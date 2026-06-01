import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let cycleCalls: Array<Record<string, unknown>> = [];
let cycleReports: any[] = [];

function synthPhase(details: Record<string, unknown>, status: 'ok' | 'fail' | 'skipped' = 'ok') {
  return {
    phase: 'synthesize',
    status,
    duration_ms: 1,
    summary: status === 'ok' ? 'synthesize ok' : 'synthesize failed',
    details,
    ...(status === 'fail' ? { error: { class: 'Test', code: 'FAIL', message: 'synthetic failure' } } : {}),
  };
}

function cycleReport(
  details: Record<string, unknown>,
  status: 'ok' | 'failed' | 'clean' | 'partial' = 'ok',
  phaseStatus: 'ok' | 'fail' | 'skipped' = 'ok',
) {
  return {
    schema_version: '1',
    timestamp: new Date().toISOString(),
    duration_ms: 1,
    status,
    brain_dir: '/tmp/brain',
    phases: [synthPhase(details, phaseStatus)],
    totals: {
      lint_fixes: 0,
      backlinks_added: 0,
      pages_synced: 0,
      pages_extracted: 0,
      pages_embedded: 0,
      orphans_found: 0,
      transcripts_processed: Number(details.transcripts_processed ?? 0),
      synth_pages_written: Number(details.pages_written ?? 0),
      patterns_written: 0,
      pages_emotional_weight_recomputed: 0,
      edges_resolved: 0,
      edges_ambiguous: 0,
      purged_sources_count: 0,
      purged_pages_count: 0,
      facts_consolidated: 0,
      consolidate_takes_written: 0,
      phantom_redirects_written: 0,
    },
  };
}

mock.module('../src/core/cycle.ts', () => ({
  runCycle: async (_engine: unknown, opts: Record<string, unknown>) => {
    cycleCalls.push(opts);
    const next = cycleReports.shift();
    if (!next) throw new Error('unexpected runCycle call');
    return next;
  },
}));

const { runDreamCanary, summarizeDreamCanaryLedger } = await import('../src/core/cycle/dream-canary.ts');
const { PROTECTED_JOB_NAMES } = await import('../src/core/minions/protected-names.ts');

class FakeEngine {
  config = new Map<string, string>();
  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }
  async setConfig(key: string, value: string): Promise<void> {
    this.config.set(key, value);
  }
}

let tmpHome = '';
let previousHome: string | undefined;

