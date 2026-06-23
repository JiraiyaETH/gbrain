import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveAuditDir } from '../audit-week-file.ts';
import type { BrainEngine } from '../engine.ts';
import { DEFAULT_DAILY_CAP_USD } from './spend-report.ts';

export interface AutonomousDailyCapOptions {
  dailyCapUsd?: number;
  auditDir?: string;
  auditPath?: string;
  now?: Date;
}

export interface AutonomousDailyCapSnapshot {
  capUsd: number;
  spentTodayUsd: number;
  projectedCostUsd: number;
  projectedTotalUsd: number;
  allowed: boolean;
  reason?: string;
}

interface AuditLine {
  ts?: unknown;
  event?: unknown;
  actual_cost_usd?: unknown;
  estimated_cost_usd?: unknown;
  est_cost_usd?: unknown;
}

export function parseAutonomousDailyCap(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function defaultAutonomousDailyCapUsd(): number {
  const env = parseAutonomousDailyCap(process.env.GBRAIN_AUTONOMOUS_DAILY_CAP_USD);
  return env ?? DEFAULT_DAILY_CAP_USD;
}

export async function resolveAutonomousDailyCapUsd(
  engine?: Pick<BrainEngine, 'getConfig'>,
  config?: Record<string, unknown> | null,
): Promise<number> {
  const env = parseAutonomousDailyCap(process.env.GBRAIN_AUTONOMOUS_DAILY_CAP_USD);
  if (env !== null) return env;

  const dbRaw = engine?.getConfig
    ? await engine.getConfig('spend.autonomous_daily_cap_usd').catch(() => null)
    : null;
  const db = parseAutonomousDailyCap(dbRaw);
  if (db !== null) return db;

  const flat = parseAutonomousDailyCap(config?.['spend.autonomous_daily_cap_usd']);
  if (flat !== null) return flat;

  const nestedSpend = config?.spend;
  if (nestedSpend && typeof nestedSpend === 'object') {
    const nested = parseAutonomousDailyCap(
      (nestedSpend as Record<string, unknown>).autonomous_daily_cap_usd,
    );
    if (nested !== null) return nested;
  }

  return DEFAULT_DAILY_CAP_USD;
}

export function checkAutonomousDailyCap(
  projectedCostUsd: number,
  opts: AutonomousDailyCapOptions = {},
): AutonomousDailyCapSnapshot {
  const capUsd = opts.dailyCapUsd ?? defaultAutonomousDailyCapUsd();
  const safeProjectedCost = Number.isFinite(projectedCostUsd) && projectedCostUsd > 0 ? projectedCostUsd : 0;
  const spentTodayUsd = readAutonomousSpendTodayUsd(opts);
  const projectedTotalUsd = spentTodayUsd + safeProjectedCost;

  if (capUsd < 0) {
    return { capUsd, spentTodayUsd, projectedCostUsd: safeProjectedCost, projectedTotalUsd, allowed: true };
  }

  if (projectedTotalUsd > capUsd) {
    return {
      capUsd,
      spentTodayUsd,
      projectedCostUsd: safeProjectedCost,
      projectedTotalUsd,
      allowed: false,
      reason:
        `AUTONOMOUS_DAILY_BUDGET_EXHAUSTED: projected $${projectedTotalUsd.toFixed(4)} ` +
        `> daily cap $${capUsd.toFixed(2)} (spent today $${spentTodayUsd.toFixed(4)} + this call $${safeProjectedCost.toFixed(4)})`,
    };
  }

  return { capUsd, spentTodayUsd, projectedCostUsd: safeProjectedCost, projectedTotalUsd, allowed: true };
}

export function readAutonomousSpendTodayUsd(opts: AutonomousDailyCapOptions = {}): number {
  const now = opts.now ?? new Date();
  const dayStart = startOfUtcDay(now).getTime();
  const dayEnd = now.getTime();
  const auditDir = opts.auditDir ?? (opts.auditPath ? dirname(opts.auditPath) : resolveAuditDir());
  let total = 0;
  const seen = new Set<string>();
  if (opts.auditPath && existsSync(opts.auditPath)) {
    total += readSpendFileTodayUsd(opts.auditPath, 'custom', dayStart, dayEnd);
    seen.add(opts.auditPath);
  }
  if (!existsSync(auditDir)) return total;

  for (const file of readdirSync(auditDir)) {
    const ledgerKind = classifyLedgerFile(file);
    if (!ledgerKind) continue;
    const fullPath = join(auditDir, file);
    if (seen.has(fullPath)) continue;
    total += readSpendFileTodayUsd(fullPath, ledgerKind, dayStart, dayEnd);
  }
  return total;
}

function readSpendFileTodayUsd(
  fullPath: string,
  ledgerKind: 'budget' | 'dream' | 'quality' | 'custom',
  dayStart: number,
  dayEnd: number,
): number {
  let total = 0;
    let content = '';
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      return 0;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: AuditLine;
      try {
        parsed = JSON.parse(line) as AuditLine;
      } catch {
        continue;
      }
      const ts = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : NaN;
      if (!Number.isFinite(ts) || ts < dayStart || ts > dayEnd) continue;
      const event = typeof parsed.event === 'string' ? parsed.event : '';
      if ((ledgerKind === 'budget' || ledgerKind === 'custom') && event === 'record') {
        total += numeric(parsed.actual_cost_usd);
      } else if ((ledgerKind === 'dream' || ledgerKind === 'custom') && event === 'submit') {
        total += numeric(parsed.estimated_cost_usd);
      } else if (ledgerKind === 'quality' || ledgerKind === 'custom') {
        total += numeric(parsed.est_cost_usd);
      }
    }
  return total;
}

function classifyLedgerFile(file: string): 'budget' | 'dream' | 'quality' | null {
  if (/^budget-\d{4}-W\d{2}\.jsonl$/.test(file)) return 'budget';
  if (/^dream-budget-\d{4}-W\d{2}\.jsonl$/.test(file)) return 'dream';
  if (/^quality-probe-\d{4}-W\d{2}\.jsonl$/.test(file)) return 'quality';
  return null;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
