/**
 * `get_status_snapshot` MCP op contract.
 *
 * Pins the v0.41.19.0 wave's per-op decisions:
 *   - scope: 'admin' (codex MAJOR-9 / D10 — prevents read-scoped clients
 *     from seeing brain-host operational state).
 *   - localOnly: false (remote thin-client `gbrain status` callers need
 *     it via HTTP MCP — that's the whole point).
 *   - payload returns ONLY {schema_version: 1, sync, cycle}. Locks /
 *     Workers / Queue / Autopilot are deliberately omitted from the
 *     remote shape; the local CLI's `gbrain status` renders them as
 *     "N/A on remote brain" instead.
 *
 * Hermetic — stubs the engine. The cycle / sync helpers degrade
 * gracefully when their queries throw, so a stubbed `executeRaw` that
 * returns `[]` is enough to exercise the shape.
 */

import { describe, test, expect } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import { buildCycleSnapshot } from '../src/commands/status.ts';

describe('get_status_snapshot op definition', () => {
  test('exists and is registered in the operations array', () => {
    expect(operationsByName.get_status_snapshot).toBeDefined();
    expect(operations.find((o) => o.name === 'get_status_snapshot')).toBeDefined();
  });

  test('scope is admin', () => {
    const op = operationsByName.get_status_snapshot;
    expect(op.scope).toBe('admin');
  });

  test('localOnly is false (must be remote-callable for thin-client status)', () => {
    const op = operationsByName.get_status_snapshot;
    expect(op.localOnly).toBe(false);
  });

  test('takes no params', () => {
    const op = operationsByName.get_status_snapshot;
    expect(op.params).toEqual({});
  });
});

describe('get_status_snapshot handler shape', () => {
  test('returns only {schema_version, sync, cycle} keys (no Locks/Workers/Queue/Autopilot)', async () => {
    const op = operationsByName.get_status_snapshot;
    // Stub engine that returns empty rows for any executeRaw and a minimal
    // BrainEngine shape. The sync helper degrades to an empty sources list
    // and a synthetic SyncStatusReport; the cycle helper degrades to
    // {last_full: null, last_targeted: null}.
    const stubEngine: any = {
      kind: 'pglite',
      executeRaw: async () => [],
      getConfig: async () => null,
    };
    const ctx: any = {
      engine: stubEngine,
      config: {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
    };
    const result = (await op.handler(ctx, {})) as Record<string, unknown>;
    expect(result.schema_version).toBe(1);
    expect(result).toHaveProperty('sync');
    expect(result).toHaveProperty('cycle');
    expect(result).not.toHaveProperty('locks');
    expect(result).not.toHaveProperty('workers');
    expect(result).not.toHaveProperty('queue');
    expect(result).not.toHaveProperty('autopilot');
  });
});

describe('cycle snapshot status semantics', () => {
  test('surfaces embedded partial autopilot result status instead of outer completed job status', async () => {
    const row = {
      finished_at: '2026-06-20T08:00:00.000Z',
      name: 'autopilot-cycle',
      status: 'completed',
      started_at: '2026-06-20T07:59:00.000Z',
      result: {
        partial: true,
        status: 'partial',
        report: {
          status: 'partial',
          totals: { extract_atoms_atoms_written: 61 },
        },
      },
    };
    const stubEngine: any = {
      kind: 'pglite',
      executeRaw: async (sql: string) => {
        if (sql.includes("name = 'autopilot-cycle'")) return [row];
        if (sql.includes("name LIKE 'autopilot-%'")) return [row];
        return [];
      },
      getConfig: async () => null,
    };

    const snapshot = await buildCycleSnapshot(stubEngine);

    expect(snapshot.last_full?.status).toBe('partial');
    expect(snapshot.last_targeted?.status).toBe('partial');
    expect(snapshot.last_full?.totals).toEqual({ extract_atoms_atoms_written: 61 });
  });
});
