/**
 * #2038 — idx_timeline_dedup schema-drift self-heal.
 *
 * Migration v102 (`timeline_entries_source_in_dedup`) widens the dedup index
 * from (page_id, date, summary) to (page_id, date, summary, source). It was
 * renumbered from v99 during a master merge, so a brain that ran the OLD v99
 * variant has its version counter stamped PAST v102 while the index stayed
 * 3-column. `runMigrations` then can't see the drift (it early-returns when no
 * version is pending), and every `addTimelineEntry(esBatch)` fails with
 * "no unique or exclusion constraint matching the ON CONFLICT specification"
 * because both insert sites infer on the 4-column tuple — timeline writes
 * silently break brain-wide.
 *
 * The version counter can't detect this, so the repair is keyed off the actual
 * index SHAPE and runs on every migrate pass (including the no-pending path).
 * Idempotent: a no-op when the index is already 4-column.
 */

import type { BrainEngine } from './engine.ts';
import type { TimelineReconcileCandidate } from './engine.ts';
import { parseTimelineEntries } from './link-extraction.ts';
import {
  normalizeTimelineSummary,
  PAGE_TIMELINE_MANAGED_BY,
  timelineOriginKey,
} from './timeline-reconcile.ts';

const INDEX_NAME = 'idx_timeline_dedup';
const EXPECTED_COLUMNS = ['page_id', 'date', 'summary', 'source'];

export interface TimelineDedupStatus {
  /** The timeline_entries table exists (nothing to repair if not). */
  tablePresent: boolean;
  /** The index exists. */
  indexPresent: boolean;
  /** Indexed columns in order (empty when the index is absent). */
  columns: string[];
  /** Index exists in the wrong (pre-v102) shape — needs a rebuild. */
  needsRepair: boolean;
}

/** Parse the column list out of a pg_indexes `indexdef` string. */
function parseIndexColumns(indexdef: string): string[] {
  const open = indexdef.lastIndexOf('(');
  const close = indexdef.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return [];
  return indexdef
    .slice(open + 1, close)
    .split(',')
    .map(c => c.trim().split(/\s+/)[0]) // drop any "col DESC"/opclass suffix
    .filter(Boolean);
}

export async function checkTimelineDedupIndex(engine: BrainEngine): Promise<TimelineDedupStatus> {
  const tbl = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('timeline_entries')::text AS reg`,
  );
  const tablePresent = !!tbl[0]?.reg;
  if (!tablePresent) {
    return { tablePresent: false, indexPresent: false, columns: [], needsRepair: false };
  }
  const rows = await engine.executeRaw<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
    [INDEX_NAME],
  );
  const indexPresent = rows.length > 0;
  const columns = indexPresent ? parseIndexColumns(rows[0].indexdef) : [];
  const correct =
    columns.length === EXPECTED_COLUMNS.length &&
    EXPECTED_COLUMNS.every((c, i) => columns[i] === c);
  // An ABSENT index is also "needs repair" — the migration that creates it was
  // skipped. (A fresh brain always has it, created by the migration chain.)
  return { tablePresent, indexPresent, columns, needsRepair: !correct };
}

export interface TimelineDedupRepairResult {
  repaired: boolean;
  before: string[];
  collapsedDuplicates: number;
  reason: 'already_correct' | 'no_table' | 'rebuilt';
}

/**
 * Heal the index if it's missing the v102 4-column shape. Dedupes FIRST —
 * the loose 3-column index let rows differing only by `source` coexist, and
 * `CREATE UNIQUE INDEX` would throw on those collisions otherwise. Keeps the
 * earliest row (min ctid) of each 4-tuple group.
 */
export async function repairTimelineDedupIndex(engine: BrainEngine): Promise<TimelineDedupRepairResult> {
  const status = await checkTimelineDedupIndex(engine);
  if (!status.tablePresent) {
    return { repaired: false, before: [], collapsedDuplicates: 0, reason: 'no_table' };
  }
  if (!status.needsRepair) {
    return { repaired: false, before: status.columns, collapsedDuplicates: 0, reason: 'already_correct' };
  }

  // Keep the lowest `id` per 4-tuple group — deterministic and consistent with
  // the existing v-migration dedup rule (`a.id > b.id`), unlike `ctid` which is
  // a physical tuple location that can preserve an arbitrary duplicate.
  const del = await engine.executeRaw<{ n: string }>(
    `WITH d AS (
       DELETE FROM timeline_entries t
       USING (
         SELECT page_id, date, summary, source, MIN(id) AS keep
           FROM timeline_entries
          GROUP BY page_id, date, summary, source
         HAVING COUNT(*) > 1
       ) dup
       WHERE t.page_id = dup.page_id
         AND t.date = dup.date
         AND t.summary = dup.summary
         AND t.source IS NOT DISTINCT FROM dup.source
         AND t.id <> dup.keep
       RETURNING 1
     )
     SELECT COUNT(*)::text AS n FROM d`,
  );
  const collapsedDuplicates = parseInt(del[0]?.n ?? '0', 10);

  await engine.executeRaw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await engine.executeRaw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
       ON timeline_entries(page_id, date, summary, source)`,
  );
  return { repaired: true, before: status.columns, collapsedDuplicates, reason: 'rebuilt' };
}

