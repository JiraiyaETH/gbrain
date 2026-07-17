import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverTranscripts,
  type DiscoveredTranscript,
} from '../../src/core/cycle/transcript-discovery.ts';
import {
  runPhaseSynthesize,
  synthesizeCompletionKey,
  synthesizeLogicalCompletionKey,
  synthesizeLogicalIdempotencyKey,
  type SynthesizeChildOutcomeStatus,
} from '../../src/core/cycle/synthesize.ts';
import { discoverExtractablePages } from '../../src/core/cycle/extract-atoms.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import type { MinionJob } from '../../src/core/minions/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

interface Rig {
  engine: PGLiteEngine;
  brainDir: string;
  corpusDir: string;
  transcript: DiscoveredTranscript;
  cleanup: () => Promise<void>;
}

const EXPORT_DATE = '2026-07-15';
const SUMMARY_SLUG = `dream-cycle-summaries/${EXPORT_DATE}`;

function renderTranscript(sessionId: string, body = 'original settled bytes'): string {
  const metadata: Record<string, unknown> = {
    source_namespace: 'claude-code',
    source: 'claude-code',
    profile: 'claude-code',
    session_id: sessionId,
    export_date: EXPORT_DATE,
    part_index: 1,
    part_total: 1,
    logical_identity_version: 1,
    exporter_owner: 'gbrain:claude-session-export',
    provenance_kind: 'human-session',
    automated: false,
    settled: true,
    exported_for: 'gbrain_dream_synthesize',
  };
  const frontmatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return `---
${frontmatter}
---

# Settled session

${`${body}. Durable human-authored reflection with enough detail to mine. `.repeat(100)}
`;
}

async function setupRig(sessionId: string): Promise<Rig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-durable-brain-'));
  const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-durable-corpus-'));
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  const transcriptPath = join(corpusDir, `${EXPORT_DATE}__claude-code__${sessionId}.md`);
  writeFileSync(transcriptPath, renderTranscript(sessionId));
  const transcript = discoverTranscripts({ corpusDir, minChars: 100 })[0];
  if (!transcript?.logicalIdentity) throw new Error('fixture logical identity missing');
  return {
    engine,
    brainDir,
    corpusDir,
    transcript,
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* best effort */ }
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
    },
  };
}

async function seedCompletedChild(
  rig: Rig,
  opts: { slug?: string; putPage?: boolean; transcript?: DiscoveredTranscript } = {},
): Promise<number> {
  const transcript = opts.transcript ?? rig.transcript;
  const slug = opts.slug ?? 'wiki/personal/reflections/recovered-session';
  if (opts.putPage !== false) {
    await rig.engine.putPage(slug, {
      type: 'original',
      title: 'Recovered session',
      compiled_truth: '# Recovered session\n\n' +
        'Durable output with [[concepts/recovery]] and enough substance for the extraction gate. '.repeat(12).trimEnd(),
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
  }
  const key = synthesizeLogicalIdempotencyKey(transcript.logicalIdentity!);
  const rows = await rig.engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs
       (name, queue, status, idempotency_key, data, result, finished_at)
     VALUES
       ('subagent', 'default', 'completed', $1, $2::text::jsonb, $3::text::jsonb, now())
     RETURNING id`,
    [
      key,
      JSON.stringify({ prompt: 'Transcript hash suffix (USE THIS in slugs): abcdef' }),
      JSON.stringify({ result: 'completed fixture child', stop_reason: 'end_turn' }),
    ],
  );
  const jobId = Number(rows[0].id);
  if (opts.slug) {
    await rig.engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, ended_at)
       VALUES ($1, 1, 'fixture-put', 'brain_put_page', $2::text::jsonb, 'complete', now())`,
      [jobId, JSON.stringify({ slug })],
    );
  }
  return jobId;
}

async function assertNoSuccessReceipts(rig: Rig): Promise<void> {
  expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(rig.transcript.logicalIdentity!))).toBeNull();
  expect(await rig.engine.getConfig(synthesizeCompletionKey())).toBeNull();
  expect(await rig.engine.getPage(SUMMARY_SLUG, { sourceId: 'default' })).toBeNull();
  expect(existsSync(join(rig.brainDir, `${SUMMARY_SLUG}.md`))).toBe(false);
}

