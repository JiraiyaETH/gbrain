#!/usr/bin/env bun

/**
 * Deterministic no-paid Dream durability canary.
 *
 * This executable is intentionally test-only. It consumes an exporter-written
 * settled transcript, copies the exact bytes into isolated fixture state, and
 * exercises the real synthesize orchestrator against PGLite. It never creates
 * an AI gateway or connects to the configured production database.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readSingleTranscript } from '../../src/core/cycle/transcript-discovery.ts';
import { discoverExtractablePages } from '../../src/core/cycle/extract-atoms.ts';
import {
  runPhaseSynthesize,
  synthesizeCompletionKey,
  synthesizeLogicalCompletionKey,
  synthesizeLogicalIdempotencyKey,
  type SynthesizeChildOutcomeStatus,
} from '../../src/core/cycle/synthesize.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;
const RECOVERED_SLUG = 'wiki/personal/reflections/no-paid-dream-canary';
const PREWRITE_SLUG = 'conversations/no-paid-dream-prewrite';

type ChildCounts = Record<SynthesizeChildOutcomeStatus | 'total', number>;

interface CanaryArgs {
  transcript: string;
  expectedLogicalId: string;
  intendedNight: string;
  stateDir: string;
  report?: string;
}

interface CanaryReport {
  schema: 'gbrain-dream-no-paid-canary/v1';
  status: 'pass';
  paid_execution: false;
  production_database_touched: false;
  production_corpus_touched: false;
  source_transcript_path: string;
  source_transcript_sha256: string;
  logical_transcript_id: string;
  export_date: string;
  intended_night: string;
  failed_child_counts: ChildCounts;
  resumed_job_id: number;
  summary_slug: string;
  phase_evidence: {
    prewrite: {
      db_marker_present: true;
      intended_cycle_date_present: true;
      facts_backstop_skipped: 'dream_generated';
    };
    failure: {
      status: 'fail';
      child_status_counts: ChildCounts;
      logical_marker_present: false;
      cooldown_present: false;
      summary_db_present: false;
      summary_file_present: false;
    };
    resume: {
      status: 'ok';
      children_submitted: 0;
      children_resumed: 1;
      reverse_write_count: 1;
      logical_marker_present: true;
      cooldown_present: true;
      summary_db_present: true;
      summary_file_present: true;
      recovered_db_marker_present: true;
      recovered_file_marker_present: true;
      recovered_content_hash_preserved: true;
      extract_atoms_excluded: true;
    };
    replay: {
      status: 'ok';
      skip_reason: 'already_synthesized_marker';
      stable_job_count: 1;
    };
  };
  assertions: Record<string, true>;
}

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function parseArgs(argv: string[]): CanaryArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    invariant(flag?.startsWith('--') && value, `invalid argument pair at ${flag ?? '<end>'}`);
    invariant(!values.has(flag), `duplicate argument ${flag}`);
    values.set(flag, value);
  }
  const transcript = values.get('--transcript');
  const expectedLogicalId = values.get('--expected-logical-id');
  const intendedNight = values.get('--intended-night');
  const stateDir = values.get('--state-dir');
  invariant(
    transcript && expectedLogicalId && intendedNight && stateDir,
    'required: --transcript --expected-logical-id --intended-night --state-dir',
  );
  invariant(SHA256_RE.test(expectedLogicalId), '--expected-logical-id must be lowercase sha256');
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(intendedNight), '--intended-night must be YYYY-MM-DD');
  const allowed = new Set([
    '--transcript', '--expected-logical-id', '--intended-night', '--state-dir', '--report',
  ]);
  for (const flag of values.keys()) invariant(allowed.has(flag), `unknown argument ${flag}`);
  return {
    transcript: resolve(transcript),
    expectedLogicalId,
    intendedNight,
    stateDir: resolve(stateDir),
    report: values.get('--report') ? resolve(values.get('--report')!) : undefined,
  };
}

function atomicWriteReport(path: string, report: CanaryReport): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function assertExactCounts(actual: unknown, expected: ChildCounts): asserts actual is ChildCounts {
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `child counts mismatch: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

export async function runNoPaidDreamCanary(args: CanaryArgs): Promise<CanaryReport> {
  invariant(existsSync(args.transcript), `exporter transcript is missing: ${args.transcript}`);
  const sourcePath = realpathSync(args.transcript);
  const sourceBytes = readFileSync(sourcePath);
  const sourceSha256 = sha256Bytes(sourceBytes);

  mkdirSync(args.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(args.stateDir, 0o700);
  invariant(readdirSync(args.stateDir).length === 0, '--state-dir must be empty isolated fixture state');
  const corpusDir = join(args.stateDir, 'corpus');
  const brainDir = join(args.stateDir, 'brain');
  const databasePath = join(args.stateDir, 'pglite');
  mkdirSync(corpusDir, { mode: 0o700 });
  mkdirSync(brainDir, { mode: 0o700 });
  const isolatedTranscriptPath = join(corpusDir, basename(sourcePath));
  copyFileSync(sourcePath, isolatedTranscriptPath);
  chmodSync(isolatedTranscriptPath, 0o600);

  const transcript = readSingleTranscript(isolatedTranscriptPath, { minChars: 100 });
  invariant(transcript?.logicalIdentity, 'exporter transcript is not an eligible identity-bearing settled transcript');
  invariant(
    transcript.logicalIdentity.logicalTranscriptId === args.expectedLogicalId,
    `Dream logical identity mismatch: expected=${args.expectedLogicalId} `
      + `actual=${transcript.logicalIdentity.logicalTranscriptId}`,
  );
  invariant(sha256File(isolatedTranscriptPath) === sourceSha256, 'isolated transcript copy changed exporter bytes');

  const exportDate = transcript.logicalIdentity.exportDate;
  invariant(
    exportDate < args.intendedNight,
    `cross-midnight fixture must start before intended settlement night: ${exportDate}`,
  );
  const summarySlug = `dream-cycle-summaries/${args.intendedNight}`;
  const markerKey = synthesizeLogicalCompletionKey(transcript.logicalIdentity);
  const stableJobKey = synthesizeLogicalIdempotencyKey(transcript.logicalIdentity);
  const summaryPath = join(brainDir, `${summarySlug}.md`);
  const recoveredPath = join(brainDir, `${RECOVERED_SLUG}.md`);
  const expectedFailedCounts: ChildCounts = {
    completed: 0,
    failed: 1,
    dead: 0,
    timed_out: 0,
    cancelled: 0,
    unknown: 0,
    total: 1,
  };

  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  try {
    await engine.initSchema();
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
    await engine.setConfig('dream.synthesize.min_chars', '100');
    await engine.putDreamVerdict(transcript.filePath, transcript.contentHash, {
      worth_processing: true,
      reasons: ['deterministic no-paid canary verdict'],
    });

    // Prove the real native child tool context stamps the DB before the facts
    // backstop. This is a protected-tool simulation only: no model/provider is
    // constructed and no production state is reachable from the PGLite engine.
    const prewriteTool = buildBrainTools({
      subagentId: 7001,
      engine,
      config: {} as GBrainConfig,
      allowedSlugPrefixes: ['conversations/*'],
      sourceId: 'default',
      dreamOutputCycleDate: args.intendedNight,
    }).find(tool => tool.name === 'brain_put_page');
    invariant(prewriteTool, 'native Dream put_page tool is missing');
    const prewriteResult = await prewriteTool.execute(
      {
        slug: PREWRITE_SLUG,
        content: `---\ntype: conversation\ntitle: No-paid prewrite proof\n---\n\n${'Settled human session evidence. '.repeat(30)}`,
      },
      { engine, jobId: 7001, remote: true },
    ) as { facts_backstop?: { skipped?: string } };
    const prewritePage = await engine.getPage(PREWRITE_SLUG, { sourceId: 'default' });
    invariant(prewritePage?.frontmatter.dream_generated === true, 'native child DB marker was absent');
    invariant(
      prewritePage.frontmatter.dream_cycle_date === args.intendedNight,
      'native child DB cycle date was absent',
    );
    invariant(
      prewriteResult.facts_backstop?.skipped === 'dream_generated',
      'native child facts backstop observed an unmarked page',
    );

    // A manual success earlier in the cooldown window must not suppress the
    // scheduled, exporter-gated night. Explicit date targeting bypasses the
    // global cooldown and binds discovery to this settled export date.
    const preseededCooldown = '2099-01-01T00:00:00.000Z';
    await engine.setConfig(synthesizeCompletionKey(), preseededCooldown);

    const failedRun = await runPhaseSynthesize(engine, {
      brainDir,
      dryRun: false,
      sourceId: 'default',
      to: args.intendedNight,
      waitForChildForTestOnly: async (queue, jobId) => {
        await engine.executeRaw(
          `UPDATE minion_jobs
             SET status = 'failed', error_text = 'fixture forced child failure', finished_at = now()
           WHERE id = $1`,
          [jobId],
        );
        const failed = await queue.getJob(jobId);
        invariant(failed, `fixture child ${jobId} disappeared`);
        return failed;
      },
    });
    invariant(failedRun.status === 'fail', `forced child failure returned ${failedRun.status}`);
    invariant(
      await engine.getConfig(synthesizeCompletionKey()) === preseededCooldown,
      'explicit --to failed run changed the preseeded cooldown',
    );
    await engine.unsetConfig(synthesizeCompletionKey());
    assertExactCounts(failedRun.details.child_status_counts, expectedFailedCounts);
    invariant(failedRun.details.cooldown_written === false, 'failed run claimed cooldown success');
    invariant(await engine.getConfig(markerKey) === null, 'failed run wrote logical completion marker');
    invariant(await engine.getConfig(synthesizeCompletionKey()) === null, 'failed run wrote success cooldown');
    invariant(await engine.getPage(summarySlug, { sourceId: 'default' }) === null, 'failed run wrote summary DB row');
    invariant(!existsSync(summaryPath), 'failed run wrote summary file');

    const failedJobs = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id, status FROM minion_jobs WHERE idempotency_key = $1 ORDER BY id`,
      [stableJobKey],
    );
    invariant(failedJobs.length === 1 && failedJobs[0].status === 'failed', 'failed child ledger is not singular and durable');
    const jobId = Number(failedJobs[0].id);

    await engine.putPage(RECOVERED_SLUG, {
      type: 'original',
      title: 'No-paid Dream canary',
      compiled_truth: ('# No-paid Dream canary\n\n' +
        'Recovered durable fixture output with enough semantic detail for atom extraction. '.repeat(12)).trimEnd(),
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    const recoveredBefore = await engine.getPage(RECOVERED_SLUG, { sourceId: 'default' });
    invariant(recoveredBefore?.content_hash, 'recovered fixture pre-stamp hash is missing');
    const recoveredHashBefore = recoveredBefore.content_hash;
    await engine.executeRaw(
      `UPDATE minion_jobs
         SET status = 'completed', result = $2::text::jsonb,
             error_text = NULL, finished_at = now()
       WHERE id = $1 AND status = 'failed'`,
      [jobId, JSON.stringify({ result: 'persisted completed fixture receipt', stop_reason: 'end_turn' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, ended_at)
       VALUES ($1, 1, 'fixture-put-page', 'brain_put_page', $2::text::jsonb, 'complete', now())`,
      [jobId, JSON.stringify({ slug: RECOVERED_SLUG, source_id: 'default' })],
    );

    const resumedRun = await runPhaseSynthesize(engine, {
      brainDir,
      dryRun: false,
      sourceId: 'default',
      to: args.intendedNight,
    });
    invariant(resumedRun.status === 'ok', `persisted receipt resume returned ${resumedRun.status}`);
    invariant(resumedRun.details.children_submitted === 0, 'resume submitted a duplicate child');
    invariant(resumedRun.details.children_resumed === 1, 'resume did not collect the completed child');
    invariant(resumedRun.details.reverse_write_count === 1, 'resume did not reverse-write exactly one page');
    invariant(resumedRun.details.cooldown_written === true, 'successful resume omitted cooldown');
    const markerBeforeReplay = await engine.getConfig(markerKey);
    invariant(markerBeforeReplay !== null, 'successful resume omitted logical completion marker');
    invariant(await engine.getConfig(synthesizeCompletionKey()) !== null, 'successful resume omitted cooldown timestamp');
    const summaryPage = await engine.getPage(summarySlug, { sourceId: 'default' });
    invariant(
      summaryPage?.compiled_truth.includes(`# Dream cycle ${args.intendedNight}`),
      'summary DB postcondition is missing',
    );
    invariant(summaryPage?.type === 'report', 'summary DB type is not active-schema report');
    invariant(
      JSON.stringify(await engine.getTags(summarySlug, { sourceId: 'default' })) === JSON.stringify(['dream-cycle']),
      'summary DB tags are not exactly dream-cycle',
    );
    invariant(existsSync(summaryPath), 'summary file postcondition is missing');
    const summaryMarkdown = readFileSync(summaryPath, 'utf8');
    invariant(
      summaryMarkdown.includes(`# Dream cycle ${args.intendedNight}`),
      'summary file content is wrong',
    );
    invariant(/^type: report$/m.test(summaryMarkdown), 'summary file type is not active-schema report');
    invariant(existsSync(recoveredPath), 'recovered page file postcondition is missing');
    const recoveredMarkdown = readFileSync(recoveredPath, 'utf8');
    invariant(recoveredMarkdown.includes('Recovered durable fixture output'), 'recovered page file content is wrong');
    const recoveredPage = await engine.getPage(RECOVERED_SLUG, { sourceId: 'default' });
    invariant(recoveredPage?.frontmatter.dream_generated === true, 'recovered DB marker is missing');
    invariant(
      recoveredPage.frontmatter.dream_cycle_date === args.intendedNight,
      'recovered DB cycle date is wrong',
    );
    invariant(
      recoveredPage.content_hash === recoveredHashBefore,
      'Dream provenance repair changed the semantic content hash',
    );
    const recoveredParsed = parseMarkdown(recoveredMarkdown, recoveredPath);
    invariant(recoveredParsed.frontmatter.dream_generated === true, 'recovered file marker is missing');
    invariant(
      recoveredParsed.frontmatter.dream_cycle_date === args.intendedNight,
      'recovered file cycle date is wrong',
    );
    invariant(
      recoveredParsed.compiled_truth === recoveredPage.compiled_truth &&
      recoveredParsed.timeline === recoveredPage.timeline,
      'recovered DB/file body parity failed',
    );
    invariant(
      (await discoverExtractablePages(engine, 'default', [RECOVERED_SLUG])).length === 0,
      'recovered Dream page remained eligible for extract_atoms',
    );
    const summaryShaBeforeReplay = sha256File(summaryPath);

    writeFileSync(
      isolatedTranscriptPath,
      `${readFileSync(isolatedTranscriptPath, 'utf8')}\nChanged fixture bytes after durable completion.\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(isolatedTranscriptPath, 0o600);
    const changedTranscript = readSingleTranscript(isolatedTranscriptPath, { minChars: 100 });
    invariant(changedTranscript?.logicalIdentity, 'changed transcript lost its logical identity');
    invariant(changedTranscript.contentHash !== transcript.contentHash, 'changed bytes did not change the content hash');
    invariant(
      changedTranscript.logicalIdentity.logicalTranscriptId === args.expectedLogicalId,
      'changed bytes changed the stable logical transcript identity',
    );

    const replayRun = await runPhaseSynthesize(engine, {
      brainDir,
      dryRun: false,
      sourceId: 'default',
      to: args.intendedNight,
    });
    invariant(replayRun.status === 'ok', `once-only replay returned ${replayRun.status}`);
    const replaySkips = replayRun.details.skips as Array<{ reason?: string }> | undefined;
    invariant(replaySkips?.some(item => item.reason === 'already_synthesized_marker'), 'changed-byte replay did not skip by marker');
    const jobCount = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE idempotency_key = $1`,
      [stableJobKey],
    );
    invariant(Number(jobCount[0].count) === 1, 'changed-byte replay created a duplicate child');
    invariant(await engine.getConfig(markerKey) === markerBeforeReplay, 'once-only replay rewrote the durable marker');
    invariant(sha256File(summaryPath) === summaryShaBeforeReplay, 'once-only replay rewrote the summary');
    invariant(sha256File(sourcePath) === sourceSha256, 'canary mutated the actual exporter output');

    const report: CanaryReport = {
      schema: 'gbrain-dream-no-paid-canary/v1',
      status: 'pass',
      paid_execution: false,
      production_database_touched: false,
      production_corpus_touched: false,
      source_transcript_path: sourcePath,
      source_transcript_sha256: sourceSha256,
      logical_transcript_id: args.expectedLogicalId,
      export_date: exportDate,
      intended_night: args.intendedNight,
      failed_child_counts: expectedFailedCounts,
      resumed_job_id: jobId,
      summary_slug: summarySlug,
      phase_evidence: {
        prewrite: {
          db_marker_present: true,
          intended_cycle_date_present: true,
          facts_backstop_skipped: 'dream_generated',
        },
        failure: {
          status: 'fail',
          child_status_counts: expectedFailedCounts,
          logical_marker_present: false,
          cooldown_present: false,
          summary_db_present: false,
          summary_file_present: false,
        },
        resume: {
          status: 'ok',
          children_submitted: 0,
          children_resumed: 1,
          reverse_write_count: 1,
          logical_marker_present: true,
          cooldown_present: true,
          summary_db_present: true,
          summary_file_present: true,
          recovered_db_marker_present: true,
          recovered_file_marker_present: true,
          recovered_content_hash_preserved: true,
          extract_atoms_excluded: true,
        },
        replay: {
          status: 'ok',
          skip_reason: 'already_synthesized_marker',
          stable_job_count: 1,
        },
      },
      assertions: {
        actual_exporter_transcript_identity_verified: true,
        preseeded_verdict_avoided_model_execution: true,
        explicit_to_bound_bypassed_preseeded_cooldown: true,
        cross_midnight_export_discovered_by_to_bound: true,
        forced_child_failure_counted_exactly: true,
        failed_child_wrote_no_marker_summary_or_cooldown: true,
        persisted_completed_receipt_resumed: true,
        reverse_write_postcondition_verified: true,
        native_child_prewrite_marker_verified_before_backstop: true,
        recovered_db_file_marker_parity_verified: true,
        recovered_content_hash_semantics_preserved: true,
        recovered_page_excluded_from_extract_atoms: true,
        summary_db_and_file_postconditions_verified: true,
        summary_active_schema_report_type_verified: true,
        summary_relational_tag_parity_verified: true,
        changed_bytes_preserved_logical_identity: true,
        durable_marker_enforced_once_only_skip: true,
        actual_exporter_output_remained_unchanged: true,
      },
    };
    if (args.report) atomicWriteReport(args.report, report);
    return report;
  } finally {
    await engine.disconnect();
  }
}

async function main(): Promise<void> {
  const report = await runNoPaidDreamCanary(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[dream-no-paid-canary] ${message}\n`);
    process.exitCode = 1;
  });
}
