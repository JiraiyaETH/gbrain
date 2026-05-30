import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const basePage: PageInput = {
  type: 'project',
  title: 'Old Dojo',
  compiled_truth: 'Old Dojo canonical body.',
  timeline: '',
  frontmatter: {},
};

describe('page rename + slug alias layer', () => {
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

  test('atomically renames the canonical slug, creates an old-slug alias, and preserves page-owned records', async () => {
    const oldSlug = 'projects/ai-engineering-dojo';
    const newSlug = 'projects/operator-dojo';

    const created = await engine.putPage(oldSlug, basePage);
    await engine.upsertChunks(oldSlug, [
      { chunk_index: 0, chunk_text: 'Old Dojo canonical body.', chunk_source: 'compiled_truth' },
    ]);
    await engine.addTag(oldSlug, 'dojo');
    await engine.addTimelineEntry(oldSlug, { date: '2026-05-30', summary: 'Old name approved' });
    await engine.putRawData(oldSlug, 'telegram', { thread: 'learning' });
    const version = await engine.createVersion(oldSlug);

    await engine.putPage('projects/referrer', {
      type: 'project',
      title: 'Referrer',
      compiled_truth: 'See [[projects/ai-engineering-dojo]] and [old dojo](projects/ai-engineering-dojo.md).',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('projects/referrer', [
      {
        chunk_index: 0,
        chunk_text: 'See [[projects/ai-engineering-dojo]] and [old dojo](projects/ai-engineering-dojo.md).',
        chunk_source: 'compiled_truth',
      },
    ]);
    await engine.addLink('projects/referrer', oldSlug, 'mentions', 'manual');

    const result = await engine.renamePage(oldSlug, newSlug, {
      createAlias: true,
      rewriteReferences: true,
    });

    expect(result).toMatchObject({
      status: 'renamed',
      old_slug: oldSlug,
      new_slug: newSlug,
      source_id: 'default',
      alias_created: true,
    });

    const canonical = await engine.getPage(newSlug);
    expect(canonical).not.toBeNull();
    expect(canonical!.id).toBe(created.id);
    expect(canonical!.title).toBe('Old Dojo');

    const viaAlias = await engine.getPage(oldSlug);
    expect(viaAlias).not.toBeNull();
    expect(viaAlias!.slug).toBe(newSlug);
    expect(viaAlias!.id).toBe(created.id);

    const listedSlugs = (await engine.listPages({ limit: 10 })).map(p => p.slug);
    expect(listedSlugs).toContain(newSlug);
    expect(listedSlugs).not.toContain(oldSlug);
    expect(await engine.resolveSlugs(oldSlug)).toEqual([newSlug]);

    expect(await engine.getTags(newSlug)).toEqual(['dojo']);
    expect((await engine.getTimeline(newSlug)).map(e => e.summary)).toEqual(['Old name approved']);
    expect((await engine.getRawData(newSlug, 'telegram'))[0].data).toEqual({ thread: 'learning' });
    expect((await engine.getVersions(newSlug)).map(v => v.id)).toContain(version.id);

    // Old-slug alias reads should remain useful beyond getPage/resolveSlugs.
    expect(await engine.getTags(oldSlug)).toEqual(['dojo']);
    expect((await engine.getTimeline(oldSlug)).map(e => e.summary)).toEqual(['Old name approved']);
    expect((await engine.getRawData(oldSlug, 'telegram'))[0].data).toEqual({ thread: 'learning' });
    expect((await engine.getVersions(oldSlug)).map(v => v.id)).toContain(version.id);
    expect((await engine.getChunks(oldSlug)).map(c => c.chunk_text)).toEqual(['Old Dojo canonical body.']);
    expect((await engine.getChunksWithEmbeddings(oldSlug)).map(c => c.chunk_text)).toEqual(['Old Dojo canonical body.']);

    const backlinks = await engine.getBacklinks(newSlug);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].from_slug).toBe('projects/referrer');
    expect(await engine.getBacklinks(oldSlug)).toHaveLength(1);

    const referrer = await engine.getPage('projects/referrer');
    expect(referrer!.compiled_truth).toContain('[[projects/operator-dojo]]');
    expect(referrer!.compiled_truth).toContain('(projects/operator-dojo.md)');
    expect(referrer!.compiled_truth).not.toContain('projects/ai-engineering-dojo');

    const referrerChunks = await engine.getChunks('projects/referrer');
    expect(referrerChunks[0].chunk_text).toContain('projects/operator-dojo');
    expect(referrerChunks[0].chunk_text).not.toContain('projects/ai-engineering-dojo');
  });

  test('keeps old-slug alias reads source-scoped when another source reuses the old canonical slug', async () => {
    const oldSlug = 'projects/source-scoped-dojo';
    const newSlug = 'projects/source-scoped-operator-dojo';

    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('alt', 'alt', '{}'::jsonb) ON CONFLICT DO NOTHING`);
    await engine.putPage(oldSlug, { ...basePage, title: 'Default Source Dojo' });
    await engine.upsertChunks(oldSlug, [
      { chunk_index: 0, chunk_text: 'Default source chunk.', chunk_source: 'compiled_truth' },
    ]);
    await engine.addTag(oldSlug, 'default-tag');
    await engine.addTimelineEntry(oldSlug, { date: '2026-05-30', summary: 'Default event' });
    await engine.putRawData(oldSlug, 'telegram', { source: 'default' });
    const defaultVersion = await engine.createVersion(oldSlug);

    await engine.renamePage(oldSlug, newSlug, { sourceId: 'default', createAlias: true });

    await engine.putPage(oldSlug, { ...basePage, title: 'Alt Source Dojo' }, { sourceId: 'alt' });
    await engine.upsertChunks(oldSlug, [
      { chunk_index: 0, chunk_text: 'Alt source chunk.', chunk_source: 'compiled_truth' },
    ], { sourceId: 'alt' });
    await engine.addTag(oldSlug, 'alt-tag', { sourceId: 'alt' });
    await engine.addTimelineEntry(oldSlug, { date: '2026-05-31', summary: 'Alt event' }, { sourceId: 'alt' });
    await engine.putRawData(oldSlug, 'telegram', { source: 'alt' }, { sourceId: 'alt' });
    const altVersion = await engine.createVersion(oldSlug, { sourceId: 'alt' });

    await withEnv({ GBRAIN_SOURCE: 'default' }, async () => {
      expect((await engine.getPage(oldSlug, { sourceId: 'default' }))!.slug).toBe(newSlug);
      expect(await engine.getTags(oldSlug, { sourceId: 'default' })).toEqual(['default-tag']);
      expect((await engine.getTimeline(oldSlug, { sourceId: 'default' })).map(e => e.summary)).toEqual(['Default event']);
      expect((await engine.getRawData(oldSlug, 'telegram', { sourceId: 'default' }))[0].data).toEqual({ source: 'default' });
      const versionIds = (await engine.getVersions(oldSlug, { sourceId: 'default' })).map(v => v.id);
      expect(versionIds).toContain(defaultVersion.id);
      expect(versionIds).not.toContain(altVersion.id);
      expect((await engine.getChunksWithEmbeddings(oldSlug, { sourceId: 'default' })).map(c => c.chunk_text)).toEqual(['Default source chunk.']);
    });

    expect((await engine.getPage(oldSlug, { sourceId: 'alt' }))!.title).toBe('Alt Source Dojo');
    expect(await engine.getTags(oldSlug, { sourceId: 'alt' })).toEqual(['alt-tag']);
  });

  test('rejects target collisions without partially moving the old page', async () => {
    await engine.putPage('projects/dojo', { ...basePage, title: 'Default Dojo' });
    await engine.putPage('projects/existing', { ...basePage, title: 'Existing Target' });

    await expect(engine.renamePage('projects/dojo', 'projects/existing', { createAlias: true }))
      .rejects.toThrow(/already exists|collision|duplicate/i);
    expect((await engine.getPage('projects/dojo'))!.title).toBe('Default Dojo');
    expect(await engine.getPage('projects/existing')).not.toBeNull();
  });
});

describe('rename_page operation surface', () => {
  test('is exposed as a mutating write operation with CLI and MCP-safe params', async () => {
    const op = operations.find(o => o.name === 'rename_page');
    expect(op).toBeDefined();
    expect(op!.mutating).toBe(true);
    expect(op!.scope).toBe('write');
    expect(op!.params.old_slug.required).toBe(true);
    expect(op!.params.new_slug.required).toBe(true);
    expect(op!.cliHints).toEqual({ name: 'rename', positional: ['old_slug', 'new_slug'] });

    const ctx: OperationContext = {
      engine: {} as BrainEngine,
      config: { engine: 'pglite' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: true,
      remote: false,
      sourceId: 'default',
    };
    await expect(op!.handler(ctx, { old_slug: 'old/slug', new_slug: 'new/slug' }))
      .resolves.toMatchObject({ dry_run: true, action: 'rename_page', old_slug: 'old/slug', new_slug: 'new/slug' });
  });
});
