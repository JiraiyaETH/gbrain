import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { importFromContent } from '../core/import-file.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { slugifySegment } from '../core/sync.ts';
import {
  buildMeetingRepairSweepPlan,
  buildMeetingRuntimeRun,
  claimMeetingWakeRequests,
  createFirefliesProviderAdapter,
  emitMeetingWakeRequests,
  ensureMeetingIntelligenceSchema,
  loadMeetingLedgers,
  persistMeetingRuntimeRun,
  recordMeetingWakeExecutionResults,
  redactSensitiveText,
  renderMeetingPage,
  resolveMeetingRuntimePaths,
  runMeetingIntelligenceDryRun,
  type ClaimedMeetingWakeRequest,
  type FirefliesGraphqlFetch,
  type MeetingWakeExecutionResult,
  type NormalizedProviderMeeting,
} from '../core/meeting-intelligence/index.ts';

const HELP = `Usage: gbrain meeting-intelligence <command> [options]

Commands:
  dry-run      Render synthetic provider payloads to page/audit/review receipts
  watch        Poll/ingest completed provider meetings into BrainEngine ledger + Alex wake rows
  wake         Claim pending Alex wake rows and print/execute isolated Hermes command plans
  materialize  Write source packet + full meeting page from a stored provider record
  repair       Plan stale ledger/wake repair actions
  paths        Print neutral runtime authority/table defaults

Dry-run options:
  --fixture PATH          JSON fixture file with fireflies.completed payload
  --out DIR               Output directory under --allow-root
  --allow-root DIR        Allowed proof root (default: --out)
  --include-duplicates    Include fireflies.duplicate from the fixture when present
  --json                  Print JSON summary

Watch options:
  --provider fireflies    Provider adapter (default: fireflies)
  --fixture PATH          JSON fixture file with fireflies.completed payload
  --live                  Explicitly enable live Fireflies GraphQL fetch
  --since ISO             Live fetch lower bound (default: now - --since-hours)
  --until ISO             Live fetch upper bound (default: now)
  --since-hours N         Live fetch lookback when --since omitted (default: 24)
  --title-match TEXT      Optional case-insensitive title substring filter
  --transcript-id ID      Fetch one known Fireflies transcript id directly
  --source default        Required canonical source (default: default)
  --limit N               Max payloads to ingest (default: 10)
  --target-profile alex   Hermes profile to wake (default: alex)
  --include-duplicates    Include fireflies.duplicate from the fixture when present
  --json                  Print JSON summary

Wake options:
  --limit N               Max wake rows to claim/plan (default: 3)
  --target-profile alex   Hermes profile to wake (default: alex)
  --dry-run               Do not mark rows claimed; only print plans
  --execute               Spawn Hermes for claimed rows (never used by tests)
  --retry-claimed         Re-claim rows left claimed by an interrupted bridge
  --retry-failed          Re-claim failed rows after operator/runtime repair
  --timeout-ms N          Per-child execution timeout (default: 900000)
  --json                  Print JSON summary

Materialize options:
  --provider fireflies    Provider adapter (default: fireflies)
  --transcript-id ID      Required provider transcript id
  --source default        Required canonical source (default: default)
  --json                  Print JSON summary

Repair options:
  --limit N               Max ledgers to inspect (default: 100)
  --stale-after-ms N      Staleness threshold (default: 6h)
  --json                  Print JSON summary

Live provider fetch is explicit and credential-gated: pass --live and FIREFLIES_API_KEY; fixture mode remains the safe default.
`;

interface ParsedArgs {
  fixture?: string;
  out?: string;
  allowRoot?: string;
  includeDuplicates: boolean;
  json: boolean;
  provider: string;
  source: string;
  limit: number;
  targetProfile: string;
  dryRun: boolean;
  execute: boolean;
  live: boolean;
  since?: string;
  until?: string;
  sinceHours: number;
  titleMatch?: string;
  transcriptId?: string;
  staleAfterMs?: number;
  retryClaimed: boolean;
  retryFailed: boolean;
  timeoutMs: number;
}

