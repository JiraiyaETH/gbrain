import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker, type UnhealthyReason } from '../src/core/minions/worker.ts';
import {
  AUTOPILOT_JOB_PROVENANCE,
  AUTOPILOT_JOB_PROVENANCE_KEY,
  isAutopilotAttributedJob,
  resolveAutopilotWriterRetryMs,
  runAutopilotJobWithWriterLease,
  withAutopilotJobProvenance,
} from '../src/core/minions/autopilot-writer-lease.ts';
import {
  isAutopilotCorpusWriterLockReleaseFailure,
  type AutopilotCorpusWriterLockConfig,
  type RunLockHelper,
} from '../src/core/autopilot-corpus-writer-lock.ts';

const ENABLED_CONFIG: AutopilotCorpusWriterLockConfig = {
  enabled: true,
  helperPath: '/sealed/runtime/run-lock.py',
  pythonBin: '/usr/bin/python3',
  lockDir: '/private/runtime/locks/corpus-writer.lock',
  waitSeconds: 0,
  pollSeconds: 0.01,
};

function job(
  name: string,
  data: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return { name, data, signal };
}

describe('Autopilot Minion execution-boundary attribution', () => {
  test('requires the exact trusted marker; generic origin metadata is not authority', () => {
    const tagged = withAutopilotJobProvenance({ sourceId: 'default' });
    expect(tagged).toMatchObject({
      origin: 'autopilot',
      sourceId: 'default',
      [AUTOPILOT_JOB_PROVENANCE_KEY]: AUTOPILOT_JOB_PROVENANCE,
    });
    expect(isAutopilotAttributedJob('sync', tagged)).toBe(true);
    expect(isAutopilotAttributedJob('sync', { origin: 'autopilot' })).toBe(false);
    expect(isAutopilotAttributedJob('sync', {
      [AUTOPILOT_JOB_PROVENANCE_KEY]: 'gbrain-autopilot/forged-version',
    })).toBe(false);
  });

  test('guards legacy intrinsic rows while leaving untagged manual jobs alone', () => {
    expect(isAutopilotAttributedJob('autopilot-cycle', {})).toBe(true);
    expect(isAutopilotAttributedJob('autopilot-global-maintenance', {})).toBe(true);
    expect(isAutopilotAttributedJob('sync', {})).toBe(false);
    expect(isAutopilotAttributedJob('lint', {})).toBe(false);
  });

  test('untagged manual execution bypasses the Autopilot lease', async () => {
    let calls = 0;
    const result = await runAutopilotJobWithWriterLease(
      job('sync', { sourceId: 'manual' }),
      async () => ++calls,
      { env: {} },
    );

    expect(result).toEqual({ status: 'completed', guarded: false, value: 1 });
    expect(calls).toBe(1);
  });

  test('tagged and legacy execution fail closed when the helper is absent', async () => {
    for (const attributed of [
      job('sync', withAutopilotJobProvenance({})),
      job('autopilot-cycle', {}),
    ]) {
      let calls = 0;
      const result = await runAutopilotJobWithWriterLease(
        attributed,
        async () => ++calls,
        { env: { GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS: '9' } },
      );
      expect(result).toMatchObject({
        status: 'deferred',
        reason: 'invalid_config',
        retryAfterMs: 9_000,
      });
      expect(calls).toBe(0);
    }
  });

  test('busy helper defers without entering the handler', async () => {
    let calls = 0;
    const result = await runAutopilotJobWithWriterLease(
      job('sync', withAutopilotJobProvenance({})),
      async () => ++calls,
      {
        env: { GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS: '0.25' },
        lock: {
          config: ENABLED_CONFIG,
          runHelper: async () => 75,
        },
      },
    );

    expect(result).toEqual({
      status: 'deferred',
      reason: 'busy',
      retryAfterMs: 250,
      helperExitCode: 75,
      detail: undefined,
    });
    expect(calls).toBe(0);
  });

  test('broken helper exit fails closed without entering the handler', async () => {
    let calls = 0;
    const result = await runAutopilotJobWithWriterLease(
      job('sync', withAutopilotJobProvenance({})),
      async () => ++calls,
      {
        lock: {
          config: ENABLED_CONFIG,
          runHelper: async () => 2,
        },
      },
    );

    expect(result).toMatchObject({
      status: 'deferred',
      reason: 'helper_error',
      helperExitCode: 2,
    });
    expect(calls).toBe(0);
  });

  test('concurrent tagged handlers never overlap and a deferred retry can run later', async () => {
    let held = false;
    let activeHandlers = 0;
    let maxActiveHandlers = 0;
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const helper: RunLockHelper = async ({ action }) => {
      if (action === 'acquire') {
        if (held) return 75;
        held = true;
        return 0;
      }
      held = false;
      return 0;
    };
    const options = {
      env: { GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS: '1' },
      lock: { config: ENABLED_CONFIG, runHelper: helper },
    };
    const guardedJob = job('sync', withAutopilotJobProvenance({}));
    let secondCalls = 0;

    const first = runAutopilotJobWithWriterLease(guardedJob, async () => {
      activeHandlers++;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      firstEntered();
      await gate;
      activeHandlers--;
      return 'first';
    }, options);
    await entered;

    const blocked = await runAutopilotJobWithWriterLease(guardedJob, async () => {
      secondCalls++;
      activeHandlers++;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      activeHandlers--;
      return 'second';
    }, options);
    expect(blocked).toMatchObject({ status: 'deferred', reason: 'busy' });
    expect(secondCalls).toBe(0);

    releaseFirst();
    expect(await first).toMatchObject({ status: 'completed', guarded: true, value: 'first' });

    const retried = await runAutopilotJobWithWriterLease(guardedJob, async () => {
      secondCalls++;
      activeHandlers++;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      activeHandlers--;
      return 'second';
    }, options);
    expect(retried).toMatchObject({ status: 'completed', guarded: true, value: 'second' });
    expect(secondCalls).toBe(1);
    expect(maxActiveHandlers).toBe(1);
  });

  test('retry delay parsing is bounded and rejects unsafe values', () => {
    expect(resolveAutopilotWriterRetryMs({})).toBe(30_000);
    expect(resolveAutopilotWriterRetryMs({ GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS: '0.5' })).toBe(500);
    expect(resolveAutopilotWriterRetryMs({ GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS: '999999' })).toBe(15 * 60_000);
    expect(resolveAutopilotWriterRetryMs({ GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS: 'nope' })).toBe(30_000);
  });
});

