import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('MinionWorker stalled/timeout detector sweep', () => {
  test('does not use overlapping async setInterval sweeps', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/core/minions/worker.ts'), 'utf8');
    expect(source).not.toMatch(/setInterval\(async\s*\(\)\s*=>\s*\{[\s\S]{0,500}?handleStalled\(\)/);
    expect(source).toContain('stalledSweepInFlight');
    expect(source).toContain('callbacks multiply pooler pressure');
  });
});
