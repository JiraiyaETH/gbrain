import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';

export const CALENDAR_PROJECTION_MANAGER = 'gbrain-runtime/calendar-projection';
export const CALENDAR_RUNTIME_AUTHORITY = 'gbrain_brainengine';
export const CALENDAR_COLLECTOR = 'macos-calendar-eventkit';
export const CALENDAR_SOURCE_ID = 'default' as const;
export const CALENDAR_SOURCE_PREFIX = 'sources/calendar';

export const CALENDAR_PROJECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS calendar_provider_records (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  calendar_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  event_date DATE NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  recurring BOOLEAN NOT NULL DEFAULT false,
  content_checksum TEXT NOT NULL,
  normalized_json JSONB NOT NULL,
  provider_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, provider, occurrence_key)
);
CREATE INDEX IF NOT EXISTS calendar_provider_records_date_idx
  ON calendar_provider_records (source_id, event_date, start_at);
CREATE INDEX IF NOT EXISTS calendar_provider_records_event_idx
  ON calendar_provider_records (source_id, provider, provider_event_id);

CREATE TABLE IF NOT EXISTS calendar_day_ledger (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  provider TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  page_slug TEXT NOT NULL,
  event_date DATE NOT NULL,
  content_checksum TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received','page_rendered','page_written','skipped','error')),
  history_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, provider, occurrence_key)
);
CREATE INDEX IF NOT EXISTS calendar_day_ledger_state_idx
  ON calendar_day_ledger (source_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS calendar_day_ledger_page_slug_idx
  ON calendar_day_ledger (source_id, page_slug);

CREATE TABLE IF NOT EXISTS calendar_projection_receipts (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  ledger_id BIGINT REFERENCES calendar_day_ledger(id) ON DELETE CASCADE,
  receipt_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot_seen','page_rendered','page_written','readback_ok','dry_run','error')),
  page_slug TEXT NOT NULL,
  receipt_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, receipt_key)
);
CREATE INDEX IF NOT EXISTS calendar_projection_receipts_page_idx
  ON calendar_projection_receipts (source_id, page_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS calendar_provider_cursors (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE DEFAULT 'default',
  provider TEXT NOT NULL,
  cursor_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, provider)
);
`;

export interface CalendarSnapshot {
  synced_at?: string;
  days_back?: number;
  days_ahead?: number;
  source?: string;
  source_method?: string;
  freshness_window_minutes?: number;
  calendar_count?: number;
  event_count?: number;
  events: CalendarSnapshotEvent[];
}

export interface CalendarSnapshotEvent {
  calendar?: unknown;
  summary?: unknown;
  title?: unknown;
  start?: unknown;
  end?: unknown;
  all_day?: unknown;
  location?: unknown;
  notes?: unknown;
  uid?: unknown;
  id?: unknown;
  recurring?: unknown;
  start_iso?: unknown;
  end_iso?: unknown;
}

export interface NormalizedCalendarSnapshot {
  source_id: 'default';
  provider: 'macos-calendar';
  source_method: 'eventkit';
  collector: typeof CALENDAR_COLLECTOR;
  synced_at: string | null;
  days_back: number | null;
  days_ahead: number | null;
  source_checksum: string;
  events: NormalizedCalendarEvent[];
}

export interface NormalizedCalendarEvent {
  provider: 'macos-calendar';
  provider_event_id: string;
  occurrence_key: string;
  calendar_name: string;
  summary: string;
  start_iso: string;
  end_iso: string | null;
  event_date: string;
  all_day: boolean;
  location: string | null;
  recurring: boolean;
  content_checksum: string;
}

export interface RenderedCalendarPage {
  slug: string;
  markdown: string;
  content_checksum: string;
  event_count: number;
  event_date?: string;
}

export interface CalendarProjectionRun {
  snapshot: NormalizedCalendarSnapshot;
  pages: RenderedCalendarPage[];
  day_pages: RenderedCalendarPage[];
  summary: CalendarProjectionSummary;
}

export interface CalendarProjectionSummary {
  status?: string;
  source_id: 'default';
  runtime_authority: typeof CALENDAR_RUNTIME_AUTHORITY;
  source_runtime: typeof CALENDAR_COLLECTOR;
  collector: typeof CALENDAR_COLLECTOR;
  provider: 'macos-calendar';
  page_count: number;
  event_count: number;
  day_count: number;
  pages_written: number;
  provider_records_upserted: number;
  ledgers_upserted: number;
  receipts_recorded: number;
  live_provider_calls: 0;
  live_gbrain_writes: number;
  output_root?: string;
}

export interface CalendarProjectionSyncOpts {
  sourceId?: string;
  snapshot: unknown;
  now?: string;
  dryRun?: boolean;
  outputRoot?: string;
  allowedRoot?: string;
}

export interface CalendarProjectionSyncResult {
  status: 'synced' | 'dry_run';
  summary: CalendarProjectionSummary;
  pages: RenderedCalendarPage[];
  files: string[];
}

interface SourceRootRow {
  local_path: string | null;
  archived: boolean;
}

interface CalendarPersistenceSummary {
  provider_records_upserted: number;
  ledgers_upserted: number;
  receipts_recorded: number;
}

interface PageWriteResult {
  files: string[];
  pagesWritten: number;
  wroteBySlug: Map<string, boolean>;
}

export async function ensureCalendarProjectionSchema(engine: BrainEngine): Promise<void> {
  for (const statement of splitSqlStatements(CALENDAR_PROJECTION_SCHEMA_SQL)) {
    await engine.executeRaw(statement);
  }
}

export function normalizeCalendarSnapshot(input: unknown): NormalizedCalendarSnapshot {
  const record = asRecord(input, 'calendar snapshot');
  const rawEvents = Array.isArray(record.events) ? record.events : [];
  const events = rawEvents
    .map((event, index) => normalizeCalendarEvent(event, index))
    .sort(compareCalendarEvents);
  const checksumPayload = events.map((event) => ({
    occurrence_key: event.occurrence_key,
    content_checksum: event.content_checksum,
  }));
  return {
    source_id: CALENDAR_SOURCE_ID,
    provider: 'macos-calendar',
    source_method: 'eventkit',
    collector: CALENDAR_COLLECTOR,
    synced_at: optionalString(record.synced_at),
    days_back: optionalNumber(record.days_back),
    days_ahead: optionalNumber(record.days_ahead),
    source_checksum: sha256(JSON.stringify(checksumPayload)),
    events,
  };
}

export function buildCalendarProjectionRun(
  snapshotInput: unknown,
  opts: { now?: string } = {},
): CalendarProjectionRun {
  // Deliberately do not render `now` into markdown. Calendar Projection pages
  // are fact-stable source surfaces; volatile run timestamps live in receipts
  // so repeated syncs with unchanged EventKit facts do not rewrite files.
  void opts;
  const snapshot = isNormalizedCalendarSnapshot(snapshotInput)
    ? snapshotInput
    : normalizeCalendarSnapshot(snapshotInput);
  const grouped = groupByDate(snapshot.events);
  const dayPages = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, events]) => renderDayPage(date, events, snapshot));
  const indexPage = renderIndexPage(dayPages, snapshot);
  const pages = [...dayPages, indexPage];
  const summary: CalendarProjectionSummary = {
    source_id: CALENDAR_SOURCE_ID,
    runtime_authority: CALENDAR_RUNTIME_AUTHORITY,
    source_runtime: CALENDAR_COLLECTOR,
    collector: CALENDAR_COLLECTOR,
    provider: 'macos-calendar',
    page_count: pages.length,
    event_count: snapshot.events.length,
    day_count: dayPages.length,
    pages_written: 0,
    provider_records_upserted: 0,
    ledgers_upserted: 0,
    receipts_recorded: 0,
    live_provider_calls: 0,
    live_gbrain_writes: 0,
  };
  return { snapshot, pages, day_pages: dayPages, summary };
}

export async function runCalendarProjectionSync(
  engine: BrainEngine,
  opts: CalendarProjectionSyncOpts,
): Promise<CalendarProjectionSyncResult> {
  assertDefaultSource(opts.sourceId ?? CALENDAR_SOURCE_ID);
  const run = buildCalendarProjectionRun(opts.snapshot, { now: opts.now });
  const dryRun = opts.dryRun === true;
  const sourceRoot = dryRun && opts.outputRoot
    ? resolve(opts.outputRoot)
    : await resolveDefaultSourceRoot(engine);
  if (opts.outputRoot) assertNotLegacyOpenClawRoot(opts.outputRoot);
  if (opts.allowedRoot) assertWithinAllowedRoot(sourceRoot, opts.allowedRoot);
  const calendarRoot = join(sourceRoot, CALENDAR_SOURCE_PREFIX);
  assertCalendarOutputRoot(sourceRoot, calendarRoot);

  if (dryRun) {
    const writeResult = await writeCalendarPages(run.pages, sourceRoot);
    return {
      status: 'dry_run',
      summary: {
        ...run.summary,
        status: 'dry_run',
        pages_written: writeResult.pagesWritten,
        output_root: sourceRoot,
      },
      pages: run.pages,
      files: writeResult.files,
    };
  }

  await ensureCalendarProjectionSchema(engine);
  // Files are written before the DB receipt transaction so readback receipts
  // only claim pages that exist on disk. The write itself is atomic and the
  // DB path is idempotent, so a crash between the two leaves a retry-repairable
  // generated page rather than a torn markdown file.
  const writeResult = await writeCalendarPages(run.pages, sourceRoot);
  const persistence = await persistCalendarProjectionRun(engine, run, writeResult.wroteBySlug);
  return {
    status: 'synced',
    summary: {
      ...run.summary,
      status: 'synced',
      pages_written: writeResult.pagesWritten,
      provider_records_upserted: persistence.provider_records_upserted,
      ledgers_upserted: persistence.ledgers_upserted,
      receipts_recorded: persistence.receipts_recorded,
      live_gbrain_writes: writeResult.pagesWritten,
      output_root: sourceRoot,
    },
    pages: run.pages,
    files: writeResult.files,
  };
}

export async function resolveDefaultSourceRoot(engine: BrainEngine): Promise<string> {
  const rows = await engine.executeRaw<SourceRootRow>(
    `SELECT local_path, archived FROM sources WHERE id = 'default' LIMIT 1`,
  );
  const row = rows[0];
  if (!row) throw new Error("Calendar Projection requires registered source 'default'");
  if (row.archived) throw new Error("Calendar Projection refuses archived source 'default'");
  if (!row.local_path) throw new Error("Calendar Projection requires source 'default' to have local_path");
  const root = resolve(row.local_path);
  assertNotLegacyOpenClawRoot(root);
  return root;
}

async function persistCalendarProjectionRun(
  engine: BrainEngine,
  run: CalendarProjectionRun,
  wroteBySlug: Map<string, boolean>,
): Promise<CalendarPersistenceSummary> {
  return await engine.transaction(async (tx) => {
    let providerRows = 0;
    let ledgerRows = 0;
    let receipts = 0;
    const ledgerIds = new Map<string, string>();
    for (const event of run.snapshot.events) {
      await upsertCalendarProviderRecord(tx, event);
      providerRows++;
      const daySlug = buildDaySlug(event.event_date);
      const ledgerId = await upsertCalendarLedger(tx, event, daySlug);
      ledgerIds.set(event.occurrence_key, ledgerId);
      ledgerRows++;
    }
    for (const page of run.pages) {
      const ledgerId = ledgerIdForPage(page, run.snapshot.events, ledgerIds);
      receipts += await insertCalendarReceipt(tx, page, ledgerId, wroteBySlug.get(page.slug) === true);
    }
    await tx.executeRaw(
      `INSERT INTO calendar_provider_cursors (source_id, provider, cursor_json, checked_at, updated_at)
       VALUES ('default', 'macos-calendar', $1::jsonb, now(), now())
       ON CONFLICT (source_id, provider) DO UPDATE SET
         cursor_json = EXCLUDED.cursor_json,
         checked_at = now(),
         updated_at = now()`,
      [JSON.stringify({
        source_checksum: run.snapshot.source_checksum,
        event_count: run.snapshot.events.length,
        synced_at: run.snapshot.synced_at,
      })],
    );
    return {
      provider_records_upserted: providerRows,
      ledgers_upserted: ledgerRows,
      receipts_recorded: receipts,
    };
  });
}

async function upsertCalendarProviderRecord(engine: BrainEngine, event: NormalizedCalendarEvent): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO calendar_provider_records
      (source_id, provider, provider_event_id, occurrence_key, calendar_name, summary, start_at, end_at,
       event_date, all_day, recurring, content_checksum, normalized_json, provider_payload_json)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
     ON CONFLICT (source_id, provider, occurrence_key) DO UPDATE SET
       provider_event_id = EXCLUDED.provider_event_id,
       calendar_name = EXCLUDED.calendar_name,
       summary = EXCLUDED.summary,
       start_at = EXCLUDED.start_at,
       end_at = EXCLUDED.end_at,
       event_date = EXCLUDED.event_date,
       all_day = EXCLUDED.all_day,
       recurring = EXCLUDED.recurring,
       content_checksum = EXCLUDED.content_checksum,
       normalized_json = EXCLUDED.normalized_json,
       provider_payload_json = EXCLUDED.provider_payload_json,
       last_seen_at = now()`,
    [
      event.provider,
      event.provider_event_id,
      event.occurrence_key,
      event.calendar_name,
      event.summary,
      event.start_iso,
      event.end_iso,
      event.event_date,
      event.all_day,
      event.recurring,
      event.content_checksum,
      JSON.stringify(event),
      JSON.stringify(stripPrivateCalendarFields(event)),
    ],
  );
}

