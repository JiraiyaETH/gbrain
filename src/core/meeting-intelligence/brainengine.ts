import type { BrainEngine } from '../engine.ts';
import type {
  AlexWakeRequestPlan,
  MeetingLedger,
  MeetingRuntimeRun,
  MeetingRuntimeReceipt,
  NormalizedProviderMeeting,
} from './index.ts';

export const MEETING_INTELLIGENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meeting_provider_records (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  provider TEXT NOT NULL,
  provider_meeting_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  meeting_date DATE NOT NULL,
  transcript_checksum TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('received','completed','duplicate','error')),
  normalized_json JSONB NOT NULL,
  provider_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, provider, provider_meeting_id)
);
CREATE INDEX IF NOT EXISTS meeting_provider_records_dedupe_idx
  ON meeting_provider_records (source_id, provider, dedupe_key);
CREATE INDEX IF NOT EXISTS meeting_provider_records_started_idx
  ON meeting_provider_records (source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS meeting_ledger (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  provider TEXT NOT NULL,
  provider_meeting_id TEXT NOT NULL,
  page_slug TEXT,
  transcript_checksum TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received','transcript_ready','page_rendered','enrichment_pending','alex_requested','alex_running','alex_failed','enriched','review_queued','skipped','error')),
  history_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, provider, provider_meeting_id)
);
CREATE INDEX IF NOT EXISTS meeting_ledger_state_idx
  ON meeting_ledger (source_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS meeting_ledger_page_slug_idx
  ON meeting_ledger (source_id, page_slug);

CREATE TABLE IF NOT EXISTS meeting_receipts (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  ledger_id BIGINT REFERENCES meeting_ledger(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_meeting_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('watcher_seen','alex_requested','alex_started','page_written','readback_ok','enrichment_done','review_queued','alex_failed','fallback_staged','error')),
  receipt_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, receipt_key)
);
CREATE INDEX IF NOT EXISTS meeting_receipts_ledger_idx
  ON meeting_receipts (ledger_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_wake_requests (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  ledger_id BIGINT REFERENCES meeting_ledger(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_meeting_id TEXT NOT NULL,
  wake_key TEXT NOT NULL,
  target_profile TEXT NOT NULL DEFAULT 'alex',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed','cancelled')),
  prompt_text TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, wake_key)
);
CREATE INDEX IF NOT EXISTS meeting_wake_requests_pending_idx
  ON meeting_wake_requests (source_id, target_profile, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS meeting_wake_requests_ledger_idx
  ON meeting_wake_requests (ledger_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_provider_cursors (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  provider TEXT NOT NULL,
  cursor_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, provider)
);
`;

export interface MeetingPersistenceSummary {
  provider_records_upserted: number;
  ledgers_upserted: number;
  receipts_recorded: number;
  wake_requests_emitted: number;
  wake_requests_pending: number;
}

export interface ClaimedMeetingWakeRequest {
  id: string;
  wake_key: string;
  source_id: 'default';
  ledger_id: string | null;
  provider: string;
  provider_meeting_id: string;
  target_profile: string;
  status: 'claimed';
  prompt_text: string;
  payload: AlexWakeRequestPlan;
  command_plan: AlexWakeRequestPlan['command_plan'];
}

export interface MeetingWakeExecutionResult {
  wake_request_id: string;
  ok: boolean;
  status: number | null;
  signal: string | null;
  timed_out?: boolean;
  error_text?: string;
}

export async function ensureMeetingIntelligenceSchema(engine: BrainEngine): Promise<void> {
  for (const statement of splitSqlStatements(MEETING_INTELLIGENCE_SCHEMA_SQL)) {
    await engine.executeRaw(statement);
  }
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export async function persistMeetingRuntimeRun(
  engine: BrainEngine,
  runtime: MeetingRuntimeRun,
  meetings: readonly NormalizedProviderMeeting[],
  opts: { emit_wake_requests?: boolean } = {},
): Promise<MeetingPersistenceSummary> {
  await ensureMeetingIntelligenceSchema(engine);
  let providerRecords = 0;
  for (const meeting of meetings) {
    await upsertProviderRecord(engine, meeting);
    providerRecords++;
  }

  let ledgers = 0;
  let receipts = 0;
  let wakes = 0;
  for (const receipt of runtime.receipts) {
    const ledger = receipt.ledger;
    const ledgerId = await upsertLedger(engine, ledger);
    ledgers++;
    receipts += await insertReceipt(engine, receipt, ledgerId, 'watcher_seen');
    if (opts.emit_wake_requests !== false && receipt.write_plan.write_required) {
      receipts += await insertReceipt(engine, receipt, ledgerId, 'alex_requested');
      wakes += await upsertWakeRequest(engine, receipt.alex_wake, ledgerId);
    }
  }

  const pendingRows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*)::text AS count FROM meeting_wake_requests WHERE source_id = 'default' AND status = 'pending'`,
  );
  return {
    provider_records_upserted: providerRecords,
    ledgers_upserted: ledgers,
    receipts_recorded: receipts,
    wake_requests_emitted: wakes,
    wake_requests_pending: Number(pendingRows[0]?.count ?? 0),
  };
}

