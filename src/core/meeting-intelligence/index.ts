import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { serializeMarkdown } from '../markdown.ts';
import { slugifySegment } from '../sync.ts';

export const MEETING_INTELLIGENCE_STATES = [
  'received',
  'transcript_ready',
  'page_rendered',
  'enrichment_pending',
  'alex_requested',
  'alex_running',
  'alex_failed',
  'enriched',
  'review_queued',
  'skipped',
  'error',
] as const;

export type MeetingIntelligenceState = typeof MEETING_INTELLIGENCE_STATES[number];

export interface DiarizedTranscriptTurn {
  speaker: string;
  start_seconds: number;
  end_seconds?: number;
  text: string;
}

export interface MeetingParticipant {
  name: string;
  email?: string;
}

export interface ProviderGeneratedHints {
  summary?: string;
  action_items: string[];
  topics: string[];
}

export interface NormalizedProviderMeeting {
  provider: string;
  provider_meeting_id: string;
  title: string;
  started_at: string;
  ended_at?: string;
  meeting_date: string;
  duration_seconds?: number;
  timezone?: string;
  meeting_link?: string;
  transcript_url?: string;
  organizer?: MeetingParticipant;
  attendees: MeetingParticipant[];
  transcript: DiarizedTranscriptTurn[];
  generated: ProviderGeneratedHints;
  metadata: Record<string, unknown>;
  transcript_checksum: string;
  source_checksum: string;
  dedupe_key: string;
  state: MeetingIntelligenceState;
}

export interface MeetingLedgerTransition {
  from: MeetingIntelligenceState | null;
  to: MeetingIntelligenceState;
  reason: string;
  at: string;
}

export interface MeetingLedger {
  provider: string;
  provider_meeting_id: string;
  transcript_checksum: string;
  source_checksum: string;
  page_slug?: string;
  state: MeetingIntelligenceState;
  history: MeetingLedgerTransition[];
}

export interface TranscriptIdempotencyResult {
  effect: 'noop' | 'update' | 'insert' | 'duplicate';
  next_state: MeetingIntelligenceState;
  enqueue_enrichment: boolean;
  reason: string;
}

export interface ReviewQueueItem {
  kind: 'generated_action_item';
  label: string;
  status: 'review_queued';
  promotion: 'none';
  blocked_reason: string;
  evidence_basis: 'generated_provider_hint';
}

export interface EnrichmentGate {
  review_queue: ReviewQueueItem[];
  assigned_actions: never[];
  durable_facts: never[];
}

export interface RenderedMeetingPage {
  slug: string;
  source_id: 'default';
  markdown: string;
  transcript_checksum: string;
  content_checksum: string;
  audit: Record<string, unknown>;
}

export interface DefaultSourceWritePlan {
  source_id: string;
  argv: string[];
  env: Record<string, string>;
  target_root?: string;
}

export interface ProviderTranscriptFetchRequest {
  provider_meeting_id: string;
}

export interface ProviderCompletedMeetingsFetchRequest {
  from_date?: string;
  to_date?: string;
  limit?: number;
  title_match?: string;
  provider_meeting_id?: string;
}

export interface FirefliesGraphqlRequest {
  operation: 'list' | 'detail';
  query: string;
  variables: Record<string, unknown>;
  api_key: string;
}

export type FirefliesGraphqlFetch = (request: FirefliesGraphqlRequest) => Promise<unknown>;

export interface MeetingProviderAdapter {
  provider: string;
  normalize(payload: unknown): NormalizedProviderMeeting;
  fetchCompletedMeeting(request: ProviderTranscriptFetchRequest): Promise<unknown>;
  fetchCompletedMeetings?(request: ProviderCompletedMeetingsFetchRequest): Promise<unknown[]>;
}

export interface FirefliesProviderAdapterOpts {
  mode: 'fixture' | 'live';
  fixture_payloads?: unknown[];
  allow_live_fetch?: boolean;
  api_key?: string;
  fetch?: (request: ProviderTranscriptFetchRequest, auth: { api_key: string }) => Promise<unknown>;
  fetch_graphql?: FirefliesGraphqlFetch;
  list_limit?: number;
}

export class MeetingIntelligenceApprovalError extends Error {
  code = 'meeting_intelligence_approval_required';
}

export class MeetingIntelligenceCredentialError extends Error {
  code = 'meeting_intelligence_credential_refused';
}

export interface MeetingRuntimePaths {
  runtime_authority: 'gbrain_brainengine';
  receipt_root: string;
  source_id: 'default';
  table_names: {
    provider_records: 'meeting_provider_records';
    ledger: 'meeting_ledger';
    receipts: 'meeting_receipts';
    wake_requests: 'meeting_wake_requests';
    provider_cursors: 'meeting_provider_cursors';
  };
}

export interface MeetingPageWriteCandidate extends DefaultSourceWritePlan {
  slug: string;
  content_checksum: string;
  mode: 'dry_run' | 'live_plan';
  write_required: boolean;
  reason: string;
}

export interface EnrichmentQueuePlan {
  queue_name: 'meeting-intelligence.enrichment';
  idempotency_key: string;
  page_slug: string;
  source_id: 'default';
  status: 'queued';
  reason: string;
  review_queue_count: number;
  live_provider_calls: 0;
  live_gbrain_writes: 0;
}

export interface AlexWakeRequestPlan {
  wake_key: string;
  source_id: 'default';
  target_profile: string;
  status: 'pending';
  provider: string;
  provider_meeting_id: string;
  page_slug: string;
  source_slug: string;
  transcript_checksum: string;
  source_checksum: string;
  action: 'fetch_transcript_by_ledger_provider_id_and_enrich';
  prompt_text: string;
  payload: {
    kind: 'meeting_ingest_wake_request';
    provider: string;
    provider_meeting_id: string;
    page_slug: string;
    source_slug: string;
    transcript_checksum: string;
    action: 'fetch_transcript_by_ledger_provider_id_and_enrich';
    guardrails: string[];
  };
  command_plan: {
    env: Record<string, string>;
    argv: string[];
  };
}

export interface MeetingReviewReceipt {
  page_slug: string;
  status: 'review_queued' | 'no_review_required';
  review_queue: ReviewQueueItem[];
  generated_hints_status: 'review_queued';
  assigned_actions_promoted: 0;
  durable_facts_promoted: 0;
}

export interface MeetingRuntimeReceipt {
  kind: 'meeting_intelligence_runtime_receipt';
  receipt_id: string;
  provider: string;
  provider_meeting_id: string;
  page_slug: string;
  source_id: 'default';
  effect: TranscriptIdempotencyResult['effect'];
  dry_run: boolean;
  write_plan: MeetingPageWriteCandidate;
  enrichment: EnrichmentQueuePlan;
  alex_wake: AlexWakeRequestPlan;
  review: MeetingReviewReceipt;
  ledger: MeetingLedger;
  audit: {
    default_source_intent: true;
    live_provider_calls: 0;
    live_gbrain_writes: 0;
    write_required: boolean;
    review_queue_count: number;
    duplicate_raw_records: number;
    runtime_authority: 'gbrain_brainengine';
    table_names: MeetingRuntimePaths['table_names'];
    receipt_root: string;
  };
  trace: Array<{ step: string; status: 'ok' | 'queued' | 'skipped'; detail: string }>;
}

export interface MeetingRuntimeRun {
  receipts: MeetingRuntimeReceipt[];
  ledgers: MeetingLedger[];
  write_plans: MeetingPageWriteCandidate[];
  enrichment_queue: EnrichmentQueuePlan[];
  alex_wake_requests: AlexWakeRequestPlan[];
  review_receipts: MeetingReviewReceipt[];
  summary: {
    runtime_authority: 'gbrain_brainengine';
    table_names: MeetingRuntimePaths['table_names'];
    receipt_root: string;
    source_id: 'default';
    page_count: number;
    write_required_count: number;
    wake_request_count: number;
    wake_requests_emitted: number;
    review_queue_count: number;
    live_provider_calls: 0;
    live_gbrain_writes: 0;
  };
}

