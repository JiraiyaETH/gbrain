/**
 * Regression tests for source freshness updates on no-change syncs.
 *
 * The live bug this pins: `gbrain sync --all --no-embed --no-pull` could
 * correctly report a source as up-to-date while `gbrain status` still marked
 * it stale, because the exact-HEAD short circuit did not refresh
 * sources.last_sync_at / sync.last_run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performSync } from '../src/commands/sync.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const OLD_ISO = '2000-01-01T00:00:00.000Z';

let engine: PGLiteEngine;
let repoPath: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

function createRepo(): { repoPath: string; headCommit: string } {
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-freshness-'));
  git(['init']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(repoPath, 'notes'), { recursive: true });
  writeFileSync(join(repoPath, 'notes/freshness.md'), [
    '---',
    'type: note',
    'title: Freshness Test',
    '---',
    '',
    'No-change sync freshness regression fixture.',
  ].join('\n'));
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  const headCommit = git(['rev-parse', 'HEAD']);
  return { repoPath, headCommit };
}

async function addSource(sourceId: string, headCommit: string) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, chunker_version, config, created_at)
     VALUES ($1, $1, $2, $3, $4::timestamptz, $5, '{}'::jsonb, NOW())`,
    [sourceId, repoPath, headCommit, OLD_ISO, String(CHUNKER_VERSION)],
  );
  await engine.setConfig('sync.last_run', OLD_ISO);
}

async function sourceFreshness(sourceId: string): Promise<{ last_commit: string; last_sync_at: unknown }> {
  const rows = await engine.executeRaw<{ last_commit: string; last_sync_at: unknown }>(
    `SELECT last_commit, last_sync_at FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0]!;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value));
}

describe('sync freshness bookkeeping', () => {
  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    createRepo();
  });

  afterEach(async () => {
    if (engine) await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('exact-HEAD up_to_date sync refreshes source last_sync_at and sync.last_run', async () => {
    const headCommit = git(['rev-parse', 'HEAD']);
    await addSource('freshness-src', headCommit);

    const before = await sourceFreshness('freshness-src');
    expect(before.last_commit).toBe(headCommit);
    expect(toMillis(before.last_sync_at)).toBe(Date.parse(OLD_ISO));

    const result = await performSync(engine, {
      repoPath,
      sourceId: 'freshness-src',
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('up_to_date');
    const after = await sourceFreshness('freshness-src');
    expect(after.last_commit).toBe(headCommit);
    expect(toMillis(after.last_sync_at)).toBeGreaterThan(Date.parse(OLD_ISO));
    expect(Date.parse((await engine.getConfig('sync.last_run'))!)).toBeGreaterThan(Date.parse(OLD_ISO));
  });

  test('exact-HEAD dry-run reports no syncable changes without mutating freshness', async () => {
    const headCommit = git(['rev-parse', 'HEAD']);
    await addSource('dry-src', headCommit);

    const result = await performSync(engine, {
      repoPath,
      sourceId: 'dry-src',
      noPull: true,
      noEmbed: true,
      dryRun: true,
    });

    expect(result.status).toBe('dry_run');
    const after = await sourceFreshness('dry-src');
    expect(after.last_commit).toBe(headCommit);
    expect(toMillis(after.last_sync_at)).toBe(Date.parse(OLD_ISO));
    expect(await engine.getConfig('sync.last_run')).toBe(OLD_ISO);
  });
});
