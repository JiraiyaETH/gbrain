#!/usr/bin/env python3
"""GBrain-native Calendar sync runtime.

Owns the full neutral Calendar source-adapter lane:
  macOS EventKit -> runtime state snapshot/agenda/heartbeat -> BrainEngine Calendar Projection.

The script prints only counts, paths, statuses, and commit ids. It never prints raw
calendar event bodies or rendered markdown.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DEFAULT_RUNTIME_ROOT = Path('/Users/jarvis/gbrain-runtime')
DEFAULT_BRAIN_ROOT = Path('/Users/jarvis/gbrain/main')
DEFAULT_GBRAIN = Path('/Users/jarvis/.local/bin/gbrain-supabase-mcp')
DEFAULT_STATE_ROOT = DEFAULT_RUNTIME_ROOT / 'var' / 'calendar'
DEFAULT_EXPORTER_APP_NAME = 'JarvisCalendarEventKitExporter.app'

SAFE_EVENT_KEYS = (
    'calendar',
    'summary',
    'start',
    'end',
    'start_iso',
    'end_iso',
    'all_day',
    'location',
    'uid',
    'recurring',
)


class CalendarSyncError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Sync macOS Calendar into GBrain-native Calendar source pages.')
    parser.add_argument('days_ahead', nargs='?', type=int, default=14)
    parser.add_argument('--days-back', type=int, default=int(os.environ.get('CALENDAR_SYNC_DAYS_BACK', '1')))
    parser.add_argument('--snapshot', type=Path, help='Use an existing collector snapshot instead of calling EventKit')
    parser.add_argument('--runtime-root', type=Path, default=Path(os.environ.get('GBRAIN_RUNTIME_ROOT', DEFAULT_RUNTIME_ROOT)))
    parser.add_argument('--brain-root', type=Path, default=Path(os.environ.get('GBRAIN_DEFAULT_SOURCE_ROOT', DEFAULT_BRAIN_ROOT)))
    parser.add_argument('--state-root', type=Path, default=Path(os.environ.get('CALENDAR_SYNC_STATE_ROOT', DEFAULT_STATE_ROOT)))
    parser.add_argument('--gbrain-bin', type=Path, default=Path(os.environ.get('GBRAIN_BIN_WRAPPER', DEFAULT_GBRAIN)))
    parser.add_argument('--eventkit-timeout', type=int, default=int(os.environ.get('CALENDAR_SYNC_EVENTKIT_TIMEOUT_SECONDS', '45')))
    parser.add_argument('--projection-timeout', type=int, default=int(os.environ.get('CALENDAR_PROJECTION_TIMEOUT_SECONDS', '120')))
    parser.add_argument('--sync-timeout', type=int, default=int(os.environ.get('CALENDAR_PROJECTION_SYNC_TIMEOUT_SECONDS', '300')))
    parser.add_argument('--dry-run', action='store_true', help='Use proof temp state and projection dry-run; no Brain/source commits')
    parser.add_argument('--skip-projection', action='store_true', help='Only write/preview runtime snapshot+agenda+heartbeat')
    parser.add_argument('--quiet', action='store_true')
    return parser.parse_args()


def run(
    cmd: list[str],
    *,
    cwd: Path | None,
    timeout: int,
    env: dict[str, str],
    start_new_session: bool = False,
) -> subprocess.CompletedProcess[str]:
    proc: subprocess.Popen[str] | None = None
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=start_new_session,
        )
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if proc is not None and proc.poll() is None:
            if start_new_session:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                proc.terminate()
            try:
                stdout, stderr = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                if start_new_session:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    proc.kill()
                stdout, stderr = proc.communicate()
        raise CalendarSyncError(f'command timed out after {timeout}s: {cmd[0]}')

    if proc.returncode != 0:
        detail = (stderr or stdout or '').strip()
        raise CalendarSyncError(f'command failed ({cmd[0]} {cmd[1] if len(cmd) > 1 else ""}, exit={proc.returncode}): {detail[:1000]}')
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def load_snapshot(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise CalendarSyncError(f'calendar snapshot root must be object: {path}')
    events = data.get('events')
    if not isinstance(events, list):
        raise CalendarSyncError(f'calendar snapshot has no events[] list: {path}')
    return data


def sanitize_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Return the persisted collector snapshot with private body fields stripped.

    Calendar event summaries/times/locations are the syncable facts. Freeform
    event notes/descriptions are private bodies and must not enter runtime state,
    BrainEngine provider payloads, generated pages, or agenda surfaces.
    """
    events = []
    for raw in snapshot.get('events') or []:
        if isinstance(raw, dict):
            events.append(event_copy(raw))
    return {
        'synced_at': snapshot.get('synced_at'),
        'days_back': snapshot.get('days_back'),
        'days_ahead': snapshot.get('days_ahead'),
        'source': snapshot.get('source'),
        'source_method': snapshot.get('source_method'),
        'freshness_window_minutes': snapshot.get('freshness_window_minutes'),
        'calendar_count': snapshot.get('calendar_count'),
        'event_count': snapshot.get('event_count', len(events)),
        'events': events,
    }