async function upsertCalendarLedger(
  engine: BrainEngine,
  event: NormalizedCalendarEvent,
  pageSlug: string,
): Promise<string> {
  const history = [{
    state: 'page_written',
    reason: 'calendar_projection_default_source_page_rendered',
    checksum: event.content_checksum,
  }];
  const rows = await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO calendar_day_ledger
      (source_id, provider, occurrence_key, page_slug, event_date, content_checksum, state, history_json)
     VALUES ('default', $1, $2, $3, $4, $5, 'page_written', $6::jsonb)
     ON CONFLICT (source_id, provider, occurrence_key) DO UPDATE SET
       page_slug = EXCLUDED.page_slug,
       event_date = EXCLUDED.event_date,
       content_checksum = EXCLUDED.content_checksum,
       state = EXCLUDED.state,
       history_json = EXCLUDED.history_json,
       updated_at = now()
     RETURNING id`,
    [event.provider, event.occurrence_key, pageSlug, event.event_date, event.content_checksum, JSON.stringify(history)],
  );
  const id = rows[0]?.id;
  if (id == null) throw new Error(`Calendar ledger upsert returned no id for occurrence ${event.occurrence_key}`);
  return String(id);
}

async function insertCalendarReceipt(
  engine: BrainEngine,
  page: RenderedCalendarPage,
  ledgerId: string | null,
  wrote: boolean,
): Promise<number> {
  const receiptKey = sha256(['calendar-page', page.slug, page.content_checksum].join('|'));
  const rows = await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO calendar_projection_receipts
      (source_id, ledger_id, receipt_key, kind, page_slug, receipt_json)
     VALUES ('default', $1, $2, 'page_written', $3, $4::jsonb)
     ON CONFLICT (source_id, receipt_key) DO NOTHING
     RETURNING id`,
    [ledgerId, receiptKey, page.slug, JSON.stringify({
      slug: page.slug,
      content_checksum: page.content_checksum,
      event_count: page.event_count,
      write_performed: wrote,
      runtime_authority: CALENDAR_RUNTIME_AUTHORITY,
      collector: CALENDAR_COLLECTOR,
    })],
  );
  return rows.length;
}

