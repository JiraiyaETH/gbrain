import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { resolveAuditDir } from '../audit-week-file.ts';
import { splitProviderModelId } from '../model-id.ts';

export const DEFAULT_DAILY_CAP_USD = 3.33;
export const DEFAULT_MONTHLY_BUDGET_USD = 100;

export type SpendKind = 'actual' | 'pending' | 'estimated';

export interface SpendEntry {
  ts: string;
  ledger: string;
  kind: SpendKind;
  subsystem: string;
  label: string;
  usd: number;
  provider: string | null;
  model: string | null;
  source_id: string | null;
  client_id: string | null;
  token_name: string | null;
  confidence: 'actual' | 'pending' | 'estimated' | 'rollup';
}

export interface SpendGroup {
  subsystem: string;
  label: string;
  provider: string | null;
  model: string | null;
  source_id: string | null;
  client_id: string | null;
  actual_usd: number;
  pending_usd: number;
  estimated_usd: number;
  calls: number;
}

export interface SpendWarning {
  code: string;
  message: string;
  ledger?: string;
  ts?: string;
  model?: string | null;
  label?: string | null;
  count?: number;
}

export interface SpendReport {
  generated_at: string;
  utc_day: string;
  utc_month: string;
  policy: {
    daily_cap_usd: number;
    monthly_budget_usd: number;
  };
  totals: {
    today_actual_usd: number;
    today_pending_usd: number;
    today_estimated_usd: number;
    today_actual_plus_pending_usd: number;
    month_to_date_actual_usd: number;
    last_7d_actual_usd: number;
    projected_month_end_usd: number;
    daily_cap_status: 'ok' | 'over_cap';
    monthly_projection_status: 'ok' | 'over_budget';
  };
  groups: SpendGroup[];
  ledger_totals: Array<{
    ledger: string;
    actual_usd: number;
    pending_usd: number;
    estimated_usd: number;
  }>;
  duplicate_actual_usd_excluded: number;
  duplicate_actual_count_excluded: number;
  warnings: SpendWarning[];
}

export interface BuildSpendReportOptions {
  now?: Date;
  auditDir?: string;
  dailyCapUsd?: number;
  monthlyBudgetUsd?: number;
  projectionDays?: number;
}

interface RawAuditLine {
  ts?: unknown;
  event?: unknown;
  label?: unknown;
  phase?: unknown;
  kind?: unknown;
  model?: unknown;
  provider?: unknown;
  sub_label?: unknown;
  actual_cost_usd?: unknown;
  estimated_cost_usd?: unknown;
  est_cost_usd?: unknown;
}

interface DedupeResult {
  entries: SpendEntry[];
  duplicateUsd: number;
  duplicateCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildSpendReport(
  engine: BrainEngine,
  opts: BuildSpendReportOptions = {},
): Promise<SpendReport> {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);
  const last7Start = new Date(now.getTime() - ((opts.projectionDays ?? 7) * DAY_MS));
  const lowerBound = last7Start < monthStart ? last7Start : monthStart;
  const warnings: SpendWarning[] = [];

  const dbEntries = await readDbSpendEntries(engine, lowerBound, now, warnings);
  const auditEntries = readAuditSpendEntries(opts.auditDir ?? resolveAuditDir(), lowerBound, now, warnings);
  const deduped = dedupeActualSpend([...dbEntries, ...auditEntries]);
  const entries = deduped.entries;

  const todayActual = sumUsd(entries, 'actual', dayStart, now);
  const todayPending = sumUsd(entries, 'pending', dayStart, now) + sumCurrentPendingUsd(entries, now);
  const todayEstimated = sumUsd(entries, 'estimated', dayStart, now);
  const mtdActual = sumUsd(entries, 'actual', monthStart, now);
  const last7Actual = sumUsd(entries, 'actual', last7Start, now);
  const projectionDays = Math.max(1, opts.projectionDays ?? 7);
  const projectedMonthEnd = (last7Actual / projectionDays) * daysInUtcMonth(now);
  const dailyCap = opts.dailyCapUsd ?? DEFAULT_DAILY_CAP_USD;
  const monthlyBudget = opts.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET_USD;