def snapshot_metadata(snapshot: dict[str, Any]) -> dict[str, Any]:
    events = snapshot.get('events') if isinstance(snapshot.get('events'), list) else []
    return {
        'synced_at': snapshot.get('synced_at'),
        'source': snapshot.get('source'),
        'source_method': snapshot.get('source_method'),
        'calendar_count': snapshot.get('calendar_count'),
        'event_count': snapshot.get('event_count', len(events)),
        'events_len': len(events),
        'days_back': snapshot.get('days_back'),
        'days_ahead': snapshot.get('days_ahead'),
    }


def collect_eventkit_snapshot(args: argparse.Namespace, output_path: Path, env: dict[str, str]) -> None:
    runtime_root = args.runtime_root.expanduser().resolve()
    exporter_app = args.state_root.expanduser().resolve() / DEFAULT_EXPORTER_APP_NAME
    exporter_swift = runtime_root / 'scripts' / 'calendar-eventkit-exporter-app.swift'
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if exporter_app.exists():
        cmd = ['open', '-W', '-n', '-g', '-j', str(exporter_app), '--args', str(args.days_ahead), str(output_path), str(args.days_back)]
    elif exporter_swift.exists():
        cmd = ['/usr/bin/swift', str(exporter_swift), str(args.days_ahead), str(output_path), str(args.days_back)]
    else:
        raise FileNotFoundError(f'Calendar EventKit exporter missing: {exporter_app} or {exporter_swift}')
    run(cmd, cwd=runtime_root, timeout=args.eventkit_timeout, env=env, start_new_session=True)


def validate_candidate(candidate: dict[str, Any], existing: dict[str, Any] | None) -> None:
    try:
        candidate_calendar_count = int(candidate.get('calendar_count') or 0)
    except Exception:
        candidate_calendar_count = 0
    if candidate_calendar_count <= 0:
        raise CalendarSyncError('EventKit candidate calendar_count must be positive')

    if not existing:
        return
    try:
        existing_calendar_count = int(existing.get('calendar_count') or 0)
    except Exception:
        existing_calendar_count = 0
    if existing_calendar_count > 0 and candidate_calendar_count < existing_calendar_count:
        raise CalendarSyncError(
            f'EventKit candidate sees fewer calendars than last-known-good ({candidate_calendar_count} < {existing_calendar_count}); preserving outputs'
        )

    now = datetime.now()
    existing_future = []
    for event in existing.get('events') or []:
        if not isinstance(event, dict):
            continue
        parsed = parse_event_start(event)
        if parsed is not None and parsed >= now:
            existing_future.append(event)
    try:
        candidate_count = int(candidate.get('event_count') or 0)
    except Exception:
        candidate_count = 0
    if candidate_count == 0 and existing_future:
        raise CalendarSyncError(
            f'EventKit candidate has zero events while last-known-good has {len(existing_future)} future events; preserving outputs'
        )


def parse_event_start(event: dict[str, Any]) -> datetime | None:
    value = event.get('start_iso') or event.get('start')
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ('%A, %d %B %Y at %H:%M:%S', '%A, %-d %B %Y at %H:%M:%S'):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def event_copy(event: dict[str, Any]) -> dict[str, Any]:
    return {key: event.get(key) for key in SAFE_EVENT_KEYS if key in event}


