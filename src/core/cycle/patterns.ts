/**
 * Patterns phase (v0.23) — cross-session theme detection.
 *
 * Reads recent reflections (within `lookback_days`), runs a single Sonnet
 * subagent to surface themes that recur across ≥`min_evidence` distinct
 * reflections, and writes one pattern page per theme.
 *
 * MUST run after `extract` so the graph state (links, timeline) is fresh.
 * Subagent put_page calls have ctx.remote=true; the trusted-workspace
 * allow-list re-enables auto-link / auto-timeline for synth + pattern
 * writes (operations.ts:trustedWorkspace branch).
 *
 * v1 behavior:
 *   - Single Sonnet subagent (no fan-out — one job per cycle is plenty).
 *   - Idempotent: if reflection set is below `min_evidence`, phase is skipped.
 *   - Pattern slug uses LLM's chosen topic-slug (subagent prompt instructs format).
 *   - Existing pattern pages are updated in place via put_page (idempotent
 *     ON CONFLICT semantics in importFromContent).
 */

import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData } from '../minions/types.ts';
import { serializeMarkdown } from '../markdown.ts';
import type { Page, PageType } from '../types.ts';
import { probeChatModel } from '../ai/gateway.ts';
import { normalizeModelId } from '../model-id.ts';
import {
  DEFAULT_DREAM_SYNTHESIZE_ROUTES,
  loadDreamSynthesizePaths,
  loadOutputRoot,
  renderDreamSlugRoute,
  type DreamSynthesizeRoutes,
} from './synthesize.ts';

export interface PatternsPhaseOpts {
  brainDir: string;
  dryRun: boolean;
  sourceId?: string;
  yieldDuringPhase?: () => Promise<void>;
}

