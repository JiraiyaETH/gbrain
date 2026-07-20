/**
 * #2038 — idx_timeline_dedup schema-drift self-heal.
 *
 * A brain that ran the pre-renumber v99 variant of the dedup migration is
 * stamped past v102 with the OLD 3-column index. `runMigrations` early-returns
 * (nothing pending) so a migration verify-hook can't fix it. The repair is
 * keyed off the index SHAPE and runs regardless. These tests simulate the
 * drifted states directly and pin: detection, rebuild, dedupe-before-rebuild
 * (only possible when the index was absent), and idempotency.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  checkTimelineDedupIndex,
  formatTimelineContentRepairHuman,
  repairTimelineContent,
  repairTimelineDedupIndex,
} from '../src/core/timeline-dedup-repair.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
let pageId: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'people/alice-example', `---\ntitle: Alice\ntype: note\n---\n\n# Alice\n`, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: 'people/alice-example.md',
  });
  const pid = await engine.executeRaw<{ id: string }>(
    `SELECT id::text AS id FROM pages WHERE slug = 'people/alice-example' AND source_id = 'default'`,
  );
  pageId = pid[0].id;
});

afterAll(async () => {
  await engine.disconnect();
});

/** Force the index back to the broken pre-v102 3-column shape. */
async function regressTo3Col() {
  await engine.executeRaw(`DELETE FROM timeline_entries`);
  await engine.executeRaw(`DROP INDEX IF EXISTS idx_timeline_dedup`);
  await engine.executeRaw(
    `CREATE UNIQUE INDEX idx_timeline_dedup ON timeline_entries(page_id, date, summary)`,
  );
}

/** The other drift shape: the index was dropped entirely, letting true
 * 4-tuple duplicates accumulate that would block a naive CREATE UNIQUE INDEX. */
async function regressToAbsentWithDupes() {
  await engine.executeRaw(`DELETE FROM timeline_entries`);
  await engine.executeRaw(`DROP INDEX IF EXISTS idx_timeline_dedup`);
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, summary, source, detail)
       VALUES ($1, '2026-04-03', 'met alice', 'meeting', ''),
              ($1, '2026-04-03', 'met alice', 'meeting', ''),
              ($1, '2026-04-03', 'met alice', 'cli:extract', '')`,
    [pageId],
  );
}

describe('#2038 idx_timeline_dedup drift repair', () => {
  test('detects the 3-column drift', async () => {
    await regressTo3Col();
    const status = await checkTimelineDedupIndex(engine);
    expect(status.tablePresent).toBe(true);
    expect(status.indexPresent).toBe(true);
    expect(status.columns).toEqual(['page_id', 'date', 'summary']);
    expect(status.needsRepair).toBe(true);
  });

  test('rebuilds the 3-column index to 4 columns (no dupes to collapse)', async () => {
    await regressTo3Col();
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, summary, source, detail)
         VALUES ($1, '2026-04-03', 'met alice', 'meeting', '')`,
      [pageId],
    );

    const res = await repairTimelineDedupIndex(engine);
    expect(res.repaired).toBe(true);
    expect(res.reason).toBe('rebuilt');
    expect(res.collapsedDuplicates).toBe(0);

    const after = await checkTimelineDedupIndex(engine);
    expect(after.columns).toEqual(['page_id', 'date', 'summary', 'source']);
    expect(after.needsRepair).toBe(false);
  });

  test('dedupes true 4-tuple duplicates before building the unique index', async () => {
    await regressToAbsentWithDupes(); // index absent + a real (meeting) dup

    const before = await checkTimelineDedupIndex(engine);
    expect(before.indexPresent).toBe(false);
    expect(before.needsRepair).toBe(true);

    const res = await repairTimelineDedupIndex(engine);
    expect(res.repaired).toBe(true);
    expect(res.collapsedDuplicates).toBe(1); // one of the two 'meeting' rows removed

    const after = await checkTimelineDedupIndex(engine);
    expect(after.columns).toEqual(['page_id', 'date', 'summary', 'source']);
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(2); // meeting (deduped) + cli:extract
  });

  test('idempotent — a second repair is a no-op', async () => {
    await regressTo3Col();
    await repairTimelineDedupIndex(engine);
    const second = await repairTimelineDedupIndex(engine);
    expect(second.repaired).toBe(false);
    expect(second.reason).toBe('already_correct');
  });
});

