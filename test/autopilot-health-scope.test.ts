import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  dispatchPerSource,
  healthOptsForAutopilotUniverse,
  loadAutopilotSourceUniverse,
} from '../src/commands/autopilot-fanout.ts';

let engine: PGLiteEngine;

function embedding(idx: number): Float32Array {
  const out = new Float32Array(1536);
  out[idx] = 1;
  return out;
}

async function markDefaultAsLocalProseSource() {
  await engine.executeRaw(
    `UPDATE sources
        SET local_path = $1,
            config = $2::jsonb
      WHERE id = 'default'`,
    ['/tmp/default-brain', JSON.stringify({ federated: true })],
  );
}

async function addSource(id: string, config: Record<string, unknown>) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [id, `/tmp/${id}`, JSON.stringify(config)],
  );
}

async function addHealthyDefaultPage(slug: string, title: string, idx: number) {
  await engine.putPage(slug, {
    type: 'person',
    title,
    compiled_truth: `${title} body`,
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: `${title} body`,
    chunk_source: 'compiled_truth',
    embedding: embedding(idx),
    token_count: 2,
  }], { sourceId: 'default' });
  await engine.addTimelineEntry(slug, { date: `2026-02-0${idx}`, summary: `${title} event` }, { sourceId: 'default' });
}

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

describe('autopilot health scope', () => {
  test('uses the same eligible source universe as fanout dispatch', async () => {
    await markDefaultAsLocalProseSource();
    await addSource('agent-fork-code', { federated: true, strategy: 'code' });

    await addHealthyDefaultPage('people/healthy-a', 'Healthy A', 1);
    await addHealthyDefaultPage('people/healthy-b', 'Healthy B', 2);
    await engine.addLink('people/healthy-a', 'people/healthy-b', '', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
    await engine.addLink('people/healthy-b', 'people/healthy-a', '', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });

    for (let i = 0; i < 8; i++) {
      await engine.putPage(`code/orphan-${i}`, {
        type: 'note',
        title: `Code Orphan ${i}`,
        compiled_truth: 'unserviced code source page',
        timeline: '',
        frontmatter: {},
      }, { sourceId: 'agent-fork-code' });
    }

    const unscoped = await engine.getHealth();
    const scoped = await engine.getHealth({ sourceIds: ['default'] });
    expect(scoped.brain_score).toBeGreaterThanOrEqual(95);
    expect(unscoped.brain_score).toBeLessThan(70);
    expect(unscoped.orphan_pages).toBe(8);

    const universe = await loadAutopilotSourceUniverse(engine);
    expect(universe.eligibleSources.map((s) => s.id)).toEqual(['default']);
    expect(universe.skippedCodeSource.map((s) => s.id)).toEqual(['agent-fork-code']);
    expect(healthOptsForAutopilotUniverse(universe)).toEqual({ sourceIds: ['default'] });

    const autopilotHealth = await engine.getHealth(healthOptsForAutopilotUniverse(universe));
    expect(autopilotHealth.brain_score).toBe(scoped.brain_score);
    expect(autopilotHealth.brain_score).toBeGreaterThan(unscoped.brain_score);

    const added: Array<{ name: string; data: Record<string, unknown> }> = [];
    const queue = {
      add: async (name: string, data: unknown) => {
        added.push({ name, data: data as Record<string, unknown> });
        return { id: added.length };
      },
    } as unknown as Parameters<typeof dispatchPerSource>[1];
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp/default-brain',
      slot: '2026-07-02T00:00:00.000Z',
      timeoutMs: 300_000,
      fanoutMax: 4,
      jsonMode: true,
      emit: () => {},
      log: () => {},
      sourceUniverse: universe,
    });

    expect(result.dispatched).toEqual(['default']);
    expect(result.skipped_code_source).toEqual(['agent-fork-code']);
    expect(added.map((j) => j.data.source_id)).toEqual(['default']);
  });

  test('runAutopilot threads scoped health opts from the fanout universe', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'), 'utf8');
    expect(src).toContain('loadAutopilotSourceUniverse(engine)');
    expect(src).toContain('healthOptsForAutopilotUniverse(sourceUniverse)');
    expect(src).toContain('engine.getHealth(healthOptsForTick)');
    expect(src).toContain('sourceId: recommendationSourceId');
    expect(src).toContain('runAllOnboardChecks(engine)');
    expect(src).toContain('filterAutopilotPlanSteps(unfilteredPlan)');
    expect(src).toContain('sourceUniverse,');
  });
});
