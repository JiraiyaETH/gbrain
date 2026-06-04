import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import {
  CALENDAR_COLLECTOR,
  CALENDAR_PROJECTION_MANAGER,
  CALENDAR_RUNTIME_AUTHORITY,
  CALENDAR_SOURCE_PREFIX,
  ensureCalendarProjectionSchema,
  resolveDefaultSourceRoot,
  runCalendarProjectionSync,
} from '../core/calendar-projection/index.ts';

const HELP = `Usage: gbrain calendar-projection <command> [options]

Commands:
  paths       Print neutral Calendar Projection runtime/source authority
  dry-run     Render a fixture/snapshot to proof files without BrainEngine writes
  sync        Write default:sources/calendar pages + BrainEngine ledger/receipts from a snapshot

Options:
  --snapshot PATH       JSON calendar snapshot with events[] (fixture-safe collector input)
  --fixture PATH        Alias for --snapshot
  --out DIR             Dry-run output root (required for dry-run)
  --allow-root DIR      Allowed dry-run root (default: --out)
  --source default      Required canonical source (default: default)
  --json                Print JSON summary

Live macOS/EventKit collection remains a separate collector boundary. This command
accepts collector snapshots and owns only GBrain-native projection state.
`;

interface ParsedArgs {
  snapshot?: string;
  out?: string;
  allowRoot?: string;
  source: string;
  json: boolean;
}

export async function runCalendarProjectionCli(
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
    const summary: Record<string, unknown> = {
      runtime_authority: CALENDAR_RUNTIME_AUTHORITY,
      manager: CALENDAR_PROJECTION_MANAGER,
      collector: CALENDAR_COLLECTOR,
      source_id: 'default',
      source_prefix: CALENDAR_SOURCE_PREFIX,
      legacy_openclaw_projection_owner: 'retired_tombstoned',
      calendar_sync_owner: 'gbrain-runtime/scripts/calendar-sync-refresh.py',
    };
    if (opts.engine) {
      try {
        summary.default_source_root = await resolveDefaultSourceRoot(opts.engine);
      } catch (err) {
        summary.default_source_root_error = err instanceof Error ? err.message : String(err);
      }
    }
    stdout(JSON.stringify(summary, null, 2));
    return 0;
  }

  const parsed = parseArgs(args.slice(1));
  if ('help' in parsed) {
    stdout(HELP);
    return 0;
  }

  if (command === 'dry-run') {
    if (!parsed.snapshot || !parsed.out) {
      stderr('Usage: gbrain calendar-projection dry-run --snapshot <path> --out <dir> [--allow-root <dir>]');
      return 2;
    }
    const snapshot = loadSnapshot(parsed.snapshot);
    const result = await runCalendarProjectionSync(createDryRunEngine(), {
      sourceId: parsed.source,
      snapshot,
      dryRun: true,
      outputRoot: resolve(parsed.out),
      allowedRoot: resolve(parsed.allowRoot ?? parsed.out),
    });
    printSummary(result, parsed.json, stdout, [
      `calendar-projection dry-run complete: ${result.summary.page_count} page(s)`,
      `output_root=${result.summary.output_root}`,
      `live_provider_calls=${result.summary.live_provider_calls}`,
      `live_gbrain_writes=${result.summary.live_gbrain_writes}`,
    ]);
    return 0;
  }

  if (command === 'sync') {
    if (!opts.engine) return missingEngine(stderr, command);
    if (parsed.source !== 'default') {
      stderr('calendar-projection sync only writes source default');
      return 2;
    }
    if (!parsed.snapshot) {
      stderr('calendar-projection sync requires --snapshot; live EventKit collection stays in the collector boundary');
      return 2;
    }
    await ensureCalendarProjectionSchema(opts.engine);
    const snapshot = loadSnapshot(parsed.snapshot);
    const result = await runCalendarProjectionSync(opts.engine, {
      sourceId: 'default',
      snapshot,
      dryRun: false,
    });
    printSummary(result, parsed.json, stdout, [
      `calendar-projection sync complete: ${result.summary.page_count} page(s)`,
      `pages_written=${result.summary.pages_written}`,
      `provider_records_upserted=${result.summary.provider_records_upserted}`,
      `ledgers_upserted=${result.summary.ledgers_upserted}`,
      `receipts_recorded=${result.summary.receipts_recorded}`,
    ]);
    return 0;
  }

  stderr(`Unknown calendar-projection command: ${command}`);
  stderr(HELP);
  return 2;
}

function parseArgs(args: string[]): ParsedArgs | (ParsedArgs & { help: true }) {
  const parsed: ParsedArgs = {
    source: 'default',
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { ...parsed, help: true };
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--snapshot' || arg === '--fixture') {
      parsed.snapshot = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === '--out') {
      parsed.out = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === '--allow-root') {
      parsed.allowRoot = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === '--source') {
      parsed.source = requireValue(args, ++i, arg);
      continue;
    }
  }
  return parsed;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function loadSnapshot(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

function missingEngine(stderr: (text: string) => void, command: string): number {
  stderr(`calendar-projection ${command} requires a BrainEngine; run through the gbrain CLI local engine path`);
  return 2;
}

function printSummary(
  result: unknown,
  json: boolean,
  stdout: (text: string) => void,
  lines: string[],
): void {
  if (json) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    stdout(lines.join('\n'));
  }
}

function createDryRunEngine(): BrainEngine {
  const fail = async () => {
    throw new Error('calendar-projection dry-run does not use BrainEngine');
  };
  return {
    kind: 'pglite',
    connect: fail,
    disconnect: fail,
    initSchema: fail,
    transaction: fail,
    withReservedConnection: fail,
    getPage: fail,
    putPage: fail,
    deletePage: fail,
    deletePages: fail,
    resolveSlugsForPaths: fail,
    getPagesBySourcePaths: fail,
    getPageBySourcePath: fail,
    listPages: fail,
    getAllPageSlugs: fail,
    getAllPageSlugsWithTypes: fail,
    getChunks: fail,
    putChunks: fail,
    upsertChunks: fail,
    deleteChunks: fail,
    search: fail,
    searchKeyword: fail,
    queryVector: fail,
    addLink: fail,
    addLinksBatch: fail,
    removeLink: fail,
    removeLinksForOrigin: fail,
    getLinks: fail,
    getBacklinks: fail,
    traverseGraph: fail,
    addTimelineEntry: fail,
    addTimelineEntriesBatch: fail,
    getTimeline: fail,
    addTag: fail,
    removeTag: fail,
    getTags: fail,
    getRawData: fail,
    putRawData: fail,
    listRawData: fail,
    logIngest: fail,
    getIngestLog: fail,
    saveVersion: fail,
    getVersions: fail,
    getStats: fail,
    getHealth: fail,
    getConfig: fail,
    setConfig: fail,
    executeRaw: fail,
  } as unknown as BrainEngine;
}
