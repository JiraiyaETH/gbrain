/**
 * v0.20.0 Cathedral II Layer 13 E2 — reindex-code tests.
 *
 * Validates the contract that makes reindex-code safe to ship:
 *   - runReindexCode walks code pages from the DB (not the filesystem).
 *   - Returns pre-computed cost + token estimates without running embeddings.
 *   - --dry-run never imports (status='dry_run', 0 reindexed).
 *   - --force bypasses importCodeFile's content_hash early-return.
 *   - Pages without frontmatter.file fail cleanly (counted, not thrown).
 *   - Batching walks every code page regardless of total count.
 *   - --source filter scopes to one sources row.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Layer 13 E2 — runReindexCode', () => {
  let engine: PGLiteEngine;
  let prevNudgeEnv: string | undefined;

  beforeAll(async () => {
    // v0.37.3 — runReindexCode now reads getEmbeddingModelName() from the
    // gateway for both the cost-preview model field and the code-model
    // nudge. Configure the gateway with the historical default so the
    // existing model-name assertion stays exact, and suppress the nudge
    // so test stderr stays clean.
    prevNudgeEnv = process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    process.env.GBRAIN_NO_CODE_MODEL_NUDGE = '1';
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Two code pages with frontmatter.file populated. compiled_truth holds
    // the full content (as importCodeFile writes it).
    await engine.putPage('src-foo-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/foo.ts (typescript)',
      compiled_truth: 'export function foo() { return 42; }',
      timeline: '',
      frontmatter: { language: 'typescript', file: 'src/foo.ts' },
    });
    await engine.putPage('src-bar-py', {
      type: 'code',
      page_kind: 'code',
      title: 'src/bar.py (python)',
      compiled_truth: 'def bar():\n    return 42\n',
      timeline: '',
      frontmatter: { language: 'python', file: 'src/bar.py' },
    });

    // One code page with missing frontmatter.file — should fail cleanly.
    await engine.putPage('src-bad-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/bad.ts (typescript)',
      compiled_truth: 'export const x = 1;',
      timeline: '',
      frontmatter: { language: 'typescript' }, // no file
    });

    // One markdown page that MUST be ignored.
    await engine.putPage('guides/not-code', {
      type: 'guide',
      title: 'Not code',
      compiled_truth: 'This is a markdown page, not code.',
      timeline: '',
    });
  });

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    if (prevNudgeEnv === undefined) delete process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    else process.env.GBRAIN_NO_CODE_MODEL_NUDGE = prevNudgeEnv;
  }, 30_000);

  test('counts code pages, ignores markdown', async () => {
    const result = await runReindexCode(engine, { dryRun: true, noEmbed: true });
    expect(result.status).toBe('dry_run');
    expect(result.codePages).toBe(3); // foo, bar, bad — not the guide
  });

  test('dry-run reports cost + token count without importing', async () => {
    const result = await runReindexCode(engine, { dryRun: true, noEmbed: true });
    expect(result.status).toBe('dry_run');
    expect(result.reindexed).toBe(0);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
    expect(result.model).toBe('text-embedding-3-large');
  });

  test('reindex walks every code page, failures counted per-slug', async () => {
    const result = await runReindexCode(engine, { noEmbed: true });
    expect(result.status).toBe('ok');
    expect(result.codePages).toBe(3);
    // src-bad-ts has no frontmatter.file → fails cleanly.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.failures).toBeDefined();
    expect(result.failures!.some(f => f.slug === 'src-bad-ts')).toBe(true);
  });

  test('empty brain returns ok with zero counts', async () => {
    const empty = new PGLiteEngine();
    await empty.connect({});
    await empty.initSchema();
    const result = await runReindexCode(empty, { noEmbed: true });
    expect(result.status).toBe('ok');
    expect(result.codePages).toBe(0);
    expect(result.reindexed).toBe(0);
    expect(result.totalTokens).toBe(0);
    await empty.disconnect();
  }, 30_000);

  test('batch size honored — walks all pages even when total > batchSize', async () => {
    const result = await runReindexCode(engine, {
      dryRun: true,
      noEmbed: true,
      batchSize: 1,
    });
    expect(result.codePages).toBe(3);
  });

  test('successful source-scoped reindex stamps code_index freshness marker', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-reindex-code-'));
    const isolated = new PGLiteEngine();
    try {
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      };
      execFileSync('git', ['-C', repo, 'init', '-q'], { env });
      writeFileSync(join(repo, 'foo.ts'), 'export const foo = 1;\n');
      execFileSync('git', ['-C', repo, 'add', '-A'], { env });
      execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed'], { env });
      const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

      await isolated.connect({});
      await isolated.initSchema();
      await isolated.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ('code-src', 'code-src', $1, '{"strategy":"code","federated":true}'::jsonb)`,
        [repo],
      );
      await isolated.putPage('foo-ts', {
        type: 'code',
        page_kind: 'code',
        title: 'foo.ts',
        compiled_truth: 'export const foo = 1;\n',
        timeline: '',
        frontmatter: { language: 'typescript', file: 'foo.ts' },
      }, { sourceId: 'code-src' });

      const result = await runReindexCode(isolated, { sourceId: 'code-src', noEmbed: true });
      expect(result.failed).toBe(0);

      const sources = await isolated.listAllSources({ localPathOnly: true });
      const marker = sources.find((s) => s.id === 'code-src')!.config.code_index as Record<string, unknown>;
      expect(marker.reindexed_head_sha).toBe(head);
      expect(typeof marker.last_reindex_at).toBe('string');
      expect(marker.code_pages).toBe(1);
    } finally {
      await isolated.disconnect().catch(() => {});
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
