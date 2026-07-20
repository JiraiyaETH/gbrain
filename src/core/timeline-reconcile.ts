import { createHash } from 'crypto';
import type {
  BrainEngine,
  TimelineReconcileCandidate,
  TimelineReconcileResult,
} from './engine.ts';
import { sanitizeForJsonb } from './batch-rows.ts';
import { executeRawJsonb } from './sql-query.ts';

export const PAGE_TIMELINE_MANAGED_BY = 'page-parser';

/** Stable semantic normalization used only for page-parser row identity. */
export function normalizeTimelineSummary(summary: string): string {
  return summary.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

/**
 * Fixed-width origin key derived from the date + normalized summary. The hash
 * keeps the partial UNIQUE index safe even when an imported line is very long.
 */
export function timelineOriginKey(date: string, summary: string): string {
  const normalized = normalizeTimelineSummary(summary);
  const digest = createHash('sha256').update(`${date}\0${normalized}`).digest('hex');
  return `${date}:${digest}`;
}

interface ReconcileRow {
  date: string;
  source: string;
  summary: string;
  detail: string;
  origin_key: string;
}

function buildRows(candidates: TimelineReconcileCandidate[]): ReconcileRow[] {
  const byOrigin = new Map<string, ReconcileRow>();
  for (const candidate of candidates) {
    const summary = sanitizeForJsonb(candidate.summary);
    if (!summary.trim()) continue;
    const row: ReconcileRow = {
      date: candidate.date,
      source: sanitizeForJsonb(candidate.source ?? ''),
      summary,
      detail: sanitizeForJsonb(candidate.detail ?? ''),
      origin_key: timelineOriginKey(candidate.date, summary),
    };
    // A normalized line key is the identity. Last candidate wins so duplicate
    // parser emissions converge deterministically instead of violating the
    // managed-origin unique index.
    byOrigin.set(row.origin_key, row);
  }
  return [...byOrigin.values()];
}

/** Shared SQL implementation; both engines expose it through their interface method. */
export async function reconcileTimelineEntriesForPageImpl(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  managedBy: string,
  candidates: TimelineReconcileCandidate[],
): Promise<TimelineReconcileResult> {
  if (!managedBy.trim()) throw new Error('reconcileTimelineEntriesForPage: managedBy must be non-empty');
  const rows = buildRows(candidates);

  return engine.transaction(async (tx) => {
    // Serialize competing parser reconciles for the same page. Manual writers
    // retain their own unique-index protection and are never selected below.
    const pages = await tx.executeRaw<{ id: string }>(
      `SELECT id::text AS id
         FROM pages
        WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [sourceId, slug],
    );
    const pageId = pages[0]?.id;
    if (!pageId) {
      return { pageFound: false, created: 0, updated: 0, deleted: 0, candidates: rows.length };
    }

    // Delete stale owned rows first. This also removes an old tuple that could
    // otherwise collide with a current candidate on the legacy four-column
    // dedup index while its origin key has changed.
    const stale = await executeRawJsonb<{ id: string }>(
      tx,
      `WITH input AS (
         SELECT origin_key
           FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(origin_key text)
       )
       DELETE FROM timeline_entries te
        WHERE te.page_id = $1::integer
          AND te.managed_by = $2
          AND NOT EXISTS (SELECT 1 FROM input i WHERE i.origin_key = te.origin_key)
       RETURNING te.id::text AS id`,
      [pageId, managedBy],
      [{ rows }],
    );

    // If a protected/manual row already represents the exact target tuple,
    // discard only our redundant managed row. The protected row remains and
    // the subsequent INSERT safely no-ops on the four-column unique index.
    const redundant = await executeRawJsonb<{ id: string }>(
      tx,
      `WITH input AS (
         SELECT date, source, summary, origin_key
           FROM jsonb_to_recordset(($3::jsonb)->'rows')
             AS v(date text, source text, summary text, origin_key text)
       )
       DELETE FROM timeline_entries te
       USING input i
        WHERE te.page_id = $1::integer
          AND te.managed_by = $2
          AND te.origin_key = i.origin_key
          AND EXISTS (
            SELECT 1 FROM timeline_entries other
             WHERE other.page_id = te.page_id
               AND other.id <> te.id
               AND other.date = i.date::date
               AND other.source = i.source
               AND other.summary = i.summary
          )
       RETURNING te.id::text AS id`,
      [pageId, managedBy],
      [{ rows }],
    );

    const updated = await executeRawJsonb<{ id: string }>(
      tx,
      `WITH input AS (
         SELECT date, source, summary, detail, origin_key
           FROM jsonb_to_recordset(($3::jsonb)->'rows')
             AS v(date text, source text, summary text, detail text, origin_key text)
       )
       UPDATE timeline_entries te
          SET date = i.date::date,
              source = i.source,
              summary = i.summary,
              detail = i.detail
         FROM input i
        WHERE te.page_id = $1::integer
          AND te.managed_by = $2
          AND te.origin_key = i.origin_key
       RETURNING te.id::text AS id`,
      [pageId, managedBy],
      [{ rows }],
    );

    const inserted = await executeRawJsonb<{ id: string }>(
      tx,
      `WITH input AS (
         SELECT date, source, summary, detail, origin_key
           FROM jsonb_to_recordset(($3::jsonb)->'rows')
             AS v(date text, source text, summary text, detail text, origin_key text)
       )
       INSERT INTO timeline_entries
         (page_id, date, source, summary, detail, managed_by, origin_key)
       SELECT $1::integer, i.date::date, i.source, i.summary, i.detail, $2, i.origin_key
         FROM input i
        WHERE NOT EXISTS (
          SELECT 1 FROM timeline_entries te
           WHERE te.page_id = $1::integer
             AND te.managed_by = $2
             AND te.origin_key = i.origin_key
        )
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id`,
      [pageId, managedBy],
      [{ rows }],
    );

    return {
      pageFound: true,
      created: inserted.length,
      updated: updated.length,
      deleted: stale.length + redundant.length,
      candidates: rows.length,
    };
  });
}
