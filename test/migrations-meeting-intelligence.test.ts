import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('migration v113 — meeting intelligence BrainEngine tables', () => {
  test('fresh schema exposes first-class meeting intelligence tables', async () => {
    const rows = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN (
             'meeting_provider_records',
             'meeting_ledger',
             'meeting_receipts',
             'meeting_wake_requests',
             'meeting_provider_cursors'
           )
         ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'meeting_ledger',
      'meeting_provider_cursors',
      'meeting_provider_records',
      'meeting_receipts',
      'meeting_wake_requests',
    ]);
  });

  test('ledger and wake constraints reject unsupported states', async () => {
    let ledgerRejected = false;
    try {
      await engine.executeRaw(
        `INSERT INTO meeting_ledger
          (source_id, provider, provider_meeting_id, transcript_checksum, source_checksum, state, history_json)
         VALUES ('default', 'fireflies', 'ff-mtg-constraint', 'abc', 'def', 'jobs_submitted', '[]'::jsonb)`,
      );
    } catch {
      ledgerRejected = true;
    }
    expect(ledgerRejected).toBe(true);

    let wakeRejected = false;
    try {
      await engine.executeRaw(
        `INSERT INTO meeting_wake_requests
          (source_id, provider, provider_meeting_id, wake_key, target_profile, status, prompt_text, payload_json)
         VALUES ('default', 'fireflies', 'ff-mtg-constraint', 'wake-key', 'alex', 'jobs_submitted', 'prompt', '{}'::jsonb)`,
      );
    } catch {
      wakeRejected = true;
    }
    expect(wakeRejected).toBe(true);
  });
});
