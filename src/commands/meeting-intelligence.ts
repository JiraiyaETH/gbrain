import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import {
  buildMeetingRepairSweepPlan,
  buildMeetingRuntimeRun,
  claimMeetingWakeRequests,
  createFirefliesProviderAdapter,
  ensureMeetingIntelligenceSchema,
  loadMeetingLedgers,
  persistMeetingRuntimeRun,
  resolveMeetingRuntimePaths,
  runMeetingIntelligenceDryRun,
} from '../core/meeting-intelligence/index.ts';

const HELP = `Usage: gbrain meeting-intelligence <command> [options]

Commands:
  dry-run      Render synthetic provider payloads to page/audit/review receipts
  watch        Poll/ingest completed provider meetings into BrainEngine ledger + Alex wake rows
  wake         Claim pending Alex wake rows and print/execute isolated Hermes command plans
  repair       Plan stale ledger/wake repair actions
  paths        Print neutral runtime authority/table defaults

Dry-run options:
  --fixture PATH          JSON fixture file with fireflies.completed payload
  --out DIR               Output directory under --allow-root
  --allow-root DIR        Allowed proof root (default: --out)
  --include-duplicates    Include fireflies.duplicate from the fixture when present
  --json                  Print JSON summary

Watch options:
  --provider fireflies    Provider adapter (currently fixture-backed Fireflies)
  --fixture PATH          JSON fixture file with fireflies.completed payload
  --source default        Required canonical source (default: default)
  --limit N               Max payloads to ingest (default: 10)
  --target-profile alex   Hermes profile to wake (default: alex)
  --include-duplicates    Include fireflies.duplicate from the fixture when present
  --json                  Print JSON summary

Wake options:
  --limit N               Max wake rows to claim/plan (default: 3)
  --target-profile alex   Hermes profile to wake (default: alex)
  --dry-run               Do not mark rows claimed; only print plans
  --execute               Spawn Hermes for claimed rows (never used by tests)
  --json                  Print JSON summary

Repair options:
  --limit N               Max ledgers to inspect (default: 100)
  --stale-after-ms N      Staleness threshold (default: 6h)
  --json                  Print JSON summary

Live provider fetch is approval-gated; fixture mode is the safe rollout/test path.
`;

interface ParsedArgs {
  fixture?: string;
  out?: string;
  allowRoot?: string;
  includeDuplicates: boolean;
  json: boolean;
  provider: string;
  source: string;
  limit: number;
  targetProfile: string;
  dryRun: boolean;
  execute: boolean;
  staleAfterMs?: number;
}

export async function runMeetingIntelligenceCli(
  args: string[],
  io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
  opts: { engine?: BrainEngine } = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => console.log(text));
  const stderr = io.stderr ?? ((text: string) => console.error(text));
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    stdout(HELP);
    return 0;
  }

  if (command === 'paths') {
    stdout(JSON.stringify(resolveMeetingRuntimePaths(), null, 2));
    return 0;
  }

  const parsed = parseArgs(args.slice(1));
  if ('help' in parsed) {
    stdout(HELP);
    return 0;
  }

  if (command === 'dry-run') {
    return runDryRunCommand(parsed, stdout, stderr);
  }
  if (command === 'watch') {
    if (!opts.engine) return missingEngine(stderr, command);
    return runWatchCommand(parsed, opts.engine, stdout, stderr);
  }
  if (command === 'wake') {
    if (!opts.engine) return missingEngine(stderr, command);
    return runWakeCommand(parsed, opts.engine, stdout);
  }
  if (command === 'repair') {
    if (!opts.engine) return missingEngine(stderr, command);
    return runRepairCommand(parsed, opts.engine, stdout);
  }

  stderr(`Unknown meeting-intelligence command: ${command}`);
  stderr(HELP);
  return 2;
}

