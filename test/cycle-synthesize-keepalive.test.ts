/**
 * Regression coverage for Dream canary parent/child finalization plumbing.
 *
 * The 2026-06-01 production stall had a parent dream-canary job blocked in
 * synthesize child wait after the child subagent had already written pages.
 * The parent cycle must pass the wrapped in-phase keepalive and abort signal
 * into synthesize so child waits can refresh the cycle/job lease and unwind
 * cleanly if the parent is cancelled or loses its lock.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cycleSource = readFileSync(join(import.meta.dir, '../src/core/cycle.ts'), 'utf8');
const synthesizeSource = readFileSync(join(import.meta.dir, '../src/core/cycle/synthesize.ts'), 'utf8');

describe('Dream synthesize parent/child keepalive plumbing', () => {
  test('runCycle passes wrapped keepalive and parent abort signal into synthesize', () => {
    const synthesizeCall = cycleSource.slice(
      cycleSource.indexOf("const { runPhaseSynthesize }"),
      cycleSource.indexOf('// ── Phase 5: extract'),
    );

    expect(synthesizeCall).toContain('yieldDuringPhase: buildYieldDuringPhase(lock, opts.yieldDuringPhase)');
    expect(synthesizeCall).toContain('signal: opts.signal');
    expect(synthesizeCall).not.toContain('yieldDuringPhase: opts.yieldDuringPhase,');
  });

  test('synthesize child waits poll with keepalive hook and parent abort signal', () => {
    const childWaitBlock = synthesizeSource.slice(
      synthesizeSource.indexOf('const keepaliveDuringChildWait'),
      synthesizeSource.indexOf('// Collect slugs from put_page tool executions'),
    );

    expect(childWaitBlock).toContain('const keepaliveDuringChildWait = async () =>');
    expect(childWaitBlock).toContain('if (now - lastKeepaliveAt < 30_000) return;');
    expect(childWaitBlock).toContain('signal: opts.signal');
    expect(childWaitBlock).toContain('onPoll: keepaliveDuringChildWait');
  });
});
