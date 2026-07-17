/**
 * Tests for registerBuiltinHandlers in src/commands/jobs.ts.
 *
 * Covers:
 *   - Every expected handler name is registered.
 *   - autopilot-cycle handler returns { partial, status, report } (v0.17
 *     runCycle-backed shape) when any step fails — does NOT throw itself
 *     (critical invariant: an intermittent phase failure must not cause
 *     the Minion to retry and block every future cycle).
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let worker: MinionWorker;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  worker = new MinionWorker(engine, { queue: 'test' });
  await registerBuiltinHandlers(worker, engine);
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('registerBuiltinHandlers', () => {
  test('registers all built-in handler names', () => {
    const names = worker.registeredNames;
    // Existing handlers from pre-v0.11.1
    expect(names).toContain('sync');
    expect(names).toContain('embed');
    expect(names).toContain('lint');
    expect(names).toContain('import');
    // New in v0.11.1 (Tier 1 + autopilot-cycle)
    expect(names).toContain('extract');
    expect(names).toContain('backlinks');
    expect(names).toContain('autopilot-cycle');
  });

  test('total handler count includes all 7 names', () => {
    expect(worker.registeredNames.length).toBeGreaterThanOrEqual(7);
  });
});

describe('autopilot-cycle handler — partial failure does NOT throw', () => {
  test('phase failure returns partial:true + structured report, no throw', async () => {
    // Call the handler directly with a job pointing at a nonexistent repo.
    // Filesystem-dependent phases (lint, backlinks, sync) all fail because
    // the dir / .git repo isn't there. DB-dependent phases (extract,
    // embed, orphans) run fine against the in-memory test engine.
    //
    // CRITICAL INVARIANT: the handler must return successfully even when
    // phases fail. Throwing would cause the Minion to retry, blocking
    // every future cycle on an intermittent bug. v0.17 moves this
    // guarantee into runCycle itself (per-phase try/catch in cycle.ts).
    const handler = (worker as any).handlers.get('autopilot-cycle');
    expect(handler).toBeDefined();

    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-autopilot-test' },
      signal: { aborted: false } as any,
      job: { id: 1, name: 'autopilot-cycle' } as any,
    });

    expect(result).toBeDefined();
    expect((result as any).partial).toBe(true);
    // v0.17 shape: { partial, status, report }. The report's phases array
    // replaces the old failed_steps list.
    expect(['partial', 'failed']).toContain((result as any).status);
    const report = (result as any).report;
    expect(report).toBeDefined();
    expect(report.schema_version).toBe('1');
    expect(Array.isArray(report.phases)).toBe(true);
    expect(report.phases.map((p: any) => p.phase)).not.toContain('synthesize');
    expect(report.phases.map((p: any) => p.phase)).not.toContain('patterns');
    expect(report.phases.map((p: any) => p.phase)).not.toContain('extract_atoms');
    // The filesystem-dependent phases should have failed on a missing dir.
    const failedPhases = report.phases
      .filter((p: any) => p.status === 'fail')
      .map((p: any) => p.phase);
    expect(failedPhases).toContain('lint');
    expect(failedPhases).toContain('backlinks');
    expect(failedPhases).toContain('sync');
  });

  test('all phases succeed → result has structured report (smoke)', async () => {
    // Smoke: invoke against a real (if empty) git repo. If every phase
    // completes (or gracefully skips), the handler returns a result
    // object with the full runCycle report. Some phases may still warn
    // (empty repo has nothing to lint/sync) — the invariant is that the
    // handler never throws.
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-autopilot-cycle-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      const result = await handler({
        data: { repoPath: dir },
        signal: { aborted: false } as any,
        job: { id: 2, name: 'autopilot-cycle' } as any,
      });
      // The handler MUST return a result object, never throw, regardless
      // of individual phase outcomes.
      expect(result).toBeDefined();
      expect(typeof (result as any).partial).toBe('boolean');
      expect('report' in (result as any)).toBe(true);
      expect((result as any).report.schema_version).toBe('1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('autopilot-cycle handler — phase passthrough', () => {
  test('job.data.phases restricts which phases run', async () => {
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-phase-pass-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      // Request only lint and sync — embed should NOT appear
      const result = await handler({
        data: { repoPath: dir, phases: ['lint', 'sync'] },
        signal: { aborted: false } as any,
        job: { id: 10, name: 'autopilot-cycle' } as any,
      });

      expect(result).toBeDefined();
      const report = (result as any).report;
      expect(report).toBeDefined();
      const phaseNames = report.phases.map((p: any) => p.phase);
      expect(phaseNames).toContain('lint');
      expect(phaseNames).toContain('sync');
      // Phases NOT requested must be absent
      expect(phaseNames).not.toContain('embed');
      expect(phaseNames).not.toContain('extract');
      expect(phaseNames).not.toContain('backlinks');
      expect(phaseNames).not.toContain('orphans');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('invalid phase names in job.data.phases are filtered out', async () => {
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-phase-invalid-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      // Mix valid and bogus names — only 'lint' should survive filtering
      const result = await handler({
        data: { repoPath: dir, phases: ['lint', 'BOGUS', 'rm -rf /'] },
        signal: { aborted: false } as any,
        job: { id: 11, name: 'autopilot-cycle' } as any,
      });

      const report = (result as any).report;
      const phaseNames = report.phases.map((p: any) => p.phase);
      expect(phaseNames).toContain('lint');
      expect(phaseNames).not.toContain('BOGUS');
      expect(phaseNames.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('empty phases array falls back to the Autopilot-safe phase set', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-phase-test', phases: [] },
      signal: { aborted: false } as any,
      job: { id: 12, name: 'autopilot-cycle' } as any,
    });

    const report = (result as any).report;
    // With all phases, filesystem phases fail on missing dir
    const phaseNames = report.phases.map((p: any) => p.phase);
    expect(phaseNames).toContain('lint');
    expect(phaseNames).toContain('backlinks');
    expect(phaseNames).toContain('sync');
    expect(phaseNames).not.toContain('synthesize');
    expect(phaseNames).not.toContain('patterns');
    expect(phaseNames).not.toContain('extract_atoms');
  }, 30_000);

  test('non-array phases value falls back to the Autopilot-safe phase set', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    // String instead of array — should be ignored
    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-phase-test', phases: 'lint' },
      signal: { aborted: false } as any,
      job: { id: 13, name: 'autopilot-cycle' } as any,
    });

    const report = (result as any).report;
    const phaseNames = report.phases.map((p: any) => p.phase);
    // Should have all phases since the string was ignored
    expect(phaseNames).toContain('lint');
    expect(phaseNames).toContain('sync');
    expect(phaseNames).toContain('embed');
    expect(phaseNames).not.toContain('synthesize');
    expect(phaseNames).not.toContain('patterns');
    expect(phaseNames).not.toContain('extract_atoms');
  }, 30_000);

  test('stale explicit payload cannot execute manual-only phases', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    const result = await handler({
      data: {
        repoPath: '/definitely-does-not-exist-for-phase-test',
        phases: ['lint', 'synthesize', 'patterns', 'extract_atoms'],
      },
      signal: { aborted: false } as any,
      job: { id: 14, name: 'autopilot-cycle' } as any,
    });

    expect(result.report.phases.map((p: any) => p.phase)).toEqual(['lint']);
  }, 30_000);

  test('manual-only explicit payload is rejected without running a cycle', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    const result = await handler({
      data: {
        repoPath: '/definitely-does-not-exist-for-phase-test',
        phases: ['synthesize', 'patterns', 'extract_atoms'],
      },
      signal: { aborted: false } as any,
      job: { id: 15, name: 'autopilot-cycle' } as any,
    });

    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('no_autopilot_phases');
  }, 30_000);
});

describe('dedicated Dream phase handlers remain explicit execution lanes', () => {
  for (const phase of ['synthesize', 'patterns']) {
    test(`${phase} handler still delegates to runCycle`, async () => {
      const handler = (worker as any).handlers.get(phase);
      expect(handler).toBeDefined();
      const result = await handler({
        data: { repoPath: '/definitely-does-not-exist-for-dream-handler-test' },
        signal: { aborted: false } as any,
        job: { id: 20, name: phase } as any,
      });
      expect(result.phase).toBe(phase);
      expect(result.report.phases.map((p: any) => p.phase)).toEqual([phase]);
    }, 30_000);
  }

  test('protected extract-atoms drain handler remains registered for explicit/manual use', () => {
    expect((worker as any).handlers.get('extract-atoms-drain')).toBeDefined();
  });
});