def build_agenda(snapshot: dict[str, Any], *, generated_at: str, state_root: Path) -> tuple[dict[str, Any], str, dict[str, Any]]:
    calendar_path = state_root / 'calendar.json'
    agenda_json_path = state_root / 'calendar-agenda.json'
    agenda_md_path = state_root / 'calendar-agenda-latest.md'
    heartbeat_path = state_root / 'calendar-sync.json'
    now = datetime.now()
    window_48h = now + timedelta(hours=48)

    events: list[dict[str, Any]] = []
    for raw in snapshot.get('events') or []:
        if not isinstance(raw, dict):
            continue
        start_dt = parse_event_start(raw)
        if start_dt is None or start_dt < now:
            continue
        copied = event_copy(raw)
        copied['_start_dt'] = start_dt
        events.append(copied)
    events.sort(key=lambda event: (event['_start_dt'], str(event.get('summary') or '')))

    upcoming = []
    upcoming_48h = []
    for event in events:
        copied = dict(event)
        start_dt = copied.pop('_start_dt')
        upcoming.append(copied)
        if start_dt <= window_48h:
            upcoming_48h.append(copied)

    agenda = {
        'schema_version': 'calendar-agenda-v1',
        'generated_at': generated_at,
        'source_calendar_path': str(calendar_path),
        'freshness_window_minutes': int(snapshot.get('freshness_window_minutes') or 90),
        'days_ahead': snapshot.get('days_ahead'),
        'days_back': snapshot.get('days_back'),
        'calendar_count': snapshot.get('calendar_count'),
        'event_count': snapshot.get('event_count'),
        'upcoming_count': len(upcoming),
        'upcoming_48h_count': len(upcoming_48h),
        'next_event': upcoming[0] if upcoming else None,
        'upcoming_48h': upcoming_48h,
        'upcoming': upcoming,
    }

    lines = [
        '# Calendar Agenda Latest',
        '',
        f'Generated: {generated_at}',
        f'Source: `{calendar_path}`',
        'Freshness contract: updated by GBrain runtime Calendar sync; stale if older than 90 minutes or heartbeat status is not ok.',
        '',
        '## Next 48 hours',
    ]
    if not upcoming_48h:
        lines.append('- No upcoming calendar events in the next 48 hours.')
    else:
        for event in upcoming_48h:
            when = event.get('start') or event.get('start_iso') or '<unknown time>'
            title = event.get('summary') or '<untitled>'
            cal_name = event.get('calendar') or '<unknown calendar>'
            loc = event.get('location') or ''
            loc_text = f' — {loc}' if loc else ''
            all_day = ' [all-day]' if event.get('all_day') else ''
            lines.append(f'- {when}: {title}{all_day} ({cal_name}){loc_text}')

    lines.extend(['', '## Upcoming window'])
    if not upcoming:
        lines.append('- No upcoming calendar events in the synced window.')
    else:
        for event in upcoming[:20]:
            when = event.get('start') or event.get('start_iso') or '<unknown time>'
            title = event.get('summary') or '<untitled>'
            cal_name = event.get('calendar') or '<unknown calendar>'
            all_day = ' [all-day]' if event.get('all_day') else ''
            lines.append(f'- {when}: {title}{all_day} ({cal_name})')

    lines.extend([
        '',
        '## Agent usage',
        '- For schedule-aware work, read this file first for the human agenda view.',
        f'- For machine filtering, read `{agenda_json_path}` and `{calendar_path}`.',
        f'- Treat `{heartbeat_path}.status != ok` as stale/unknown; do not infer no meetings.',
        '- Durable source lookup lives in GBrain `default:sources/calendar/index` and linked day pages.',
    ])

    heartbeat = {
        'agent': 'gbrain-runtime-calendar-sync',
        'status': 'ok',
        'ts': generated_at,
        'source': 'macos-calendar',
        'source_method': snapshot.get('source_method') or 'eventkit',
        'runtime_authority': 'gbrain-runtime/calendar-sync-refresh.py',
        'calendar_path': str(calendar_path),
        'agenda_json_path': str(agenda_json_path),
        'agenda_md_path': str(agenda_md_path),
        'calendar_count': snapshot.get('calendar_count'),
        'event_count': snapshot.get('event_count'),
        'upcoming_count': len(upcoming),
        'next_event': upcoming[0] if upcoming else None,
        'freshness_window_minutes': int(snapshot.get('freshness_window_minutes') or 90),
    }
    return agenda, '\n'.join(lines) + '\n', heartbeat


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', delete=False, dir=str(path.parent), prefix=f'.{path.name}.tmp.') as handle:
        handle.write(content)
        tmp_path = Path(handle.name)
    tmp_path.replace(path)