interface MeetingIntelligenceCliOpts {
  engine?: BrainEngine;
  env?: Record<string, string | undefined>;
  firefliesGraphql?: FirefliesGraphqlFetch;
}

interface MaterializeMeetingSummary {
  status: 'materialize_complete' | 'materialize_incomplete';
  source_id: 'default';
  provider: string;
  provider_meeting_id: string;
  meeting_slug: string;
  source_slug: string;
  meeting_import_status: string;
  source_import_status: string;
  meeting_chunks: number;
  source_chunks: number;
  meeting_readback_ok: boolean;
  source_readback_ok: boolean;
}

export async function runMeetingIntelligenceCli(
  args: string[],
  io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
  opts: MeetingIntelligenceCliOpts = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => console.log(text));
  const stderr = io.stderr ?? ((text: string) => console.error(text));
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    stdout(HELP);
    return 0;
  }

  if (command === 'paths') {
    stdout(JSON.stringify(resolveMeetingRuntimePaths(), null, 2));
    return 0;
  }

  const parsed = parseArgs(args.slice(1));
  if ('help' in parsed) {
    stdout(HELP);
    return 0;
  }

  if (command === 'dry-run') {
    return runDryRunCommand(parsed, stdout, stderr);
  }
  if (command === 'watch') {
    if (!opts.engine) return missingEngine(stderr, command);
    return runWatchCommand(parsed, opts.engine, stdout, stderr, opts);
  }
  if (command === 'wake') {
    if (!opts.engine) return missingEngine(stderr, command);
    return runWakeCommand(parsed, opts.engine, stdout);
  }
  if (command === 'materialize') {
    if (!opts.engine) return missingEngine(stderr, command);
    return runMaterializeCommand(parsed, opts.engine, stdout, stderr);
  }
  if (command === 'repair') {
    if (!opts.engine) return missingEngine(stderr, command);
    return runRepairCommand(parsed, opts.engine, stdout);
  }

  stderr(`Unknown meeting-intelligence command: ${command}`);
  stderr(HELP);
  return 2;
}

