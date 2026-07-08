import { describe, expect, test } from 'bun:test';
import { shouldDispatchFullCycle } from '../src/commands/autopilot.ts';

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
