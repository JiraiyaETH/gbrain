/**
 * Native Dream canary control plane.
 *
 * Runs the existing synthesize phase with hard canary caps. This is not a
 * Dream wrapper: dry-run + actual both call runCycle({ phases:['synthesize'] })
 * so trigger/write semantics, Minion subagent payloads, slug allow-lists,
 * no-clobber gates, reverse-write receipts, and child-job persistence stay in
 * the native path.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { gbrainPath } from '../config.ts';
import { BudgetTracker } from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import { MinionQueue } from '../minions/queue.ts';
import { runCycle, type CycleReport, type PhaseResult } from '../cycle.ts';
import { loadAllowedSlugPrefixes } from './dream-topology.ts';

export interface DreamCanaryOpts {
  brainDir: string;
  sourceId?: string;
  signal?: AbortSignal;
  /** Run only the dry-run/significance gate; do not synthesize or count a run. */
  dryRunOnly?: boolean;
  /** Self-reschedule the next delayed canary when the actual run succeeds. */
  reschedule?: boolean;
  maxRuns?: number;
  maxTranscripts?: number;
  maxCostUsd?: number;
  delayMs?: number;
}

export interface DreamCanaryLedgerSummary {
  schema_version: 1;
  ledger_path: string;
  total_receipts: number;
  successful_actual_runs: number;
  dry_run_ok_runs: number;
  failed_runs: number;
  skipped_runs: number;
  total_api_cost_usd: number;
  total_model_calls: number;
  last_status?: DreamCanaryResult['status'];
  last_run_id?: string;
  last_run_date?: string;
}

export interface DreamCanaryResult {
  schema_version: 1;
  status: 'skipped' | 'dry_run_ok' | 'ok' | 'failed';
  reason?: string;
  run_id: string;
  run_date: string;
  run_count_before: number;
  run_count_after: number;
  max_runs: number;
  max_transcripts: number;
  max_cost_usd: number;
  dry_run_report?: CycleReport;
  actual_report?: CycleReport;
  next_job_id?: number;
  budget: {
    dry_run?: ReturnType<BudgetTracker['snapshot']>;
    actual?: ReturnType<BudgetTracker['snapshot']>;
  };
  ledger_summary?: DreamCanaryLedgerSummary;
}

const DEFAULT_MAX_RUNS = 7;
const DEFAULT_MAX_TRANSCRIPTS = 5;
const DEFAULT_MAX_COST_USD = 0;
const DEFAULT_DELAY_MS = 24 * 60 * 60 * 1000;
const CANARY_ALLOWED_SLUG_PREFIXES = ['ideas/', 'reflections/', 'dream-cycles/'] as const;
const CANARY_ALLOWED_SLUG_GLOBS = CANARY_ALLOWED_SLUG_PREFIXES.map(prefix => `${prefix}*`);