async function writeCalendarPages(pages: readonly RenderedCalendarPage[], sourceRoot: string): Promise<PageWriteResult> {
  const files: string[] = [];
  const wroteBySlug = new Map<string, boolean>();
  let pagesWritten = 0;
  for (const page of pages) {
    const filePath = resolve(sourceRoot, `${page.slug}.md`);
    assertPathInside(filePath, sourceRoot, 'Calendar Projection page path escaped source root');
    assertNotLegacyOpenClawRoot(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    const wrote = await writeIfChanged(filePath, page.markdown);
    wroteBySlug.set(page.slug, wrote);
    if (wrote) pagesWritten++;
    files.push(filePath);
  }
  return { files, pagesWritten, wroteBySlug };
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === content) return false;
  } catch {
    // Missing/unreadable file takes the write path; writeFile surfaces hard failures.
  }
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, path);
  return true;
}

function renderDayPage(
  date: string,
  events: readonly NormalizedCalendarEvent[],
  snapshot: NormalizedCalendarSnapshot,
): RenderedCalendarPage {
  const slug = buildDaySlug(date);
  const title = `${date} (${weekdayName(date)})`;
  const body = [
    frontmatter({
      type: 'source',
      title: `Calendar — ${title}`,
      slug,
      source_id: CALENDAR_SOURCE_ID,
      managed_by: CALENDAR_PROJECTION_MANAGER,
      collector: CALENDAR_COLLECTOR,
      runtime_authority: CALENDAR_RUNTIME_AUTHORITY,
      provider: snapshot.provider,
      event_date: date,
      event_count: events.length,
      facts_checksum: sha256(events.map((event) => event.content_checksum).join('|')),
    }),
    `# Calendar — ${title}`,
    '',
    `Managed by ${CALENDAR_PROJECTION_MANAGER}; collector: ${CALENDAR_COLLECTOR}; runtime authority: ${CALENDAR_RUNTIME_AUTHORITY}.`,
    '',
    '## Events',
    ...events.map(formatEventLine),
    '',
  ].join('\n');
  return {
    slug,
    markdown: body,
    content_checksum: sha256(body),
    event_count: events.length,
    event_date: date,
  };
}

