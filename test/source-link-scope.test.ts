import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

async function addAltSource(engine: PGLiteEngine): Promise<void> {
  const db = (engine as any).db;
  await db.query(
    `INSERT INTO sources (id, name) VALUES ('alt', 'alt')
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function putPage(engine: PGLiteEngine, slug: string, sourceId: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'person',
    title,
    compiled_truth: `${title} in ${sourceId}.`,
    timeline: '',
    source_id: sourceId,
  });
}

describe('source-scoped link graph operations', () => {
  let engine: PGLiteEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await addAltSource(engine);
  }, 60_000);

  afterEach(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  test('getLinks and getBacklinks honor explicit source scope when slugs collide', async () => {
    await putPage(engine, 'people/alice', 'default', 'Default Alice');
    await putPage(engine, 'people/bob', 'default', 'Default Bob');
    await putPage(engine, 'people/alice', 'alt', 'Alt Alice');
    await putPage(engine, 'people/bob', 'alt', 'Alt Bob');

    await engine.addLink(
      'people/alice',
      'people/bob',
      'default edge',
      'knows',
      'markdown',
      undefined,
      undefined,
      'default',
      'default',
      'default',
    );
    await engine.addLink(
      'people/alice',
      'people/bob',
      'alt edge',
      'knows',
      'markdown',
      undefined,
      undefined,
      'alt',
      'alt',
      'alt',
    );

    const defaultOut = await engine.getLinks('people/alice', 'default');
    const altOut = await engine.getLinks('people/alice', 'alt');
    const defaultIn = await engine.getBacklinks('people/bob', 'default');
    const altIn = await engine.getBacklinks('people/bob', 'alt');

    expect(defaultOut.map(l => l.context)).toEqual(['default edge']);
    expect(altOut.map(l => l.context)).toEqual(['alt edge']);
    expect(defaultIn.map(l => l.context)).toEqual(['default edge']);
    expect(altIn.map(l => l.context)).toEqual(['alt edge']);
  });

  test('removeLink with source constraints removes only the selected source edge', async () => {
    await putPage(engine, 'people/alice', 'default', 'Default Alice');
    await putPage(engine, 'people/bob', 'default', 'Default Bob');
    await putPage(engine, 'people/alice', 'alt', 'Alt Alice');
    await putPage(engine, 'people/bob', 'alt', 'Alt Bob');

    await engine.addLink(
      'people/alice',
      'people/bob',
      'default edge',
      'knows',
      'frontmatter',
      undefined,
      undefined,
      'default',
      'default',
      'default',
    );
    await engine.addLink(
      'people/alice',
      'people/bob',
      'alt edge',
      'knows',
      'frontmatter',
      undefined,
      undefined,
      'alt',
      'alt',
      'alt',
    );

    await engine.removeLink('people/alice', 'people/bob', 'knows', 'frontmatter', 'default', 'default');

    expect(await engine.getLinks('people/alice', 'default')).toHaveLength(0);
    const altOut = await engine.getLinks('people/alice', 'alt');
    expect(altOut.map(l => l.context)).toEqual(['alt edge']);
  });

  test('addLink can create an intentional cross-source edge without fanning out', async () => {
    await putPage(engine, 'people/alice', 'default', 'Default Alice');
    await putPage(engine, 'people/bob', 'default', 'Default Bob');
    await putPage(engine, 'people/bob', 'alt', 'Alt Bob');

    await engine.addLink(
      'people/alice',
      'people/bob',
      'default alice to alt bob',
      'mentions',
      'markdown',
      undefined,
      undefined,
      'default',
      'alt',
      'default',
    );

    const defaultBobBacklinks = await engine.getBacklinks('people/bob', 'default');
    const altBobBacklinks = await engine.getBacklinks('people/bob', 'alt');

    expect(defaultBobBacklinks).toHaveLength(0);
    expect(altBobBacklinks.map(l => l.context)).toEqual(['default alice to alt bob']);
  });
});
