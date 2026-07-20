import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_TIMELINE_MANAGED_BY } from '../src/core/timeline-reconcile.ts';
import { extractTimelineForSlugs, runExtract } from '../src/commands/extract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seed(slug = 'people/alice-example', compiledTruth = ''): Promise<void> {
  await engine.putPage(slug, {
    type: 'person', title: 'Alice Example', compiled_truth: compiledTruth, timeline: '', frontmatter: {},
  });
}

async function stored(slug = 'people/alice-example') {
  return engine.executeRaw<{
    id: string; date: string; source: string; summary: string; detail: string;
    managed_by: string | null; origin_key: string | null;
  }>(
    `SELECT te.id::text AS id, te.date::text AS date, te.source, te.summary,
            te.detail, te.managed_by, te.origin_key
       FROM timeline_entries te JOIN pages p ON p.id = te.page_id
      WHERE p.slug = $1 AND p.source_id = 'default'
      ORDER BY te.id`,
    [slug],
  );
}

describe('timeline page-parser reconciliation', () => {
  test('rewording deletes the old owned row and inserts the new row', async () => {
    await seed();
    const first = await engine.reconcileTimelineEntriesForPage('default', 'people/alice-example', PAGE_TIMELINE_MANAGED_BY, [
      { date: '2026-01-01', summary: 'Approved plan', detail: 'first' },
    ]);
    expect(first).toMatchObject({ created: 1, deleted: 0 });

    const second = await engine.reconcileTimelineEntriesForPage('default', 'people/alice-example', PAGE_TIMELINE_MANAGED_BY, [
      { date: '2026-01-01', summary: 'Approved revised plan', detail: 'second' },
    ]);
    expect(second).toMatchObject({ created: 1, deleted: 1 });
    expect(await stored()).toEqual([
      expect.objectContaining({ summary: 'Approved revised plan', detail: 'second', managed_by: PAGE_TIMELINE_MANAGED_BY }),
    ]);
  });

  test('removing all page timeline content deletes only owned rows', async () => {
    await seed();
    await engine.addTimelineEntry('people/alice-example', {
      date: '2026-01-02', source: 'manual', summary: 'Operator note', detail: 'keep',
    });
    await engine.reconcileTimelineEntriesForPage('default', 'people/alice-example', PAGE_TIMELINE_MANAGED_BY, [
      { date: '2026-01-01', summary: 'Parser note' },
    ]);

    const result = await engine.reconcileTimelineEntriesForPage(
      'default', 'people/alice-example', PAGE_TIMELINE_MANAGED_BY, [],
    );
    expect(result.deleted).toBe(1);
    expect(await stored()).toEqual([
      expect.objectContaining({ source: 'manual', summary: 'Operator note', managed_by: null, origin_key: null }),
    ]);
  });

  test('detail-only edits update the same row in place', async () => {
    await seed();
    await engine.reconcileTimelineEntriesForPage('default', 'people/alice-example', PAGE_TIMELINE_MANAGED_BY, [
      { date: '2026-01-01', source: 'Board', summary: 'Approved plan', detail: 'old detail' },
    ]);
    const before = await stored();

    const result = await engine.reconcileTimelineEntriesForPage('default', 'people/alice-example', PAGE_TIMELINE_MANAGED_BY, [
      { date: '2026-01-01', source: 'Board', summary: 'Approved plan', detail: 'new detail' },
    ]);
    const after = await stored();
    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].detail).toBe('new detail');
  });

  test('JSONB transport sanitizes free text without pre-stringifying payloads', async () => {
    await seed();
    const result = await engine.reconcileTimelineEntriesForPage(
      'default',
      'people/alice-example',
      PAGE_TIMELINE_MANAGED_BY,
      [{
        date: '2026-01-01',
        source: 'board\0notes',
        summary: 'Approved "plan" \u{1F680} \uD800',
        detail: 'detail\0with {json-like: true}',
      }],
    );
    expect(result.created).toBe(1);
    expect(await stored()).toEqual([
      expect.objectContaining({
        source: 'boardnotes',
        summary: 'Approved "plan" \u{1F680} \uFFFD',
        detail: 'detailwith {json-like: true}',
        managed_by: PAGE_TIMELINE_MANAGED_BY,
      }),
    ]);
  });

  test('filesystem, DB, and sync helper paths converge to one owned row', async () => {
    const slug = 'people/cross-path';
    const content = '## Timeline\n\n- **2026-01-01** | Board — Approved plan\n';
    await seed(slug, content);
    const dir = mkdtempSync(join(tmpdir(), 'timeline-cross-path-'));
    try {
      const path = join(dir, `${slug}.md`);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);

      await runExtract(engine, ['timeline', '--source', 'fs', '--dir', dir]);
      expect(await stored(slug)).toHaveLength(1);
      expect((await stored(slug))[0].summary).toBe('Approved plan');

      await runExtract(engine, ['timeline', '--source', 'db']);
      expect(await stored(slug)).toHaveLength(1);
      expect((await stored(slug))[0].summary).toBe('Board — Approved plan');

      await extractTimelineForSlugs(engine, dir, [slug], { sourceId: 'default' });
      const finalRows = await stored(slug);
      expect(finalRows).toHaveLength(1);
      expect(finalRows[0]).toMatchObject({ summary: 'Approved plan', source: 'Board', managed_by: PAGE_TIMELINE_MANAGED_BY });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
