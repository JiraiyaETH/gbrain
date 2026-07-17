import { describe, expect, test } from 'bun:test';
import {
  shouldDispatchFullCycle,
  shouldDispatchSyncFreshnessForSource,
} from '../src/commands/autopilot.ts';

describe('autopilot full-cycle dispatch predicate', () => {
  test('stale per-source cycle freshness forces fan-out even when score plan is targeted-sized', () => {
    expect(shouldDispatchFullCycle({
      score: 85,
      planLength: 2,
      estTotalSeconds: 120,
      minutesSinceLastFull: 10,
      fullCycleFloorMin: 60,
      hasStaleCycleSources: true,
    })).toBe(true);
  });

  test('score 85 with a small plan and fresh cycle markers stays targeted mode', () => {
    expect(shouldDispatchFullCycle({
      score: 85,
      planLength: 2,
      estTotalSeconds: 120,
      minutesSinceLastFull: 10,
      fullCycleFloorMin: 60,
      hasStaleCycleSources: false,
    })).toBe(false);
  });
});

describe('autopilot sync-freshness fan-out predicate', () => {
  test('code-strategy sources are not sync freshness targets', () => {
    expect(shouldDispatchSyncFreshnessForSource({
      local_path: '/repo',
      config: { strategy: 'code' },
    })).toBe(false);
  });

  test('non-code local sources remain sync freshness targets', () => {
    expect(shouldDispatchSyncFreshnessForSource({
      local_path: '/repo',
      config: { federated: true },
    })).toBe(true);
  });

  test('isolated local sources are not sync freshness targets', () => {
    expect(shouldDispatchSyncFreshnessForSource({
      local_path: '/repo',
      config: { federated: false },
    })).toBe(false);
  });

  test('sources without local_path are not sync freshness targets', () => {
    expect(shouldDispatchSyncFreshnessForSource({
      local_path: null,
      config: { federated: true },
    })).toBe(false);
  });
});
