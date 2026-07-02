import { afterEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  ALLOWED_PAGE_TYPES,
  extractTakesFromPages,
  parseTakesPageTypesConfig,
} from '../src/core/extract-takes-from-pages.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

interface CapturedSql {
  sql: string;
  params: unknown[];
}

function withCapturedStderr<T>(fn: () => T): { result: T; stderr: string } {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

function makeChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  };
}

function buildEngine(config: Record<string, string | null> = {}): { engine: BrainEngine; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  const engine = {
    kind: 'pglite',
    async getConfig(key: string): Promise<string | null> {
      return config[key] ?? null;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      return [];
    },
    async addTakesBatch(): Promise<number> {
      return 0;
    },
  } as unknown as BrainEngine;
  return { engine, captured };
}

async function runScanner(
  config: Record<string, string | null> = {},
  opts: { sourceIdFilter?: string } = {},
) {
  const { engine, captured } = buildEngine(config);
  __setChatTransportForTests(async () => makeChatResult('[]'));
  const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, ...opts });
  return { result, captured };
}

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('takes.page_types config', () => {
  test('default fallback equals the legacy constant', () => {
    expect(parseTakesPageTypesConfig(null)).toEqual([...ALLOWED_PAGE_TYPES]);
    expect(parseTakesPageTypesConfig('')).toEqual([...ALLOWED_PAGE_TYPES]);
    expect(parseTakesPageTypesConfig(' , , ')).toEqual([...ALLOWED_PAGE_TYPES]);
  });

  test('config override is trimmed, lowercased, and respected', () => {
    expect(parseTakesPageTypesConfig(' Concept, IDEA ,personal-reflection,atom_2 ')).toEqual([
      'concept',
      'idea',
      'personal-reflection',
      'atom_2',
    ]);
  });

  test('malformed entries are warned, ignored, and all-invalid config falls back intact', () => {
    const mixed = withCapturedStderr(() => parseTakesPageTypesConfig('idea, 9bad, bad type, personal'));
    expect(mixed.result).toEqual(['idea', 'personal']);
    expect(mixed.stderr).toContain('ignoring invalid takes.page_types entry "9bad"');
    expect(mixed.stderr).toContain('ignoring invalid takes.page_types entry "bad type"');

    const allInvalid = withCapturedStderr(() => parseTakesPageTypesConfig('9bad, bad type'));
    expect(allInvalid.result).toEqual([...ALLOWED_PAGE_TYPES]);
    expect(ALLOWED_PAGE_TYPES).toEqual(['concept', 'atom', 'lore', 'briefing', 'writing', 'originals']);
  });

  test('SQL receives the resolved list as a parameter', async () => {
    const { captured } = await runScanner({ 'takes.page_types': 'idea, personal' });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain('type = ANY($1::text[])');
    expect(captured[0]!.sql).not.toContain("'idea'");
    expect(captured[0]!.params[0]).toEqual(['idea', 'personal']);
    expect(captured[0]!.params[1]).toBe(50);
  });

  test('SQL receives the legacy list when config is absent', async () => {
    const { captured } = await runScanner();
    expect(captured[0]!.params[0]).toEqual([...ALLOWED_PAGE_TYPES]);
  });

  test('SQL keeps source filter parameterized after the resolved type list', async () => {
    const { captured } = await runScanner(
      { 'takes.page_types': 'idea, personal' },
      { sourceIdFilter: 'vault-a' },
    );
    expect(captured[0]!.sql).toContain('AND source_id = $2');
    expect(captured[0]!.sql).toContain('LIMIT $3');
    expect(captured[0]!.params).toEqual([['idea', 'personal'], 'vault-a', 50]);
  });
});
