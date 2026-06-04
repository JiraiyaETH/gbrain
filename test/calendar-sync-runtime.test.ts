import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GBrain runtime Calendar sync wrapper', () => {
  test('dry-run snapshot replay writes neutral runtime state and strips private event notes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sync-runtime-test-'));
    const snapshotPath = join(dir, 'calendar.json');
    const stateRoot = join(dir, 'state');
    const privateSentinel = 'PRIVATE_NOTES_SENTINEL_MUST_NOT_PERSIST';
    writeFileSync(snapshotPath, JSON.stringify({
      synced_at: '2026-06-03T11:00:00',
      days_back: 1,
      days_ahead: 14,
      source: 'macos-calendar',
      source_method: 'eventkit',
      freshness_window_minutes: 90,
      calendar_count: 1,
      event_count: 1,
      events: [{
        calendar: 'Synthetic Work',
        summary: 'Synthetic agenda sync',
        start: 'Wednesday, 3 June 2026 at 10:30:00',
        end: 'Wednesday, 3 June 2026 at 11:00:00',
        all_day: false,
        location: 'Synthetic Room',
        notes: privateSentinel,
        description: privateSentinel,
        uid: 'synthetic-runtime-event@example.test',
        recurring: false,
        start_iso: '2999-06-03T10:30:00',
        end_iso: '2999-06-03T11:00:00',
      }],
    }, null, 2));

    const proc = Bun.spawnSync([
      '/usr/bin/python3',
      'scripts/calendar-sync-refresh.py',
      '--snapshot', snapshotPath,
      '--state-root', stateRoot,
      '--dry-run',
      '--skip-projection',
    ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });

    expect(proc.exitCode).toBe(0);
    const result = JSON.parse(proc.stdout.toString());
    expect(result.status).toBe('dry_run');
    expect(result.live_provider_calls).toBe(0);
    expect(String(result.state_root).startsWith('/tmp/calendar-sync-refresh-proof-')).toBe(true);
    expect(String(result.state_root)).not.toContain('.openclaw-jarvis-v2');
    expect(result.projection).toBeNull();

    const runtimeSnapshot = readFileSync(join(result.state_root, 'calendar.json'), 'utf8');
    const agendaJson = readFileSync(join(result.state_root, 'calendar-agenda.json'), 'utf8');
    const agendaMd = readFileSync(join(result.state_root, 'calendar-agenda-latest.md'), 'utf8');
    const heartbeat = readFileSync(join(result.state_root, 'calendar-sync.json'), 'utf8');
    const combined = [runtimeSnapshot, agendaJson, agendaMd, heartbeat].join('\n');

    expect(combined).toContain('gbrain-runtime');
    expect(combined).toContain('Synthetic agenda sync');
    expect(combined).not.toContain(privateSentinel);
    expect(combined).not.toContain('notes');
    expect(combined).not.toContain('description');
    expect(combined).not.toContain('.openclaw-jarvis-v2');
  });
});