async function runDryRunCommand(
  parsed: ParsedArgs,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  if (!parsed.fixture || !parsed.out) {
    stderr('Usage: gbrain meeting-intelligence dry-run --fixture <path> --out <dir> [--allow-root <dir>]');
    return 2;
  }
  const fixturePath = resolve(parsed.fixture);
  const outputRoot = resolve(parsed.out);
  const allowedRoot = resolve(parsed.allowRoot ?? parsed.out);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  const payloads = await loadFirefliesFixturePayloads(fixture, parsed.includeDuplicates, parsed.limit);
  const result = await runMeetingIntelligenceDryRun({
    provider_payloads: payloads,
    output_root: outputRoot,
    allowed_root: allowedRoot,
  });
  const summary = {
    status: 'dry_run_complete',
    output_root: result.output_root,
    pages_written: result.pages_written,
    audit_files_written: result.audit_files_written,
    receipt_files_written: result.receipt_files_written,
    idempotent_pages: result.idempotent_pages,
    page_count: result.artifacts.audit.page_count,
    duplicate_raw_records: result.artifacts.audit.duplicate_raw_records,
    review_queue_count: result.artifacts.audit.review_queue_count,
    live_provider_calls: result.artifacts.audit.live_provider_calls,
    live_gbrain_writes: result.artifacts.audit.live_gbrain_writes,
    runtime: result.runtime.summary,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence dry-run complete: ${summary.page_count} page(s)`,
    `output_root=${summary.output_root}`,
    `review_queue_count=${summary.review_queue_count}`,
    `live_provider_calls=${summary.live_provider_calls}`,
    `live_gbrain_writes=${summary.live_gbrain_writes}`,
  ]);
  return 0;
}

async function runWatchCommand(
  parsed: ParsedArgs,
  engine: BrainEngine,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  opts: MeetingIntelligenceCliOpts,
): Promise<number> {
  if (parsed.source !== 'default') {
    stderr('meeting-intelligence watch only writes source default');
    return 2;
  }
  if (parsed.provider !== 'fireflies') {
    stderr(`unsupported meeting provider: ${parsed.provider}`);
    return 2;
  }
  if (!parsed.fixture && !parsed.live) {
    stderr('meeting-intelligence watch requires --fixture or explicit --live');
    return 2;
  }
  await ensureMeetingIntelligenceSchema(engine);

  let liveProviderCalls = 0;
  let payloads: unknown[];
  let adapter = createFirefliesProviderAdapter({ mode: 'fixture', fixture_payloads: [] });
  if (parsed.fixture) {
    const fixture = JSON.parse(readFileSync(resolve(parsed.fixture), 'utf8')) as unknown;
    payloads = await loadFirefliesFixturePayloads(fixture, parsed.includeDuplicates, parsed.limit);
    adapter = createFirefliesProviderAdapter({ mode: 'fixture', fixture_payloads: payloads });
  } else {
    const env = opts.env ?? process.env;
    const apiKey = resolveFirefliesApiKey(env);
    adapter = createFirefliesProviderAdapter({
      mode: 'live',
      allow_live_fetch: true,
      api_key: apiKey,
      fetch_graphql: async (request) => {
        liveProviderCalls++;
        if (opts.firefliesGraphql) return opts.firefliesGraphql(request);
        const { performFirefliesGraphqlRequest } = await import('../core/meeting-intelligence/index.ts');
        return performFirefliesGraphqlRequest(request);
      },
    });
    payloads = await adapter.fetchCompletedMeetings!({
      from_date: parsed.since ?? new Date(Date.now() - parsed.sinceHours * 60 * 60 * 1000).toISOString(),
      to_date: parsed.until ?? new Date().toISOString(),
      limit: parsed.limit,
      title_match: parsed.titleMatch,
      provider_meeting_id: parsed.transcriptId,
    });
  }

  const meetings = payloads.map((payload) => adapter.normalize(payload));
  const existingLedgers = await loadMeetingLedgers(engine, { limit: 500 });
  const runtime = buildMeetingRuntimeRun(meetings, { existing_ledgers: existingLedgers });
  const initialPersistence = await persistMeetingRuntimeRun(engine, runtime, meetings, { emit_wake_requests: false });
  const materializations: MaterializeMeetingSummary[] = [];
  for (const receipt of runtime.receipts) {
    if (!receipt.write_plan.write_required) continue;
    materializations.push(await materializeStoredProviderMeeting(engine, receipt.provider, receipt.provider_meeting_id));
  }
  const wakePersistence = await emitMeetingWakeRequests(engine, runtime);
  const persistence = {
    provider_records_upserted: initialPersistence.provider_records_upserted,
    ledgers_upserted: initialPersistence.ledgers_upserted,
    receipts_recorded: initialPersistence.receipts_recorded + wakePersistence.receipts_recorded,
    wake_requests_emitted: wakePersistence.wake_requests_emitted,
    wake_requests_pending: wakePersistence.wake_requests_pending,
  };
  const materializedCount = materializations.filter((item) => item.meeting_readback_ok && item.source_readback_ok).length;
  const liveGbrainWrites = materializations.reduce(
    (sum, item) => sum + (item.meeting_readback_ok ? 1 : 0) + (item.source_readback_ok ? 1 : 0),
    0,
  );
  const summary = {
    status: materializedCount === materializations.length ? 'watch_complete' : 'watch_incomplete',
    provider: parsed.provider,
    source_id: 'default',
    runtime: runtime.summary,
    persistence,
    page_count: runtime.summary.page_count,
    materialized_count: materializedCount,
    materializations,
    wake_requests_emitted: persistence.wake_requests_emitted,
    wake_requests_pending: persistence.wake_requests_pending,
    live_provider_calls: liveProviderCalls,
    live_gbrain_writes: liveGbrainWrites,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence watch complete: ${summary.page_count} meeting(s)`,
    `wake_requests_emitted=${summary.wake_requests_emitted}`,
    `wake_requests_pending=${summary.wake_requests_pending}`,
  ]);
  return 0;
}

