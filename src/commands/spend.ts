import type { BrainEngine } from '../core/engine.ts';
import {
  DEFAULT_DAILY_CAP_USD,
  DEFAULT_MONTHLY_BUDGET_USD,
  buildSpendReport,
  formatSpendReport,
} from '../core/budget/spend-report.ts';
import { buildSpendAlert, formatSpendAlert } from '../core/budget/spend-alert.ts';

const HELP = `gbrain spend

USAGE
  gbrain spend [--json|--alert-json|--alert-text] [--audit-dir DIR] [--daily-cap-usd N] [--monthly-budget-usd N]

SUMMARY
  Summarizes known paid API spend across:
  - mcp_spend_log and pending mcp_spend_reservations
  - BudgetTracker JSONL audit rows (budget-YYYY-Www.jsonl)
  - quality-probe and dream-budget audit estimates
  - DB eval / takes / calibration / extract cost receipt tables

ALERT OUTPUTS
  --alert-json   Render the Alex warning payload without sending it.
  --alert-text   Render the Telegram-ready warning text without sending it.

Defaults: daily cap $${DEFAULT_DAILY_CAP_USD.toFixed(2)}, monthly budget $${DEFAULT_MONTHLY_BUDGET_USD.toFixed(2)}.
`;

export async function runSpend(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (!engine) {
    throw new Error('gbrain spend requires a local brain database connection');
  }
  const json = args.includes('--json');
  const alertJson = args.includes('--alert-json');
  const alertText = args.includes('--alert-text');
  const outputModes = [json, alertJson, alertText].filter(Boolean).length;
  if (outputModes > 1) {
    throw new Error('choose only one of --json, --alert-json, or --alert-text');
  }
  const auditDir = stringFlag(args, '--audit-dir');
  const dailyCapUsd = numberFlag(args, '--daily-cap-usd') ?? DEFAULT_DAILY_CAP_USD;
  const monthlyBudgetUsd = numberFlag(args, '--monthly-budget-usd') ?? DEFAULT_MONTHLY_BUDGET_USD;
  const nowRaw = stringFlag(args, '--now');
  const now = nowRaw ? new Date(nowRaw) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`invalid --now value: ${nowRaw}`);
  }
  const report = await buildSpendReport(engine, {
    now,
    auditDir,
    dailyCapUsd,
    monthlyBudgetUsd,
  });
  if (alertJson || alertText) {
    const alert = buildSpendAlert(report);
    if (alertJson) console.log(JSON.stringify(alert, null, 2));
    else console.log(formatSpendAlert(alert));
    return;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSpendReport(report));
  }
}

function stringFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

function numberFlag(args: string[], flag: string): number | undefined {
  const raw = stringFlag(args, flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number`);
  return n;
}
