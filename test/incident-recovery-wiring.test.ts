import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const cycleSource = source('../src/core/cycle.ts');
const synthesizeSource = source('../src/core/cycle/synthesize.ts');
const jobsSource = source('../src/commands/jobs.ts');
const fanoutSource = source('../src/commands/autopilot-fanout.ts');
const autopilotSource = source('../src/commands/autopilot.ts');

describe('incident recovery wiring (dependency-free)', () => {
  test('transcript cooldown and canonical idempotency keys are corpus-global', () => {
    expect(synthesizeSource).toContain("return 'dream.synthesize.last_completion_ts';");
    expect(synthesizeSource).toContain('const base = `dream:synth:${filePath}:${hash16}`;');
    expect(synthesizeSource).not.toContain('`dream:synth:${sourceId}:${filePath}:${hash16}`');
  });

  test('Autopilot owns an explicit phase set with manual-only phases removed', () => {
    expect(cycleSource).toContain("export const AUTOPILOT_EXCLUDED_PHASES: readonly CyclePhase[] = ['synthesize', 'patterns', 'extract_atoms'];");
    expect(cycleSource).toContain('export const AUTOPILOT_PHASES: CyclePhase[] = ALL_PHASES.filter');
    expect(cycleSource).toContain('export function selectAutopilotPhases(');
  });

  test('queued Autopilot dispatch and handler boundaries use only Autopilot phase sets', () => {
    expect(fanoutSource).toContain('phases: AUTOPILOT_PHASES');
    expect(fanoutSource).toContain('phases: AUTOPILOT_NON_GLOBAL_PHASES');
    expect(fanoutSource).toContain('phases: AUTOPILOT_GLOBAL_PHASES');
    expect(jobsSource).toContain('selectAutopilotPhases(job.data.phases');
    expect(jobsSource).toContain("reason: 'no_autopilot_phases'");
  });

  test('inline and targeted Autopilot paths are guarded', () => {
    expect(autopilotSource).toContain('phases: AUTOPILOT_PHASES');
    expect(autopilotSource).toContain('filterAutopilotPlanSteps(unfilteredPlan)');
    expect(autopilotSource).not.toContain("queue.add(\n                      'extract-atoms-drain'");
  });

  test('per-source freshness fanout is not coalesced queue-wide', () => {
    const freshnessBlock = autopilotSource.match(/v0\.40 D17: per-source freshness check[\s\S]*?Cheap path:/)?.[0];
    expect(freshnessBlock).toBeDefined();
    expect(freshnessBlock).not.toContain('maxWaiting');
  });
});