describe('Autopilot corpus-writer deferral row state', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('busy release is delayed, token-free, retry-safe, and resets execution clocks', async () => {
    const created = await queue.add(
      'sync',
      withAutopilotJobProvenance({ sourceId: 'default' }),
      { max_attempts: 1, timeout_ms: 100 },
    );
    const first = await queue.claim('writer-token-1', 30_000, 'default', ['sync']);
    expect(first?.id).toBe(created.id);
    expect(first?.attempts_started).toBe(1);

    const released = await queue.releaseDeferredJob(
      created.id,
      'writer-token-1',
      'autopilot corpus-writer lock busy (helper exit 75)',
      50,
    );
    expect(released).not.toBeNull();

    const delayed = await queue.getJob(created.id);
    expect(delayed).toMatchObject({
      status: 'delayed',
      attempts_made: 0,
      attempts_started: 1,
      lock_token: null,
      lock_until: null,
      started_at: null,
      timeout_at: null,
    });

    // Promote and claim the same row again. max_attempts=1 proves the busy
    // bounce did not spend the sole real handler attempt or dead-letter it.
    await engine.executeRaw(
      `UPDATE minion_jobs SET delay_until = now() - interval '1 second'
       WHERE id = $1`,
      [created.id],
    );
    expect(await queue.promoteDelayed()).toHaveLength(1);
    const retried = await queue.claim('writer-token-2', 30_000, 'default', ['sync']);
    expect(retried?.id).toBe(created.id);
    expect(retried?.attempts_made).toBe(0);
    expect(retried?.attempts_started).toBe(2);
    expect(retried?.started_at).not.toBeNull();

    const completed = await queue.completeJob(created.id, 'writer-token-2', { ok: true });
    expect(completed?.status).toBe('completed');
    expect(completed?.attempts_made).toBe(0);
  });

  test('wrong token cannot release a row owned by another worker', async () => {
    const created = await queue.add('sync', withAutopilotJobProvenance({}));
    await queue.claim('real-token', 30_000, 'default', ['sync']);
    expect(await queue.releaseDeferredJob(created.id, 'wrong-token', 'busy', 50)).toBeNull();
    expect(await queue.getJob(created.id)).toMatchObject({
      status: 'active',
      lock_token: 'real-token',
      attempts_made: 0,
    });
  });

  test('worker stamps successful handler output then stops on release exit 74', async () => {
    const actions: string[] = [];
    let unhealthy: UnhealthyReason | undefined;
    let handlerCalls = 0;
    const worker = new MinionWorker(engine, {
      concurrency: 1,
      pollInterval: 10,
      stalledInterval: 10_000,
      healthCheckInterval: 0,
      autopilotWriterExecutionOptions: {
        lock: {
          config: ENABLED_CONFIG,
          runHelper: async ({ action }) => {
            actions.push(action);
            return action === 'release' ? 74 : 0;
          },
        },
      },
    });
    worker.on('unhealthy', (info) => { unhealthy = info; });
    worker.register('writer-release-74', async () => {
      handlerCalls++;
      return { written: true };
    });
    const created = await queue.add(
      'writer-release-74',
      withAutopilotJobProvenance({}),
      { max_attempts: 1 },
    );

    await worker.start();

    expect(handlerCalls).toBe(1);
    expect(actions).toEqual(['acquire', 'release']);
    expect(unhealthy).toMatchObject({
      reason: 'corpus_writer_lock_release_failed',
      jobId: created.id,
      jobName: 'writer-release-74',
    });
    expect(await queue.getJob(created.id)).toMatchObject({
      status: 'completed',
      attempts_made: 0,
      result: { written: true },
    });
  }, 5_000);

  test('worker preserves primary handler failure then stops on release exit 75', async () => {
    const diagnostics: string[] = [];
    let unhealthy: UnhealthyReason | undefined;
    const primary = new Error('primary handler failure');
    const worker = new MinionWorker(engine, {
      concurrency: 1,
      pollInterval: 10,
      stalledInterval: 10_000,
      healthCheckInterval: 0,
      autopilotWriterExecutionOptions: {
        lock: {
          config: ENABLED_CONFIG,
          runHelper: async ({ action }) => action === 'release' ? 75 : 0,
          onDiagnostic: (message) => diagnostics.push(message),
        },
      },
    });
    worker.on('unhealthy', (info) => { unhealthy = info; });
    worker.register('writer-release-75', async () => {
      throw primary;
    });
    const created = await queue.add(
      'writer-release-75',
      withAutopilotJobProvenance({}),
      { max_attempts: 1 },
    );

    await worker.start();

    expect(isAutopilotCorpusWriterLockReleaseFailure(primary)).toBe(true);
    expect(diagnostics).toEqual([
      'Autopilot corpus-writer lock release also failed after dispatch failure: helper exit 75',
    ]);
    expect(unhealthy).toMatchObject({
      reason: 'corpus_writer_lock_release_failed',
      jobId: created.id,
      jobName: 'writer-release-75',
      message: 'primary handler failure',
    });
    const failed = await queue.getJob(created.id);
    expect(failed).toMatchObject({
      status: 'dead',
      attempts_made: 1,
      error_text: 'primary handler failure',
    });
    expect(failed?.error_text).not.toContain('release');
  }, 5_000);
});
