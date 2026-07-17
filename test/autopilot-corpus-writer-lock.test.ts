import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AutopilotCorpusWriterLockReleaseError,
  isAutopilotCorpusWriterLockReleaseFailure,
  resolveAutopilotCorpusWriterLockConfig,
  withAutopilotCorpusWriterLock,
  type AutopilotCorpusWriterLockConfig,
  type RunLockInvocation,
} from '../src/core/autopilot-corpus-writer-lock.ts';
import {
  AUTOPILOT_EXCLUDED_PHASES,
  AUTOPILOT_PHASES,
  filterAutopilotPlanSteps,
} from '../src/core/cycle.ts';

const ENABLED_CONFIG: AutopilotCorpusWriterLockConfig = {
  enabled: true,
  helperPath: '/sealed/runtime/run-lock.py',
  pythonBin: '/usr/bin/python3',
  lockDir: '/private/runtime/locks/corpus-writer.lock',
  waitSeconds: 2,
  pollSeconds: 0.1,
};

describe('Autopilot shared corpus-writer exclusion', () => {
  test('contention defers the tick and prevents every phase dispatch', async () => {
    const actions: string[] = [];
    let dispatched = 0;
    const result = await withAutopilotCorpusWriterLock(async () => {
      dispatched++;
    }, {
      config: ENABLED_CONFIG,
      ownerPid: 1234,
      tokenNonce: 'busy',
      runHelper: async (invocation) => {
        actions.push(invocation.action);
        return 75;
      },
    });

    expect(result).toEqual({
      status: 'deferred',
      reason: 'busy',
      helper_exit_code: 75,
    });
    expect(dispatched).toBe(0);
    expect(actions).toEqual(['acquire']);
  });

  test('successful dispatch releases the exact per-tick lease', async () => {
    const order: string[] = [];
    const invocations: RunLockInvocation[] = [];
    const result = await withAutopilotCorpusWriterLock(async () => {
      order.push('dispatch');
      return 'done';
    }, {
      config: ENABLED_CONFIG,
      ownerPid: 4321,
      tokenNonce: 'success',
      runHelper: async (invocation) => {
        invocations.push(invocation);
        order.push(invocation.action);
        return 0;
      },
    });

    expect(result).toEqual({ status: 'completed', lock: 'acquired', value: 'done' });
    expect(order).toEqual(['acquire', 'dispatch', 'release']);
    expect(invocations[0]?.argv).toContain('--wait-seconds');
    expect(invocations[0]?.argv).toContain('/private/runtime/locks/corpus-writer.lock');
    const acquireToken = invocations[0]?.argv[invocations[0].argv.indexOf('--token-file') + 1];
    const releaseToken = invocations[1]?.argv[invocations[1].argv.indexOf('--token-file') + 1];
    expect(acquireToken).toBe(releaseToken);
    expect(acquireToken).toContain('.autopilot-corpus-writer.4321.success.token');
  });

  test('dispatch failure releases first and preserves the primary error', async () => {
    const order: string[] = [];
    const diagnostics: string[] = [];
    const primary = new Error('phase failed');
    const pending = withAutopilotCorpusWriterLock(async () => {
      order.push('dispatch');
      throw primary;
    }, {
      config: ENABLED_CONFIG,
      runHelper: async (invocation) => {
        order.push(invocation.action);
        // Even a release failure must not replace the phase failure.
        return invocation.action === 'release' ? 74 : 0;
      },
      onDiagnostic: (message) => diagnostics.push(message),
    });

    await expect(pending).rejects.toBe(primary);
    expect(isAutopilotCorpusWriterLockReleaseFailure(primary)).toBe(true);
    expect(order).toEqual(['acquire', 'dispatch', 'release']);
    expect(diagnostics).toEqual([
      'Autopilot corpus-writer lock release also failed after dispatch failure: helper exit 74',
    ]);
  });

  test('release exit 74/75 after successful dispatch carries the completed value and is fatal', async () => {
    for (const releaseExit of [74, 75]) {
      const order: string[] = [];
      let caught: unknown;
      try {
        await withAutopilotCorpusWriterLock(async () => {
          order.push('dispatch');
          return `written-${releaseExit}`;
        }, {
          config: ENABLED_CONFIG,
          runHelper: async (invocation) => {
            order.push(invocation.action);
            return invocation.action === 'release' ? releaseExit : 0;
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AutopilotCorpusWriterLockReleaseError);
      expect(isAutopilotCorpusWriterLockReleaseFailure(caught)).toBe(true);
      expect(caught).toMatchObject({
        dispatchCompleted: true,
        completedValue: `written-${releaseExit}`,
        helperExitCode: releaseExit,
      });
      expect(order).toEqual(['acquire', 'dispatch', 'release']);
    }
  });

  test('primitive primary dispatch evidence survives a secondary release failure', async () => {
    let caught: unknown;
    try {
      await withAutopilotCorpusWriterLock(async () => {
        throw 'primitive handler failure';
      }, {
        config: ENABLED_CONFIG,
        runHelper: async ({ action }) => action === 'release' ? 75 : 0,
        onDiagnostic: () => {},
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutopilotCorpusWriterLockReleaseError);
    expect(caught).toMatchObject({
      dispatchCompleted: false,
      hasPrimaryDispatchError: true,
      primaryDispatchError: 'primitive handler failure',
      helperExitCode: 75,
    });
    expect(isAutopilotCorpusWriterLockReleaseFailure(caught)).toBe(true);
  });

  test('signal cancellation cleans up a raced acquisition without dispatch', async () => {
    const controller = new AbortController();
    const actions: string[] = [];
    let dispatched = false;
    const pending = withAutopilotCorpusWriterLock(async () => {
      dispatched = true;
    }, {
      config: ENABLED_CONFIG,
      signal: controller.signal,
      runHelper: async (invocation) => {
        actions.push(invocation.action);
        if (invocation.action === 'release') return 0;
        controller.abort();
        return 143;
      },
    });

    expect(await pending).toEqual({
      status: 'deferred',
      reason: 'aborted',
      helper_exit_code: 143,
    });
    expect(dispatched).toBe(false);
    expect(actions).toEqual(['acquire', 'release']);
  });

  test('signal cancellation after a successful acquire releases before dispatch', async () => {
    const controller = new AbortController();
    const actions: string[] = [];
    let dispatched = false;
    const result = await withAutopilotCorpusWriterLock(async () => {
      dispatched = true;
    }, {
      config: ENABLED_CONFIG,
      signal: controller.signal,
      runHelper: async (invocation) => {
        actions.push(invocation.action);
        if (invocation.action === 'acquire') controller.abort();
        return 0;
      },
    });

    expect(result).toEqual({ status: 'deferred', reason: 'aborted' });
    expect(dispatched).toBe(false);
    expect(actions).toEqual(['acquire', 'release']);
  });

  test('configured helper errors fail closed instead of dispatching', async () => {
    let dispatched = false;
    const result = await withAutopilotCorpusWriterLock(async () => {
      dispatched = true;
    }, {
      config: ENABLED_CONFIG,
      runHelper: async () => {
        throw new Error('helper unavailable');
      },
    });

    expect(result.status).toBe('deferred');
    if (result.status === 'deferred') expect(result.reason).toBe('helper_error');
    expect(dispatched).toBe(false);
  });

  test('required writers fail closed when no helper is configured', async () => {
    let dispatched = false;
    const result = await withAutopilotCorpusWriterLock(async () => {
      dispatched = true;
    }, {
      env: {},
      required: true,
    });

    expect(result).toEqual({
      status: 'deferred',
      reason: 'invalid_config',
      detail: 'GBRAIN_RUN_LOCK_HELPER is required for this corpus writer',
    });
    expect(dispatched).toBe(false);
  });

  test('runtime env resolves the same sealed helper and shared lock coordinates as wrappers', () => {
    expect(resolveAutopilotCorpusWriterLockConfig({ HOME: '/Users/example' })).toEqual({ enabled: false });
    expect(resolveAutopilotCorpusWriterLockConfig({
      HOME: '/Users/example',
      GBRAIN_RUN_LOCK_HELPER: '/sealed/r3/run-lock.py',
      GBRAIN_PYTHON_BIN: '/usr/bin/python3',
      GBRAIN_CORPUS_WRITER_LOCK_DIR: '/Users/example/.gbrain/locks/corpus-writer.lock',
      GBRAIN_AUTOPILOT_CORPUS_LOCK_WAIT_SECONDS: '30',
      GBRAIN_AUTOPILOT_CORPUS_LOCK_POLL_SECONDS: '0.5',
    })).toEqual({
      enabled: true,
      helperPath: '/sealed/r3/run-lock.py',
      pythonBin: '/usr/bin/python3',
      lockDir: '/Users/example/.gbrain/locks/corpus-writer.lock',
      waitSeconds: 30,
      pollSeconds: 0.5,
      invalidReason: undefined,
    });
  });
});

describe('Autopilot phase policy remains structural', () => {
  test('forbidden paid/manual phases remain absent from phase and targeted dispatch', () => {
    expect(AUTOPILOT_EXCLUDED_PHASES).toEqual(['synthesize', 'patterns', 'extract_atoms']);
    for (const phase of AUTOPILOT_EXCLUDED_PHASES) {
      expect(AUTOPILOT_PHASES).not.toContain(phase);
    }
    expect(filterAutopilotPlanSteps([
      { job: 'lint' },
      { job: 'synthesize' },
      { job: 'patterns' },
      { job: 'extract_atoms' },
    ])).toEqual([{ job: 'lint' }]);
  });

  test('minion dispatch is tagged while only inline execution takes the scheduler lease', () => {
    const source = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');
    const minionBranch = source.indexOf('if (useMinionsDispatch)');
    const leaseStart = source.indexOf('withAutopilotCorpusWriterLock(async (tickSignal) =>');
    const inlineCycle = source.indexOf('const report = await runCycle(engine', leaseStart);
    const leaseAwait = source.indexOf('const lockOutcome = await corpusTick', inlineCycle);
    expect(minionBranch).toBeGreaterThan(-1);
    expect(leaseStart).toBeGreaterThan(minionBranch);
    expect(inlineCycle).toBeGreaterThan(leaseStart);
    expect(leaseAwait).toBeGreaterThan(inlineCycle);
    expect(source).toContain('withAutopilotJobProvenance({');
    expect(source).toContain('withAutopilotJobProvenance(step.params)');
    expect(source).toContain('signal: tickSignal');
    expect(source).toContain("await shutdown('corpus-writer-lock-release-failed', 1)");
    expect(source).toContain('isAutopilotCorpusWriterLockReleaseFailure(e)');

    const worker = readFileSync(join(import.meta.dir, '../src/core/minions/worker.ts'), 'utf8');
    const executionGate = worker.indexOf('runAutopilotJobWithWriterLease(');
    const handlerCall = worker.indexOf('() => handler(context)', executionGate);
    const completion = worker.indexOf('this.queue.completeJob(', handlerCall);
    expect(executionGate).toBeGreaterThan(-1);
    expect(handlerCall).toBeGreaterThan(executionGate);
    expect(completion).toBeGreaterThan(handlerCall);

    const fanout = readFileSync(join(import.meta.dir, '../src/commands/autopilot-fanout.ts'), 'utf8');
    expect(fanout).toContain('withAutopilotJobProvenance({ repoPath: opts.repoPath, phases: AUTOPILOT_PHASES })');
    expect(fanout).toContain('withAutopilotJobProvenance({ repoPath: opts.repoPath, phases: AUTOPILOT_GLOBAL_PHASES })');
  });
});