function resolveFirefliesApiKey(env: Record<string, string | undefined>): string | undefined {
  return env.FIREFLIES_API_KEY?.trim() || env.Fireflies_API_Key?.trim() || env.FIREFLIES_TOKEN?.trim();
}

async function runWakeCommand(
  parsed: ParsedArgs,
  engine: BrainEngine,
  stdout: (text: string) => void,
): Promise<number> {
  const claimed = await claimMeetingWakeRequests(engine, {
    target_profile: parsed.targetProfile,
    limit: parsed.limit,
    dry_run: parsed.dryRun,
    retry_claimed: parsed.retryClaimed,
    retry_failed: parsed.retryFailed,
  });
  const executions = parsed.execute && !parsed.dryRun
    ? executeWakePlans(claimed, parsed.timeoutMs)
    : [];
  if (executions.length > 0) {
    await recordMeetingWakeExecutionResults(engine, executions);
  }
  const failed = executions.some((result) => !result.ok);
  const summary = {
    status: parsed.dryRun
      ? 'wake_plan'
      : parsed.execute
        ? (failed ? 'wake_failed' : 'wake_executed')
        : 'wake_claimed',
    target_profile: parsed.targetProfile,
    dry_run: parsed.dryRun,
    execute: parsed.execute,
    retry_claimed: parsed.retryClaimed,
    retry_failed: parsed.retryFailed,
    timeout_ms: parsed.timeoutMs,
    claimed_count: claimed.length,
    wake_requests: claimed,
    executions,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence wake ${summary.status}: ${summary.claimed_count} request(s)`,
  ]);
  return failed ? 1 : 0;
}

async function runMaterializeCommand(
  parsed: ParsedArgs,
  engine: BrainEngine,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  if (parsed.source !== 'default') {
    stderr('meeting-intelligence materialize only writes source default');
    return 2;
  }
  if (parsed.provider !== 'fireflies') {
    stderr(`unsupported meeting provider: ${parsed.provider}`);
    return 2;
  }
  if (!parsed.transcriptId) {
    stderr('meeting-intelligence materialize requires --transcript-id <provider id>');
    return 2;
  }
  let summary: MaterializeMeetingSummary;
  try {
    summary = await materializeStoredProviderMeeting(engine, parsed.provider, parsed.transcriptId);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence materialize ${summary.status}: ${summary.meeting_slug}`,
    `source=${summary.source_slug}`,
  ]);
  return summary.meeting_readback_ok && summary.source_readback_ok ? 0 : 1;
}

