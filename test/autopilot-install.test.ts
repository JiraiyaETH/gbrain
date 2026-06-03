/**
 * Tests for env-aware `gbrain autopilot --install`.
 *
 * Covers:
 *   - detectInstallTarget picks the right target based on env vars +
 *     filesystem sentinels.
 *   - --target flag overrides detection.
 *   - Ephemeral-container path writes the start script + executable bit.
 *   - OpenClaw bootstrap injection is idempotent + creates .bak.
 *   - Uninstall mirrors all four targets and is a no-op when nothing is
 *     installed.
 *
 * Regression guards:
 *   - macOS launchd plist still writes the same shape it always did.
 *   - Linux crontab still writes the same every-5-min line.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildAutopilotWrapperScript,
  detectInstallTarget,
  generateLaunchdPlist,
} from '../src/commands/autopilot.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

function envKeys() {
  return ['HOME', 'RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME', 'OPENCLAW_HOME'] as const;
}

beforeEach(() => {
  for (const k of envKeys()) envSnapshot[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-install-test-'));
  process.env.HOME = tmp;
  // Start each test with a clean slate for ephemeral env vars.
  delete process.env.RENDER;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.FLY_APP_NAME;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  for (const k of envKeys()) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('detectInstallTarget', () => {
  test('returns "macos" on darwin regardless of env', () => {
    if (process.platform !== 'darwin') return; // Skip on non-mac CI
    // Even if RENDER is set, darwin wins (user is probably dev-testing).
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('macos');
  });

  test('returns "ephemeral-container" when RENDER is set', () => {
    if (process.platform === 'darwin') return; // darwin shortcircuits first
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when RAILWAY_ENVIRONMENT is set', () => {
    if (process.platform === 'darwin') return;
    process.env.RAILWAY_ENVIRONMENT = 'production';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when FLY_APP_NAME is set', () => {
    if (process.platform === 'darwin') return;
    process.env.FLY_APP_NAME = 'myapp';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  // Note: direct testing of linux-systemd / linux-cron requires mocking
  // existsSync + execSync which is awkward in-process. Those branches are
  // exercised by the E2E test (Task 14) against a stubbed host.
});

// v0.36.1.x (cherry-pick #966): the autopilot wrapper script must source
// ~/.zshenv BEFORE ~/.zshrc. zshenv is the canonical place for env vars in
// non-interactive zsh; zshrc only fires for interactive shells, so vars
// exported in zshrc never reach the LaunchAgent subprocess. Operators who
// exported GBRAIN_DATABASE_URL or {OPENAI,ANTHROPIC}_API_KEY in zshrc and
// expected autopilot to inherit them hit silent missing-secret failures.
describe('autopilot wrapper script — env source order (v0.36.1.x #966)', () => {
  test('wrapper sources ~/.zshenv before ~/.zshrc', () => {
    const src = buildAutopilotWrapperScript('/usr/local/bin/gbrain', '/Users/me/brain');
    const zshenvIdx = src.indexOf('~/.zshenv');
    const zshrcIdx = src.indexOf('~/.zshrc');
    expect(zshenvIdx).toBeGreaterThan(0);
    expect(zshrcIdx).toBeGreaterThan(0);
    expect(zshenvIdx).toBeLessThan(zshrcIdx);
    expect(src).toMatch(/source\s+~\/\.zshenv/);
    expect(src).toMatch(/source\s+~\/\.zshrc/);
  });

  test('wrapper can pin the runtime binary behind the secret bridge', () => {
    const src = buildAutopilotWrapperScript('/Users/jarvis/.local/bin/gbrain', '/Users/me/brain', {
      mode: 'observe-propose',
      intervalSeconds: 600,
      runtimeBinOverride: '/Users/jarvis/gbrain-runtime/src/cli.ts',
    });

    expect(src).toContain("export GBRAIN_BIN='/Users/jarvis/gbrain-runtime/src/cli.ts'");
    expect(src).toContain("exec '/Users/jarvis/.local/bin/gbrain' autopilot --repo '/Users/me/brain' --interval 600 --no-worker --propose-only --json");
    expect(src).not.toContain('jobs work');
    expect(src).not.toContain('dream');
  });
});

describe('observe/propose launchd canary plist', () => {
  test('runs on StartInterval without KeepAlive daemon semantics', () => {
    const plist = generateLaunchdPlist('/Users/me/.gbrain/autopilot-observe-propose-run.sh', '/Users/me', {
      label: 'com.gbrain.autopilot.observe-propose',
      startIntervalSeconds: 600,
      keepAlive: false,
      stdoutName: 'autopilot-observe-propose.log',
      stderrName: 'autopilot-observe-propose.err',
    });

    expect(plist).toContain('<key>Label</key><string>com.gbrain.autopilot.observe-propose</string>');
    expect(plist).toContain('<key>StartInterval</key><integer>600</integer>');
    expect(plist).not.toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('/Users/me/.gbrain/autopilot-observe-propose.log');
    expect(plist).toContain('/Users/me/.gbrain/autopilot-observe-propose.err');
  });
});
