import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { normalizeWakeCommandPlan, runMeetingIntelligenceCli } from '../src/commands/meeting-intelligence.ts';
import {
  buildMeetingRepairSweepPlan,
  buildMeetingRuntimeRun,
  claimMeetingWakeRequests,
  createFirefliesProviderAdapter,
  ensureMeetingIntelligenceSchema,
  loadMeetingLedgers,
  normalizeFirefliesMeeting,
  persistMeetingRuntimeRun,
  recordMeetingWakeExecutionResults,
  transitionMeetingLedger,
} from '../src/core/meeting-intelligence/index.ts';

const fixturePath = join(
  import.meta.dir,
  'fixtures',
  'meeting-intelligence',
  'fireflies-completed.synthetic.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  fireflies: Record<string, unknown>;
};

let engine: PGLiteEngine;

async function markMeetingPageEnriched(slug: string, enrichmentTruth = ''): Promise<void> {
  const page = await engine.getPage(slug, { sourceId: 'default' });
  expect(page).not.toBeNull();
  await engine.putPage(slug, {
    type: page!.type,
    title: page!.title,
    compiled_truth: `${page!.compiled_truth}\n\nSemantic enrichment state: completed${enrichmentTruth ? `\n${enrichmentTruth}` : ''}`,
    timeline: page!.timeline,
    frontmatter: {
      ...page!.frontmatter,
      meeting_intelligence_state: 'enriched',
    },
  }, { sourceId: 'default' });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await ensureMeetingIntelligenceSchema(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await ensureMeetingIntelligenceSchema(engine);
});

