import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  JobTerminalWriteTimeoutError,
  isTerminalWriteRetryable,
  resolveJobTerminalWriteTimeoutMs,
} from '../src/core/minions/worker.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

describe('MinionWorker completion retry guard', () => {
  test('completeJob status flip retries once after retryable connection errors/timeouts', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/core/minions/worker.ts'), 'utf8');
    expect(source).toContain('completion hit connection blip');
    expect(source).toContain('isTerminalWriteRetryable(err)');
    expect(source).toContain('awaitTerminalJobWrite');
    expect(source).toContain('reconnect.call(this.engine)');
    expect(source).toContain("readback?.status === 'completed'");
  });

  test('terminal write timeout knob defaults and validates', () => {
    expect(resolveJobTerminalWriteTimeoutMs({})).toBe(20_000);
    expect(resolveJobTerminalWriteTimeoutMs({ GBRAIN_JOB_TERMINAL_WRITE_TIMEOUT_MS: '5000' })).toBe(20_000);
    expect(resolveJobTerminalWriteTimeoutMs({ GBRAIN_JOB_TERMINAL_WRITE_TIMEOUT_MS: '8000' })).toBe(20_000);
    expect(resolveJobTerminalWriteTimeoutMs({ GBRAIN_JOB_TERMINAL_WRITE_TIMEOUT_MS: '30000' })).toBe(30_000);
    expect(resolveJobTerminalWriteTimeoutMs({ GBRAIN_JOB_TERMINAL_WRITE_TIMEOUT_MS: '0' })).toBe(20_000);
    expect(resolveJobTerminalWriteTimeoutMs({ GBRAIN_JOB_TERMINAL_WRITE_TIMEOUT_MS: 'bad' })).toBe(20_000);
  });

  test('queue completion uses the canonical lock retry wrapper', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/core/minions/queue.ts'), 'utf8');
    expect(source).toContain('async completeJob(');
    expect(source).toMatch(/async completeJob[\s\S]{0,220}?return this\.lockRetry\(\(\) => this\.engine\.transaction/);
  });

  test('PostgresEngine reconnect force-closes a wedged pool and coalesces concurrent reconnects', async () => {
    const engine = new PostgresEngine() as unknown as {
      _savedConfig: { database_url: string; poolSize: number } | null;
      _connectionStyle: 'instance' | 'module' | null;
      _sql: { end: (opts?: { timeout?: number }) => Promise<void> } | null;
      connectionManager: { disconnect: () => Promise<void> } | null;
      connect: (config: { database_url: string; poolSize: number }) => Promise<void>;
      reconnect: () => Promise<void>;
    };

    const calls: string[] = [];
    engine._savedConfig = { database_url: 'postgres://example.invalid/db', poolSize: 1 };
    engine._connectionStyle = 'instance';
    engine._sql = {
      end: async (opts?: { timeout?: number }) => {
        calls.push(`sql.end:${opts?.timeout ?? 'none'}`);
      },
    };
    engine.connectionManager = {
      disconnect: async () => {
        calls.push('manager.disconnect');
      },
    };
    engine.connect = async () => {
      calls.push('connect');
    };

    await Promise.all([engine.reconnect(), engine.reconnect()]);

    expect(calls.filter(c => c === 'connect')).toHaveLength(1);
    expect(calls).toContain('manager.disconnect');
    expect(calls).toContain('sql.end:1');
  });

  test('terminal write timeouts are retryable but ordinary errors are not', () => {
    expect(isTerminalWriteRetryable(new JobTerminalWriteTimeoutError('completeJob', 1))).toBe(true);
    expect(isTerminalWriteRetryable(new Error('ordinary application failure'))).toBe(false);
  });
});
