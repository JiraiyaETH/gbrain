import { describe, expect, test } from 'bun:test';
import { buildSupervisorWorkerArgs } from '../src/core/minions/supervisor.ts';

describe('MinionSupervisor worker argument propagation', () => {
  test('passes explicit lockDuration to child worker as --lock-duration-ms', () => {
    expect(buildSupervisorWorkerArgs({
      concurrency: 1,
      queue: 'default',
      lockDurationMs: 120_000,
      maxRssMb: 8192,
    })).toEqual([
      'jobs', 'work',
      '--concurrency', '1',
      '--queue', 'default',
      '--lock-duration-ms', '120000',
      '--max-rss', '8192',
    ]);
  });
});
