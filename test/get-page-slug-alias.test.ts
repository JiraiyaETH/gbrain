import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

delete process.env.GBRAIN_PGLITE_SNAPSHOT;

const getPage = operations.find((op) => op.name === 'get_page')!;
let engine: PGLiteEngine;

function context(sourceId = 'default'): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId,
  };
}

function federatedContext(sourceIds: string[]): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: { allowedSources: sourceIds } as any,
  };
}

async function seed(sourceId: string, slug: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note' as any,
    title,
    compiled_truth: `# ${title}`,
    timeline: '',
    frontmatter: {},
  }, { sourceId });
}

async function alias(sourceId: string, from: string, to: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
     VALUES ($1, $2, $3, 'test')`,
    [sourceId, from, to],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path)
     VALUES ('other', 'other', '/tmp/other') ON CONFLICT (id) DO NOTHING`,
  );
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('get_page slug aliases', () => {
  test('a soft-deleted old slug resolves to its active canonical page', async () => {
    await seed('default', 'notes/canonical-one', 'Canonical one');
    await seed('default', 'notes/retired-one', 'Retired one');
    await engine.softDeletePage('notes/retired-one', { sourceId: 'default' });
    await alias('default', 'notes/retired-one', 'notes/canonical-one');

    const page = await getPage.handler(context(), { slug: 'notes/retired-one' }) as any;
    expect(page.slug).toBe('notes/canonical-one');
    expect(page.title).toBe('Canonical one');
    expect(page.resolved_slug).toBe('notes/canonical-one');
  });

  test('include_deleted recovery reads return the retired row, not the redirect', async () => {
    const page = await getPage.handler(context(), {
      slug: 'notes/retired-one',
      include_deleted: true,
    }) as any;
    expect(page.slug).toBe('notes/retired-one');
    expect(page.title).toBe('Retired one');
    expect(page.deleted_at).toBeTruthy();
    expect(page.resolved_slug).toBeUndefined();
  });

  test('an active exact page wins over an alias row', async () => {
    await seed('default', 'notes/exact-wins', 'Exact wins');
    await seed('default', 'notes/other-canonical', 'Other canonical');
    await alias('default', 'notes/exact-wins', 'notes/other-canonical');

    const page = await getPage.handler(context(), { slug: 'notes/exact-wins' }) as any;
    expect(page.slug).toBe('notes/exact-wins');
    expect(page.title).toBe('Exact wins');
    expect(page.resolved_slug).toBeUndefined();
  });

  test('alias lookup stays within the caller source scope', async () => {
    await seed('other', 'notes/other-only', 'Other only');
    await alias('other', 'notes/scoped-alias', 'notes/other-only');

    await expect(getPage.handler(context('default'), {
      slug: 'notes/scoped-alias',
    })).rejects.toBeInstanceOf(OperationError);

    const page = await getPage.handler(context('other'), {
      slug: 'notes/scoped-alias',
    }) as any;
    expect(page.slug).toBe('notes/other-only');
    expect(page.resolved_slug).toBe('notes/other-only');
  });

  test('a dangling alias fails closed instead of returning a phantom page', async () => {
    await alias('default', 'notes/dangling-old', 'notes/missing-canonical');
    await expect(getPage.handler(context(), {
      slug: 'notes/dangling-old',
    })).rejects.toBeInstanceOf(OperationError);
  });

  test('federated alias resolution reads the canonical from the alias source', async () => {
    await seed('default', 'notes/shared-canonical', 'Default collision');
    await seed('other', 'notes/shared-canonical', 'Other canonical');
    await alias('other', 'notes/other-alias-only', 'notes/shared-canonical');

    const page = await getPage.handler(
      federatedContext(['default', 'other']),
      { slug: 'notes/other-alias-only' },
    ) as any;
    expect(page.slug).toBe('notes/shared-canonical');
    expect(page.title).toBe('Other canonical');
    expect(page.source_id).toBe('other');
    expect(page.resolved_slug).toBe('notes/shared-canonical');
  });
});
