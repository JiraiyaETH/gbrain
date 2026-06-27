/**
 * E2E smoke — meeting-ingestion (v1.6.0) Phase-7 QA gate.
 *
 * Proves the skill's verification contract end-to-end against a real brain:
 * the resolver routes a meeting trigger to the skill, and the Phase-7 QA gate
 * (skills/meeting-ingestion/scripts/qa-meeting.sh) runs GREEN on an already-
 * ingested meeting (full frontmatter + two-layer + edge contract).
 *
 * DB-gated like the rest of test/e2e: skips unless a real brain is reachable
 * AND SMOKE_SLUG names an ingested meeting + EXEMPT_PAGES/BRAIN_DIR are set
 * (method in references/doctrine.md; this brain's values are supplied via env).
 */
import { describe, test, expect } from 'bun:test';
import { hasDatabase } from './helpers.ts';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const RUN = hasDatabase() && !!process.env.SMOKE_SLUG;
const d = RUN ? describe : describe.skip;

d('meeting-ingestion E2E smoke', () => {
  test('resolver routing + Phase-7 QA gate pass on an ingested meeting', () => {
    const smoke = resolve(import.meta.dir, '../../skills/meeting-ingestion/e2e/smoke.sh');
    const out = execFileSync('bash', [smoke], { encoding: 'utf8', env: process.env });
    expect(out).toContain('PASS: resolver routes meeting trigger');
    expect(out).toContain('E2E SMOKE: PASS');
  });
});