def write_runtime_state(state_root: Path, snapshot: dict[str, Any], agenda: dict[str, Any], agenda_md: str, heartbeat: dict[str, Any]) -> None:
    atomic_write(state_root / 'calendar.json', json.dumps(snapshot, indent=2, ensure_ascii=False) + '\n')
    atomic_write(state_root / 'calendar-agenda.json', json.dumps(agenda, indent=2, ensure_ascii=False) + '\n')
    atomic_write(state_root / 'calendar-agenda-latest.md', agenda_md)
    atomic_write(state_root / 'calendar-sync.json', json.dumps(heartbeat, indent=2, ensure_ascii=False) + '\n')


def write_failure_heartbeat(state_root: Path, reason: str) -> None:
    heartbeat_path = state_root / 'calendar-sync.json'
    existing: dict[str, Any] = {}
    try:
        existing = json.loads(heartbeat_path.read_text(encoding='utf-8'))
        if not isinstance(existing, dict):
            existing = {}
    except Exception:
        existing = {}
    now = datetime.now().isoformat(timespec='seconds')
    last_success_ts = existing.get('last_success_ts')
    if existing.get('status') == 'ok':
        last_success_ts = existing.get('ts')
    heartbeat = {
        'agent': 'gbrain-runtime-calendar-sync',
        'status': 'stale_unknown',
        'ts': now,
        'source': 'macos-calendar',
        'runtime_authority': 'gbrain-runtime/calendar-sync-refresh.py',
        'calendar_path': str(state_root / 'calendar.json'),
        'agenda_json_path': str(state_root / 'calendar-agenda.json'),
        'agenda_md_path': str(state_root / 'calendar-agenda-latest.md'),
        'freshness_window_minutes': int(existing.get('freshness_window_minutes') or 90),
        'last_success_ts': last_success_ts,
        'previous_status': existing.get('status'),
        'error': reason[:1000],
        'stale_unknown': True,
    }
    # Preserve last-known-good snapshot and agenda on failure. The Calendar
    # lesson is "unknown, not empty"; only heartbeat moves to stale_unknown.
    atomic_write(heartbeat_path, json.dumps(heartbeat, indent=2, ensure_ascii=False) + '\n')


def changed_calendar_paths(brain_root: Path, env: dict[str, str]) -> list[str]:
    proc = run(['git', '-C', str(brain_root), 'status', '--porcelain', '--', 'sources/calendar'], cwd=None, timeout=30, env=env)
    return [line[3:].strip() for line in proc.stdout.splitlines() if line.strip()]


def commit_calendar_changes(brain_root: Path, env: dict[str, str]) -> str | None:
    paths = changed_calendar_paths(brain_root, env)
    if not paths:
        return None
    run(['git', '-C', str(brain_root), 'add', '-A', '--', 'sources/calendar'], cwd=None, timeout=60, env=env)
    staged = run(['git', '-C', str(brain_root), 'diff', '--cached', '--name-only', '--', 'sources/calendar'], cwd=None, timeout=30, env=env).stdout.splitlines()
    if not staged:
        return None
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%SZ')
    run(['git', '-C', str(brain_root), 'commit', '-m', f'Calendar sync refresh ({stamp})', '--', 'sources/calendar'], cwd=None, timeout=120, env=env)
    return run(['git', '-C', str(brain_root), 'rev-parse', '--short', 'HEAD'], cwd=None, timeout=30, env=env).stdout.strip()


def run_projection(args: argparse.Namespace, snapshot_path: Path, state_root: Path, env: dict[str, str]) -> tuple[dict[str, Any] | None, str | None, bool]:
    if args.skip_projection:
        return None, None, False
    runtime_root = args.runtime_root.expanduser().resolve()
    brain_root = args.brain_root.expanduser().resolve()
    gbrain_bin = args.gbrain_bin.expanduser().resolve()
    if not gbrain_bin.exists():
        raise FileNotFoundError(f'gbrain command wrapper not found: {gbrain_bin}')
    if args.dry_run:
        proof_root = state_root / 'projection-proof'
        run(
            [str(gbrain_bin), 'calendar-projection', 'dry-run', '--snapshot', str(snapshot_path), '--out', str(proof_root), '--allow-root', str(state_root)],
            cwd=runtime_root,
            timeout=args.projection_timeout,
            env=env,
        )
        return {'status': 'dry_run', 'proof_root': str(proof_root), 'live_gbrain_writes': 0}, None, False
    run(
        [str(gbrain_bin), 'calendar-projection', 'sync', '--snapshot', str(snapshot_path), '--source', 'default'],
        cwd=runtime_root,
        timeout=args.projection_timeout,
        env=env,
    )
    changed = changed_calendar_paths(brain_root, env)
    commit = commit_calendar_changes(brain_root, env)
    sync_ran = False
    if commit:
        run(
            [str(gbrain_bin), 'sync', '--source', 'default', '--repo', str(brain_root), '--no-embed', '--no-extract', '--no-pull', '--json', '--yes'],
            cwd=runtime_root,
            timeout=args.sync_timeout,
            env=env,
        )
        sync_ran = True
    return {'calendar_paths_changed': changed, 'calendar_change_count': len(changed)}, commit, sync_ran