export async function emitMeetingWakeRequests(
  engine: BrainEngine,
  runtime: MeetingRuntimeRun,
): Promise<Pick<MeetingPersistenceSummary, 'receipts_recorded' | 'wake_requests_emitted' | 'wake_requests_pending'>> {
  await ensureMeetingIntelligenceSchema(engine);
  let receipts = 0;
  let wakes = 0;
  for (const receipt of runtime.receipts) {
    if (!receipt.write_plan.write_required) continue;
    const ledgerRows = await engine.executeRaw<{ id: string | number }>(
      `SELECT id FROM meeting_ledger
        WHERE source_id = 'default' AND provider = $1 AND provider_meeting_id = $2
        LIMIT 1`,
      [receipt.ledger.provider, receipt.ledger.provider_meeting_id],
    );
    const ledgerId = ledgerRows[0]?.id;
    if (ledgerId == null) continue;
    receipts += await insertReceipt(engine, receipt, String(ledgerId), 'alex_requested');
    wakes += await upsertWakeRequest(engine, receipt.alex_wake, String(ledgerId));
  }
  const pendingRows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*)::text AS count FROM meeting_wake_requests WHERE source_id = 'default' AND status = 'pending'`,
  );
  return {
    receipts_recorded: receipts,
    wake_requests_emitted: wakes,
    wake_requests_pending: Number(pendingRows[0]?.count ?? 0),
  };
}

export async function loadMeetingLedgers(
  engine: BrainEngine,
  opts: { source_id?: 'default'; states?: string[]; limit?: number } = {},
): Promise<MeetingLedger[]> {
  await ensureMeetingIntelligenceSchema(engine);
  const sourceId = opts.source_id ?? 'default';
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const states = opts.states ?? [];
  const rows = states.length > 0
    ? await engine.executeRaw<MeetingLedgerRow>(
      `SELECT * FROM meeting_ledger WHERE source_id = $1 AND state = ANY($2::text[]) ORDER BY updated_at DESC LIMIT $3`,
      [sourceId, states, limit],
    )
    : await engine.executeRaw<MeetingLedgerRow>(
      `SELECT * FROM meeting_ledger WHERE source_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [sourceId, limit],
    );
  return rows.map(rowToLedger);
}

export async function claimMeetingWakeRequests(
  engine: BrainEngine,
  opts: { target_profile?: string; limit?: number; dry_run?: boolean; retry_claimed?: boolean; retry_failed?: boolean } = {},
): Promise<ClaimedMeetingWakeRequest[]> {
  await ensureMeetingIntelligenceSchema(engine);
  const targetProfile = opts.target_profile ?? 'alex';
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 20));
  const statuses = ['pending'];
  if (opts.retry_claimed) statuses.push('claimed');
  if (opts.retry_failed) statuses.push('failed');
  const rows = await engine.executeRaw<WakeRow>(
    `SELECT * FROM meeting_wake_requests
      WHERE source_id = 'default' AND target_profile = $1 AND status = ANY($2::text[])
      ORDER BY created_at ASC
      LIMIT $3`,
    [targetProfile, statuses, limit],
  );
  const claimed: ClaimedMeetingWakeRequest[] = [];
  for (const row of rows) {
    if (!opts.dry_run) {
      await engine.executeRaw(
        `UPDATE meeting_wake_requests
           SET status = 'claimed', attempts = attempts + 1, claimed_at = now(), updated_at = now(), error_text = NULL
         WHERE id = $1 AND status = ANY($2::text[])`,
        [row.id, statuses],
      );
      await engine.executeRaw(
        `UPDATE meeting_ledger
           SET state = 'alex_running', updated_at = now(),
               history_json = history_json || $1::jsonb
         WHERE id = $2 AND state IN ('alex_requested', 'alex_failed', 'alex_running')`,
        [JSON.stringify([{ from: row.status === 'failed' ? 'alex_failed' : 'alex_requested', to: 'alex_running', reason: 'wake_claimed_by_hermes_bridge', at: new Date().toISOString() }]), row.ledger_id],
      );
    }
    const payload = parseJson<AlexWakeRequestPlan>(row.payload_json);
    claimed.push({
      id: String(row.id),
      wake_key: row.wake_key,
      source_id: 'default',
      ledger_id: row.ledger_id == null ? null : String(row.ledger_id),
      provider: row.provider,
      provider_meeting_id: row.provider_meeting_id,
      target_profile: row.target_profile,
      status: 'claimed',
      prompt_text: row.prompt_text,
      payload,
      command_plan: payload.command_plan,
    });
  }
  return claimed;
}

