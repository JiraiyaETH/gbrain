/**
 * Relational recall arm integration tests (PGLite, default CI).
 *
 * End-to-end through buildRelationalArm: parse → resolve seed → fanout →
 * hydrate. Pins the lexically-unrecoverable win (the investor page never names
 * the company; only the invested_in edge connects them), the non-relational
 * no-op, attribution stamping, and fail-open.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { probeEmbeddingDim } from './fixtures/retrieval-quality/relational/corpus.ts';
import type { ChunkInput } from '../src/core/types.ts';

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  const dim = await probeEmbeddingDim(eng); // match schema column width (1280 ZE / 1536 OpenAI)

  await eng.putPage('companies/widget-co', { type: 'company', title: 'Widget Co', compiled_truth: 'A payments company.', timeline: '' });
  // The investor's body deliberately NEVER mentions Widget Co — only the edge connects them.
  await eng.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a seed-stage investor based in Lisbon.', timeline: '' });
  await eng.upsertChunks('people/alice-example', [{
    chunk_index: 0, chunk_text: 'Alice is a seed-stage investor based in Lisbon.',
    chunk_source: 'compiled_truth', embedding: new Float32Array(dim), token_count: 8,
  }] satisfies ChunkInput[]);
  await eng.addLink('people/alice-example', 'companies/widget-co', '', 'invested_in', 'manual');
}, 60_000);

afterAll(async () => { await eng.disconnect(); });

describe('buildRelationalArm', () => {
  test('surfaces the edge answer that lexical search would miss', async () => {
    const list = await buildRelationalArm(eng, 'who invested in widget-co');
    const alice = list.find(r => r.slug === 'people/alice-example');
    expect(alice).toBeDefined();
    expect(alice!.relational_via_link_types).toEqual(['invested_in']);
    expect(alice!.relational_hop).toBe(1);
    expect(alice!.relational_seed).toBe('companies/widget-co');
    // chunk-backed page → reinforces a REAL chunk id (not synthetic 0).
    expect(alice!.chunk_id).toBeGreaterThan(0);
  });

  test('non-relational query is a pure no-op', async () => {
    const meta: { fired?: boolean } = {};
    const list = await buildRelationalArm(eng, 'summary of the payments roadmap', { onMeta: m => { meta.fired = m.fired; } });
    expect(list).toEqual([]);
    expect(meta.fired).toBe(false);
  });

  test('unresolvable seed → no-op (never traverse from a guess)', async () => {
    const list = await buildRelationalArm(eng, 'who invested in nonexistent-phantom-xyz');
    expect(list).toEqual([]);
  });

  test('fail-open: fanout error returns [] + errored meta, never throws', async () => {
    const original = eng.relationalFanout.bind(eng);
    let captured: { errored?: boolean } = {};
    eng.relationalFanout = async () => { throw new Error('boom'); };
    try {
      const list = await buildRelationalArm(eng, 'who invested in widget-co', { onMeta: m => { captured = m; } });
      expect(list).toEqual([]);
      expect(captured.errored).toBe(true);
    } finally {
      eng.relationalFanout = original;
    }
  });

  test('intersection fans each endpoint to its full neighbor set before intersecting (regression)', async () => {
    // company-alpha has MORE creator_for neighbors than the caller's result
    // `limit`, and the ONLY creator it shares with company-beta sorts
    // alphabetically LAST. Pre-fix, each endpoint fanout was truncated to
    // `limit` BEFORE intersecting, so the shared creator fell outside
    // company-alpha's truncated head and the intersection came back empty.
    await eng.putPage('companies/acme-alpha', { type: 'company', title: 'Acme Alpha', compiled_truth: 'Alpha co.', timeline: '' });
    await eng.putPage('companies/beta-corp', { type: 'company', title: 'Beta Corp', compiled_truth: 'Beta co.', timeline: '' });
    const creators = ['c-anna', 'c-brad', 'c-cory', 'c-dana', 'c-evan', 'c-zoe-shared'];
    for (const slug of creators) {
      await eng.putPage(`people/${slug}`, { type: 'person', title: slug, compiled_truth: `${slug} is a creator.`, timeline: '' });
      await eng.addLink(`people/${slug}`, 'companies/acme-alpha', '', 'creator_for', 'manual');
    }
    // Only the alphabetically-last creator also worked with Beta Corp.
    await eng.addLink('people/c-zoe-shared', 'companies/beta-corp', '', 'creator_for', 'manual');

    // Small result limit: pre-fix this truncated company-alpha's fanout to 3
    // (dropping c-zoe-shared) BEFORE the intersection ran → empty result.
    const list = await buildRelationalArm(eng, 'what connects Acme Alpha and Beta Corp?', { limit: 3 });
    expect(list.map(r => r.slug)).toContain('people/c-zoe-shared');
  });

  test('resolves an unambiguous short title head and walks signed contract evidence', async () => {
    await eng.putPage('projects/tap-program', {
      type: 'project', title: 'TAP — Tailored Associate Program',
      compiled_truth: 'A creator associate program.', timeline: '',
    });
    await eng.putPage('contracts/tap/alice-example', {
      type: 'contract', title: 'Alice Example — TAP Associate',
      compiled_truth: 'A signed TAP agreement.', timeline: '',
    });
    // Lower-confidence colon-prefixed notes must not make the stronger,
    // unique em-dash display head ambiguous.
    await eng.putPage('notes/tap-example', {
      type: 'note', title: 'TAP: Supporting note',
      compiled_truth: 'A note about TAP.', timeline: '',
    });
    await eng.addLink('projects/tap-program', 'contracts/tap/alice-example', '', 'mentions', 'manual');
    await eng.addLink('people/alice-example', 'contracts/tap/alice-example', '', 'signed', 'manual');

    const list = await buildRelationalArm(eng, 'who signed the TAP contract', { depth: 2, limit: 20 });
    expect(list.map(row => row.slug)).toContain('people/alice-example');
    expect(list.map(row => row.slug)).toContain('contracts/tap/alice-example');
  });

  test('rejects two display heads tied at the strongest match tier', async () => {
    await eng.putPage('projects/amb-one', {
      type: 'project', title: 'AMB — One', compiled_truth: 'One.', timeline: '',
    });
    await eng.putPage('projects/amb-two', {
      type: 'project', title: 'AMB — Two', compiled_truth: 'Two.', timeline: '',
    });
    let seedsResolved = -1;
    const list = await buildRelationalArm(eng, 'who signed the AMB contract', {
      onMeta: meta => { seedsResolved = meta.seeds_resolved; },
    });
    expect(list).toEqual([]);
    expect(seedsResolved).toBe(0);
  });

  test('treats LIKE metacharacters in a seed literally', async () => {
    let seedsResolved = -1;
    const list = await buildRelationalArm(eng, 'who signed the T_P contract', {
      onMeta: meta => { seedsResolved = meta.seeds_resolved; },
    });
    expect(list).toEqual([]);
    expect(seedsResolved).toBe(0);
  });

  test('KOLs signed to a company traverse creator and signature edges', async () => {
    await eng.putPage('companies/silo-example', {
      type: 'company', title: 'Silo Example', compiled_truth: 'A protocol.', timeline: '',
    });
    await eng.putPage('people/silo-kol', {
      type: 'person', title: 'Silo KOL', compiled_truth: 'A creator.', timeline: '',
    });
    await eng.putPage('contracts/silo/silo-kol', {
      type: 'contract', title: 'Silo KOL Agreement', compiled_truth: 'Signed.', timeline: '',
    });
    await eng.addLink('people/silo-kol', 'companies/silo-example', '', 'creator_for', 'manual');
    await eng.addLink('people/silo-kol', 'contracts/silo/silo-kol', '', 'signed', 'manual');

    const list = await buildRelationalArm(eng, 'who are all the KOLs signed to Silo Example', { depth: 2, limit: 20 });
    expect(list.map(row => row.slug)).toContain('people/silo-kol');
    expect(list.map(row => row.slug)).toContain('contracts/silo/silo-kol');
  });
});
