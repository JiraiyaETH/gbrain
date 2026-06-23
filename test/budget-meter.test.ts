import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetMeter, _resetBudgetMeterWarningsForTest, ANTHROPIC_PRICING } from '../src/core/cycle/budget-meter.ts';

let tmpDir: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'budget-meter-'));
  auditPath = join(tmpDir, 'budget.jsonl');
  _resetBudgetMeterWarningsForTest();
});

function readLedger(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('BudgetMeter', () => {
  test('Anthropic pricing map covers the alias resolution targets', () => {
    expect(ANTHROPIC_PRICING['claude-opus-4-7']).toBeDefined();
    expect(ANTHROPIC_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(ANTHROPIC_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
  });

  test('first submit is allowed when within budget', () => {
    const meter = new BudgetMeter({ budgetUsd: 1.0, phase: 'auto_think', auditPath });
    const r = meter.check({ modelId: 'claude-haiku-4-5-20251001', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'test' });
    expect(r.allowed).toBe(true);
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
    expect(r.cumulativeCostUsd).toBe(r.estimatedCostUsd);
  });

  test('cumulative cost denies the second submit when budget exhausted', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.50, phase: 'auto_think', auditPath });
    // Opus 4.7: $5 in / $25 out per 1M. Per call: 5000×5/1M + 10000×25/1M = $0.025 + $0.25 = $0.275
    const big = { modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 10000, label: 'big' };
    const r1 = meter.check(big); // $0.275 cumulative — allowed
    const r2 = meter.check(big); // $0.55 cumulative — exceeds $0.50 → DENY
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toContain('BUDGET_EXHAUSTED');
  });

  test('budget=0 hard-skips the submit', () => {
    const meter = new BudgetMeter({ budgetUsd: 0, phase: 'drift', auditPath });
    const r = meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 100_000, maxOutputTokens: 100_000, label: 'huge' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('$0.00');
    expect(meter.totalSpent).toBe(0);
  });

  test('negative budget is the explicit unlimited sentinel', () => {
    const meter = new BudgetMeter({ budgetUsd: -1, phase: 'drift', auditPath });
    const r = meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 100_000, maxOutputTokens: 100_000, label: 'huge' });
    expect(r.allowed).toBe(true);
    expect(meter.totalSpent).toBeGreaterThan(0);
  });

  test('non-Anthropic model bypasses gate with warn-once + ledger entry', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    const r1 = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'gem1' });
    const r2 = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'gem2' });
    expect(r1.allowed).toBe(true);
    expect(r1.unpriced).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(meter.unpricedSubmits).toBe(2);
  });

  test('autonomous daily cap denies a submit before increasing cycle spend', () => {
    writeFileSync(
      auditPath,
      JSON.stringify({
        schema_version: 1,
        phase: 'auto_think',
        ts: '2026-06-20T02:00:00.000Z',
        event: 'submit',
        model: 'claude-opus-4-7',
        label: 'already-spent',
        estimated_cost_usd: 3.2,
      }) + '\n',
    );
    const meter = new BudgetMeter({
      budgetUsd: 10,
      phase: 'auto_think',
      auditPath,
      dailyCapUsd: 3.33,
      now: new Date('2026-06-20T12:00:00.000Z'),
    });
    const r = meter.check({
      modelId: 'claude-opus-4-7',
      estimatedInputTokens: 5000,
      maxOutputTokens: 10000,
      label: 'would-cross-day-cap',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('AUTONOMOUS_DAILY_BUDGET_EXHAUSTED');
    expect(meter.totalSpent).toBe(0);
    const lines = readLedger();
    expect(lines[1].event).toBe('submit_denied');
    expect(lines[1].daily_cap_usd).toBe(3.33);
  });

  test('autonomous daily cap resets on the UTC day boundary', () => {
    writeFileSync(
      auditPath,
      JSON.stringify({
        schema_version: 1,
        phase: 'auto_think',
        ts: '2026-06-19T23:59:59.000Z',
        event: 'submit',
        model: 'claude-opus-4-7',
        label: 'yesterday',
        estimated_cost_usd: 99,
      }) + '\n',
    );
    const meter = new BudgetMeter({
      budgetUsd: 10,
      phase: 'auto_think',
      auditPath,
      dailyCapUsd: 3.33,
      now: new Date('2026-06-20T00:00:01.000Z'),
    });
    const r = meter.check({
      modelId: 'claude-haiku-4-5-20251001',
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      label: 'fresh-day',
    });
    expect(r.allowed).toBe(true);
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
  });

  test('autonomous daily cap refuses unpriced models because spend cannot be capped', () => {
    const meter = new BudgetMeter({
      budgetUsd: 10,
      phase: 'auto_think',
      auditPath,
      dailyCapUsd: 3.33,
      now: new Date('2026-06-20T12:00:00.000Z'),
    });
    const r = meter.check({
      modelId: 'mystery:model',
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      label: 'unpriced',
    });
    expect(r.allowed).toBe(false);
    expect(r.unpriced).toBe(true);
    expect(r.reason).toContain('AUTONOMOUS_DAILY_BUDGET_UNPRICED');
    expect(meter.totalSpent).toBe(0);
  });

  test('ledger captures every submit (allowed + denied + unpriced)', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 4000, label: 'a' });
    meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 4000, label: 'b-denied' });
    meter.check({ modelId: 'gpt-5', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'c-unpriced' });
    const lines = readLedger();
    expect(lines).toHaveLength(3);
    expect(lines[0].event).toBe('submit_denied'); // first opus call exceeds the $0.001 cap
    expect(lines[1].event).toBe('submit_denied');
    expect(lines[2].event).toBe('submit_unpriced');
  });

  test('ledger uses ISO-week filename when auditPath not overridden', () => {
    // Implicit path branch — just verify it doesn't throw and writes somewhere reasonable.
    const meter = new BudgetMeter({ budgetUsd: 1.0, phase: 'drift' });
    const r = meter.check({ modelId: 'claude-haiku-4-5-20251001', estimatedInputTokens: 100, maxOutputTokens: 100, label: 'wk' });
    expect(r.allowed).toBe(true);
  });

  test('A2 amended: every ledger line carries schema_version=1 and the documented field set', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.01, phase: 'auto_think', auditPath });
    meter.check({ modelId: 'claude-haiku-4-5-20251001', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'verdict' }); // submit
    meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 10000, label: 'big-call' });          // submit_denied
    meter.check({ modelId: 'gpt-5', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'unpriced' });                     // submit_unpriced
    const lines = readLedger();
    expect(lines).toHaveLength(3);

    // schema_version must be on every line (renames here are breaking).
    for (const line of lines) {
      expect(line.schema_version).toBe(1);
      expect(typeof line.ts).toBe('string');
      expect(line.phase).toBe('auto_think');
      expect(['submit', 'submit_denied', 'submit_unpriced']).toContain(line.event as string);
      expect(typeof line.model).toBe('string');
      expect(typeof line.label).toBe('string');
    }

    // submit / submit_denied carry the cost fields.
    const denied = lines[0]; // first opus call exceeds the cap → denied
    expect(typeof denied.estimated_cost_usd).toBe('number');
    expect(typeof denied.cumulative_cost_usd).toBe('number');
    expect(denied.budget_usd).toBe(0.01);

    // submit_unpriced carries the token-shape fields instead.
    const unpriced = lines[2];
    expect(typeof unpriced.estimated_input_tokens).toBe('number');
    expect(typeof unpriced.max_output_tokens).toBe('number');
  });
});
