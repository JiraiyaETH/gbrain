import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isMcpExplicitSourceRequired, parseMcpAllowedSourceIds } from '../src/mcp/read-only.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

describe('MCP source allow-list env parsing', () => {
  test('parses comma-separated source ids and explicit-source requirement', () => {
    expect(parseMcpAllowedSourceIds({
      GBRAIN_MCP_ALLOWED_SOURCE_IDS: 'agent-fork-code, runtime-code, agent-fork-code',
    })).toEqual(new Set(['agent-fork-code', 'runtime-code']));
    expect(parseMcpAllowedSourceIds({})).toBeNull();

    expect(isMcpExplicitSourceRequired({ GBRAIN_MCP_REQUIRE_EXPLICIT_SOURCE_ID: '1' })).toBe(true);
    expect(isMcpExplicitSourceRequired({ GBRAIN_MCP_REQUIRE_EXPLICIT_SOURCE_ID: 'YES' })).toBe(true);
    expect(isMcpExplicitSourceRequired({ GBRAIN_MCP_REQUIRE_EXPLICIT_SOURCE_ID: '0' })).toBe(false);
    expect(isMcpExplicitSourceRequired({})).toBe(false);
  });
});

describe('MCP source allow-list dispatch fence', () => {
  test('filters sources_list to approved source ids only', async () => {
    await registerSource('default');
    await registerSource('source-a');
    await registerSource('source-b');

    const result = await dispatchToolCall(engine, 'sources_list', {}, {
      remote: true,
      sourceId: 'source-a',
      allowedSourceIds: ['source-a'],
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { sources: Array<{ id: string }> };
    expect(payload.sources.map((s) => s.id)).toEqual(['source-a']);
  });

  test('sources_status rejects default, unknown, and disallowed sources before diagnostics', async () => {
    await registerSource('default');
    await registerSource('source-a');

    for (const requested of ['default', 'unknown-source', 'source-b']) {
      const result = await dispatchToolCall(engine, 'sources_status', { id: requested }, {
        remote: true,
        sourceId: 'source-a',
        allowedSourceIds: ['source-a'],
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.error).toBe('permission_denied');
      expect(payload.allowed_source_ids).toEqual(['source-a']);
    }

    const ok = await dispatchToolCall(engine, 'sources_status', { id: 'source-a' }, {
      remote: true,
      sourceId: 'source-a',
      allowedSourceIds: ['source-a'],
    });
    expect(ok.isError).toBeFalsy();
    const payload = JSON.parse(ok.content[0]!.text);
    expect(payload.id).toBe('source-a');
  });

  test('code tools require explicit approved source ids when configured', async () => {
    await registerSource('source-a');
    await registerSource('source-b');
    await insertCodeDef('source-a', 'parseMarkdown');

    const baseOpts = {
      remote: true,
      sourceId: 'source-a',
      allowedSourceIds: ['source-a'],
      requireExplicitSourceId: true,
    };

    const missing = await dispatchToolCall(engine, 'code_def', { symbol: 'parseMarkdown' }, baseOpts);
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0]!.text).error).toBe('source_id_required');

    for (const params of [
      { symbol: 'parseMarkdown', source_id: '__all__' },
      { symbol: 'parseMarkdown', all_sources: true },
      { symbol: 'parseMarkdown', source_id: 'source-b' },
    ]) {
      const result = await dispatchToolCall(engine, 'code_def', params, baseOpts);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).error).toBe('permission_denied');
    }

    const ok = await dispatchToolCall(engine, 'code_def', {
      symbol: 'parseMarkdown',
      source_id: 'source-a',
    }, baseOpts);
    expect(ok.isError).toBeFalsy();
    const payload = JSON.parse(ok.content[0]!.text);
    expect(payload.count).toBe(1);
    expect(payload.defs[0].symbol_type).toBe('function');
  });

  test('approved sources still fail closed when archived or federated', async () => {
    await registerSource('source-archived', { archived: true });
    await registerSource('source-federated', { federated: true });

    for (const sourceId of ['source-archived', 'source-federated']) {
      const result = await dispatchToolCall(engine, 'sources_status', { id: sourceId }, {
        remote: true,
        sourceId,
        allowedSourceIds: [sourceId],
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.error).toBe('permission_denied');
      expect(payload.requested_source_id).toBe(sourceId);
    }
  });
});

async function registerSource(
  id: string,
  opts: { archived?: boolean; federated?: boolean } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at, archived)
     VALUES ($1, $1, $2, $3::jsonb, NOW(), $4)
     ON CONFLICT (id) DO UPDATE SET
       local_path = EXCLUDED.local_path,
       config = EXCLUDED.config,
       archived = EXCLUDED.archived`,
    [id, `/fake/${id}`, JSON.stringify({ federated: opts.federated === true }), opts.archived === true],
  );
}

async function insertCodeDef(sourceId: string, symbol: string): Promise<void> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ('src/parser.ts', $1, 'src/parser.ts', 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [sourceId],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type, start_line, end_line)
     VALUES ($1, 0, 'export function parseMarkdown(s: string) { return s; }', 'compiled_truth', 'typescript', $2, $2, 'function', 1, 3)`,
    [rows[0]!.id, symbol],
  );
}
