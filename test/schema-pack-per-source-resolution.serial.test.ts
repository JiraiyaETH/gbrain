import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { runImport } from '../src/commands/import.ts';
import { performSync } from '../src/commands/sync.ts';
import { runCycle } from '../src/core/cycle.ts';
import {
  resolveActivePackForSource,
  _resetPackCacheForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/index.ts';
import { withEnv } from './helpers/with-env.ts';

const putPage = operations.find((op) => op.name === 'put_page');
if (!putPage) throw new Error('put_page op not registered');

const TEST_ENV = {
  GBRAIN_SCHEMA_PACK: undefined,
  GBRAIN_DATABASE_URL: undefined,
  DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  DEEPSEEK_API_KEY: undefined,
  ZEROENTROPY_API_KEY: undefined,
};

afterEach(() => {
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
});

type Rig = {
  engine: PGLiteEngine;
  home: string;
};

async function withRig<T>(fn: (rig: Rig) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-per-source-pack-home-'));
  return await withEnv({ ...TEST_ENV, GBRAIN_HOME: home }, async () => {
    installPacks(home);
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      await seedSources(engine);
      await engine.setConfig('schema_pack', 'global-brain');
      await engine.setConfig('schema_pack.source.robotics', 'robotics-brain');
      return await fn({ engine, home });
    } finally {
      await engine.disconnect();
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

function installPacks(home: string): void {
  const root = join(home, '.gbrain', 'schema-packs');
  writePack(root, 'global-brain', `api_version: gbrain-schema-pack-v1
name: global-brain
version: 0.1.0
description: Global prose test pack
extends: gbrain-base
page_types:
  - name: global-note
    primitive: media
    path_prefixes:
      - global/
    aliases: []
    extractable: false
    expert_routing: false
link_types:
  - name: global_related
frontmatter_links:
  - page_type: global-note
    fields:
      - global_link
    link_type: global_related
    direction: outgoing
    dir_hint: global
`);
  writePack(root, 'robotics-brain', `api_version: gbrain-schema-pack-v1
name: robotics-brain
version: 0.1.0
description: Robotics prose source pack
extends: gbrain-base
page_types:
  - name: robot-note
    primitive: media
    path_prefixes:
      - robots/
    aliases: []
    extractable: true
    expert_routing: false
link_types:
  - name: robot_related
frontmatter_links:
  - page_type: robot-note
    fields:
      - robot_link
    link_type: robot_related
    direction: outgoing
    dir_hint: robots
phases:
  - extract_atoms
`);
}

function writePack(root: string, name: string, yaml: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), yaml, 'utf-8');
}

async function seedSources(engine: PGLiteEngine): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
      ('robotics', 'robotics', '{}'::jsonb),
      ('robotics-nokey', 'robotics-nokey', '{}'::jsonb),
      ('code-a', 'code-a', '{"strategy":"code"}'::jsonb),
      ('code-b', 'code-b', '{"strategy":"code"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage('src/a.ts', {
    type: 'code' as never,
    title: 'a.ts',
    compiled_truth: 'export const a = 1;',
  }, { sourceId: 'code-a' });
  await engine.putPage('src/b.ts', {
    type: 'code' as never,
    title: 'b.ts',
    compiled_truth: 'export const b = 1;',
  }, { sourceId: 'code-b' });
}

function ctx(engine: PGLiteEngine, sourceId: string, remote = false): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: { engine: 'pglite' } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
    sourceId,
  };
}