  return {
    generated_at: generatedAt,
    utc_day: isoDate(dayStart),
    utc_month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    policy: {
      daily_cap_usd: roundUsd(dailyCap),
      monthly_budget_usd: roundUsd(monthlyBudget),
    },
    totals: {
      today_actual_usd: roundUsd(todayActual),
      today_pending_usd: roundUsd(todayPending),
      today_estimated_usd: roundUsd(todayEstimated),
      today_actual_plus_pending_usd: roundUsd(todayActual + todayPending),
      month_to_date_actual_usd: roundUsd(mtdActual),
      last_7d_actual_usd: roundUsd(last7Actual),
      projected_month_end_usd: roundUsd(projectedMonthEnd),
      daily_cap_status: todayActual + todayPending > dailyCap ? 'over_cap' : 'ok',
      monthly_projection_status: projectedMonthEnd > monthlyBudget ? 'over_budget' : 'ok',
    },
    groups: groupEntries(entries, monthStart, now),
    ledger_totals: groupLedgers(entries, monthStart, now),
    duplicate_actual_usd_excluded: roundUsd(deduped.duplicateUsd),
    duplicate_actual_count_excluded: deduped.duplicateCount,
    warnings: aggregateWarnings(warnings),
  };
}

export function formatSpendReport(report: SpendReport): string {
  const lines: string[] = [];
  lines.push(`GBrain spend (${report.utc_day} UTC)`);
  lines.push(`Today actual: ${money(report.totals.today_actual_usd)} / ${money(report.policy.daily_cap_usd)} cap`);
  lines.push(`Today pending: ${money(report.totals.today_pending_usd)}; estimated/unsettled: ${money(report.totals.today_estimated_usd)}`);
  lines.push(`Month-to-date actual: ${money(report.totals.month_to_date_actual_usd)} / ${money(report.policy.monthly_budget_usd)} budget`);
  lines.push(`Projected month-end from last 7d: ${money(report.totals.projected_month_end_usd)} (${report.totals.monthly_projection_status})`);
  if (report.duplicate_actual_count_excluded > 0) {
    lines.push(`Duplicates excluded: ${report.duplicate_actual_count_excluded} rows / ${money(report.duplicate_actual_usd_excluded)}`);
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of report.warnings.slice(0, 8)) {
      const count = w.count && w.count > 1 ? ` (${w.count} events)` : '';
      lines.push(`  - ${w.code}: ${w.message}${count}`);
    }
  }
  if (report.groups.length > 0) {
    lines.push('Top groups this month:');
    for (const g of report.groups.slice(0, 10)) {
      const who = g.client_id ? ` client=${g.client_id}` : '';
      const model = g.model ? ` model=${g.model}` : '';
      lines.push(`  - ${g.subsystem}/${g.label}${who}${model}: actual ${money(g.actual_usd)}, pending ${money(g.pending_usd)}, estimated ${money(g.estimated_usd)}`);
    }
  }
  return lines.join('\n');
}

async function readDbSpendEntries(
  engine: BrainEngine,
  since: Date,
  until: Date,
  warnings: SpendWarning[],
): Promise<SpendEntry[]> {
  const entries: SpendEntry[] = [];
  entries.push(...await readMcpSpendLog(engine, since, until, warnings));
  entries.push(...await readPendingReservations(engine, until, warnings));
  entries.push(...await readEvalReceiptSpend(engine, since, until, warnings));
  entries.push(...await readTakeAndCalibrationSpend(engine, since, until, warnings));
  entries.push(...await readExtractRollupSpend(engine, since, until, warnings));
  return entries;
}

async function readMcpSpendLog(
  engine: BrainEngine,
  since: Date,
  until: Date,
  warnings: SpendWarning[],
): Promise<SpendEntry[]> {
  const rows = await safeQuery<{
    ts: string;
    operation: string | null;
    spend_cents: string | number;
    provider: string | null;
    model: string | null;
    client_id: string | null;
    token_name: string | null;
  }>(engine, `
      SELECT created_at::text AS ts, operation, spend_cents::text AS spend_cents,
             provider, model, client_id, token_name
      FROM mcp_spend_log
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
    `, [since.toISOString(), until.toISOString()], warnings, 'mcp_spend_log');
  return rows.map((r) => {
    const label = r.operation ?? 'unknown';
    return normalizeEntry({
      ts: toIso(r.ts),
      ledger: 'mcp_spend_log',
      kind: 'actual',
      subsystem: subsystemFromLabel(label),
      label,
      usd: centsToUsd(r.spend_cents),
      provider: r.provider,
      model: r.model,
      source_id: null,
      client_id: r.client_id,
      token_name: r.token_name,
      confidence: 'actual',
    });
  });
}