export async function recordMeetingWakeExecutionResults(
  engine: BrainEngine,
  results: readonly MeetingWakeExecutionResult[],
): Promise<void> {
  await ensureMeetingIntelligenceSchema(engine);
  for (const result of results) {
    const nextStatus = result.ok ? 'done' : 'failed';
    const errorText = result.ok ? null : (result.error_text ?? (result.timed_out ? 'wake execution timed out' : 'wake execution failed'));
    await engine.executeRaw(
      `UPDATE meeting_wake_requests
         SET status = $2, completed_at = CASE WHEN $2 = 'done' THEN now() ELSE completed_at END,
             error_text = $3, updated_at = now()
       WHERE id = $1 AND status = 'claimed'`,
      [result.wake_request_id, nextStatus, errorText],
    );
    if (result.ok) {
      await engine.executeRaw(
        `UPDATE meeting_ledger
           SET state = 'enriched', updated_at = now(),
               history_json = history_json || $1::jsonb
         WHERE id = (
           SELECT ledger_id FROM meeting_wake_requests WHERE id = $2
         ) AND state = 'alex_running'`,
        [JSON.stringify([{ from: 'alex_running', to: 'enriched', reason: 'wake_execution_completed', at: new Date().toISOString() }]), result.wake_request_id],
      );
      await engine.executeRaw(
        `INSERT INTO meeting_receipts
          (source_id, ledger_id, provider, provider_meeting_id, receipt_key, kind, receipt_json)
         SELECT source_id, ledger_id, provider, provider_meeting_id, $2, 'enrichment_done', $3::jsonb
           FROM meeting_wake_requests
          WHERE id = $1
         ON CONFLICT (source_id, receipt_key) DO NOTHING`,
        [result.wake_request_id, `enrichment_done:wake:${result.wake_request_id}`, JSON.stringify({ wake_request_id: result.wake_request_id, status: result.status, signal: result.signal })],
      );
      continue;
    }
    await engine.executeRaw(
      `UPDATE meeting_ledger
         SET state = 'alex_failed', updated_at = now(),
             history_json = history_json || $1::jsonb
       WHERE id = (
         SELECT ledger_id FROM meeting_wake_requests WHERE id = $2
       ) AND state = 'alex_running'`,
      [JSON.stringify([{ from: 'alex_running', to: 'alex_failed', reason: errorText, at: new Date().toISOString() }]), result.wake_request_id],
    );
    await engine.executeRaw(
      `INSERT INTO meeting_receipts
        (source_id, ledger_id, provider, provider_meeting_id, receipt_key, kind, receipt_json)
       SELECT source_id, ledger_id, provider, provider_meeting_id, $2, 'alex_failed', $3::jsonb
         FROM meeting_wake_requests
        WHERE id = $1
       ON CONFLICT (source_id, receipt_key) DO NOTHING`,
      [result.wake_request_id, `alex_failed:wake:${result.wake_request_id}`, JSON.stringify({ wake_request_id: result.wake_request_id, error_text: errorText, status: result.status, signal: result.signal, timed_out: result.timed_out === true })],
    );
  }
}