beforeEach(() => {
  cycleCalls = [];
  cycleReports = [];
  previousHome = process.env.GBRAIN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-canary-test-'));
  process.env.GBRAIN_HOME = tmpHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('Dream canary control plane', () => {
  test('dry-run proof uses native synthesize cycle with transcript cap and does not count as a run', async () => {
    cycleReports.push(cycleReport({
      transcripts_discovered: 9,
      transcripts_considered: 5,
      transcripts_cap: 5,
      transcripts_processed: 0,
      pages_written: 0,
      dryRun: true,
      verdicts: [],
    }));
    const engine = new FakeEngine();

    const result = await runDreamCanary(engine as any, {
      brainDir: '/tmp/brain',
      sourceId: 'default',
      dryRunOnly: true,
    });

    expect(result.status).toBe('dry_run_ok');
    expect(cycleCalls).toHaveLength(1);
    expect(cycleCalls[0].dryRun).toBe(true);
    expect(cycleCalls[0].phases).toEqual(['synthesize']);
    expect(cycleCalls[0].sourceId).toBe('default');
    expect(cycleCalls[0].synthMaxTranscripts).toBe(5);
    expect(cycleCalls[0].synthAllowedSlugPrefixes).toEqual(['ideas/*', 'reflections/*', 'dream-cycles/*']);
    expect(engine.config.get('dream.canary.run_count')).toBeUndefined();
    const ledger = JSON.parse(engine.config.get('dream.canary.cost_ledger')!);
    expect(ledger.total_receipts).toBe(1);
    expect(ledger.dry_run_ok_runs).toBe(1);
    expect(ledger.successful_actual_runs).toBe(0);
  });

  test('dry-run synthesize skip fails closed instead of approving an unconfigured canary', async () => {
    cycleReports.push(cycleReport({ reason: 'not_configured' }, 'clean', 'skipped'));
    const engine = new FakeEngine();

    const result = await runDreamCanary(engine as any, {
      brainDir: '/tmp/brain',
      sourceId: 'default',
      dryRunOnly: true,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/dry_run_synthesize_skipped/);
    expect(engine.config.get('dream.canary.run_count')).toBeUndefined();
  });

  test('run cap skips closed without calling Dream', async () => {
    const engine = new FakeEngine();
    engine.config.set('dream.canary.run_count', '7');

    const result = await runDreamCanary(engine as any, { brainDir: '/tmp/brain' });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('max_runs_reached');
    expect(cycleCalls).toHaveLength(0);
  });

  test('successful actual run increments count and does not self-reschedule unless explicitly requested', async () => {
    cycleReports.push(
      cycleReport({ transcripts_discovered: 2, transcripts_considered: 2, transcripts_cap: 5, transcripts_processed: 0, pages_written: 0, dryRun: true, verdicts: [] }),
      cycleReport({
        transcripts_discovered: 2,
        transcripts_considered: 2,
        transcripts_cap: 5,
        transcripts_processed: 1,
        pages_written: 2,
        written_slugs: ['ideas/test-abc123', 'reflections/test-def456'],
        child_outcomes: [{ jobId: 11, status: 'completed' }],
        summary_slug: 'dream-cycles/2026-05-31',
        verdicts: [],
      }),
    );
    const engine = new FakeEngine();

    const result = await runDreamCanary(engine as any, { brainDir: '/tmp/brain' });

    expect(result.status).toBe('ok');
    expect(result.run_count_after).toBe(1);
    expect(engine.config.get('dream.canary.run_count')).toBe('1');
    expect(result.next_job_id).toBeUndefined();
    expect(cycleCalls).toHaveLength(2);
    expect(cycleCalls[0].dryRun).toBe(true);
    expect(cycleCalls[1].dryRun).toBe(false);
  });

  test('actual run that processes transcripts but writes no pages fails closed and does not count', async () => {
    cycleReports.push(
      cycleReport({ transcripts_discovered: 1, transcripts_considered: 1, transcripts_cap: 5, transcripts_processed: 0, pages_written: 0, dryRun: true, verdicts: [] }),
      cycleReport({
        transcripts_discovered: 1,
        transcripts_considered: 1,
        transcripts_cap: 5,
        transcripts_processed: 1,
        pages_written: 0,
        written_slugs: [],
        child_outcomes: [{ jobId: 13, status: 'completed' }],
        summary_slug: 'dream-cycles/2026-05-31',
      }),
    );
    const engine = new FakeEngine();

    const result = await runDreamCanary(engine as any, { brainDir: '/tmp/brain' });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('actual_no_pages_written: processed=1');
    expect(engine.config.get('dream.canary.run_count')).toBeUndefined();
  });

  test('actual run that considers transcripts but processes none and writes no pages fails closed and does not count', async () => {
    cycleReports.push(
      cycleReport({ transcripts_discovered: 1, transcripts_considered: 1, transcripts_cap: 5, transcripts_processed: 0, pages_written: 0, dryRun: true, verdicts: [] }),
      cycleReport({
        transcripts_discovered: 1,
        transcripts_considered: 1,
        transcripts_cap: 5,
        transcripts_processed: 0,
        pages_written: 0,
        written_slugs: [],
        child_outcomes: [],
        summary_slug: 'dream-cycles/2026-05-31',
      }),
    );
    const engine = new FakeEngine();

    const result = await runDreamCanary(engine as any, { brainDir: '/tmp/brain' });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('actual_no_transcripts_processed: considered=1');
    expect(engine.config.get('dream.canary.run_count')).toBeUndefined();
  });

  test('route violation fails closed and does not increment run count', async () => {
    cycleReports.push(
      cycleReport({ transcripts_discovered: 1, transcripts_considered: 1, transcripts_cap: 5, transcripts_processed: 0, pages_written: 0, dryRun: true, verdicts: [] }),
      cycleReport({
        transcripts_discovered: 1,
        transcripts_considered: 1,
        transcripts_cap: 5,
        transcripts_processed: 1,
        pages_written: 1,
        written_slugs: ['workout/jiraiya/leak'],
        child_outcomes: [{ jobId: 12, status: 'completed' }],
      }),
    );
    const engine = new FakeEngine();

    const result = await runDreamCanary(engine as any, { brainDir: '/tmp/brain' });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/actual_route_violation/);
    expect(engine.config.get('dream.canary.run_count')).toBeUndefined();
    expect(engine.config.get('dream.canary.paused_reason')).toMatch(/actual_route_violation/);
  });

  test('ledger summary aggregates cost and call counts from JSONL receipts', () => {
    const ledgerPath = join(tmpHome, 'ledger.jsonl');
    writeFileSync(ledgerPath, [
      JSON.stringify({ status: 'dry_run_ok', run_id: 'a', run_date: '2026-05-31', budget: { dry_run: { cumulativeCostUsd: 0, callsRecorded: 1 } } }),
      JSON.stringify({ status: 'ok', run_id: 'b', run_date: '2026-06-01', budget: { dry_run: { cumulativeCostUsd: 0.01, callsRecorded: 2 }, actual: { cumulativeCostUsd: 0.02, callsRecorded: 3 } } }),
      JSON.stringify({ status: 'failed', run_id: 'c', run_date: '2026-06-02', budget: { actual: { cumulativeCostUsd: 0.005, callsRecorded: 1 } } }),
      JSON.stringify({ status: 'ok', run_id: 'd', run_date: '2026-06-03', actual_report: { phases: [{ phase: 'synthesize', status: 'ok', details: { transcripts_processed: 1, written_slugs: [] } }] }, budget: { actual: { cumulativeCostUsd: 0, callsRecorded: 0 } } }),
    ].join('\n') + '\n');

    const summary = summarizeDreamCanaryLedger(ledgerPath);
    expect(summary.total_receipts).toBe(4);
    expect(summary.successful_actual_runs).toBe(1);
    expect(summary.dry_run_ok_runs).toBe(1);
    expect(summary.failed_runs).toBe(2);
    expect(summary.total_api_cost_usd).toBe(0.035);
    expect(summary.total_model_calls).toBe(7);
    expect(summary.last_run_id).toBe('d');
    expect(summary.last_status).toBe('failed');
  });

  test('dream-canary is a protected Minion job name', () => {
    expect(PROTECTED_JOB_NAMES.has('dream-canary')).toBe(true);
  });
});
