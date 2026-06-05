#!/usr/bin/env python3
"""Calendar Projection wrapper.

Projection-only compatibility boundary:
collector snapshot -> gbrain-runtime Calendar Projection -> exact calendar commit -> no-embed/no-extract sync.

Full Calendar sync/collection is owned by scripts/calendar-sync-refresh.py. This
wrapper remains useful for explicit snapshot replay and projection tests.

This wrapper intentionally logs only counts, paths, and commit ids; it never prints
raw event bodies or rendered markdown.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_RUNTIME_ROOT = Path('/Users/jarvis/gbrain-runtime')
DEFAULT_BRAIN_ROOT = Path('/Users/jarvis/gbrain/main')
DEFAULT_SNAPSHOT = Path('/Users/jarvis/gbrain-runtime/var/calendar/calendar.json')
DEFAULT_GBRAIN = Path('/Users/jarvis/.local/bin/gbrain')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Project macOS Calendar collector snapshots through GBrain runtime.')
    parser.add_argument('--snapshot', type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument('--runtime-root', type=Path, default=Path(os.environ.get('GBRAIN_RUNTIME_ROOT', DEFAULT_RUNTIME_ROOT)))
    parser.add_argument('--brain-root', type=Path, default=Path(os.environ.get('GBRAIN_DEFAULT_SOURCE_ROOT', DEFAULT_BRAIN_ROOT)))
    parser.add_argument('--gbrain-bin', type=Path, default=Path(os.environ.get('GBRAIN_BIN') or os.environ.get('GBRAIN_BIN_WRAPPER', DEFAULT_GBRAIN)))
    parser.add_argument('--projection-timeout', type=int, default=int(os.environ.get('CALENDAR_PROJECTION_TIMEOUT_SECONDS', '120')))
    parser.add_argument('--sync-timeout', type=int, default=int(os.environ.get('CALENDAR_PROJECTION_SYNC_TIMEOUT_SECONDS', '300')))
    parser.add_argument('--dry-run', action='store_true', help='Render projection to a temp proof root; do not write Brain DB/repo.')
    parser.add_argument('--quiet', action='store_true')
    return parser.parse_args()


def run(cmd: list[str], *, cwd: Path | None, timeout: int, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, text=True, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or '').strip()
        raise RuntimeError(f'command failed ({cmd[0]} {cmd[1] if len(cmd) > 1 else ""}, exit={proc.returncode}): {detail[:1000]}')
    return proc


def load_snapshot_metadata(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f'calendar snapshot not found: {path}')
    data = json.loads(path.read_text(encoding='utf-8'))
    events = data.get('events')
    if not isinstance(events, list):
        raise RuntimeError('calendar snapshot has no events[] list')
    return {
        'synced_at': data.get('synced_at'),
        'source': data.get('source'),
        'source_method': data.get('source_method'),
        'calendar_count': data.get('calendar_count'),
        'event_count': data.get('event_count', len(events)),
        'events_len': len(events),
        'days_back': data.get('days_back'),
        'days_ahead': data.get('days_ahead'),
    }


def changed_calendar_paths(brain_root: Path, env: dict[str, str]) -> list[str]:
    proc = run(
        ['git', '-C', str(brain_root), 'status', '--porcelain', '--', 'sources/calendar'],
        cwd=None,
        timeout=30,
        env=env,
    )
    paths: list[str] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        # Porcelain format: XY path; rename includes "old -> new". Calendar projection does not rename.
        paths.append(line[3:].strip())
    return paths


def commit_calendar_changes(brain_root: Path, env: dict[str, str]) -> str | None:
    paths = changed_calendar_paths(brain_root, env)
    if not paths:
        return None
    run(['git', '-C', str(brain_root), 'add', '-A', '--', 'sources/calendar'], cwd=None, timeout=60, env=env)
    staged = run(
        ['git', '-C', str(brain_root), 'diff', '--cached', '--name-only', '--', 'sources/calendar'],
        cwd=None,
        timeout=30,
        env=env,
    ).stdout.splitlines()
    if not staged:
        return None
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%SZ')
    run(
        ['git', '-C', str(brain_root), 'commit', '-m', f'Calendar projection refresh ({stamp})', '--', 'sources/calendar'],
        cwd=None,
        timeout=120,
        env=env,
    )
    return run(['git', '-C', str(brain_root), 'rev-parse', '--short', 'HEAD'], cwd=None, timeout=30, env=env).stdout.strip()


def main() -> int:
    args = parse_args()
    runtime_root = args.runtime_root.expanduser().resolve()
    brain_root = args.brain_root.expanduser().resolve()
    snapshot = args.snapshot.expanduser().resolve()
    gbrain_bin = args.gbrain_bin.expanduser().resolve()
    metadata = load_snapshot_metadata(snapshot)
    env = os.environ.copy()
    env.setdefault('HOME', '/Users/jarvis')
    env.setdefault('GBRAIN_HOME', '/Users/jarvis')

    cli = runtime_root / 'src' / 'cli.ts'
    if not cli.exists():
        raise FileNotFoundError(f'gbrain runtime CLI not found: {cli}')
    if not gbrain_bin.exists():
        raise FileNotFoundError(f'gbrain command not found: {gbrain_bin}')
    if not brain_root.exists():
        raise FileNotFoundError(f'gbrain source root not found: {brain_root}')
    if args.dry_run:
        proof_root = Path('/tmp') / f'calendar-projection-refresh-proof-{os.getpid()}'
        run(
            [str(gbrain_bin), 'calendar-projection', 'dry-run', '--snapshot', str(snapshot), '--out', str(proof_root), '--allow-root', '/tmp'],
            cwd=runtime_root,
            timeout=args.projection_timeout,
            env=env,
        )
        result = {
            'status': 'dry_run',
            'snapshot': metadata,
            'proof_root': str(proof_root),
            'live_gbrain_writes': 0,
        }
        if not args.quiet:
            print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    run(
        [str(gbrain_bin), 'calendar-projection', 'sync', '--snapshot', str(snapshot), '--source', 'default'],
        cwd=runtime_root,
        timeout=args.projection_timeout,
        env=env,
    )
    changed = changed_calendar_paths(brain_root, env)
    commit = commit_calendar_changes(brain_root, env)
    sync_ran = False
    if commit:
        run(
            [
                str(gbrain_bin), 'sync', '--source', 'default', '--repo', str(brain_root),
                '--no-embed', '--no-extract', '--no-pull', '--json', '--yes',
            ],
            cwd=runtime_root,
            timeout=args.sync_timeout,
            env=env,
        )
        sync_ran = True
    result = {
        'status': 'ok',
        'snapshot': metadata,
        'calendar_paths_changed': changed,
        'calendar_change_count': len(changed),
        'commit': commit,
        'sync_ran': sync_ran,
        'source_id': 'default',
        'runtime_authority': 'gbrain_brainengine',
        'manager': 'gbrain-runtime/calendar-projection',
    }
    if not args.quiet:
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