export async function runDreamCanary(engine: BrainEngine, opts: DreamCanaryOpts): Promise<DreamCanaryResult> {
  const maxRuns = positiveInt(opts.maxRuns, DEFAULT_MAX_RUNS);
  const maxTranscripts = positiveInt(opts.maxTranscripts, DEFAULT_MAX_TRANSCRIPTS);
  const maxCostUsd = nonNegativeNumber(opts.maxCostUsd, DEFAULT_MAX_COST_USD);
  const runDate = todayUtc();
  const runId = `dream-canary:${runDate}:${Date.now()}`;
  const runCountBefore = parseInt((await engine.getConfig('dream.canary.run_count').catch(() => null)) ?? '0', 10) || 0;
  const lastRunDate = await engine.getConfig('dream.canary.last_run_date').catch(() => null);

  const base: DreamCanaryResult = {
    schema_version: 1,
    status: 'failed',
    run_id: runId,
    run_date: runDate,
    run_count_before: runCountBefore,
    run_count_after: runCountBefore,
    max_runs: maxRuns,
    max_transcripts: maxTranscripts,
    max_cost_usd: maxCostUsd,
    budget: {},
  };

  if (runCountBefore >= maxRuns) {
    return writeCanaryReceipt(engine, { ...base, status: 'skipped', reason: 'max_runs_reached' });
  }
  if (!opts.dryRunOnly && lastRunDate === runDate) {
    return writeCanaryReceipt(engine, { ...base, status: 'skipped', reason: 'already_ran_today' });
  }

  const configuredAllowedPrefixes = await loadAllowedSlugPrefixes();
  const missingCanaryPrefixes = CANARY_ALLOWED_SLUG_PREFIXES.filter(
    required => !configuredAllowedPrefixes.some(configured => allowlistCoversPrefix(configured, required)),
  );
  if (missingCanaryPrefixes.length > 0) {
    return writeCanaryReceipt(engine, {
      ...base,
      status: 'failed',
      reason: `allowlist_missing_required_dream_prefixes: ${JSON.stringify(missingCanaryPrefixes)}`,
    });
  }

  const dryBudget = new BudgetTracker({
    label: 'dream.canary.dry-run',
    maxCostUsd,
    auditPath: gbrainPath(`audit/dream-canary-${runDate}-budget.jsonl`),
  });
  let dryRunReport: CycleReport;
  try {
    dryRunReport = await withBudgetTracker(dryBudget, () => runCycle(engine, {
      brainDir: opts.brainDir,
      dryRun: true,
      pull: false,
      phases: ['synthesize'],
      sourceId: opts.sourceId,
      synthMaxTranscripts: maxTranscripts,
      synthAllowedSlugPrefixes: [...CANARY_ALLOWED_SLUG_GLOBS],
      signal: opts.signal,
    }));
  } catch (err) {
    return writeCanaryReceipt(engine, {
      ...base,
      status: 'failed',
      reason: `dry_run_exception: ${err instanceof Error ? err.message : String(err)}`,
      budget: { dry_run: dryBudget.snapshot() },
    });
  }

  const dryFailure = validateDryRun(dryRunReport, maxTranscripts);
  if (dryFailure) {
    return writeCanaryReceipt(engine, {
      ...base,
      status: 'failed',
      reason: dryFailure,
      dry_run_report: dryRunReport,
      budget: { dry_run: dryBudget.snapshot() },
    });
  }

  if (opts.dryRunOnly) {
    return writeCanaryReceipt(engine, {
      ...base,
      status: 'dry_run_ok',
      dry_run_report: dryRunReport,
      budget: { dry_run: dryBudget.snapshot() },
    });
  }

  const actualBudget = new BudgetTracker({
    label: 'dream.canary.actual',
    maxCostUsd,
    auditPath: gbrainPath(`audit/dream-canary-${runDate}-budget.jsonl`),
  });
  let actualReport: CycleReport;
  try {
    actualReport = await withBudgetTracker(actualBudget, () => runCycle(engine, {
      brainDir: opts.brainDir,
      dryRun: false,
      pull: false,
      phases: ['synthesize'],
      sourceId: opts.sourceId,
      synthMaxTranscripts: maxTranscripts,
      synthAllowedSlugPrefixes: [...CANARY_ALLOWED_SLUG_GLOBS],
      signal: opts.signal,
    }));
  } catch (err) {
    return writeCanaryReceipt(engine, {
      ...base,
      status: 'failed',
      reason: `actual_exception: ${err instanceof Error ? err.message : String(err)}`,
      dry_run_report: dryRunReport,
      budget: { dry_run: dryBudget.snapshot(), actual: actualBudget.snapshot() },
    });
  }

  const actualFailure = validateActualRun(actualReport, [...CANARY_ALLOWED_SLUG_PREFIXES], maxTranscripts);
  if (actualFailure) {
    await engine.setConfig('dream.canary.paused_reason', actualFailure).catch(() => {});
    return writeCanaryReceipt(engine, {
      ...base,
      status: 'failed',
      reason: actualFailure,
      dry_run_report: dryRunReport,
      actual_report: actualReport,
      budget: { dry_run: dryBudget.snapshot(), actual: actualBudget.snapshot() },
    });
  }

  const runCountAfter = runCountBefore + 1;
  await engine.setConfig('dream.canary.run_count', String(runCountAfter));
  await engine.setConfig('dream.canary.last_run_date', runDate);
  await engine.setConfig('dream.canary.last_success_ts', new Date().toISOString());

  let nextJobId: number | undefined;
  if (opts.reschedule === true && runCountAfter < maxRuns) {
    const queue = new MinionQueue(engine);
    const next = await queue.add(
      'dream-canary',
      {
        repoPath: opts.brainDir,
        source_id: opts.sourceId,
        max_runs: maxRuns,
        max_transcripts: maxTranscripts,
        max_cost_usd: maxCostUsd,
        reschedule: true,
      },
      {
        delay: nonNegativeNumber(opts.delayMs, DEFAULT_DELAY_MS),
        idempotency_key: `dream-canary:${addDaysUtc(runDate, 1)}`,
        max_attempts: 1,
        timeout_ms: 2 * 60 * 60 * 1000,
        max_stalled: 1,
        stagger_key: 'dream-canary',
      },
      { allowProtectedSubmit: true },
    );
    nextJobId = next.id;
  }

  return writeCanaryReceipt(engine, {
    ...base,
    status: 'ok',
    run_count_after: runCountAfter,
    dry_run_report: dryRunReport,
    actual_report: actualReport,
    next_job_id: nextJobId,
    budget: { dry_run: dryBudget.snapshot(), actual: actualBudget.snapshot() },
  });
}

