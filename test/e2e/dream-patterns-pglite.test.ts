/**
 * E2E patterns phase — PGLite, no API key required.
 *
 * Mirrors the per-test-rig pattern from dream-synthesize-pglite.test.ts.
 * Each test creates and tears down its own PGLite engine to avoid
 * cross-test contention (CLAUDE.md issue #223 macOS WASM bug).
 *
 * Covers the runPhasePatterns skip paths that don't require a real
 * Anthropic call:
 *   - disabled: dream.patterns.enabled=false → skipped
 *   - insufficient_evidence: <min_evidence reflections → skipped
 *   - no_provider: enough reflections, no reachable provider for the
 *     resolved patterns model (default: Anthropic with no key in env OR
 *     config) → skipped
 *   - dry-run: passes through with reflections_considered + zero pages
 *
 * The Sonnet detection path is structurally covered in
 * test/cycle-patterns.test.ts (asserts queue + waitForCompletion are
 * wired, allow-list reads from filing-rules JSON, slug provenance from
 * subagent_tool_executions, no raw_data dependency).
 *
 * Run: bun test test/e2e/dream-patterns-pglite.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { withoutAnthropicKey } from '../helpers/no-anthropic-key.ts';

interface TestRig {
  engine: PGLiteEngine;
  brainDir: string;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  return {
    engine,
    brainDir: '/tmp/gbrain-patterns-test',
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* */ }
    },
  };
}

/**
 * Insert N reflection pages directly via engine.putPage so the patterns
 * gather query has data without going through the synthesize phase.
 * Slugs follow the route-driven personal/reflections/<topic>-<hash> shape.
 */
async function seedReflections(engine: PGLiteEngine, count: number, sourceId = 'default'): Promise<void> {
  for (let i = 0; i < count; i++) {
    const slug = `personal/reflections/2026-04-${String(15 + i).padStart(2, '0')}-test-pattern-aaa${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Reflection ${i}`,
      compiled_truth: `Sample reflection content ${i} discussing recurring theme of work-life balance.`,
      timeline: '',
      frontmatter: { type: 'note', title: `Reflection ${i}` },
    }, { sourceId });
  }
}

async function withSubagentAutoCancel<T>(engine: PGLiteEngine, body: () => Promise<T>): Promise<T> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await engine.executeRaw(
        `UPDATE minion_jobs
            SET status = 'cancelled', finished_at = now()
          WHERE name IN ('subagent', 'shell-subagent')
            AND status IN ('waiting', 'active')`,
      ).catch(() => {});
    }
  })();
  try {
    return await body();
  } finally {
    stopped = true;
    await loop;
  }
}

describe('E2E patterns — disabled', () => {
  test('skipped when dream.patterns.enabled=false', async () => {
    // 30s timeout: a fresh PGLiteEngine + initSchema (36 migrations,
    // pgvector WASM cold start) clears in ~3s but spikes to 6-15s under
    // full-e2e-suite load contention. Default 5s timeout was eating the
    // happy path.
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.patterns.enabled', 'false');
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('disabled');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('default-enabled when config key unset', async () => {
    const rig = await setupRig();
    try {
      // No reflections seeded → falls through to insufficient_evidence,
      // not disabled. Confirms the default-true semantics.
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E patterns — insufficient_evidence', () => {
  test('skipped with 0 reflections', async () => {
    const rig = await setupRig();
    try {
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('skipped with reflections below min_evidence', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.patterns.min_evidence', '5');
      await seedReflections(rig.engine, 3); // below 5
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E patterns — no reachable provider', () => {
  test('enough reflections, no Anthropic key in env OR config → skipped no_provider', async () => {
    const rig = await setupRig();
    try {
      await seedReflections(rig.engine, 5); // above default min_evidence (3)
      // Default patterns model resolves to Anthropic; with no key reachable
      // from EITHER source (env + config file — the shared helper neuters
      // both) the gateway probe reports the provider unavailable. A
      // non-Anthropic stack (litellm, deepseek, ...) passes this gate and
      // dispatches through the gateway instead (PR #2279).
      await withoutAnthropicKey(async () => {
        const result = await runPhasePatterns(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
          sourceId: 'default',
        });
        expect(result.status).toBe('skipped');
        expect((result.details as { reason?: string }).reason).toBe('no_provider');
      });
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E patterns — dry-run', () => {
  test('dry-run returns ok with reflections_considered and zero patterns_written', async () => {
    const rig = await setupRig();
    try {
      await seedReflections(rig.engine, 5);
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: true,
        sourceId: 'default',
      });
      expect(result.status).toBe('ok');
      expect((result.details as { dryRun: boolean }).dryRun).toBe(true);
      expect((result.details as { reflections_considered: number }).reflections_considered).toBe(5);
      expect((result.details as { patterns_written: number }).patterns_written).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E patterns — source-threaded child job', () => {
  test('non-default source is present in child job data and gather scope', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ('robotics', 'robotics', '{"federated": true}'::jsonb)`,
      );
      await rig.engine.setConfig('dream.synthesize.use_subscription_billing', 'true');
      await seedReflections(rig.engine, 3, 'robotics');

      const result = await withSubagentAutoCancel(rig.engine, () => runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'robotics',
      }));
      expect(result.status).toBe('fail');
      expect(result.error?.code).toBe('PATTERNS_CHILD_CANCELLED');

      const jobs = await rig.engine.executeRaw<{ data: Record<string, unknown> }>(
        `SELECT data FROM minion_jobs WHERE name = 'shell-subagent'`,
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data.source_id).toBe('robotics');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
