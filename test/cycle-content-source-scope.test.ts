import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { runCycle } from '../src/core/cycle.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const cleanupDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function addSource(id: string, localPath: string | null = null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, $2, '{"federated": true}'::jsonb)`,
    [id, localPath],
  );
}

async function configureSynthesize(corpusDir: string): Promise<void> {
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
}

async function runCycleInTest(opts: Parameters<typeof runCycle>[1]) {
  const home = tempDir('cycle-scope-home-');
  return withEnv(
    { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined },
    () => runCycle(engine, opts),
  );
}

describe('cycle content phase source resolution', () => {
  test('multi-source unresolved scope fails closed before content reads or writes and stamps no freshness', async () => {
    const brainDir = tempDir('cycle-scope-unresolved-brain-');
    const corpusDir = tempDir('cycle-scope-unresolved-corpus-');
    await addSource('robotics');
    await configureSynthesize(corpusDir);
    await engine.setConfig('dream.patterns.enabled', 'true');

    const executeSpy = spyOn(engine, 'executeRaw');
    const putPageSpy = spyOn(engine, 'putPage');
    const freshnessSpy = spyOn(engine, 'updateSourceConfig');
    try {
      const report = await runCycleInTest({
        brainDir,
        phases: ['synthesize', 'patterns'],
      });

      expect(report.phases).toHaveLength(2);
      for (const phase of report.phases) {
        expect(phase.status).toBe('fail');
        expect(phase.error?.code).toBe('SOURCE_SCOPE_UNRESOLVED');
        expect(phase.error?.message).toBe(
          'cycle content phases require a resolved source; pass --source <id> or run from a registered source checkout',
        );
      }
      expect(putPageSpy).not.toHaveBeenCalled();
      expect(freshnessSpy).not.toHaveBeenCalled();
      const contentReads = executeSpy.mock.calls.filter(([sql]) =>
        typeof sql === 'string'
        && (/\bFROM\s+pages\b/i.test(sql) || /subagent_tool_executions/i.test(sql)));
      expect(contentReads).toEqual([]);
      const pages = await engine.executeRaw<{ count: number | string }>('SELECT count(*) AS count FROM pages');
      expect(Number(pages[0].count)).toBe(0);
    } finally {
      executeSpy.mockRestore();
      putPageSpy.mockRestore();
      freshnessSpy.mockRestore();
    }
  }, 30_000);

  test('fresh seeded-default single-source brain resolves default without local_path', async () => {
    const brainDir = tempDir('cycle-scope-default-brain-');
    const corpusDir = tempDir('cycle-scope-default-corpus-');
    await configureSynthesize(corpusDir);

    const executeSpy = spyOn(engine, 'executeRaw');
    try {
      const report = await runCycleInTest({
        brainDir,
        phases: ['synthesize', 'patterns'],
        dryRun: true,
      });
      const synthesize = report.phases.find((phase) => phase.phase === 'synthesize');
      const patterns = report.phases.find((phase) => phase.phase === 'patterns');
      expect(synthesize?.status).toBe('ok');
      expect(patterns?.status).toBe('skipped');
      expect(patterns?.details.reason).toBe('insufficient_evidence');
      expect(report.phases.every((phase) => phase.error?.code !== 'SOURCE_SCOPE_UNRESOLVED')).toBe(true);

      const gatherCall = executeSpy.mock.calls.find(([sql]) =>
        typeof sql === 'string' && /FROM\s+pages/i.test(sql) && /source_id = \$3/.test(sql));
      expect(gatherCall?.[1]?.[2]).toBe('default');
    } finally {
      executeSpy.mockRestore();
    }
  }, 30_000);

  test('disabled and unconfigured phases skip before unresolved-source guard', async () => {
    const brainDir = tempDir('cycle-scope-disabled-brain-');
    await addSource('robotics');
    await engine.setConfig('dream.patterns.enabled', 'false');

    const report = await runCycleInTest({
      brainDir,
      phases: ['synthesize', 'patterns'],
    });
    expect(report.phases.map((phase) => [phase.phase, phase.status, phase.details.reason])).toEqual([
      ['synthesize', 'skipped', 'not_configured'],
      ['patterns', 'skipped', 'disabled'],
    ]);
  }, 30_000);

  test('symlinked nested checkout resolves through canonical realpath containment', async () => {
    const registered = tempDir('cycle-scope-registered-');
    const nested = join(registered, 'nested', 'brain');
    mkdirSync(nested, { recursive: true });
    const linksDir = tempDir('cycle-scope-links-');
    const linkedCheckout = join(linksDir, 'checkout');
    symlinkSync(nested, linkedCheckout, 'dir');
    const corpusDir = tempDir('cycle-scope-symlink-corpus-');
    await addSource('robotics', registered);
    await configureSynthesize(corpusDir);

    const report = await runCycleInTest({
      brainDir: linkedCheckout,
      phases: ['synthesize'],
    });
    expect(report.phases[0].status).toBe('ok');
    expect(report.phases[0].error?.code).not.toBe('SOURCE_SCOPE_UNRESOLVED');
  }, 30_000);
});

describe('targeted content-phase minion handler', () => {
  test('threads job.data.source_id into runCycle', async () => {
    const brainDir = tempDir('cycle-scope-handler-');
    await addSource('robotics');
    await engine.setConfig('dream.patterns.enabled', 'true');

    const handlers = new Map<string, (job: any) => Promise<any>>();
    const worker = {
      register(name: string, handler: (job: any) => Promise<any>) {
        handlers.set(name, handler);
      },
    };
    await registerBuiltinHandlers(worker as never, engine);
    const handler = handlers.get('patterns');
    expect(handler).toBeDefined();

    const result = await withEnv(
      { GBRAIN_HOME: tempDir('cycle-scope-handler-home-'), GBRAIN_SOURCE: undefined },
      () => handler!({
        data: { repoPath: brainDir, source_id: 'robotics' },
        signal: undefined,
      }),
    );
    expect(result.report.phases[0].status).toBe('skipped');
    expect(result.report.phases[0].details.reason).toBe('insufficient_evidence');
    expect(result.report.phases[0].error?.code).not.toBe('SOURCE_SCOPE_UNRESOLVED');
  }, 30_000);
});