export async function runPhasePatterns(
  engine: BrainEngine,
  opts: PatternsPhaseOpts,
): Promise<PhaseResult> {
  const start = Date.now();
  try {
    const config = await loadPatternsConfig(engine);

    if (!config.enabled) {
      return skipped('disabled', 'dream.patterns.enabled is false');
    }

    const synthPaths = await loadDreamSynthesizePaths(config.outputRoot);
    const reflectionLikePrefix = deriveDreamRouteLikePrefix(
      synthPaths.routes.reflection,
      'wiki/personal/reflections/%',
    );

    // Gather reflections within lookback window.
    const reflections = await gatherReflections(engine, config.lookbackDays, reflectionLikePrefix);
    if (reflections.length < config.minEvidence) {
      return skipped(
        'insufficient_evidence',
        `${reflections.length} reflections in last ${config.lookbackDays}d (need ≥${config.minEvidence})`,
      );
    }

    if (opts.dryRun) {
      return ok(`dry-run: would detect patterns over ${reflections.length} reflections`, {
        reflections_considered: reflections.length,
        patterns_written: 0,
        dryRun: true,
      });
    }

    // Submit one subagent for pattern detection. The subagent dispatches via
    // the gateway model-tier resolver, so gate on "is the resolved model's
    // provider reachable" rather than ANTHROPIC_API_KEY specifically — a
    // hardcoded env gate misclassified non-Anthropic stacks (litellm,
    // deepseek, openrouter, ...) as "no upstream" even though the subagent
    // routes them through the gateway (agent.use_gateway_loop), and it missed
    // Anthropic keys set via `gbrain config set anthropic_api_key`. Same
    // probe semantics as think/index.ts + synthesize's makeJudgeClient:
    // unknown provider/model or Anthropic-without-key skips cheaply; other
    // providers' auth is checked lazily at dispatch and surfaces in the job
    // outcome. (Takeover of PR #2279's intent by @brettdavies.)
    if (!config.useSubscriptionBilling) {
      const probe = probeChatModel(normalizeModelId(config.model));
      if (!probe.ok) {
        return skipped('no_provider', `pattern detection skipped: ${probe.detail}`);
      }
    }

    const allowedSlugPrefixes = synthPaths.globs;
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }

    const queue = new MinionQueue(engine);
    const childJobName = config.useSubscriptionBilling ? 'shell-subagent' : 'subagent';
    const subagentModel = config.model.includes(':')
      ? config.model
      : config.model.toLowerCase().startsWith('claude-')
        ? `anthropic:${config.model}`
        : config.model;
    const data: SubagentHandlerData = {
      prompt: buildPatternsPrompt(
        reflections,
        config.minEvidence,
        synthPaths.routes,
        reflectionLikePrefix,
      ),
      model: subagentModel,
      max_turns: 30,
      allowed_slug_prefixes: allowedSlugPrefixes,
      ...(opts.sourceId && opts.sourceId !== 'default' ? { source_id: opts.sourceId } : {}),
    };
    const submitOpts: Partial<MinionJobInput> = {
      max_stalled: 3,
      timeout_ms: config.subagentTimeoutMs,
    };
    const job = await queue.add(childJobName, data as unknown as Record<string, unknown>, submitOpts, {
      allowProtectedSubmit: true,
    });

    let outcome: string;
    try {
      const final = await waitForCompletion(queue, job.id, {
        timeoutMs: config.subagentWaitTimeoutMs,
        pollMs: 5 * 1000,
      });
      outcome = final.status;
    } catch (e) {
      if (e instanceof TimeoutError) outcome = 'timeout';
      else throw e;
    }

    if (opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* best-effort */ }
    }

    // Collect refs the subagent wrote (codex finding #2 — query tool exec rows).
    // v0.32.8: refs carry source_id so reverseWriteRefs targets the right
    // (source, slug) row instead of the first DB match.
    const writtenRefs = await collectChildPutPageSlugs(engine, [job.id], opts.sourceId ?? 'default');

    // Reverse-write to fs.
    const reverseWriteCount = await reverseWriteRefs(engine, opts.brainDir, writtenRefs);

    const details = {
      reflections_considered: reflections.length,
      patterns_written: writtenRefs.length,
      reverse_write_count: reverseWriteCount,
      child_outcome: outcome,
      job_id: job.id,
    };

    // #2782: the phase status must reflect the child outcome. Pre-fix this
    // returned status:ok even when the subagent timed out (e.g. no
    // subagent-capable worker slot free for the whole wait window) and zero
    // pattern pages were written — a silent no-op for days.
    if (outcome !== 'complete') {
      if (writtenRefs.length === 0) {
        return {
          phase: 'patterns',
          status: 'fail',
          duration_ms: 0,
          summary: `pattern-detection subagent job ${job.id} ended '${outcome}'; nothing was written`,
          details,
          error: makeError(
            outcome === 'timeout' ? 'Timeout' : 'InternalError',
            `PATTERNS_CHILD_${outcome.toUpperCase()}`,
            `subagent job ${job.id} outcome '${outcome}' with zero pattern pages written`,
            outcome === 'timeout'
              ? 'A timeout with zero writes usually means no subagent-capable worker claimed the job. Check `gbrain jobs list` and worker capacity.'
              : undefined,
          ),
        };
      }
      // Partial: the child died/timed out but some pages landed first.
      return {
        phase: 'patterns',
        status: 'warn',
        duration_ms: 0,
        summary: `${writtenRefs.length} pattern page(s) written but subagent job ${job.id} ended '${outcome}'`,
        details,
      };
    }

    return ok(`${writtenRefs.length} pattern page(s) written/updated (${outcome})`, details);
  } catch (e) {
    return failed(makeError('InternalError', 'PATTERNS_PHASE_FAIL',
      e instanceof Error ? (e.message || 'patterns phase threw') : String(e)));
  } finally {
    void start;
  }
}

// ── Config ────────────────────────────────────────────────────────────

interface PatternsConfig {
  enabled: boolean;
  lookbackDays: number;
  minEvidence: number;
  model: string;
  /** #2415: shared output namespace (dream.synthesize.output_root, default 'wiki'). */
  outputRoot: string;
  /** #1594-family: subagent job timeout, config `dream.patterns.subagent_timeout_ms`. */
  subagentTimeoutMs: number;
  /** #1594-family: waitForCompletion timeout, config `dream.patterns.subagent_wait_timeout_ms`. */
  subagentWaitTimeoutMs: number;
  useSubscriptionBilling: boolean;
}

const DEFAULT_PATTERNS_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PATTERNS_SUBAGENT_WAIT_TIMEOUT_MS = 35 * 60 * 1000;

