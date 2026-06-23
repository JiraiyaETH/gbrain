import type { SpendReport, SpendWarning } from './spend-report.ts';

export const ALEX_NOTIFICATIONS_TOPIC_DESTINATION = 'telegram:-1003757407550:1';
export const ALEX_DM_FALLBACK_DESTINATION = 'telegram:447751292';

export type SpendAlertSeverity = 'none' | 'warning' | 'critical';

export interface SpendAlert {
  should_alert: boolean;
  severity: SpendAlertSeverity;
  destination: string;
  fallback_destination: string;
  dedupe_key: string;
  title: string;
  text: string;
  reasons: string[];
  report_generated_at: string;
  dry_run_only: true;
}

export interface BuildSpendAlertOptions {
  destination?: string;
  fallbackDestination?: string;
  maxWarnings?: number;
}

export function buildSpendAlert(report: SpendReport, opts: BuildSpendAlertOptions = {}): SpendAlert {
  const destination = opts.destination ?? ALEX_NOTIFICATIONS_TOPIC_DESTINATION;
  const fallbackDestination = opts.fallbackDestination ?? ALEX_DM_FALLBACK_DESTINATION;
  const maxWarnings = Math.max(0, opts.maxWarnings ?? 3);
  const reasons: string[] = [];
  let severity: SpendAlertSeverity = 'none';

  if (report.totals.daily_cap_status === 'over_cap') {
    severity = 'critical';
    reasons.push(
      `daily cap exceeded: ${money(report.totals.today_actual_plus_pending_usd)} actual+pending / ` +
      `${money(report.policy.daily_cap_usd)} cap`,
    );
  }

  if (report.totals.monthly_projection_status === 'over_budget') {
    if (severity === 'none') severity = 'warning';
    reasons.push(
      `month-end projection over budget: ${money(report.totals.projected_month_end_usd)} projected / ` +
      `${money(report.policy.monthly_budget_usd)} budget`,
    );
  }

  const alertWarnings = report.warnings.slice(0, maxWarnings);
  if (alertWarnings.length > 0) {
    if (severity === 'none') severity = 'warning';
    for (const warning of alertWarnings) {
      reasons.push(warningReason(warning));
    }
    if (report.warnings.length > alertWarnings.length) {
      reasons.push(`${report.warnings.length - alertWarnings.length} more spend ledger warnings`);
    }
  }

  const shouldAlert = severity !== 'none';
  const dedupeKey = [
    'gbrain-spend',
    report.utc_day,
    report.totals.daily_cap_status,
    report.totals.monthly_projection_status,
    warningCodes(report.warnings),
  ].join(':');
  const alert: SpendAlert = {
    should_alert: shouldAlert,
    severity,
    destination,
    fallback_destination: fallbackDestination,
    dedupe_key: dedupeKey,
    title: 'GBrain Spend Monitor',
    text: '',
    reasons,
    report_generated_at: report.generated_at,
    dry_run_only: true,
  };
  alert.text = renderAlertText(alert, report);
  return alert;
}

export function formatSpendAlert(alert: SpendAlert): string {
  return alert.text;
}

function renderAlertText(alert: SpendAlert, report: SpendReport): string {
  const lines: string[] = [];
  lines.push('**GBrain Spend Monitor**');
  lines.push('');
  if (!alert.should_alert) {
    lines.push('Status: OK - no spend warning.');
    lines.push(
      `- Today: ${money(report.totals.today_actual_plus_pending_usd)} actual+pending / ` +
      `${money(report.policy.daily_cap_usd)} daily cap; ${money(report.totals.today_estimated_usd)} estimated/unsettled.`,
    );
    lines.push(
      `- Month: ${money(report.totals.month_to_date_actual_usd)} actual; ` +
      `${money(report.totals.projected_month_end_usd)} projected / ${money(report.policy.monthly_budget_usd)} budget.`,
    );
    lines.push('Route: no Telegram send needed.');
    return lines.join('\n');
  }

  const status = alert.severity === 'critical' ? 'CRITICAL' : 'WARNING';
  lines.push(`Status: ${status} - spend policy needs attention.`);
  lines.push(
    `- Route: Alex -> ${alert.destination} (Notifications topic); fallback ${alert.fallback_destination} ` +
    'only if topic delivery fails.',
  );
  lines.push(
    `- Today: ${money(report.totals.today_actual_plus_pending_usd)} actual+pending / ` +
    `${money(report.policy.daily_cap_usd)} daily cap; ${money(report.totals.today_estimated_usd)} estimated/unsettled.`,
  );
  lines.push(
    `- Month: ${money(report.totals.month_to_date_actual_usd)} actual; ` +
    `${money(report.totals.projected_month_end_usd)} projected / ${money(report.policy.monthly_budget_usd)} budget.`,
  );
  for (const reason of alert.reasons) {
    lines.push(`- Reason: ${reason}`);
  }
  lines.push('Action: keep autonomous paid work gated until the spend source is reviewed.');
  lines.push(`Dedupe: ${alert.dedupe_key}`);
  return lines.join('\n');
}

function warningReason(warning: SpendWarning): string {
  const count = warning.count && warning.count > 1 ? ` (${warning.count} events)` : '';
  const label = warning.label ? ` label=${warning.label}` : '';
  const model = warning.model ? ` model=${warning.model}` : '';
  return `${warning.code}: ${warning.message}${count}${label}${model}`;
}

function warningCodes(warnings: SpendWarning[]): string {
  const codes = Array.from(new Set(warnings.map((w) => w.code))).sort();
  return codes.length > 0 ? codes.join(',') : 'no-warnings';
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