function renderIndexPage(dayPages: readonly RenderedCalendarPage[], snapshot: NormalizedCalendarSnapshot): RenderedCalendarPage {
  const slug = `${CALENDAR_SOURCE_PREFIX}/index`;
  const lines = dayPages.length === 0
    ? ['- No calendar events in the current collector window.']
    : dayPages.map((page) => {
      const date = page.event_date ?? page.slug.split('/').pop() ?? 'unknown-date';
      return `- [${date} (${weekdayName(date)})](${date.slice(0, 4)}/${date}.md) — ${page.event_count} event(s)`;
    });
  const body = [
    frontmatter({
      type: 'source',
      title: 'Calendar Projection Index',
      slug,
      source_id: CALENDAR_SOURCE_ID,
      managed_by: CALENDAR_PROJECTION_MANAGER,
      collector: CALENDAR_COLLECTOR,
      runtime_authority: CALENDAR_RUNTIME_AUTHORITY,
      provider: snapshot.provider,
      event_count: snapshot.events.length,
      day_count: dayPages.length,
      facts_checksum: snapshot.source_checksum,
    }),
    '# Calendar Projection Index',
    '',
    `Managed by ${CALENDAR_PROJECTION_MANAGER}; collector: ${CALENDAR_COLLECTOR}; runtime authority: ${CALENDAR_RUNTIME_AUTHORITY}.`,
    '',
    '## Days',
    ...lines,
    '',
  ].join('\n');
  return {
    slug,
    markdown: body,
    content_checksum: sha256(body),
    event_count: snapshot.events.length,
  };
}