function validateDryRun(report: CycleReport, maxTranscripts: number): string | null {
  if (report.status === 'failed') return 'dry_run_failed';
  const synth = synthPhase(report);
  if (!synth) return 'dry_run_missing_synthesize_phase';
  if (synth.status === 'fail') return `dry_run_synthesize_failed: ${synth.error?.message ?? synth.summary}`;
  if (synth.status === 'skipped') return `dry_run_synthesize_skipped: ${synth.summary ?? synth.details.reason ?? 'unknown'}`;
  const considered = numeric(synth.details.transcripts_considered ?? synth.details.transcripts_discovered);
  if (considered > maxTranscripts) return `dry_run_transcript_cap_violation: ${considered}/${maxTranscripts}`;
  return null;
}

function validateActualRun(report: CycleReport, allowedPrefixes: string[], maxTranscripts: number): string | null {
  if (report.status === 'failed') return 'actual_run_failed';
  const synth = synthPhase(report);
  if (!synth) return 'actual_missing_synthesize_phase';
  if (synth.status === 'fail') return `actual_synthesize_failed: ${synth.error?.message ?? synth.summary}`;
  if (synth.status === 'skipped') return `actual_synthesize_skipped: ${synth.summary ?? synth.details.reason ?? 'unknown'}`;
  const considered = numeric(synth.details.transcripts_considered ?? synth.details.transcripts_discovered);
  if (considered > maxTranscripts) return `actual_transcript_cap_violation: ${considered}/${maxTranscripts}`;

  const written = Array.isArray(synth.details.written_slugs) ? synth.details.written_slugs : [];
  const processed = numeric(synth.details.transcripts_processed);
  if (considered > 0 && processed === 0 && written.length === 0) {
    return `actual_no_transcripts_processed: considered=${considered}`;
  }
  if (processed > 0 && written.length === 0) {
    return `actual_no_pages_written: processed=${processed}`;
  }
  const summarySlug = typeof synth.details.summary_slug === 'string' ? synth.details.summary_slug : null;
  for (const slug of [...written, ...(summarySlug ? [summarySlug] : [])]) {
    if (typeof slug !== 'string') return 'actual_written_slug_non_string';
    if (!allowedPrefixes.some(prefix => slug.startsWith(prefix))) {
      return `actual_route_violation: ${slug}`;
    }
  }

  const childOutcomes = Array.isArray(synth.details.child_outcomes) ? synth.details.child_outcomes : [];
  for (const outcome of childOutcomes) {
    const status = outcome && typeof outcome === 'object' ? (outcome as Record<string, unknown>).status : undefined;
    if (status !== 'completed') return `actual_child_failure: ${String(status ?? 'unknown')}`;
  }
  return null;
}

function synthPhase(report: CycleReport): PhaseResult | undefined {
  return report.phases.find(p => p.phase === 'synthesize');
}

