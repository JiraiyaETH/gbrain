/**
 * #2194 fix #3 / #2227 bug #3 — the cycle split.
 *
 * Per-source autopilot cycles run ONLY source-scoped (+ mixed) phases; the
 * brain-wide `global` phases run ONCE in a separate autopilot-global-maintenance
 * job. This replaces the rejected skip-and-stamp-fresh design (codex #1/#2): the
 * split makes single-flight structural (one global job, not N concurrent embeds)
 * and never marks a source "fresh" for global work it didn't do. These tests pin
 * the phase partition, the dispatch gate, the per-source phase set, and the
 * global handler stamping autopilot.last_global_at.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  ALL_PHASES,
  AUTOPILOT_EXCLUDED_PHASES,
  AUTOPILOT_GLOBAL_PHASES,
  AUTOPILOT_NON_GLOBAL_PHASES,
  AUTOPILOT_PHASES,
  filterAutopilotPlanSteps,
  GLOBAL_PHASES,
  isAutopilotExcludedPhase,
  NON_GLOBAL_PHASES,
  PHASE_SCOPE,
  LAST_GLOBAL_AT_KEY,
  selectAutopilotPhases,
} from '../src/core/cycle.ts';
import {
  dispatchGlobalMaintenance,
  isGlobalMaintenanceStale,
  dispatchPerSource,
} from '../src/commands/autopilot-fanout.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('cycle phase partition (#2194 fix #3)', () => {
  test('GLOBAL ∪ NON_GLOBAL == ALL_PHASES, no overlap', () => {
    const union = new Set([...GLOBAL_PHASES, ...NON_GLOBAL_PHASES]);
    expect(union.size).toBe(ALL_PHASES.length);
    for (const p of ALL_PHASES) expect(union.has(p)).toBe(true);
    // No phase in both.
    const overlap = GLOBAL_PHASES.filter((p) => NON_GLOBAL_PHASES.includes(p));
    expect(overlap).toEqual([]);
  });

  test('every GLOBAL phase is PHASE_SCOPE==="global"; embed is global, lint is not', () => {
    for (const p of GLOBAL_PHASES) expect(PHASE_SCOPE[p]).toBe('global');
    expect(GLOBAL_PHASES).toContain('embed');
    expect(GLOBAL_PHASES).toContain('orphans');
    expect(GLOBAL_PHASES).toContain('purge');
    expect(NON_GLOBAL_PHASES).toContain('lint');
    expect(NON_GLOBAL_PHASES).toContain('sync');
    expect(NON_GLOBAL_PHASES).not.toContain('embed');
  });

  test('Autopilot phase sets exclude explicit/manual phases without changing ALL_PHASES', () => {
    expect(AUTOPILOT_EXCLUDED_PHASES).toEqual(['synthesize', 'patterns', 'extract_atoms']);
    for (const phase of AUTOPILOT_EXCLUDED_PHASES) {
      expect(ALL_PHASES).toContain(phase);
      expect(AUTOPILOT_PHASES).not.toContain(phase);
      expect(AUTOPILOT_NON_GLOBAL_PHASES).not.toContain(phase);
      expect(AUTOPILOT_GLOBAL_PHASES).not.toContain(phase);
      expect(isAutopilotExcludedPhase(phase)).toBe(true);
    }
  });

  test('phase selector strips excluded phases even if a stale caller passes ALL_PHASES as allowed', () => {
    expect(selectAutopilotPhases(
      ['lint', 'synthesize', 'patterns', 'extract_atoms'],
      ALL_PHASES,
    )).toEqual(['lint']);
  });

  test('malformed and empty payloads fail closed to the explicit Autopilot fallback', () => {
    expect(selectAutopilotPhases(undefined)).toEqual(AUTOPILOT_PHASES);
    expect(selectAutopilotPhases('extract_atoms')).toEqual(AUTOPILOT_PHASES);
    expect(selectAutopilotPhases([])).toEqual(AUTOPILOT_PHASES);
  });

  test('targeted-plan filter removes every excluded job', () => {
    const plan = [
      { id: 'sync', job: 'sync' },
      { id: 'synth', job: 'synthesize' },
      { id: 'patterns', job: 'patterns' },
      { id: 'atoms', job: 'extract_atoms' },
    ];
    expect(filterAutopilotPlanSteps(plan).map((step) => step.id)).toEqual(['sync']);
  });
});

describe('isGlobalMaintenanceStale', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  test('null/unparseable → stale (must run)', () => {
    expect(isGlobalMaintenanceStale(null, now)).toBe(true);
    expect(isGlobalMaintenanceStale('not-a-date', now)).toBe(true);
  });
  test('older than floor → stale; within floor → fresh', () => {
    expect(isGlobalMaintenanceStale(new Date(now - 61 * 60_000).toISOString(), now, 60)).toBe(true);
    expect(isGlobalMaintenanceStale(new Date(now - 10 * 60_000).toISOString(), now, 60)).toBe(false);
  });
});

describe('dispatchGlobalMaintenance — single-flight gate', () => {
  function stubs(lastGlobalAt: string | null) {
    const added: Array<{ name: string; data: any; opts: any }> = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => (k === LAST_GLOBAL_AT_KEY ? lastGlobalAt : null),
    } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts }); return { id: 1 };
      },
    } as any;
    return { engine, queue, added };
  }

  test('stale (never run) → dispatches one global job with single-flight opts', async () => {
    const { engine, queue, added } = stubs(null);
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe('autopilot-global-maintenance');
    expect(added[0].opts.idempotency_key).toBe('autopilot-global:s1');
    expect(added[0].opts.maxWaiting).toBe(1); // structural single-flight
    expect(added[0].data.phases).toEqual(AUTOPILOT_GLOBAL_PHASES);
  });

  test('fresh → does NOT dispatch', async () => {
    const { engine, queue, added } = stubs(new Date().toISOString());
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(false);
    expect(added.length).toBe(0);
  });
});

describe('dispatchPerSource — queued phase payloads exclude manual-only work', () => {
  test('each per-source job sets phases = AUTOPILOT_NON_GLOBAL_PHASES', async () => {
    const sources = [
      { id: 'repo-a', name: 'a', config: { federated: true } },
      { id: 'repo-b', name: 'b', config: { federated: true } },
    ];
    const added: any[] = [];
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => sources,
      getConfig: async () => null,
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const queue = { add: async (name: string, data: unknown, opts: unknown) => { added.push({ name, data, opts }); return { id: added.length }; } } as any;
    await dispatchPerSource(engine, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 4, jsonMode: true, emit: () => {}, log: () => {} });
    expect(added.length).toBe(2);
    for (const j of added) {
      expect(j.data.phases).toEqual(AUTOPILOT_NON_GLOBAL_PHASES);
      expect(j.data.phases).not.toContain('embed');
      expect(j.data.phases).not.toContain('synthesize');
      expect(j.data.phases).not.toContain('patterns');
      expect(j.data.phases).not.toContain('extract_atoms');
    }
  });

  test('legacy single-source fallback sends an explicit Autopilot-safe phase payload', async () => {
    const added: any[] = [];
    const engine = { kind: 'postgres' as const } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data, opts });
        return { id: 1 };
      },
    } as any;
    await dispatchPerSource(engine, queue, {
      repoPath: '/tmp',
      slot: 'legacy',
      timeoutMs: 1,
      fanoutMax: 1,
      jsonMode: true,
      emit: () => {},
      log: () => {},
      sourceUniverse: {
        sources: [],
        eligibleSources: [],
        skippedCodeSource: [],
        skippedIsolatedSource: [],
        legacyFallback: true,
      },
    });
    expect(added).toHaveLength(1);
    expect(added[0].data.phases).toEqual(AUTOPILOT_PHASES);
  });
});

describe('autopilot-global-maintenance handler stamps last_global_at (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function captureHandlers() {
    const handlers = new Map<string, (job: any) => Promise<any>>();
    const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
    await registerBuiltinHandlers(fakeWorker as never, engine);
    return handlers;
  }

  test('runs global phases (no source_id) and stamps autopilot.last_global_at on success', async () => {
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const result = await handler!({ data: { phases: ['orphans', 'embed'] }, signal: undefined });
    // The cycle ran the requested global phases (DB-only on an empty brain).
    expect(result.report.phases.some((p: any) => p.phase === 'orphans')).toBe(true);
    expect(['ok', 'clean', 'partial']).toContain(result.report.status);
    // Freshness stamped so the dispatch gate backs off.
    const stamped = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamped).not.toBeNull();
    expect(Number.isFinite(new Date(stamped!).getTime())).toBe(true);
  });

  test('explicit manual-only phases are stripped before the global handler can execute them', async () => {
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    const result = await handler!({
      data: { phases: ['synthesize', 'orphans', 'patterns', 'extract_atoms'] },
      signal: undefined,
    });
    expect(result.report.phases.map((p: any) => p.phase)).toEqual(['orphans']);
  });

  test('stale global payload cannot cross into per-source phases', async () => {
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    const result = await handler!({
      data: { phases: ['lint', 'sync', 'orphans', 'extract_atoms'] },
      signal: undefined,
    });
    expect(result.report.phases.map((p: any) => p.phase)).toEqual(['orphans']);
  });

  test('manual-only global payload is rejected without stamping global freshness', async () => {
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    const result = await handler!({
      data: { phases: ['synthesize', 'patterns', 'extract_atoms'] },
      signal: undefined,
    });
    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('no_autopilot_phases');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  });
});
