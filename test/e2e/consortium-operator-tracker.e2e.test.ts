// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

const SCRIPT = 'skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs';

describe('consortium-operator-tracker e2e command-planning smoke', () => {
  it('turns a status update request into the exact non-mutating OpenClaw command plan', () => {
    const proc = spawnSync('bun', [SCRIPT, '--update', '--protocol', 'Ankr', '--outreach-status', 'Form sent', '--dry-run'], {
      cwd: '/Users/jarvis/gbrain',
      encoding: 'utf8',
    });
    expect(proc.status).toBe(0);
    const payload = JSON.parse(proc.stdout);
    expect(payload.action).toBe('update');
    expect(payload.command).toEqual([
      'python3',
      '/Users/jarvis/.openclaw-jarvis-v2/ops/consortium/update_operator_friendly_status.py',
      '--protocol',
      'Ankr',
      '--outreach-status',
      'Form sent',
      '--dry-run',
    ]);
  });
});