async function materializeStoredProviderMeeting(
  engine: BrainEngine,
  provider: string,
  transcriptId: string,
): Promise<MaterializeMeetingSummary> {
  await ensureMeetingIntelligenceSchema(engine);
  const rows = await engine.executeRaw<{
    ledger_id: string | number | null;
    normalized_json: unknown;
  }>(
    `SELECT l.id AS ledger_id, p.normalized_json
       FROM meeting_provider_records p
       LEFT JOIN meeting_ledger l
         ON l.source_id = p.source_id
        AND l.provider = p.provider
        AND l.provider_meeting_id = p.provider_meeting_id
      WHERE p.source_id = 'default'
        AND p.provider = $1
        AND p.provider_meeting_id = $2
      LIMIT 1`,
    [provider, transcriptId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`no stored provider record for ${provider}:${redactSensitiveText(transcriptId)}`);
  }
  const meeting = parseStoredJson<NormalizedProviderMeeting>(row.normalized_json);
  const page = renderMeetingPage(meeting);
  const sourceSlug = page.slug.replace(/^meetings\//, `sources/${meeting.provider}/`);
  const sourceMarkdown = renderSourcePacketMarkdown(meeting, page.slug);
  const meetingImport = await importFromContent(engine, page.slug, page.markdown, {
    noEmbed: true,
    sourceId: 'default',
    source_kind: 'meeting-intelligence',
    source_uri: `${meeting.provider}:${meeting.provider_meeting_id}`,
    ingested_via: 'meeting-intelligence:materialize:meeting',
    remote: false,
  });
  const sourceImport = await importFromContent(engine, sourceSlug, sourceMarkdown, {
    noEmbed: true,
    sourceId: 'default',
    source_kind: 'meeting-intelligence',
    source_uri: `${meeting.provider}:${meeting.provider_meeting_id}`,
    ingested_via: 'meeting-intelligence:materialize:source',
    remote: false,
  });
  await reconcileMaterializedMeetingLinks(engine, meeting, page.slug, sourceSlug);
  const meetingReadback = await engine.getPage(page.slug, { sourceId: 'default' });
  const sourceReadback = await engine.getPage(sourceSlug, { sourceId: 'default' });
  await engine.executeRaw(
    `UPDATE meeting_ledger
       SET page_slug = $3, updated_at = now()
     WHERE source_id = 'default' AND provider = $1 AND provider_meeting_id = $2`,
    [meeting.provider, meeting.provider_meeting_id, page.slug],
  );
  await insertMaterializeReceipt(engine, row.ledger_id, meeting, 'page_written', {
    meeting_slug: page.slug,
    source_slug: sourceSlug,
    meeting_import_status: meetingImport.status,
    source_import_status: sourceImport.status,
    meeting_chunks: meetingImport.chunks,
    source_chunks: sourceImport.chunks,
  });
  if (meetingReadback && sourceReadback) {
    await insertMaterializeReceipt(engine, row.ledger_id, meeting, 'readback_ok', {
      meeting_slug: page.slug,
      source_slug: sourceSlug,
    });
  }
  return {
    status: meetingReadback && sourceReadback ? 'materialize_complete' : 'materialize_incomplete',
    source_id: 'default',
    provider: meeting.provider,
    provider_meeting_id: redactSensitiveText(meeting.provider_meeting_id),
    meeting_slug: page.slug,
    source_slug: sourceSlug,
    meeting_import_status: meetingImport.status,
    source_import_status: sourceImport.status,
    meeting_chunks: meetingImport.chunks,
    source_chunks: sourceImport.chunks,
    meeting_readback_ok: Boolean(meetingReadback),
    source_readback_ok: Boolean(sourceReadback),
  };
}

async function reconcileMaterializedMeetingLinks(
  engine: BrainEngine,
  meeting: NormalizedProviderMeeting,
  meetingSlug: string,
  sourceSlug: string,
): Promise<void> {
  const sourceOpts = { fromSourceId: 'default', toSourceId: 'default' };
  await engine.addLink(meetingSlug, sourceSlug, 'meeting-intelligence materialized source packet', 'source', 'manual', undefined, undefined, sourceOpts); // gbrain-allow-direct-insert: materialize writes the canonical meeting/source pages, then reconciles deterministic same-source graph edges.
  await engine.addLink(sourceSlug, meetingSlug, 'meeting-intelligence materialized meeting page', 'source', 'manual', undefined, undefined, sourceOpts); // gbrain-allow-direct-insert: materialize writes the canonical meeting/source pages, then reconciles deterministic same-source graph edges.

  for (const personSlug of materializedMeetingPersonSlugs(meeting)) {
    try {
      await engine.addLink(meetingSlug, personSlug, 'meeting-intelligence materialized attendee/speaker', 'attended', 'manual', undefined, undefined, sourceOpts); // gbrain-allow-direct-insert: attendee/speaker edge is derived from materialized transcript metadata; unresolved people are skipped below.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/not found/i.test(message)) throw err;
    }
  }
}

function materializedMeetingPersonSlugs(meeting: NormalizedProviderMeeting): string[] {
  const labels = new Set<string>();
  const push = (label: unknown) => {
    if (typeof label !== 'string') return;
    const trimmed = redactSensitiveText(label.trim());
    if (!trimmed || trimmed.includes('@') || trimmed.startsWith('<REDACTED:')) return;
    if (/^unknown[-_\s]?speaker$/i.test(trimmed)) return;
    const slug = slugifySegment(trimmed);
    if (slug) labels.add(`people/${slug}`);
  };

  push(meeting.organizer?.name);
  for (const attendee of meeting.attendees) push(attendee.name);
  for (const turn of meeting.transcript) push(turn.speaker);
  return [...labels].sort();
}

function renderSourcePacketMarkdown(meeting: NormalizedProviderMeeting, meetingSlug: string): string {
  const compiledTruth = [
    `# Fireflies Source Packet: ${redactSensitiveText(meeting.title)}`,
    '',
    '## Source Packet',
    `- Provider adapter: ${meeting.provider}`,
    '- Canonical owner: GBrain meeting intelligence',
    '- GBrain source intent: default',
    `- Provider meeting id: ${redactSensitiveText(meeting.provider_meeting_id)}`,
    `- Meeting page: [[${meetingSlug}]]`,
    `- Transcript checksum: ${meeting.transcript_checksum}`,
    `- Source checksum: ${meeting.source_checksum}`,
    `- Started at: ${meeting.started_at}`,
    '',
    '## Promotion Boundary',
    '- This packet identifies the provider source and readback target.',
    '- Full diarized transcript is stored on the linked meeting page, not duplicated here.',
    '- Generated Fireflies summaries/action items remain low-trust hints until transcript or human notes support promotion.',
  ].join('\n');
  return serializeMarkdown(
    {
      provider: meeting.provider,
      provider_meeting_id: redactSensitiveText(meeting.provider_meeting_id),
      provider_canonical_id: `${meeting.provider}:${redactSensitiveText(meeting.provider_meeting_id)}`,
      gbrain_source_id: 'default',
      meeting_page: meetingSlug,
      meeting_date: meeting.meeting_date,
      started_at: meeting.started_at,
      transcript_checksum: meeting.transcript_checksum,
      source_checksum: meeting.source_checksum,
      source_system: 'meeting-intelligence',
    },
    compiledTruth,
    '',
    {
      type: 'source',
      title: `Fireflies Source Packet: ${redactSensitiveText(meeting.title)}`,
      tags: ['source', 'fireflies', 'meeting-intelligence', 'meeting-source'],
    },
  );
}

async function insertMaterializeReceipt(
  engine: BrainEngine,
  ledgerId: string | number | null,
  meeting: NormalizedProviderMeeting,
  kind: 'page_written' | 'readback_ok',
  payload: Record<string, unknown>,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO meeting_receipts
      (source_id, ledger_id, provider, provider_meeting_id, receipt_key, kind, receipt_json)
     VALUES ('default', $1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (source_id, receipt_key) DO NOTHING`,
    [
      ledgerId,
      meeting.provider,
      meeting.provider_meeting_id,
      `${kind}:${meeting.provider}:${meeting.provider_meeting_id}`,
      kind,
      JSON.stringify({ ...payload, source_id: 'default', provider: meeting.provider, provider_meeting_id: redactSensitiveText(meeting.provider_meeting_id) }),
    ],
  );
}

function parseStoredJson<T>(value: unknown): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value as T;
}

async function runRepairCommand(
  parsed: ParsedArgs,
  engine: BrainEngine,
  stdout: (text: string) => void,
): Promise<number> {
  const ledgers = await loadMeetingLedgers(engine, { limit: parsed.limit });
  const plan = buildMeetingRepairSweepPlan(ledgers, {
    stale_after_ms: parsed.staleAfterMs,
  });
  const summary = {
    status: 'repair_plan',
    candidates: plan.candidates,
    poller: plan.poller,
  };
  printSummary(summary, parsed.json, stdout, [
    `meeting-intelligence repair plan: ${plan.candidates.length} candidate(s)`,
  ]);
  return 0;
}

function parseArgs(args: string[]): ParsedArgs | { help: true } {
  const parsed: ParsedArgs = {
    includeDuplicates: false,
    json: false,
    provider: 'fireflies',
    source: 'default',
    limit: 10,
    targetProfile: 'alex',
    dryRun: false,
    execute: false,
    live: false,
    sinceHours: 24,
    retryClaimed: false,
    retryFailed: false,
    timeoutMs: 900_000,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--include-duplicates') { parsed.includeDuplicates = true; continue; }
    if (arg === '--dry-run') { parsed.dryRun = true; continue; }
    if (arg === '--execute') { parsed.execute = true; continue; }
    if (arg === '--retry-claimed') { parsed.retryClaimed = true; continue; }
    if (arg === '--retry-failed') { parsed.retryFailed = true; continue; }
    if (arg === '--live') { parsed.live = true; continue; }
    if (arg === '--fixture') { parsed.fixture = args[++i]; continue; }
    if (arg === '--out') { parsed.out = args[++i]; continue; }
    if (arg === '--allow-root') { parsed.allowRoot = args[++i]; continue; }
    if (arg === '--provider') { parsed.provider = args[++i] ?? parsed.provider; continue; }
    if (arg === '--source') { parsed.source = args[++i] ?? parsed.source; continue; }
    if (arg === '--target-profile') { parsed.targetProfile = args[++i] ?? parsed.targetProfile; continue; }
    if (arg === '--limit') { parsed.limit = positiveInt(args[++i], '--limit'); continue; }
    if (arg === '--since-hours') { parsed.sinceHours = positiveInt(args[++i], '--since-hours'); continue; }
    if (arg === '--since') { parsed.since = requireValue(args[++i], '--since'); continue; }
    if (arg === '--until') { parsed.until = requireValue(args[++i], '--until'); continue; }
    if (arg === '--title-match') { parsed.titleMatch = requireValue(args[++i], '--title-match'); continue; }
    if (arg === '--transcript-id') { parsed.transcriptId = requireValue(args[++i], '--transcript-id'); continue; }
    if (arg === '--stale-after-ms') { parsed.staleAfterMs = positiveInt(args[++i], '--stale-after-ms'); continue; }
    if (arg === '--timeout-ms') { parsed.timeoutMs = positiveInt(args[++i], '--timeout-ms'); continue; }
  }
  return parsed;
}

async function loadFirefliesFixturePayloads(
  fixture: unknown,
  includeDuplicates: boolean,
  limit = 10,
): Promise<unknown[]> {
  const root = fixture && typeof fixture === 'object' && !Array.isArray(fixture)
    ? fixture as Record<string, unknown>
    : {};
  const fireflies = root.fireflies && typeof root.fireflies === 'object' && !Array.isArray(root.fireflies)
    ? root.fireflies as Record<string, unknown>
    : {};
  const payloads = [fireflies.completed, includeDuplicates ? fireflies.duplicate : undefined]
    .filter((payload): payload is unknown => payload !== undefined)
    .slice(0, limit);
  if (payloads.length === 0) {
    throw new Error('fixture must contain fireflies.completed');
  }
  const adapter = createFirefliesProviderAdapter({
    mode: 'fixture',
    fixture_payloads: payloads,
  });
  const completed = await adapter.fetchCompletedMeeting({
    provider_meeting_id: providerMeetingId(payloads[0]!),
  });
  const result = [completed];
  if (includeDuplicates && payloads[1]) {
    result.push(await adapter.fetchCompletedMeeting({
      provider_meeting_id: providerMeetingId(payloads[1]),
    }));
  }
  return result;
}

function providerMeetingId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Fireflies fixture payload must be an object');
  }
  const raw = payload as Record<string, unknown>;
  const id = raw.id ?? raw.transcript_id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Fireflies fixture payload requires id or transcript_id');
  }
  return id;
}

function missingEngine(stderr: (text: string) => void, command: string): number {
  stderr(`meeting-intelligence ${command} requires a connected BrainEngine`);
  return 2;
}

function positiveInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} requires a positive integer`);
  }
  return parsed;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value || value.trim().length === 0) throw new Error(`${label} requires a value`);
  return value.trim();
}

