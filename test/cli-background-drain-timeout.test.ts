/**
 * Facts queue model-call regression guard.
 *
 * Queue-mode facts extraction forwards the queue AbortSignal into gateway.chat.
 * A too-short CLI-exit background drain turns normal model latency into
 * facts:absorb `pipeline_error: [chat(...)] The operation was aborted.` rows,
 * while inline extract_facts keeps working. This pins the model-call-sized drain
 * budget on both local-op and CLI_ONLY disconnect paths.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLI = readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf-8');

describe('CLI background facts drain timeout', () => {
  test('local operation and CLI_ONLY paths both wait long enough for a normal facts model call', () => {
    const drainConstants = [...CLI.matchAll(/const BACKGROUND_DRAIN_TIMEOUT_MS = ([0-9_]+);/g)]
      .map((m) => Number(m[1].replace(/_/g, '')));
    expect(drainConstants.length).toBeGreaterThanOrEqual(2);
    expect(drainConstants.every((n) => n >= 30_000)).toBe(true);

    const drainCalls = [...CLI.matchAll(/drainAllBackgroundWorkForCliExit\(\{ timeoutMs: BACKGROUND_DRAIN_TIMEOUT_MS \}\)/g)];
    expect(drainCalls.length).toBeGreaterThanOrEqual(2);
  });

  test('hard disconnect deadline is longer than the background drain window', () => {
    const drainConstants = [...CLI.matchAll(/const BACKGROUND_DRAIN_TIMEOUT_MS = ([0-9_]+);/g)]
      .map((m) => Number(m[1].replace(/_/g, '')));
    const hardDeadlines = [...CLI.matchAll(/const DISCONNECT_HARD_DEADLINE_MS = ([0-9_]+);/g)]
      .map((m) => Number(m[1].replace(/_/g, '')));

    expect(hardDeadlines.length).toBeGreaterThanOrEqual(2);
    for (const [i, drain] of drainConstants.entries()) {
      expect(hardDeadlines[i]).toBeGreaterThan(drain);
    }
  });
});
