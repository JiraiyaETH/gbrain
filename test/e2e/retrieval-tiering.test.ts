/**
 * Retrieval tiering E2E
 *
 * Pins the default Brain contract after literal default promotion:
 * owner-shaped compiled truth wins normal retrieval, evidence/source folders
 * are preserved but not first-rank, and quarantine paths stay out.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

const QUERY = 'canonical caldera retrieval';

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.putPage('companies/acme-caldera', {
    type: 'company',
    title: 'Acme Caldera',
    compiled_truth: 'Acme Caldera is the canonical caldera retrieval owner page.',
    timeline: '',
  });
  await engine.upsertChunks('companies/acme-caldera', [
    {
      chunk_index: 0,
      chunk_text: 'canonical caldera retrieval owner page canonical caldera retrieval',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(11),
      token_count: 12,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('meetings/acme-caldera-2026-05-25', {
    type: 'meeting',
    title: 'Acme Caldera meeting',
    compiled_truth: '',
    timeline: 'canonical caldera retrieval came up in meeting context.',
  });
  await engine.upsertChunks('meetings/acme-caldera-2026-05-25', [
    {
      chunk_index: 0,
      chunk_text: 'canonical caldera retrieval meeting context canonical caldera retrieval',
      chunk_source: 'timeline',
      embedding: basisEmbedding(11),
      token_count: 12,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('sources/google-docs/acme-caldera-packet', {
    type: 'source',
    title: 'Acme Caldera raw packet',
    compiled_truth:
      'canonical caldera retrieval raw packet canonical caldera retrieval raw packet canonical caldera retrieval raw packet',
    timeline: '',
  });
  await engine.upsertChunks('sources/google-docs/acme-caldera-packet', [
    {
      chunk_index: 0,
      chunk_text:
        'canonical caldera retrieval raw packet canonical caldera retrieval raw packet canonical caldera retrieval raw packet',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(11),
      token_count: 18,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('_quarantine/acme-caldera-broken-import', {
    type: 'note',
    title: 'Broken Acme Caldera import',
    compiled_truth:
      'canonical caldera retrieval quarantined canonical caldera retrieval quarantined canonical caldera retrieval',
    timeline: '',
  });
  await engine.upsertChunks('_quarantine/acme-caldera-broken-import', [
    {
      chunk_index: 0,
      chunk_text:
        'canonical caldera retrieval quarantined canonical caldera retrieval quarantined canonical caldera retrieval',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(11),
      token_count: 18,
    },
  ] satisfies ChunkInput[]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('keyword retrieval tiering', () => {
  test('normal page-grain retrieval returns owner truth and hides sources/quarantine', async () => {
    const results = await engine.searchKeyword(QUERY, { limit: 10 });
    const slugs = results.map(r => r.slug);

    expect(slugs[0]).toBe('companies/acme-caldera');
    expect(slugs).toContain('meetings/acme-caldera-2026-05-25');
    expect(slugs.some(s => s.startsWith('sources/'))).toBe(false);
    expect(slugs.some(s => s.startsWith('_quarantine/'))).toBe(false);
  });

  test('chunk-grain anchors obey the same default evidence boundary', async () => {
    const results = await engine.searchKeywordChunks(QUERY, { limit: 10 });
    const slugs = results.map(r => r.slug);

    expect(slugs.some(s => s.startsWith('sources/'))).toBe(false);
    expect(slugs.some(s => s.startsWith('_quarantine/'))).toBe(false);
  });

  test('vector retrieval applies the same default evidence boundary', async () => {
    const results = await engine.searchVector(basisEmbedding(11), { limit: 10 });
    const slugs = results.map(r => r.slug);

    expect(slugs[0]).toBe('companies/acme-caldera');
    expect(slugs).toContain('meetings/acme-caldera-2026-05-25');
    expect(slugs.some(s => s.startsWith('sources/'))).toBe(false);
    expect(slugs.some(s => s.startsWith('_quarantine/'))).toBe(false);
  });

  test('sources evidence is reachable only when explicitly opted in', async () => {
    const results = await engine.searchKeyword(QUERY, {
      limit: 10,
      include_slug_prefixes: ['sources/'],
    });
    const slugs = results.map(r => r.slug);

    expect(slugs).toContain('sources/google-docs/acme-caldera-packet');
    expect(slugs.some(s => s.startsWith('_quarantine/'))).toBe(false);
  });
});