function printSummary(summary: unknown, json: boolean, stdout: (text: string) => void, lines: string[]): void {
  if (json) stdout(JSON.stringify(summary, null, 2));
  else stdout(lines.join('\n'));
}

function executeWakePlans(
  requests: readonly ClaimedMeetingWakeRequest[],
  timeoutMs: number,
): MeetingWakeExecutionResult[] {
  // Imported lazily so dry-run/test paths do not acquire subprocess state.
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  return requests.map((request) => {
    const plan = normalizeWakeCommandPlan(request.command_plan, request.target_profile);
    const [command, ...args] = plan.argv;
    if (!command) {
      return {
        wake_request_id: request.id,
        ok: false,
        status: null,
        signal: null,
        error_text: 'wake command plan missing argv[0]',
      };
    }
    const result = spawnSync(command, args, {
      env: { ...process.env, ...plan.env },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: 'pipe',
      timeout: timeoutMs,
    });
    const timedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
    const ok = result.status === 0 && !result.signal && !result.error;
    const statusText = result.status === null ? 'no exit status' : `exited with status ${result.status}`;
    const signalText = result.signal ? `signal ${result.signal}` : undefined;
    const errorText = ok
      ? undefined
      : [
        timedOut ? `timed out after ${timeoutMs}ms` : undefined,
        result.error?.message,
        statusText,
        signalText,
      ].filter(Boolean).join('; ');
    return {
      wake_request_id: request.id,
      ok,
      status: result.status,
      signal: result.signal,
      timed_out: timedOut || undefined,
      error_text: errorText,
    };
  });
}

