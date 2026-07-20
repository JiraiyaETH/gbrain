/**
 * Synthesize phase (v0.23) — conversation-to-brain pipeline.
 *
 * Reads transcripts from the configured corpus dir, runs a cheap Haiku
 * "is this worth processing?" verdict (cached in `dream_verdicts`), then
 * fans out one Sonnet subagent per worth-processing transcript with the
 * trusted-workspace `allowed_slug_prefixes` list. After children resolve,
 * the orchestrator queries `subagent_tool_executions` for the put_page
 * slugs each child wrote (codex finding #2: NOT a time-windowed pages
 * query — picks up unrelated writes), reverse-renders each new page from
 * DB to disk, and writes a deterministic summary index.
 *
 * Hard guarantees:
 *   - Subagent never gets fs-write access. Orchestrator holds the dual-write.
 *   - Allow-list is sourced from `skills/_brain-filing-rules.json` (single
 *     source of truth) and threaded as handler data; PROTECTED_JOB_NAMES
 *     prevents MCP from submitting `subagent` jobs, so the field is trusted.
 *   - Corpus-global cooldown via `dream.synthesize.last_completion_ts` —
 *     written ONLY on success (codex finding #5 deferral: no auto git commit
 *     in v1).
 *   - Settled exporter transcripts use a stable namespaced logical identity;
 *     content hash remains verdict/evidence metadata, never the once-only key.
 *   - Legacy path/hash completions remain recognized during migration.
 *
 * NOT in v1:
 *   - git auto-commit / push (deferred to v1.1, codex finding #5).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { chat as gatewayChat, validateModelId, type ChatResult } from '../ai/gateway.ts';
import { AIConfigError } from '../ai/errors.ts';
import { normalizeModelId } from '../model-id.ts';
import { hasAnthropicKey } from '../ai/anthropic-key.ts';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJob, MinionJobInput, SubagentHandlerData } from '../minions/types.ts';
import {
  discoverTranscripts,
  type DiscoveredTranscript,
  type TranscriptLogicalIdentity,
} from './transcript-discovery.ts';
import { parseMarkdown, serializeMarkdown, serializePageToMarkdown } from '../markdown.ts';
import type { Page, PageType } from '../types.ts';
import { validateSourceId } from '../utils.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { createHash } from 'node:crypto';

// Slug regex from validatePageSlug — kept in sync.
// Used for the orchestrator-written summary index slug.
const SUMMARY_SLUG_RE = /^[a-z0-9][a-z0-9\-]*(\/[a-z0-9][a-z0-9\-]*)*$/;

export type SynthesizeChildOutcomeStatus =
  | 'completed'
  | 'failed'
  | 'dead'
  | 'timed_out'
  | 'cancelled'
  | 'unknown';

export interface SynthesizeChildOutcome {
  jobId: number;
  status: SynthesizeChildOutcomeStatus;
  error?: string;
}

export type SynthesizeChildStatusCounts = Record<SynthesizeChildOutcomeStatus, number> & {
  total: number;
};

const SYNTH_CHILD_STATUSES: readonly SynthesizeChildOutcomeStatus[] = [
  'completed', 'failed', 'dead', 'timed_out', 'cancelled', 'unknown',
] as const;

/** Classify queue terminal state without allowing timeout-shaped dead rows to hide. */
export function classifySynthesizeChildOutcome(
  job: Pick<MinionJob, 'id' | 'status' | 'error_text'>,
): SynthesizeChildOutcome {
  const error = job.error_text ?? undefined;
  if (job.status === 'completed') return { jobId: job.id, status: 'completed' };
  if ((job.status === 'dead' || job.status === 'failed') && error && /(?:time[ -]?out|deadline exceeded)/i.test(error)) {
    return { jobId: job.id, status: 'timed_out', error };
  }
  if (job.status === 'failed' || job.status === 'dead' || job.status === 'cancelled') {
    return { jobId: job.id, status: job.status, ...(error ? { error } : {}) };
  }
  return {
    jobId: job.id,
    status: 'unknown',
    error: error ?? `unexpected terminal state: ${job.status}`,
  };
}

export function countSynthesizeChildOutcomes(
  outcomes: readonly SynthesizeChildOutcome[],
): SynthesizeChildStatusCounts {
  const counts = Object.fromEntries(SYNTH_CHILD_STATUSES.map(status => [status, 0])) as
    Record<SynthesizeChildOutcomeStatus, number>;
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return { ...counts, total: outcomes.length };
}

export function allSynthesizeChildrenCompleted(outcomes: readonly SynthesizeChildOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'completed');
}

// ── Model context budget (D1, D5, D7, D9) ─────────────────────────────

/**
 * Anthropic model id → input context window (tokens).
 * Unknown id (non-Anthropic alias, custom string) → safe 200K-token fallback
 * via `computeChunkCharBudget`. Codex finding #4: `resolveModel()` does not
 * canonicalize to Anthropic-only; this map keys on the exact strings the
 * resolver returns for known Anthropic aliases.
 */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

/** Token-to-char ratio. 3.5 matches PR #748; conservative for English text. */
const CHARS_PER_TOKEN = 3.5;
/** Reserve 10% of context window for system prompt + tool defs + output. */
const HEADROOM_RATIO = 0.9;
/** Floor on user-overridable max_prompt_tokens (matches PR #748 minimum). */
const MIN_PROMPT_TOKENS = 100_000;
/** Default chunk-count cap; operator-configurable via dream.synthesize.max_chunks_per_transcript. */
const DEFAULT_MAX_CHUNKS = 24;
const DEFAULT_MAX_PAID_CHILDREN_PER_RUN = 10;
/** Conservative default budget when model is unknown (200K × HEADROOM_RATIO). */
const UNKNOWN_MODEL_BUDGET_TOKENS = 180_000;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 35 * 60 * 1000;

/**
 * Compute per-chunk character budget for the resolved model + config override.
 *
 * Resolution:
 *   - configMaxPromptTokens (already floored at MIN_PROMPT_TOKENS) wins when set.
 *   - Else the model's MODEL_CONTEXT_TOKENS entry × HEADROOM_RATIO.
 *   - Else (non-Anthropic alias / custom id) UNKNOWN_MODEL_BUDGET_TOKENS, with
 *     a once-per-process stderr warning.
 *
 * D7 scope: this bounds the INITIAL prompt size only. Tool-loop turn-N
 * accumulation is out of scope for v0.30.2 (terminal-error classification
 * catches turn-N blowups; per-turn budget guard is a v0.31+ follow-up).
 */
function computeChunkCharBudget(
  model: string,
  configMaxPromptTokens: number | null,
): number {
  if (configMaxPromptTokens !== null) {
    return Math.floor(configMaxPromptTokens * CHARS_PER_TOKEN);
  }
  const ctx = MODEL_CONTEXT_TOKENS[model];
  if (ctx === undefined) {
    warnUnknownModelOnce(model);
    return Math.floor(UNKNOWN_MODEL_BUDGET_TOKENS * CHARS_PER_TOKEN);
  }
  return Math.floor(ctx * HEADROOM_RATIO * CHARS_PER_TOKEN);
}

const _unknownModelWarned = new Set<string>();
function warnUnknownModelOnce(model: string): void {
  if (_unknownModelWarned.has(model)) return;
  _unknownModelWarned.add(model);
  process.stderr.write(
    `[dream] model "${model}" is not in MODEL_CONTEXT_TOKENS; ` +
    `using ${UNKNOWN_MODEL_BUDGET_TOKENS}-token fallback budget. ` +
    `Set dream.synthesize.max_prompt_tokens to override.\n`,
  );
}

// ── Hash-deterministic transcript chunker (D9) ────────────────────────

/**
 * Split content into chunks at most maxChars long, picking boundaries via a
 * 3-tier ladder lifted from PR #748:
 *   1. `## Topic:` separators (matches the daily-aggregated transcript shape)
 *   2. `---` markdown HR markers
 *   3. nearest `\n` newline
 *
 * D9 stable chunk identity: the back-half-of-budget search window is seeded
 * with a deterministic offset derived from contentHash so the same
 * (content, contentHash, maxChars) triple always produces identical chunks.
 * Closes the partial-progress ambiguity: chunk 2 of a transcript that
 * previously failed terminally produces byte-identical content on retry,
 * so the per-chunk idempotency key is durable across runs.
 *
 * The hash-derived offset jitters the search start within
 * [0.5×budget, 0.6×budget] so the back-half rule still holds.
 *
 * If no boundary fits, hard-split at maxChars (also deterministic in the
 * inputs).
 *
 * Pure function. Tested by `test/cycle/synthesize-chunker.test.ts`.
 */
