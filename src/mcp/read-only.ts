import type { Operation } from '../core/operations.ts';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isReadOnlyMcpEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.GBRAIN_MCP_READ_ONLY;
  return typeof value === 'string' && TRUE_VALUES.has(value.trim().toLowerCase());
}

export function parseMcpAllowedTools(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const raw = env.GBRAIN_MCP_ALLOWED_TOOLS;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const names = raw
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

export function parseMcpAllowedSlugPrefixes(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.GBRAIN_MCP_ALLOWED_SLUG_PREFIXES;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const prefixes = raw
    .split(',')
    .map(prefix => prefix.trim())
    .filter(Boolean);
  return prefixes.length > 0 ? prefixes : null;
}

const READ_ONLY_ADMIN_TOOLS = new Set([
  'get_stats',
  'get_health',
  'run_doctor',
  'get_status_snapshot',
  'get_job',
  'list_jobs',
  'get_job_progress',
]);

export function isReadOnlyOperation(op: Operation): boolean {
  if (op.mutating === true || op.localOnly === true) return false;
  return op.scope === 'read' || READ_ONLY_ADMIN_TOOLS.has(op.name);
}

export function filterMcpOperationsForEnv(
  ops: readonly Operation[],
  env: Record<string, string | undefined> = process.env,
): Operation[] {
  const allowedTools = parseMcpAllowedTools(env);
  const scoped = isReadOnlyMcpEnabled(env) ? ops.filter(isReadOnlyOperation) : [...ops];
  if (!allowedTools) return scoped;
  return scoped.filter(op => allowedTools.has(op.name));
}

export function mcpToolNotExposedResult(name: string, env: Record<string, string | undefined> = process.env) {
  const readOnly = isReadOnlyMcpEnabled(env);
  const allowedTools = parseMcpAllowedTools(env);
  const reason = readOnly ? 'read_only_mcp' : 'mcp_tool_not_allowed';
  const message = readOnly
    ? `Tool is not exposed because GBRAIN_MCP_READ_ONLY=1: ${name}`
    : `Tool is not exposed by GBRAIN_MCP_ALLOWED_TOOLS: ${name}`;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: reason,
        message,
        allowed_scope: readOnly ? 'read' : 'configured_allowlist',
        allowed_tools: allowedTools ? [...allowedTools].sort() : undefined,
      }, null, 2),
    }],
    isError: true,
  };
}

export function readOnlyBlockedToolResult(name: string) {
  return mcpToolNotExposedResult(name, { GBRAIN_MCP_READ_ONLY: '1' });
}