describe('Dream orchestrator durability recovery', () => {
  test('completed child without marker resumes collection/writes/summary, then changed bytes cannot replay', async () => {
    const rig = await setupRig('durable-crash-resume');
    try {
      const slug = 'wiki/personal/reflections/recovered-session';
      const jobId = await seedCompletedChild(rig, { slug });
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(rig.transcript.logicalIdentity!))).toBeNull();
      expect(existsSync(join(rig.brainDir, `${slug}.md`))).toBe(false);

      const resumed = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(resumed.status).toBe('ok');
      expect(resumed.details.children_submitted).toBe(0);
      expect(resumed.details.children_resumed).toBe(1);
      expect(resumed.details.reverse_write_count).toBe(1);
      expect(resumed.details.cooldown_written).toBe(true);
      const recoveredPath = join(rig.brainDir, `${slug}.md`);
      expect(existsSync(recoveredPath)).toBe(true);
      expect(existsSync(join(rig.brainDir, `${SUMMARY_SLUG}.md`))).toBe(true);
      const recovered = await rig.engine.getPage(slug, { sourceId: 'default' });
      expect(recovered).not.toBeNull();
      expect(recovered?.frontmatter.dream_generated).toBe(true);
      expect(recovered?.frontmatter.dream_cycle_date).toBe(EXPORT_DATE);
      const recoveredFile = parseMarkdown(readFileSync(recoveredPath, 'utf8'), recoveredPath);
      expect(recoveredFile.frontmatter.dream_generated).toBe(true);
      expect(recoveredFile.frontmatter.dream_cycle_date).toBe(EXPORT_DATE);
      expect(recoveredFile.compiled_truth).toBe(recovered!.compiled_truth);
      expect(recoveredFile.timeline).toBe(recovered!.timeline);
      expect(await discoverExtractablePages(rig.engine, 'default', [slug])).toEqual([]);
      const summary = await rig.engine.getPage(SUMMARY_SLUG, { sourceId: 'default' });
      expect(summary).not.toBeNull();
      expect(summary?.type).toBe('report');
      expect(await rig.engine.getTags(SUMMARY_SLUG, { sourceId: 'default' })).toEqual(['dream-cycle']);
      expect(readFileSync(join(rig.brainDir, `${SUMMARY_SLUG}.md`), 'utf8')).toMatch(/^type: report$/m);
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(rig.transcript.logicalIdentity!))).not.toBeNull();

      writeFileSync(rig.transcript.filePath, renderTranscript('durable-crash-resume', 'changed bytes after durable completion'));
      const replay = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(replay.status).toBe('ok');
      expect((replay.details.skips as Array<{ reason: string }>).map(item => item.reason))
        .toContain('already_synthesized_marker');
      const jobs = await rig.engine.executeRaw<{ count: string }>(
        `SELECT count(*)::text AS count FROM minion_jobs WHERE id = $1`,
        [jobId],
      );
      expect(Number(jobs[0].count)).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('logical markers and cooldown commit atomically so retry retains the complete date summary', async () => {
    const rig = await setupRig('durable-atomic-a');
    try {
      const secondPath = join(rig.corpusDir, `${EXPORT_DATE}__claude-code__durable-atomic-b.md`);
      writeFileSync(secondPath, renderTranscript('durable-atomic-b'));
      const transcripts = discoverTranscripts({ corpusDir: rig.corpusDir, minChars: 100 });
      expect(transcripts).toHaveLength(2);
      const first = transcripts.find(item => item.logicalIdentity?.sessionId === 'durable-atomic-a');
      const second = transcripts.find(item => item.logicalIdentity?.sessionId === 'durable-atomic-b');
      if (!first?.logicalIdentity || !second?.logicalIdentity) {
        throw new Error('atomic marker fixtures missing logical identities');
      }

      const firstSlug = 'wiki/personal/reflections/durable-atomic-a';
      const secondSlug = 'wiki/personal/reflections/durable-atomic-b';
      await seedCompletedChild(rig, { transcript: first, slug: firstSlug });
      await seedCompletedChild(rig, { transcript: second, slug: secondSlug });

      const originalTransaction: BrainEngine['transaction'] = rig.engine.transaction.bind(rig.engine);
      rig.engine.transaction = (async <T>(
        fn: (engine: BrainEngine) => Promise<T>,
      ): Promise<T> => originalTransaction(async tx => {
        const originalSetConfig = tx.setConfig.bind(tx);
        let logicalMarkerWrites = 0;
        tx.setConfig = async (key: string, value: string): Promise<void> => {
          if (key.startsWith('dream.synthesize.logical_completion.v1.')) {
            logicalMarkerWrites += 1;
            if (logicalMarkerWrites === 2) {
              throw new Error('fixture second logical marker failure');
            }
          }
          await originalSetConfig(key, value);
        };
        return fn(tx);
      })) as BrainEngine['transaction'];

      const interrupted = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(interrupted.status).toBe('fail');
      expect(interrupted.error?.message).toContain('second logical marker failure');
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(first.logicalIdentity))).toBeNull();
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(second.logicalIdentity))).toBeNull();
      expect(await rig.engine.getConfig(synthesizeCompletionKey())).toBeNull();

      rig.engine.transaction = originalTransaction;
      const retried = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(retried.status).toBe('ok');
      expect(retried.details.transcripts_processed).toBe(2);
      expect(retried.details.children_resumed).toBe(2);
      const summary = await rig.engine.getPage(SUMMARY_SLUG, { sourceId: 'default' });
      expect(summary?.compiled_truth).toContain(`[[${firstSlug}]]`);
      expect(summary?.compiled_truth).toContain(`[[${secondSlug}]]`);
      expect(readFileSync(join(rig.brainDir, `${SUMMARY_SLUG}.md`), 'utf8')).toContain(`[[${firstSlug}]]`);
      expect(readFileSync(join(rig.brainDir, `${SUMMARY_SLUG}.md`), 'utf8')).toContain(`[[${secondSlug}]]`);
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(first.logicalIdentity))).not.toBeNull();
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(second.logicalIdentity))).not.toBeNull();
      expect(await rig.engine.getConfig(synthesizeCompletionKey())).not.toBeNull();
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('missing referenced page is fatal and writes no marker, summary, or cooldown', async () => {
    const rig = await setupRig('durable-missing-page');
    try {
      await seedCompletedChild(rig, {
        slug: 'wiki/personal/reflections/missing-recovered-page',
        putPage: false,
      });
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(result.status).toBe('fail');
      expect(result.error?.message).toContain('references missing page');
      await assertNoSuccessReceipts(rig);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('reverse-write filesystem failure is fatal and writes no marker, summary, or cooldown', async () => {
    const rig = await setupRig('durable-reverse-write-failure');
    try {
      await seedCompletedChild(rig, { slug: 'wiki/personal/reflections/reverse-write-failure' });
      writeFileSync(join(rig.brainDir, 'wiki'), 'blocks nested reverse-write directory');
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(result.status).toBe('fail');
      expect(result.error?.message).toContain('reverse-write');
      await assertNoSuccessReceipts(rig);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('summary filesystem failure is fatal and writes no marker or cooldown', async () => {
    const rig = await setupRig('durable-summary-failure');
    try {
      await seedCompletedChild(rig);
      writeFileSync(join(rig.brainDir, 'dream-cycle-summaries'), 'blocks summary directory');
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(result.status).toBe('fail');
      expect(result.error?.message).toContain('summary file-write failed');
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(rig.transcript.logicalIdentity!))).toBeNull();
      expect(await rig.engine.getConfig(synthesizeCompletionKey())).toBeNull();
      // DB mutation may have completed before the filesystem failure. The
      // absent marker makes the next run deterministically repair the disk.
      expect(await rig.engine.getPage(SUMMARY_SLUG, { sourceId: 'default' })).not.toBeNull();
      expect(existsSync(join(rig.brainDir, `${SUMMARY_SLUG}.md`))).toBe(false);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('summary tag persistence failure is fatal and writes no marker or cooldown', async () => {
    const rig = await setupRig('durable-summary-tag-failure');
    try {
      await seedCompletedChild(rig);
      rig.engine.addTag = async () => {
        throw new Error('fixture tag persistence failure');
      };
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
      });
      expect(result.status).toBe('fail');
      expect(result.error?.message).toContain('tag persistence failure');
      expect(await rig.engine.getConfig(synthesizeLogicalCompletionKey(rig.transcript.logicalIdentity!))).toBeNull();
      expect(await rig.engine.getConfig(synthesizeCompletionKey())).toBeNull();
      expect(await rig.engine.getPage(SUMMARY_SLUG, { sourceId: 'default' })).not.toBeNull();
      expect(existsSync(join(rig.brainDir, `${SUMMARY_SLUG}.md`))).toBe(false);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

const NON_SUCCESS_CASES: Array<{
  label: string;
  expected: SynthesizeChildOutcomeStatus;
  mutate: (rig: Rig, jobId: number) => Promise<MinionJob>;
}> = [
  {
    label: 'failed',
    expected: 'failed',
    mutate: async (rig, jobId) => {
      await rig.engine.executeRaw(
        `UPDATE minion_jobs SET status='failed', error_text='fixture model failure', finished_at=now() WHERE id=$1`,
        [jobId],
      );
      return (await new MinionQueue(rig.engine).getJob(jobId))!;
    },
  },
  {
    label: 'dead',
    expected: 'dead',
    mutate: async (rig, jobId) => {
      await rig.engine.executeRaw(
        `UPDATE minion_jobs SET status='dead', error_text='attempts exhausted', finished_at=now() WHERE id=$1`,
        [jobId],
      );
      return (await new MinionQueue(rig.engine).getJob(jobId))!;
    },
  },
  {
    label: 'timeout-shaped dead',
    expected: 'timed_out',
    mutate: async (rig, jobId) => {
      await rig.engine.executeRaw(
        `UPDATE minion_jobs SET status='dead', error_text='wall-clock timeout exceeded', finished_at=now() WHERE id=$1`,
        [jobId],
      );
      return (await new MinionQueue(rig.engine).getJob(jobId))!;
    },
  },
  {
    label: 'cancelled',
    expected: 'cancelled',
    mutate: async (rig, jobId) => {
      await rig.engine.executeRaw(
        `UPDATE minion_jobs SET status='cancelled', finished_at=now() WHERE id=$1`,
        [jobId],
      );
      return (await new MinionQueue(rig.engine).getJob(jobId))!;
    },
  },
];

describe('Dream runPhase terminal outcome evidence', () => {
  for (const fixture of NON_SUCCESS_CASES) {
    test(`${fixture.label} child is phase-fatal with exact counts and no success receipts`, async () => {
      const rig = await setupRig(`outcome-${fixture.expected}`);
      try {
        await rig.engine.putDreamVerdict(rig.transcript.filePath, rig.transcript.contentHash, {
          worth_processing: true,
          reasons: ['fixture worth processing'],
        });
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
          sourceId: 'default',
          date: EXPORT_DATE,
          waitForChildForTestOnly: async (_queue, jobId) => fixture.mutate(rig, jobId),
        });
        expect(result.status).toBe('fail');
        const counts = result.details.child_status_counts as Record<SynthesizeChildOutcomeStatus | 'total', number>;
        expect(counts).toEqual({
          completed: 0,
          failed: fixture.expected === 'failed' ? 1 : 0,
          dead: fixture.expected === 'dead' ? 1 : 0,
          timed_out: fixture.expected === 'timed_out' ? 1 : 0,
          cancelled: fixture.expected === 'cancelled' ? 1 : 0,
          unknown: 0,
          total: 1,
        });
        expect(result.details.cooldown_written).toBe(false);
        await assertNoSuccessReceipts(rig);
      } finally {
        await rig.cleanup();
      }
    }, 30_000);
  }

  test('disappeared child is unknown, phase-fatal, and writes no success receipts', async () => {
    const rig = await setupRig('outcome-unknown');
    try {
      await rig.engine.putDreamVerdict(rig.transcript.filePath, rig.transcript.contentHash, {
        worth_processing: true,
        reasons: ['fixture worth processing'],
      });
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
        sourceId: 'default',
        date: EXPORT_DATE,
        waitForChildForTestOnly: async (_queue, jobId) => {
          await rig.engine.executeRaw(`DELETE FROM minion_jobs WHERE id=$1`, [jobId]);
          throw new Error(`job ${jobId} disappeared mid-wait`);
        },
      });
      expect(result.status).toBe('fail');
      expect(result.details.child_status_counts).toEqual({
        completed: 0,
        failed: 0,
        dead: 0,
        timed_out: 0,
        cancelled: 0,
        unknown: 1,
        total: 1,
      });
      expect(result.details.cooldown_written).toBe(false);
      await assertNoSuccessReceipts(rig);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