async function readPendingReservations(
  engine: BrainEngine,
  until: Date,
  warnings: SpendWarning[],
): Promise<SpendEntry[]> {
  const rows = await safeQuery<{
    ts: string;
    estimated_cents: string | number;
    provider: string | null;
    model: string | null;
    client_id: string | null;
  }>(engine, `
      SELECT created_at::text AS ts, estimated_cents::text AS estimated_cents,
             provider, model, client_id
      FROM mcp_spend_reservations
      WHERE status = 'pending' AND expires_at > $1::timestamptz
    `, [until.toISOString()], warnings, 'mcp_spend_reservations');
  return rows.map((r) => normalizeEntry({
    ts: toIso(r.ts),
    ledger: 'mcp_spend_reservations',
    kind: 'pending',
    subsystem: 'mcp',
    label: 'pending_reservation',
    usd: centsToUsd(r.estimated_cents),
    provider: r.provider,
    model: r.model,
    source_id: null,
    client_id: r.client_id,
    token_name: null,
    confidence: 'pending',
  }));
}

async function readEvalReceiptSpend(
  engine: BrainEngine,
  since: Date,
  until: Date,
  warnings: SpendWarning[],
): Promise<SpendEntry[]> {
  const entries: SpendEntry[] = [];
  const takes = await safeQuery<{ ts: string; cost_usd: string | number }>(engine, `
      SELECT created_at::text AS ts, cost_usd::text AS cost_usd
      FROM eval_takes_quality_runs
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
    `, [since.toISOString(), until.toISOString()], warnings, 'eval_takes_quality_runs');
  for (const r of takes) entries.push(normalizeEntry({
    ts: toIso(r.ts),
    ledger: 'eval_takes_quality_runs',
    kind: 'actual',
    subsystem: 'eval',
    label: 'takes_quality',
    usd: numberOrZero(r.cost_usd),
    provider: null,
    model: null,
    source_id: null,
    client_id: null,
    token_name: null,
    confidence: 'actual',
  }));

  const contradictions = await safeQuery<{ ts: string; cost_usd: string | number; model: string | null }>(engine, `
      SELECT ran_at::text AS ts, cost_usd_total::text AS cost_usd, judge_model AS model
      FROM eval_contradictions_runs
      WHERE ran_at >= $1::timestamptz AND ran_at < $2::timestamptz
    `, [since.toISOString(), until.toISOString()], warnings, 'eval_contradictions_runs');
  for (const r of contradictions) entries.push(normalizeEntry({
    ts: toIso(r.ts),
    ledger: 'eval_contradictions_runs',
    kind: 'actual',
    subsystem: 'eval',
    label: 'suspected_contradictions',
    usd: numberOrZero(r.cost_usd),
    provider: null,
    model: r.model,
    source_id: null,
    client_id: null,
    token_name: null,
    confidence: 'actual',
  }));
  return entries;
}