describe('content-aware timeline repair fixture corpus', () => {
  async function seedCorpus() {
    await repairTimelineDedupIndex(engine);
    await engine.executeRaw(`DELETE FROM timeline_entries`);
    await engine.putPage('people/alice-example', {
      type: 'note',
      title: 'Alice',
      compiled_truth: '## Timeline\n\n- **2026-04-03** | Board — Approved revised plan',
      timeline: '',
      frontmatter: {},
    });
    await engine.executeRaw(
      `INSERT INTO timeline_entries
         (page_id, date, source, summary, detail, created_at)
       VALUES
         ($1, '2026-04-03', '', 'Board — Approved revised plan', '', '2026-04-04T00:00:00Z'),
         ($1, '2026-04-03', 'Board', 'Approved revised plan', '', '2026-04-03T00:00:00Z'),
         ($1, '2026-04-03', 'Board', 'Approved plan', '', '2026-04-01T00:00:00Z'),
         ($1, '2026-04-03', '[[board-notes]] →', 'Approved revised plan', '', '2026-04-01T00:00:00Z'),
         ($1, '2026-04-03', '', 'Board approved plan manually', '', '2026-04-01T00:00:00Z'),
         ($1, '2026-04-03', 'extract-timeline-from-meetings:meetings/2026-04-03', 'Approved plan', '', '2026-04-01T00:00:00Z'),
         ($1, '2026-04-03', 'companies/acme-example', 'Referenced in enrichment', '', '2026-04-01T00:00:00Z')`,
      [pageId],
    );
  }

  test('dry-run reports per-page adoptions/deletions without changing rows', async () => {
    await seedCorpus();
    const report = await repairTimelineContent(engine);
    expect(report).toMatchObject({
      mode: 'content', dry_run: true, adoptions_proposed: 1, deletions_proposed: 2,
      adoptions_applied: 0, deletions_applied: 0,
    });
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0].proposed_deletions.map(d => d.reason).sort()).toEqual([
      'fragmented-source-signature', 'near-duplicate-superseded',
    ]);
    const rows = await engine.executeRaw<{ n: string; managed: string }>(
      `SELECT COUNT(*)::text AS n, COUNT(managed_by)::text AS managed FROM timeline_entries`,
    );
    expect(rows[0]).toEqual({ n: '7', managed: '0' });

    const human = formatTimelineContentRepairHuman(report);
    expect(human).toContain('Timeline content repair (DRY RUN)');
    expect(human).toContain('default:people/alice-example');
    expect(human).toContain('[near-duplicate-superseded]');
    expect(human).toContain('No changes applied. Re-run with --apply');
  });

  test('--apply adopts the current parser row, deletes only parser-looking stale rows, and preserves manual rows', async () => {
    await seedCorpus();
    const report = await repairTimelineContent(engine, { apply: true });
    expect(report).toMatchObject({
      dry_run: false, adoptions_applied: 1, deletions_applied: 2,
    });
    const rows = await engine.executeRaw<{
      source: string; summary: string; managed_by: string | null; origin_key: string | null;
    }>(
      `SELECT source, summary, managed_by, origin_key
         FROM timeline_entries ORDER BY id`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.find(r => r.source === 'Board' && r.summary === 'Approved revised plan')).toMatchObject({
      managed_by: 'page-parser',
    });
    expect(rows.find(r => r.source === 'Board' && r.summary === 'Approved revised plan')?.origin_key).toBeTruthy();
    expect(rows).toContainEqual(expect.objectContaining({
      source: '', summary: 'Board — Approved revised plan', managed_by: null, origin_key: null,
    }));
    expect(rows).toContainEqual(expect.objectContaining({ source: '', summary: 'Board approved plan manually', managed_by: null }));
    expect(rows).toContainEqual(expect.objectContaining({ source: 'extract-timeline-from-meetings:meetings/2026-04-03', managed_by: null }));
    expect(rows).toContainEqual(expect.objectContaining({ source: 'companies/acme-example', managed_by: null }));
  });
});