async function runDryRunCommand(
  parsed: ParsedArgs,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  if (!parsed.fixture || !parsed.out) {
    stderr('Usage: gbrain meeting-intelligence dry-run --fixture <path> --out <dir> [--allow-root <dir>]');
    return 2;
  }
  const fixturePath = resolve(parsed.fixture);
  const outputRoot = resolve(parsed.out);
  const allowedRoot = resolve(parsed.allowRoot ?? parsed.out);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  const payloads = await loadFirefliesFixturePayloads(fixture, parsed.includeDuplicates, parsed.limit);
  const result = await runMeetingIntelligenceDryRun({
    provider_payloads: payloads,
    output_root: outputRoot,
    allowed_root: allowedRoot,
  });
  const summary = {
    status: 'dry_run_complete',
    output_root: result.output_root,
    pages_written: result.pages_written,
    audit_files_written: result.audit_files_written,
    receipt_files_written: result.receipt_files_written,
    idempotent_pages: result.idempotent_pages,
    page_count: result.artifacts.audit.page_count,
    duplicate_raw_records: result.artifacts.audit.duplicate_raw_records,
    review_queue_count: result.artifacts.audit.review_queue_count,
    live_provider_calls: result.artifacts.audit.live_provider_calls,
    live_gbrain_writes: result.artifacts.audit.live_gbrain_writes,
    runtime: result.runtime.summary,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence dry-run complete: ${summary.page_count} page(s)`,
    `output_root=${summary.output_root}`,
    `review_queue_count=${summary.review_queue_count}`,
    `live_provider_calls=${summary.live_provider_calls}`,
    `live_gbrain_writes=${summary.live_gbrain_writes}`,
  ]);
  return 0;
}

async function runWatchCommand(
  parsed: ParsedArgs,
  engine: BrainEngine,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  if (parsed.source !== 'default') {
    stderr('meeting-intelligence watch only writes source default');
    return 2;
  }
  if (parsed.provider !== 'fireflies') {
    stderr(`unsupported meeting provider: ${parsed.provider}`);
    return 2;
  }
  if (!parsed.fixture) {
    stderr('live Fireflies watch is approval-gated in this build; provide --fixture for controlled rollout/testing');
    return 2;
  }
  await ensureMeetingIntelligenceSchema(engine);
  const fixture = JSON.parse(readFileSync(resolve(parsed.fixture), 'utf8')) as unknown;
  const payloads = await loadFirefliesFixturePayloads(fixture, parsed.includeDuplicates, parsed.limit);
  const adapter = createFirefliesProviderAdapter({ mode: 'fixture', fixture_payloads: payloads });
  const meetings = payloads.map((payload) => adapter.normalize(payload));
  const existingLedgers = await loadMeetingLedgers(engine, { limit: 500 });
  const runtime = buildMeetingRuntimeRun(meetings, { existing_ledgers: existingLedgers });
  const persistence = await persistMeetingRuntimeRun(engine, runtime, meetings);
  const summary = {
    status: 'watch_complete',
    provider: parsed.provider,
    source_id: 'default',
    runtime: runtime.summary,
    persistence,
    page_count: runtime.summary.page_count,
    wake_requests_emitted: persistence.wake_requests_emitted,
    wake_requests_pending: persistence.wake_requests_pending,
    live_provider_calls: 0,
    live_gbrain_writes: 0,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence watch complete: ${summary.page_count} meeting(s)`,
    `wake_requests_emitted=${summary.wake_requests_emitted}`,
    `wake_requests_pending=${summary.wake_requests_pending}`,
  ]);
  return 0;
}

async function runWakeCommand(
  parsed: ParsedArgs,
  engine: BrainEngine,
  stdout: (text: string) => void,
): Promise<number> {
  const claimed = await claimMeetingWakeRequests(engine, {
    target_profile: parsed.targetProfile,
    limit: parsed.limit,
    dry_run: parsed.dryRun,
  });
  const executions = parsed.execute && !parsed.dryRun
    ? executeWakePlans(claimed.map((row) => row.command_plan))
    : [];
  const summary = {
    status: parsed.dryRun ? 'wake_plan' : 'wake_claimed',
    target_profile: parsed.targetProfile,
    dry_run: parsed.dryRun,
    execute: parsed.execute,
    claimed_count: claimed.length,
    wake_requests: claimed,
    executions,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence wake ${summary.status}: ${summary.claimed_count} request(s)`,
  ]);
  return 0;
}

async function runRepairCommand(
  parsed: ParsedArgs,
  engine: BrainEngine,
  stdout: (text: string) => void,
): Promise<number> {
  const ledgers = await loadMeetingLedgers(engine, { limit: parsed.limit });
  const plan = buildMeetingRepairSweepPlan(ledgers, {
    stale_after_ms: parsed.staleAfterMs,
  });
  const summary = {
    status: 'repair_plan',
    candidates: plan.candidates,
    poller: plan.poller,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence repair plan: ${plan.candidates.length} candidate(s)`,
  ]);
  return 0;
}