async function readTakeAndCalibrationSpend(
  engine: BrainEngine,
  since: Date,
  until: Date,
  warnings: SpendWarning[],
): Promise<SpendEntry[]> {
  const entries: SpendEntry[] = [];
  const grades = await safeQuery<{ ts: string; cost_usd: string | number; model: string | null }>(engine, `
      SELECT graded_at::text AS ts, cost_usd::text AS cost_usd, judge_model_id AS model
      FROM take_grade_cache
      WHERE cost_usd IS NOT NULL
        AND graded_at >= $1::timestamptz AND graded_at < $2::timestamptz
    `, [since.toISOString(), until.toISOString()], warnings, 'take_grade_cache');
  for (const r of grades) entries.push(normalizeEntry({
    ts: toIso(r.ts),
    ledger: 'take_grade_cache',
    kind: 'actual',
    subsystem: 'takes',
    label: 'grade_cache',
    usd: numberOrZero(r.cost_usd),
    provider: null,
    model: r.model,
    source_id: null,
    client_id: null,
    token_name: null,
    confidence: 'actual',
  }));

  const calibration = await safeQuery<{ ts: string; cost_usd: string | number; model: string | null; source_id: string | null }>(engine, `
      SELECT generated_at::text AS ts, cost_usd::text AS cost_usd, model_id AS model, source_id
      FROM calibration_profiles
      WHERE cost_usd IS NOT NULL
        AND generated_at >= $1::timestamptz AND generated_at < $2::timestamptz
    `, [since.toISOString(), until.toISOString()], warnings, 'calibration_profiles');
  for (const r of calibration) entries.push(normalizeEntry({
    ts: toIso(r.ts),
    ledger: 'calibration_profiles',
    kind: 'actual',
    subsystem: 'calibration',
    label: 'profile',
    usd: numberOrZero(r.cost_usd),
    provider: null,
    model: r.model,
    source_id: r.source_id,
    client_id: null,
    token_name: null,
    confidence: 'actual',
  }));
  return entries;
}

async function readExtractRollupSpend(
  engine: BrainEngine,
  since: Date,
  until: Date,
  warnings: SpendWarning[],
): Promise<SpendEntry[]> {
  const rows = await safeQuery<{ ts: string; cost_usd: string | number; kind: string; source_id: string }>(engine, `
      SELECT (day::timestamptz)::text AS ts, cost_usd::text AS cost_usd, kind, source_id
      FROM extract_rollup_7d
      WHERE cost_usd > 0
        AND day >= $1::date AND day <= $2::date
    `, [isoDate(since), isoDate(until)], warnings, 'extract_rollup_7d');
  return rows.map((r) => normalizeEntry({
    ts: toIso(r.ts),
    ledger: 'extract_rollup_7d',
    kind: 'actual',
    subsystem: 'extract',
    label: r.kind,
    usd: numberOrZero(r.cost_usd),
    provider: null,
    model: null,
    source_id: r.source_id,
    client_id: null,
    token_name: null,
    confidence: 'rollup',
  }));
}