export interface MeetingRepairSweepPlan {
  candidates: Array<{
    provider: string;
    provider_meeting_id: string;
    page_slug?: string;
    state: MeetingIntelligenceState;
    action:
      | 'fetch_full_transcript'
      | 'render_or_write_page'
      | 'reemit_alex_wake'
      | 'stage_deterministic_fallback'
      | 'reconcile_enrichment'
      | 'await_human_review';
    reason: string;
  }>;
  poller: {
    enabled_by_default: false;
    requires_approval: true;
    interval_hint: 'manual_or_scheduler_after_live_rollout_approval';
  };
}

export interface LegacyMeetingMigrationCandidate {
  migration_only: true;
  provider: string;
  provider_meeting_id: string;
  legacy_source_id: string;
  target_source_id: 'default';
  canonical_write_allowed: false;
  action: 'manual_review_required' | 'adopt_default_source_with_review';
  reason: string;
}

export interface CollapsedProviderMeeting {
  canonical: NormalizedProviderMeeting;
  raw_provider_ids: string[];
  duplicates: Array<{ provider_meeting_id: string; reason: string }>;
}

export interface MeetingArtifacts {
  packets: CollapsedProviderMeeting[];
  pages: RenderedMeetingPage[];
  ledgers: MeetingLedger[];
  review_queue: ReviewQueueItem[];
  audit: {
    default_source_intent: boolean;
    live_provider_calls: 0;
    live_gbrain_writes: 0;
    duplicate_raw_records: number;
    page_count: number;
    review_queue_count: number;
  };
}

export interface MeetingDryRunOpts {
  provider_payloads: unknown[];
  output_root: string;
  allowed_root: string;
}

export interface MeetingDryRunResult {
  output_root: string;
  pages_written: number;
  audit_files_written: number;
  receipt_files_written: number;
  idempotent_pages: number;
  files: string[];
  artifacts: MeetingArtifacts;
  runtime: MeetingRuntimeRun;
}

const ALLOWED_TRANSITIONS: Record<MeetingIntelligenceState, MeetingIntelligenceState[]> = {
  received: ['transcript_ready', 'skipped', 'error'],
  transcript_ready: ['page_rendered', 'skipped', 'error'],
  page_rendered: ['enrichment_pending', 'skipped', 'error'],
  enrichment_pending: ['alex_requested', 'enriched', 'review_queued', 'skipped', 'error'],
  alex_requested: ['alex_running', 'alex_failed', 'skipped', 'error'],
  alex_running: ['enriched', 'review_queued', 'alex_failed', 'error'],
  alex_failed: ['alex_requested', 'error'],
  enriched: [],
  review_queued: ['enriched', 'skipped', 'error'],
  skipped: [],
  error: [],
};

const DEFAULT_RUNTIME_HOME = '/Users/jarvis';
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const FIREFLIES_API_URL = 'https://api.fireflies.ai/graphql';
const FIREFLIES_LIST_LIMIT = 50;

const FIREFLIES_LIST_TRANSCRIPTS_QUERY = `
query RecentTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
    id
    title
    date
    dateString
    organizer_email
    participants
    duration
    transcript_url
  }
}
`;

const FIREFLIES_DETAIL_TRANSCRIPT_QUERY = `
query TranscriptDetail($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id
    title
    date
    dateString
    organizer_email
    participants
    transcript_url
    duration
    video_url
    meeting_link
    summary {
      overview
      action_items
      short_summary
      keywords
      topics_discussed
      meeting_type
      outline
    }
    sentences {
      speaker_name
      text
      start_time
      end_time
    }
    meeting_attendees {
      displayName
      email
      phoneNumber
      name
    }
    analytics {
      sentiments {
        positive_pct
        neutral_pct
        negative_pct
      }
    }
  }
}
`;

export function createFirefliesProviderAdapter(
  opts: FirefliesProviderAdapterOpts,
): MeetingProviderAdapter {
  return {
    provider: 'fireflies',
    normalize: normalizeFirefliesMeeting,
    async fetchCompletedMeeting(request) {
      if (opts.mode === 'fixture') {
        const match = findFirefliesFixturePayload(opts.fixture_payloads ?? [], request.provider_meeting_id);
        if (!match) {
          throw new Error(
            `fixture Fireflies meeting not found: ${redactSensitiveText(request.provider_meeting_id)}`,
          );
        }
        return match;
      }

      assertFirefliesLiveFetchAllowed(opts);
      if (opts.fetch) return opts.fetch(request, { api_key: opts.api_key!.trim() });
      return fetchLiveFirefliesTranscriptDetail(opts, request.provider_meeting_id);
    },
    async fetchCompletedMeetings(request) {
      if (opts.mode === 'fixture') {
        return (opts.fixture_payloads ?? [])
          .filter((payload) => {
            const raw = asOptionalRecord(payload);
            const id = optionalString(raw?.id ?? raw?.transcript_id);
            if (request.provider_meeting_id && id !== request.provider_meeting_id) return false;
            if (request.title_match) {
              const title = optionalString(raw?.title) ?? '';
              if (!matchesText(title, request.title_match)) return false;
            }
            return true;
          })
          .slice(0, clampPositiveInt(request.limit, 10, 100));
      }
      return fetchLiveFirefliesCompletedMeetings(opts, request);
    },
  };
}

function findFirefliesFixturePayload(payloads: readonly unknown[], providerMeetingId: string): unknown | undefined {
  return payloads.find((payload) => {
    const raw = asOptionalRecord(payload);
    const id = optionalString(raw?.id ?? raw?.transcript_id);
    return id === providerMeetingId;
  });
}

export function assertFirefliesLiveFetchAllowed(
  opts: Pick<FirefliesProviderAdapterOpts, 'allow_live_fetch' | 'api_key'>,
): void {
  if (!opts.allow_live_fetch) {
    throw new MeetingIntelligenceApprovalError(
      'live Fireflies fetch requires explicit rollout approval; no provider credentials were read or printed',
    );
  }
  const apiKey = optionalString(opts.api_key);
  if (!apiKey) {
    throw new MeetingIntelligenceCredentialError(
      'approved live Fireflies fetch requires an API key; credential value was not printed',
    );
  }
  if (apiKey.length < 12 || /\s/.test(apiKey)) {
    throw new MeetingIntelligenceCredentialError(
      'approved live Fireflies fetch received an invalid API key shape; credential value was not printed',
    );
  }
}

