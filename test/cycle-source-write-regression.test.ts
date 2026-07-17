import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testing as synthTesting,
  synthesizeCompletionKey,
  synthesizeIdempotencyKey,
} from '../src/core/cycle/synthesize.ts';
import { __testing as patternsTesting } from '../src/core/cycle/patterns.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const synthesizeSrc = readFileSync(
  new URL('../src/core/cycle/synthesize.ts', import.meta.url),
  'utf8',
);
const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf8',
);

function fakeCollectEngine(): BrainEngine {
  return {
    executeRaw: async <T,>(sql: string): Promise<T[]> => {
      if (sql.includes('subagent_tool_executions')) {
        return [{ job_id: 101, slug: 'wiki/personal/reflections/2026-07-08-robotics-a1b2c3' }] as T[];
      }
      return [] as T[];
    },
  } as unknown as BrainEngine;
}

function fakeReverseWriteEngine(): BrainEngine {
  const frontmatter = new Map<string, Record<string, unknown>>();
  const engine = {
    getPage: async (slug: string, opts?: { sourceId?: string }) => {
      if (opts?.sourceId !== 'robotics' && opts?.sourceId !== 'default') return null;
      const key = `${opts.sourceId}\0${slug}`;
      return {
        id: 1,
        slug,
        source_id: opts.sourceId,
        type: 'note',
        title: opts.sourceId === 'robotics' ? 'Robotics Reflection' : 'Default Reflection',
        compiled_truth: `${opts.sourceId} body`,
        timeline: '',
        frontmatter: frontmatter.get(key) ?? {},
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
    getTags: async () => ['dream-cycle'],
    mergePageFrontmatter: async (
      slug: string,
      sourceId: string,
      patch: Record<string, unknown>,
    ) => {
      const key = `${sourceId}\0${slug}`;
      frontmatter.set(key, { ...(frontmatter.get(key) ?? {}), ...patch });
      return true;
    },
    transaction: async <T,>(fn: (tx: BrainEngine) => Promise<T>) => fn(engine as unknown as BrainEngine),
  };
  return engine as unknown as BrainEngine;
}

function fakeGatherEngine(calls: Array<{ sql: string; params: unknown[] }>): BrainEngine {
  return {
    executeRaw: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      return [] as T[];
    },
  } as unknown as BrainEngine;
}

describe('cycle source-aware dream writes', () => {
  test('synthesize cooldown and idempotency lineage is corpus-global', () => {
    expect(synthesizeCompletionKey()).toBe('dream.synthesize.last_completion_ts');
    expect(synthesizeIdempotencyKey('/corpus/a.txt', 'abc123'))
      .toBe('dream:synth:/corpus/a.txt:abc123');
    expect(synthesizeIdempotencyKey('/corpus/a.txt', 'abc123', { index: 1, total: 3 }))
      .toBe('dream:synth:/corpus/a.txt:abc123:c1of3');
  });

  test('dream phases thread source_id unconditionally into child job payloads', () => {
    expect(synthesizeSrc).toContain("source_id: opts.sourceId");
    expect(patternsSrc).toContain("source_id: opts.sourceId");
    expect(synthesizeSrc).toContain('const cycleSourceId = opts.sourceId');
    expect(synthesizeSrc).toContain('collectChildPutPageSlugs(engine, childIds, chunkInfo, cycleSourceId)');
    expect(patternsSrc).toContain('collectChildPutPageSlugs(engine, [job.id], opts.sourceId)');
  });

  test('synthesize child refs carry explicit default source without fallback', async () => {
    const refs = await synthTesting.collectChildPutPageSlugs(
      fakeCollectEngine(),
      [101],
      new Map(),
      'default',
    );

    expect(refs).toEqual([
      { slug: 'wiki/personal/reflections/2026-07-08-robotics-a1b2c3', source_id: 'default' },
    ]);
  });

  test('synthesize child refs carry the cycle sourceId when provided', async () => {
    const refs = await synthTesting.collectChildPutPageSlugs(
      fakeCollectEngine(),
      [101],
      new Map(),
      'robotics',
    );

    expect(refs).toEqual([
      { slug: 'wiki/personal/reflections/2026-07-08-robotics-a1b2c3', source_id: 'robotics' },
    ]);
  });

  test('patterns child refs carry explicit default and non-default source ids', async () => {
    const engine = fakeCollectEngine();

    const defaultRefs = await patternsTesting.collectChildPutPageSlugs(engine, [101], 'default');
    const scopedRefs = await patternsTesting.collectChildPutPageSlugs(engine, [101], 'robotics');

    expect(defaultRefs).toEqual([
      { slug: 'wiki/personal/reflections/2026-07-08-robotics-a1b2c3', source_id: 'default' },
    ]);
    expect(scopedRefs).toEqual([
      { slug: 'wiki/personal/reflections/2026-07-08-robotics-a1b2c3', source_id: 'robotics' },
    ]);
  });

  test('patterns gatherReflections filters by sourceId when the cycle is source-scoped', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const engine = fakeGatherEngine(calls);

    await patternsTesting.gatherReflections(engine, 30, 'personal/reflections/%', 'robotics');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('AND source_id = $3');
    expect(calls[0].params[2]).toBe('robotics');
  });

  test('patterns gatherReflections threads explicit default without an unscoped branch', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const engine = fakeGatherEngine(calls);

    await patternsTesting.gatherReflections(engine, 30, 'personal/reflections/%', 'default');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('source_id = $3');
    expect(calls[0].params[2]).toBe('default');
  });

  test('synthesize reverseWriteRefs writes non-default sources under brainDir/.sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-source-synth-'));
    try {
      const count = await synthTesting.reverseWriteRefs(fakeReverseWriteEngine(), dir, [
        { slug: 'wiki/personal/reflections/source-test', source_id: 'robotics' },
      ], '2026-07-15');

      const scopedPath = join(dir, '.sources', 'robotics', 'wiki/personal/reflections/source-test.md');
      const defaultPath = join(dir, 'wiki/personal/reflections/source-test.md');
      expect(count).toBe(1);
      expect(existsSync(scopedPath)).toBe(true);
      expect(existsSync(defaultPath)).toBe(false);
      expect(readFileSync(scopedPath, 'utf8')).toContain('robotics body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('patterns reverseWriteRefs preserves default-source root layout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-source-patterns-'));
    try {
      const count = await patternsTesting.reverseWriteRefs(fakeReverseWriteEngine(), dir, [
        { slug: 'wiki/personal/patterns/source-test', source_id: 'default' },
      ], '2026-07-15');

      const defaultPath = join(dir, 'wiki/personal/patterns/source-test.md');
      expect(count).toBe(1);
      expect(existsSync(defaultPath)).toBe(true);
      expect(readFileSync(defaultPath, 'utf8')).toContain('default body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('summary putPage and filesystem write use the explicit non-default source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-source-summary-'));
    const puts: Array<{ slug: string; opts: unknown }> = [];
    const tagCalls: Array<{ operation: string; opts: unknown }> = [];
    const tags: string[] = [];
    let storedCompiledTruth = '';
    const engine = {
      putPage: async (slug: string, input: unknown, opts: unknown) => {
        puts.push({ slug, opts });
        storedCompiledTruth = (input as { compiled_truth: string }).compiled_truth;
      },
      getPage: async () => ({ compiled_truth: storedCompiledTruth, type: 'report' }),
      getTags: async (_slug: string, opts: unknown) => {
        tagCalls.push({ operation: 'get', opts });
        return [...tags];
      },
      addTag: async (_slug: string, tag: string, opts: unknown) => {
        tagCalls.push({ operation: 'add', opts });
        if (!tags.includes(tag)) tags.push(tag);
      },
      removeTag: async (_slug: string, tag: string, opts: unknown) => {
        tagCalls.push({ operation: 'remove', opts });
        const index = tags.indexOf(tag);
        if (index >= 0) tags.splice(index, 1);
      },
    } as unknown as BrainEngine;
    try {
      await synthTesting.writeSummaryPage(
        engine,
        dir,
        'dream-cycle-summaries/2026-07-15',
        '2026-07-15',
        ['wiki/personal/reflections/example'],
        [{ jobId: 1, status: 'completed' }],
        'robotics',
      );
      expect(puts).toEqual([{
        slug: 'dream-cycle-summaries/2026-07-15',
        opts: { sourceId: 'robotics' },
      }]);
      expect(tagCalls).toEqual([
        { operation: 'get', opts: { sourceId: 'robotics' } },
        { operation: 'add', opts: { sourceId: 'robotics' } },
        { operation: 'get', opts: { sourceId: 'robotics' } },
      ]);
      expect(existsSync(join(
        dir,
        '.sources/robotics/dream-cycle-summaries/2026-07-15.md',
      ))).toBe(true);
      expect(existsSync(join(dir, 'dream-cycle-summaries/2026-07-15.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('summary explicit default source preserves root layout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-default-summary-'));
    const puts: unknown[] = [];
    const tagCalls: Array<{ operation: string; opts: unknown }> = [];
    const tags: string[] = [];
    let storedCompiledTruth = '';
    const engine = {
      putPage: async (_slug: string, input: unknown, opts: unknown) => {
        puts.push(opts);
        storedCompiledTruth = (input as { compiled_truth: string }).compiled_truth;
      },
      getPage: async () => ({ compiled_truth: storedCompiledTruth, type: 'report' }),
      getTags: async (_slug: string, opts: unknown) => {
        tagCalls.push({ operation: 'get', opts });
        return [...tags];
      },
      addTag: async (_slug: string, tag: string, opts: unknown) => {
        tagCalls.push({ operation: 'add', opts });
        if (!tags.includes(tag)) tags.push(tag);
      },
      removeTag: async (_slug: string, tag: string, opts: unknown) => {
        tagCalls.push({ operation: 'remove', opts });
        const index = tags.indexOf(tag);
        if (index >= 0) tags.splice(index, 1);
      },
    } as unknown as BrainEngine;
    try {
      await synthTesting.writeSummaryPage(
        engine,
        dir,
        'dream-cycle-summaries/2026-07-15',
        '2026-07-15',
        [],
        [],
        'default',
      );
      expect(puts).toEqual([{ sourceId: 'default' }]);
      expect(tagCalls).toEqual([
        { operation: 'get', opts: { sourceId: 'default' } },
        { operation: 'add', opts: { sourceId: 'default' } },
        { operation: 'get', opts: { sourceId: 'default' } },
      ]);
      expect(existsSync(join(dir, 'dream-cycle-summaries/2026-07-15.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
