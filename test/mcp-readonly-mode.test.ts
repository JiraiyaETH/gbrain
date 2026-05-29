import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import {
  filterMcpOperationsForEnv,
  isReadOnlyMcpEnabled,
  mcpToolNotExposedResult,
  parseMcpAllowedSlugPrefixes,
  parseMcpAllowedTools,
  readOnlyBlockedToolResult,
} from '../src/mcp/read-only.ts';

describe('MCP read-only mode', () => {
  test('GBRAIN_MCP_READ_ONLY truthy values enable read-only filtering', () => {
    expect(isReadOnlyMcpEnabled({ GBRAIN_MCP_READ_ONLY: '1' })).toBe(true);
    expect(isReadOnlyMcpEnabled({ GBRAIN_MCP_READ_ONLY: 'true' })).toBe(true);
    expect(isReadOnlyMcpEnabled({ GBRAIN_MCP_READ_ONLY: 'YES' })).toBe(true);
    expect(isReadOnlyMcpEnabled({ GBRAIN_MCP_READ_ONLY: 'on' })).toBe(true);
    expect(isReadOnlyMcpEnabled({ GBRAIN_MCP_READ_ONLY: '0' })).toBe(false);
    expect(isReadOnlyMcpEnabled({})).toBe(false);
  });

  test('read-only mode exposes read operations and hides write/admin/local-only tools', () => {
    const names = new Set(filterMcpOperationsForEnv(operations, { GBRAIN_MCP_READ_ONLY: '1' }).map(op => op.name));

    for (const name of ['get_page', 'search', 'query', 'list_pages', 'run_doctor', 'sources_list', 'resolve_slugs']) {
      expect(names.has(name)).toBe(true);
    }

    for (const name of [
      'put_page',
      'delete_page',
      'restore_page',
      'purge_deleted_pages',
      'sync_brain',
      'sources_remove',
      'schema_apply_mutations',
      'think',
      'pause_job',
      'resume_job',
      'replay_job',
      'send_job_message',
      'reload_schema_pack',
    ]) {
      expect(names.has(name)).toBe(false);
    }
  });

  test('GBRAIN_MCP_ALLOWED_TOOLS scopes stdio exposure without enabling admin sprawl', () => {
    const env = {
      GBRAIN_MCP_ALLOWED_TOOLS: 'get_page, search, put_page, add_link, add_timeline_entry',
    };
    const allowed = parseMcpAllowedTools(env);
    expect(allowed).toEqual(new Set(['get_page', 'search', 'put_page', 'add_link', 'add_timeline_entry']));

    const names = new Set(filterMcpOperationsForEnv(operations, env).map(op => op.name));
    expect(names).toEqual(new Set(['get_page', 'search', 'put_page', 'add_link', 'add_timeline_entry']));
    expect(names.has('delete_page')).toBe(false);
    expect(names.has('sources_remove')).toBe(false);
  });

  test('GBRAIN_MCP_ALLOWED_SLUG_PREFIXES parses comma-separated write fences', () => {
    const prefixes = parseMcpAllowedSlugPrefixes({
      GBRAIN_MCP_ALLOWED_SLUG_PREFIXES: 'people/*, companies/*, projects/tailored/*, food/alina/*',
    });

    expect(prefixes).toEqual(['people/*', 'companies/*', 'projects/tailored/*', 'food/alina/*']);
    expect(parseMcpAllowedSlugPrefixes({})).toBeNull();
  });

  test('read-only mode wins over allowed-tools and cannot be bypassed by listing write tools', () => {
    const names = new Set(filterMcpOperationsForEnv(operations, {
      GBRAIN_MCP_READ_ONLY: '1',
      GBRAIN_MCP_ALLOWED_TOOLS: 'get_page,put_page,add_link',
    }).map(op => op.name));

    expect(names).toEqual(new Set(['get_page']));
  });

  test('allow-list block response names the configured scope', () => {
    const result = mcpToolNotExposedResult('delete_page', {
      GBRAIN_MCP_ALLOWED_TOOLS: 'get_page,put_page',
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('mcp_tool_not_allowed');
    expect(body.allowed_scope).toBe('configured_allowlist');
    expect(body.allowed_tools).toEqual(['get_page', 'put_page']);
  });

  test('read-only block response is JSON-shaped MCP error content', () => {
    const result = readOnlyBlockedToolResult('put_page');
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('read_only_mcp');
    expect(body.message).toContain('put_page');
  });
});
