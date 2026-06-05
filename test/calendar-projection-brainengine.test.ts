/**
 * Calendar Projection migration: EventKit/macOS collector -> BrainEngine ledger
 * -> default source pages. This locks the neutral GBrain boundary before the
 * legacy OpenClaw projection side-door is tombstoned.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  buildCalendarProjectionRun,
  ensureCalendarProjectionSchema,
  normalizeCalendarSnapshot,
  runCalendarProjectionSync,
} from '../src/core/calendar-projection/index.ts';

let engine: PGLiteEngine;
let brainRoot: string;

const fixtureSnapshot = {
  synced_at: '2026-06-03T11:00:00',
  days_back: 30,
  days_ahead: 14,
  source: 'macos-calendar',
  source_method: 'eventkit',
  freshness_window_minutes: 90,
  calendar_count: 2,
  event_count: 2,
  events: [
    {
      calendar: 'Synthetic Work',
      summary: 'Synthetic founder check-in',
      start: 'Wednesday, 3 June 2026 at 10:30:00',
      end: 'Wednesday, 3 June 2026 at 11:00:00',
      all_day: false,
      location: 'Video call',
      notes: 'must not be projected into source pages',
      uid: 'synthetic-event-1@example.test',
      recurring: false,
      start_iso: '2026-06-03T10:30:00',
      end_iso: '2026-06-03T11:00:00',
    },
    {
      calendar: 'Synthetic Holidays',
      summary: 'Synthetic holiday',
      start: 'Wednesday, 3 June 2026 at 00:00:00',
      end: 'Wednesday, 3 June 2026 at 23:59:59',
      all_day: true,
      location: '',
      notes: '',
      uid: 'synthetic-event-2@example.test',
      recurring: true,
      start_iso: '2026-06-03T00:00:00',
      end_iso: '2026-06-03T23:59:59',
    },
  ],
};

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
  brainRoot = mkdtempSync(join(tmpdir(), 'calendar-projection-brain-'));
  await engine.executeRaw(
    `UPDATE sources SET local_path = $1, config = '{"federated": true}'::jsonb WHERE id = 'default'`,
    [brainRoot],
  );
});

describe('Calendar Projection renderer boundary', () => {
  test('renders default-source Calendar pages with GBrain-native provenance and no OpenClaw owner', () => {
    const snapshot = normalizeCalendarSnapshot(fixtureSnapshot);
    const run = buildCalendarProjectionRun(snapshot, { now: '2026-06-03T12:00:00' });

    expect(run.summary.runtime_authority).toBe('gbrain_brainengine');
    expect(run.summary.source_id).toBe('default');
    expect(run.summary.source_runtime).toBe('macos-calendar-eventkit');
    expect(run.pages).toHaveLength(2);

    const day = run.pages.find((page) => page.slug === 'sources/calendar/2026/2026-06-03');
    expect(day).toBeDefined();
    expect(day!.markdown).toContain('managed_by: gbrain-runtime/calendar-projection');
    expect(day!.markdown).toContain('collector: macos-calendar-eventkit');
    expect(day!.markdown).toContain('runtime_authority: gbrain_brainengine');
    expect(day!.markdown).toContain('Synthetic founder check-in');
    expect(day!.markdown).not.toContain('.openclaw-jarvis-v2');
    expect(day!.markdown).not.toContain('calendar-brain-sync.py');
    expect(day!.markdown).not.toContain('must not be projected into source pages');
  });
});

describe('Calendar Projection BrainEngine persistence and idempotency', () => {
  test('writes default source pages, provider rows, ledgers, and receipts exactly once for unchanged calendar facts', async () => {
    const first = await runCalendarProjectionSync(engine, {
      sourceId: 'default',
      snapshot: fixtureSnapshot,
      now: '2026-06-03T12:00:00',
      dryRun: false,
    });

    expect(first.status).toBe('synced');
    expect(first.summary.page_count).toBe(2);
    expect(first.summary.pages_written).toBe(2);
    expect(first.summary.live_provider_calls).toBe(0);

    const dayPath = join(brainRoot, 'sources/calendar/2026/2026-06-03.md');
    const indexPath = join(brainRoot, 'sources/calendar/index.md');
    const firstDayStat = statSync(dayPath).mtimeMs;
    const dayMarkdown = readFileSync(dayPath, 'utf8');
    const indexMarkdown = readFileSync(indexPath, 'utf8');
    expect(dayMarkdown).toContain('Synthetic founder check-in');
    expect(dayMarkdown).toContain('managed_by: gbrain-runtime/calendar-projection');
    expect(indexMarkdown).toContain('[2026-06-03 (Wednesday)](2026/2026-06-03.md) — 2 event(s)');

    const dayPage = await engine.getPage('sources/calendar/2026/2026-06-03', { sourceId: 'default' });
    const indexPage = await engine.getPage('sources/calendar/index', { sourceId: 'default' });
    expect(dayPage?.compiled_truth).toContain('Synthetic founder check-in');
    expect(indexPage?.compiled_truth).toContain('[2026-06-03 (Wednesday)](2026/2026-06-03.md) — 2 event(s)');
    expect(indexPage?.frontmatter.event_count).toBe(2);

    await ensureCalendarProjectionSchema(engine);
    const providerRows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM calendar_provider_records WHERE source_id = 'default'`,
    );
    const ledgerRows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM calendar_day_ledger WHERE source_id = 'default'`,
    );
    const receiptRows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM calendar_projection_receipts WHERE source_id = 'default'`,
    );
    const jsonbRows = await engine.executeRaw<{ provider_json: string; ledger_json: string; receipt_json: string; cursor_json: string }>(
      `SELECT
         (SELECT jsonb_typeof(normalized_json) FROM calendar_provider_records WHERE source_id = 'default' LIMIT 1) AS provider_json,
         (SELECT jsonb_typeof(history_json) FROM calendar_day_ledger WHERE source_id = 'default' LIMIT 1) AS ledger_json,
         (SELECT jsonb_typeof(receipt_json) FROM calendar_projection_receipts WHERE source_id = 'default' LIMIT 1) AS receipt_json,
         (SELECT jsonb_typeof(cursor_json) FROM calendar_provider_cursors WHERE source_id = 'default' LIMIT 1) AS cursor_json`,
    );
    expect(Number(providerRows[0]!.count)).toBe(2);
    expect(Number(ledgerRows[0]!.count)).toBe(2);
    expect(Number(receiptRows[0]!.count)).toBeGreaterThanOrEqual(2);
    expect(jsonbRows[0]).toEqual({
      provider_json: 'object',
      ledger_json: 'array',
      receipt_json: 'object',
      cursor_json: 'object',
    });

    const second = await runCalendarProjectionSync(engine, {
      sourceId: 'default',
      snapshot: fixtureSnapshot,
      now: '2026-06-03T12:30:00',
      dryRun: false,
    });
    expect(second.status).toBe('synced');
    expect(second.summary.pages_written).toBe(0);
    expect(statSync(dayPath).mtimeMs).toBe(firstDayStat);
  });

  test('refuses non-default source writes and legacy OpenClaw output roots', async () => {
    await expect(runCalendarProjectionSync(engine, {
      sourceId: 'workspace',
      snapshot: fixtureSnapshot,
      now: '2026-06-03T12:00:00',
      dryRun: false,
    })).rejects.toThrow(/Calendar Projection only writes source default/);

    await expect(runCalendarProjectionSync(engine, {
      sourceId: 'default',
      snapshot: fixtureSnapshot,
      outputRoot: '/Users/jarvis/.openclaw-jarvis-v2/brain/sources/calendar',
      now: '2026-06-03T12:00:00',
      dryRun: false,
    })).rejects.toThrow(/must not target legacy OpenClaw roots/);
  });
});

describe('calendar_projection_sync Minion handler', () => {
  test('is registered and calls the core BrainEngine Calendar Projection path', async () => {
    const worker = new MinionWorker(engine, { concurrency: 1 });
    await registerBuiltinHandlers(worker, engine);
    const handler = (worker as unknown as { handlers: Map<string, (j: any) => Promise<any>> }).handlers.get('calendar_projection_sync');
    expect(handler).toBeDefined();

    const result = await handler!({
      id: 99,
      name: 'calendar_projection_sync',
      data: {
        sourceId: 'default',
        snapshot: fixtureSnapshot,
        now: '2026-06-03T12:00:00',
        dryRun: false,
      },
      signal: new AbortController().signal,
      updateProgress: async () => {},
    });

    expect(result.status).toBe('synced');
    expect(result.summary.runtime_authority).toBe('gbrain_brainengine');
    expect(readFileSync(join(brainRoot, 'sources/calendar/2026/2026-06-03.md'), 'utf8')).toContain('Synthetic founder check-in');
  });
});