async function fetchLiveFirefliesCompletedMeetings(
  opts: FirefliesProviderAdapterOpts,
  request: ProviderCompletedMeetingsFetchRequest,
): Promise<unknown[]> {
  assertFirefliesLiveFetchAllowed(opts);
  if (request.provider_meeting_id) {
    return [await fetchLiveFirefliesTranscriptDetail(opts, request.provider_meeting_id)];
  }
  const fromDate = requireString(request.from_date, 'live Fireflies watch from_date');
  const limit = clampPositiveInt(request.limit, 10, 100);
  const listLimit = Math.min(clampPositiveInt(opts.list_limit, FIREFLIES_LIST_LIMIT, FIREFLIES_LIST_LIMIT), limit);
  const summaries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let skip = 0;

  while (summaries.length < limit) {
    const payload = await runFirefliesGraphql(opts, {
      operation: 'list',
      query: FIREFLIES_LIST_TRANSCRIPTS_QUERY,
      variables: {
        fromDate,
        toDate: request.to_date ?? null,
        limit: listLimit,
        skip,
      },
      api_key: opts.api_key!.trim(),
    });
    const data = asOptionalRecord(payload)?.data;
    const transcripts = asOptionalRecord(data)?.transcripts;
    if (!Array.isArray(transcripts)) {
      throw new Error('Fireflies live list returned invalid transcripts payload');
    }
    const pageItems = transcripts.filter((item): item is Record<string, unknown> => Boolean(asOptionalRecord(item)));
    let newItems = 0;
    for (const item of pageItems) {
      const id = optionalString(item.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      newItems++;
      if (request.title_match && !matchesText(optionalString(item.title) ?? '', request.title_match)) continue;
      summaries.push(item);
      if (summaries.length >= limit) break;
    }
    if (pageItems.length < listLimit || newItems === 0) break;
    skip += listLimit;
  }

  const details: unknown[] = [];
  for (const summary of summaries) {
    const id = requireString(summary.id, 'Fireflies transcript id');
    const detail = await fetchLiveFirefliesTranscriptDetail(opts, id);
    if (request.title_match) {
      const title = optionalString(asOptionalRecord(detail)?.title) ?? '';
      if (!matchesText(title, request.title_match)) continue;
    }
    const meeting = normalizeFirefliesMeeting(detail);
    if (meeting.transcript.length === 0) continue;
    details.push(detail);
    if (details.length >= limit) break;
  }
  return details;
}

async function fetchLiveFirefliesTranscriptDetail(
  opts: FirefliesProviderAdapterOpts,
  providerMeetingId: string,
): Promise<Record<string, unknown>> {
  assertFirefliesLiveFetchAllowed(opts);
  const payload = await runFirefliesGraphql(opts, {
    operation: 'detail',
    query: FIREFLIES_DETAIL_TRANSCRIPT_QUERY,
    variables: { transcriptId: providerMeetingId },
    api_key: opts.api_key!.trim(),
  });
  const data = asOptionalRecord(asOptionalRecord(payload)?.data);
  const transcript = asOptionalRecord(data?.transcript);
  if (!transcript) {
    throw new Error(`Fireflies live detail returned no transcript for ${redactSensitiveText(providerMeetingId)}`);
  }
  return normalizeFirefliesApiTranscriptPayload(transcript as Record<string, unknown>);
}

async function runFirefliesGraphql(
  opts: FirefliesProviderAdapterOpts,
  request: FirefliesGraphqlRequest,
): Promise<unknown> {
  if (opts.fetch_graphql) return opts.fetch_graphql(request);
  return performFirefliesGraphqlRequest(request);
}

export async function performFirefliesGraphqlRequest(request: FirefliesGraphqlRequest): Promise<unknown> {
  const response = await fetch(FIREFLIES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.api_key}`,
    },
    body: JSON.stringify({ query: request.query, variables: request.variables }),
  });
  if (response.status === 401) {
    throw new MeetingIntelligenceCredentialError('Fireflies API key rejected; credential value was not printed');
  }
  if (response.status === 429) {
    throw new Error('Fireflies API rate limited; credential value was not printed');
  }
  if (!response.ok) {
    throw new Error(`Fireflies API ${request.operation} request failed with HTTP ${response.status}; credential value was not printed`);
  }
  const payload = await response.json();
  const record = asRecord(payload, 'Fireflies GraphQL response');
  if (record.errors) {
    throw new Error(`Fireflies GraphQL ${request.operation} returned errors; credential value was not printed`);
  }
  if (!('data' in record)) {
    throw new Error(`Fireflies GraphQL ${request.operation} returned no data; credential value was not printed`);
  }
  return record;
}

function normalizeFirefliesApiTranscriptPayload(detail: Record<string, unknown>): Record<string, unknown> {
  const id = requireString(detail.id, 'Fireflies transcript id');
  const dateMs = optionalNumber(detail.date);
  const startedAt = optionalString(detail.started_at ?? detail.date_recorded)
    ?? (dateMs !== undefined ? new Date(dateMs).toISOString() : undefined);
  const durationSeconds = optionalNumber(detail.duration_seconds)
    ?? (optionalNumber(detail.duration) !== undefined ? Math.round(optionalNumber(detail.duration)! * 60) : undefined);
  const organizerEmail = optionalString(detail.organizer_email);
  return {
    provider: 'fireflies',
    id,
    transcript_id: id,
    title: stringOr(detail.title, 'Untitled meeting'),
    started_at: requireString(startedAt, 'Fireflies meeting started_at'),
    date_recorded: requireString(startedAt, 'Fireflies meeting date_recorded'),
    duration_seconds: durationSeconds,
    transcript_url: optionalString(detail.transcript_url),
    meeting_link: optionalString(detail.meeting_link),
    video_url: optionalString(detail.video_url),
    organizer: organizerEmail ? { name: organizerEmail, email: organizerEmail } : undefined,
    attendees: normalizeFirefliesApiAttendees(detail.meeting_attendees, detail.participants),
    summary: asOptionalRecord(detail.summary) ?? {},
    sentences: Array.isArray(detail.sentences) ? detail.sentences : [],
    metadata: redactRecord({
      date: detail.date,
      dateString: detail.dateString,
      organizer_email: detail.organizer_email,
      participants: detail.participants,
      analytics: detail.analytics,
      provider_shape: 'fireflies_graphql_transcript_detail_v1',
    }),
  };
}

function normalizeFirefliesApiAttendees(attendees: unknown, participants: unknown): MeetingParticipant[] {
  const seen = new Set<string>();
  const seenEmails = new Set<string>();
  const result: MeetingParticipant[] = [];
  const push = (participant: MeetingParticipant | undefined) => {
    if (!participant) return;
    const emailKey = participant.email?.toLowerCase();
    if (emailKey && seenEmails.has(emailKey)) return;
    const key = `${participant.name}|${participant.email ?? ''}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (emailKey) seenEmails.add(emailKey);
    result.push(participant);
  };
  if (Array.isArray(attendees)) {
    for (const attendee of attendees) {
      const row = asOptionalRecord(attendee);
      if (!row) continue;
      const email = optionalString(row.email);
      const name = optionalString(row.displayName ?? row.name ?? row.phoneNumber ?? email);
      if (name) push(email ? { name, email } : { name });
    }
  }
  if (Array.isArray(participants)) {
    for (const item of participants) {
      if (typeof item === 'string') {
        const label = optionalString(item);
        if (label) push(label.includes('@') ? { name: label, email: label } : { name: label });
        continue;
      }
      push(normalizeParticipant(item));
    }
  }
  return result;
}

function matchesText(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return Math.min(value, max);
}

export function resolveMeetingRuntimePaths(
  opts: { home?: string; receipt_root?: string } = {},
): MeetingRuntimePaths {
  const home = opts.home ?? DEFAULT_RUNTIME_HOME;
  return {
    runtime_authority: 'gbrain_brainengine',
    receipt_root: opts.receipt_root ?? join(home, 'ops', 'meeting-intelligence'),
    source_id: 'default',
    table_names: {
      provider_records: 'meeting_provider_records',
      ledger: 'meeting_ledger',
      receipts: 'meeting_receipts',
      wake_requests: 'meeting_wake_requests',
      provider_cursors: 'meeting_provider_cursors',
    },
  };
}