function parseArgs(args: string[]): ParsedArgs | { help: true } {
  const parsed: ParsedArgs = {
    includeDuplicates: false,
    json: false,
    provider: 'fireflies',
    source: 'default',
    limit: 10,
    targetProfile: 'alex',
    dryRun: false,
    execute: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--include-duplicates') { parsed.includeDuplicates = true; continue; }
    if (arg === '--dry-run') { parsed.dryRun = true; continue; }
    if (arg === '--execute') { parsed.execute = true; continue; }
    if (arg === '--fixture') { parsed.fixture = args[++i]; continue; }
    if (arg === '--out') { parsed.out = args[++i]; continue; }
    if (arg === '--allow-root') { parsed.allowRoot = args[++i]; continue; }
    if (arg === '--provider') { parsed.provider = args[++i] ?? parsed.provider; continue; }
    if (arg === '--source') { parsed.source = args[++i] ?? parsed.source; continue; }
    if (arg === '--target-profile') { parsed.targetProfile = args[++i] ?? parsed.targetProfile; continue; }
    if (arg === '--limit') { parsed.limit = positiveInt(args[++i], '--limit'); continue; }
    if (arg === '--stale-after-ms') { parsed.staleAfterMs = positiveInt(args[++i], '--stale-after-ms'); continue; }
  }
  return parsed;
}

async function loadFirefliesFixturePayloads(
  fixture: unknown,
  includeDuplicates: boolean,
  limit = 10,
): Promise<unknown[]> {
  const root = fixture && typeof fixture === 'object' && !Array.isArray(fixture)
    ? fixture as Record<string, unknown>
    : {};
  const fireflies = root.fireflies && typeof root.fireflies === 'object' && !Array.isArray(root.fireflies)
    ? root.fireflies as Record<string, unknown>
    : {};
  const payloads = [fireflies.completed, includeDuplicates ? fireflies.duplicate : undefined]
    .filter((payload): payload is unknown => payload !== undefined)
    .slice(0, limit);
  if (payloads.length === 0) {
    throw new Error('fixture must contain fireflies.completed');
  }
  const adapter = createFirefliesProviderAdapter({
    mode: 'fixture',
    fixture_payloads: payloads,
  });
  const completed = await adapter.fetchCompletedMeeting({
    provider_meeting_id: providerMeetingId(payloads[0]!),
  });
  const result = [completed];
  if (includeDuplicates && payloads[1]) {
    result.push(await adapter.fetchCompletedMeeting({
      provider_meeting_id: providerMeetingId(payloads[1]),
    }));
  }
  return result;
}

function providerMeetingId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Fireflies fixture payload must be an object');
  }
  const raw = payload as Record<string, unknown>;
  const id = raw.id ?? raw.transcript_id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Fireflies fixture payload requires id or transcript_id');
  }
  return id;
}

function missingEngine(stderr: (text: string) => void, command: string): number {
  stderr(`meeting-intelligence ${command} requires a connected BrainEngine`);
  return 2;
}

function positiveInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} requires a positive integer`);
  }
  return parsed;
}

function printSummary(summary: unknown, json: boolean, stdout: (text: string) => void, lines: string[]): void {
  if (json) stdout(JSON.stringify(summary, null, 2));
  else stdout(lines.join('\n'));
}

function executeWakePlans(plans: Array<{ env: Record<string, string>; argv: string[] }>): Array<{ status: number | null; signal: NodeJS.Signals | null }> {
  // Imported lazily so dry-run/test paths do not acquire subprocess state.
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  return plans.map((plan) => {
    const [command, ...args] = plan.argv;
    const result = spawnSync(command!, args, {
      env: { ...process.env, ...plan.env },
      stdio: 'ignore',
    });
    return { status: result.status, signal: result.signal };
  });
}
