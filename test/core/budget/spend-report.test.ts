import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { buildSpendReport } from '../../../src/core/budget/spend-report.ts';
import {
  ALEX_DM_FALLBACK_DESTINATION,
  ALEX_NOTIFICATIONS_TOPIC_DESTINATION,
  buildSpendAlert,
} from '../../../src/core/budget/spend-alert.ts';
import { resetPgliteState } from '../../helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let auditDir: string;
const NOW = new Date('2026-06-20T12:00:00.000Z');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '106');
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-spend-report-'));
});

afterEach(() => {
  rmSync(auditDir, { recursive: true, force: true });
});

describe('buildSpendReport', () => {
  test('sums mcp_spend_log by UTC day and month, with pending reservations in cap status', async () => {
    await seedMcpSpend('2026-06-20T01:00:00Z', 125, {
      client_id: 'agent-a',
      operation: 'subagent_loop',
      provider: 'anthropic',
      model: 'anthropic:claude-haiku-4-5-20251001',
    });
    await seedMcpSpend('2026-06-19T23:00:00Z', 50, {
      client_id: 'agent-a',
      operation: 'search_by_image',
      provider: 'voyage',
      model: 'voyage:multimodal-3',
    });
    await seedMcpSpend('2026-05-30T23:00:00Z', 999, {
      client_id: 'old',
      operation: 'old_month',
    });
    await engine.executeRaw(
      `INSERT INTO mcp_spend_reservations
         (reservation_id, client_id, estimated_cents, model, provider, status, created_at, expires_at)
       VALUES ('10000000-0000-0000-0000-000000000001', 'agent-a', 75,
               'anthropic:claude-haiku-4-5-20251001', 'anthropic', 'pending',
               '2026-06-18T00:00:00Z', '2026-06-20T13:00:00Z')`,
    );

    const report = await buildSpendReport(engine, {
      now: NOW,
      auditDir,
      dailyCapUsd: 1.5,
      monthlyBudgetUsd: 100,
    });

    expect(report.totals.today_actual_usd).toBe(1.25);
    expect(report.totals.today_pending_usd).toBe(0.75);
    expect(report.totals.today_actual_plus_pending_usd).toBe(2);
    expect(report.totals.daily_cap_status).toBe('over_cap');
    expect(report.totals.month_to_date_actual_usd).toBe(1.75);
    expect(report.groups.find((g) => g.client_id === 'agent-a' && g.label === 'subagent_loop')?.actual_usd).toBe(1.25);
    expect(report.ledger_totals.find((l) => l.ledger === 'mcp_spend_reservations')?.pending_usd).toBe(0.75);
  });

  test('includes BudgetTracker actual JSONL and keeps quality/dream rows as estimates', async () => {
    writeAudit('budget-2026-W25.jsonl', [
      {
        schema_version: 1,
        ts: '2026-06-20T04:00:00.000Z',
        event: 'record',
        label: 'enrich.thin',
        kind: 'chat',
        model: 'anthropic:claude-haiku-4-5-20251001',
        actual_cost_usd: 0.33,
      },
    ]);
    writeAudit('quality-probe-2026-W25.jsonl', [
      {
        ts: '2026-06-20T05:00:00.000Z',
        outcome: 'pass',
        est_cost_usd: 0.22,
      },
    ]);
    writeAudit('dream-budget-2026-W25.jsonl', [
      {
        schema_version: 1,
        ts: '2026-06-20T06:00:00.000Z',
        event: 'submit',
        phase: 'auto_think',
        label: 'synthesize',
        model: 'claude-haiku-4-5-20251001',
        estimated_cost_usd: 0.11,
      },
    ]);

    const report = await buildSpendReport(engine, { now: NOW, auditDir });

    expect(report.totals.today_actual_usd).toBe(0.33);
    expect(report.totals.today_estimated_usd).toBe(0.33);
    expect(report.ledger_totals.find((l) => l.ledger === 'budget_jsonl')?.actual_usd).toBe(0.33);
    expect(report.ledger_totals.find((l) => l.ledger === 'quality_probe_jsonl')?.estimated_usd).toBe(0.22);
    expect(report.ledger_totals.find((l) => l.ledger === 'dream_budget_jsonl')?.estimated_usd).toBe(0.11);
  });

  test('deduplicates exact provider calls present in mcp_spend_log and BudgetTracker JSONL', async () => {
    const ts = '2026-06-20T07:00:01.000Z';
    await seedMcpSpend(ts, 33, {
      operation: 'subagent_loop',
      provider: 'anthropic',
      model: 'anthropic:claude-haiku-4-5-20251001',
      client_id: 'agent-a',
    });
    writeAudit('budget-2026-W25.jsonl', [
      {
        schema_version: 1,
        ts,
        event: 'record',
        label: 'subagent_loop',
        kind: 'chat',
        model: 'anthropic:claude-haiku-4-5-20251001',
        actual_cost_usd: 0.33,
      },
    ]);

    const report = await buildSpendReport(engine, { now: NOW, auditDir });

    expect(report.totals.today_actual_usd).toBe(0.33);
    expect(report.duplicate_actual_count_excluded).toBe(1);
    expect(report.duplicate_actual_usd_excluded).toBe(0.33);
  });

  test('adds DB receipt tables to month-to-date actual spend', async () => {
    await engine.executeRaw(
      `INSERT INTO eval_takes_quality_runs
         (receipt_sha8_corpus, receipt_sha8_prompt, receipt_sha8_models, receipt_sha8_rubric,
          rubric_version, verdict, overall_score, dim_scores, cost_usd, receipt_json, created_at)
       VALUES ('a','b','c','d','v1','pass',1,'{}'::jsonb,0.40,'{}'::jsonb,'2026-06-20T02:00:00Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO eval_contradictions_runs
         (run_id, ran_at, schema_version, judge_model, prompt_version, queries_evaluated,
          queries_with_contradiction, total_contradictions_flagged, wilson_ci_lower,
          wilson_ci_upper, judge_errors_total, cost_usd_total, duration_ms,
          source_tier_breakdown, report_json)
       VALUES ('run-1','2026-06-20T03:00:00Z',1,'anthropic:judge','p',1,0,0,0,0,0,0.60,10,'{}'::jsonb,'{}'::jsonb)`,
    );
    await engine.executeRaw(
      `INSERT INTO take_grade_cache
         (take_id, prompt_version, judge_model_id, evidence_signature, verdict, confidence, cost_usd, graded_at)
       VALUES (1,'p','anthropic:judge','sig','correct',0.9,0.20,'2026-06-20T04:00:00Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO calibration_profiles
         (source_id, holder, wave_version, generated_at, total_resolved, grade_completion,
          domain_scorecards, pattern_statements, voice_gate_passed, voice_gate_attempts,
          active_bias_tags, model_id, cost_usd)
       VALUES ('default','world','v1','2026-06-20T05:00:00Z',1,1,'{}'::jsonb,ARRAY[]::text[],true,1,ARRAY[]::text[],'anthropic:judge',0.10)`,
    );
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d
         (kind, source_id, day, cost_usd)
       VALUES ('facts','default','2026-06-20',0.30)`,
    );

    const report = await buildSpendReport(engine, { now: NOW, auditDir });

    expect(report.totals.month_to_date_actual_usd).toBe(1.6);
    expect(report.groups.find((g) => g.label === 'takes_quality')?.actual_usd).toBe(0.4);
    expect(report.groups.find((g) => g.label === 'suspected_contradictions')?.actual_usd).toBe(0.6);
    expect(report.groups.find((g) => g.label === 'grade_cache')?.actual_usd).toBe(0.2);
    expect(report.groups.find((g) => g.subsystem === 'calibration')?.actual_usd).toBe(0.1);
    expect(report.groups.find((g) => g.subsystem === 'extract')?.actual_usd).toBe(0.3);
  });

  test('flags unpriced audit events as untracked instead of reporting zero spend', async () => {
    writeAudit('budget-2026-W25.jsonl', [
      {
        schema_version: 1,
        ts: '2026-06-20T08:00:00.000Z',
        event: 'record_unpriced',
        label: 'mystery.phase',
        model: 'provider:unknown-model',
      },
      {
        schema_version: 1,
        ts: '2026-06-20T08:00:01.000Z',
        event: 'record_unpriced',
        label: 'mystery.phase',
        model: 'provider:unknown-model',
      },
    ]);
    writeAudit('dream-budget-2026-W25.jsonl', [
      {
        schema_version: 1,
        ts: '2026-06-20T09:00:00.000Z',
        event: 'submit_unpriced',
        phase: 'auto_think',
        model: 'provider:unknown-model',
      },
    ]);

    const report = await buildSpendReport(engine, { now: NOW, auditDir });

    expect(report.totals.today_actual_usd).toBe(0);
    expect(report.warnings.map((w) => w.code)).toContain('unpriced_budget_record');
    expect(report.warnings.map((w) => w.code)).toContain('unpriced_dream_submit');
    expect(report.warnings.find((w) => w.code === 'unpriced_budget_record')?.count).toBe(2);
  });

  test('uses the last seven days for month-end projection', async () => {
    await seedMcpSpend('2026-06-19T00:00:00Z', 100, { operation: 'one' });
    await seedMcpSpend('2026-06-16T00:00:00Z', 200, { operation: 'two' });
    await seedMcpSpend('2026-06-01T00:00:00Z', 900, { operation: 'outside_projection' });

    const report = await buildSpendReport(engine, {
      now: NOW,
      auditDir,
      monthlyBudgetUsd: 10,
    });

    expect(report.totals.last_7d_actual_usd).toBe(3);
    expect(report.totals.projected_month_end_usd).toBe(12.857143);
    expect(report.totals.monthly_projection_status).toBe('over_budget');
  });

  test('renders Alex Notifications Topic 1 alert when spend is over cap', async () => {
    await seedMcpSpend('2026-06-20T01:00:00Z', 250, {
      client_id: 'agent-a',
      operation: 'subagent_loop',
      provider: 'anthropic',
      model: 'anthropic:claude-haiku-4-5-20251001',
    });

    const report = await buildSpendReport(engine, {
      now: NOW,
      auditDir,
      dailyCapUsd: 2,
      monthlyBudgetUsd: 5,
    });
    const alert = buildSpendAlert(report);

    expect(alert.should_alert).toBe(true);
    expect(alert.severity).toBe('critical');
    expect(alert.destination).toBe(ALEX_NOTIFICATIONS_TOPIC_DESTINATION);
    expect(alert.fallback_destination).toBe(ALEX_DM_FALLBACK_DESTINATION);
    expect(alert.dry_run_only).toBe(true);
    expect(alert.reasons.some((r) => r.includes('daily cap exceeded'))).toBe(true);
    expect(alert.text).toContain('**GBrain Spend Monitor**');
    expect(alert.text).toContain('Alex -> telegram:-1003757407550:1 (Notifications topic)');
    expect(alert.text).toContain('fallback telegram:447751292 only if topic delivery fails');
  });

  test('keeps Alex alert quiet when spend and projection are healthy', async () => {
    await seedMcpSpend('2026-06-20T01:00:00Z', 50, {
      operation: 'small_manual_run',
    });

    const report = await buildSpendReport(engine, {
      now: NOW,
      auditDir,
      dailyCapUsd: 2,
      monthlyBudgetUsd: 100,
    });
    const alert = buildSpendAlert(report);

    expect(alert.should_alert).toBe(false);
    expect(alert.severity).toBe('none');
    expect(alert.destination).toBe(ALEX_NOTIFICATIONS_TOPIC_DESTINATION);
    expect(alert.text).toContain('Status: OK - no spend warning.');
    expect(alert.text).toContain('Route: no Telegram send needed.');
  });

  test('alerts on unpriced ledger warnings even without reported spend', async () => {
    writeAudit('budget-2026-W25.jsonl', [
      { ts: '2026-06-20T08:00:00.000Z', event: 'record_unpriced', label: 'cycle.x', model: 'provider:unknown' },
    ]);

    const report = await buildSpendReport(engine, { now: NOW, auditDir });
    const alert = buildSpendAlert(report);

    expect(alert.should_alert).toBe(true);
    expect(alert.severity).toBe('warning');
    expect(alert.reasons.join('\n')).toContain('unpriced_budget_record');
  });
});

async function seedMcpSpend(
  ts: string,
  cents: number,
  opts: {
    operation?: string;
    provider?: string;
    model?: string;
    client_id?: string;
    token_name?: string;
  } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO mcp_spend_log
       (client_id, token_name, operation, spend_cents, provider, model, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      opts.client_id ?? null,
      opts.token_name ?? null,
      opts.operation ?? 'test_op',
      cents,
      opts.provider ?? null,
      opts.model ?? null,
      ts,
    ],
  );
}

function writeAudit(name: string, rows: unknown[]): void {
  writeFileSync(join(auditDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
