import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

// put_page pre-write corruption guard (Phase 1 item 2b). The guard rejects two
// explicit corruption classes at WRITE time (put_page's post-write lint is
// non-blocking): duplicate frontmatter blocks (dream-cycle double-frontmatter)
// and escaped-JSON bodies (MCP double-encode). It must NOT reject the
// historically-valid callers: body-only pages, horizontal rules, code fences,
// Timeline separators, or normal frontmatter.

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

const fence = '---';

async function put(slug: string, content: string, remote = false) {
  return withEnv(noEmbeddingEnv(), async () =>
    putPage!.handler(makeCtx({ remote }), { slug, content }),
  );
}

describe('put_page corruption guard — REJECTED classes', () => {
  test('rejects duplicate frontmatter blocks (local + remote)', async () => {
    const content =
      `${fence}\ntype: personal\ntitle: 'Align once'\ndream_generated: true\n${fence}\n\n` +
      `title: Align once\nrelevant_to:\n  - projects/x\n${fence}\n# Align once\n\nbody`;
    for (const remote of [false, true]) {
      const slug = `personal/reflections/dup-${remote ? 'r' : 'l'}`;
      const promise = put(slug, content, remote);
      await expect(promise).rejects.toBeInstanceOf(OperationError);
      await expect(promise).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(promise).rejects.toThrow(/frontmatter/i);
      expect(await engine.getPage(slug)).toBeNull();
    }
  });

  test('rejects escaped-JSON body — noncanonical fragment shape (MCP double-encode signature)', async () => {
    // A raw escaped fragment written verbatim into the body (easier, non-quoted form).
    const content =
      `${fence}\ntype: note\ntitle: Smoke\n${fence}\n\n` +
      '---\\ntype: note\\ntitle: GBrain MCP smoke\\n---\\n\\n# smoke\\n';
    for (const remote of [false, true]) {
      const slug = `notes/smoke-${remote ? 'r' : 'l'}`;
      const promise = put(slug, content, remote);
      await expect(promise).rejects.toBeInstanceOf(OperationError);
      await expect(promise).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(promise).rejects.toThrow(/JSON-stringified/);
      expect(await engine.getPage(slug)).toBeNull();
    }
  });

  test('rejects canonical JSON.stringify(markdown) body (double-encode corruption shape)', async () => {
    // The REAL corruption shape (P1-1, Codex QA): the entire content is
    // JSON.stringify() of a genuine markdown document — a single JSON string
    // scalar whose decoded value carries real `---\n` frontmatter. The leading
    // double-quote is what the old `/^\s*---\\n/` guard missed.
    const realMarkdownDoc =
      `${fence}\ntype: note\ntitle: GBrain MCP smoke\n${fence}\n\n# smoke\n\nbody text\n`;
    const content = JSON.stringify(realMarkdownDoc);
    for (const remote of [false, true]) {
      const slug = `notes/stringify-${remote ? 'r' : 'l'}`;
      const promise = put(slug, content, remote);
      await expect(promise).rejects.toBeInstanceOf(OperationError);
      await expect(promise).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(promise).rejects.toThrow(/JSON-stringified/);
      expect(await engine.getPage(slug)).toBeNull();
    }
  });
});

describe('put_page corruption guard — ALLOWED (historically valid) classes', () => {
  test('body-only page (no frontmatter) is accepted', async () => {
    const r = (await put('notes/body-only', '# A heading\n\nsome body text')) as { status: string };
    expect(r.status).toBe('created_or_updated');
    expect((await engine.getPage('notes/body-only'))?.compiled_truth).toContain('body text');
  });

  test('body with a real horizontal rule is accepted', async () => {
    const content = `${fence}\ntype: note\ntitle: hi\n${fence}\n\nbefore\n\n---\n\nafter`;
    const r = (await put('notes/hr', content)) as { status: string };
    expect(r.status).toBe('created_or_updated');
  });

  test('body with a fenced code block containing dashes is accepted', async () => {
    const content =
      `${fence}\ntype: note\ntitle: hi\n${fence}\n\n` +
      '```yaml\nfoo: bar\n```\n\nbody';
    const r = (await put('notes/codefence', content)) as { status: string };
    expect(r.status).toBe('created_or_updated');
  });

  test('page with a Timeline separator is accepted', async () => {
    const content =
      `${fence}\ntype: note\ntitle: hi\n${fence}\n\ncompiled truth\n\n` +
      `---\n## Timeline\n- **2026-01-01** | thing happened`;
    const r = (await put('notes/timeline', content)) as { status: string };
    expect(r.status).toBe('created_or_updated');
  });

  test('normal single-frontmatter page is accepted', async () => {
    const content = `${fence}\ntype: concept\ntitle: hi\n${fence}\n\nbody`;
    const r = (await put('concepts/normal', content)) as { status: string };
    expect(r.status).toBe('created_or_updated');
  });
});