function formatEventLine(event: NormalizedCalendarEvent): string {
  const time = event.all_day ? 'All day' : `${formatClock(event.start_iso)}${event.end_iso ? `–${formatClock(event.end_iso)}` : ''}`;
  const location = event.location ? ` @ ${event.location}` : '';
  const recurring = event.recurring ? ' · recurring' : '';
  return `- ${time} — ${event.summary} (${event.calendar_name})${location}${recurring}`;
}

function normalizeCalendarEvent(input: unknown, index: number): NormalizedCalendarEvent {
  const record = asRecord(input, 'calendar event');
  const calendarName = nonEmptyString(record.calendar) ?? 'Calendar';
  const summary = nonEmptyString(record.summary) ?? nonEmptyString(record.title) ?? 'Untitled event';
  const startIso = normalizeDateTime(record.start_iso) ?? normalizeDateTime(record.start);
  if (!startIso) throw new Error(`Calendar event ${index} is missing start_iso/start`);
  const endIso = normalizeDateTime(record.end_iso) ?? normalizeDateTime(record.end);
  const eventDate = startIso.slice(0, 10);
  const providerEventId = nonEmptyString(record.uid) ?? nonEmptyString(record.id) ?? sha256([calendarName, summary, startIso].join('|')).slice(0, 24);
  const allDay = Boolean(record.all_day);
  const location = nonEmptyString(record.location);
  const recurring = Boolean(record.recurring);
  const contentPayload = {
    calendar_name: calendarName,
    summary,
    start_iso: startIso,
    end_iso: endIso,
    event_date: eventDate,
    all_day: allDay,
    location,
    recurring,
  };
  const contentChecksum = sha256(JSON.stringify(contentPayload));
  const occurrenceKey = sha256(['macos-calendar', calendarName, providerEventId, startIso, endIso ?? ''].join('|'));
  return {
    provider: 'macos-calendar',
    provider_event_id: providerEventId,
    occurrence_key: occurrenceKey,
    calendar_name: calendarName,
    summary,
    start_iso: startIso,
    end_iso: endIso,
    event_date: eventDate,
    all_day: allDay,
    location,
    recurring,
    content_checksum: contentChecksum,
  };
}