async function getNumberConfig(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

async function loadPatternsConfig(engine: BrainEngine): Promise<PatternsConfig> {
  const enabledStr = await engine.getConfig('dream.patterns.enabled');
  const enabled = enabledStr === null ? true : enabledStr === 'true';
  const lookbackStr = await engine.getConfig('dream.patterns.lookback_days');
  const minEvidenceStr = await engine.getConfig('dream.patterns.min_evidence');
  const useSubscriptionBillingRaw = await engine.getConfig('dream.synthesize.use_subscription_billing');
  // v0.28: unified model resolution
  const { resolveModel } = await import('../model-config.ts');
  const model = await resolveModel(engine, {
    configKey: 'models.dream.patterns',
    deprecatedConfigKey: 'dream.patterns.model',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  return {
    enabled,
    lookbackDays: lookbackStr ? Math.max(1, parseInt(lookbackStr, 10) || 30) : 30,
    minEvidence: minEvidenceStr ? Math.max(1, parseInt(minEvidenceStr, 10) || 3) : 3,
    model,
    outputRoot: await loadOutputRoot(engine),
    subagentTimeoutMs: await getNumberConfig(
      engine, 'dream.patterns.subagent_timeout_ms', DEFAULT_PATTERNS_SUBAGENT_TIMEOUT_MS,
    ),
    subagentWaitTimeoutMs: await getNumberConfig(
      engine, 'dream.patterns.subagent_wait_timeout_ms', DEFAULT_PATTERNS_SUBAGENT_WAIT_TIMEOUT_MS,
    ),
    useSubscriptionBilling: useSubscriptionBillingRaw === 'true' || useSubscriptionBillingRaw === '1',
  };
}

// ── Reflection gathering ─────────────────────────────────────────────

interface ReflectionRef {
  slug: string;
  title: string;
  excerpt: string;
}

async function gatherReflections(
  engine: BrainEngine,
  lookbackDays: number,
  reflectionLikePrefix: string,
): Promise<ReflectionRef[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  // #2415: reflections live under the configured output root (bound as a
  // parameter; outputRoot is slug-grammar-validated by loadOutputRoot).
  const rows = await engine.executeRaw<{ slug: string; title: string | null; compiled_truth: string | null }>(
    `SELECT slug, title, compiled_truth
       FROM pages
      WHERE slug LIKE $2
        AND updated_at >= $1::timestamptz
      ORDER BY updated_at DESC
      LIMIT 100`,
    [since, reflectionLikePrefix],
  );
  return rows.map(r => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    excerpt: (r.compiled_truth ?? '').slice(0, 600),
  }));
}

// ── Prompt ────────────────────────────────────────────────────────────

function buildPatternsPrompt(
  reflections: ReflectionRef[],
  minEvidence: number,
  routes: DreamSynthesizeRoutes = DEFAULT_DREAM_SYNTHESIZE_ROUTES,
  reflectionLikePrefix = 'wiki/personal/reflections/%',
): string {
  const today = new Date().toISOString().slice(0, 10);
  const patternSlugTemplate = renderDreamSlugRoute(routes.pattern, today, '');
  const reflectionEvidencePath = displayPathFromLikePrefix(reflectionLikePrefix);
  const patternWritePrefix = displayPathFromLikePrefix(
    deriveDreamRouteLikePrefix(routes.pattern, 'wiki/personal/patterns/%'),
  );
  const corpus = reflections
    .map((r, i) => `### ${i + 1}. [[${r.slug}]] — ${r.title}\n${r.excerpt}`)
    .join('\n\n---\n\n');

  return `You are surfacing recurring themes across the user's recent reflections.

OUTPUT POLICY
- Only name a pattern if it appears in at least ${minEvidence} DISTINCT reflections.
- Each pattern page MUST cite the reflections that constitute its evidence (use [[${reflectionEvidencePath}]] wikilinks).
- Use \`search\` to check whether a similar pattern page already exists; if yes, update it (use the same slug). If no, create a new one.
- Pattern slug format: \`${patternSlugTemplate}\` (lowercase alphanumeric + hyphens; no underscores, no extension, no date).
- A "pattern" is a recurring theme, anxiety, decision pattern, relationship dynamic, or self-knowledge motif. NOT a single insight. NOT a list of unrelated topics.

DO NOT WRITE
- A "patterns from today" digest (that's the dream-cycle-summaries page; not your job).
- Patterns with <${minEvidence} reflections cited.
- Anything outside ${patternWritePrefix}.

CONTEXT
- Today: ${today}
- Reflections in scope: ${reflections.length}

REFLECTIONS
${corpus}

When done, briefly list the pattern slugs you wrote/updated in your final message.`;
}

function deriveDreamRouteLikePrefix(template: string, fallback: string): string {
  const route = template.trim();
  if (!route) return fallback;
  const firstPlaceholder = route.search(/[<{]/);
  const staticPrefix = firstPlaceholder >= 0 ? route.slice(0, firstPlaceholder) : route;
  const slash = staticPrefix.lastIndexOf('/');
  if (slash < 0) return fallback;
  const dirPrefix = staticPrefix.slice(0, slash + 1);
  return dirPrefix ? `${dirPrefix}%` : fallback;
}

function displayPathFromLikePrefix(likePrefix: string): string {
  return likePrefix.endsWith('%')
    ? `${likePrefix.slice(0, -1)}...`
    : likePrefix;
}

// ── Provenance via put_page tool execution rows ─────────────────────

async function collectChildPutPageSlugs(
  engine: BrainEngine,
  childIds: number[],
  sourceId = 'default',
): Promise<Array<{ slug: string; source_id: string }>> {
  if (childIds.length === 0) return [];
  // v0.32.8: refs carry source_id so reverseWriteRefs can pass it through
  // getPage and pick the correct (source_id, slug) row. The child job's
  // OperationContext is scoped to the same single source.
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT
            COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'
      ORDER BY 1`,
    [childIds],
  );
  const slugs = new Set<string>();
  for (const r of rows) {
    if (typeof r.slug === 'string' && r.slug.length > 0) slugs.add(r.slug);
  }

  const resultRows = await engine.executeRaw<{ result: unknown }>(
    `SELECT result
       FROM minion_jobs
      WHERE id = ANY($1::int[])
        AND name = 'shell-subagent'
        AND status = 'completed'
        AND result IS NOT NULL`,
    [childIds],
  );
  for (const r of resultRows) {
    let result: Record<string, unknown> | null = null;
    try {
      result = typeof r.result === 'string'
        ? JSON.parse(r.result) as Record<string, unknown>
        : (r.result && typeof r.result === 'object' ? r.result as Record<string, unknown> : null);
    } catch {
      result = null;
    }
    const written = result?.written_slugs;
    if (!Array.isArray(written)) continue;
    for (const slug of written) {
      if (typeof slug === 'string' && slug.length > 0) slugs.add(slug);
    }
  }

  return Array.from(slugs).sort()
    .map(slug => ({ slug, source_id: sourceId }));
}

// ── Reverse-write ────────────────────────────────────────────────────

import { validateSourceId } from '../utils.ts';

async function reverseWriteRefs(
  engine: BrainEngine,
  brainDir: string,
  refs: Array<{ slug: string; source_id: string }>,
): Promise<number> {
  let count = 0;
  for (const { slug, source_id } of refs) {
    // v0.32.8 F6: guard against malformed source_id (would let join() break
    // out of brainDir). validateSourceId throws on `..`, `/`, etc.
    validateSourceId(source_id);
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    const tags = await engine.getTags(slug, { sourceId: source_id });
    try {
      const md = renderPageToMarkdown(page, tags);
      // v0.32.8 F6: non-default sources land under brainDir/.sources/<id>/<slug>.md
      // so same-slug-different-source pages don't collide on disk. Default-source
      // pages stay at brainDir/<slug>.md so single-source brains see no change.
      // `.sources/` is a reserved prefix; walkBrainRepo skips dot-dirs.
      const filePath = source_id === 'default'
        ? join(brainDir, `${slug}.md`)
        : join(brainDir, '.sources', source_id, `${slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, md, 'utf8');
      count++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
  return count;
}

function renderPageToMarkdown(page: Page, tags: string[]): string {
  const frontmatter = (page.frontmatter ?? {}) as Record<string, unknown>;
  return serializeMarkdown(
    frontmatter,
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as string) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
}

// ── Status helpers ───────────────────────────────────────────────────

function ok(summary: string, details: Record<string, unknown> = {}): PhaseResult {
  return { phase: 'patterns', status: 'ok', duration_ms: 0, summary, details };
}

function skipped(reason: string, summary: string): PhaseResult {
  return {
    phase: 'patterns',
    status: 'skipped',
    duration_ms: 0,
    summary,
    details: { reason },
  };
}

function failed(error: PhaseError): PhaseResult {
  return {
    phase: 'patterns',
    status: 'fail',
    duration_ms: 0,
    summary: 'patterns phase failed',
    details: {},
    error,
  };
}

function makeError(cls: string, code: string, message: string, hint?: string): PhaseError {
  return hint ? { class: cls, code, message, hint } : { class: cls, code, message };
}

export const __testing = {
  buildPatternsPrompt,
  collectChildPutPageSlugs,
  deriveDreamRouteLikePrefix,
  displayPathFromLikePrefix,
  gatherReflections,
  reverseWriteRefs,
};
