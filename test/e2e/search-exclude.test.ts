/**
 * Hard-Exclude E2E
 *
 * Verifies the new exclude_slug_prefixes / include_slug_prefixes plumbing.
 * test/, archive/, attachments/, .raw/, sources/, inbox/ are hard-excluded by default.
 * include_slug_prefixes opts back in.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.putPage('test/fixtures/widget', {
    type: 'note',
    title: 'Widget test fixture',
    compiled_truth: 'widget test fixture for the test suite',
    timeline: '',
  });
  await engine.upsertChunks('test/fixtures/widget', [
    {
      chunk_index: 0,
      chunk_text: 'widget test fixture for the test suite',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(11),
      token_count: 8,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('archive/old-stuff/widget-2020', {
    type: 'note',
    title: 'Widget 2020',
    compiled_truth: 'widget archived from 2020',
    timeline: '',
  });
  await engine.upsertChunks('archive/old-stuff/widget-2020', [
    {
      chunk_index: 0,
      chunk_text: 'widget archived from 2020 — stale info about widget',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(12),
      token_count: 8,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('concepts/widget-pattern', {
    type: 'concept',
    title: 'Widget Pattern',
    compiled_truth: 'the widget pattern is a useful design pattern',
    timeline: '',
  });
  await engine.upsertChunks('concepts/widget-pattern', [
    {
      chunk_index: 0,
      chunk_text: 'the widget pattern is a useful widget design pattern',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(13),
      token_count: 9,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('sources/books/raw-widget-book', {
    type: 'source',
    title: 'Raw Widget Book',
    compiled_truth: 'raw widget book packet should stay provenance only',
    timeline: '',
  });
  await engine.upsertChunks('sources/books/raw-widget-book', [
    {
      chunk_index: 0,
      chunk_text: 'raw widget book packet should stay provenance only',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(14),
      token_count: 8,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('inbox/raw-widget-intake', {
    type: 'note',
    title: 'Raw Widget Intake',
    compiled_truth: 'raw widget intake should stay review only until filed',
    timeline: '',
  });
  await engine.upsertChunks('inbox/raw-widget-intake', [
    {
      chunk_index: 0,
      chunk_text: 'raw widget intake should stay review only until filed',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(15),
      token_count: 9,
    },
  ] satisfies ChunkInput[]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('searchKeyword default hard-excludes', () => {
  test('test/ pages are hidden by default', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('test/fixtures/widget');
  });

  test('archive/ pages are hidden by default', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('archive/old-stuff/widget-2020');
  });

  test('sources/ raw provenance packets are hidden by default', async () => {
    const results = await engine.searchKeyword('raw widget book packet');
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('sources/books/raw-widget-book');
  });

  test('inbox/ triage pages are hidden by default', async () => {
    const results = await engine.searchKeyword('raw widget intake review filed');
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('inbox/raw-widget-intake');
  });

  test('curated content is unaffected', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('concepts/widget-pattern');
  });
});

describe('searchKeyword include_slug_prefixes opt-back-in', () => {
  test('include_slug_prefixes: ["test/"] surfaces test pages', async () => {
    const results = await engine.searchKeyword('widget', {
      include_slug_prefixes: ['test/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('test/fixtures/widget');
    // archive/ is still excluded.
    expect(slugs).not.toContain('archive/old-stuff/widget-2020');
  });

  test('include_slug_prefixes lets caller opt back into test/archive bulk prefixes', async () => {
    const results = await engine.searchKeyword('widget', {
      include_slug_prefixes: ['test/', 'archive/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('test/fixtures/widget');
    expect(slugs).toContain('archive/old-stuff/widget-2020');
  });

  test('include_slug_prefixes: ["sources/"] surfaces raw provenance packets for cited-source drilldown', async () => {
    const results = await engine.searchKeyword('raw widget book packet', {
      include_slug_prefixes: ['sources/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('sources/books/raw-widget-book');
  });

  test('include_slug_prefixes: ["inbox/"] surfaces triage pages for explicit review', async () => {
    const results = await engine.searchKeyword('raw widget intake review filed', {
      include_slug_prefixes: ['inbox/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('inbox/raw-widget-intake');
  });
});

describe('searchVector hard-excludes', () => {
  test('test/ pages are excluded by default in vector search', async () => {
    const results = await engine.searchVector(basisEmbedding(11));
    // basisEmbedding(11) is the closest direction to test/fixtures/widget,
    // so without exclude it would be at top. With default exclude, it's gone.
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('test/fixtures/widget');
  });

  test('include_slug_prefixes lets it back in', async () => {
    const results = await engine.searchVector(basisEmbedding(11), {
      include_slug_prefixes: ['test/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('test/fixtures/widget');
  });
});

describe('caller-supplied exclude_slug_prefixes (additive)', () => {
  test('caller can add a custom exclude prefix on top of defaults', async () => {
    const results = await engine.searchKeyword('widget', {
      exclude_slug_prefixes: ['concepts/'],
    });
    const slugs = results.map(r => r.slug);
    // concepts/ now also excluded; with all three categories filtered, no
    // hits remain.
    expect(slugs).not.toContain('concepts/widget-pattern');
    expect(slugs).not.toContain('test/fixtures/widget');
    expect(slugs).not.toContain('archive/old-stuff/widget-2020');
  });
});
