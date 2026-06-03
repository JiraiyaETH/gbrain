import { describe, expect, test } from 'bun:test';
import {
  buildAutopilotJobProposal,
  buildAutopilotFreshnessSyncData,
  isAutopilotProposeOnly,
  selectAutopilotFreshnessSources,
  selectDispatchableTargetedSteps,
  submitOrProposeAutopilotJob,
} from '../src/commands/autopilot.ts';
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

  test('autopilot freshness sync does not auto-enqueue unbounded embed backfill', () => {
    const data = buildAutopilotFreshnessSyncData({
      id: 'default',
      local_path: '/brain',
    });

    expect(data).toEqual({
      sourceId: 'default',
      repoPath: '/brain',
      auto_embed_backfill: false,
      embed_reason: 'autopilot_freshness',
    });
  });

  test('repo-scoped autopilot freshness only targets the resolved source by default', () => {
    const sources = [
      { id: 'default', local_path: '/brain' },
      { id: 'gbrain-runtime-code', local_path: '/code' },
    ];

    expect(selectAutopilotFreshnessSources(sources, 'default').map((s) => s.id)).toEqual(['default']);
  });

  test('autopilot freshness can still be widened explicitly to all local sources', () => {
    const sources = [
      { id: 'default', local_path: '/brain' },
      { id: 'gbrain-runtime-code', local_path: '/code' },
    ];

    expect(selectAutopilotFreshnessSources(sources, 'default', { allSources: true }).map((s) => s.id))
      .toEqual(['default', 'gbrain-runtime-code']);
  });

  test('observe and propose-only aliases enter non-mutating proposal mode', () => {
    expect(isAutopilotProposeOnly(['--observe'])).toBe(true);
    expect(isAutopilotProposeOnly(['--propose-only'])).toBe(true);
    expect(isAutopilotProposeOnly(['--status'])).toBe(false);
  });

  test('proposal payload preserves the exact job data and submit options', () => {
    const proposal = buildAutopilotJobProposal({
      mode: 'targeted',
      job: 'embed-backfill',
      params: { sourceId: 'default', batchSize: 1, maxChunks: 1 },
      submitOptions: {
        queue: 'default',
        idempotency_key: 'autopilot:embed:default:test',
        max_attempts: 2,
        timeout_ms: 300_000,
        maxWaiting: 1,
      },
      metadata: {
        step: 'embed.stale',
        score: 76,
        plan_size: 1,
        protected: true,
      },
    });

    expect(proposal).toEqual({
      event: 'proposed',
      mode: 'targeted',
      job: 'embed-backfill',
      params: { sourceId: 'default', batchSize: 1, maxChunks: 1 },
      submit_options: {
        queue: 'default',
        idempotency_key: 'autopilot:embed:default:test',
        max_attempts: 2,
        timeout_ms: 300_000,
        maxWaiting: 1,
      },
      step: 'embed.stale',
      score: 76,
      plan_size: 1,
      protected: true,
    });
  });

  test('proposal mode never calls queue.add', async () => {
    let addCalls = 0;
    const queue = {
      add: async () => {
        addCalls += 1;
        throw new Error('queue.add must not run in proposal mode');
      },
    };
    const proposal = buildAutopilotJobProposal({
      mode: 'freshness',
      job: 'sync',
      params: buildAutopilotFreshnessSyncData({ id: 'default', local_path: '/brain' }),
      submitOptions: {
        queue: 'default',
        idempotency_key: 'autopilot-sync:default:test',
        max_attempts: 2,
        timeout_ms: 300_000,
        maxWaiting: 1,
      },
      metadata: { source_id: 'default', age_ms: 60_000 },
    });

    const result = await submitOrProposeAutopilotJob({
      queue,
      proposeOnly: true,
      job: 'sync',
      params: proposal.params,
      submitOptions: proposal.submit_options,
      proposal,
    });

    expect(addCalls).toBe(0);
    expect(result.kind).toBe('proposed');
    if (result.kind !== 'proposed') throw new Error('expected proposal result');
    expect(result.proposal).toEqual(proposal);
  });
});