interface StoredTimelineRow {
  id: number;
  date: string;
  source: string;
  summary: string;
  detail: string;
  managed_by: string | null;
  origin_key: string | null;
  created_at: string;
}

export interface TimelineRepairAdoption {
  id: number;
  date: string;
  source: string;
  summary: string;
  origin_key: string;
  match: 'exact' | 'source-summary-recombined' | 'citation-source';
}

export interface TimelineRepairDeletion {
  id: number;
  date: string;
  source: string;
  summary: string;
  reason:
    | 'managed-origin-not-current'
    | 'duplicate-current-parser-row'
    | 'fragmented-source-signature'
    | 'near-duplicate-superseded';
}

export interface TimelineRepairPageReport {
  source_id: string;
  slug: string;
  current_candidates: number;
  rows_scanned: number;
  adoptions: TimelineRepairAdoption[];
  proposed_deletions: TimelineRepairDeletion[];
}

export interface TimelineContentRepairReport {
  mode: 'content';
  dry_run: boolean;
  pages_scanned: number;
  rows_scanned: number;
  adoptions_proposed: number;
  deletions_proposed: number;
  adoptions_applied: number;
  deletions_applied: number;
  pages: TimelineRepairPageReport[];
}

function parseContentCandidates(content: string): TimelineReconcileCandidate[] {
  const candidates: TimelineReconcileCandidate[] = parseTimelineEntries(content);
  // Preserve the filesystem extractor's Format 2 in the repair corpus. Format
  // 1 intentionally follows the canonical parser; the eval-gated follow-up
  // commit makes the filesystem writer delegate to that same parser.
  const headerPattern = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(content)) !== null) {
    const afterIdx = match.index + match[0].length;
    const nextHeader = content.indexOf('\n### ', afterIdx);
    const nextSection = content.indexOf('\n## ', afterIdx);
    const endIdx = Math.min(
      nextHeader >= 0 ? nextHeader : content.length,
      nextSection >= 0 ? nextSection : content.length,
    );
    candidates.push({
      date: match[1],
      source: 'markdown',
      summary: match[2].trim(),
      detail: content.slice(afterIdx, endIdx).trim(),
    });
  }
  const byOrigin = new Map<string, TimelineReconcileCandidate>();
  for (const candidate of candidates) {
    byOrigin.set(timelineOriginKey(candidate.date, candidate.summary), candidate);
  }
  return [...byOrigin.values()];
}

function protectedLegacyRow(row: StoredTimelineRow): boolean {
  if (row.managed_by && row.managed_by !== PAGE_TIMELINE_MANAGED_BY) return true;
  const source = row.source.trim();
  // A source-less legacy row is indistinguishable from add_timeline_entry's
  // default shape. Keep it unowned even when it exactly matches page content;
  // positive parser evidence (a split/citation/fragment source) is required
  // before repair may adopt an unowned row.
  if (!row.managed_by && !source) return true;
  if (/^(extract-timeline-from-meetings:|life-chronicle:)/.test(source)) return true;
  if (/^(manual|add_timeline_entry|cli:timeline-add|gbrain integrity --auto)$/i.test(source)) return true;
  // Enrichment writes sourceSlug. A path-shaped provenance is therefore kept
  // unless the row is already explicitly page-parser owned.
  if (!row.managed_by && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9/._-]*$/i.test(source)) return true;
  return false;
}

function sourceFromCitationDetail(detail: string | undefined): string | null {
  const m = /^Source:\s*(.+)$/i.exec(detail ?? '');
  return m?.[1]?.trim() ?? null;
}

function matchRow(
  row: StoredTimelineRow,
  candidates: TimelineReconcileCandidate[],
): { candidate: TimelineReconcileCandidate; match: TimelineRepairAdoption['match']; score: number } | null {
  for (const candidate of candidates) {
    if (row.date !== candidate.date) continue;
    const candidateSource = candidate.source ?? '';
    if (row.summary === candidate.summary && row.source === candidateSource) {
      return { candidate, match: 'exact', score: 30 };
    }
    const citationSource = sourceFromCitationDetail(candidate.detail);
    if (citationSource && row.summary === candidate.summary && row.source === citationSource) {
      return { candidate, match: 'citation-source', score: 20 };
    }
    const recombined = normalizeTimelineSummary(`${row.source} — ${row.summary}`);
    if (row.source && recombined === normalizeTimelineSummary(candidate.summary)) {
      return { candidate, match: 'source-summary-recombined', score: 10 };
    }
  }
  return null;
}

