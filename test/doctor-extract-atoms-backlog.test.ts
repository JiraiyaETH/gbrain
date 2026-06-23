/**
 * issue #1678 — extract_atoms backlog count + doctor check.
 *
 * Pins:
 *  - countExtractAtomsBacklog counts eligible-but-unextracted pages (scoped +
 *    brain-wide) and excludes pages that already have an atom (NOT EXISTS).
 *  - computeExtractAtomsBacklogCheck WARNs with a `--drain` hint when the pack
 *    doesn't run the phase and the backlog is real; OK at 0.
 *
 * Real in-memory PGLite (canonical block, R3+R4). GBRAIN_HOME is pointed at an
 * empty tmpdir for the doctor-check cases so packDeclaresPhase resolves the
 * bundled base pack (which does NOT declare extract_atoms) deterministically,
 * independent of the developer's real ~/.gbrain config.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
import { computeExtractAtomsBacklogCheck } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'gbrain-xa-backlog-home-'));
const HOME_WITH_BASE_V2 = mkdtempSync(join(tmpdir(), 'gbrain-xa-backlog-home-base-'));
mkdirSync(HOME_WITH_BASE_V2, { recursive: true });
writeFileSync(
  join(HOME_WITH_BASE_V2, 'config.json'),
  JSON.stringify({ engine: 'pglite', schema_pack: 'gbrain-base-v2' }, null, 2),
);

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

const BODY = 'x'.repeat(600); // >= MIN_PAGE_CHARS_FOR_EXTRACTION (500)

async function seedArticle(slug: string) {
  return engine.putPage(slug, { type: 'article', title: slug, compiled_truth: BODY });
}

describe('countExtractAtomsBacklog (issue #1678)', () => {
  it('counts eligible pages with no atom (scoped + brain-wide)', async () => {
    await seedArticle('article-a');
    await seedArticle('article-b');
    await seedArticle('article-c');
    expect(await countExtractAtomsBacklog(engine)).toBe(3);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(3);
  });

  it('excludes a page that already has a matching atom (NOT EXISTS)', async () => {
    const p = await seedArticle('article-x');
    const h16 = (p.content_hash ?? '').slice(0, 16);
    expect(h16.length).toBe(16);
    await engine.putPage('atoms/a1', {
      type: 'atom',
      title: 'a1',
      compiled_truth: 'an extracted nugget',
      frontmatter: { source_hash: h16 },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  it('ignores short pages and dream-generated pages', async () => {
    await engine.putPage('article-short', { type: 'article', title: 's', compiled_truth: 'too short' });
    await engine.putPage('article-dream', {
      type: 'article', title: 'd', compiled_truth: BODY,
      frontmatter: { dream_generated: 'true' },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });
});

describe('computeExtractAtomsBacklogCheck (issue #1678)', () => {
  it('OK with no backlog', async () => {
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect((check.details as { backlog: number }).backlog).toBe(0);
  });

  it('WARNs with a --drain hint when the pack does not run the phase and backlog > 10', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`article-${i}`);
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('--drain');
    expect((check.details as { pack_declares_phase: boolean }).pack_declares_phase).toBe(false);
    expect((check.details as { known_approximation: string }).known_approximation).toContain('page backlog only');
  });

  it('honors DB schema_pack above home config when detecting extract_atoms phase', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`db-pack-article-${i}`);
    await engine.setConfig('schema_pack', 'gbrain-creator');
    const check = await withEnv({ GBRAIN_HOME: HOME_WITH_BASE_V2 }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('active pack runs extract_atoms');
    expect((check.details as { pack_declares_phase: boolean }).pack_declares_phase).toBe(true);
  });
});
