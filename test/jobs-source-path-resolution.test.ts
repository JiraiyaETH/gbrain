import { describe, test, expect } from 'bun:test';
import { resolveJobBrainDir } from '../src/commands/jobs.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeEngine(opts: {
  defaultPath?: string | null;
  sourcePaths?: Record<string, string | null>;
  legacyPath?: string | null;
} = {}): BrainEngine {
  const sourcePaths: Record<string, string | null> = { default: opts.defaultPath ?? null, ...(opts.sourcePaths ?? {}) };
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const id = params?.[0] as string;
        return (id in sourcePaths ? [{ id } as unknown as T] : []);
      }
      if (sql.includes('SELECT local_path FROM sources WHERE id = $1')) {
        const id = params?.[0] as string;
        if (id in sourcePaths) return [{ local_path: sourcePaths[id] } as unknown as T];
        return [];
      }
      if (sql.includes('SELECT id, local_path FROM sources')) {
        return Object.entries(sourcePaths)
          .filter(([_, local_path]) => local_path !== null)
          .map(([id, local_path]) => ({ id, local_path }) as unknown as T);
      }
      return [];
    },
    getConfig: async (key: string) => {
      if (key === 'sources.default') return 'default';
      if (key === 'sync.repo_path') return opts.legacyPath ?? null;
      return null;
    },
  } as unknown as BrainEngine;
}

describe('resolveJobBrainDir', () => {
  test('explicit repoPath wins when no source coherence check is requested', async () => {
    const engine = makeEngine({ defaultPath: '/brain/default', sourcePaths: { code: '/brain/code' } });
    await expect(resolveJobBrainDir(engine, { repoPath: '/explicit', source_id: 'code' }, 'unit-test'))
      .resolves.toBe('/explicit');
  });

  test('source_id resolves through the source local_path when repoPath is omitted', async () => {
    const engine = makeEngine({ defaultPath: '/brain/default', sourcePaths: { code: '/brain/code' }, legacyPath: '/stale/global' });
    await expect(resolveJobBrainDir(engine, { source_id: 'code' }, 'autopilot-cycle'))
      .resolves.toBe('/brain/code');
  });

  test('camelCase sourceId is accepted for sync-style job payloads', async () => {
    const engine = makeEngine({ defaultPath: '/brain/default', sourcePaths: { work: '/brain/work' } });
    await expect(resolveJobBrainDir(engine, { sourceId: 'work' }, 'sync'))
      .resolves.toBe('/brain/work');
  });

  test('falls back to the default source local_path, not process.cwd(), when no job path/source is provided', async () => {
    const engine = makeEngine({ defaultPath: '/brain/default', legacyPath: '/stale/global' });
    await expect(resolveJobBrainDir(engine, {}, 'extract'))
      .resolves.toBe('/brain/default');
  });

  test('throws a clear error instead of falling back to cwd when no source path exists', async () => {
    const engine = makeEngine({ defaultPath: null, legacyPath: null });
    await expect(resolveJobBrainDir(engine, {}, 'extract'))
      .rejects.toThrow(/extract: no brain repo path configured/);
  });

  test('can reject explicit repoPath/source_id mismatches for source-scoped cycle jobs', async () => {
    const engine = makeEngine({ defaultPath: '/brain/default', sourcePaths: { code: '/brain/code' } });
    await expect(
      resolveJobBrainDir(engine, { repoPath: '/wrong/root', source_id: 'code' }, 'autopilot-cycle', { requireSourcePathMatch: true }),
    ).rejects.toThrow(/repoPath .* does not match source code local_path/);
  });
});
