import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createFirefliesProviderAdapter,
  resolveMeetingRuntimePaths,
  runMeetingIntelligenceDryRun,
} from '../core/meeting-intelligence/index.ts';

const HELP = `Usage: gbrain meeting-intelligence <command> [options]

Commands:
  dry-run      Render synthetic provider payloads to page/audit/review receipts
  paths        Print neutral runtime path defaults

Dry-run options:
  --fixture PATH          JSON fixture file with fireflies.completed payload
  --out DIR               Output directory under --allow-root
  --allow-root DIR        Allowed proof root (default: --out)
  --include-duplicates    Include fireflies.duplicate from the fixture when present
  --json                  Print JSON summary
  --help, -h              Show this help

This command does not call live providers and does not write a live GBrain corpus.
`;

interface ParsedDryRun {
  fixture?: string;
  out?: string;
  allowRoot?: string;
  includeDuplicates: boolean;
  json: boolean;
}

export async function runMeetingIntelligenceCli(
  args: string[],
  io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
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

  if (command !== 'dry-run') {
    stderr(`Unknown meeting-intelligence command: ${command}`);
    stderr(HELP);
    return 2;
  }

  const parsed = parseDryRunArgs(args.slice(1));
  if ('help' in parsed) {
    stdout(HELP);
    return 0;
  }
  if (!parsed.fixture || !parsed.out) {
    stderr('Usage: gbrain meeting-intelligence dry-run --fixture <path> --out <dir> [--allow-root <dir>]');
    return 2;
  }

  const fixturePath = resolve(parsed.fixture);
  const outputRoot = resolve(parsed.out);
  const allowedRoot = resolve(parsed.allowRoot ?? parsed.out);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  const payloads = await loadFirefliesFixturePayloads(fixture, parsed.includeDuplicates);
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

  if (parsed.json) {
    stdout(JSON.stringify(summary, null, 2));
  } else {
    stdout(
      [
        `meeting-intelligence dry-run complete: ${summary.page_count} page(s)`,
        `output_root=${summary.output_root}`,
        `review_queue_count=${summary.review_queue_count}`,
        `live_provider_calls=${summary.live_provider_calls}`,
        `live_gbrain_writes=${summary.live_gbrain_writes}`,
      ].join('\n'),
    );
  }
  return 0;
}

function parseDryRunArgs(args: string[]): ParsedDryRun | { help: true } {
  const parsed: ParsedDryRun = {
    includeDuplicates: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--include-duplicates') {
      parsed.includeDuplicates = true;
      continue;
    }
    if (arg === '--fixture') {
      parsed.fixture = args[++i];
      continue;
    }
    if (arg === '--out') {
      parsed.out = args[++i];
      continue;
    }
    if (arg === '--allow-root') {
      parsed.allowRoot = args[++i];
      continue;
    }
  }
  return parsed;
}

async function loadFirefliesFixturePayloads(
  fixture: unknown,
  includeDuplicates: boolean,
): Promise<unknown[]> {
  const root = fixture && typeof fixture === 'object' && !Array.isArray(fixture)
    ? fixture as Record<string, unknown>
    : {};
  const fireflies = root.fireflies && typeof root.fireflies === 'object' && !Array.isArray(root.fireflies)
    ? root.fireflies as Record<string, unknown>
    : {};
  const payloads = [fireflies.completed, includeDuplicates ? fireflies.duplicate : undefined]
    .filter((payload): payload is unknown => payload !== undefined);
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
