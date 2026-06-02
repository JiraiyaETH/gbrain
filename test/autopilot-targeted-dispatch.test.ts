import { describe, expect, test } from 'bun:test';
import { selectDispatchableTargetedSteps } from '../src/commands/autopilot.ts';
import type { RemediationStep } from '../src/core/remediation-step.ts';

function step(id: string, depends_on: string[] = []): RemediationStep {
  return {
    id,
    job: id.split('.')[0] ?? id,
    params: {},
    idempotency_key: `test:${id}`,
    severity: 'medium',
    est_seconds: 1,
    est_usd_cost: 0,
    depends_on,
    rationale: id,
    status: 'remediable',
  };
}

describe('selectDispatchableTargetedSteps', () => {
  test('does not flatten same-plan dependencies in one autopilot tick', () => {
    const plan = [
      step('sync.repo'),
      step('embed.stale', ['sync.repo']),
      step('extract.all', ['sync.repo']),
    ];

    const selected = selectDispatchableTargetedSteps(plan);

    expect(selected.dispatch.map(s => s.id)).toEqual(['sync.repo']);
    expect(selected.deferred.map(s => s.id).sort()).toEqual(['embed.stale', 'extract.all']);
  });

  test('dispatches dependent work when its dependency is absent from this tick plan', () => {
    const plan = [step('embed.stale', ['sync.repo'])];

    const selected = selectDispatchableTargetedSteps(plan);

    expect(selected.dispatch.map(s => s.id)).toEqual(['embed.stale']);
    expect(selected.deferred).toEqual([]);
  });
});