async function writeCanaryReceipt(engine: BrainEngine, result: DreamCanaryResult): Promise<DreamCanaryResult> {
  const receiptPath = gbrainPath('audit/dream-canary-ledger.jsonl');
  try {
    mkdirSync(dirname(receiptPath), { recursive: true });
    appendFileSync(receiptPath, JSON.stringify({ ...result, ts: new Date().toISOString() }) + '\n');
  } catch {
    // Best-effort ledger; config receipt below is the DB-side fallback.
  }
  const ledgerSummary = summarizeDreamCanaryLedger(receiptPath);
  result.ledger_summary = ledgerSummary;
  await engine.setConfig('dream.canary.last_receipt', JSON.stringify(redactReportForConfig(result))).catch(() => {});
  await engine.setConfig('dream.canary.cost_ledger', JSON.stringify(ledgerSummary)).catch(() => {});
  return result;
}

export function summarizeDreamCanaryLedger(receiptPath = gbrainPath('audit/dream-canary-ledger.jsonl')): DreamCanaryLedgerSummary {
  const summary: DreamCanaryLedgerSummary = {
    schema_version: 1,
    ledger_path: receiptPath,
    total_receipts: 0,
    successful_actual_runs: 0,
    dry_run_ok_runs: 0,
    failed_runs: 0,
    skipped_runs: 0,
    total_api_cost_usd: 0,
    total_model_calls: 0,
  };
  if (!existsSync(receiptPath)) return summary;
  const lines = readFileSync(receiptPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Partial<DreamCanaryResult>;
      if (!row.status) continue;
      const effectiveStatus: DreamCanaryResult['status'] =
        row.status === 'ok' && isInvalidNoWriteActualSuccess(row) ? 'failed' : row.status;
      summary.total_receipts++;
      if (effectiveStatus === 'ok') summary.successful_actual_runs++;
      else if (effectiveStatus === 'dry_run_ok') summary.dry_run_ok_runs++;
      else if (effectiveStatus === 'failed') summary.failed_runs++;
      else if (effectiveStatus === 'skipped') summary.skipped_runs++;
      for (const snapshot of [row.budget?.dry_run, row.budget?.actual]) {
        if (!snapshot) continue;
        summary.total_api_cost_usd += typeof snapshot.cumulativeCostUsd === 'number' ? snapshot.cumulativeCostUsd : 0;
        summary.total_model_calls += typeof snapshot.callsRecorded === 'number' ? snapshot.callsRecorded : 0;
      }
      summary.last_status = effectiveStatus;
      summary.last_run_id = row.run_id;
      summary.last_run_date = row.run_date;
    } catch {
      // Ignore malformed legacy/debug rows; the per-run receipt remains intact.
    }
  }
  summary.total_api_cost_usd = Number(summary.total_api_cost_usd.toFixed(6));
  return summary;
}

function isInvalidNoWriteActualSuccess(row: Partial<DreamCanaryResult>): boolean {
  if (!row.actual_report) return false;
  const synth = synthPhase(row.actual_report);
  if (!synth) return false;
  const considered = numeric(synth.details.transcripts_considered ?? synth.details.transcripts_discovered);
  const processed = numeric(synth.details.transcripts_processed);
  const written = Array.isArray(synth.details.written_slugs) ? synth.details.written_slugs : [];
  return considered > 0 && processed === 0 && written.length === 0 || processed > 0 && written.length === 0;
}

function redactReportForConfig(result: DreamCanaryResult): DreamCanaryResult {
  // Config values should stay compact; keep structural proof without embedding
  // full transcript verdict reason arrays forever in the config table.
  const compact = JSON.parse(JSON.stringify(result)) as DreamCanaryResult;
  for (const report of [compact.dry_run_report, compact.actual_report]) {
    if (!report) continue;
    for (const phase of report.phases) {
      if (phase.details.verdicts) phase.details.verdicts = '[omitted]';
    }
  }
  return compact;
}

function allowlistCoversPrefix(allowlistEntry: string, requiredPrefix: string): boolean {
  const normalized = allowlistEntry.trim().replace(/\*$/, '').replace(/\/+$/, '');
  const required = requiredPrefix.replace(/\/+$/, '');
  return normalized === required || normalized.startsWith(`${required}/`) || required.startsWith(`${normalized}/`);
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysUtc(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
