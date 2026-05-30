import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveImportSourceId } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';

function makeStub(
  registeredSources: string[],
  paths: Array<{ id: string; local_path: string }>,
  defaultKey: string | null,
): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const target = params?.[0];
        return (registeredSources.includes(target as string)
          ? [{ id: target } as unknown as T]
          : []);
      }
      if (sql.includes('SELECT id, local_path FROM sources')) {
        return paths as unknown as T[];
      }
      return [];
    },
    getConfig: async (key: string) => (key === 'sources.default' ? defaultKey : null),
  } as unknown as BrainEngine;
}

describe('resolveImportSourceId', () => {
  test('infers the registered source from the import directory when unscoped', async () => {
    const engine = makeStub(
      ['default', 'jarvis-brain'],
      [{ id: 'jarvis-brain', local_path: '/repo/brain' }],
      null,
    );

    const id = await resolveImportSourceId(engine, ['/repo/brain/companies'], '/repo/brain/companies');
    expect(id).toBe('jarvis-brain');
  });

  test('explicit --source still wins over directory inference', async () => {
    const engine = makeStub(
      ['default', 'jarvis-brain', 'seksi'],
      [{ id: 'jarvis-brain', local_path: '/repo/brain' }],
      null,
    );

    const id = await resolveImportSourceId(
      engine,
      ['/repo/brain/companies', '--source', 'seksi'],
      '/repo/brain/companies',
    );
    expect(id).toBe('seksi');
  });

  test('GBRAIN_SOURCE still wins over directory inference', async () => {
    const engine = makeStub(
      ['default', 'jarvis-brain', 'env-wins'],
      [{ id: 'jarvis-brain', local_path: '/repo/brain' }],
      null,
    );

    await withEnv({ GBRAIN_SOURCE: 'env-wins' }, async () => {
      const id = await resolveImportSourceId(engine, ['/repo/brain/companies'], '/repo/brain/companies');
      expect(id).toBe('env-wins');
    });
  });
});
