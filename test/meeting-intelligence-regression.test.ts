import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDefaultSourceWriteIntent,
  buildDefaultSourceWritePlan,
  buildMeetingRuntimeRun,
  collapseProviderDuplicates,
  normalizeLegacyMeetingMigrationCandidate,
  normalizeFirefliesMeeting,
  renderMeetingPage,
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

function legacyTrapStrings(): {
  sourceId: string;
  env: string;
  frontmatter: string;
  agentRoot: string;
} {
  const traps = fixture.fireflies.legacyTraps as {
    sourceIdFragments: string[];
    envFragments: string[];
    frontmatterFragments: string[];
    agentRootFragments: string[];
  };
  return {
    sourceId: traps.sourceIdFragments.join(''),
    env: traps.envFragments.join(''),
    frontmatter: traps.frontmatterFragments.join(''),
    agentRoot: traps.agentRootFragments.join('/'),
  };
}

describe('meeting intelligence regressions', () => {
  test('default-source write plans omit legacy source flags and reject stale source routing traps', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const page = renderMeetingPage(meeting);
    const plan = buildDefaultSourceWritePlan(page);
    const traps = legacyTrapStrings();

    expect(plan.source_id).toBe('default');
    expect(plan.argv).toEqual(['gbrain', 'put', page.slug, '--source', 'default']);
    expect(plan.env).toEqual({});
    expect(JSON.stringify(plan)).not.toContain(traps.env);
    expect(JSON.stringify(plan)).not.toContain(traps.frontmatter);
    expect(JSON.stringify(plan)).not.toContain(traps.agentRoot);

    expect(() =>
      assertDefaultSourceWriteIntent({
        source_id: 'default',
        argv: ['gbrain', 'put', page.slug],
        env: {},
        target_root: 'gbrain-default-source',
      }),
    ).toThrow(/explicit --source default/i);

    expect(() =>
      assertDefaultSourceWriteIntent({
        source_id: traps.sourceId,
        argv: ['gbrain', 'put', page.slug, '--source', traps.sourceId],
        env: { GBRAIN_SOURCE: traps.sourceId },
        target_root: traps.agentRoot,
      }),
    ).toThrow(/default source/i);
  });

  test('duplicate raw Fireflies records collapse to one canonical meeting packet', () => {
    const first = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const duplicate = normalizeFirefliesMeeting(fixture.fireflies.duplicate);
    const collapsed = collapseProviderDuplicates([duplicate, first]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.canonical.provider_meeting_id).toBe('ff-mtg-0001');
    expect(collapsed[0]?.raw_provider_ids).toEqual([
      'ff-mtg-0001',
      'ff-mtg-duplicate-0001',
    ]);
    expect(collapsed[0]?.duplicates).toEqual([
      {
        provider_meeting_id: 'ff-mtg-duplicate-0001',
        reason: 'same_provider_meeting_link_date_and_title',
      },
    ]);
  });

  test('parallel Fireflies bot records collapse even when one title is provider-generated untitled', () => {
    const first = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const parallelBot = normalizeFirefliesMeeting({
      ...(fixture.fireflies.completed as Record<string, unknown>),
      id: 'ff-mtg-parallel-bot-0001',
      transcript_id: 'ff-mtg-parallel-bot-0001',
      title: 'alice@example.com - Wed, 20 May 2026 03:01:30 +00 - Untitled',
      started_at: '2026-05-20T03:01:30.000Z',
      date_recorded: '2026-05-20T03:01:30.000Z',
      sentences: (fixture.fireflies.completed as { sentences: unknown[] }).sentences.slice(1),
    });

    const collapsed = collapseProviderDuplicates([parallelBot, first]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.canonical.provider_meeting_id).toBe('ff-mtg-0001');
    expect(collapsed[0]?.raw_provider_ids).toEqual([
      'ff-mtg-0001',
      'ff-mtg-parallel-bot-0001',
    ]);
    expect(collapsed[0]?.duplicates).toContainEqual({
      provider_meeting_id: 'ff-mtg-parallel-bot-0001',
      reason: 'same_provider_parallel_bot_same_start_window',
    });
  });

  test('rendered page and audit do not leak secret-like provider material', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const page = renderMeetingPage(meeting);
    const combined = `${page.markdown}\n${JSON.stringify(page.audit)}`;

    expect(combined).not.toContain('X-Amz-Signature');
    expect(combined).not.toContain('fixture-token-123');
    expect(combined).not.toContain('fixturebearer.abc.def');
    expect(combined).not.toContain('postgres://');
    expect(combined).not.toContain('pm_fixture_12345');
    expect(combined).not.toContain('4242 4242 4242 4242');
    expect(combined).not.toContain('0x1111111111111111111111111111111111111111');
  });

  test('runtime write candidates keep explicit default source and reject missing or legacy routes', () => {
    const meeting = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const runtime = buildMeetingRuntimeRun([meeting], { dry_run: true });
    const writePlan = runtime.write_plans[0]!;
    const traps = legacyTrapStrings();

    expect(writePlan.source_id).toBe('default');
    expect(writePlan.argv).toEqual([
      'gbrain',
      'put',
      writePlan.slug,
      '--source',
      'default',
    ]);
    expect(writePlan.mode).toBe('dry_run');
    expect(JSON.stringify(runtime)).not.toContain(traps.env);
    expect(JSON.stringify(runtime)).not.toContain(traps.frontmatter);
    expect(() =>
      assertDefaultSourceWriteIntent({
        ...writePlan,
        argv: ['gbrain', 'put', writePlan.slug],
      }),
    ).toThrow(/explicit --source default/i);
  });

  test('legacy non-default rows are fixture-only migration candidates, never canonical writes', () => {
    const candidate = normalizeLegacyMeetingMigrationCandidate({
      provider: 'fireflies',
      provider_meeting_id: 'ff-mtg-0001',
      source_id: legacyTrapStrings().sourceId,
    });

    expect(candidate.target_source_id).toBe('default');
    expect(candidate.canonical_write_allowed).toBe(false);
    expect(candidate.action).toBe('manual_review_required');
    expect(candidate.reason).toContain('never canonical writes');
  });
});
