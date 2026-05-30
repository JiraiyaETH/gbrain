import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getAutopilotStatusSnapshot, resolveAutopilotControlCommand } from '../src/commands/autopilot.ts';
import { withEnv } from './helpers/with-env.ts';

describe('resolveAutopilotControlCommand', () => {
  test('treats positional status as read-only status, not daemon start', () => {
    expect(resolveAutopilotControlCommand(['status'])).toBe('status');
    expect(resolveAutopilotControlCommand(['status', '--json'])).toBe('status');
  });

  test('keeps flag spelling compatible', () => {
    expect(resolveAutopilotControlCommand(['--status'])).toBe('status');
    expect(resolveAutopilotControlCommand(['--install'])).toBe('install');
    expect(resolveAutopilotControlCommand(['--uninstall'])).toBe('uninstall');
  });

  test('supports positional install and uninstall without misreading option values', () => {
    expect(resolveAutopilotControlCommand(['install', '--repo', '/tmp/brain'])).toBe('install');
    expect(resolveAutopilotControlCommand(['uninstall'])).toBe('uninstall');
    expect(resolveAutopilotControlCommand(['--repo', 'status', '--interval', '300'])).toBeUndefined();
  });
});

describe('getAutopilotStatusSnapshot', () => {
  test('reports lock state read-only without creating or removing the lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-status-'));
    const gbrainDir = join(root, '.gbrain');
    const lockPath = join(gbrainDir, 'autopilot.lock');
    try {
      await withEnv({ GBRAIN_HOME: root }, async () => {
        mkdirSync(gbrainDir, { recursive: true });
        writeFileSync(lockPath, String(process.pid));
        const now = Date.now();
        const mtime = new Date(now - 11 * 60 * 1000);
        utimesSync(lockPath, mtime, mtime);

        const snapshot = getAutopilotStatusSnapshot(now);

        expect(snapshot.lock.exists).toBe(true);
        expect(snapshot.lock.path).toBe(lockPath);
        expect(snapshot.lock.pid).toBe(process.pid);
        expect(snapshot.lock.pid_alive).toBe(true);
        expect(snapshot.lock.stale).toBe(true);
        expect(snapshot.lock.age_seconds).toBeGreaterThanOrEqual(660);
        expect(snapshot.installed).toBe(false);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
