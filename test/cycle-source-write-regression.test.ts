import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testing as synthTesting } from '../src/core/cycle/synthesize.ts';
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
  return {
    getPage: async (slug: string, opts?: { sourceId?: string }) => {
      if (opts?.sourceId !== 'robotics' && opts?.sourceId !== 'default') return null;
      return {
        id: 1,
        slug,
        source_id: opts.sourceId,
        type: 'note',
        title: opts.sourceId === 'robotics' ? 'Robotics Reflection' : 'Default Reflection',
        compiled_truth: `${opts.sourceId} body`,
        timeline: '',
        frontmatter: {},
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
    getTags: async () => ['dream-cycle'],
  } as unknown as BrainEngine;
}

describe('cycle source-aware dream writes', () => {
  test('dream phases thread non-default source_id into child job payloads', () => {
    expect(synthesizeSrc).toContain("source_id: opts.sourceId");
    expect(patternsSrc).toContain("source_id: opts.sourceId");
    expect(synthesizeSrc).toContain("const cycleSourceId = opts.sourceId ?? 'default'");
    expect(synthesizeSrc).toContain('collectChildPutPageSlugs(engine, childIds, chunkInfo, cycleSourceId)');
    expect(patternsSrc).toContain("collectChildPutPageSlugs(engine, [job.id], opts.sourceId ?? 'default')");
  });

  test('synthesize child refs default to default source when sourceId is omitted', async () => {
    const refs = await synthTesting.collectChildPutPageSlugs(
      fakeCollectEngine(),
      [101],
      new Map(),
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

  test('patterns child refs default to default and carry an explicit cycle sourceId', async () => {
    const engine = fakeCollectEngine();

    const defaultRefs = await patternsTesting.collectChildPutPageSlugs(engine, [101]);
    const scopedRefs = await patternsTesting.collectChildPutPageSlugs(engine, [101], 'robotics');

    expect(defaultRefs).toEqual([
      { slug: 'wiki/personal/reflections/2026-07-08-robotics-a1b2c3', source_id: 'default' },
    ]);
    expect(scopedRefs).toEqual([
      { slug: 'wiki/personal/reflections/2026-07-08-robotics-a1b2c3', source_id: 'robotics' },
    ]);
  });

  test('synthesize reverseWriteRefs writes non-default sources under brainDir/.sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cycle-source-synth-'));
    try {
      const count = await synthTesting.reverseWriteRefs(fakeReverseWriteEngine(), dir, [
        { slug: 'wiki/personal/reflections/source-test', source_id: 'robotics' },
      ]);

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
      ]);

      const defaultPath = join(dir, 'wiki/personal/patterns/source-test.md');
      expect(count).toBe(1);
      expect(existsSync(defaultPath)).toBe(true);
      expect(readFileSync(defaultPath, 'utf8')).toContain('default body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