export function normalizeFirefliesMeeting(payload: unknown): NormalizedProviderMeeting {
  const raw = asRecord(payload, 'Fireflies meeting payload');
  const provider = stringOr(raw.provider, 'fireflies').toLowerCase();
  const providerMeetingId = requireString(raw.id ?? raw.transcript_id, 'Fireflies meeting id');
  const title = stringOr(raw.title, 'Untitled meeting');
  const startedAt = requireString(raw.started_at ?? raw.date_recorded, 'Fireflies meeting started_at');
  const meetingDate = isoDate(startedAt);
  const summary = asOptionalRecord(raw.summary);
  const transcript = normalizeFirefliesTranscript(raw.sentences);
  const generated: ProviderGeneratedHints = {
    summary: optionalString(summary?.short_summary ?? summary?.overview),
    action_items: stringArray(summary?.action_items),
    topics: stringArray(summary?.topics_discussed ?? summary?.keywords),
  };
  const sourceMaterial = {
    provider,
    provider_meeting_id: providerMeetingId,
    title,
    started_at: startedAt,
    ended_at: optionalString(raw.ended_at),
    duration_seconds: optionalNumber(raw.duration_seconds),
    timezone: optionalString(raw.timezone),
    meeting_link: optionalString(raw.meeting_link),
    transcript_url: optionalString(raw.transcript_url),
    organizer: normalizeParticipant(raw.organizer),
    attendees: normalizeParticipants(raw.attendees),
    generated,
    transcript,
    metadata: asOptionalRecord(raw.metadata) ?? {},
  };
  const transcriptChecksum = computeTranscriptChecksum(transcript);
  const sourceChecksum = sha256(stableStringify(sourceMaterial));
  const meetingLink = optionalString(raw.meeting_link);
  const dedupeKey = [
    provider,
    meetingLink ? normalizeDedupeLink(meetingLink) : providerMeetingId,
    meetingDate,
    slugifySegment(title),
  ].join('|');

  return {
    provider,
    provider_meeting_id: providerMeetingId,
    title,
    started_at: startedAt,
    ended_at: sourceMaterial.ended_at,
    meeting_date: meetingDate,
    duration_seconds: sourceMaterial.duration_seconds,
    timezone: sourceMaterial.timezone,
    meeting_link: meetingLink,
    transcript_url: optionalString(raw.transcript_url),
    organizer: sourceMaterial.organizer,
    attendees: sourceMaterial.attendees,
    transcript,
    generated,
    metadata: sourceMaterial.metadata,
    transcript_checksum: transcriptChecksum,
    source_checksum: sourceChecksum,
    dedupe_key: dedupeKey,
    state: transcript.length > 0 ? 'transcript_ready' : 'received',
  };
}

function normalizeFirefliesTranscript(value: unknown): DiarizedTranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, idx) => {
    const row = asRecord(item, `Fireflies sentence ${idx}`);
    return {
      speaker: stringOr(row.speaker_name ?? row.speaker, 'unknown-speaker'),
      start_seconds: numberOr(row.start_time ?? row.start_seconds, 0),
      end_seconds: optionalNumber(row.end_time ?? row.end_seconds),
      text: requireString(row.text, `Fireflies sentence ${idx} text`),
    };
  }).sort((a, b) => a.start_seconds - b.start_seconds);
}

export function computeTranscriptChecksum(transcript: readonly DiarizedTranscriptTurn[]): string {
  return sha256(stableStringify(transcript.map((turn) => ({
    speaker: turn.speaker,
    start_seconds: turn.start_seconds,
    end_seconds: turn.end_seconds ?? null,
    text: turn.text,
  }))));
}

export function buildInitialMeetingLedger(
  meeting: NormalizedProviderMeeting,
  at = meeting.started_at,
): MeetingLedger {
  return {
    provider: meeting.provider,
    provider_meeting_id: meeting.provider_meeting_id,
    transcript_checksum: meeting.transcript_checksum,
    source_checksum: meeting.source_checksum,
    state: meeting.state,
    history: [{
      from: null,
      to: meeting.state,
      reason: 'normalized_provider_event',
      at,
    }],
  };
}

export function transitionMeetingLedger(
  ledger: MeetingLedger,
  nextState: MeetingIntelligenceState,
  reason = 'meeting_intelligence_step',
  at?: string,
): MeetingLedger {
  const allowed = ALLOWED_TRANSITIONS[ledger.state] ?? [];
  if (!allowed.includes(nextState)) {
    throw new Error(
      `invalid meeting intelligence transition: ${ledger.state} -> ${nextState}`,
    );
  }
  const transitionAt = at ?? ledger.history[ledger.history.length - 1]?.at;
  if (!transitionAt) {
    throw new Error('meeting intelligence ledger transition timestamp is required');
  }
  return {
    ...ledger,
    state: nextState,
    history: [
      ...ledger.history,
      {
        from: ledger.state,
        to: nextState,
        reason,
        at: transitionAt,
      },
    ],
  };
}

export function evaluateTranscriptIdempotency(
  existing: MeetingLedger | null,
  meeting: NormalizedProviderMeeting,
): TranscriptIdempotencyResult {
  if (!existing) {
    return {
      effect: 'insert',
      next_state: meeting.state,
      enqueue_enrichment: meeting.state === 'transcript_ready',
      reason: 'new_provider_meeting',
    };
  }
  if (
    existing.provider === meeting.provider
    && existing.provider_meeting_id === meeting.provider_meeting_id
    && existing.transcript_checksum === meeting.transcript_checksum
  ) {
    return {
      effect: 'noop',
      next_state: 'skipped',
      enqueue_enrichment: false,
      reason: 'same_provider_id_same_transcript_checksum',
    };
  }
  if (
    existing.provider === meeting.provider
    && existing.provider_meeting_id === meeting.provider_meeting_id
    && existing.transcript_checksum !== meeting.transcript_checksum
  ) {
    return {
      effect: 'update',
      next_state: 'transcript_ready',
      enqueue_enrichment: true,
      reason: 'same_provider_id_changed_transcript_checksum',
    };
  }
  return {
    effect: 'duplicate',
    next_state: 'skipped',
    enqueue_enrichment: false,
    reason: 'different_provider_id_duplicate_candidate',
  };
}

export function resetMeetingLedgerForChangedTranscript(
  existing: MeetingLedger,
  meeting: NormalizedProviderMeeting,
  at: string,
): MeetingLedger {
  return {
    ...existing,
    provider: meeting.provider,
    provider_meeting_id: meeting.provider_meeting_id,
    transcript_checksum: meeting.transcript_checksum,
    source_checksum: meeting.source_checksum,
    state: 'transcript_ready',
    history: [
      ...existing.history,
      {
        from: existing.state,
        to: 'transcript_ready',
        reason: 'changed_transcript_checksum_reset',
        at,
      },
    ],
  };
}

export function collapseProviderDuplicates(
  meetings: readonly NormalizedProviderMeeting[],
): CollapsedProviderMeeting[] {
  const groups = new Map<string, Array<{ meeting: NormalizedProviderMeeting; index: number }>>();
  meetings.forEach((meeting, index) => {
    const group = groups.get(meeting.dedupe_key) ?? [];
    group.push({ meeting, index });
    groups.set(meeting.dedupe_key, group);
  });

  return [...groups.values()].map((group) => {
    const latestByProviderId = new Map<string, { meeting: NormalizedProviderMeeting; index: number }>();
    const superseded: CollapsedProviderMeeting['duplicates'] = [];

    for (const item of group.sort((a, b) => a.index - b.index)) {
      const existing = latestByProviderId.get(item.meeting.provider_meeting_id);
      if (!existing) {
        latestByProviderId.set(item.meeting.provider_meeting_id, item);
        continue;
      }
      superseded.push({
        provider_meeting_id: existing.meeting.provider_meeting_id,
        reason: existing.meeting.transcript_checksum === item.meeting.transcript_checksum
          ? 'same_provider_id_same_transcript_checksum'
          : 'same_provider_id_changed_transcript_superseded',
      });
      latestByProviderId.set(item.meeting.provider_meeting_id, item);
    }

    const candidates = [...latestByProviderId.values()];
    const sorted = candidates.sort((a, b) => {
      const transcriptDelta = b.meeting.transcript.length - a.meeting.transcript.length;
      if (transcriptDelta !== 0) return transcriptDelta;
      const startDelta = Date.parse(a.meeting.started_at) - Date.parse(b.meeting.started_at);
      if (startDelta !== 0) return startDelta;
      const providerIdDelta = a.meeting.provider_meeting_id.localeCompare(b.meeting.provider_meeting_id);
      if (providerIdDelta !== 0) return providerIdDelta;
      return b.index - a.index;
    });
    const canonical = sorted[0]!.meeting;
    const duplicateProviderRecords = sorted
      .slice(1)
      .map((item) => ({
        provider_meeting_id: item.meeting.provider_meeting_id,
        reason: 'same_provider_meeting_link_date_and_title',
      }));
    const duplicateProviderIds = [...new Set(duplicateProviderRecords
      .map((duplicate) => duplicate.provider_meeting_id))]
      .sort();
    return {
      canonical,
      raw_provider_ids: [canonical.provider_meeting_id, ...duplicateProviderIds],
      duplicates: [...duplicateProviderRecords, ...superseded],
    };
  }).sort((a, b) => a.canonical.started_at.localeCompare(b.canonical.started_at));
}

