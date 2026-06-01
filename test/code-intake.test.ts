import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildCodeIntakeReport } from '../src/core/code-intake.ts';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

describe('buildCodeIntakeReport', () => {
  test('previews missing code source intake without mutating sources', async () => {
    const repo = makeGitRepo('demo-app');

    const report = await buildCodeIntakeReport(engine, {
      repoPath: repo.root,
      sourceId: 'demo-app-code',
    });

    expect(report.schema_version).toBe(1);
    expect(report.source_id).toBe('demo-app-code');
    expect(report.repo.root).toBe(repo.root);
    expect(report.repo.head).toBe(repo.head);
    expect(report.repo.dirty).toBe(false);
    expect(report.source.exists).toBe(false);
    expect(report.verdict).toBe('ready_for_registration');
    expect(report.auditor_gate).toBe('BLOCKED_NEEDS_REPO_INTAKE');
    expect(report.stop_gates).toContain('source_not_registered');
    expect(report.recommended_steps.map((s) => s.label)).toEqual([
      'create-managed-worktree',
      'register-non-federated-code-source',
      'sync-code-no-embed',
      'smoke-structural-code-lookup',
      'authorize-auditor-source-id',
    ]);
    expect(report.recommended_steps[1]!.argv).toContain('--no-federated');
    expect(report.recommended_steps[2]!.argv).toContain('--no-embed');

    const rows = await engine.executeRaw<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM sources WHERE id = $1',
      ['demo-app-code'],
    );
    expect(rows[0]!.n).toBe(0);
  });

  test('CLI emits the same read-only intake packet as JSON', async () => {
    const repo = makeGitRepo('cli-app');

    const stdout = await captureStdout(async () => {
      await runSources(engine, [
        'code-intake',
        'cli-app-code',
        '--path', repo.root,
        '--known-symbol', 'knownSymbol',
        '--json',
      ]);
    });

    const parsed = JSON.parse(stdout.join('\n')) as Awaited<ReturnType<typeof buildCodeIntakeReport>>;
    expect(parsed.source_id).toBe('cli-app-code');
    expect(parsed.repo.head).toBe(repo.head);
    expect(parsed.auditor_gate).toBe('BLOCKED_NEEDS_REPO_INTAKE');
    expect(parsed.recommended_steps.at(-2)?.argv).toEqual([
      'gbrain', 'code-def', 'knownSymbol', '--source', 'cli-app-code', '--json',
    ]);

    const rows = await engine.executeRaw<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM sources WHERE id = $1',
      ['cli-app-code'],
    );
    expect(rows[0]!.n).toBe(0);
  });

  test('marks an indexed non-federated code source fresh when commits match', async () => {
    const repo = makeGitRepo('fresh-app');
    await insertSource('fresh-app-code', repo.root, repo.head, { federated: false });
    await insertCodePage('fresh-app-code');

    const report = await buildCodeIntakeReport(engine, {
      repoPath: repo.root,
      sourceId: 'fresh-app-code',
    });

    expect(report.verdict).toBe('indexed_fresh');
    expect(report.auditor_gate).toBe('READY_FOR_CODEBASE_AUDITOR');
    expect(report.source.exists).toBe(true);
    expect(report.source.federated).toBe(false);
    expect(report.source.last_commit).toBe(repo.head);
    expect(report.source.page_count).toBe(1);
    expect(report.stop_gates).toEqual([]);
  });

  test('blocks stale indexed source when source last_commit differs from repo head', async () => {
    const repo = makeGitRepo('stale-app');
    await insertSource('stale-app-code', repo.root, '0000000000000000000000000000000000000000', { federated: false });
    await insertCodePage('stale-app-code');

    const report = await buildCodeIntakeReport(engine, {
      repoPath: repo.root,
      sourceId: 'stale-app-code',
    });

    expect(report.verdict).toBe('indexed_stale');
    expect(report.auditor_gate).toBe('BLOCKED_INDEX_STALE');
    expect(report.stop_gates).toContain('index_commit_mismatch');
    expect(report.recommended_steps.map((s) => s.label)).toContain('sync-code-no-embed');
  });

  test('blocks sources that are federated or archived', async () => {
    const repo = makeGitRepo('unsafe-app');
    await insertSource('unsafe-fed-code', repo.root, repo.head, { federated: true });
    await insertSource('unsafe-arch-code', repo.root, repo.head, { federated: false, archived: true });

    const federated = await buildCodeIntakeReport(engine, {
      repoPath: repo.root,
      sourceId: 'unsafe-fed-code',
    });
    expect(federated.verdict).toBe('blocked');
    expect(federated.auditor_gate).toBe('BLOCKED_SOURCE_POLICY');
    expect(federated.stop_gates).toContain('source_is_federated');

    const archived = await buildCodeIntakeReport(engine, {
      repoPath: repo.root,
      sourceId: 'unsafe-arch-code',
    });
    expect(archived.verdict).toBe('blocked');
    expect(archived.auditor_gate).toBe('BLOCKED_SOURCE_POLICY');
    expect(archived.stop_gates).toContain('source_is_archived');
  });

  test('blocks non-git paths before source recommendations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-not-git-'));

    const report = await buildCodeIntakeReport(engine, {
      repoPath: dir,
      sourceId: 'not-git-code',
    });

    expect(report.verdict).toBe('blocked');
    expect(report.auditor_gate).toBe('BLOCKED_REPO_PRECHECK');
    expect(report.stop_gates).toContain('repo_not_git');
    expect(report.recommended_steps).toEqual([]);
  });
});

async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function makeGitRepo(name: string): { root: string; head: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `gbrain-${name}-`)));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'index.ts'), 'export function knownSymbol() { return 42; }\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', 'index.ts']);
  execFileSync('git', [
    '-C', root,
    '-c', 'user.name=GBrain Test',
    '-c', 'user.email=gbrain-test@example.invalid',
    'commit', '-q', '-m', 'initial',
  ]);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { root, head };
}

async function insertSource(
  id: string,
  localPath: string,
  lastCommit: string,
  opts: { federated: boolean; archived?: boolean },
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, config, created_at, archived)
     VALUES ($1, $1, $2, $3, NOW(), $4::jsonb, NOW(), $5)`,
    [id, localPath, lastCommit, JSON.stringify({ federated: opts.federated }), opts.archived === true],
  );
}

async function insertCodePage(sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ('index.ts', $1, 'index.ts', 'code', 'code', '', '{}'::jsonb, NOW(), NOW())`,
    [sourceId],
  );
}