describe('meeting intelligence BrainEngine persistence and Alex wake bridge', () => {
  test('persists provider row, ledger, receipts, and one idempotent pending Alex wake', async () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const runtime = buildMeetingRuntimeRun([meeting]);

    const first = await persistMeetingRuntimeRun(engine, runtime, [meeting]);
    const second = await persistMeetingRuntimeRun(engine, runtime, [meeting]);

    expect(first.provider_records_upserted).toBe(1);
    expect(first.ledgers_upserted).toBe(1);
    expect(first.wake_requests_emitted).toBe(1);
    expect(first.wake_requests_pending).toBe(1);
    expect(second.wake_requests_emitted).toBe(0);
    expect(second.wake_requests_pending).toBe(1);

    const rows = await engine.executeRaw<{ providers: string; ledgers: string; wakes: string; receipts: string }>(
      `SELECT
        (SELECT COUNT(*)::text FROM meeting_provider_records) AS providers,
        (SELECT COUNT(*)::text FROM meeting_ledger) AS ledgers,
        (SELECT COUNT(*)::text FROM meeting_wake_requests) AS wakes,
        (SELECT COUNT(*)::text FROM meeting_receipts) AS receipts`,
    );
    expect(rows[0]).toEqual({ providers: '1', ledgers: '1', wakes: '1', receipts: '2' });

    const wakeRows = await engine.executeRaw<{ prompt_text: string; status: string }>(
      `SELECT prompt_text, status FROM meeting_wake_requests`,
    );
    expect(wakeRows[0]?.status).toBe('pending');
    expect(wakeRows[0]?.prompt_text).toContain('Provider meeting id: ff-mtg-0001');
    expect(wakeRows[0]?.prompt_text).not.toContain('Let\'s review the acme-example follow-up');
    expect(wakeRows[0]?.prompt_text).not.toContain('enterprise pricing by Friday');
  });

  test('claims pending wake requests without exposing transcript text', async () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    await persistMeetingRuntimeRun(engine, buildMeetingRuntimeRun([meeting]), [meeting]);

    const dryRunClaim = await claimMeetingWakeRequests(engine, {
      target_profile: 'alex',
      limit: 1,
      dry_run: true,
    });
    expect(dryRunClaim).toHaveLength(1);
    expect(dryRunClaim[0]?.command_plan.env.HERMES_PROFILE).toBe('alex');
    expect(dryRunClaim[0]?.command_plan.argv.slice(0, 11)).toEqual([
      ['her', 'mes'].join(''),
      '--profile',
      'alex',
      '--skills',
      'meeting-ingestion',
      '--yolo',
      'chat',
      '--provider',
      'openai-codex',
      '-m',
      'gpt-5.5',
    ]);
    expect(dryRunClaim[0]?.command_plan.argv).toContain('terminal,file,skills');
    expect(dryRunClaim[0]?.prompt_text).toContain('Load and follow the meeting-ingestion skill.');
    expect(dryRunClaim[0]?.prompt_text).not.toContain('Let\'s review the acme-example follow-up');

    const claimed = await claimMeetingWakeRequests(engine, {
      target_profile: 'alex',
      limit: 1,
    });
    expect(claimed).toHaveLength(1);
    const statuses = await engine.executeRaw<{ wake_status: string; ledger_state: string }>(
      `SELECT w.status AS wake_status, l.state AS ledger_state
         FROM meeting_wake_requests w
         JOIN meeting_ledger l ON l.id = w.ledger_id`,
    );
    expect(statuses[0]).toEqual({ wake_status: 'claimed', ledger_state: 'alex_running' });
  });

  test('fixture-backed watch and wake CLI use injected BrainEngine and stay idempotent', async () => {
    const watchOut: string[] = [];
    const firstWatch = await runMeetingIntelligenceCli([
      'watch',
      '--provider',
      'fireflies',
      '--fixture',
      fixturePath,
      '--source',
      'default',
      '--limit',
      '10',
      '--target-profile',
      'alex',
      '--json',
    ], { stdout: (line) => watchOut.push(line) }, { engine });
    const firstSummary = JSON.parse(watchOut[0]!) as {
      status: string;
      wake_requests_emitted: number;
      wake_requests_pending: number;
      materialized_count: number;
      live_gbrain_writes: number;
      materializations: Array<{ meeting_slug: string; source_slug: string; meeting_readback_ok: boolean; source_readback_ok: boolean }>;
    };
    expect(firstWatch).toBe(0);
    expect(firstSummary.status).toBe('watch_complete');
    expect(firstSummary.materialized_count).toBe(1);
    expect(firstSummary.live_gbrain_writes).toBe(2);
    expect(firstSummary.materializations[0]).toMatchObject({
      meeting_readback_ok: true,
      source_readback_ok: true,
    });
    expect(firstSummary.wake_requests_emitted).toBe(1);
    expect(firstSummary.wake_requests_pending).toBe(1);
    const materializedMeeting = await engine.getPage(firstSummary.materializations[0]!.meeting_slug, { sourceId: 'default' });
    const materializedSource = await engine.getPage(firstSummary.materializations[0]!.source_slug, { sourceId: 'default' });
    expect(materializedMeeting?.timeline).toContain('## Full Diarized Transcript');
    expect(materializedSource?.compiled_truth).toContain('## Source Packet');

    const secondOut: string[] = [];
    await runMeetingIntelligenceCli([
      'watch',
      '--provider',
      'fireflies',
      '--fixture',
      fixturePath,
      '--source',
      'default',
      '--json',
    ], { stdout: (line) => secondOut.push(line) }, { engine });
    const secondSummary = JSON.parse(secondOut[0]!) as { wake_requests_emitted: number; wake_requests_pending: number };
    expect(secondSummary.wake_requests_emitted).toBe(0);
    expect(secondSummary.wake_requests_pending).toBe(1);

    const wakeOut: string[] = [];
    const wakeCode = await runMeetingIntelligenceCli([
      'wake',
      '--limit',
      '1',
      '--target-profile',
      'alex',
      '--dry-run',
      '--json',
    ], { stdout: (line) => wakeOut.push(line) }, { engine });
    const wakeSummary = JSON.parse(wakeOut[0]!) as {
      status: string;
      claimed_count: number;
      wake_requests: Array<{ prompt_text: string; command_plan: { env: Record<string, string>; argv: string[] } }>;
    };
    expect(wakeCode).toBe(0);
    expect(wakeSummary.status).toBe('wake_plan');
    expect(wakeSummary.claimed_count).toBe(1);
    expect(wakeSummary.wake_requests[0]?.command_plan.env.HERMES_PROFILE).toBe('alex');
    expect(wakeSummary.wake_requests[0]?.command_plan.argv.slice(0, 11)).toEqual([
      ['her', 'mes'].join(''),
      '--profile',
      'alex',
      '--skills',
      'meeting-ingestion',
      '--yolo',
      'chat',
      '--provider',
      'openai-codex',
      '-m',
      'gpt-5.5',
    ]);
    expect(wakeSummary.wake_requests[0]?.command_plan.argv).toContain('terminal,file,skills');
    expect(wakeSummary.wake_requests[0]?.prompt_text).toContain('Load and follow the meeting-ingestion skill.');
    expect(wakeSummary.wake_requests[0]?.prompt_text).toContain('Read the materialized GBrain pages; do not rely on this prompt for transcript content.');
    expect(wakeSummary.wake_requests[0]?.prompt_text).not.toContain('Let\'s review the acme-example follow-up');
  });

  test('live watch CLI uses injected Fireflies GraphQL fetch, persists BrainEngine rows, and keeps transcript out of wake prompt', async () => {
    const calls: string[] = [];
    const watchOut: string[] = [];
    const code = await runMeetingIntelligenceCli([
      'watch',
      '--provider',
      'fireflies',
      '--live',
      '--since',
      '2026-06-03T00:00:00.000Z',
      '--until',
      '2026-06-03T23:59:59.000Z',
      '--title-match',
      'Eli5DeFi',
      '--limit',
      '1',
      '--target-profile',
      'alex',
      '--json',
    ], { stdout: (line) => watchOut.push(line) }, {
      engine,
      env: { FIREFLIES_API_KEY: 'fireflies_live_secret_fixture_123' },
      firefliesGraphql: async (request) => {
        calls.push(request.operation);
        if (request.operation === 'list') {
          return {
            data: {
              transcripts: [{ id: 'live-eli5defi-0001', title: 'Jiraiya <> Eli5DeFi', date: 1780461000000 }],
            },
          };
        }
        return {
          data: {
            transcript: {
              id: 'live-eli5defi-0001',
              title: 'Jiraiya <> Eli5DeFi',
              date: 1780461000000,
              duration: 31,
              organizer_email: 'jiraiya@example.com',
              participants: ['jiraiya@example.com', 'eli5defi@example.com'],
              summary: { short_summary: 'Fresh live transcript summary.' },
              sentences: [
                { speaker_name: 'Jiraiya', text: 'Fresh live transcript line.', start_time: 0, end_time: 3 },
              ],
              meeting_attendees: [
                { displayName: 'Jiraiya', email: 'jiraiya@example.com' },
                { displayName: 'Eli5DeFi', email: 'eli5defi@example.com' },
              ],
            },
          },
        };
      },
    });
    const summary = JSON.parse(watchOut[0]!) as {
      status: string;
      live_provider_calls: number;
      wake_requests_emitted: number;
      wake_requests_pending: number;
    };

    expect(code).toBe(0);
    expect(calls).toEqual(['list', 'detail']);
    expect(summary.status).toBe('watch_complete');
    expect(summary.live_provider_calls).toBe(2);
    expect(summary.wake_requests_emitted).toBe(1);
    expect(summary.wake_requests_pending).toBe(1);

    const wakeRows = await engine.executeRaw<{ provider_meeting_id: string; prompt_text: string }>(
      `SELECT provider_meeting_id, prompt_text FROM meeting_wake_requests`,
    );
    expect(wakeRows[0]?.provider_meeting_id).toBe('live-eli5defi-0001');
    expect(wakeRows[0]?.prompt_text).toContain('Provider meeting id: live-eli5defi-0001');
    expect(wakeRows[0]?.prompt_text).not.toContain('Fresh live transcript line.');
  });

  test('materialize writes source packet and full meeting page from stored provider record', async () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    await persistMeetingRuntimeRun(engine, buildMeetingRuntimeRun([meeting]), [meeting]);

    let output = '';
    const providerId = (fixture.fireflies.completed as { id: string }).id;
    const materializeCode = await runMeetingIntelligenceCli([
      'materialize',
      '--provider',
      'fireflies',
      '--transcript-id',
      providerId,
      '--source',
      'default',
      '--json',
    ], { stdout: (text) => { output += text; }, stderr: () => {} }, { engine });
    expect(materializeCode).toBe(0);
    const summary = JSON.parse(output) as {
      status: string;
      source_id: string;
      meeting_slug: string;
      source_slug: string;
      meeting_readback_ok: boolean;
      source_readback_ok: boolean;
    };
    expect(summary).toMatchObject({
      status: 'materialize_complete',
      source_id: 'default',
      meeting_readback_ok: true,
      source_readback_ok: true,
    });
    const meetingPage = await engine.getPage(summary.meeting_slug, { sourceId: 'default' });
    const sourcePage = await engine.getPage(summary.source_slug, { sourceId: 'default' });
    expect(meetingPage?.compiled_truth).toContain('## Meeting Record');
    expect(meetingPage?.timeline).toContain('## Full Diarized Transcript');
    expect(sourcePage?.compiled_truth).toContain('## Source Packet');
    const meetingLinks = await engine.getLinks(summary.meeting_slug, { sourceId: 'default' });
    const sourceLinks = await engine.getLinks(summary.source_slug, { sourceId: 'default' });
    expect(meetingLinks.some((link) => link.to_slug === summary.source_slug && link.link_type === 'source')).toBe(true);
    expect(sourceLinks.some((link) => link.to_slug === summary.meeting_slug && link.link_type === 'source')).toBe(true);
  });

  test('top-level CLI connects BrainEngine for materialize subcommand', async () => {
    const cliSource = await Bun.file(new URL('../src/cli.ts', import.meta.url).pathname).text();
    const meetingBlock = cliSource.match(
      /if \(command === 'meeting-intelligence'\) \{[\s\S]*?if \(command === 'calendar-projection'\)/,
    )?.[0];

    expect(meetingBlock).toContain("'materialize'");
    expect(meetingBlock).toContain('runMeetingIntelligenceCli(args, {}, { engine })');
  });

  test('execute wake normalizes legacy chat prompt plans into deterministic materializer commands', () => {
    const normalized = normalizeWakeCommandPlan({
      env: { HERMES_PROFILE: 'alex' },
      argv: [
        ['her', 'mes'].join(''),
        'chat',
        '--query',
        [
          'Meeting ingest wake request.',
          'Materialize command: gbrain meeting-intelligence materialize --provider fireflies --transcript-id ff-mtg-0001 --source default --json',
          'Guardrails:',
        ].join('\n'),
      ],
    }, 'alex');
    expect(normalized.env.HERMES_PROFILE).toBe('alex');
    expect(normalized.argv).toEqual([
      'gbrain',
      'meeting-intelligence',
      'materialize',
      '--provider',
      'fireflies',
      '--transcript-id',
      'ff-mtg-0001',
      '--source',
      'default',
      '--json',
    ]);
  });

  test('execute wake leaves current target-profile semantic enrichment prompts on the primary agent lane', () => {
    const prompt = [
      'Meeting intelligence semantic enrichment wake request.',
      'Provider: fireflies',
      'Provider meeting id: ff-mtg-live-0001',
      'Action: enrich_materialized_meeting.',
    ].join('\n');
    const normalized = normalizeWakeCommandPlan({
      env: { HERMES_PROFILE: 'alex' },
      argv: [
        ['her', 'mes'].join(''),
        '--profile',
        'alex',
        '--skills',
        'meeting-ingestion',
        '--yolo',
        'chat',
        '--provider',
        'openai-codex',
        '-m',
        'gpt-5.5',
        '-Q',
        '--source',
        'meeting-intelligence-enrichment-wake',
        '-q',
        prompt,
      ],
    }, 'alex');

    expect(normalized.argv.slice(0, 11)).toEqual([
      ['her', 'mes'].join(''),
      '--profile',
      'alex',
      '--skills',
      'meeting-ingestion',
      '--yolo',
      'chat',
      '--provider',
      'openai-codex',
      '-m',
      'gpt-5.5',
    ]);
    expect(normalized.argv.join(' ')).not.toContain('meeting-intelligence materialize');
  });

  test('execute wake upgrades legacy semantic enrichment prompts onto the primary agent lane', () => {
    const prompt = [
      'Meeting ingest enrichment wake request.',
      'Provider: fireflies',
      'Provider meeting id: ff-mtg-live-0002',
      'Action: enrich attendee/entity Brain pages from the materialized meeting/source pages only; do not call Claude, Anthropic, or Minions by default.',
    ].join('\n');
    const normalized = normalizeWakeCommandPlan({
      env: { HERMES_PROFILE: 'alex' },
      argv: [
        ['her', 'mes'].join(''),
        '--profile',
        'alex',
        '--skills',
        'meeting-ingestion',
        'chat',
        '-Q',
        '--source',
        'meeting-intelligence-wake',
        '-q',
        prompt,
      ],
    }, 'alex');

    expect(normalized.argv.slice(0, 11)).toEqual([
      ['her', 'mes'].join(''),
      '--profile',
      'alex',
      '--skills',
      'meeting-ingestion',
      '--yolo',
      'chat',
      '--provider',
      'openai-codex',
      '-m',
      'gpt-5.5',
    ]);
    expect(normalized.argv).toContain('terminal,file,skills');
    expect(normalized.argv.join(' ')).not.toContain('meeting-intelligence materialize');
  });

  test('execute wake refuses child-exit false green without canonical enrichment readback', async () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    await persistMeetingRuntimeRun(engine, buildMeetingRuntimeRun([meeting]), [meeting]);
    const rows = await engine.executeRaw<{ id: string; payload_json: unknown }>(
      `SELECT id, payload_json FROM meeting_wake_requests LIMIT 1`,
    );
    const payload = typeof rows[0]?.payload_json === 'string'
      ? JSON.parse(rows[0].payload_json)
      : rows[0]?.payload_json as Record<string, unknown>;
    await engine.executeRaw(
      `UPDATE meeting_wake_requests
         SET payload_json = jsonb_set($2::jsonb, '{command_plan,argv}', $3::jsonb)
       WHERE id = $1`,
      [rows[0]!.id, JSON.stringify(payload), JSON.stringify([process.execPath, '-e', 'process.exit(0)'])],
    );

    const wakeOut: string[] = [];
    const code = await runMeetingIntelligenceCli([
      'wake',
      '--target-profile',
      'alex',
      '--execute',
      '--json',
    ], { stdout: (line) => wakeOut.push(line), stderr: () => {} }, { engine });
    const summary = JSON.parse(wakeOut[0]!) as {
      status: string;
      executions: Array<{ ok: boolean; error_text?: string }>;
    };
    expect(code).toBe(1);
    expect(summary.status).toBe('wake_failed');
    expect(summary.executions[0]?.ok).toBe(false);
    expect(summary.executions[0]?.error_text).toContain('canonical enrichment readback');
    const statusRows = await engine.executeRaw<{ wake_status: string; ledger_state: string; receipt_count: string; error_text: string | null }>(
      `SELECT
        (SELECT status FROM meeting_wake_requests LIMIT 1) AS wake_status,
        (SELECT state FROM meeting_ledger LIMIT 1) AS ledger_state,
        (SELECT COUNT(*)::text FROM meeting_receipts WHERE kind = 'enrichment_done') AS receipt_count,
        (SELECT error_text FROM meeting_wake_requests LIMIT 1) AS error_text`,
    );
    expect(statusRows[0]?.wake_status).toBe('failed');
    expect(statusRows[0]?.ledger_state).toBe('alex_failed');
    expect(statusRows[0]?.receipt_count).toBe('0');
    expect(statusRows[0]?.error_text).toContain('canonical enrichment readback');
  });

  test('execution result closes enriched only after meeting page readback proves enrichment', async () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    await runMeetingIntelligenceCli([
      'watch',
      '--provider',
      'fireflies',
      '--fixture',
      fixturePath,
      '--source',
      'default',
      '--limit',
      '1',
      '--target-profile',
      'alex',
      '--json',
    ], { stdout: () => {} }, { engine });
    const claimed = await claimMeetingWakeRequests(engine, { target_profile: 'alex', limit: 1 });
    expect(claimed).toHaveLength(1);
    await markMeetingPageEnriched(claimed[0]!.payload.page_slug);

    const recorded = await recordMeetingWakeExecutionResults(engine, [{
      wake_request_id: claimed[0]!.id,
      ok: true,
      status: 0,
      signal: null,
    }]);

    expect(recorded[0]?.ok).toBe(true);
    const statusRows = await engine.executeRaw<{ wake_status: string; ledger_state: string; receipt_count: string }>(
      `SELECT
        (SELECT status FROM meeting_wake_requests LIMIT 1) AS wake_status,
        (SELECT state FROM meeting_ledger LIMIT 1) AS ledger_state,
        (SELECT COUNT(*)::text FROM meeting_receipts WHERE kind = 'enrichment_done') AS receipt_count`,
    );
    expect(statusRows[0]).toEqual({ wake_status: 'done', ledger_state: 'enriched', receipt_count: '1' });
  });

  test('notify command emits from verified GBrain receipts instead of local meeting markdown globs', async () => {
    await runMeetingIntelligenceCli([
      'watch',
      '--provider',
      'fireflies',
      '--fixture',
      fixturePath,
      '--source',
      'default',
      '--limit',
      '1',
      '--target-profile',
      'alex',
      '--json',
    ], { stdout: () => {} }, { engine });
    const claimed = await claimMeetingWakeRequests(engine, { target_profile: 'alex', limit: 1 });
    expect(claimed).toHaveLength(1);
    await engine.putPage('people/jiraiya', {
      type: 'person',
      title: 'Jiraiya',
      compiled_truth: '# Jiraiya',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.executeRaw(`UPDATE pages SET created_at = '2026-01-01T00:00:00.000Z' WHERE slug = 'people/jiraiya' AND source_id = 'default'`);
    await engine.putPage('people/mars-defi', {
      type: 'person',
      title: 'Mars DeFi',
      compiled_truth: '# Mars DeFi',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('companies/tailored-studios', {
      type: 'company',
      title: 'Tailored Studios',
      compiled_truth: '# Tailored Studios',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.executeRaw(`UPDATE pages SET created_at = '2026-01-01T00:00:00.000Z' WHERE slug = 'companies/tailored-studios' AND source_id = 'default'`);
    await engine.addLinksBatch([
      {
        from_slug: claimed[0]!.payload.page_slug,
        to_slug: 'people/mars-defi',
        link_type: 'attended',
        context: 'semantic wake attendee link',
        link_source: 'markdown',
        from_source_id: 'default',
        to_source_id: 'default',
      },
      {
        from_slug: claimed[0]!.payload.page_slug,
        to_slug: 'people/jiraiya',
        link_type: 'attended',
        context: 'semantic wake attendee link',
        link_source: 'markdown',
        from_source_id: 'default',
        to_source_id: 'default',
      },
    ]);
    await markMeetingPageEnriched(claimed[0]!.payload.page_slug, [
      '- Durable facts promoted: 3',
      '- Updated pages: [Mars DeFi](../people/mars-defi.md), [Jiraiya](../people/jiraiya.md)',
      '- Existing page already current: [Tailored Studios](../companies/tailored-studios.md)',
      '- Promotion boundary: transcript-backed relationship and referral signal promoted; commercial terms stayed review-only.',
    ].join('\n'));
    await recordMeetingWakeExecutionResults(engine, [{
      wake_request_id: claimed[0]!.id,
      ok: true,
      status: 0,
      signal: null,
    }]);

    const tmp = mkdtempSync(join(tmpdir(), 'meeting-intelligence-notify-'));
    const ledger = join(tmp, 'notified.jsonl');
    try {
      const out: string[] = [];
      const code = await runMeetingIntelligenceCli([
        'notify',
        '--notified-ledger',
        ledger,
        '--json',
      ], { stdout: (line) => out.push(line), stderr: () => {} }, { engine });
      const summary = JSON.parse(out[0]!) as {
        status: string;
        notifications: Array<{ meeting_slug: string; text: string }>;
        emitted_count: number;
      };
      expect(code).toBe(0);
      expect(summary.status).toBe('notify_complete');
      expect(summary.emitted_count).toBe(1);
      expect(summary.notifications[0]?.meeting_slug).toBe(claimed[0]!.payload.page_slug);
      expect(summary.notifications[0]?.text).toContain('Meeting Intelligence Watch');
      expect(summary.notifications[0]?.text).toContain('Brain changed: 3 durable facts promoted.');
      expect(summary.notifications[0]?.text).toContain('Created: Mars DeFi (people/mars-defi)');
      expect(summary.notifications[0]?.text).toContain('Updated: Jiraiya (people/jiraiya)');
      expect(summary.notifications[0]?.text).toContain('Already current: Tailored Studios (companies/tailored-studios)');
      expect(summary.notifications[0]?.text).toContain(`${claimed[0]!.payload.page_slug} → people/mars-defi (attended)`);
      expect(summary.notifications[0]?.text).not.toContain('Signal:');
      expect(summary.notifications[0]?.text).not.toContain('Backend kept:');
      expect(summary.notifications[0]?.text).toContain(claimed[0]!.payload.page_slug);
      expect(summary.notifications[0]?.text).not.toContain('Cronjob Response');
      expect(existsSync(ledger)).toBe(true);
      expect(readFileSync(ledger, 'utf8')).toContain(claimed[0]!.payload.page_slug);

      const secondOut: string[] = [];
      await runMeetingIntelligenceCli([
        'notify',
        '--notified-ledger',
        ledger,
        '--json',
      ], { stdout: (line) => secondOut.push(line), stderr: () => {} }, { engine });
      const second = JSON.parse(secondOut[0]!) as { emitted_count: number; notifications: unknown[] };
      expect(second.emitted_count).toBe(0);
      expect(second.notifications).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('execute wake records child failure and exposes retryable failed rows', async () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    await persistMeetingRuntimeRun(engine, buildMeetingRuntimeRun([meeting]), [meeting]);
    const rows = await engine.executeRaw<{ id: string; payload_json: unknown }>(
      `SELECT id, payload_json FROM meeting_wake_requests LIMIT 1`,
    );
    const payload = typeof rows[0]?.payload_json === 'string'
      ? JSON.parse(rows[0].payload_json)
      : rows[0]?.payload_json as Record<string, unknown>;
    await engine.executeRaw(
      `UPDATE meeting_wake_requests
         SET payload_json = jsonb_set($2::jsonb, '{command_plan,argv}', $3::jsonb)
       WHERE id = $1`,
      [rows[0]!.id, JSON.stringify(payload), JSON.stringify([process.execPath, '-e', 'process.exit(7)'])],
    );

    const wakeOut: string[] = [];
    const code = await runMeetingIntelligenceCli([
      'wake',
      '--limit',
      '1',
      '--target-profile',
      'alex',
      '--execute',
      '--json',
    ], { stdout: (line) => wakeOut.push(line) }, { engine });
    const summary = JSON.parse(wakeOut[0]!) as {
      status: string;
      executions: Array<{ ok: boolean; status: number | null; error_text?: string }>;
    };

    expect(code).toBe(1);
    expect(summary.status).toBe('wake_failed');
    expect(summary.executions[0]).toMatchObject({ ok: false, status: 7 });
    const statuses = await engine.executeRaw<{ wake_status: string; ledger_state: string; error_text: string | null }>(
      `SELECT w.status AS wake_status, l.state AS ledger_state, w.error_text
         FROM meeting_wake_requests w
         JOIN meeting_ledger l ON l.id = w.ledger_id`,
    );
    expect(statuses[0]?.wake_status).toBe('failed');
    expect(statuses[0]?.ledger_state).toBe('alex_failed');
    expect(statuses[0]?.error_text).toContain('exited with status 7');

    const retryPlan = await claimMeetingWakeRequests(engine, {
      target_profile: 'alex',
      limit: 1,
      dry_run: true,
      retry_failed: true,
    });
    expect(retryPlan).toHaveLength(1);
  });

  test('repair sweep re-emits stale Alex wake and stages deterministic fallback for stuck running wake', async () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const runtime = buildMeetingRuntimeRun([meeting], { now: '2026-05-20T03:00:00.000Z' });
    const requested = runtime.ledgers[0]!;
    const running = transitionMeetingLedger(requested, 'alex_running', 'claimed_by_bridge', '2026-05-20T03:10:00.000Z');
    const sweep = buildMeetingRepairSweepPlan([requested, running], {
      now: '2026-05-20T10:00:00.000Z',
      stale_after_ms: 60 * 60 * 1000,
    });

    expect(sweep.candidates.map((candidate) => candidate.action)).toEqual([
      'reemit_alex_wake',
      'stage_deterministic_fallback',
    ]);
  });
});