async function upsertProviderRecord(engine: BrainEngine, meeting: NormalizedProviderMeeting): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO meeting_provider_records
      (source_id, provider, provider_meeting_id, dedupe_key, title, started_at, meeting_date,
       transcript_checksum, source_checksum, status, normalized_json, provider_payload_json)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9::jsonb, $10::jsonb)
     ON CONFLICT (source_id, provider, provider_meeting_id) DO UPDATE SET
       dedupe_key = EXCLUDED.dedupe_key,
       title = EXCLUDED.title,
       started_at = EXCLUDED.started_at,
       meeting_date = EXCLUDED.meeting_date,
       transcript_checksum = EXCLUDED.transcript_checksum,
       source_checksum = EXCLUDED.source_checksum,
       status = EXCLUDED.status,
       normalized_json = EXCLUDED.normalized_json,
       provider_payload_json = EXCLUDED.provider_payload_json,
       last_seen_at = now()`,
    [
      meeting.provider,
      meeting.provider_meeting_id,
      meeting.dedupe_key,
      meeting.title,
      meeting.started_at,
      meeting.meeting_date,
      meeting.transcript_checksum,
      meeting.source_checksum,
      JSON.stringify(meeting),
      JSON.stringify(meeting),
    ],
  );
}

async function upsertLedger(engine: BrainEngine, ledger: MeetingLedger): Promise<string> {
  const rows = await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO meeting_ledger
      (source_id, provider, provider_meeting_id, page_slug, transcript_checksum, source_checksum, state, history_json)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (source_id, provider, provider_meeting_id) DO UPDATE SET
       page_slug = EXCLUDED.page_slug,
       transcript_checksum = EXCLUDED.transcript_checksum,
       source_checksum = EXCLUDED.source_checksum,
       state = EXCLUDED.state,
       history_json = EXCLUDED.history_json,
       updated_at = now()
     RETURNING id`,
    [
      ledger.provider,
      ledger.provider_meeting_id,
      ledger.page_slug ?? null,
      ledger.transcript_checksum,
      ledger.source_checksum,
      ledger.state,
      JSON.stringify(ledger.history),
    ],
  );
  return String(rows[0]?.id);
}

async function insertReceipt(
  engine: BrainEngine,
  receipt: MeetingRuntimeReceipt,
  ledgerId: string,
  kind: 'watcher_seen' | 'alex_requested',
): Promise<number> {
  const receiptKey = `${kind}:${receipt.receipt_id}`;
  const rows = await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO meeting_receipts
      (source_id, ledger_id, provider, provider_meeting_id, receipt_key, kind, receipt_json)
     VALUES ('default', $1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (source_id, receipt_key) DO NOTHING
     RETURNING id`,
    [ledgerId, receipt.ledger.provider, receipt.ledger.provider_meeting_id, receiptKey, kind, JSON.stringify(receipt)],
  );
  return rows.length;
}

async function upsertWakeRequest(
  engine: BrainEngine,
  wake: AlexWakeRequestPlan,
  ledgerId: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ inserted: string | number | boolean }>(
    `INSERT INTO meeting_wake_requests
      (source_id, ledger_id, provider, provider_meeting_id, wake_key, target_profile, status, prompt_text, payload_json)
     VALUES ('default', $1, $2, $3, $4, $5, 'pending', $6, $7::jsonb)
     ON CONFLICT (source_id, wake_key) DO UPDATE SET
       target_profile = EXCLUDED.target_profile,
       prompt_text = EXCLUDED.prompt_text,
       payload_json = EXCLUDED.payload_json,
       updated_at = now(),
       error_text = NULL
     WHERE meeting_wake_requests.status IN ('pending','claimed','failed')
     RETURNING (xmax = 0) AS inserted`,
    [ledgerId, wake.provider, wake.provider_meeting_id, wake.wake_key, wake.target_profile, wake.prompt_text, JSON.stringify(wake)],
  );
  const inserted = rows[0]?.inserted;
  return inserted === true || inserted === 'true' || inserted === 1 || inserted === '1' ? 1 : 0;
}

interface MeetingLedgerRow {
  provider: string;
  provider_meeting_id: string;
  transcript_checksum: string;
  source_checksum: string;
  page_slug?: string | null;
  state: MeetingLedger['state'];
  history_json: unknown;
}

interface WakeRow {
  id: string | number;
  ledger_id: string | number | null;
  wake_key: string;
  provider: string;
  provider_meeting_id: string;
  target_profile: string;
  status: string;
  prompt_text: string;
  payload_json: unknown;
}

function rowToLedger(row: MeetingLedgerRow): MeetingLedger {
  return {
    provider: row.provider,
    provider_meeting_id: row.provider_meeting_id,
    transcript_checksum: row.transcript_checksum,
    source_checksum: row.source_checksum,
    page_slug: row.page_slug ?? undefined,
    state: row.state,
    history: parseJson<MeetingLedger['history']>(row.history_json),
  };
}

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}
