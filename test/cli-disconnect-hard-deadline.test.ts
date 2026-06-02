import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { disconnectEngineWithHardDeadline } from '../src/core/cli-disconnect.ts';

function fakeEngine(disconnect: () => Promise<void>): BrainEngine {
  return { disconnect } as unknown as BrainEngine;
}

describe('disconnectEngineWithHardDeadline', () => {
  test('awaits a clean disconnect without forcing exit', async () => {
    let disconnected = false;
    let exitCode: number | null = null;

    await disconnectEngineWithHardDeadline(fakeEngine(async () => {
      disconnected = true;
    }), {
      label: 'test clean',
      deadlineMs: 25,
      exit: (code) => { exitCode = code; },
      warn: () => {},
    });

    expect(disconnected).toBe(true);
    expect(exitCode).toBeNull();
  });

  test('forces non-daemon CLI exit when disconnect hangs', async () => {
    let exitCode: number | null = null;
    const warnings: string[] = [];

    const result = await disconnectEngineWithHardDeadline(fakeEngine(() => new Promise<void>(() => {})), {
      label: 'gbrain onboard',
      deadlineMs: 10,
      exit: (code) => { exitCode = code; },
      warn: (line) => warnings.push(line),
    });

    expect(result.outcome).toBe('forced_exit');
    expect(exitCode).toBe(0);
    expect(warnings.join('\n')).toContain('gbrain onboard');
    expect(warnings.join('\n')).toContain('force-exiting');
  });

  test('preserves a pre-set nonzero exit code when forced', async () => {
    const previous = process.exitCode;
    let exitCode: number | null = null;
    process.exitCode = 7;
    try {
      await disconnectEngineWithHardDeadline(fakeEngine(() => new Promise<void>(() => {})), {
        label: 'gbrain import',
        deadlineMs: 10,
        exit: (code) => { exitCode = code; },
        warn: () => {},
      });
    } finally {
      process.exitCode = previous ?? 0;
    }

    expect(exitCode).toBe(7);
  });
});
