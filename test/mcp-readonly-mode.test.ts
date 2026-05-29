import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import {
  filterMcpOperationsForEnv,
  isReadOnlyMcpEnabled,
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

  test('read-only block response is JSON-shaped MCP error content', () => {
    const result = readOnlyBlockedToolResult('put_page');
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('read_only_mcp');
    expect(body.message).toContain('put_page');
  });
});