def maybe_bootstrap_exporter_app(state_root: Path) -> None:
    """One-time compatibility: copy a pre-approved EventKit app if the runtime copy is absent.

    The recurring path never reads from OpenClaw after this copy; this is a cutover
    bootstrap so macOS Calendar privacy authorization is not reset mid-migration.
    """
    dest = state_root / DEFAULT_EXPORTER_APP_NAME
    if dest.exists():
        return
    legacy = Path('/Users/jarvis/.openclaw-jarvis-v2/tools/ops') / DEFAULT_EXPORTER_APP_NAME
    if legacy.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(legacy, dest, symlinks=True)


def main() -> int:
    args = parse_args()
    if args.days_ahead < 0 or args.days_back < 0:
        raise CalendarSyncError('days_ahead and --days-back must be non-negative')
    runtime_root = args.runtime_root.expanduser().resolve()
    base_state_root = args.state_root.expanduser().resolve()
    state_root = base_state_root if not args.dry_run else Path('/tmp') / f'calendar-sync-refresh-proof-{os.getpid()}'
    env = os.environ.copy()
    env.setdefault('HOME', '/Users/jarvis')
    env.setdefault('GBRAIN_HOME', '/Users/jarvis')

    if not runtime_root.exists():
        raise FileNotFoundError(f'gbrain runtime root not found: {runtime_root}')
    if not args.dry_run:
        maybe_bootstrap_exporter_app(base_state_root)

    try:
        if args.snapshot:
            source_snapshot_path = args.snapshot.expanduser().resolve()
            snapshot = sanitize_snapshot(load_snapshot(source_snapshot_path))
            live_provider_calls = 0
        else:
            with tempfile.NamedTemporaryFile('w', encoding='utf-8', delete=False, prefix='calendar-sync-candidate-', suffix='.json') as handle:
                source_snapshot_path = Path(handle.name)
            try:
                collect_eventkit_snapshot(args, source_snapshot_path, env)
                existing = None
                if (base_state_root / 'calendar.json').exists():
                    try:
                        existing = load_snapshot(base_state_root / 'calendar.json')
                    except Exception:
                        existing = None
                snapshot = sanitize_snapshot(load_snapshot(source_snapshot_path))
                validate_candidate(snapshot, existing)
                live_provider_calls = 1
            finally:
                source_snapshot_path.unlink(missing_ok=True)

        generated_at = datetime.now().isoformat(timespec='seconds')
        agenda, agenda_md, heartbeat = build_agenda(snapshot, generated_at=generated_at, state_root=state_root)
        write_runtime_state(state_root, snapshot, agenda, agenda_md, heartbeat)
        snapshot_path = state_root / 'calendar.json'
        projection, commit, sync_ran = run_projection(args, snapshot_path, state_root, env)
        result = {
            'status': 'dry_run' if args.dry_run else 'ok',
            'runtime_authority': 'gbrain-runtime/calendar-sync-refresh.py',
            'state_root': str(state_root),
            'snapshot': snapshot_metadata(snapshot),
            'live_provider_calls': live_provider_calls,
            'projection': projection,
            'commit': commit,
            'sync_ran': sync_ran,
            'source_id': 'default',
            'manager': 'gbrain-runtime/calendar-projection',
        }
        if not args.quiet:
            print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        if not args.dry_run:
            try:
                write_failure_heartbeat(base_state_root, str(exc))
            except Exception:
                pass
        raise


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f'calendar-sync-refresh failed: {exc}', file=sys.stderr)
        raise SystemExit(1)
