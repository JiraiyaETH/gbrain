/** Incident policy: extract_atoms is explicit/manual only, never Autopilot. */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');
const JOBS_SRC = readFileSync(join(import.meta.dir, '../src/commands/jobs.ts'), 'utf8');
const DREAM_SRC = readFileSync(join(import.meta.dir, '../src/commands/dream.ts'), 'utf8');

describe('Autopilot extract_atoms exclusion', () => {
  test('Autopilot has no extract-atoms drain submission lane', () => {
    expect(SRC).not.toContain('autopilot-extract-atoms-drain:');
    expect(SRC).not.toContain("queue.add(\n                      'extract-atoms-drain'");
    expect(SRC).not.toContain('dispatch.auto-drain');
  });

  test('explicit/manual drain surfaces remain available', () => {
    expect(JOBS_SRC).toContain("worker.register('extract-atoms-drain'");
    expect(DREAM_SRC).toContain('runExtractAtomsDrainForSource');
  });
});