async function pageType(engine: PGLiteEngine, slug: string, sourceId: string): Promise<string | null> {
  const page = await engine.getPage(slug, { sourceId });
  return page?.type ?? null;
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-per-source-pack-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('per-source schema-pack resolution', () => {
  test('installed per-source pack extends gbrain-base and overrides type inference for put_page', async () => {
    await withRig(async ({ engine }) => {
      const resolved = await resolveActivePackForSource({
        engine,
        cfg: null,
        remote: false,
        sourceId: 'robotics',
      });
      expect(resolved.resolution).toEqual({ pack_name: 'robotics-brain', source: 'per-source-db' });
      expect(resolved.pack.manifest.page_types.some((t) => t.name === 'robot-note')).toBe(true);
      expect(resolved.pack.manifest.page_types.some((t) => t.name === 'person')).toBe(true);

      await putPage.handler(ctx(engine, 'robotics'), {
        slug: 'robots/arm-note',
        content: '# Arm Note\n\nRobot source page.',
      });
      expect(await pageType(engine, 'robots/arm-note', 'robotics')).toBe('robot-note');

      await putPage.handler(ctx(engine, 'robotics-nokey'), {
        slug: 'global/no-key-note',
        content: '# No Key\n\nFalls back to the global pack.',
      });
      expect(await pageType(engine, 'global/no-key-note', 'robotics-nokey')).toBe('global-note');
    });
  });

  test('runImport and performSync honor the per-source pack for type inference', async () => {
    await withRig(async ({ engine }) => {
      const importDir = mkdtempSync(join(tmpdir(), 'gbrain-per-source-pack-import-'));
      mkdirSync(join(importDir, 'robots'), { recursive: true });
      writeFileSync(join(importDir, 'robots', 'imported.md'), '# Imported\n\nRobotics import.', 'utf-8');

      const imported = await runImport(
        engine,
        [importDir, '--no-embed'],
        { sourceId: 'robotics' },
      );
      expect(imported.imported).toBe(1);
      expect(await pageType(engine, 'robots/imported', 'robotics')).toBe('robot-note');

      const repo = makeRepo({
        'robots/synced.md': '# Synced\n\nRobotics sync.',
      });
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'robotics'`,
        [repo],
      );
      const synced = await performSync(engine, {
        repoPath: repo,
        sourceId: 'robotics',
        noPull: true,
        noEmbed: true,
      });
      expect(['first_sync', 'synced', 'partial', 'up_to_date']).toContain(synced.status);
      expect(await pageType(engine, 'robots/synced', 'robotics')).toBe('robot-note');
    });
  });

  test('cycle pack-gated phases use the cycle source pack', async () => {
    await withRig(async ({ engine }) => {
      const robotics = await runCycle(engine, {
        brainDir: null,
        sourceId: 'robotics',
        phases: ['extract_atoms'],
      });
      const roboticsPhase = robotics.phases.find((p) => p.phase === 'extract_atoms');
      expect(roboticsPhase?.details?.reason).not.toBe('not_in_active_pack');

      const defaultCycle = await runCycle(engine, {
        brainDir: null,
        sourceId: 'default',
        phases: ['extract_atoms'],
      });
      const defaultPhase = defaultCycle.phases.find((p) => p.phase === 'extract_atoms');
      expect(defaultPhase?.status).toBe('skipped');
      expect(defaultPhase?.details?.reason).toBe('not_in_active_pack');
    });
  });

  test('broken per-source pack logs and falls back to global pack without crashing put_page', async () => {
    await withRig(async ({ engine }) => {
      await engine.setConfig('schema_pack.source.robotics-nokey', 'missing-robotics-pack');
      const warnings: string[] = [];
      const oldWarn = console.warn;
      console.warn = (message?: unknown) => { warnings.push(String(message)); };
      try {
        await putPage.handler(ctx(engine, 'robotics-nokey'), {
          slug: 'global/fallback-note',
          content: '# Fallback\n\nGlobal pack still applies.',
        });
      } finally {
        console.warn = oldWarn;
      }
      expect(await pageType(engine, 'global/fallback-note', 'robotics-nokey')).toBe('global-note');
      expect(warnings.some((w) => w.includes('missing-robotics-pack') && w.includes('falling back'))).toBe(true);
    });
  });

  test('remote per-call override remains ignored by the source-aware resolver', async () => {
    await withRig(async ({ engine }) => {
      const resolved = await resolveActivePackForSource({
        engine,
        cfg: null,
        remote: true,
        perCall: 'robotics-brain',
        sourceId: 'robotics-nokey',
      });
      expect(resolved.resolution).toEqual({ pack_name: 'global-brain', source: 'db-config' });
      expect(resolved.pack.manifest.name).toBe('global-brain');
    });
  });

  test('four-source production shape has no page/link/timeline leakage and code sources remain index-only', async () => {
    await withRig(async ({ engine }) => {
      await putPage.handler(ctx(engine, 'default'), {
        slug: 'global/default-note',
        content: '# Default Note\n\n- **2026-01-01** | lab — Default timeline entry',
      });
      await putPage.handler(ctx(engine, 'robotics'), {
        slug: 'robots/target-bot',
        content: '# Target Bot\n\nTarget page.',
      });
      await putPage.handler(ctx(engine, 'robotics'), {
        slug: 'robots/source-bot',
        content: [
          '---',
          'robot_link: Target Bot',
          '---',
          '# Source Bot',
          '',
          '- **2026-02-01** | lab — Robotics timeline entry',
        ].join('\n'),
      });

      await expect(putPage.handler(ctx(engine, 'code-a'), {
        slug: 'robots/code-write',
        content: '# Blocked',
      })).rejects.toBeInstanceOf(OperationError);

      const pageRows = await engine.executeRaw<{ source_id: string; slug: string; type: string }>(
        `SELECT source_id, slug, type
           FROM pages
          WHERE slug IN ('global/default-note', 'robots/target-bot', 'robots/source-bot', 'src/a.ts', 'src/b.ts')
          ORDER BY source_id, slug`,
      );
      expect(pageRows).toEqual([
        { source_id: 'code-a', slug: 'src/a.ts', type: 'code' },
        { source_id: 'code-b', slug: 'src/b.ts', type: 'code' },
        { source_id: 'default', slug: 'global/default-note', type: 'global-note' },
        { source_id: 'robotics', slug: 'robots/source-bot', type: 'robot-note' },
        { source_id: 'robotics', slug: 'robots/target-bot', type: 'robot-note' },
      ]);

      const linkRows = await engine.executeRaw<{ from_source: string; to_source: string; link_type: string }>(
        `SELECT pf.source_id AS from_source, pt.source_id AS to_source, l.link_type
           FROM links l
           JOIN pages pf ON pf.id = l.from_page_id
           JOIN pages pt ON pt.id = l.to_page_id
          ORDER BY pf.source_id, pt.source_id, l.link_type`,
      );
      expect(linkRows).toEqual([
        { from_source: 'robotics', to_source: 'robotics', link_type: 'robot_related' },
      ]);

      const timelineRows = await engine.executeRaw<{ source_id: string; summary: string }>(
        `SELECT p.source_id, te.summary
           FROM timeline_entries te
           JOIN pages p ON p.id = te.page_id
          ORDER BY p.source_id, te.summary`,
      );
      expect(timelineRows).toEqual([
        { source_id: 'default', summary: 'lab — Default timeline entry' },
        { source_id: 'robotics', summary: 'lab — Robotics timeline entry' },
      ]);
    });
  });
});
