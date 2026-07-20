import type { BrainEngine } from '../core/engine.ts';
import {
  checkTimelineDedupIndex,
  formatTimelineContentRepairHuman,
  repairTimelineContent,
  repairTimelineDedupIndex,
} from '../core/timeline-dedup-repair.ts';

export const TIMELINE_REPAIR_HELP = `gbrain timeline repair [--content] [--apply] [--json] [--source-id ID]

Default is a strict dry run.
  --content       Compare stored rows with each page's current timeline content
  --apply         Apply proposed adoptions/deletions (or index repair)
  --json          Print one machine-readable JSON object
  --source-id ID  Restrict content repair to one source
`;

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runTimelineRepair(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(TIMELINE_REPAIR_HELP);
    return;
  }
  if (!engine) throw new Error('timeline repair requires a local brain');

  const apply = args.includes('--apply');
  const json = args.includes('--json');
  const content = args.includes('--content');
  const sourceId = valueAfter(args, '--source-id');
  const known = new Set(['--apply', '--json', '--content', '--source-id']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--') || !known.has(arg)) throw new Error(`Unknown timeline repair option: ${arg}`);
    if (arg === '--source-id') i++;
  }
  if (args.includes('--source-id') && (!sourceId || sourceId.startsWith('--'))) {
    throw new Error('--source-id requires a value');
  }

  if (content) {
    const report = await repairTimelineContent(engine, { apply, sourceId });
    if (json) process.stdout.write(JSON.stringify(report) + '\n');
    else process.stdout.write(formatTimelineContentRepairHuman(report) + '\n');
    return;
  }

  const before = await checkTimelineDedupIndex(engine);
  if (!apply) {
    const report = {
      mode: 'index',
      dry_run: true,
      needs_repair: before.needsRepair,
      table_present: before.tablePresent,
      index_present: before.indexPresent,
      columns: before.columns,
    };
    if (json) process.stdout.write(JSON.stringify(report) + '\n');
    else {
      process.stdout.write(
        `Timeline index repair (DRY RUN)\n` +
        `Shape: ${before.columns.join(',') || '(absent)'}\n` +
        `${before.needsRepair ? 'Repair required.' : 'Index is already correct.'}\n` +
        `No changes applied. Re-run with --apply to rebuild when required.\n`,
      );
    }
    return;
  }

  const repaired = await repairTimelineDedupIndex(engine);
  if (json) process.stdout.write(JSON.stringify({ mode: 'index', dry_run: false, ...repaired }) + '\n');
  else {
    process.stdout.write(
      `Timeline index repair (APPLIED)\n` +
      `${repaired.repaired ? 'Rebuilt index.' : `No change (${repaired.reason}).`}\n` +
      `Collapsed duplicates: ${repaired.collapsedDuplicates}\n`,
    );
  }
}