function semanticSimilarity(a: string, b: string): number {
  const left = normalizeTimelineSummary(a);
  const right = normalizeTimelineSummary(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const la = new Set(left.split(/\s+/));
  const rb = new Set(right.split(/\s+/));
  let overlap = 0;
  for (const token of la) if (rb.has(token)) overlap++;
  return overlap / Math.max(la.size, rb.size, 1);
}

function bestSimilarity(row: StoredTimelineRow, candidate: TimelineReconcileCandidate): number {
  return Math.max(
    semanticSimilarity(row.summary, candidate.summary),
    row.source ? semanticSimilarity(`${row.source} — ${row.summary}`, candidate.summary) : 0,
  );
}

function looksParserProducedAgainst(row: StoredTimelineRow, candidate: TimelineReconcileCandidate): boolean {
  if (!row.source) return false;
  const source = normalizeTimelineSummary(row.source);
  const candidateSource = normalizeTimelineSummary(candidate.source ?? '');
  const citationSource = normalizeTimelineSummary(sourceFromCitationDetail(candidate.detail) ?? '');
  const summary = normalizeTimelineSummary(candidate.summary);
  return source === candidateSource
    || source === citationSource
    || summary.startsWith(`${source} `)
    || summary.startsWith(`${source} — `);
}

function chooseAdoptions(
  rows: StoredTimelineRow[],
  candidates: TimelineReconcileCandidate[],
): Map<string, { row: StoredTimelineRow; match: ReturnType<typeof matchRow> & {} }> {
  const chosen = new Map<string, { row: StoredTimelineRow; match: ReturnType<typeof matchRow> & {} }>();
  for (const row of rows) {
    if (protectedLegacyRow(row)) continue;
    const match = matchRow(row, candidates);
    if (!match) continue;
    const origin = timelineOriginKey(match.candidate.date, match.candidate.summary);
    const current = chosen.get(origin);
    const ownedBonus = row.managed_by === PAGE_TIMELINE_MANAGED_BY ? 100 : 0;
    const currentBonus = current?.row.managed_by === PAGE_TIMELINE_MANAGED_BY ? 100 : 0;
    const rowRank = ownedBonus + match.score;
    const currentRank = currentBonus + (current?.match.score ?? 0);
    if (!current || rowRank > currentRank || (rowRank === currentRank && row.created_at > current.row.created_at)) {
      chosen.set(origin, { row, match });
    }
  }
  return chosen;
}

export async function repairTimelineContent(
  engine: BrainEngine,
  opts: { apply?: boolean; sourceId?: string } = {},
): Promise<TimelineContentRepairReport> {
  const apply = opts.apply === true;
  const refs = opts.sourceId
    ? (await engine.listAllPageRefs()).filter(ref => ref.source_id === opts.sourceId)
    : await engine.listAllPageRefs();
  const pageReports: TimelineRepairPageReport[] = [];
  let rowsScanned = 0;
  let adoptionsApplied = 0;
  let deletionsApplied = 0;

  for (const ref of refs) {
    const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
    if (!page) continue;
    const candidates = parseContentCandidates(`${page.compiled_truth}\n${page.timeline}`);
    const rows = await engine.executeRaw<StoredTimelineRow>(
      `SELECT te.id::integer AS id, te.date::text AS date, te.source, te.summary,
              te.detail, te.managed_by, te.origin_key, te.created_at::text AS created_at
         FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
        WHERE p.source_id = $1 AND p.slug = $2
        ORDER BY te.date, te.id`,
      [ref.source_id, ref.slug],
    );
    rowsScanned += rows.length;
    if (rows.length === 0) continue;

    const chosen = chooseAdoptions(rows, candidates);
    const chosenIds = new Set([...chosen.values()].map(v => v.row.id));
    const adoptions: TimelineRepairAdoption[] = [...chosen.entries()]
      .filter(([, value]) => value.row.managed_by !== PAGE_TIMELINE_MANAGED_BY || value.row.origin_key !== timelineOriginKey(value.match.candidate.date, value.match.candidate.summary))
      .map(([origin, value]) => ({
        id: value.row.id,
        date: value.row.date,
        source: value.row.source,
        summary: value.row.summary,
        origin_key: origin,
        match: value.match.match,
      }));

    const deletions: TimelineRepairDeletion[] = [];
    for (const row of rows) {
      if (chosenIds.has(row.id) || protectedLegacyRow(row)) continue;
      const matched = matchRow(row, candidates);
      if (row.managed_by === PAGE_TIMELINE_MANAGED_BY) {
        deletions.push({
          id: row.id, date: row.date, source: row.source, summary: row.summary,
          reason: matched ? 'duplicate-current-parser-row' : 'managed-origin-not-current',
        });
        continue;
      }
      if (matched) {
        deletions.push({
          id: row.id, date: row.date, source: row.source, summary: row.summary,
          reason: 'duplicate-current-parser-row',
        });
        continue;
      }
      if (row.source.includes('[[') || row.source.includes('→')) {
        deletions.push({
          id: row.id, date: row.date, source: row.source, summary: row.summary,
          reason: 'fragmented-source-signature',
        });
        continue;
      }
      const sameDate = candidates.filter(candidate => candidate.date === row.date);
      if (sameDate.some(candidate => looksParserProducedAgainst(row, candidate) && bestSimilarity(row, candidate) >= 0.65)) {
        const replacement = sameDate
          .map(candidate => chosen.get(timelineOriginKey(candidate.date, candidate.summary))?.row)
          .find((candidateRow): candidateRow is StoredTimelineRow => !!candidateRow);
        if (replacement && (replacement.created_at >= row.created_at || replacement.summary.length >= row.summary.length)) {
          deletions.push({
            id: row.id, date: row.date, source: row.source, summary: row.summary,
            reason: 'near-duplicate-superseded',
          });
        }
      }
    }

    if (adoptions.length === 0 && deletions.length === 0) continue;
    const pageReport: TimelineRepairPageReport = {
      source_id: ref.source_id,
      slug: ref.slug,
      current_candidates: candidates.length,
      rows_scanned: rows.length,
      adoptions,
      proposed_deletions: deletions,
    };
    pageReports.push(pageReport);

    if (apply) {
      await engine.transaction(async tx => {
        for (const adoption of adoptions) {
          const changed = await tx.executeRaw<{ id: number }>(
            `UPDATE timeline_entries
                SET managed_by = $1, origin_key = $2
              WHERE id = $3
                AND (managed_by IS NULL OR managed_by = $1)
              RETURNING id`,
            [PAGE_TIMELINE_MANAGED_BY, adoption.origin_key, adoption.id],
          );
          adoptionsApplied += changed.length;
        }
        for (const deletion of deletions) {
          const removed = await tx.executeRaw<{ id: number }>(
            `DELETE FROM timeline_entries
              WHERE id = $1
                AND (managed_by IS NULL OR managed_by = $2)
              RETURNING id`,
            [deletion.id, PAGE_TIMELINE_MANAGED_BY],
          );
          deletionsApplied += removed.length;
        }
      });
    }
  }

  const adoptionsProposed = pageReports.reduce((n, page) => n + page.adoptions.length, 0);
  const deletionsProposed = pageReports.reduce((n, page) => n + page.proposed_deletions.length, 0);
  return {
    mode: 'content',
    dry_run: !apply,
    pages_scanned: refs.length,
    rows_scanned: rowsScanned,
    adoptions_proposed: adoptionsProposed,
    deletions_proposed: deletionsProposed,
    adoptions_applied: adoptionsApplied,
    deletions_applied: deletionsApplied,
    pages: pageReports,
  };
}

export function formatTimelineContentRepairHuman(report: TimelineContentRepairReport): string {
  const lines = [`Timeline content repair ${report.dry_run ? '(DRY RUN)' : '(APPLIED)'}`];
  for (const page of report.pages) {
    lines.push(`${page.source_id}:${page.slug}`);
    for (const adoption of page.adoptions) {
      lines.push(`  adopt #${adoption.id} ${adoption.date} | ${adoption.summary} [${adoption.match}]`);
    }
    for (const deletion of page.proposed_deletions) {
      lines.push(`  delete #${deletion.id} ${deletion.date} | ${deletion.summary} [${deletion.reason}]`);
    }
  }
  lines.push(
    `Summary: ${report.pages_scanned} page(s), ${report.rows_scanned} row(s), ` +
    `${report.adoptions_proposed} adoption(s), ${report.deletions_proposed} proposed deletion(s).`,
  );
  if (report.dry_run) lines.push('No changes applied. Re-run with --apply to adopt/delete the proposed rows.');
  else lines.push(`Applied ${report.adoptions_applied} adoption(s) and ${report.deletions_applied} deletion(s).`);
  return lines.join('\n');
}