async function safeQuery<T>(
  engine: BrainEngine,
  sql: string,
  params: unknown[],
  warnings: SpendWarning[],
  ledger: string,
): Promise<T[]> {
  try {
    return await engine.executeRaw<T>(sql, params);
  } catch (err) {
    warnings.push({
      code: 'ledger_unavailable',
      ledger,
      message: `${ledger} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    });
    return [];
  }
}

function readAuditSpendEntries(
  auditDir: string,
  since: Date,
  until: Date,
  warnings: SpendWarning[],
): SpendEntry[] {
  const entries: SpendEntry[] = [];
  if (!existsSync(auditDir)) return entries;
  let files: string[] = [];
  try {
    files = readdirSync(auditDir).filter((f) =>
      /^(budget|dream-budget|quality-probe)-\d{4}-W\d{2}\.jsonl$/.test(f)
    );
  } catch (err) {
    warnings.push({ code: 'audit_dir_unreadable', message: `${auditDir}: ${err instanceof Error ? err.message : String(err)}` });
    return entries;
  }
  for (const file of files) {
    const ledger = file.startsWith('dream-budget-')
      ? 'dream_budget_jsonl'
      : file.startsWith('quality-probe-')
        ? 'quality_probe_jsonl'
        : 'budget_jsonl';
    const path = join(auditDir, file);
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let row: RawAuditLine;
      try {
        row = JSON.parse(line) as RawAuditLine;
      } catch {
        warnings.push({ code: 'audit_json_parse_failed', ledger, message: `${file}: invalid JSONL row` });
        continue;
      }
      const ts = typeof row.ts === 'string' ? toIso(row.ts) : null;
      if (!ts || !inWindow(new Date(ts), since, until)) continue;
      const event = typeof row.event === 'string' ? row.event : '';
      const label = auditLabel(row);
      const model = typeof row.model === 'string' ? row.model : null;
      const provider = typeof row.provider === 'string' ? row.provider : null;

      if (ledger === 'budget_jsonl' && event === 'record') {
        const usd = numberOrNull(row.actual_cost_usd);
        if (usd !== null) {
          entries.push(normalizeEntry({
            ts,
            ledger,
            kind: 'actual',
            subsystem: subsystemFromLabel(label),
            label,
            usd,
            provider,
            model,
            source_id: null,
            client_id: null,
            token_name: null,
            confidence: 'actual',
          }));
        }
        continue;
      }

      if (ledger === 'budget_jsonl' && (event === 'record_unpriced' || event === 'reserve_unpriced')) {
        warnings.push({
          code: event === 'record_unpriced' ? 'unpriced_budget_record' : 'unpriced_budget_reserve',
          ledger,
          ts,
          model,
          label,
          message: `${label} used unpriced model ${model ?? '(unknown)'}; spend is tracked as unknown, not $0.00`,
        });
        continue;
      }

      if (ledger === 'dream_budget_jsonl') {
        if (event === 'submit_unpriced') {
          warnings.push({
            code: 'unpriced_dream_submit',
            ledger,
            ts,
            model,
            label,
            message: `${label} submitted unpriced model ${model ?? '(unknown)'}; dream spend cannot be capped precisely`,
          });
          continue;
        }
        const estimated = numberOrNull(row.estimated_cost_usd);
        if (event === 'submit' && estimated !== null) {
          entries.push(normalizeEntry({
            ts,
            ledger,
            kind: 'estimated',
            subsystem: 'dream',
            label,
            usd: estimated,
            provider,
            model,
            source_id: null,
            client_id: null,
            token_name: null,
            confidence: 'estimated',
          }));
        }
        continue;
      }

      if (ledger === 'quality_probe_jsonl') {
        const estimated = numberOrNull(row.est_cost_usd);
        if (estimated !== null && estimated > 0) {
          entries.push(normalizeEntry({
            ts,
            ledger,
            kind: 'estimated',
            subsystem: 'quality_probe',
            label: 'nightly_quality_probe',
            usd: estimated,
            provider,
            model,
            source_id: null,
            client_id: null,
            token_name: null,
            confidence: 'estimated',
          }));
        }
      }
    }
  }
  return entries;
}

function dedupeActualSpend(entries: SpendEntry[]): DedupeResult {
  const seen = new Set<string>();
  const out: SpendEntry[] = [];
  let duplicateUsd = 0;
  let duplicateCount = 0;
  const sorted = [...entries].sort((a, b) => ledgerRank(a.ledger) - ledgerRank(b.ledger));
  for (const entry of sorted) {
    if (entry.kind !== 'actual') {
      out.push(entry);
      continue;
    }
    const key = actualFingerprint(entry);
    if (seen.has(key)) {
      duplicateUsd += entry.usd;
      duplicateCount++;
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return { entries: out, duplicateUsd, duplicateCount };
}

function aggregateWarnings(warnings: SpendWarning[]): SpendWarning[] {
  const map = new Map<string, SpendWarning>();
  for (const warning of warnings) {
    const key = [
      warning.code,
      warning.ledger ?? '',
      warning.model ?? '',
      warning.label ?? '',
      warning.message,
    ].join('|');
    const existing = map.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      continue;
    }
    map.set(key, { ...warning, count: warning.count ?? 1 });
  }
  return Array.from(map.values());
}

function actualFingerprint(entry: SpendEntry): string {
  const d = new Date(entry.ts);
  const second = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19) : entry.ts.slice(0, 19);
  const provider = entry.provider ?? providerFromModel(entry.model) ?? '';
  return [
    second,
    provider,
    entry.model ?? '',
    Math.round(entry.usd * 1_000_000) / 1_000_000,
  ].join('|');
}

function ledgerRank(ledger: string): number {
  if (ledger === 'mcp_spend_log') return 0;
  if (ledger.endsWith('_runs') || ledger === 'take_grade_cache' || ledger === 'calibration_profiles') return 1;
  if (ledger === 'budget_jsonl') return 2;
  if (ledger === 'extract_rollup_7d') return 3;
  return 4;
}

function normalizeEntry(entry: SpendEntry): SpendEntry {
  const provider = entry.provider ?? providerFromModel(entry.model);
  return {
    ...entry,
    provider,
    usd: roundUsd(entry.usd),
  };
}

function providerFromModel(model: string | null): string | null {
  if (!model) return null;
  const split = splitProviderModelId(model);
  return split.provider ?? null;
}

function groupEntries(entries: SpendEntry[], since: Date, until: Date): SpendGroup[] {
  const map = new Map<string, SpendGroup>();
  for (const e of entries) {
    if (!inWindow(new Date(e.ts), since, until)) continue;
    const key = [
      e.subsystem,
      e.label,
      e.provider ?? '',
      e.model ?? '',
      e.source_id ?? '',
      e.client_id ?? '',
    ].join('|');
    let g = map.get(key);
    if (!g) {
      g = {
        subsystem: e.subsystem,
        label: e.label,
        provider: e.provider,
        model: e.model,
        source_id: e.source_id,
        client_id: e.client_id,
        actual_usd: 0,
        pending_usd: 0,
        estimated_usd: 0,
        calls: 0,
      };
      map.set(key, g);
    }
    if (e.kind === 'actual') g.actual_usd += e.usd;
    if (e.kind === 'pending') g.pending_usd += e.usd;
    if (e.kind === 'estimated') g.estimated_usd += e.usd;
    g.calls++;
  }
  return Array.from(map.values())
    .map(roundGroup)
    .sort((a, b) => (b.actual_usd + b.pending_usd + b.estimated_usd) - (a.actual_usd + a.pending_usd + a.estimated_usd));
}

function groupLedgers(entries: SpendEntry[], since: Date, until: Date): SpendReport['ledger_totals'] {
  const map = new Map<string, { ledger: string; actual_usd: number; pending_usd: number; estimated_usd: number }>();
  for (const e of entries) {
    if (!inWindow(new Date(e.ts), since, until)) continue;
    const g = map.get(e.ledger) ?? { ledger: e.ledger, actual_usd: 0, pending_usd: 0, estimated_usd: 0 };
    if (e.kind === 'actual') g.actual_usd += e.usd;
    if (e.kind === 'pending') g.pending_usd += e.usd;
    if (e.kind === 'estimated') g.estimated_usd += e.usd;
    map.set(e.ledger, g);
  }
  return Array.from(map.values())
    .map((g) => ({
      ledger: g.ledger,
      actual_usd: roundUsd(g.actual_usd),
      pending_usd: roundUsd(g.pending_usd),
      estimated_usd: roundUsd(g.estimated_usd),
    }))
    .sort((a, b) => a.ledger.localeCompare(b.ledger));
}

function roundGroup(g: SpendGroup): SpendGroup {
  return {
    ...g,
    actual_usd: roundUsd(g.actual_usd),
    pending_usd: roundUsd(g.pending_usd),
    estimated_usd: roundUsd(g.estimated_usd),
  };
}

function sumUsd(entries: SpendEntry[], kind: SpendKind, since: Date, until: Date): number {
  return entries.reduce((sum, e) => {
    if (e.kind !== kind) return sum;
    return inWindow(new Date(e.ts), since, until) ? sum + e.usd : sum;
  }, 0);
}

function sumCurrentPendingUsd(entries: SpendEntry[], now: Date): number {
  const dayStart = startOfUtcDay(now);
  return entries.reduce((sum, e) => {
    if (e.kind !== 'pending') return sum;
    const ts = new Date(e.ts);
    return ts < dayStart ? sum + e.usd : sum;
  }, 0);
}

function auditLabel(row: RawAuditLine): string {
  const raw = row.sub_label ?? row.label ?? row.phase ?? 'unknown';
  return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

function subsystemFromLabel(label: string): string {
  const cleaned = label.replace(/[:_]/g, '.');
  const first = cleaned.split('.')[0];
  return first && first.length > 0 ? first : 'unknown';
}

function centsToUsd(v: unknown): number {
  return numberOrZero(v) / 100;
}

function numberOrZero(v: unknown): number {
  const n = numberOrNull(v);
  return n ?? 0;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundUsd(n: number): number {
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function daysInUtcMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toIso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  if (!Number.isFinite(d.getTime())) return new Date(0).toISOString();
  return d.toISOString();
}

function inWindow(d: Date, since: Date, until: Date): boolean {
  return Number.isFinite(d.getTime()) && d >= since && d < until;
}
