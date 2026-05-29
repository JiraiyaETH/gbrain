import { describe, expect, test } from 'bun:test';

import { resolveAutopilotControlCommand } from '../src/commands/autopilot.ts';

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
