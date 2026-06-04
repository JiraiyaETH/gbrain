import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertFirefliesLiveFetchAllowed,
  buildEnrichmentGate,
  buildInitialMeetingLedger,
  buildMeetingIntelligenceArtifacts,
  buildMeetingRepairSweepPlan,
  buildMeetingRuntimeRun,
  computeTranscriptChecksum,
  createFirefliesProviderAdapter,
  evaluateTranscriptIdempotency,
  normalizeLegacyMeetingMigrationCandidate,
  normalizeFirefliesMeeting,
  redactSensitiveText,
  renderMeetingPage,
  resolveMeetingRuntimePaths,
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

describe('meeting intelligence foundation', () => {
  test('normalizes a Fireflies completed meeting into a provider-neutral record', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);

    expect(meeting.provider).toBe('fireflies');
    expect(meeting.provider_meeting_id).toBe('ff-mtg-0001');
    expect(meeting.state).toBe('transcript_ready');
    expect(meeting.transcript).toHaveLength(5);
    expect(meeting.transcript[0]).toEqual({
      speaker: 'alice-example',
      start_seconds: 0,
      end_seconds: 8,
      text: 'Let\'s review the acme-example follow-up and keep this as exploratory.',
    });
    expect(meeting.generated.action_items).toContain(
      'alice-example owns enterprise pricing by Friday',
    );
    expect(meeting.transcript_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(computeTranscriptChecksum(meeting.transcript)).toBe(
      meeting.transcript_checksum,
    );
  });

  test('enforces provider-neutral ledger transitions', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const ledger = buildInitialMeetingLedger(meeting);

    expect(ledger.state).toBe('transcript_ready');
    const rendered = transitionMeetingLedger(ledger, 'page_rendered');
    const pending = transitionMeetingLedger(rendered, 'enrichment_pending');
    const queued = transitionMeetingLedger(pending, 'review_queued');

    expect(queued.history.map((h) => h.to)).toEqual([
      'transcript_ready',
      'page_rendered',
      'enrichment_pending',
      'review_queued',
    ]);
    expect(ledger.history[0]?.at).toBe(meeting.started_at);
    const explicitAt = '2026-05-20T00:01:00.000Z';
    const explicitlyTimed = transitionMeetingLedger(
      ledger,
      'page_rendered',
      'rendered_full_transcript_page',
      explicitAt,
    );
    expect(explicitlyTimed.history[1]?.at).toBe(explicitAt);
    expect(() => transitionMeetingLedger(ledger, 'enriched')).toThrow(
      /invalid meeting intelligence transition/i,
    );
  });

  test('computes transcript checksum idempotency and changed-transcript updates', () => {
    const first = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const changed = normalizeFirefliesMeeting(fixture.fireflies.changedTranscript);
    const ledger = buildInitialMeetingLedger(first);

    expect(evaluateTranscriptIdempotency(ledger, first)).toEqual({
      effect: 'noop',
      next_state: 'skipped',
      enqueue_enrichment: false,
      reason: 'same_provider_id_same_transcript_checksum',
    });

    const changedResult = evaluateTranscriptIdempotency(ledger, changed);
    expect(changed.transcript_checksum).not.toBe(first.transcript_checksum);
    expect(changedResult).toEqual({
      effect: 'update',
      next_state: 'transcript_ready',
      enqueue_enrichment: true,
      reason: 'same_provider_id_changed_transcript_checksum',
    });
  });

  test('artifact builder keeps same-provider changed transcripts as the latest update candidate', () => {
    const first = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const changed = normalizeFirefliesMeeting(fixture.fireflies.changedTranscript);
    const artifacts = buildMeetingIntelligenceArtifacts([first, changed]);

    expect(artifacts.pages).toHaveLength(1);
    expect(artifacts.pages[0]?.transcript_checksum).toBe(changed.transcript_checksum);
    expect(artifacts.pages[0]?.markdown).toContain('Correction: I will collect questions');
    expect(artifacts.packets[0]?.duplicates).toEqual([
      {
        provider_meeting_id: 'ff-mtg-0001',
        reason: 'same_provider_id_changed_transcript_superseded',
      },
    ]);
  });

  test('renders a deterministic full-transcript meeting page for the default source', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const page = renderMeetingPage(meeting);

    expect(page.slug).toBe(
      'meetings/2026-05-20-acme-example-partner-review-fireflies-ff-mtg-0001',
    );
    expect(page.source_id).toBe('default');
    expect(page.markdown).toContain('gbrain_source_id: default');
    expect(page.markdown).toContain('## Attendees');
    expect(page.markdown).toContain('[alice-example](../people/alice-example.md)');
    expect(page.markdown).toContain('[bob-example](../people/bob-example.md)');
    expect(page.markdown).toContain('## Provider Summary Hint');
    expect(page.markdown).toContain('provider-generated summary is a navigation aid');
    expect(page.markdown).toContain('## Topics Hinted by Provider');
    expect(page.markdown).toContain('acme-example renewal');
    expect(page.markdown).toContain('## Full Diarized Transcript');
    expect(page.markdown).toContain(
      '**alice-example** (00:00:00): Let\'s review the acme-example follow-up',
    );
    expect(page.markdown).toContain('## Provider Hints Requiring Review');
    expect(page.markdown).toContain('review_queued');
    expect(page.markdown).not.toContain(['source_id: ', 'busi', 'ness'].join(''));
  });

  test('redacts secret-like title and provider ids before durable slug construction', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const secretLikeMeeting = {
      ...meeting,
      title: 'Recording https://recordings.example.com/a?X-Amz-Signature=fixture-signature&token=fixture-token',
      provider_meeting_id: 'bearer fixturebearer.abc.def',
    };
    const page = renderMeetingPage(secretLikeMeeting);

    expect(page.slug).toContain('redactedsigned-url');
    expect(page.slug).toContain('redactedbearer-token');
    expect(page.slug).not.toContain('fixture-token');
    expect(page.slug).not.toContain('fixturebearer');
    expect(page.slug).not.toContain('x-amz-signature');
    expect(page.audit.slug).toBe(page.slug);
  });

  test('keeps generated provider action hints out of durable assignments', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const gate = buildEnrichmentGate(meeting);

    expect(gate.assigned_actions).toEqual([]);
    expect(gate.durable_facts).toEqual([]);
    expect(gate.review_queue).toHaveLength(3);
    expect(gate.review_queue.every((item) => item.status === 'review_queued')).toBe(true);
    expect(gate.review_queue.every((item) => item.promotion === 'none')).toBe(true);
    expect(gate.review_queue[0]?.blocked_reason).toContain('generated_provider_hint');
  });

  test('redacts signed URLs, token-looking strings, connection strings, and payment-looking strings', () => {
    const input = [
      'https://recordings.example.com/a?X-Amz-Signature=fixture-signature&token=fixture-token',
      'Bearer fixturebearer.abc.def',
      'bearer lowercasefixture.abc.def',
      'postgres://user:***@db.example.com:5432/app',
      'pm_fixture_12345',
      '4242 4242 4242 4242',
      '0x1111111111111111111111111111111111111111',
    ].join('\n');

    const redacted = redactSensitiveText(input);

    expect(redacted).toContain('<REDACTED:signed-url>');
    expect(redacted).toContain('<REDACTED:bearer-token>');
    expect(redacted).toContain('<REDACTED:connection-string>');
    expect(redacted).toContain('<REDACTED:payment-token>');
    expect(redacted).toContain('<REDACTED:payment-card>');
    expect(redacted).toContain('<REDACTED:wallet-address>');
    expect(redacted).not.toContain('fixture-token');
    expect(redacted).not.toContain('fixture-password');
    expect(redacted).not.toContain('lowercasefixture');
  });

  test('fetches through a fixture Fireflies adapter and refuses unapproved live fetches without leaking credentials', async () => {
    const adapter = createFirefliesProviderAdapter({
      mode: 'fixture',
      fixture_payloads: [fixture.fireflies.completed],
    });
    const payload = await adapter.fetchCompletedMeeting({ provider_meeting_id: 'ff-mtg-0001' });
    const meeting = adapter.normalize(payload);

    expect(adapter.provider).toBe('fireflies');
    expect(meeting.provider_meeting_id).toBe('ff-mtg-0001');

    expect(() => assertFirefliesLiveFetchAllowed({
      allow_live_fetch: false,
      api_key: 'fireflies_live_secret_fixture_123',
    })).toThrow(/explicit rollout approval/i);
    try {
      assertFirefliesLiveFetchAllowed({
        allow_live_fetch: true,
        api_key: 'bad key',
      });
      throw new Error('expected credential refusal');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('credential value was not printed');
      expect(msg).not.toContain('bad key');
    }
  });

  test('live Fireflies adapter lists then hydrates completed transcript details without leaking credentials', async () => {
    const apiKey = 'fireflies_live_secret_fixture_123';
    const calls: Array<{ operation: string; variables: Record<string, unknown>; api_key: string }> = [];
    const adapter = createFirefliesProviderAdapter({
      mode: 'live',
      allow_live_fetch: true,
      api_key: apiKey,
      fetch_graphql: async (request) => {
        calls.push({ operation: request.operation, variables: request.variables, api_key: request.api_key });
        if (request.operation === 'list') {
          return {
            data: {
              transcripts: [{ id: 'live-eli5defi-0001', title: 'Jiraiya <> Eli5DeFi', date: 1780456200000 }],
            },
          };
        }
        return {
          data: {
            transcript: {
              id: 'live-eli5defi-0001',
              title: 'Jiraiya <> Eli5DeFi',
              date: 1780456200000,
              dateString: '2026-06-03 11:10 AM',
              organizer_email: 'jiraiya@example.com',
              participants: ['jiraiya@example.com', 'eli5defi@example.com'],
              transcript_url: 'https://app.fireflies.ai/view/live-eli5defi-0001',
              duration: 31,
              meeting_link: 'https://meet.google.com/eli-5defi-live',
              summary: {
                short_summary: 'Introductory Eli5DeFi conversation.',
                action_items: ['Generated hint that must remain review-only'],
                topics_discussed: ['Eli5DeFi', 'Tailored'],
              },
              sentences: [
                { speaker_name: 'Jiraiya', text: 'Fresh live transcript line.', start_time: 0, end_time: 3 },
                { speaker_name: 'Eli5DeFi', text: 'We should keep this source-backed.', start_time: 4, end_time: 9 },
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

    const payloads = await adapter.fetchCompletedMeetings!({
      from_date: '2026-06-03T00:00:00.000Z',
      to_date: '2026-06-03T23:59:59.000Z',
      limit: 1,
      title_match: 'Eli5DeFi',
    });
    const meeting = adapter.normalize(payloads[0]);

    expect(calls.map((call) => call.operation)).toEqual(['list', 'detail']);
    expect(calls.every((call) => call.api_key === apiKey)).toBe(true);
    expect(meeting.provider_meeting_id).toBe('live-eli5defi-0001');
    expect(meeting.started_at).toBe('2026-06-03T03:10:00.000Z');
    expect(meeting.duration_seconds).toBe(1860);
    expect(meeting.attendees.map((attendee) => attendee.name)).toEqual(['Jiraiya', 'Eli5DeFi']);
    expect(meeting.transcript).toHaveLength(2);
    expect(JSON.stringify(payloads)).not.toContain(apiKey);
  });

  test('builds a BrainEngine-ledger runtime receipt with an Alex wake request and no transcript in prompt', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const runtime = buildMeetingRuntimeRun([meeting], {
      dry_run: true,
      paths: resolveMeetingRuntimePaths({ home: '/Users/jarvis' }),
    });

    expect(runtime.summary.source_id).toBe('default');
    expect(runtime.summary.runtime_authority).toBe('gbrain_brainengine');
    expect(runtime.summary.table_names.ledger).toBe('meeting_ledger');
    expect(runtime.summary.write_required_count).toBe(1);
    expect(runtime.summary.wake_request_count).toBe(1);
    expect(runtime.summary.wake_requests_emitted).toBe(1);
    expect(runtime.summary.review_queue_count).toBe(3);
    expect(runtime.summary.live_provider_calls).toBe(0);
    expect(runtime.summary.live_gbrain_writes).toBe(0);
    expect(runtime.write_plans[0]?.argv).toEqual([
      'gbrain',
      'put',
      runtime.receipts[0]!.page_slug,
      '--source',
      'default',
    ]);
    expect(runtime.write_plans[0]?.mode).toBe('dry_run');
    expect(runtime.enrichment_queue[0]?.reason).toContain('fallback_only');
    expect(runtime.alex_wake_requests[0]?.target_profile).toBe('alex');
    const wake = runtime.alex_wake_requests[0]!;
    expect(wake.command_plan.argv.slice(0, 11)).toEqual([
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
    expect(wake.command_plan.argv).toContain('terminal,file,skills');
    const forbiddenRuntimeWords = [
      ['cla', 'ude'].join(''),
      ['anth', 'ropic'].join(''),
      ['min', 'ion'].join(''),
    ];
    const commandOnly = wake.command_plan.argv.slice(0, wake.command_plan.argv.indexOf('-q')).join(' ');
    expect(commandOnly).not.toMatch(new RegExp(forbiddenRuntimeWords.join('|'), 'i'));
    expect(commandOnly).not.toContain('meeting-intelligence materialize');
    expect(runtime.alex_wake_requests[0]?.action).toBe('enrich_materialized_meeting');
    expect(wake.prompt_text).toContain('Load and follow the meeting-ingestion skill.');
    expect(wake.prompt_text).toContain('Provider meeting id: ff-mtg-0001');
    expect(wake.prompt_text).toContain('Meeting page: meetings/2026-05-20-acme-example-partner-review-fireflies-ff-mtg-0001');
    expect(wake.prompt_text).toContain('Source packet: sources/fireflies/2026-05-20-acme-example-partner-review-fireflies-ff-mtg-0001');
    expect(wake.prompt_text).toContain('Read the materialized GBrain pages; do not rely on this prompt for transcript content.');
    expect(wake.prompt_text).toContain('Action: enrich_materialized_meeting.');
    expect(wake.prompt_text).not.toContain('Materialize command:');
    expect(wake.prompt_text).not.toContain('Let\'s review the acme-example follow-up');
    expect(wake.prompt_text).not.toContain('enterprise pricing by Friday');
    expect(runtime.review_receipts[0]?.status).toBe('review_queued');
    expect(runtime.ledgers[0]?.state).toBe('alex_requested');
  });

  test('uses existing ledger checksums for no-op and changed-transcript runtime reconciliation', () => {
    const first = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const changed = normalizeFirefliesMeeting(fixture.fireflies.changedTranscript);
    const existing = buildMeetingRuntimeRun([first]).ledgers[0]!;

    const noop = buildMeetingRuntimeRun([first], { existing_ledgers: [existing], dry_run: true });
    expect(noop.receipts[0]?.effect).toBe('noop');
    expect(noop.write_plans[0]?.write_required).toBe(false);
    expect(noop.summary.write_required_count).toBe(0);

    const update = buildMeetingRuntimeRun([changed], {
      existing_ledgers: [existing],
      dry_run: true,
      now: '2026-05-20T04:00:00.000Z',
    });
    expect(update.receipts[0]?.effect).toBe('update');
    expect(update.write_plans[0]?.write_required).toBe(true);
    expect(update.ledgers[0]?.transcript_checksum).toBe(changed.transcript_checksum);
    expect(update.ledgers[0]?.history.map((entry) => entry.reason)).toContain(
      'changed_transcript_checksum_reset',
    );
  });

  test('builds a fallback repair sweep plan without enabling a scheduler', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const stale = buildInitialMeetingLedger(meeting, '2026-05-20T03:00:00.000Z');
    const fresh = buildInitialMeetingLedger(meeting, '2026-05-20T08:59:00.000Z');
    const sweep = buildMeetingRepairSweepPlan([stale, fresh], {
      now: '2026-05-20T09:00:00.000Z',
      stale_after_ms: 60 * 60 * 1000,
    });

    expect(sweep.poller.enabled_by_default).toBe(false);
    expect(sweep.poller.requires_approval).toBe(true);
    expect(sweep.candidates).toHaveLength(1);
    expect(sweep.candidates[0]?.action).toBe('render_or_write_page');
  });

  test('marks legacy agent-owned rows as migration-only input', () => {
    const candidate = normalizeLegacyMeetingMigrationCandidate({
      provider: 'fireflies',
      provider_meeting_id: 'ff-mtg-0001',
      source_id: 'legacy-agent-source',
    });

    expect(candidate.migration_only).toBe(true);
    expect(candidate.target_source_id).toBe('default');
    expect(candidate.canonical_write_allowed).toBe(false);
    expect(candidate.action).toBe('manual_review_required');
    expect(candidate.reason).toContain('migration input only');
  });
});
