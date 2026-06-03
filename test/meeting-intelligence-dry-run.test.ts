import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMeetingIntelligenceDryRun,
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

describe('meeting intelligence dry-run harness', () => {
  test('writes deterministic temp-only page and audit artifacts and reruns idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-meeting-intelligence-'));
    try {
      const first = await runMeetingIntelligenceDryRun({
        provider_payloads: [
          fixture.fireflies.completed,
          fixture.fireflies.duplicate,
        ],
        output_root: root,
        allowed_root: root,
      });
      const second = await runMeetingIntelligenceDryRun({
        provider_payloads: [
          fixture.fireflies.completed,
          fixture.fireflies.duplicate,
        ],
        output_root: root,
        allowed_root: root,
      });

      expect(first.pages_written).toBe(1);
      expect(first.audit_files_written).toBe(1);
      expect(first.receipt_files_written).toBe(3);
      expect(first.files.every((file) => file.startsWith(root))).toBe(true);
      expect(second.pages_written).toBe(0);
      expect(second.idempotent_pages).toBe(1);
      expect(second.receipt_files_written).toBe(0);
      expect(existsSync(first.files[0]!)).toBe(true);

      const page = readFileSync(first.files[0]!, 'utf8');
      expect(page).toContain('## Full Diarized Transcript');
      expect(page).toContain('gbrain_source_id: default');
      expect(page).not.toContain('fixture-token-123');
      const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')) as {
        runtime: { source_id: string; live_provider_calls: number; live_gbrain_writes: number };
        review_queue_count: number;
      };
      expect(summary.runtime.source_id).toBe('default');
      expect(summary.runtime.live_provider_calls).toBe(0);
      expect(summary.runtime.live_gbrain_writes).toBe(0);
      expect(summary.review_queue_count).toBe(3);
      expect(existsSync(join(root, 'receipts'))).toBe(true);
      expect(existsSync(join(root, 'review'))).toBe(true);
      expect(existsSync(join(root, 'ledger'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses dry-run output roots outside the approved temp root', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'gbrain-meeting-intelligence-allowed-'));
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-meeting-intelligence-outside-'));
    try {
      await expect(
        runMeetingIntelligenceDryRun({
          provider_payloads: [fixture.fireflies.completed],
          output_root: outside,
          allowed_root: allowed,
        }),
      ).rejects.toThrow(/outside allowed dry-run root/i);
    } finally {
      rmSync(allowed, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
