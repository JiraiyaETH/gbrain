import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeShellSubagentHandler } from '../src/core/minions/handlers/shell-subagent.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function makeCtx(data: Record<string, unknown>): MinionJobContext {
  return {
    id: 977,
    name: 'shell-subagent',
    data,
    attempts_made: 0,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

describe('shell-subagent handler', () => {
  test('shell-subagent is protected at queue submission', async () => {
    await engine.setConfig('version', '119');
    const queue = new MinionQueue(engine);
    await expect(queue.add('shell-subagent', { prompt: 'noop' })).rejects.toThrow(/protected job name/);

    const job = await queue.add(
      'shell-subagent',
      { prompt: 'noop' },
      undefined,
      { allowProtectedSubmit: true },
    );
    expect(job.name).toBe('shell-subagent');
  });

  test('writes allowed page blocks, rejects disallowed slugs, and strips ANTHROPIC_API_KEY', async () => {
    const fakeClaude = join(import.meta.dir, 'fixtures', 'fake-claude-bin.sh');
    await engine.setConfig('dream.synthesize.claude_bin', fakeClaude);

    const handler = makeShellSubagentHandler({
      engine,
      config: {} as GBrainConfig,
    });

    const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-should-not-leak' }, async () => {
      return handler(makeCtx({
        prompt: 'Synthesize this transcript.',
        allowed_slug_prefixes: ['wiki/personal/reflections/*'],
      }));
    });

    expect(result.result).toContain('anthropic_present=no');
    expect(result.written_slugs).toEqual([
      'wiki/personal/reflections/2026-04-25-allowed-abc123',
    ]);
    expect(result.rejected_slugs).toHaveLength(1);
    expect(result.rejected_slugs[0]!.slug).toBe('wiki/private/not-allowed');
    expect(result.rejected_slugs[0]!.reason).toMatch(/allow-list/i);

    const allowed = await engine.getPage('wiki/personal/reflections/2026-04-25-allowed-abc123');
    expect(allowed).not.toBeNull();
    expect(allowed!.title).toBe('Allowed Reflection');

    const disallowed = await engine.getPage('wiki/private/not-allowed');
    expect(disallowed).toBeNull();
  });
});