export function buildEnrichmentGate(meeting: NormalizedProviderMeeting): EnrichmentGate {
  return {
    review_queue: meeting.generated.action_items.map((item) => ({
      kind: 'generated_action_item',
      label: redactSensitiveText(item),
      status: 'review_queued',
      promotion: 'none',
      blocked_reason:
        'generated_provider_hint_without_transcript_or_human_note_evidence',
      evidence_basis: 'generated_provider_hint',
    })),
    assigned_actions: [],
    durable_facts: [],
  };
}

export function renderMeetingPage(
  meeting: NormalizedProviderMeeting,
  opts: { raw_provider_ids?: string[]; duplicates?: CollapsedProviderMeeting['duplicates'] } = {},
): RenderedMeetingPage {
  const slug = buildMeetingSlug(meeting);
  const gate = buildEnrichmentGate(meeting);
  const rawProviderIds = opts.raw_provider_ids ?? [meeting.provider_meeting_id];
  const duplicates = opts.duplicates ?? [];
  const sourceSlug = buildSourcePacketSlug(meeting);
  const compiledTruth = [
    `# ${redactSensitiveText(meeting.title)}`,
    '',
    '## Meeting Record',
    `- Provider adapter: ${meeting.provider}`,
    '- Canonical owner: GBrain meeting intelligence',
    '- GBrain source intent: default',
    `- Provider meeting id: ${redactSensitiveText(meeting.provider_meeting_id)}`,
    `- Source packet: [Fireflies Source Packet](../${sourceSlug}.md)`,
    `- Started at: ${meeting.started_at}`,
    meeting.duration_seconds !== undefined ? `- Duration seconds: ${meeting.duration_seconds}` : '- Duration seconds: unknown',
    `- Transcript checksum: ${meeting.transcript_checksum}`,
    `- Raw provider ids: ${rawProviderIds.map(redactSensitiveText).join(', ')}`,
    duplicates.length > 0
      ? `- Duplicate raw records collapsed: ${duplicates.length}`
      : '- Duplicate raw records collapsed: 0',
    '',
    '## Attendees',
    ...formatMeetingParticipants(meeting),
    '',
    '## Provider Summary Hint',
    ...formatProviderSummaryHint(meeting.generated.summary),
    '',
    '## Topics Hinted by Provider',
    ...formatProviderTopics(meeting.generated.topics),
    '',
    '## Provider Hints Requiring Review',
    ...formatProviderHints(gate.review_queue),
    '',
    '## Enrichment Gate',
    '- Generated summaries and action items are review candidates only.',
    '- Assigned actions promoted: 0',
    '- Durable facts promoted: 0',
  ].join('\n');

  const timeline = [
    '## Full Diarized Transcript',
    '',
    ...meeting.transcript.map((turn) =>
      `**${redactSensitiveText(turn.speaker)}** (${formatDuration(turn.start_seconds)}): ${redactSensitiveText(turn.text)}`),
  ].join('\n');

  const frontmatter = {
    provider: meeting.provider,
    provider_meeting_id: redactSensitiveText(meeting.provider_meeting_id),
    provider_canonical_id: `${meeting.provider}:${redactSensitiveText(meeting.provider_meeting_id)}`,
    gbrain_source_id: 'default',
    meeting_date: meeting.meeting_date,
    started_at: meeting.started_at,
    duration_seconds: meeting.duration_seconds ?? null,
    transcript_checksum: meeting.transcript_checksum,
    source_checksum: meeting.source_checksum,
    meeting_intelligence_state: 'enrichment_pending',
    generated_hints_status: 'review_queued',
    raw_provider_ids: rawProviderIds.map(redactSensitiveText),
    duplicate_provider_ids: duplicates.map((d) => redactSensitiveText(d.provider_meeting_id)),
    source_system: 'meeting-intelligence',
  };
  const markdown = serializeMarkdown(
    frontmatter,
    compiledTruth,
    timeline,
    {
      type: 'meeting',
      title: redactSensitiveText(meeting.title),
      tags: ['meeting', 'meeting-intelligence', meeting.provider],
    },
  );
  const audit = redactRecord({
    slug,
    source_id: 'default',
    provider: meeting.provider,
    provider_meeting_id: meeting.provider_meeting_id,
    transcript_checksum: meeting.transcript_checksum,
    content_checksum: sha256(markdown),
    review_queue_count: gate.review_queue.length,
    duplicate_provider_ids: duplicates.map((d) => d.provider_meeting_id),
    provider_urls: [meeting.meeting_link, meeting.transcript_url].filter(Boolean),
  });

  return {
    slug,
    source_id: 'default',
    markdown,
    transcript_checksum: meeting.transcript_checksum,
    content_checksum: sha256(markdown),
    audit,
  };
}

function formatProviderHints(items: readonly ReviewQueueItem[]): string[] {
  if (items.length === 0) return ['- No generated provider action hints captured.'];
  return items.map((item) =>
    `- [${item.status}] ${item.label} (${item.blocked_reason})`);
}

