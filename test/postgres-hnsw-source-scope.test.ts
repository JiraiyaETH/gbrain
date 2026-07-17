import { describe, expect, test } from 'bun:test';

import { PostgresEngine } from '../src/core/postgres-engine.ts';

type Call = { kind: 'tag' | 'unsafe'; sql: string };

function fakeSql(extensionVersion: string | null | Error) {
  const calls: Call[] = [];
  const tag: any = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ kind: 'tag', sql });
    if (sql.includes("FROM pg_extension WHERE extname = 'vector'")) {
      if (extensionVersion instanceof Error) throw extensionVersion;
      return extensionVersion === null ? [] : [{ extversion: extensionVersion }];
    }
    return [];
  };
  tag.unsafe = async (sql: string) => {
    calls.push({ kind: 'unsafe', sql: sql.replace(/\s+/g, ' ').trim() });
    return [];
  };
  tag.begin = async (fn: (tx: any) => Promise<unknown>) => fn(tag);
  return { tag, calls };
}

function engineWithSql(tag: any): PostgresEngine {
  const engine = new PostgresEngine();
  (engine as any)._sql = tag;
  (engine as any)._connectionStyle = 'instance';
  return engine;
}

describe('Postgres source-scoped HNSW completeness guard', () => {
  test('pgvector 0.8+ raises recall knobs inside the same search transaction', async () => {
    const { tag, calls } = fakeSql('0.8.0');
    const engine = engineWithSql(tag);

    await engine.searchVector(new Float32Array([0.1, 0.2]), {
      limit: 10,
      sourceId: 'default',
    });

    const statements = calls.map(call => call.sql);
    expect(statements.filter(sql => sql.includes("FROM pg_extension WHERE extname = 'vector'"))).toHaveLength(1);
    expect(statements).toContain("SET LOCAL hnsw.ef_search = 1000");
    expect(statements).toContain("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(statements).toContain("SET LOCAL hnsw.max_scan_tuples = 100000");
    expect(statements.findIndex(sql => sql.includes('hnsw.ef_search')))
      .toBeLessThan(statements.findIndex(sql => sql.startsWith('WITH hnsw_candidates')));
  });

  test('capability probe is cached per engine', async () => {
    const { tag, calls } = fakeSql('0.8.1');
    const engine = engineWithSql(tag);

    await engine.searchVector(new Float32Array([0.1, 0.2]), { sourceId: 'default' });
    await engine.searchVector(new Float32Array([0.1, 0.2]), { sourceId: 'default' });

    expect(calls.filter(call => call.sql.includes("FROM pg_extension WHERE extname = 'vector'"))).toHaveLength(1);
  });

  test('older/restricted pgvector remains compatible without unknown GUCs', async () => {
    for (const capability of ['0.7.4', null, new Error('extension lookup denied')]) {
      const { tag, calls } = fakeSql(capability);
      const engine = engineWithSql(tag);

      await engine.searchVector(new Float32Array([0.1, 0.2]), { sourceId: 'default' });

      expect(calls.some(call => call.sql.includes('SET LOCAL hnsw.'))).toBe(false);
      expect(calls.some(call => call.kind === 'unsafe' && call.sql.startsWith('WITH hnsw_candidates'))).toBe(true);
    }
  });

  test('unscoped search keeps the low-cost default HNSW path', async () => {
    const { tag, calls } = fakeSql('0.8.0');
    const engine = engineWithSql(tag);

    await engine.searchVector(new Float32Array([0.1, 0.2]), { limit: 10 });

    expect(calls.some(call => call.sql.includes("FROM pg_extension WHERE extname = 'vector'"))).toBe(false);
    expect(calls.some(call => call.sql.includes('SET LOCAL hnsw.'))).toBe(false);
  });
});
