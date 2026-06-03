import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMeetingIntelligenceArtifacts,
  normalizeFirefliesMeeting,
} from '../src/core/meeting-intelligence/index.ts';
import { runMeetingIntelligenceCli } from '../src/commands/meeting-intelligence.ts';

const fixturePath = join(
  import.meta.dir,
  'fixtures',
  'meeting-intelligence',
  'fireflies-completed.synthetic.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  fireflies: Record<string, unknown>;
};

describe('meeting intelligence temp-only integration', () => {
  test('simulates completed event to page artifact and enrichment-pending audit state', () => {
    const completed = normalizeFirefliesMeeting(fixture.fireflies.completed);
    const duplicate = normalizeFirefliesMeeting(fixture.fireflies.duplicate);
    const result = buildMeetingIntelligenceArtifacts([completed, duplicate]);

    expect(result.pages).toHaveLength(1);
    expect(result.ledgers).toHaveLength(1);
    expect(result.ledgers[0]?.state).toBe('enrichment_pending');
    expect(result.ledgers[0]?.history.map((h) => h.to)).toEqual([
      'transcript_ready',
      'page_rendered',
      'enrichment_pending',
    ]);
    expect(result.pages[0]?.markdown).toContain('## Full Diarized Transcript');
    expect(result.pages[0]?.source_id).toBe('default');
    expect(result.review_queue).toHaveLength(3);
    expect(result.audit.default_source_intent).toBe(true);
    expect(result.audit.live_provider_calls).toBe(0);
    expect(result.audit.live_gbrain_writes).toBe(0);
    expect(result.audit.duplicate_raw_records).toBe(1);
  });

  test('runs the dry-run CLI surface with a synthetic Fireflies fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-meeting-intelligence-cli-'));
    try {
      const stdout: string[] = [];
      const code = await runMeetingIntelligenceCli([
        'dry-run',
        '--fixture',
        fixturePath,
        '--out',
        root,
        '--allow-root',
        root,
        '--include-duplicates',
        '--json',
      ], { stdout: (line) => stdout.push(line) });
      const summary = JSON.parse(stdout[0]!) as {
        status: string;
        page_count: number;
        duplicate_raw_records: number;
        review_queue_count: number;
        live_provider_calls: number;
        live_gbrain_writes: number;
        runtime: { source_id: string; write_required_count: number };
      };

      expect(code).toBe(0);
      expect(summary.status).toBe('dry_run_complete');
      expect(summary.page_count).toBe(1);
      expect(summary.duplicate_raw_records).toBe(1);
      expect(summary.review_queue_count).toBe(3);
      expect(summary.live_provider_calls).toBe(0);
      expect(summary.live_gbrain_writes).toBe(0);
      expect(summary.runtime.source_id).toBe('default');
      expect(summary.runtime.write_required_count).toBe(1);
      expect(existsSync(join(root, 'summary.json'))).toBe(true);
      expect(existsSync(join(root, 'receipts'))).toBe(true);
      expect(existsSync(join(root, 'review'))).toBe(true);
      expect(existsSync(join(root, 'ledger'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
