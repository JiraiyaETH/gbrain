import { describe, expect, test } from 'bun:test';
import {
  createHash,
} from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { withAutopilotCorpusWriterLock } from '../src/core/autopilot-corpus-writer-lock.ts';
import { withAutopilotJobProvenance } from '../src/core/minions/autopilot-writer-lease.ts';
import { withEnv } from './helpers/with-env.ts';

const CANONICAL_R3_HELPER_SHA256 = '5592258b3d417a67bbe5c188c441947a1919ef3881224b94a1f4eb1d4b1b1f82';
const helperPath = process.env.GBRAIN_RUN_LOCK_HELPER_INTEGRATION_PATH;
const integrationTest = helperPath ? test : test.skip;

function helperHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await read();
  }
  if (!accept(latest)) {
    throw new Error(
      `condition not met within ${timeoutMs}ms; latest=${JSON.stringify(latest)}`,
    );
  }
  return latest;
}

describe('sealed r3 run-lock helper ABI', () => {
  integrationTest('real subprocess accepts wait/poll, excludes a contender, and exact-releases', async () => {
    const exactHelper = helperPath!;
    expect(isAbsolute(exactHelper)).toBe(true);
    expect(existsSync(exactHelper)).toBe(true);
    expect(helperHash(exactHelper)).toBe(CANONICAL_R3_HELPER_SHA256);

    const root = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-helper-'));
    const lockDir = join(root, 'locks', 'corpus-writer.lock');
    const config = {
      enabled: true,
      helperPath: exactHelper,
      pythonBin: '/usr/bin/python3',
      lockDir,
      waitSeconds: 0,
      pollSeconds: 0.01,
    } as const;
    try {
      const result = await withAutopilotCorpusWriterLock(async () => {
        const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as {
          owner?: string;
          schema?: string;
        };
        expect(owner).toMatchObject({
          owner: 'gbrain-autopilot-tick',
          schema: 'gbrain-run-lock/v1',
        });

        const contender = await withAutopilotCorpusWriterLock(
          async () => 'must-not-run',
          { config, tokenNonce: 'contender' },
        );
        expect(contender).toEqual({
          status: 'deferred',
          reason: 'busy',
          helper_exit_code: 75,
        });
        return 'held';
      }, { config, tokenNonce: 'owner' });

      expect(result).toEqual({ status: 'completed', lock: 'acquired', value: 'held' });
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  integrationTest('real worker defers a contending tagged row without burning attempts, then retries', async () => {
    const exactHelper = helperPath!;
    expect(helperHash(exactHelper)).toBe(CANONICAL_R3_HELPER_SHA256);

    const root = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-worker-lock-'));
    const lockDir = join(root, 'locks', 'corpus-writer.lock');
    const engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    const queue = new MinionQueue(engine);
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const worker = new MinionWorker(engine, {
      concurrency: 2,
      pollInterval: 10,
      lockDuration: 30_000,
      stalledInterval: 10_000,
      healthCheckInterval: 0,
    });
    worker.register('writer-probe', async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) {
          firstEntered!();
          await firstGate;
        }
        return { call: calls };
      } finally {
        active--;
      }
    });

    let workerPromise: Promise<void> | undefined;
    try {
      await queue.add('writer-probe', withAutopilotJobProvenance({ logical: 1 }), {
        max_attempts: 1,
        timeout_ms: 60_000,
      });
      await queue.add('writer-probe', withAutopilotJobProvenance({ logical: 2 }), {
        max_attempts: 1,
        timeout_ms: 60_000,
      });

      await withEnv({
        GBRAIN_RUN_LOCK_HELPER: exactHelper,
        GBRAIN_PYTHON_BIN: '/usr/bin/python3',
        GBRAIN_CORPUS_WRITER_LOCK_DIR: lockDir,
        GBRAIN_AUTOPILOT_CORPUS_LOCK_WAIT_SECONDS: '0',
        GBRAIN_AUTOPILOT_CORPUS_LOCK_POLL_SECONDS: '0.01',
        // Keep the deferred row observable long enough for the assertion.
        // A sub-second retry can be reclaimed between 10ms polling samples,
        // turning this ABI test into a timing lottery.
        GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS: '2',
      }, async () => {
        workerPromise = worker.start();
        await entered;

        const duringContention = await waitFor(
          () => queue.getJobs({ name: 'writer-probe' }),
          (rows) => rows.some((row) => row.status === 'delayed'),
        );
        const deferred = duringContention.find((row) => row.status === 'delayed');
        expect(deferred).toMatchObject({
          attempts_made: 0,
          attempts_started: 1,
          lock_token: null,
          started_at: null,
          timeout_at: null,
        });
        expect(calls).toBe(1);
        expect(maxActive).toBe(1);

        releaseFirst!();
        const finished = await waitFor(
          () => queue.getJobs({ name: 'writer-probe' }),
          (rows) => rows.length === 2 && rows.every((row) => row.status === 'completed'),
          12_000,
        );
        expect(finished.every((row) => row.attempts_made === 0)).toBe(true);
        expect(finished.some((row) => row.attempts_started === 2)).toBe(true);
        expect(calls).toBe(2);
        expect(maxActive).toBe(1);
      });
    } finally {
      // Never strand the first handler if an assertion above fails.
      releaseFirst?.();
      worker.stop();
      if (workerPromise) await workerPromise;
      await engine.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
