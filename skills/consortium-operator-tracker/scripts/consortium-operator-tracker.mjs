#!/usr/bin/env bun
/**
 * Deterministic helpers for the Tailored DeFi Consortium Operator Friendly sheet.
 *
 * The mutating source of truth lives in OpenClaw Python scripts because the
 * tracker state and Google OAuth bridge belong to OpenClaw/Tailored ops.
 * This wrapper keeps Hermes/GBrain routing, validation, and command planning
 * deterministic and testable.
 */

import { spawnSync } from 'node:child_process';

export const OPENCLAW_ROOT = '/Users/jarvis/.openclaw-jarvis-v2';
export const SHEET_ID = '1X3837i_Mf8UDZ91gWpBpLPr2rIB3tMgkaCxqT7vyxO4';
export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
export const OPERATOR_TAB = 'Operator Friendly';
export const SYNC_SCRIPT = `${OPENCLAW_ROOT}/ops/consortium/sync_operator_friendly_sheet.py`;
export const UPDATE_SCRIPT = `${OPENCLAW_ROOT}/ops/consortium/update_operator_friendly_status.py`;
export const LOCAL_CSV = `${OPENCLAW_ROOT}/data/prospect/defi-consortium/consortium_operator_friendly.csv`;
export const LOCAL_JSON = `${OPENCLAW_ROOT}/data/prospect/defi-consortium/consortium_operator_friendly.json`;

export const VISIBLE_COLUMNS = [
  'Protocol',
  'X Handle',
  'Consortium Role',
  'PoC',
  'Connected with',
  'Outreach Status',
  'Net Status',
];
export const ALLOWED_OPERATORS = ['Ted', 'Nutoro', 'Alina', 'Jiraiya'];
export const ALLOWED_ROLES = ['Member', 'Vendor'];
export const ALLOWED_OUTREACH = ['Not yet', 'Form sent', 'Form filled'];
export const ALLOWED_NET = ['N/A', 'Consortium Member', 'Consortium Vendor'];

const OWNER_PATTERNS = [
  ['Jiraiya', /jiraiya|tailored/i],
  ['Alina', /alina/i],
  ['Nutoro', /nutoro/i],
  ['Ted', /\bted\b/i],
];

export function normalizeOperator(source) {
  const text = String(source ?? '');
  const hits = OWNER_PATTERNS
    .map(([operator, pattern]) => {
      const match = text.match(pattern);
      return match ? { operator, index: match.index ?? 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
  return hits[0]?.operator ?? '';
}

export function assertAllowed(field, value) {
  const allowedByField = {
    'Consortium Role': ALLOWED_ROLES,
    'Connected with': ALLOWED_OPERATORS,
    'Outreach Status': ALLOWED_OUTREACH,
    'Net Status': ALLOWED_NET,
  };
  const allowed = allowedByField[field];
  if (!allowed) throw new Error(`unknown constrained field: ${field}`);
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return value;
}

export function validateVisibleRow(row) {
  const errors = [];
  for (const column of VISIBLE_COLUMNS) {
    if (!(column in row)) errors.push(`missing ${column}`);
  }
  for (const [field, allowed] of [
    ['Consortium Role', ALLOWED_ROLES],
    ['Outreach Status', ALLOWED_OUTREACH],
    ['Net Status', ALLOWED_NET],
  ]) {
    if (field in row && !allowed.includes(row[field])) errors.push(`${field} invalid: ${row[field]}`);
  }
  if (row['Connected with'] && !ALLOWED_OPERATORS.includes(row['Connected with'])) {
    errors.push(`Connected with invalid: ${row['Connected with']}`);
  }
  return { ok: errors.length === 0, errors };
}

export function buildSyncCommand() {
  return ['python3', SYNC_SCRIPT];
}

export function buildUpdateCommand({ protocol, canonicalId, role, outreachStatus, netStatus, evidence, dryRun = false, noResync = false }) {
  if (!protocol && !canonicalId) throw new Error('protocol or canonicalId is required');
  const args = ['python3', UPDATE_SCRIPT];
  if (protocol) args.push('--protocol', protocol);
  if (canonicalId) args.push('--canonical-id', canonicalId);
  if (role) args.push('--role', assertAllowed('Consortium Role', role));
  if (outreachStatus) args.push('--outreach-status', assertAllowed('Outreach Status', outreachStatus));
  if (netStatus) {
    args.push('--net-status', assertAllowed('Net Status', netStatus));
    if (netStatus !== 'N/A') {
      if (!String(evidence ?? '').trim()) {
        throw new Error('evidence is required when Net Status is Consortium Member or Consortium Vendor');
      }
      args.push('--evidence', String(evidence).trim());
    }
  }
  if (!outreachStatus && !netStatus) throw new Error('outreachStatus or netStatus is required');
  if (dryRun) args.push('--dry-run');
  if (noResync) args.push('--no-resync');
  return args;
}

export function plan(input = {}) {
  const action = input.action ?? 'config';
  if (action === 'sync') {
    return { action, sheetUrl: SHEET_URL, command: buildSyncCommand(), localCsv: LOCAL_CSV, localJson: LOCAL_JSON };
  }
  if (action === 'update') {
    return { action, sheetUrl: SHEET_URL, command: buildUpdateCommand(input) };
  }
  if (action === 'config') {
    return {
      action,
      sheetUrl: SHEET_URL,
      operatorTab: OPERATOR_TAB,
      visibleColumns: VISIBLE_COLUMNS,
      allowedOperators: ALLOWED_OPERATORS,
      allowedRoles: ALLOWED_ROLES,
      allowedOutreach: ALLOWED_OUTREACH,
      allowedNet: ALLOWED_NET,
      syncScript: SYNC_SCRIPT,
      updateScript: UPDATE_SCRIPT,
      localCsv: LOCAL_CSV,
      localJson: LOCAL_JSON,
    };
  }
  throw new Error(`unknown action: ${action}`);
}

export function run(input = {}) {
  return plan(input);
}

function parseCliArgs(argv) {
  const out = { action: 'config' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sync') out.action = 'sync';
    else if (arg === '--update') out.action = 'update';
    else if (arg === '--exec') out.exec = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-resync') out.noResync = true;
    else if (arg === '--protocol') out.protocol = argv[++i];
    else if (arg === '--canonical-id') out.canonicalId = argv[++i];
    else if (arg === '--role') out.role = argv[++i];
    else if (arg === '--outreach-status') out.outreachStatus = argv[++i];
    else if (arg === '--net-status') out.netStatus = argv[++i];
    else if (arg === '--evidence') out.evidence = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

const HELP = `consortium-operator-tracker

Examples:
  bun skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs --sync
  bun skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs --update --protocol Ankr --outreach-status "Form sent" --dry-run
  bun skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs --update --canonical-id ankr --net-status "Consortium Vendor" --evidence "Jiraiya confirmed signed/agreed in Telegram YYYY-MM-DD" --exec

Without --exec, the script prints the exact argv command plan only. Mutating updates require --exec.
`;

if (import.meta.main) {
  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(HELP);
      process.exit(0);
    }
    const execution = Boolean(parsed.exec);
    delete parsed.exec;
    const p = plan(parsed);
    if (execution && (p.action === 'sync' || p.action === 'update')) {
      const proc = spawnSync(p.command[0], p.command.slice(1), { cwd: OPENCLAW_ROOT, encoding: 'utf8' });
      if (proc.stdout) process.stdout.write(proc.stdout);
      if (proc.stderr) process.stderr.write(proc.stderr);
      process.exit(proc.status ?? 1);
    }
    console.log(JSON.stringify(p, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
