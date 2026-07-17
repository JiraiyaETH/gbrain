import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeShellSubagentHandler, __testing } from '../src/core/minions/handlers/shell-subagent.ts';
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
        dream_output_cycle_date: '2026-07-15',
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
    expect(allowed!.frontmatter.dream_generated).toBe(true);
    expect(allowed!.frontmatter.dream_cycle_date).toBe('2026-07-15');

    const disallowed = await engine.getPage('wiki/private/not-allowed');
    expect(disallowed).toBeNull();
  });
});

describe('shell-subagent claude -p model wiring', () => {
  test('buildClaudeArgs appends --model only when a model is pinned', () => {
    expect(__testing.buildClaudeArgs('claude-opus-4-8')).toEqual(['-p', '--model', 'claude-opus-4-8']);
    expect(__testing.buildClaudeArgs(null)).toEqual(['-p']);
  });

  test('resolveCliModel strips the provider prefix the queue validator requires', () => {
    // Dream cycle stores provider-qualified ids; claude --model wants the bare id.
    expect(__testing.resolveCliModel('anthropic:claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(__testing.resolveCliModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    // Absent / empty → null → no --model flag (preserves legacy default behavior).
    expect(__testing.resolveCliModel(undefined)).toBeNull();
    expect(__testing.resolveCliModel('')).toBeNull();
    expect(__testing.resolveCliModel('   ')).toBeNull();
  });

  test('a pinned payload model reaches the spawned claude -p as --model', () => {
    // End-to-end through resolveCliModel → buildClaudeArgs: the exact argv the
    // spawn receives for a dream writer job carrying the Opus 4.8 pin.
    const payloadModel = 'anthropic:claude-opus-4-8';
    const argv = __testing.buildClaudeArgs(__testing.resolveCliModel(payloadModel));
    expect(argv).toEqual(['-p', '--model', 'claude-opus-4-8']);
  });
});