function formatMeetingParticipants(meeting: NormalizedProviderMeeting): string[] {
  const seen = new Set<string>();
  const participants: MeetingParticipant[] = [];
  const push = (participant: MeetingParticipant | undefined) => {
    if (!participant) return;
    const label = optionalString(participant.name);
    if (!label) return;
    const key = `${label}|${participant.email ?? ''}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    participants.push(participant.email ? { name: label, email: participant.email } : { name: label });
  };

  push(meeting.organizer);
  for (const attendee of meeting.attendees) push(attendee);
  for (const speaker of distinctTranscriptSpeakers(meeting.transcript)) push({ name: speaker });

  if (participants.length === 0) return ['- No attendees captured in provider metadata or transcript speakers.'];
  return participants.map(formatMeetingParticipant);
}

function distinctTranscriptSpeakers(transcript: readonly DiarizedTranscriptTurn[]): string[] {
  const seen = new Set<string>();
  const speakers: string[] = [];
  for (const turn of transcript) {
    const label = optionalString(turn.speaker);
    if (!label) continue;
    if (/^unknown[-_\s]?speaker$/i.test(label)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    speakers.push(label);
  }
  return speakers;
}

function formatMeetingParticipant(participant: MeetingParticipant): string {
  const label = redactSensitiveText(participant.name);
  const suffix = participant.email ? ` (${redactSensitiveText(participant.email)})` : '';
  if (shouldLinkParticipant(label)) {
    return `- ${formatPersonPageLink(label)}${suffix}`;
  }
  return `- ${label}${suffix}`;
}

function shouldLinkParticipant(label: string): boolean {
  if (!label || label.includes('@')) return false;
  if (label.startsWith('<REDACTED:')) return false;
  return slugifySegment(label).length > 0;
}

function formatPersonPageLink(label: string): string {
  return `[${label}](../people/${slugifySegment(label)}.md)`;
}

function formatProviderSummaryHint(summary: string | undefined): string[] {
  const redacted = optionalString(summary ? redactSensitiveText(summary) : undefined);
  if (!redacted) return ['- No provider summary captured.'];
  return [
    `- ${redacted}`,
    '- Boundary: provider-generated summary is a navigation aid, not durable truth until transcript or human notes support it.',
  ];
}

function formatProviderTopics(topics: readonly string[]): string[] {
  const cleaned = [...new Set(topics.map((topic) => optionalString(redactSensitiveText(topic))).filter(Boolean) as string[])];
  if (cleaned.length === 0) return ['- No provider topics captured.'];
  return cleaned.map((topic) => `- ${topic}`);
}

export function buildSourcePacketSlug(meeting: NormalizedProviderMeeting): string {
  return buildMeetingSlug(meeting).replace(/^meetings\//, `sources/${meeting.provider}/`);
}

export function buildMeetingSlug(meeting: NormalizedProviderMeeting): string {
  const title = slugifySegment(redactSensitiveText(meeting.title)) || 'redacted-meeting';
  const provider = slugifySegment(redactSensitiveText(meeting.provider)) || 'provider';
  const providerId = slugifySegment(redactSensitiveText(meeting.provider_meeting_id)) || 'redacted-id';
  return `meetings/${meeting.meeting_date}-${title}-${provider}-${providerId}`;
}

export function buildDefaultSourceWritePlan(page: RenderedMeetingPage): DefaultSourceWritePlan {
  const plan: DefaultSourceWritePlan = {
    source_id: 'default',
    argv: ['gbrain', 'put', page.slug, '--source', 'default'],
    env: {},
    target_root: 'gbrain-default-source',
  };
  assertDefaultSourceWriteIntent(plan);
  return plan;
}

export function assertDefaultSourceWriteIntent(plan: DefaultSourceWritePlan): void {
  if (plan.source_id !== 'default') {
    throw new Error(`meeting intelligence writes must target default source, got ${plan.source_id}`);
  }
  const envSource = plan.env.GBRAIN_SOURCE;
  if (envSource !== undefined && envSource !== 'default') {
    throw new Error(`meeting intelligence writes must not override default source via environment`);
  }
  const sourceFlagIndex = plan.argv.indexOf('--source');
  if (sourceFlagIndex < 0) {
    throw new Error('meeting intelligence CLI write plans must include explicit --source default');
  }
  const value = plan.argv[sourceFlagIndex + 1];
  if (value !== 'default') {
    throw new Error('meeting intelligence writes must not route through non-default source flags');
  }
  const target = plan.target_root?.toLowerCase() ?? '';
  if (target.includes('openclaw') || (target.includes('jarvis-v2') && target.includes('brain'))) {
    throw new Error('meeting intelligence writes must not target legacy agent-owned roots');
  }
}

export function buildMeetingPageWriteCandidate(
  page: RenderedMeetingPage,
  opts: { dry_run?: boolean; write_required?: boolean; reason?: string } = {},
): MeetingPageWriteCandidate {
  const plan = buildDefaultSourceWritePlan(page);
  return {
    ...plan,
    slug: page.slug,
    content_checksum: page.content_checksum,
    mode: opts.dry_run ? 'dry_run' : 'live_plan',
    write_required: opts.write_required ?? true,
    reason: opts.reason ?? 'full_transcript_page_default_source_write_plan',
  };
}

export function buildEnrichmentQueuePlan(
  meeting: NormalizedProviderMeeting,
  page: RenderedMeetingPage,
  gate = buildEnrichmentGate(meeting),
): EnrichmentQueuePlan {
  return {
    queue_name: 'meeting-intelligence.enrichment',
    idempotency_key: sha256([
      page.slug,
      page.transcript_checksum,
      gate.review_queue.length,
    ].join('|')),
    page_slug: page.slug,
    source_id: 'default',
    status: 'queued',
    reason: 'fallback_only_after_alex_wake_failure_or_repair',
    review_queue_count: gate.review_queue.length,
    live_provider_calls: 0,
    live_gbrain_writes: 0,
  };
}

export function buildAlexWakeRequestPlan(
  meeting: NormalizedProviderMeeting,
  page: RenderedMeetingPage,
  opts: { target_profile?: string } = {},
): AlexWakeRequestPlan {
  const targetProfile = opts.target_profile ?? 'alex';
  const wakeKey = sha256([
    'alex-wake',
    targetProfile,
    meeting.provider,
    meeting.provider_meeting_id,
    meeting.transcript_checksum,
  ].join('|'));
  const providerMeetingId = redactSensitiveText(meeting.provider_meeting_id);
  const sourceSlug = page.slug.replace(/^meetings\//, `sources/${meeting.provider}/`);
  const guardrails = [
    'Read the materialized GBrain pages; do not rely on this prompt for transcript content.',
    'Write durable meeting/source/person/company knowledge only to GBrain source_id=default.',
    'Treat generated provider summaries and action items as low-trust hints until transcript or human notes support them.',
    'Queue fuzzy identity, money/legal/commercial commitments, and unsupported action ownership for review instead of promoting them.',
    'Capture changed pages back to GBrain, read them back, and record receipts before closing the wake.',
  ];
  const promptText = [
    'Meeting ingest enrichment wake request.',
    'Load and follow the meeting-ingestion skill.',
    `Provider: ${redactSensitiveText(meeting.provider)}`,
    `Provider meeting id: ${providerMeetingId}`,
    `Meeting page: ${page.slug}`,
    `Source packet: ${sourceSlug}`,
    `Transcript checksum: ${meeting.transcript_checksum}`,
    'Action: enrich attendee/entity Brain pages from the materialized meeting/source pages only; do not call Claude, Anthropic, or Minions by default.',
    'Extraction lenses: identity, origin/current location, family/language context, travel context, working style, content direction, commercial signals, follow-ups, review-only risks.',
    'Guardrails:',
    ...guardrails.map((item) => `- ${item}`),
  ].join('\n');
  const argv = [
    'hermes',
    '--profile',
    targetProfile,
    '--skills',
    'meeting-ingestion',
    'chat',
    '-Q',
    '--source',
    'meeting-intelligence-wake',
    '-q',
    promptText,
  ];
  return {
    wake_key: wakeKey,
    source_id: 'default',
    target_profile: targetProfile,
    status: 'pending',
    provider: meeting.provider,
    provider_meeting_id: providerMeetingId,
    page_slug: page.slug,
    source_slug: sourceSlug,
    transcript_checksum: meeting.transcript_checksum,
    source_checksum: meeting.source_checksum,
    action: 'fetch_transcript_by_ledger_provider_id_and_enrich',
    prompt_text: promptText,
    payload: {
      kind: 'meeting_ingest_wake_request',
      provider: meeting.provider,
      provider_meeting_id: providerMeetingId,
      page_slug: page.slug,
      source_slug: sourceSlug,
      transcript_checksum: meeting.transcript_checksum,
      action: 'fetch_transcript_by_ledger_provider_id_and_enrich',
      guardrails,
    },
    command_plan: {
      env: { HERMES_PROFILE: targetProfile },
      argv,
    },
  };
}

export function buildMeetingReviewReceipt(
  page: RenderedMeetingPage,
  gate: EnrichmentGate,
): MeetingReviewReceipt {
  return {
    page_slug: page.slug,
    status: gate.review_queue.length > 0 ? 'review_queued' : 'no_review_required',
    review_queue: gate.review_queue,
    generated_hints_status: 'review_queued',
    assigned_actions_promoted: 0,
    durable_facts_promoted: 0,
  };
}

export function reconcileMeetingRuntimeEvent(
  packet: CollapsedProviderMeeting,
  existing: MeetingLedger | null,
  opts: { now?: string; dry_run?: boolean; paths?: MeetingRuntimePaths } = {},
): MeetingRuntimeReceipt {
  const meeting = packet.canonical;
  const paths = opts.paths ?? resolveMeetingRuntimePaths();
  const now = opts.now ?? meeting.started_at;
  const idempotency = evaluateTranscriptIdempotency(existing, meeting);
  const page = renderMeetingPage(meeting, {
    raw_provider_ids: packet.raw_provider_ids,
    duplicates: packet.duplicates,
  });
  const gate = buildEnrichmentGate(meeting);
  const writeRequired = idempotency.effect !== 'noop' && idempotency.effect !== 'duplicate';
  const writePlan = buildMeetingPageWriteCandidate(page, {
    dry_run: opts.dry_run,
    write_required: writeRequired,
    reason: idempotency.reason,
  });
  const enrichment = buildEnrichmentQueuePlan(meeting, page, gate);
  const alexWake = buildAlexWakeRequestPlan(meeting, page);
  const review = buildMeetingReviewReceipt(page, gate);
  const ledger = buildRuntimeLedger(existing, meeting, page, idempotency, review, now);
  const receiptId = sha256([
    meeting.provider,
    meeting.provider_meeting_id,
    page.slug,
    meeting.transcript_checksum,
    idempotency.effect,
    opts.dry_run ? 'dry-run' : 'live-plan',
  ].join('|'));

  return {
    kind: 'meeting_intelligence_runtime_receipt',
    receipt_id: receiptId,
    provider: meeting.provider,
    provider_meeting_id: redactSensitiveText(meeting.provider_meeting_id),
    page_slug: page.slug,
    source_id: 'default',
    effect: idempotency.effect,
    dry_run: opts.dry_run === true,
    write_plan: writePlan,
    enrichment,
    alex_wake: alexWake,
    review,
    ledger,
    audit: {
      default_source_intent: true,
      live_provider_calls: 0,
      live_gbrain_writes: 0,
      write_required: writeRequired,
      review_queue_count: gate.review_queue.length,
      duplicate_raw_records: packet.duplicates.length,
      runtime_authority: paths.runtime_authority,
      table_names: paths.table_names,
      receipt_root: paths.receipt_root,
    },
    trace: [
      { step: 'provider_completed_event', status: 'ok', detail: 'provider payload accepted by adapter boundary' },
      { step: 'full_transcript_normalized', status: 'ok', detail: meeting.transcript.length > 0 ? 'diarized transcript present' : 'transcript missing' },
      { step: 'default_source_write_plan', status: writeRequired ? 'queued' : 'skipped', detail: idempotency.reason },
      { step: 'alex_wake_request', status: writeRequired ? 'queued' : 'skipped', detail: 'durable Alex wake request emitted; prompt excludes transcript text' },
      { step: 'fallback_enrichment_plan', status: 'queued', detail: enrichment.reason },
      { step: 'review_receipt', status: review.status === 'review_queued' ? 'queued' : 'ok', detail: `${review.review_queue.length} generated hints require review` },
    ],
  };
}

export function buildMeetingRuntimeRun(
  meetings: readonly NormalizedProviderMeeting[],
  opts: {
    existing_ledgers?: readonly MeetingLedger[];
    now?: string;
    dry_run?: boolean;
    paths?: MeetingRuntimePaths;
  } = {},
): MeetingRuntimeRun {
  const paths = opts.paths ?? resolveMeetingRuntimePaths();
  const existingByProviderId = new Map<string, MeetingLedger>();
  for (const ledger of opts.existing_ledgers ?? []) {
    existingByProviderId.set(`${ledger.provider}:${ledger.provider_meeting_id}`, ledger);
  }

  const receipts = collapseProviderDuplicates(meetings).map((packet) =>
    reconcileMeetingRuntimeEvent(
      packet,
      existingByProviderId.get(
        `${packet.canonical.provider}:${packet.canonical.provider_meeting_id}`,
      ) ?? null,
      { now: opts.now, dry_run: opts.dry_run, paths },
    ));
  const reviewReceipts = receipts.map((receipt) => receipt.review);
  const reviewQueueCount = reviewReceipts.reduce(
    (sum, receipt) => sum + receipt.review_queue.length,
    0,
  );

  return {
    receipts,
    ledgers: receipts.map((receipt) => receipt.ledger),
    write_plans: receipts.map((receipt) => receipt.write_plan),
    enrichment_queue: receipts.map((receipt) => receipt.enrichment),
    alex_wake_requests: receipts.map((receipt) => receipt.alex_wake),
    review_receipts: reviewReceipts,
    summary: {
      runtime_authority: paths.runtime_authority,
      table_names: paths.table_names,
      receipt_root: paths.receipt_root,
      source_id: 'default',
      page_count: receipts.length,
      write_required_count: receipts.filter((receipt) => receipt.write_plan.write_required).length,
      wake_request_count: receipts.length,
      wake_requests_emitted: receipts.filter((receipt) => receipt.write_plan.write_required).length,
      review_queue_count: reviewQueueCount,
      live_provider_calls: 0,
      live_gbrain_writes: 0,
    },
  };
}

function buildRuntimeLedger(
  existing: MeetingLedger | null,
  meeting: NormalizedProviderMeeting,
  page: RenderedMeetingPage,
  idempotency: TranscriptIdempotencyResult,
  _review: MeetingReviewReceipt,
  at: string,
): MeetingLedger {
  if (idempotency.effect === 'noop' && existing) {
    return { ...existing, page_slug: existing.page_slug ?? page.slug };
  }

  let ledger = existing && idempotency.effect === 'update'
    ? resetMeetingLedgerForChangedTranscript(existing, meeting, at)
    : buildInitialMeetingLedger(meeting, at);
  ledger = transitionMeetingLedger(ledger, 'page_rendered', 'rendered_full_transcript_page', at);
  ledger = transitionMeetingLedger(ledger, 'enrichment_pending', 'prepared_default_source_page_and_fallback_plan', at);
  ledger = transitionMeetingLedger(ledger, 'alex_requested', 'durable_alex_wake_requested', at);
  return { ...ledger, page_slug: page.slug };
}

export function buildMeetingRepairSweepPlan(
  ledgers: readonly MeetingLedger[],
  opts: { now?: string; stale_after_ms?: number } = {},
): MeetingRepairSweepPlan {
  const nowMs = Date.parse(opts.now ?? new Date(0).toISOString());
  const staleAfterMs = opts.stale_after_ms ?? DEFAULT_STALE_AFTER_MS;
  const candidates: MeetingRepairSweepPlan['candidates'] = [];

  for (const ledger of ledgers) {
    if (ledger.state === 'skipped' || ledger.state === 'error' || ledger.state === 'enriched') {
      continue;
    }
    const lastTransition = ledger.history[ledger.history.length - 1];
    const lastMs = Date.parse(lastTransition?.at ?? '');
    const stale = !Number.isFinite(lastMs) || nowMs - lastMs >= staleAfterMs;
    if (!stale) continue;
    candidates.push({
      provider: ledger.provider,
      provider_meeting_id: redactSensitiveText(ledger.provider_meeting_id),
      page_slug: ledger.page_slug,
      state: ledger.state,
      action: repairActionForState(ledger.state),
      reason: !Number.isFinite(lastMs)
        ? 'invalid_or_missing_ledger_timestamp'
        : `ledger_state_stale_for_${Math.floor((nowMs - lastMs) / 1000)}s`,
    });
  }

  return {
    candidates,
    poller: {
      enabled_by_default: false,
      requires_approval: true,
      interval_hint: 'manual_or_scheduler_after_live_rollout_approval',
    },
  };
}

function repairActionForState(
  state: MeetingIntelligenceState,
): MeetingRepairSweepPlan['candidates'][number]['action'] {
  if (state === 'received') return 'fetch_full_transcript';
  if (state === 'transcript_ready' || state === 'page_rendered') return 'render_or_write_page';
  if (state === 'alex_requested') return 'reemit_alex_wake';
  if (state === 'alex_running' || state === 'alex_failed') return 'stage_deterministic_fallback';
  if (state === 'review_queued') return 'await_human_review';
  return 'reconcile_enrichment';
}

export function normalizeLegacyMeetingMigrationCandidate(
  row: unknown,
): LegacyMeetingMigrationCandidate {
  const raw = asRecord(row, 'legacy meeting intelligence row');
  const provider = stringOr(raw.provider, 'unknown-provider');
  const providerMeetingId = requireString(
    raw.provider_meeting_id ?? raw.providerMeetingId ?? raw.transcript_id,
    'legacy provider meeting id',
  );
  const legacySourceId = stringOr(raw.source_id ?? raw.sourceId, 'unknown');
  const isDefault = legacySourceId === 'default';

  return {
    migration_only: true,
    provider: redactSensitiveText(provider),
    provider_meeting_id: redactSensitiveText(providerMeetingId),
    legacy_source_id: redactSensitiveText(legacySourceId),
    target_source_id: 'default',
    canonical_write_allowed: false,
    action: isDefault ? 'adopt_default_source_with_review' : 'manual_review_required',
    reason: isDefault
      ? 'legacy default-source row still requires receipt review before adoption'
      : 'legacy non-default source rows are migration input only and never canonical writes',
  };
}

export function buildMeetingIntelligenceArtifacts(
  meetings: readonly NormalizedProviderMeeting[],
): MeetingArtifacts {
  const packets = collapseProviderDuplicates(meetings);
  const pages: RenderedMeetingPage[] = [];
  const ledgers: MeetingLedger[] = [];
  const reviewQueue: ReviewQueueItem[] = [];

  for (const packet of packets) {
    const page = renderMeetingPage(packet.canonical, {
      raw_provider_ids: packet.raw_provider_ids,
      duplicates: packet.duplicates,
    });
    buildDefaultSourceWritePlan(page);
    pages.push(page);

    const initial = buildInitialMeetingLedger(packet.canonical);
    const rendered = transitionMeetingLedger(initial, 'page_rendered', 'rendered_full_transcript_page');
    const pending = transitionMeetingLedger(rendered, 'enrichment_pending', 'queued_evidence_gated_enrichment');
    ledgers.push({ ...pending, page_slug: page.slug });
    reviewQueue.push(...buildEnrichmentGate(packet.canonical).review_queue);
  }

  return {
    packets,
    pages,
    ledgers,
    review_queue: reviewQueue,
    audit: {
      default_source_intent: pages.every((page) => page.source_id === 'default'),
      live_provider_calls: 0,
      live_gbrain_writes: 0,
      duplicate_raw_records: packets.reduce((sum, packet) => sum + packet.duplicates.length, 0),
      page_count: pages.length,
      review_queue_count: reviewQueue.length,
    },
  };
}

export async function runMeetingIntelligenceDryRun(
  opts: MeetingDryRunOpts,
): Promise<MeetingDryRunResult> {
  assertWithinAllowedRoot(opts.output_root, opts.allowed_root);
  const normalized = opts.provider_payloads.map((payload) => normalizeFirefliesMeeting(payload));
  const artifacts = buildMeetingIntelligenceArtifacts(normalized);
  const runtime = buildMeetingRuntimeRun(normalized, { dry_run: true });
  let pagesWritten = 0;
  let auditFilesWritten = 0;
  let receiptFilesWritten = 0;
  let idempotentPages = 0;
  const files: string[] = [];

  for (const page of artifacts.pages) {
    const pagePath = join(opts.output_root, `${page.slug}.md`);
    const auditPath = join(opts.output_root, 'audit', `${page.slug.split('/').pop()}.json`);
    await mkdir(dirname(pagePath), { recursive: true });
    await mkdir(dirname(auditPath), { recursive: true });

    if (await writeIfChanged(pagePath, page.markdown)) {
      pagesWritten++;
    } else {
      idempotentPages++;
    }
    const auditBody = `${JSON.stringify({
      ...page.audit,
      dry_run: true,
      live_provider_calls: 0,
      live_gbrain_writes: 0,
    }, null, 2)}\n`;
    if (await writeIfChanged(auditPath, auditBody)) {
      auditFilesWritten++;
    }
    files.push(pagePath, auditPath);
  }

  for (const receipt of runtime.receipts) {
    const suffix = receipt.page_slug.split('/').pop() ?? receipt.receipt_id;
    const receiptPath = join(opts.output_root, 'receipts', `${suffix}.json`);
    const reviewPath = join(opts.output_root, 'review', `${suffix}.json`);
    const ledgerPath = join(opts.output_root, 'ledger', `${suffix}.json`);
    await mkdir(dirname(receiptPath), { recursive: true });
    await mkdir(dirname(reviewPath), { recursive: true });
    await mkdir(dirname(ledgerPath), { recursive: true });
    if (await writeIfChanged(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)) {
      receiptFilesWritten++;
    }
    if (await writeIfChanged(reviewPath, `${JSON.stringify(receipt.review, null, 2)}\n`)) {
      receiptFilesWritten++;
    }
    if (await writeIfChanged(ledgerPath, `${JSON.stringify(receipt.ledger, null, 2)}\n`)) {
      receiptFilesWritten++;
    }
    files.push(receiptPath, reviewPath, ledgerPath);
  }

  const summaryPath = join(opts.output_root, 'summary.json');
  const summary = {
    dry_run: true,
    output_root: opts.output_root,
    pages_written: pagesWritten,
    audit_files_written: auditFilesWritten,
    receipt_files_written: receiptFilesWritten,
    idempotent_pages: idempotentPages,
    page_count: artifacts.audit.page_count,
    duplicate_raw_records: artifacts.audit.duplicate_raw_records,
    review_queue_count: artifacts.audit.review_queue_count,
    live_provider_calls: 0,
    live_gbrain_writes: 0,
    runtime: runtime.summary,
  };
  await writeIfChanged(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  files.push(summaryPath);

  return {
    output_root: opts.output_root,
    pages_written: pagesWritten,
    audit_files_written: auditFilesWritten,
    receipt_files_written: receiptFilesWritten,
    idempotent_pages: idempotentPages,
    files,
    artifacts,
    runtime,
  };
}

function assertWithinAllowedRoot(outputRoot: string, allowedRoot: string): void {
  const output = resolve(outputRoot);
  const allowed = resolve(allowedRoot);
  if (output !== allowed && !output.startsWith(`${allowed}${sep}`)) {
    throw new Error(`dry-run output root is outside allowed dry-run root: ${output}`);
  }
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === content) return false;
  } catch {
    // Missing files are written below. Other read errors surface through writeFile.
  }
  await writeFile(path, content, 'utf8');
  return true;
}

export function redactSensitiveText(input: string): string {
  let text = input;
  text = text.replace(
    /https?:\/\/[^\s<>"']+\?(?=[^\s<>"']*(?:x-amz-signature|sig=|signature=|token=|expires=|awsaccesskeyid))[^\s<>"']+/gi,
    '<REDACTED:signed-url>',
  );
  text = text.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, '<REDACTED:bearer-token>');
  text = text.replace(/\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s)]+/gi, '<REDACTED:connection-string>');
  text = text.replace(/\b(?:token|api[_-]?key|secret|signature|password)=[^\s&)\]]+/gi, '<REDACTED:secret-param>');
  text = text.replace(/\b(?:pm|tok|acct)_[A-Za-z0-9_-]{6,}/g, '<REDACTED:payment-token>');
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, '<REDACTED:payment-card>');
  text = text.replace(/\b0x[a-fA-F0-9]{40}\b/g, '<REDACTED:wallet-address>');
  return text;
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactObject(value) as Record<string, unknown>;
}

function redactObject(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactObject(child);
    return out;
  }
  return value;
}

function normalizeParticipant(value: unknown): MeetingParticipant | undefined {
  const record = asOptionalRecord(value);
  if (!record) return undefined;
  const name = optionalString(record.name ?? record.display_name);
  if (!name) return undefined;
  const email = optionalString(record.email);
  return email ? { name, email } : { name };
}

function normalizeParticipants(value: unknown): MeetingParticipant[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const participants: MeetingParticipant[] = [];
  for (const item of value) {
    const participant = normalizeParticipant(item);
    if (!participant) continue;
    const key = `${participant.name}|${participant.email ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push(participant);
  }
  return participants;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  const str = optionalString(value);
  if (!str) throw new Error(`${label} is required`);
  return str;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return optionalNumber(value) ?? fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(optionalString)
    .filter((item): item is string => Boolean(item));
}

function isoDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid meeting timestamp: ${value}`);
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizeDedupeLink(value: string): string {
  return value.replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortStable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export * from './brainengine.ts';