function compareCalendarEvents(a: NormalizedCalendarEvent, b: NormalizedCalendarEvent): number {
  return a.start_iso.localeCompare(b.start_iso)
    || a.calendar_name.localeCompare(b.calendar_name)
    || a.summary.localeCompare(b.summary)
    || a.occurrence_key.localeCompare(b.occurrence_key);
}

function groupByDate(events: readonly NormalizedCalendarEvent[]): Map<string, NormalizedCalendarEvent[]> {
  const grouped = new Map<string, NormalizedCalendarEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.event_date) ?? [];
    list.push(event);
    grouped.set(event.event_date, list);
  }
  return grouped;
}

function ledgerIdForPage(
  page: RenderedCalendarPage,
  events: readonly NormalizedCalendarEvent[],
  ledgerIds: Map<string, string>,
): string | null {
  const event = events.find((candidate) => page.event_date === candidate.event_date);
  if (!event) return null;
  return ledgerIds.get(event.occurrence_key) ?? null;
}

function buildDaySlug(date: string): string {
  return `${CALENDAR_SOURCE_PREFIX}/${date.slice(0, 4)}/${date}`;
}

function frontmatter(fields: Record<string, string | number | boolean>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      lines.push(`${key}: ${quoteYaml(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function quoteYaml(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function weekdayName(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(parsed);
}

function formatClock(iso: string): string {
  const clock = iso.split('T')[1]?.slice(0, 5);
  return clock && /^\d{2}:\d{2}$/.test(clock) ? clock : iso;
}

function normalizeDateTime(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (isoMatch) return isoMatch[1]!.length === 16 ? `${isoMatch[1]}:00` : isoMatch[1]!;
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 19);
  return null;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`Invalid ${label}: expected object`);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalString(value: unknown): string | null {
  return nonEmptyString(value);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isNormalizedCalendarSnapshot(value: unknown): value is NormalizedCalendarSnapshot {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as Partial<NormalizedCalendarSnapshot>).collector === CALENDAR_COLLECTOR &&
    Array.isArray((value as Partial<NormalizedCalendarSnapshot>).events),
  );
}

function stripPrivateCalendarFields(event: NormalizedCalendarEvent): Record<string, unknown> {
  return {
    provider: event.provider,
    provider_event_id: event.provider_event_id,
    occurrence_key: event.occurrence_key,
    calendar_name: event.calendar_name,
    summary: event.summary,
    start_iso: event.start_iso,
    end_iso: event.end_iso,
    event_date: event.event_date,
    all_day: event.all_day,
    location: event.location,
    recurring: event.recurring,
    content_checksum: event.content_checksum,
  };
}

function assertDefaultSource(sourceId: string): void {
  if (sourceId !== CALENDAR_SOURCE_ID) {
    throw new Error(`Calendar Projection only writes source default, got ${sourceId}`);
  }
}

function assertCalendarOutputRoot(sourceRoot: string, calendarRoot: string): void {
  assertPathInside(calendarRoot, sourceRoot, 'Calendar Projection calendar root escaped source root');
  if (!calendarRoot.endsWith(`${sep}${CALENDAR_SOURCE_PREFIX.replace('/', sep)}`) &&
      !calendarRoot.endsWith(`${sep}sources${sep}calendar`)) {
    throw new Error('Calendar Projection output root must resolve under default:sources/calendar');
  }
}

function assertPathInside(path: string, root: string, message: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(message);
  }
}

function assertWithinAllowedRoot(outputRoot: string, allowedRoot: string): void {
  const output = resolve(outputRoot);
  const allowed = resolve(allowedRoot);
  if (output !== allowed && !output.startsWith(`${allowed}${sep}`)) {
    throw new Error(`Calendar Projection dry-run output root is outside allowed root: ${output}`);
  }
}

function assertNotLegacyOpenClawRoot(path: string): void {
  const lowered = resolve(path).toLowerCase();
  if (lowered.includes('.openclaw-jarvis-v2') || lowered.includes(`${sep}openclaw`)) {
    throw new Error('Calendar Projection must not target legacy OpenClaw roots');
  }
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