export function splitTranscriptByBudget(
  content: string,
  contentHash: string,
  maxChars: number,
): string[] {
  if (maxChars <= 0) {
    throw new Error(`splitTranscriptByBudget: maxChars must be > 0, got ${maxChars}`);
  }
  if (content.length <= maxChars) return [content];

  const hashInt = parseHashOffset(contentHash);
  // Jitter window is the next 10% of budget after the 50% midpoint.
  const jitterRange = Math.max(1, Math.floor(maxChars * 0.1));
  const searchStart = Math.floor(maxChars * 0.5) + (hashInt % jitterRange);

  const out: string[] = [];
  let remaining = content;
  while (remaining.length > maxChars) {
    const split = findBoundary(remaining, maxChars, searchStart);
    out.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

function parseHashOffset(contentHash: string): number {
  // First 8 hex chars = 32 bits; plenty of entropy for the offset jitter.
  const hex = contentHash.slice(0, 8);
  const n = parseInt(hex, 16);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function findBoundary(text: string, maxChars: number, searchStart: number): number {
  const window = text.slice(searchStart, maxChars);
  // Tier 1: "\n## Topic:" — last occurrence inside the search window.
  const topicIdx = window.lastIndexOf('\n## Topic:');
  if (topicIdx >= 0) return searchStart + topicIdx;
  // Tier 2: "\n---\n" markdown HR.
  const hrIdx = window.lastIndexOf('\n---\n');
  if (hrIdx >= 0) return searchStart + hrIdx;
  // Tier 3: any newline.
  const nlIdx = window.lastIndexOf('\n');
  if (nlIdx >= 0) return searchStart + nlIdx;
  // No boundary fits; hard-split at maxChars (deterministic).
  // v0.42.0.0: route through safeSplitIndex so a hard-split that lands
  // between a UTF-16 surrogate pair (emoji / non-BMP CJK / mathematical
  // alphanumerics) doesn't orphan the high surrogate — that would change
  // chunk byte-content vs the source and break the D9 stable-chunk-identity
  // invariant on the next retry.
  return safeSplitIndex(text, maxChars);
}

/**
 * D6: orchestrator-side deterministic slug rewrite. Zero Sonnet trust.
 *
 * Expected shape from `buildSynthesisPrompt` for a chunked child is already
 * `<base>-<hash6>-c<idx>`, but if Sonnet drops the chunk suffix this rewrite
 * enforces uniqueness post-hoc. Same hash AND same chunk idx → idempotent.
 *
 * Pure function. Cases:
 *   - already correctly suffixed (`...-<hash6>-c<idx>`) → return unchanged.
 *   - bare hash suffix (`...-<hash6>`) → append `-c<idx>`.
 *   - some other shape → pass through (orchestrator can't safely guess
 *     where to inject the chunk index; e2e test pins this).
 */
export function rewriteChunkedSlug(slug: string, hash6: string, idx: number): string {
  if (!slug) return slug;
  const expected = `${hash6}-c${idx}`;
  // Already correctly chunk-suffixed.
  if (slug === expected) return slug;
  if (slug.endsWith(`-${expected}`) || slug.endsWith(`/${expected}`)) return slug;
  // Bare hash6 at end of last path segment: rewrite.
  // Match either at start-of-slug, after a "/" path separator, or after a "-".
  const re = new RegExp(`(^|[/-])${hash6}$`);
  if (re.test(slug)) return `${slug}-c${idx}`;
  // Unknown shape — pass through; collision risk is now bounded by Sonnet's
  // per-chunk-prompt guidance and the existing slug-prefix allow-list.
  return slug;
}

// ── Public entry ──────────────────────────────────────────────────────

export interface SynthesizePhaseOpts {
  brainDir: string;
  dryRun: boolean;
  /**
   * The cycle's canonically resolved brain source. Required so content reads,
   * child writes, cooldowns, provenance, and reverse-writes cannot fall back
   * to a different source.
   */
  sourceId: string;
  /** Generic in-cycle keepalive for cycle-lock TTL renewal during long waits. */
  yieldDuringPhase?: () => Promise<void>;
  /**
   * Override the corpus directory and other tunables. Primarily for the
   * `gbrain dream --input <file>` ad-hoc path; bypasses config reads.
   */
  inputFile?: string;
  date?: string;
  from?: string;
  to?: string;
  /** Scheduled exact-night scope. Activates the paid-child run cap. */
  nightId?: string;
  /**
   * Disable the self-consumption guard. Wired from the
   * `--unsafe-bypass-dream-guard` CLI flag. NOT auto-applied for `--input`
   * because that would allow any dream-generated page to silently re-enter
   * the synthesize loop. Caller must opt in explicitly.
   */
  bypassDreamGuard?: boolean;
  /** Hermetic test seam; production always uses waitForCompletion. */
  waitForChildForTestOnly?: (queue: MinionQueue, jobId: number) => Promise<MinionJob>;
}

/**
 * Cheap availability check shared by runCycle's fail-closed dispatch guard
 * and the phase itself. It intentionally performs config reads only: an
 * unresolved multi-source cycle may determine that a disabled/unconfigured
 * phase is harmless, but must not touch content tables.
 */
export async function preflightSynthesize(
  engine: BrainEngine,
  opts: Pick<SynthesizePhaseOpts, 'inputFile'>,
): Promise<PhaseResult | null> {
  if (opts.inputFile) return null;
  const [enabledRaw, corpusDir] = await Promise.all([
    engine.getConfig('dream.synthesize.enabled'),
    engine.getConfig('dream.synthesize.session_corpus_dir'),
  ]);
  if (!corpusDir) {
    return skipped('not_configured', 'dream.synthesize.session_corpus_dir is unset');
  }
  if (enabledRaw === 'false') {
    return skipped('not_configured', 'dream.synthesize.enabled is explicitly false');
  }
  return null;
}

export async function runPhaseSynthesize(
  engine: BrainEngine,
  opts: SynthesizePhaseOpts,
): Promise<PhaseResult> {
  const start = Date.now();
  // Normalize brainDir to an absolute path BEFORE any reverse-write. Without
  // this, a relative or empty brainDir flows down to writeReversePages →
  // `join(brainDir, '${slug}.md')` → relative path → resolves against cwd at
  // writeFileSync time, spilling synthesize output into whatever directory
  // the cycle ran from (e.g., `companies/novamind.md` at the repo root).
  // Surfaced by the warm-narwhal wave when E2E test cleanup found orphan
  // synthesize pages at repo root from a `runCycle({brainDir: '.'})` call
  // chain. Throw on empty (silent cwd-resolution is worse than a loud
  // failure); resolve if relative (`.` / `./brain` / `../sibling` all valid
  // inputs but must canonicalize before the write).
  if (!opts.brainDir || opts.brainDir.trim() === '') {
    return failed(makeError('InternalError', 'BRAINDIR_EMPTY',
      'opts.brainDir is empty; refusing to run synthesize. Pass an absolute path.'));
  }
  if (!isAbsolute(opts.brainDir)) {
    opts.brainDir = resolve(opts.brainDir);
  }
  try {
    const unavailable = await preflightSynthesize(engine, opts);
    if (unavailable) return unavailable;

    const config = await loadSynthConfig(engine);
    // Pin one cycle date for every child DB write, reverse-write repair, and
    // summary receipt. Scheduled bounded scans use --to so cross-midnight
    // sessions are stamped with the intended settlement night.
    const summaryDate = opts.nightId ?? opts.date ?? opts.to ?? today();

    // Cooldown check (skipped for explicit --input / --date / --from / --to runs).
    const explicitTarget = opts.inputFile || opts.nightId || opts.date || opts.from || opts.to;
    if (!explicitTarget) {
      const cooldown = await checkCooldown(engine, config.cooldownHours);
      if (cooldown.active) {
        return skipped('cooldown_active',
          `synthesize cooled down until ${cooldown.expires_at} (${config.cooldownHours}h cooldown)`);
      }
    }

    if (opts.bypassDreamGuard) {
      process.stderr.write(
        '[dream] WARNING: --unsafe-bypass-dream-guard set; self-consumption guard disabled. ' +
        'Re-ingestion of dream output will incur Sonnet costs forever.\n',
      );
    }

    // v0.32.6 M2: pre-fetch prior contradictions from the most recent probe
    // run (if any). Surfaced as an informational block to the synthesize
    // subagent so it knows which slugs it should reconcile if it writes to
    // them. Best-effort — a probe that's never run is a normal early state.
    const priorContradictionsBlock = await loadPriorContradictionsBlock(engine, opts.sourceId);

    // Discover.
    // The session corpus is intentionally source-less: it is an external
    // discovery lane, not a brain table. Every DB read and every page write
    // below is nevertheless bound to opts.sourceId.
    const transcripts = opts.inputFile
      ? loadAdHocTranscript(
          opts.inputFile,
          config.minChars,
          config.excludePatterns,
          opts.bypassDreamGuard,
          config.corpusDir,
        )
      : discoverTranscripts({
          corpusDir: config.corpusDir!,
          meetingTranscriptsDir: config.meetingTranscriptsDir ?? undefined,
          minChars: config.minChars,
          excludePatterns: config.excludePatterns,
          date: opts.date,
          from: opts.from,
          to: opts.to,
          nightId: opts.nightId,
          bypassGuard: opts.bypassDreamGuard,
        });

    if (transcripts.length === 0) {
      return ok('no transcripts to process', { transcripts_processed: 0, pages_written: 0 });
    }

    // Settled-once suppression MUST precede the paid significance verdict.
    // A logical marker is the durable ORCHESTRATOR receipt: child completion
    // alone is not enough because collection, reverse-write, and summary may
    // still need to run after a crash. Stable completed lineages without that
    // marker therefore enter the resume lane below and never call the judge.
    //
    // Legacy path/hash lineages predate the orchestrator receipt. Preserve
    // their historical once-only suppression narrowly, but do not fabricate a
    // new logical marker from child state alone.
    const lineageSkips: Array<{ filePath: string; reason: string }> = [];
    const pendingTranscripts: DiscoveredTranscript[] = [];
    const resumableTranscripts = new Map<string, SynthesizeLineageRow[]>();
    for (const transcript of transcripts) {
      if (await engine.getConfig(synthesizeOperatorDiscardKey(transcript))) {
        lineageSkips.push({
          filePath: transcript.filePath,
          reason: 'operator_discarded',
        });
        continue;
      }
      const completion = await transcriptCompletionState(engine, transcript);
      if (completion.via === 'marker') {
        lineageSkips.push({
          filePath: transcript.filePath,
          reason: 'already_synthesized_marker',
        });
        continue;
      }
      if (completion.via === 'stable_job') {
        resumableTranscripts.set(transcript.filePath, completion.rows);
        continue;
      }
      if (completion.via === 'legacy_job') {
        lineageSkips.push({
          filePath: transcript.filePath,
          reason: 'already_synthesized_legacy_job',
        });
        continue;
      }
      pendingTranscripts.push(transcript);
    }

    if (pendingTranscripts.length === 0 && resumableTranscripts.size === 0) {
      return ok('all settled logical transcripts already synthesized', {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        children_submitted: 0,
        skips: lineageSkips,
      });
    }

    // Significance verdicts (cached in dream_verdicts; Haiku on miss).
    const worthProcessing: DiscoveredTranscript[] = transcripts.filter(
      transcript => resumableTranscripts.has(transcript.filePath),
    );
    const verdicts: Array<{ filePath: string; worth: boolean; reasons: string[]; cached: boolean }> = [];
    // Provider-aware judge client routes through gateway.chat, so any
    // configured provider works (Anthropic, DeepSeek, OpenRouter, Voyage,
    // Ollama, llama-server, etc.). Returns null when the resolved verdict
    // model has no reachable provider (legacy "no API key" branch preserved
    // as the cheap pre-flight check).
    const judge = makeJudgeClient(config.verdictModel);
    for (const t of pendingTranscripts) {
      const cached = await engine.getDreamVerdict(t.filePath, t.contentHash);
      if (cached) {
        verdicts.push({ filePath: t.filePath, worth: cached.worth_processing, reasons: cached.reasons, cached: true });
        if (cached.worth_processing) worthProcessing.push(t);
        continue;
      }
      if (!judge) {
        // No configured provider for the verdict model — can't judge.
        // Skip with explicit reason; don't crash phase.
        verdicts.push({
          filePath: t.filePath,
          worth: false,
          reasons: [`no configured provider for verdict model: ${config.verdictModel}`],
          cached: false,
        });
        continue;
      }
      try {
        const verdict = await judgeSignificance(judge, t, config.verdictModel);
        await engine.putDreamVerdict(t.filePath, t.contentHash, verdict);
        verdicts.push({ filePath: t.filePath, worth: verdict.worth_processing, reasons: verdict.reasons, cached: false });
        if (verdict.worth_processing) worthProcessing.push(t);
      } catch (e) {
        // AIConfigError at chat time = provider auth/config went bad mid-run
        // (revoked key, recipe misconfig surfacing at first real call). Skip
        // this transcript with the gateway error message so the user sees the
        // shape of the problem in `gbrain dream --phase synthesize --dry-run`.
        if (e instanceof AIConfigError) {
          verdicts.push({
            filePath: t.filePath,
            worth: false,
            reasons: [`gateway error: ${e.message}`],
            cached: false,
          });
          continue;
        }
        throw e;
      }
    }

    // Dry-run stops here: significance filter ran (Haiku verdicts cached),
    // but no Sonnet synthesis. Codex finding #8: --dry-run does NOT mean
    // "zero LLM calls"; it means "skip Sonnet."
    if (opts.dryRun) {
      return ok(
        `dry-run: ${worthProcessing.length - resumableTranscripts.size} of ${pendingTranscripts.length} pending transcripts would synthesize; ` +
        `${resumableTranscripts.size} completed lineage(s) would resume orchestration`,
        {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        verdicts,
        skips: lineageSkips,
        transcripts_to_resume: resumableTranscripts.size,
        dryRun: true,
        },
      );
    }

    if (worthProcessing.length === 0) {
      // Even with verdicts, the cooldown timestamp is updated only on a
      // real successful run — not on "nothing worth processing." Lets a
      // re-run pick up if a new transcript lands later.
      return ok('all transcripts skipped by significance filter', {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        verdicts,
        skips: lineageSkips,
      });
    }

    // Fan-out: submit one subagent per worth-processing transcript (or one
    // per chunk for transcripts that exceed the model's per-prompt budget).
    const synthPaths = await loadDreamSynthesizePaths(config.outputRoot);
    const allowedSlugPrefixes = synthPaths.globs;
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }

    const queue = new MinionQueue(engine);
    const childIdSet = new Set<number>();
    const submittedChildIdSet = new Set<number>();
    const resumedChildIdSet = new Set<number>();
    /** Map child job_id → chunk metadata for D6 orchestrator-side slug rewrite. */
    const chunkInfo = new Map<number, { idx: number; hash6: string }>();
    /** Skip reasons for the cycle report (D5 cap hits, D8 legacy-key skips). */
    const skipReports: Array<{ filePath: string; reason: string }> = [...lineageSkips];

    interface TranscriptPlan {
      transcript: DiscoveredTranscript;
      requiredJobIds: Set<number>;
      reusedCompletedChildren: number;
    }
    const transcriptPlans: TranscriptPlan[] = [];
    let paidChildrenDispatched = 0;
    let paidChildrenOverflow = 0;
    let transcriptsCapped = 0;

    const maxCharsPerChunk = computeChunkCharBudget(config.model, config.maxPromptTokens);

    for (const t of worthProcessing) {
      const hash6 = t.contentHash.slice(0, 6);

      const recoveryRows = resumableTranscripts.get(t.filePath);
      if (recoveryRows) {
        const plan: TranscriptPlan = {
          transcript: t,
          requiredJobIds: new Set<number>(),
          reusedCompletedChildren: recoveryRows.length,
        };
        for (const row of recoveryRows) {
          assertPersistedCompletedJobReceipt(row);
          childIdSet.add(row.id);
          resumedChildIdSet.add(row.id);
          plan.requiredJobIds.add(row.id);
          const recoveredChunk = recoveredChunkInfo(row, t);
          if (recoveredChunk) chunkInfo.set(row.id, recoveredChunk);
        }
        transcriptPlans.push(plan);
        continue;
      }

      const chunks = splitTranscriptByBudget(t.content, t.contentHash, maxCharsPerChunk);

      // D5 cap hit: log + skip; do NOT write to dream_verdicts. Closes the
      // poison-pill class — next cycle re-attempts under whatever budget
      // is then current.
      if (chunks.length > config.maxChunksPerTranscript) {
        process.stderr.write(
          `[dream] transcript ${t.basename} produced ${chunks.length} chunks at ` +
          `${maxCharsPerChunk}-char budget (cap=${config.maxChunksPerTranscript}); skipping. ` +
          `Increase dream.synthesize.max_chunks_per_transcript or use a larger-context model.\n`,
        );
        skipReports.push({
          filePath: t.filePath,
          reason: `oversize_after_split: ${chunks.length}/${config.maxChunksPerTranscript}`,
        });
        continue;
      }

      const isChunked = chunks.length > 1;
      const plan: TranscriptPlan = {
        transcript: t,
        requiredJobIds: new Set<number>(),
        reusedCompletedChildren: 0,
      };
      const childJobName = config.useSubscriptionBilling ? 'shell-subagent' : 'subagent';
      // queue.add subagent validator (classifyCapabilities → resolveRecipe)
      // requires `provider:model`. resolveModel can return a bare id when
      // TIER_DEFAULTS / DEFAULT_ALIASES carry a bare value; ensure the
      // anthropic: prefix is present for known claude-* ids before passing
      // to the queue. Non-anthropic providers must already declare a colon.
      const subagentModel = config.model.includes(':')
        ? config.model
        : config.model.toLowerCase().startsWith('claude-')
          ? `anthropic:${config.model}`
          : config.model;
      const completedChunks: Array<SynthesizeLineageRow | null> = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkIdentity = isChunked ? { index: i, total: chunks.length } : undefined;
        completedChunks.push(await findRequiredChunkCompletion(engine, t, chunkIdentity));
      }
      const missingChildren = completedChunks.filter(row => row === null).length;
      if (
        opts.nightId
        && paidChildrenDispatched + missingChildren > config.maxPaidChildrenPerRun
      ) {
        const remaining = Math.max(0, config.maxPaidChildrenPerRun - paidChildrenDispatched);
        paidChildrenOverflow += missingChildren;
        transcriptsCapped += 1;
        skipReports.push({
          filePath: t.filePath,
          reason: `paid_child_cap: required=${missingChildren}, remaining=${remaining}, cap=${config.maxPaidChildrenPerRun}`,
        });
        continue;
      }
      for (let i = 0; i < chunks.length; i++) {
        const chunkIdentity = isChunked ? { index: i, total: chunks.length } : undefined;
        // Recognize both stable and legacy completed chunks. Partial legacy
        // runs retry only their missing chunks; a complete legacy set was
        // already suppressed before the paid verdict.
        const completedChunk = completedChunks[i];
        if (completedChunk) {
          assertPersistedCompletedJobReceipt(completedChunk);
          plan.reusedCompletedChildren += 1;
          childIdSet.add(completedChunk.id);
          resumedChildIdSet.add(completedChunk.id);
          plan.requiredJobIds.add(completedChunk.id);
          if (isChunked) {
            const recoveredChunk = recoveredChunkInfo(completedChunk, t);
            if (!recoveredChunk) {
              throw new Error(
                `completed synthesis child ${completedChunk.id} is chunked but its persisted identity is missing`,
              );
            }
            chunkInfo.set(completedChunk.id, recoveredChunk);
          }
          continue;
        }
        const childData: SubagentHandlerData = {
          prompt: buildSynthesisPrompt(t, chunks[i], i, chunks.length, priorContradictionsBlock, synthPaths.routes),
          model: subagentModel,
          max_turns: 30,
          allowed_slug_prefixes: allowedSlugPrefixes,
          // #1586: scope every child tool call to the cycle's resolved source
          // so put_page writes land there instead of the hardcoded 'default'.
          source_id: opts.sourceId,
          dream_output_cycle_date: summaryDate,
        };
        // Exporter identity is stable across byte drift and namespaced across
        // Claude/Hermes profiles and parts. Ad-hoc legacy input retains the
        // historical path/hash key. source_id remains write routing only.
        const idempotency_key = t.logicalIdentity
          ? synthesizeLogicalIdempotencyKey(t.logicalIdentity, chunkIdentity)
          : synthesizeIdempotencyKey(t.filePath, t.contentHash.slice(0, 16), chunkIdentity);
        const submitOpts: Partial<MinionJobInput> = {
          max_stalled: 3,
          on_child_fail: 'continue',
          idempotency_key,
          timeout_ms: config.subagentTimeoutMs,
        };
        const child = await queue.add(
          childJobName,
          childData as unknown as Record<string, unknown>,
          submitOpts,
          { allowProtectedSubmit: true },
          { rearmCompleted: false },
        );
        paidChildrenDispatched += 1;
        childIdSet.add(child.id);
        if (child.status === 'completed') {
          const completedRow = lineageRowFromJob(child);
          assertPersistedCompletedJobReceipt(completedRow);
          resumedChildIdSet.add(child.id);
          if (isChunked) {
            const recoveredChunk = recoveredChunkInfo(completedRow, t);
            if (recoveredChunk) chunkInfo.set(child.id, recoveredChunk);
          }
        } else {
          submittedChildIdSet.add(child.id);
        }
        plan.requiredJobIds.add(child.id);
        if (isChunked) {
          chunkInfo.set(child.id, { idx: i, hash6 });
        }
      }
      if (plan.requiredJobIds.size === 0) {
        skipReports.push({
          filePath: t.filePath,
          reason: 'no_required_synthesis_children',
        });
      } else {
        transcriptPlans.push(plan);
      }
    }

    const childIds = Array.from(childIdSet);
    if (childIds.length === 0) {
      const details = {
        transcripts_discovered: transcripts.length,
        transcripts_processed: 0,
        pages_written: 0,
        children_submitted: 0,
        children_resumed: 0,
        capped: transcriptsCapped > 0,
        paid_children_cap: opts.nightId ? config.maxPaidChildrenPerRun : null,
        paid_children_dispatched: paidChildrenDispatched,
        paid_children_overflow: paidChildrenOverflow,
        transcripts_capped: transcriptsCapped,
        skips: skipReports,
        verdicts,
      };
      return transcriptsCapped > 0
        ? warned('paid synthesis child cap reached; overflow remains pending', details)
        : ok('no new synthesis children required', details);
    }

    // Wait for every child to reach a terminal state. Tick yieldDuringPhase
    // every 5 min so the cycle lock TTL refreshes.
    const childOutcomes: SynthesizeChildOutcome[] = [];
    for (const jobId of childIds) {
      try {
        const job = opts.waitForChildForTestOnly
          ? await opts.waitForChildForTestOnly(queue, jobId)
          : await waitForCompletion(queue, jobId, {
              timeoutMs: config.subagentWaitTimeoutMs,
              pollMs: 5 * 1000,
            });
        childOutcomes.push(classifySynthesizeChildOutcome(job));
      } catch (e) {
        if (e instanceof TimeoutError) {
          childOutcomes.push({ jobId, status: 'timed_out', error: e.message });
        } else {
          childOutcomes.push({
            jobId,
            status: 'unknown',
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // After each child terminal, give the cycle lock + worker job lock a chance.
      if (opts.yieldDuringPhase) {
        try { await opts.yieldDuringPhase(); } catch { /* best-effort */ }
      }
    }

    // Collect slugs from put_page tool executions across the children
    // (codex finding #2: deterministic provenance, NOT pages.updated_at).
    // D6 orchestrator slug rewrite: chunkInfo drives post-hoc rewrite of
    // bare-hash slugs to `<hash6>-c<idx>` so chunked siblings can't collide
    // even if Sonnet drops the chunk suffix.
    // v0.32.8: refs carry source_id so reverseWriteRefs picks the correct
    // (source, slug) row. #1586: refs are stamped with the cycle's resolved
    // source (children write there via SubagentHandlerData.source_id).
    const cycleSourceId = opts.sourceId;
    const writtenRefs = await collectChildPutPageSlugs(engine, childIds, chunkInfo, cycleSourceId);

    // #2569: persist the dream-output identity marker into the DB frontmatter
    // of every child-written page BEFORE reverse-rendering, so generated pages
    // are queryable (`frontmatter->>'dream_generated'`) and a later put_page
    // write-through (which re-renders from the DB row) can't erase the stamp.
    await stampDreamProvenance(engine, writtenRefs, summaryDate);

    // Dual-write: reverse-render each DB row → markdown file.
    const reverseWriteCount = await reverseWriteRefs(
      engine,
      opts.brainDir,
      writtenRefs,
      summaryDate,
      cycleSourceId,
    );

    // Summary index page (deterministic; orchestrator-written via direct
    // engine.putPage so no allow-list path needed).
    // A scheduled bounded scan uses --to <settlement-night> so a Claude
    // session that began before midnight but settled on that night is still
    // eligible. Anchor the shared receipt/summary to that explicit upper
    // bound; per-transcript stable identities retain their own export dates.
    const summarySlug = `dream-cycle-summaries/${summaryDate}`;
    // Back-compat: writeSummaryPage takes string[] for display; map refs back to slugs.
    const writtenSlugs = writtenRefs.map(r => r.slug);
    const outcomeByJobId = new Map(childOutcomes.map(outcome => [outcome.jobId, outcome]));
    let completedTranscripts = 0;
    let incompleteTranscripts = 0;
    const transcriptsReadyForDurableCompletion: DiscoveredTranscript[] = [];
    for (const plan of transcriptPlans) {
      const complete = Array.from(plan.requiredJobIds).every(
        jobId => outcomeByJobId.get(jobId)?.status === 'completed',
      );
      if (complete) {
        completedTranscripts += 1;
        transcriptsReadyForDurableCompletion.push(plan.transcript);
      } else {
        incompleteTranscripts += 1;
      }
    }

    const childStatusCounts = countSynthesizeChildOutcomes(childOutcomes);
    const allChildrenSucceeded = allSynthesizeChildrenCompleted(childOutcomes);
    const reusedCompletedChildren = transcriptPlans.reduce(
      (total, plan) => total + plan.reusedCompletedChildren,
      0,
    );
    const commonDetails = {
      transcripts_discovered: transcripts.length,
      transcripts_processed: completedTranscripts,
      transcripts_incomplete: incompleteTranscripts,
      pages_written: writtenSlugs.length,
      written_slugs: writtenSlugs,
      reverse_write_count: reverseWriteCount,
      child_outcomes: childOutcomes,
      child_status_counts: childStatusCounts,
      children_submitted: submittedChildIdSet.size,
      children_resumed: resumedChildIdSet.size,
      reused_completed_children: reusedCompletedChildren,
      capped: transcriptsCapped > 0,
      paid_children_cap: opts.nightId ? config.maxPaidChildrenPerRun : null,
      paid_children_dispatched: paidChildrenDispatched,
      paid_children_overflow: paidChildrenOverflow,
      transcripts_capped: transcriptsCapped,
      skips: skipReports,
      verdicts,
    };

    if (!allChildrenSucceeded) {
      const nonSuccess = childStatusCounts.total - childStatusCounts.completed;
      return failedWithDetails(
        makeError(
          'ChildJobFailure',
          'SYNTH_CHILD_INCOMPLETE',
          `${nonSuccess}/${childStatusCounts.total} synthesis child jobs did not complete successfully`,
        ),
        { ...commonDetails, summary_slug: null, cooldown_written: false },
        `synthesize incomplete: ${nonSuccess}/${childStatusCounts.total} child jobs non-success`,
      );
    }

    if (!SUMMARY_SLUG_RE.test(summarySlug)) {
      throw new Error(`invalid synthesize summary slug: ${summarySlug}`);
    }
    await writeSummaryPage(
      engine,
      opts.brainDir,
      summarySlug,
      summaryDate,
      writtenSlugs,
      childOutcomes,
      opts.sourceId,
    );

    // Logical markers and the success cooldown are one durability receipt.
    // If any marker write fails, the transaction rolls all of them back so a
    // retry rediscovers the complete settled set and reconstructs the shared
    // date summary instead of overwriting it with only an unmarked suffix.
    // The summary/page/file postconditions above intentionally complete first.
    const completionTimestamp = new Date().toISOString();
    await engine.transaction(async tx => {
      for (const transcript of transcriptsReadyForDurableCompletion) {
        await markLogicalTranscriptComplete(tx, transcript, completionTimestamp);
      }
      if (transcriptsCapped === 0) {
        await tx.setConfig(synthesizeCompletionKey(), completionTimestamp);
      }
    });

    const ms = Date.now() - start;
    const successDetails = {
      ...commonDetails,
      summary_slug: summarySlug,
      cooldown_written: transcriptsCapped === 0,
    };
    return transcriptsCapped > 0
      ? warned(
          `${completedTranscripts} transcript(s) synthesized; paid child cap left ${transcriptsCapped} transcript(s) pending`,
          successDetails,
        )
      : ok(`${completedTranscripts} transcript(s) synthesized in ${(ms / 1000).toFixed(1)}s`, successDetails);
  } catch (e) {
    return failed(makeError('InternalError', 'SYNTH_PHASE_FAIL',
      e instanceof Error ? (e.message || 'synthesize phase threw') : String(e)));
  }
}

// ── Config ────────────────────────────────────────────────────────────

interface SynthConfig {
  corpusDir: string | null;
  meetingTranscriptsDir: string | null;
  minChars: number;
  excludePatterns: string[];
  model: string;
  verdictModel: string;
  cooldownHours: number;
  /**
   * D1: Override the per-chunk token budget (model_context × HEADROOM_RATIO
   * by default). Floor MIN_PROMPT_TOKENS, no upper cap (model context wins).
   * Surface name follows PR #748: `dream.synthesize.max_prompt_tokens`.
   * `null` means use the model-context lookup.
   */
  maxPromptTokens: number | null;
  /**
   * D5/D10: Cap on chunks produced from a single transcript. On cap hit, the
   * transcript is logged + skipped (NOT cached in dream_verdicts — closes the
   * cache-poisoning class). Operator override:
   * `dream.synthesize.max_chunks_per_transcript`.
   */
  maxChunksPerTranscript: number;
  /** Scheduled paid synthesis fan-out cap. Zero/unset/invalid means 10. */
  maxPaidChildrenPerRun: number;
  /**
   * #2415: top-level namespace for synthesized output (reflections, originals,
   * patterns). Config key `dream.synthesize.output_root`; default 'wiki' —
   * zero behavior change unless set. No trailing slash. Must satisfy the slug
   * grammar; invalid values fall back to 'wiki' with a stderr warning.
   */
  outputRoot: string;
  subagentTimeoutMs: number;
  subagentWaitTimeoutMs: number;
  /**
   * When true, dream synthesize submits shell-subagent children that invoke
   * the local Claude CLI instead of Anthropic API-backed subagent children.
   */
  useSubscriptionBilling: boolean;
}

/** #2415: shared output-root resolution (synthesize + patterns phases). */
export async function loadOutputRoot(engine: BrainEngine): Promise<string> {
  const raw = await engine.getConfig('dream.synthesize.output_root');
  if (!raw) return 'wiki';
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (SUMMARY_SLUG_RE.test(trimmed)) return trimmed;
  process.stderr.write(
    `[dream] dream.synthesize.output_root "${raw}" is not a valid slug prefix; falling back to "wiki".\n`,
  );
  return 'wiki';
}

async function loadSynthConfig(engine: BrainEngine): Promise<SynthConfig> {
  const corpusDir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  const meetingTranscriptsDir = await engine.getConfig('dream.synthesize.meeting_transcripts_dir');
  const minCharsStr = await engine.getConfig('dream.synthesize.min_chars');
  const excludeStr = await engine.getConfig('dream.synthesize.exclude_patterns');
  // v0.28: resolveModel() unifies CLI flag > new key > deprecated key > models.default > env > fallback
  const { resolveModel } = await import('../model-config.ts');
  const model = await resolveModel(engine, {
    configKey: 'models.dream.synthesize',
    deprecatedConfigKey: 'dream.synthesize.model',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  const verdictModel = await resolveModel(engine, {
    configKey: 'models.dream.synthesize_verdict',
    deprecatedConfigKey: 'dream.synthesize.verdict_model',
    tier: 'utility',
    fallback: 'haiku',
  });
  const cooldownHoursStr = await engine.getConfig('dream.synthesize.cooldown_hours');
  const maxPromptTokensStr = await engine.getConfig('dream.synthesize.max_prompt_tokens');
  const maxChunksStr = await engine.getConfig('dream.synthesize.max_chunks_per_transcript');
  const maxPaidChildrenStr = await engine.getConfig('dream.synthesize.max_paid_children_per_run');
  const subagentTimeoutMs = await getNumberConfig(
    engine,
    'dream.synthesize.subagent_timeout_ms',
    DEFAULT_SUBAGENT_TIMEOUT_MS,
  );
  const subagentWaitTimeoutMs = await getNumberConfig(
    engine,
    'dream.synthesize.subagent_wait_timeout_ms',
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
  );
  const useSubscriptionBillingRaw = await engine.getConfig('dream.synthesize.use_subscription_billing');

  let excludePatterns: string[] = ['medical', 'therapy'];
  if (excludeStr) {
    try {
      const parsed = JSON.parse(excludeStr);
      if (Array.isArray(parsed)) excludePatterns = parsed.filter(p => typeof p === 'string');
    } catch { /* keep default */ }
  }

  // D1: max_prompt_tokens floored at MIN_PROMPT_TOKENS; null → use model lookup.
  let maxPromptTokens: number | null = null;
  if (maxPromptTokensStr) {
    const parsed = parseInt(maxPromptTokensStr, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxPromptTokens = Math.max(MIN_PROMPT_TOKENS, parsed);
    }
  }
  // D10: max_chunks default 24, floor 1.
  let maxChunksPerTranscript = DEFAULT_MAX_CHUNKS;
  if (maxChunksStr) {
    const parsed = parseInt(maxChunksStr, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      maxChunksPerTranscript = parsed;
    }
  }
  let maxPaidChildrenPerRun = DEFAULT_MAX_PAID_CHILDREN_PER_RUN;
  if (maxPaidChildrenStr) {
    const parsed = parseInt(maxPaidChildrenStr, 10);
    if (Number.isFinite(parsed) && parsed > 0) maxPaidChildrenPerRun = parsed;
  }

  return {
    corpusDir: corpusDir ?? null,
    meetingTranscriptsDir: meetingTranscriptsDir ?? null,
    minChars: minCharsStr ? Math.max(0, parseInt(minCharsStr, 10) || 2000) : 2000,
    excludePatterns,
    model,
    verdictModel,
    cooldownHours: cooldownHoursStr ? Math.max(0, parseInt(cooldownHoursStr, 10) || 12) : 12,
    maxPromptTokens,
    maxChunksPerTranscript,
    maxPaidChildrenPerRun,
    outputRoot: await loadOutputRoot(engine),
    subagentTimeoutMs,
    subagentWaitTimeoutMs,
    useSubscriptionBilling: useSubscriptionBillingRaw === 'true' || useSubscriptionBillingRaw === '1',
  };
}

async function getNumberConfig(
  engine: BrainEngine,
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

async function checkCooldown(
  engine: BrainEngine,
  hours: number,
): Promise<{ active: boolean; expires_at?: string }> {
  if (hours <= 0) return { active: false };
  const last = await engine.getConfig(synthesizeCompletionKey());
  if (!last) return { active: false };
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return { active: false };
  const expiresMs = lastMs + hours * 60 * 60 * 1000;
  if (Date.now() >= expiresMs) return { active: false };
  return { active: true, expires_at: new Date(expiresMs).toISOString() };
}

export function synthesizeCompletionKey(): string {
  return 'dream.synthesize.last_completion_ts';
}

export function synthesizeIdempotencyKey(
  filePath: string,
  hash16: string,
  chunk?: { index: number; total: number },
): string {
  const base = `dream:synth:${filePath}:${hash16}`;
  return chunk ? `${base}:c${chunk.index}of${chunk.total}` : base;
}

/** Stable settled-transcript key. Content changes never alter this lineage. */
export function synthesizeLogicalIdempotencyKey(
  identity: Pick<TranscriptLogicalIdentity, 'logicalTranscriptId'>,
  chunk?: { index: number; total: number },
): string {
  const base = `dream:synth:logical:v1:${identity.logicalTranscriptId}`;
  return chunk ? `${base}:c${chunk.index}of${chunk.total}` : base;
}

export function synthesizeLogicalCompletionKey(
  identity: Pick<TranscriptLogicalIdentity, 'logicalTranscriptId'>,
): string {
  return `dream.synthesize.logical_completion.v1.${identity.logicalTranscriptId}`;
}

export function synthesizeOperatorDiscardKey(transcript: DiscoveredTranscript): string {
  if (transcript.logicalIdentity) {
    return `dream.synthesize.operator_discarded.v1.logical.${transcript.logicalIdentity.logicalTranscriptId}`;
  }
  const pathHash = createHash('sha256').update(resolve(transcript.filePath), 'utf8').digest('hex');
  return `dream.synthesize.operator_discarded.v1.path.${pathHash}`;
}

export interface CloseDreamBacklogOpts {
  before: string;
  dryRun: boolean;
  reason?: string;
  now?: string;
}

export interface CloseDreamBacklogItem {
  file_path: string;
  content_sha256: string;
  logical_transcript_id: string | null;
  settled_date: string;
  settled_date_source: 'exporter_settled_at' | 'filename_fallback';
  marker_key: string;
  partial_lineage_rows: number;
}

export interface CloseDreamBacklogResult {
  schema: 'gbrain-dream-close-backlog/v1';
  before: string;
  dry_run: boolean;
  reason: string;
  transcripts_discovered: number;
  candidates: number;
  markers_written: number;
  already_discarded: number;
  completed_lineage: number;
  not_before_cutoff: number;
  undated: number;
  items: CloseDreamBacklogItem[];
}

/**
 * Permanently retire historical transcript backlog without modifying evidence
 * files. Partial child rows do not count as completion: the operator discard
 * marker intentionally closes those transcripts too.
 */
export async function closeDreamBacklog(
  engine: BrainEngine,
  opts: CloseDreamBacklogOpts,
): Promise<CloseDreamBacklogResult> {
  const config = await loadSynthConfig(engine);
  if (!config.corpusDir) {
    throw new Error('dream.synthesize.session_corpus_dir is unset');
  }
  const transcripts = discoverTranscripts({
    corpusDir: config.corpusDir,
    meetingTranscriptsDir: config.meetingTranscriptsDir ?? undefined,
    minChars: config.minChars,
    excludePatterns: config.excludePatterns,
  });
  const reason = opts.reason ?? 'operator_discarded_before_cutoff';
  const items: CloseDreamBacklogItem[] = [];
  let alreadyDiscarded = 0;
  let completedLineageCount = 0;
  let notBeforeCutoff = 0;
  let undated = 0;

  for (const transcript of transcripts) {
    const settledDate = transcript.settledDate ?? transcript.inferredDate;
    if (!settledDate) {
      undated += 1;
      continue;
    }
    if (settledDate >= opts.before) {
      notBeforeCutoff += 1;
      continue;
    }
    const markerKey = synthesizeOperatorDiscardKey(transcript);
    if (await engine.getConfig(markerKey)) {
      alreadyDiscarded += 1;
      continue;
    }
    const completion = await transcriptCompletionState(engine, transcript);
    if (completion.via !== null) {
      completedLineageCount += 1;
      continue;
    }
    items.push({
      file_path: transcript.filePath,
      content_sha256: transcript.contentHash,
      logical_transcript_id: transcript.logicalIdentity?.logicalTranscriptId ?? null,
      settled_date: settledDate,
      settled_date_source: transcript.settledDate ? 'exporter_settled_at' : 'filename_fallback',
      marker_key: markerKey,
      partial_lineage_rows: completion.rows.length,
    });
  }

  if (!opts.dryRun && items.length > 0) {
    const discardedAt = opts.now ?? new Date().toISOString();
    await engine.transaction(async tx => {
      for (const item of items) {
        await tx.setConfig(item.marker_key, JSON.stringify({
          schema: 'gbrain-dream-operator-discard/v1',
          status: 'operator_discarded',
          reason,
          discarded_at: discardedAt,
          before: opts.before,
          file_path: item.file_path,
          content_sha256: item.content_sha256,
          logical_transcript_id: item.logical_transcript_id,
          settled_date: item.settled_date,
          settled_date_source: item.settled_date_source,
          partial_lineage_rows: item.partial_lineage_rows,
        }));
      }
    });
  }

  return {
    schema: 'gbrain-dream-close-backlog/v1',
    before: opts.before,
    dry_run: opts.dryRun,
    reason,
    transcripts_discovered: transcripts.length,
    candidates: items.length,
    markers_written: opts.dryRun ? 0 : items.length,
    already_discarded: alreadyDiscarded,
    completed_lineage: completedLineageCount,
    not_before_cutoff: notBeforeCutoff,
    undated,
    items,
  };
}

// ── Allow-list source of truth ───────────────────────────────────────

export interface DreamSynthesizeRoutes {
  reflection: string;
  original: string;
  pattern: string;
}

export interface DreamSynthesizePaths {
  globs: string[];
  routes: DreamSynthesizeRoutes;
}

export const DEFAULT_DREAM_SYNTHESIZE_ROUTES: DreamSynthesizeRoutes = {
  reflection: 'wiki/personal/reflections/{date}-<topic-slug>-{hash}',
  original: 'wiki/originals/ideas/{date}-<idea-slug>-{hash}',
  pattern: 'wiki/personal/patterns/<topic-slug>',
};

export async function loadDreamSynthesizePaths(outputRoot = 'wiki'): Promise<DreamSynthesizePaths> {
  // Search a few known locations relative to the binary / repo. The first
  // hit wins; if none found, return [].
  const candidates = [
    join(process.cwd(), 'skills', '_brain-filing-rules.json'),
    join(__dirname, '..', '..', '..', 'skills', '_brain-filing-rules.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { dream_synthesize_paths?: { globs?: unknown; routes?: unknown } };
      const globs = parsed?.dream_synthesize_paths?.globs;
      const routes = parseDreamSynthesizeRoutes(parsed?.dream_synthesize_paths?.routes);
      if (Array.isArray(globs) && globs.every(g => typeof g === 'string')) {
        return {
          globs: (globs as string[]).map(g => remapDreamAllowGlob(g, routes, outputRoot)),
          routes: {
            reflection: remapDreamRoute(routes.reflection, outputRoot),
            original: remapDreamRoute(routes.original, outputRoot),
            pattern: remapDreamRoute(routes.pattern, outputRoot),
          },
        };
      }
    } catch { /* try next */ }
  }
  return {
    globs: [],
    routes: {
      reflection: remapDreamRoute(DEFAULT_DREAM_SYNTHESIZE_ROUTES.reflection, outputRoot),
      original: remapDreamRoute(DEFAULT_DREAM_SYNTHESIZE_ROUTES.original, outputRoot),
      pattern: remapDreamRoute(DEFAULT_DREAM_SYNTHESIZE_ROUTES.pattern, outputRoot),
    },
  };
}

/**
 * #2415: `outputRoot` remaps the canonical `wiki/`-rooted globs to the
 * configured namespace (e.g. `notes/personal/reflections/*`). Default 'wiki'
 * returns the globs verbatim. Shared by the patterns phase (imported there —
 * the two phases must enforce the same allow-list).
 */
export async function loadAllowedSlugPrefixes(outputRoot = 'wiki'): Promise<string[]> {
  return (await loadDreamSynthesizePaths(outputRoot)).globs;
}

function remapDreamRoute(path: string, outputRoot: string): string {
  if (outputRoot === 'wiki' || path.startsWith(`${outputRoot}/`)) return path;
  return path.startsWith('wiki/')
    ? `${outputRoot}/${path.slice('wiki/'.length)}`
    : `${outputRoot}/${path}`;
}

function remapDreamAllowGlob(
  glob: string,
  routes: DreamSynthesizeRoutes,
  outputRoot: string,
): string {
  if (outputRoot === 'wiki' || glob.startsWith(`${outputRoot}/`)) return glob;
  if (glob.startsWith('wiki/')) return `${outputRoot}/${glob.slice('wiki/'.length)}`;
  const routedRoots = new Set(Object.values(routes).map(route => route.split('/')[0]));
  return routedRoots.has(glob.split('/')[0]) ? `${outputRoot}/${glob}` : glob;
}

function parseDreamSynthesizeRoutes(raw: unknown): DreamSynthesizeRoutes {
  if (!raw || typeof raw !== 'object') return DEFAULT_DREAM_SYNTHESIZE_ROUTES;
  const r = raw as Record<string, unknown>;
  return {
    reflection: typeof r.reflection === 'string' && r.reflection.trim()
      ? r.reflection
      : DEFAULT_DREAM_SYNTHESIZE_ROUTES.reflection,
    original: typeof r.original === 'string' && r.original.trim()
      ? r.original
      : DEFAULT_DREAM_SYNTHESIZE_ROUTES.original,
    pattern: typeof r.pattern === 'string' && r.pattern.trim()
      ? r.pattern
      : DEFAULT_DREAM_SYNTHESIZE_ROUTES.pattern,
  };
}

// ── Significance judge (gateway-routed; provider-agnostic) ──────────────
//
// The JudgeClient interface is unchanged for test-seam stability — existing
// tests that pass a mock client to judgeSignificance keep working byte-
// identically. Only the construction path moved from `new Anthropic()` to
// `gateway.chat()` so any provider with a registered recipe (Anthropic,
// DeepSeek, OpenRouter, Voyage, Ollama, llama-server, etc.) is reachable
// via `gbrain config set models.dream.synthesize_verdict <provider>:<model>`.
//
// This mirrors v0.35.5.0's `tryBuildGatewayClient` in src/core/think/index.ts
// (which closed #952 for runThink). Same pattern, same trade-offs:
// construction-time provider/key probe returns null on a clear miss (cheap
// pre-flight), and the verdict loop wraps the actual chat call in try/catch
// for AIConfigError surfacing mid-run.

export interface JudgeClient {
  create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
}

/**
 * Build a gateway-routed JudgeClient for the resolved verdict model.
 * Returns null when no chat provider is reachable for `verdictModel`:
 *   - Unknown provider id (resolveRecipe throws AIConfigError).
 *   - Anthropic provider with no key (env or config) — preserves the legacy
 *     "no ANTHROPIC_API_KEY" cheap-skip semantics.
 * On null, the verdict loop short-circuits each transcript with an explicit
 * "no configured provider" reason and continues the phase.
 *
 * For non-Anthropic providers (deepseek, openrouter, voyage, ollama,
 * llama-server, ...), we delegate auth probing to the gateway's own
 * recipe `auth_env.required` machinery — AIConfigError at gateway.chat()
 * time is caught by the verdict loop and surfaced per-transcript.
 */
export function makeJudgeClient(verdictModel: string): JudgeClient | null {
  // Normalize: ensure provider:model shape (and slash→colon — #1698). resolveModel
  // returns bare anthropic ids (e.g. `claude-haiku-4-5`); gateway.chat needs `anthropic:...`.
  const modelStr = normalizeModelId(verdictModel);

  // #1698 (C1): id-validity via the shared `validateModelId` core (resolveRecipe +
  // assertTouchpoint) — catches unknown provider AND typo'd native model. We do NOT
  // use the full `probeChatModel` here: its `isAvailable` layer would reject
  // non-Anthropic-no-key providers and an unconfigured gateway, breaking the
  // deliberate per-transcript-degrade contract (and test A9). validateModelId reads
  // the recipe registry, not gateway _config, so it works pre-configureGateway().
  const v = validateModelId(modelStr);
  if (!v.ok) return null;

  // Anthropic key probe (legacy behavior preserved verbatim). Other providers' key
  // checks happen lazily at chat call time and surface as AIConfigError, which the
  // verdict loop catches per-transcript.
  if (v.parsed.providerId === 'anthropic' && !hasAnthropicKey()) return null;

  return {
    create: async (params): Promise<Anthropic.Message> => {
      // Map Anthropic.MessageCreateParamsNonStreaming → gateway.ChatOpts.
      // `judgeSignificance` always sends string content + string system,
      // and the adapter only TEXT-flattens the array-of-blocks shape —
      // `tool_use`, `tool_result`, image, and other non-text blocks become
      // empty strings. If a future caller wires tool-use or image content
      // through this client, extend the mapping instead of relying on the
      // current silent drop. Same pattern as think/index.ts:607-615.
      const messages = params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content)
              ? m.content.map(b => ('text' in b ? b.text : '')).join('')
              : ''),
      }));
      const system = typeof params.system === 'string'
        ? params.system
        : (Array.isArray(params.system)
            ? params.system.map(b => ('text' in b ? b.text : '')).join('')
            : undefined);

      const result: ChatResult = await gatewayChat({
        model: modelStr,
        system,
        messages,
        maxTokens: params.max_tokens,
      });

      // Map gateway.ChatResult → Anthropic.Message shape. judgeSignificance
      // reads `.content[0].type === 'text'` and `.content[0].text`; other
      // fields are best-effort for downstream telemetry parity.
      return {
        id: '',
        type: 'message',
        role: 'assistant',
        model: modelStr,
        content: [{ type: 'text', text: result.text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      } as unknown as Anthropic.Message;
    },
  };
}

interface VerdictResult {
  worth_processing: boolean;
  reasons: string[];
}

export async function judgeSignificance(
  client: JudgeClient,
  t: DiscoveredTranscript,
  verdictModel = 'claude-haiku-4-5-20251001',
): Promise<VerdictResult> {
  // Truncate the transcript at 8K chars for cost control. Haiku's verdict
  // doesn't need the full body; the opening + closing sections are usually
  // representative of significance.
  //
  // v0.41.13 surrogate-safety (supersedes PRs #1559+#1561's safeSliceEnd
  // helper; see text-safe.ts:18-21 module docstring for why that helper
  // re-introduces the case-3 bug the canonical safeSplitIndex was written
  // to fix). Routes head + tail slicing through safeSplitIndex so an emoji
  // at offset 4000 (or length-4000) never produces a lone surrogate that
  // Anthropic's JSON parser rejects ("no low surrogate in string", caught
  // 2026-05-24 on telegram).
  //
  // Contract: this branch only runs when content.length > 8000, so
  // length - 4000 > 4000 > 0 — safeSplitIndex never sees an out-of-range
  // maxChars here. (Codex C-10 documented contract.)
  let trimmed: string;
  if (t.content.length > 8000) {
    const headEnd = safeSplitIndex(t.content, 4000);
    const tailStart = safeSplitIndex(t.content, t.content.length - 4000);
    trimmed = t.content.slice(0, headEnd) + '\n[...truncated...]\n' + t.content.slice(tailStart);
  } else {
    trimmed = t.content;
  }

  const sys = `You judge whether a conversation transcript is worth synthesizing into a personal knowledge brain.

WORTH PROCESSING (return worth_processing=true):
- The user articulates a new idea, frame, mental model, or thesis
- The user reflects on themselves, names patterns, processes emotion
- The user discusses specific people, companies, or decisions in depth
- The user makes a strategic call worth remembering

NOT WORTH PROCESSING (return worth_processing=false):
- Routine ops ("check my email", "schedule X")
- Pure code debugging without user reflection
- Short message exchanges with no original thought
- Repetitive content the brain already has

Respond as JSON: {"worth_processing": <bool>, "reasons": ["<short>", "<short>"]}.
Two reasons max, one phrase each.`;

  const msg = await client.create({
    model: verdictModel,
    max_tokens: 200,
    system: sys,
    messages: [{ role: 'user', content: `Transcript ${t.basename}:\n\n${trimmed}` }],
  });

  for (const block of msg.content) {
    if (block.type === 'text') {
      const text = block.text.trim();
      const m = /\{[\s\S]*\}/.exec(text);
      if (!m) continue;
      try {
        const parsed = JSON.parse(m[0]) as { worth_processing?: unknown; reasons?: unknown };
        const worth = parsed.worth_processing === true;
        const reasons = Array.isArray(parsed.reasons)
          ? parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 4)
          : [];
        return { worth_processing: worth, reasons };
      } catch { /* fall through */ }
    }
  }
  // Couldn't parse — default to NOT processing (cheap fallback).
  return { worth_processing: false, reasons: ['judge response unparseable'] };
}

// ── Subagent prompt ──────────────────────────────────────────────────

/**
 * Build the prompt for one subagent. When `chunkTotal > 1`, the slug seed
 * gains a `-c<idx>` suffix and the prompt names which chunk this is.
 *
 * D6 enforcement is orchestrator-side (rewriteChunkedSlug runs at slug-
 * collection time). Sonnet still gets the chunked seed via the prompt's
 * `USE THIS in slugs` rule for the happy path.
 */
/**
 * v0.32.6 M2 — Load prior probe findings into an informational block.
 * Returns '' if no probe runs exist or the engine doesn't know how (pre-v33
 * brain that hasn't applied migrations). Best-effort and silent on failure.
 */
async function loadPriorContradictionsBlock(engine: BrainEngine, sourceId: string): Promise<string> {
  try {
    const rows = await engine.loadContradictionsTrend(30, { sourceId });
    if (!rows || rows.length === 0) return '';
    const latest = rows[0];
    const report = latest.report_json as Record<string, unknown> | null;
    const perQuery = (report?.per_query as Array<{
      contradictions: Array<{
        severity: 'low' | 'medium' | 'high';
        axis: string;
        a: { slug: string };
        b: { slug: string };
      }>;
    }> | undefined) ?? [];
    const findings: Array<{ severity: string; axis: string; a: string; b: string }> = [];
    for (const q of perQuery) {
      for (const c of q.contradictions) {
        findings.push({ severity: c.severity, axis: c.axis, a: c.a.slug, b: c.b.slug });
      }
    }
    if (findings.length === 0) return '';
    // Sort by severity DESC (high first); take top 5 to keep prompt bounded.
    const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
    findings.sort((x, y) => (rank[y.severity] ?? 0) - (rank[x.severity] ?? 0));
    const top = findings.slice(0, 5);
    const lines = top.map((f) => `  - [${f.severity}] ${f.a} vs ${f.b}${f.axis ? ' — ' + f.axis : ''}`);
    return [
      '',
      'PRIOR DETECTED CONTRADICTIONS (latest probe run, severity DESC, top 5):',
      ...lines,
      '',
      'If your synthesis writes to any of these slugs, reconcile the contradiction',
      'in the compiled_truth instead of recreating it. Either update to the newer/',
      'correct value, mark the older claim as historical, or note the conflict',
      'explicitly. Ignore findings irrelevant to what this transcript covers.',
    ].join('\n');
  } catch {
    return '';
  }
}

function buildSynthesisPrompt(
  t: DiscoveredTranscript,
  chunkText: string,
  chunkIdx: number,
  chunkTotal: number,
  priorContradictionsBlock = '',
  routesOrOutputRoot: DreamSynthesizeRoutes | string = DEFAULT_DREAM_SYNTHESIZE_ROUTES,
): string {
  const dateHint = t.inferredDate ?? today();
  const baseSlugSegment = sanitizeForSlug(t.basename) || `session-${dateHint}`;
  const isChunked = chunkTotal > 1;
  const hashSuffix = isChunked
    ? `${t.contentHash.slice(0, 6)}-c${chunkIdx}`
    : t.contentHash.slice(0, 6);
  const chunkBanner = isChunked
    ? `\n- This is CHUNK ${chunkIdx + 1} of ${chunkTotal} from the same transcript. Different chunks process different sections; do not assume continuity with other chunks.`
    : '';
  const transcriptHeader = isChunked
    ? `${t.filePath} (chunk ${chunkIdx + 1}/${chunkTotal})`
    : t.filePath;
  const routes = typeof routesOrOutputRoot === 'string'
    ? {
        reflection: remapDreamRoute(DEFAULT_DREAM_SYNTHESIZE_ROUTES.reflection, routesOrOutputRoot),
        original: remapDreamRoute(DEFAULT_DREAM_SYNTHESIZE_ROUTES.original, routesOrOutputRoot),
        pattern: remapDreamRoute(DEFAULT_DREAM_SYNTHESIZE_ROUTES.pattern, routesOrOutputRoot),
      }
    : routesOrOutputRoot;
  const reflectionSlugTemplate = renderDreamSlugRoute(routes.reflection, dateHint, hashSuffix);
  const originalSlugTemplate = renderDreamSlugRoute(routes.original, dateHint, hashSuffix);
  return `You are synthesizing a conversation transcript into the user's personal knowledge brain.

CONTEXT
- Today's date: ${dateHint}
- Transcript hash suffix (USE THIS in slugs): ${hashSuffix}
- Source file basename: ${baseSlugSegment}${chunkBanner}${priorContradictionsBlock}

OUTPUT POLICY (ALL of these are required)
1. Quote the user verbatim. Do not paraphrase memorable phrasings.
2. Cross-reference compulsively: every new page MUST contain at least one wikilink (e.g., \`[ref](people/jane-doe)\` or \`[[people/jane-doe]]\`) to existing brain content. Use the search tool to find existing pages first.
3. Do NOT write to any path outside the allow-list shown in the put_page schema.
4. Slug discipline: lowercase alphanumeric and hyphens only, slash-separated segments. NO underscores, NO file extensions.

TASKS
A. Reflections (self-knowledge, pattern recognition, emotional processing):
   slug: \`${reflectionSlugTemplate}\`

B. Originals (new ideas, frames, theses, mental models):
   slug: \`${originalSlugTemplate}\`

C. People mentions: search first; if a page exists, do not put_page over it (the orchestrator handles people enrichment via timeline entries — your job is the reflection/original synthesis, NOT modifying existing person pages).

D. If nothing in this transcript meets the bar (significance filter already passed but the content is still routine), return without writing anything.

FRONTMATTER LINKS (typed edges — precision over recall)
On every page you write, connect it to EXISTING brain pages by adding these YAML frontmatter fields (list form, exact slugs only). Your schema pack turns the valid ones into typed graph edges; unmatched fields stay inert, so target the right pages and let the pack decide what materializes.
- relevant_to: 2-5 existing pages this output is genuinely ABOUT — projects, concepts, ideas, research, people, or companies. This is the primary connective tissue. A few precise links beat many loose ones.
- derived_from: (Originals/ideas only) the 1-2 existing source pages this idea explicitly BUILDS ON — a source, research page, prior idea/concept, meeting, or contract. Use only when the idea clearly grew out of that page.
- supersedes: ONLY when this page explicitly REPLACES a specific prior page (a correction that makes the old page wrong) — NOT lineage, and NOT the case where you update an existing page under its own slug. Omit otherwise.

HARD RULES for these fields:
- Reference ONLY slugs you have actually SEEN exist (in your search-tool results or the context above). If you are unsure a page exists, DO NOT list it in frontmatter — write it in the body as a [[wikilink]] instead (that becomes a harmless mention).
- Never invent, guess, or construct a slug.
- Maximum 2-5 relevant_to entries. Precision over recall.
- Add NO frontmatter fields beyond these and the ones you already emit (type, title, and any you were already writing).

Example frontmatter for a page you write:
---
type: personal
title: ...
relevant_to:
  - projects/design-library
  - concepts/adversarial-verification
---

TRANSCRIPT (${transcriptHeader})
---
${chunkText}
---

When done, briefly list the slugs you wrote in your final message so the orchestrator can audit.`;
}

export function renderDreamSlugRoute(template: string, dateHint: string, hashSuffix: string): string {
  return template
    .replaceAll('{date}', dateHint)
    .replaceAll('{hash}', hashSuffix);
}

function sanitizeForSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── Slug collection from child put_page calls (codex #2 + D6) ────────

/**
 * D6 (orchestrator-side deterministic slug rewrite, zero Sonnet trust):
 * two-stage path — raw fetch (no DISTINCT, preserves duplicate evidence) →
 * in-memory chunk-suffix rewrite via `rewriteChunkedSlug` for chunked
 * children → return distinct rewritten set.
 *
 * Closes Codex finding #2 ("collision detection via SELECT DISTINCT was
 * fake"): we no longer need detection because the rewrite enforces
 * uniqueness at slug-write time.
 *
 * `chunkInfo` maps child job_id → { chunk_index, hash6 }. Single-chunk
 * children are absent from the map and pass through unchanged.
 */
async function collectChildPutPageSlugs(
  engine: BrainEngine,
  childIds: number[],
  chunkInfo: Map<number, { idx: number; hash6: string }>,
  sourceId: string,
): Promise<Array<{ slug: string; source_id: string }>> {
  if (childIds.length === 0) return [];
  // Raw fetch — NO SELECT DISTINCT. Preserves per-child slug duplicates so
  // the orchestrator sees what each child wrote. COALESCE handles both
  // properly-stored jsonb objects (input->>'slug') and double-encoded jsonb
  // strings from pre-fix data ((input #>> '{}')::jsonb->>'slug').
  //
  // v0.32.8: returns Array<{slug, source_id}> instead of string[]. Subagent
  // put_page tool schema doesn't expose source_id (subagents are scoped to
  // a single source). #1586: the orchestrator scopes each child to the
  // cycle's resolved source via SubagentHandlerData.source_id, and stamps
  // the SAME source here so reverseWriteRefs / provenance reads target the
  // correct (source_id, slug) row. Unset → legacy 'default'.
  const rows = await engine.executeRaw<{ job_id: number; slug: string }>(
    `SELECT job_id,
            COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'`,
    [childIds],
  );
  const rewritten = new Set<string>();
  for (const r of rows) {
    if (typeof r.slug !== 'string' || r.slug.length === 0) continue;
    const ci = chunkInfo.get(r.job_id);
    rewritten.add(ci ? rewriteChunkedSlug(r.slug, ci.hash6, ci.idx) : r.slug);
  }
  const resultRows = await engine.executeRaw<{ id: number; result: unknown }>(
    `SELECT id, result
       FROM minion_jobs
      WHERE id = ANY($1::int[])
        AND name = 'shell-subagent'
        AND status = 'completed'
        AND result IS NOT NULL`,
    [childIds],
  );
  for (const r of resultRows) {
    const result = typeof r.result === 'string'
      ? JSON.parse(r.result) as Record<string, unknown>
      : (r.result && typeof r.result === 'object' ? r.result as Record<string, unknown> : null);
    const slugs = result?.written_slugs;
    if (!Array.isArray(slugs)) continue;
    for (const slug of slugs) {
      if (typeof slug !== 'string' || slug.length === 0) continue;
      const ci = chunkInfo.get(r.id);
      rewritten.add(ci ? rewriteChunkedSlug(slug, ci.hash6, ci.idx) : slug);
    }
  }
  return Array.from(rewritten).sort().map(slug => ({ slug, source_id: sourceId }));
}

interface SynthesizeLineageRow {
  id: number;
  name: string;
  idempotency_key: string;
  status: string;
  data: unknown;
  result: unknown;
}

interface TranscriptCompletionState {
  via: 'marker' | 'stable_job' | 'legacy_job' | null;
  rows: SynthesizeLineageRow[];
}

function lineageRemainder(key: string, base: string, allowSuffixMatch: boolean): string | null {
  if (key === base) return '';
  if (key.startsWith(`${base}:`)) return key.slice(base.length);
  if (!allowSuffixMatch) return null;
  const idx = key.lastIndexOf(base.slice('dream:synth'.length));
  if (idx < 0) return null;
  const end = idx + base.slice('dream:synth'.length).length;
  if (end !== key.length && key[end] !== ':') return null;
  return key.slice(end);
}

/** Return the exact completed receipt set: one row, or a full 0..N-1 chunk set. */
function completedLineageRows(
  rows: readonly SynthesizeLineageRow[],
  base: string,
  allowSuffixMatch: boolean,
): SynthesizeLineageRow[] | null {
  const exact = rows
    .filter(row => row.status === 'completed' && lineageRemainder(row.idempotency_key, base, allowSuffixMatch) === '')
    .sort((a, b) => a.id - b.id)[0];
  if (exact) return [exact];

  const completedChunks = new Map<number, Map<number, SynthesizeLineageRow>>();
  for (const row of rows) {
    const remainder = lineageRemainder(row.idempotency_key, base, allowSuffixMatch);
    if (remainder === null) continue;
    if (remainder === '') continue;
    const match = /^:c(\d+)of(\d+)$/.exec(remainder);
    if (!match || row.status !== 'completed') continue;
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total <= 0 || index < 0 || index >= total) continue;
    const indexes = completedChunks.get(total) ?? new Map<number, SynthesizeLineageRow>();
    const current = indexes.get(index);
    if (!current || row.id < current.id) indexes.set(index, row);
    completedChunks.set(total, indexes);
  }
  for (const total of Array.from(completedChunks.keys()).sort((a, b) => a - b)) {
    const indexes = completedChunks.get(total)!;
    if (indexes.size === total && Array.from({ length: total }, (_, index) => indexes.has(index)).every(Boolean)) {
      return Array.from({ length: total }, (_, index) => indexes.get(index)!);
    }
  }
  return null;
}

/** A lineage is complete only for an exact single row or a full 0..N-1 chunk set. */
function completedLineage(
  rows: readonly SynthesizeLineageRow[],
  base: string,
  allowSuffixMatch: boolean,
): boolean {
  return completedLineageRows(rows, base, allowSuffixMatch) !== null;
}

function legacyPathBases(filePath: string): string[] {
  return Array.from(new Set([filePath, resolve(filePath)]))
    .map(path => `dream:synth:${path}`);
}

function legacyPathLineageMatch(
  idempotencyKey: string,
  pathBase: string,
): { base: string; remainder: string } | null {
  const direct = lineageRemainder(idempotencyKey, pathBase, false);
  if (direct !== null) return { base: pathBase, remainder: direct };

  const prefix = 'dream:synth:';
  const path = pathBase.slice(prefix.length);
  if (!path || !idempotencyKey.startsWith(prefix)) return null;
  const namespaced = idempotencyKey.slice(prefix.length);
  const separator = namespaced.indexOf(':');
  if (separator <= 0) return null;
  const sourceId = namespaced.slice(0, separator);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId)) return null;
  const namespacedBase = `${prefix}${sourceId}:${path}`;
  const remainder = lineageRemainder(idempotencyKey, namespacedBase, false);
  return remainder === null ? null : { base: namespacedBase, remainder };
}

/**
 * Legacy completion is path-scoped, not current-content-scoped. Exporters now
 * add identity/provenance frontmatter, so the same settled logical transcript
 * can have different bytes from the version whose path/hash job completed.
 * Keep each historical hash lineage isolated: chunks from different hashes
 * must never be combined into a synthetic "complete" set.
 */
function completedLegacyLineageByPath(
  rows: readonly SynthesizeLineageRow[],
  filePath: string,
): boolean {
  for (const pathBase of legacyPathBases(filePath)) {
    const byHashBase = new Map<string, SynthesizeLineageRow[]>();
    for (const row of rows) {
      const lineage = legacyPathLineageMatch(row.idempotency_key, pathBase);
      if (!lineage) continue;
      const match = /^:([^:]+)(?::c\d+of\d+)?$/.exec(lineage.remainder);
      if (!match) continue;
      const hashBase = `${lineage.base}:${match[1]}`;
      const group = byHashBase.get(hashBase) ?? [];
      group.push(row);
      byHashBase.set(hashBase, group);
    }
    for (const [hashBase, group] of byHashBase) {
      if (completedLineage(group, hashBase, false)) return true;
    }
  }
  return false;
}

async function loadTranscriptLineageRows(
  engine: BrainEngine,
  transcript: DiscoveredTranscript,
): Promise<SynthesizeLineageRow[]> {
  const stableBase = transcript.logicalIdentity
    ? synthesizeLogicalIdempotencyKey(transcript.logicalIdentity)
    : '__no_stable_identity__';
  const pathBases = legacyPathBases(transcript.filePath);
  const legacyPathBase = pathBases[0];
  const resolvedLegacyPathBase = pathBases[1] ?? '__same_legacy_path__';
  const legacyPath = legacyPathBase.slice('dream:synth:'.length);
  const resolvedLegacyPath = resolvedLegacyPathBase.slice('dream:synth:'.length);
  return engine.executeRaw<SynthesizeLineageRow>(
    `SELECT mj.id, mj.name, mj.idempotency_key, mj.status, mj.data, mj.result
       FROM minion_jobs mj
      WHERE idempotency_key IS NOT NULL
        AND (
          mj.idempotency_key = $1
          OR LEFT(mj.idempotency_key, char_length($2) + 1) = $2 || ':'
          OR LEFT(mj.idempotency_key, char_length($3) + 1) = $3 || ':'
          OR LEFT(mj.idempotency_key, char_length($4) + 1) = $4 || ':'
          OR EXISTS (
            SELECT 1
              FROM sources s
             WHERE LEFT(
                     mj.idempotency_key,
                     char_length('dream:synth:' || s.id || ':' || $5) + 1
                   ) = 'dream:synth:' || s.id || ':' || $5 || ':'
                OR LEFT(
                     mj.idempotency_key,
                     char_length('dream:synth:' || s.id || ':' || $6) + 1
                   ) = 'dream:synth:' || s.id || ':' || $6 || ':'
          )
        )`,
    [stableBase, stableBase, legacyPathBase, resolvedLegacyPathBase, legacyPath, resolvedLegacyPath],
  );
}

async function transcriptCompletionState(
  engine: BrainEngine,
  transcript: DiscoveredTranscript,
): Promise<TranscriptCompletionState> {
  if (transcript.logicalIdentity) {
    const marker = await engine.getConfig(synthesizeLogicalCompletionKey(transcript.logicalIdentity));
    if (marker) return { via: 'marker', rows: [] };
  }

  const rows = await loadTranscriptLineageRows(engine, transcript);
  if (transcript.logicalIdentity) {
    const stableBase = synthesizeLogicalIdempotencyKey(transcript.logicalIdentity);
    const completedRows = completedLineageRows(rows, stableBase, false);
    if (completedRows) {
      return { via: 'stable_job', rows: completedRows };
    }
  }
  if (completedLegacyLineageByPath(rows, transcript.filePath)) {
    return { via: 'legacy_job', rows };
  }
  return { via: null, rows };
}

async function findRequiredChunkCompletion(
  engine: BrainEngine,
  transcript: DiscoveredTranscript,
  chunk?: { index: number; total: number },
): Promise<SynthesizeLineageRow | null> {
  const rows = await loadTranscriptLineageRows(engine, transcript);
  const stableBase = transcript.logicalIdentity
    ? synthesizeLogicalIdempotencyKey(transcript.logicalIdentity)
    : null;
  const legacyHash = transcript.contentHash.slice(0, 16);
  const expectedRemainder = chunk ? `:c${chunk.index}of${chunk.total}` : '';
  return rows.find(row => {
    if (row.status !== 'completed') return false;
    if (stableBase && lineageRemainder(row.idempotency_key, stableBase, false) === expectedRemainder) return true;
    return legacyPathBases(transcript.filePath).some(pathBase => {
      const lineage = legacyPathLineageMatch(row.idempotency_key, pathBase);
      return lineage?.remainder === `:${legacyHash}${expectedRemainder}`;
    });
  }) ?? null;
}

function lineageRowFromJob(job: MinionJob): SynthesizeLineageRow {
  if (!job.idempotency_key) {
    throw new Error(`completed synthesis child ${job.id} is missing its idempotency key`);
  }
  return {
    id: job.id,
    name: job.name,
    idempotency_key: job.idempotency_key,
    status: job.status,
    data: job.data,
    result: job.result,
  };
}

function assertPersistedCompletedJobReceipt(row: SynthesizeLineageRow): void {
  if (row.status !== 'completed') {
    throw new Error(`synthesis child ${row.id} cannot resume from non-completed status ${row.status}`);
  }
  if (row.result === null || row.result === undefined) {
    throw new Error(`completed synthesis child ${row.id} has no persisted result receipt`);
  }
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Rebuild chunk rewrite metadata only from durable job identity/prompt data. */
function recoveredChunkInfo(
  row: SynthesizeLineageRow,
  transcript: DiscoveredTranscript,
): { idx: number; hash6: string } | null {
  let index: number | null = null;
  let total: number | null = null;
  let hash6: string | null = null;

  if (transcript.logicalIdentity) {
    const stableBase = synthesizeLogicalIdempotencyKey(transcript.logicalIdentity);
    const remainder = lineageRemainder(row.idempotency_key, stableBase, false);
    const stableChunk = remainder === null ? null : /^:c(\d+)of(\d+)$/.exec(remainder);
    if (stableChunk) {
      index = Number(stableChunk[1]);
      total = Number(stableChunk[2]);
    }
  }

  if (index === null || total === null) {
    for (const pathBase of legacyPathBases(transcript.filePath)) {
      const lineage = legacyPathLineageMatch(row.idempotency_key, pathBase);
      if (!lineage) continue;
      const legacyChunk = /^:([^:]+):c(\d+)of(\d+)$/.exec(lineage.remainder);
      if (!legacyChunk) continue;
      index = Number(legacyChunk[2]);
      total = Number(legacyChunk[3]);
      hash6 = legacyChunk[1].slice(0, 6);
      break;
    }
  }

  if (index === null || total === null) return null;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total <= 0 || index < 0 || index >= total) {
    throw new Error(`completed synthesis child ${row.id} has malformed chunk identity`);
  }

  if (!hash6) {
    const prompt = parseRecord(row.data)?.prompt;
    const match = typeof prompt === 'string'
      ? /Transcript hash suffix \(USE THIS in slugs\): ([a-f0-9]{6})(?:-c\d+)?/i.exec(prompt)
      : null;
    hash6 = match?.[1]?.toLowerCase() ?? null;
  }
  if (!hash6) {
    throw new Error(`completed synthesis child ${row.id} is missing persisted chunk hash metadata`);
  }
  return { idx: index, hash6 };
}

async function markLogicalTranscriptComplete(
  engine: BrainEngine,
  transcript: DiscoveredTranscript,
  completedAt = new Date().toISOString(),
): Promise<void> {
  if (!transcript.logicalIdentity) return;
  await engine.setConfig(
    synthesizeLogicalCompletionKey(transcript.logicalIdentity),
    completedAt,
  );
}

// ── Dream-provenance DB stamp (#2569) ────────────────────────────────

/**
 * Persist the dream-output identity marker (`dream_generated: true` +
 * `dream_cycle_date`) into the `pages.frontmatter` JSONB row for every page
 * a synthesize child wrote. Render-time `frontmatterOverrides` alone only
 * reach the markdown FILE — the DB row stayed unstamped, so DB consumers
 * couldn't enumerate generated pages and a later put_page write-through
 * (which re-renders from the DB row) silently erased the marker.
 *
 * Plain UPDATE through executeRawJsonb (raw object bound to $3::jsonb —
 * never JSON.stringify into a ::jsonb cast; engine-parity safe, no new
 * engine method). Best-effort per row: a stamp failure never kills the
 * phase (the render-time override still covers the file).
 */
async function stampDreamProvenance(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string }>,
  cycleDate: string,
): Promise<void> {
  if (refs.length === 0) return;
  const { executeRawJsonb } = await import('../sql-query.ts');
  for (const { slug, source_id } of refs) {
    try {
      await executeRawJsonb(
        engine,
        `UPDATE pages
            SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || $3::jsonb
          WHERE slug = $1 AND source_id = $2`,
        [slug, source_id],
        [{ dream_generated: true, dream_cycle_date: cycleDate }],
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] provenance stamp ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
}

// ── Reverse-write DB rows → markdown files ───────────────────────────

async function reverseWriteRefs(
  engine: BrainEngine,
  brainDir: string,
  refs: Array<{ slug: string; source_id: string }>,
  cycleDate: string,
  nativeSourceId = 'default',
): Promise<number> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cycleDate)) {
    throw new Error(`reverse-write cycle date must be YYYY-MM-DD; got ${JSON.stringify(cycleDate)}`);
  }

  // Crash-resume / legacy defense-in-depth. New Dream children are stamped
  // inside put_page before facts/chronicle backstops run; historical completed
  // jobs may predate that context. Stamp every referenced DB row transactionally
  // before exposing any rendered file or allowing later cycle phases to scan it.
  const stampedPages = await engine.transaction(async tx => {
    const pages = new Map<string, { page: Page; tags: string[] }>();
    for (const { slug, source_id } of refs) {
      validateSourceId(source_id);
      const before = await tx.getPage(slug, { sourceId: source_id });
      if (!before) {
        throw new Error(`reverse-write receipt references missing page ${slug}@${source_id}`);
      }
      const tags = await tx.getTags(slug, { sourceId: source_id });
      const updated = await tx.mergePageFrontmatter(slug, source_id, {
        dream_generated: true,
        dream_cycle_date: cycleDate,
      });
      if (!updated) {
        throw new Error(`reverse-write could not stamp live page ${slug}@${source_id}`);
      }
      const after = await tx.getPage(slug, { sourceId: source_id });
      if (!after) {
        throw new Error(`reverse-write stamped page disappeared ${slug}@${source_id}`);
      }
      if (after.frontmatter?.dream_generated !== true ||
          after.frontmatter?.dream_cycle_date !== cycleDate ||
          after.content_hash !== before.content_hash) {
        throw new Error(`reverse-write DB marker verification failed for ${slug}@${source_id}`);
      }
      if (after.type !== before.type || after.title !== before.title ||
          after.compiled_truth !== before.compiled_truth || after.timeline !== before.timeline) {
        throw new Error(`reverse-write metadata stamp mutated page content ${slug}@${source_id}`);
      }
      pages.set(`${source_id}\0${slug}`, { page: after, tags });
    }
    return pages;
  });

  let count = 0;
  for (const { slug, source_id } of refs) {
    // v0.32.8 F6: validate source_id is filesystem-safe before any join().
    validateSourceId(source_id);
    const stamped = stampedPages.get(`${source_id}\0${slug}`);
    if (!stamped) {
      throw new Error(`reverse-write transaction lost stamped page ${slug}@${source_id}`);
    }
    const { page, tags } = stamped;
    try {
      const md = renderPageToMarkdown(page, tags);
      // v0.32.8 F6: foreign-source pages land at brainDir/.sources/<id>/<slug>.md
      // so same-slug-different-source pages don't collide. Pages belonging to
      // the cycle's own source (#1586: brainDir IS that source's checkout —
      // legacy 'default' when unscoped) stay at brainDir/<slug>.md.
      const filePath = source_id === nativeSourceId
        ? join(brainDir, `${slug}.md`)
        : join(brainDir, '.sources', source_id, `${slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, md, 'utf8');
      const written = readFileSync(filePath, 'utf8');
      if (written !== md) {
        throw new Error(`read-after-write mismatch at ${filePath}`);
      }
      const parsed = parseMarkdown(written, filePath);
      if (parsed.frontmatter.dream_generated !== true ||
          parsed.frontmatter.dream_cycle_date !== cycleDate ||
          parsed.type !== page.type || parsed.title !== page.title ||
          parsed.compiled_truth !== page.compiled_truth || parsed.timeline !== page.timeline) {
        throw new Error(`DB/file Dream marker parity verification failed at ${filePath}`);
      }
      count++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`reverse-write ${slug}@${source_id} failed: ${msg}`);
    }
  }
  return count;
}

/**
 * Render an already-stamped Dream Page to markdown. The trusted child put_page
 * context and reverse-write repair transaction own DB provenance; rendering
 * must not invent fields that are absent from the row or DB/file parity can
 * silently diverge.
 */
export function renderPageToMarkdown(page: Page, tags: string[]): string {
  if (page.frontmatter?.dream_generated !== true ||
      typeof page.frontmatter?.dream_cycle_date !== 'string') {
    throw new Error(`refusing to render unstamped Dream page ${page.slug}`);
  }
  return serializePageToMarkdown(page, tags);
}

// ── Summary index page ───────────────────────────────────────────────

async function writeSummaryPage(
  engine: BrainEngine,
  brainDir: string,
  summarySlug: string,
  summaryDate: string,
  writtenSlugs: string[],
  childOutcomes: Array<{ jobId: number; status: string }>,
  sourceId: string,
): Promise<void> {
  const completed = childOutcomes.filter(c => c.status === 'completed').length;
  const failed = childOutcomes.length - completed;

  const lines: string[] = [];
  lines.push(`# Dream cycle ${summaryDate}`);
  lines.push('');
  lines.push(`**Children:** ${completed} completed, ${failed} failed/timeout.`);
  lines.push(`**Pages written:** ${writtenSlugs.length}.`);
  lines.push('');
  if (writtenSlugs.length > 0) {
    lines.push('## Pages');
    lines.push('');
    for (const s of writtenSlugs) {
      lines.push(`- [[${s}]]`);
    }
    lines.push('');
  }

  const body = lines.join('\n');
  // Stamp the dream-output identity marker into the summary's frontmatter.
  // parseMarkdown below round-trips it into the DB-stored frontmatter, so the
  // marker survives any later reverse-render of the summary page.
  const fullMarkdown = serializeMarkdown(
    { dream_generated: true, dream_cycle_date: summaryDate } as Record<string, unknown>,
    body,
    '',
    { type: 'report' as string, title: `Dream cycle ${summaryDate}`, tags: ['dream-cycle'] },
  );

  // Direct engine.putPage — orchestrator write, no subagent context, no
  // allow-list check (server-side viaSubagent=false). The summary slug is
  // pre-validated against SUMMARY_SLUG_RE in the caller.
  // Importing put_page via operations.ts would re-run namespace logic
  // unnecessarily; we go straight to the engine.
  const { parseMarkdown } = await import('../markdown.ts');
  const parsed = parseMarkdown(fullMarkdown);
  // #1586: summary lands in the cycle's resolved source too — otherwise the
  // children live in the named source while the index drifts to 'default'.
  await engine.putPage(summarySlug, {
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  }, { sourceId });

  // parseMarkdown projects tags outside PageInput. Reconcile the generated
  // summary's relational tags explicitly so the DB and dual-written markdown
  // cannot diverge after a successful run or crash-resume retry.
  const desiredSummaryTags = ['dream-cycle'];
  const existingSummaryTags = await engine.getTags(summarySlug, { sourceId });
  for (const tag of existingSummaryTags) {
    if (!desiredSummaryTags.includes(tag)) {
      await engine.removeTag(summarySlug, tag, { sourceId });
    }
  }
  for (const tag of desiredSummaryTags) {
    await engine.addTag(summarySlug, tag, { sourceId });
  }

  const storedSummary = await engine.getPage(summarySlug, { sourceId });
  if (!storedSummary) {
    throw new Error(`summary DB postcondition missing ${summarySlug}@${sourceId}`);
  }
  if (storedSummary.compiled_truth !== parsed.compiled_truth) {
    throw new Error(`summary DB postcondition body mismatch ${summarySlug}@${sourceId}`);
  }
  if (storedSummary.type !== 'report') {
    throw new Error(`summary DB postcondition type mismatch ${summarySlug}@${sourceId}`);
  }
  const storedSummaryTags = (await engine.getTags(summarySlug, { sourceId })).sort();
  if (storedSummaryTags.length !== 1 || storedSummaryTags[0] !== 'dream-cycle') {
    throw new Error(`summary DB postcondition tags mismatch ${summarySlug}@${sourceId}`);
  }

  // Also write to disk (orchestrator dual-write).
  try {
    validateSourceId(sourceId);
    const filePath = sourceId === 'default'
      ? join(brainDir, `${summarySlug}.md`)
      : join(brainDir, '.sources', sourceId, `${summarySlug}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, fullMarkdown, 'utf8');
    const written = readFileSync(filePath, 'utf8');
    if (written !== fullMarkdown) {
      throw new Error(`read-after-write mismatch at ${filePath}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`summary file-write failed: ${msg}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function loadAdHocTranscript(
  filePath: string,
  minChars: number,
  excludePatterns: string[],
  bypassGuard?: boolean,
  provenanceRoot?: string | null,
): DiscoveredTranscript[] {
  const { readSingleTranscript } = require('./transcript-discovery.ts') as typeof import('./transcript-discovery.ts');
  const t = readSingleTranscript(filePath, {
    minChars,
    excludePatterns,
    bypassGuard,
    provenanceRoot,
  });
  return t ? [t] : [];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ok(summary: string, details: Record<string, unknown> = {}): PhaseResult {
  return { phase: 'synthesize', status: 'ok', duration_ms: 0, summary, details };
}

function warned(summary: string, details: Record<string, unknown> = {}): PhaseResult {
  return { phase: 'synthesize', status: 'warn', duration_ms: 0, summary, details };
}

function skipped(reason: string, summary: string): PhaseResult {
  return {
    phase: 'synthesize',
    status: 'skipped',
    duration_ms: 0,
    summary,
    details: { reason },
  };
}

function failed(error: PhaseError): PhaseResult {
  return {
    phase: 'synthesize',
    status: 'fail',
    duration_ms: 0,
    summary: 'synthesize phase failed',
    details: {},
    error,
  };
}

function failedWithDetails(
  error: PhaseError,
  details: Record<string, unknown>,
  summary = 'synthesize phase failed',
): PhaseResult {
  return {
    phase: 'synthesize',
    status: 'fail',
    duration_ms: 0,
    summary,
    details,
    error,
  };
}

function makeError(cls: string, code: string, message: string, hint?: string): PhaseError {
  return hint ? { class: cls, code, message, hint } : { class: cls, code, message };
}

// ── Test-only export ───────────────────────────────────────
// `__testing` re-exports otherwise-private helpers so unit tests can pin
// behavior at function granularity (e.g., #745 collectChildPutPageSlugs
// double-encoded jsonb regression). Not part of the runtime contract.
export const __testing = {
  collectChildPutPageSlugs,
  buildSynthesisPrompt,
  stampDreamProvenance,
  reverseWriteRefs,
  DEFAULT_DREAM_SYNTHESIZE_ROUTES,
  parseDreamSynthesizeRoutes,
  renderDreamSlugRoute,
  loadPriorContradictionsBlock,
  writeSummaryPage,
};