export function normalizeWakeCommandPlan(
  plan: { env: Record<string, string>; argv: string[] },
  targetProfile: string,
): { env: Record<string, string>; argv: string[] } {
  const env = { ...plan.env, HERMES_PROFILE: plan.env.HERMES_PROFILE ?? targetProfile };
  const promptText = findArgValue(plan.argv, '--query') ?? findArgValue(plan.argv, '-q');
  const deterministic = typeof promptText === 'string'
    ? materializeArgvFromWakePrompt(promptText)
    : null;
  if (deterministic) return { env, argv: deterministic };

  const [command, firstArg, ...rest] = plan.argv;
  if (command === 'hermes' && firstArg === 'chat') {
    return {
      env: { ...env, HERMES_PROFILE: targetProfile },
      argv: [command, '--profile', targetProfile, firstArg, ...rest],
    };
  }
  return { env, argv: plan.argv };
}

function findArgValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function materializeArgvFromWakePrompt(promptText: string): string[] | null {
  const explicit = promptText.match(
    /(?:^|\n)Materialize command:\s*(gbrain\s+meeting-intelligence\s+materialize\s+--provider\s+\S+\s+--transcript-id\s+\S+\s+--source\s+default\s+--json)(?:\n|$)/,
  );
  if (explicit?.[1]) return explicit[1].trim().split(/\s+/);

  const provider = promptText.match(/(?:^|\n)Provider:\s*([^\n\s]+)/)?.[1]?.trim();
  const transcriptId = promptText.match(/(?:^|\n)Provider meeting id:\s*([^\n\s]+)/)?.[1]?.trim();
  if (!provider || !transcriptId) return null;
  return [
    'gbrain',
    'meeting-intelligence',
    'materialize',
    '--provider',
    provider,
    '--transcript-id',
    transcriptId,
    '--source',
    'default',
    '--json',
  ];
}
