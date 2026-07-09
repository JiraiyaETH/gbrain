import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

const putPage = operations.find(o => o.name === 'put_page');
if (!putPage) throw new Error('put_page op missing');

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

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: { engine: 'pglite' } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

function noEmbeddingEnv(): Record<string, string | undefined> {
  return {
    GBRAIN_HOME: emptyHome(),
    OPENAI_API_KEY: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    VOYAGE_API_KEY: undefined,
    AZURE_OPENAI_API_KEY: undefined,
  };
}

const EMPTY_BODY_MARKDOWN = `---
title: Empty Body
type: note
---
`;

describe('put_page empty-body overwrite guard', () => {
  test('rejects empty parsed body over an existing non-empty page for local and remote callers', async () => {
    for (const remote of [false, true]) {
      const slug = `personal/taste/content-ledger-${remote ? 'remote' : 'local'}`;
      await engine.putPage(slug, {
        type: 'note',
        title: 'Content Ledger',
        compiled_truth: 'Existing body must survive.',
        timeline: '',
        frontmatter: {},
      });

      await withEnv(noEmbeddingEnv(), async () => {
        const promise = putPage.handler(makeCtx({ remote }), {
          slug,
          content: EMPTY_BODY_MARKDOWN,
        });
        await expect(promise).rejects.toBeInstanceOf(OperationError);
        await expect(promise).rejects.toMatchObject({ code: 'invalid_params' });
        await expect(promise).rejects.toThrow(/allow_empty_overwrite: true/);
      });

      const page = await engine.getPage(slug);
      expect(page?.compiled_truth).toBe('Existing body must survive.');
    }
  });

  test('allows empty parsed body when allow_empty_overwrite is explicit', async () => {
    const slug = 'personal/taste/content-ledger-allowed';
    await engine.putPage(slug, {
      type: 'note',
      title: 'Content Ledger',
      compiled_truth: 'Body intentionally cleared by the next write.',
      timeline: '',
      frontmatter: {},
    });

    const result = await withEnv(noEmbeddingEnv(), async () => putPage.handler(makeCtx({ remote: true }), {
      slug,
      content: EMPTY_BODY_MARKDOWN,
      allow_empty_overwrite: true,
    })) as { status: string };

    expect(result.status).toBe('created_or_updated');
    const page = await engine.getPage(slug);
    expect(page?.compiled_truth).toBe('');
    expect(page?.title).toBe('Empty Body');
  });
});
