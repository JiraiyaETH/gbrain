import type { Operation } from '../core/operations.ts';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isReadOnlyMcpEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.GBRAIN_MCP_READ_ONLY;
  return typeof value === 'string' && TRUE_VALUES.has(value.trim().toLowerCase());
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
  if (!isReadOnlyMcpEnabled(env)) return [...ops];
  return ops.filter(isReadOnlyOperation);
}

export function readOnlyBlockedToolResult(name: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'read_only_mcp',
        message: `Tool is not exposed because GBRAIN_MCP_READ_ONLY=1: ${name}`,
        allowed_scope: 'read',
      }, null, 2),
    }],
    isError: true,
  };
}
