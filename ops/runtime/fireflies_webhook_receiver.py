#!/usr/bin/env python3
"""Fireflies webhook receiver for native GBrain ingest (re-homed to ~/.gbrain).

Public HTTPS is terminated by Cloudflare Tunnel. This local receiver validates
Fireflies' x-hub-signature HMAC header before doing any provider work. After
validation it fetches a full transcript through an explicit client interface,
renders ONE native GBrain meeting page as a DETERMINISTIC STAGING SHELL, and
submits it to GBrain via the `gbrain capture` CLI. Dry-run mode is ON by default:
instead of capturing it writes the would-be request to disk.

STAGING SHELL CONTRACT (canon: upstream's meeting-sync recipe):
  - status: captured  (NOT ingested — the completer flips it after the skill runs)
  - NO AI summaries, key points, or action items — they hallucinate framing.
  - Shell body: title + one-line deterministic-capture notice + ## Details
    (date/provider id) + ## Attendees (resolved slugs) + ### Unresolved speakers
    subsection (best-effort labels that did not resolve, so nothing is silently
    lost) + provenance line + --- + ## Transcript.
  - Frontmatter: type: meeting, date: YYYY-MM-DD, id: fireflies-<meeting_id>,
    status: captured, attendees: (resolved slugs only).
  - ONE provenance line immediately above the --- separator:
    `**Source:** Fireflies — <url> (transcript sha256: <checksum>)`.
  - Raw JSON payloads persist OUTSIDE the brain at
    ~/data/fireflies/raw/<meeting_id>.json for dead-letter recovery. Never indexed.

Audit logs contain compact metadata only: no secrets, raw payloads, or raw
transcript text.

SINCE-FLOOR: set env FIREFLIES_SINCE=YYYY-MM-DD to ignore meetings dated before
that date. Default is 2026-07-03 (cutover date). This prevents webhook replays
from double-ingesting meetings that already exist under date-title slugs without
fireflies ids. Meetings dated before the floor are ACK'd 202 (ignored) and
logged. Set FIREFLIES_SINCE=1970-01-01 to disable the floor.

RE-HOMED from /Users/jarvis/.hermes/profiles/alex/scripts/fireflies_webhook_receiver.py.
Surgical deltas only (BUILD-PLAN 2026-06-24 §2.1, decisions D1/D6):
  1. types-from-pack: page types now derive from the ACTIVE schema pack via
     brain_type_resolver (resolve_type). Fail-CLOSED where gbrain fails-open.
  2. compressed-slug probe in resolve_attendee_label: probe `gbrain get
     people/<slug>` for the dash-stripped and dashed forms before minting a new
     page (fixes the rektdiomedes class).
  3. re-home: brain root /Users/jarvis/brain; state under ~/.gbrain/meeting-state;
     secrets via ~/bin/get-secret.sh; default port 8796.
  4. artifact-contract alignment (2026-07-03): date: YYYY-MM-DD, status: captured,
     id: fireflies-<meeting_id>, --- separator before ## Transcript.
  5. one-artifact (2026-07-03): removed source-packet render+ingest; provenance
     line added to meeting page body; raw JSON persists non-indexed.
  6. pure-staging-shell (2026-07-03): removed AI summary/key-points/action-items
     sections and all rendering helpers for them; status downgraded to `captured`
     for completer handoff.
The transcript extraction is KEPT AS-IS (decision D1).
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import hmac
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol

# Immutable runtime dependencies. The production r3 bundle co-locates the
# resolver, secret helper, and gbrain binary with this receiver. Environment
# overrides remain available for isolated fixtures and deliberate operations.
SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
RUNTIME_GBRAIN_BIN = pathlib.Path(
    os.environ.get('GBRAIN_BIN', str(SCRIPT_DIR / 'gbrain'))
).expanduser().resolve()
os.environ.setdefault('GBRAIN_BIN', str(RUNTIME_GBRAIN_BIN))
RUNTIME_EXEC_PATH = os.pathsep.join((
    str(RUNTIME_GBRAIN_BIN.parent),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
))
os.environ['PATH'] = RUNTIME_EXEC_PATH
RESOLVER_DIR = pathlib.Path(
    os.environ.get('FIREFLIES_RESOLVER_DIR', str(SCRIPT_DIR))
).expanduser().resolve()
sys.path.insert(0, str(RESOLVER_DIR))
from brain_type_resolver import resolve_type  # noqa: E402

# --- CHANGE-CLASS 3 (re-home): canonical secret helper + ~/.gbrain state roots ---
GBRAIN_HOME = pathlib.Path('/Users/jarvis/.gbrain')
BRAIN_ROOT = pathlib.Path('/Users/jarvis/brain')
SECRET_HELPER = pathlib.Path(
    os.environ.get('FIREFLIES_SECRET_HELPER', str(SCRIPT_DIR / 'get-secret.sh'))
).expanduser().resolve()
RUN_LOCK_HELPER = pathlib.Path(
    os.environ.get('GBRAIN_RUN_LOCK_HELPER', str(SCRIPT_DIR / 'run-lock.py'))
).expanduser().resolve()
MEETING_STATE = GBRAIN_HOME / 'meeting-state'
DEFAULT_SECRET_FILE = GBRAIN_HOME / 'secrets' / 'fireflies_webhook_secret'
DEFAULT_AUDIT_LOG = MEETING_STATE / 'logs' / 'fireflies-webhook.jsonl'
DEFAULT_PATH = '/fireflies/webhook'
DEFAULT_DRY_RUN_DIR = MEETING_STATE / 'receipts' / 'fireflies-ingest-dry-run'
DEFAULT_DEAD_LETTER_DIR = MEETING_STATE / 'receipts' / 'fireflies-webhook-dead-letter'
DEFAULT_DREAM_TRANSCRIPTS_DIR = pathlib.Path('/Users/jarvis/data/fireflies/transcripts')  # data home, NOT the brain repo (filing standard); nothing consumes these — recovery artifacts only
DEFAULT_INGEST_URL = 'http://127.0.0.1:7317/ingest'
FIREFLIES_VIEW_BASE = 'https://app.fireflies.ai/view/'
MAX_BODY_BYTES = 1_048_576
MAX_TRANSCRIPT_BYTES = 5_000_000
# SINCE-FLOOR: ignore meetings dated before this date. Prevents webhook replays
# from double-ingesting pre-cutover meetings. Override via env FIREFLIES_SINCE.
FIREFLIES_SINCE_DEFAULT = '2026-07-03'
SUPPORTED_EVENT_TYPES = {
    'meeting.completed',
    'meeting_completed',
    'meeting.transcribed',
    'meeting.summarized',
    'transcript.completed',
    'transcript_completed',
    'transcript.ready',
    'transcript_ready',
    'transcription.completed',
    'transcription_completed',
    'transcription completed',
    'transcription.ready',
    'transcription_ready',
    'transcript ready',
    'meeting.transcription_completed',
    'meeting_transcription_completed',
}

# --- CHANGE-CLASS 1 (types-from-pack): resolve canonical types ONCE at import,
# fail CLOSED if the active pack does not author them as expected. This is the
# fail-closed point compensating gbrain's fail-open type handling. ---
MEETING_TYPE = resolve_type('meeting')
# TRANSCRIPT_TYPE removed: one-artifact standard (2026-07-03) — no packet pages.
# Raw JSON persists to ~/data/fireflies/raw/<meeting_id>.json (non-indexed).
DEFAULT_RAW_JSON_DIR = pathlib.Path('/Users/jarvis/data/fireflies/raw')


def assert_types_from_pack() -> None:
    """Startup guard: the active pack MUST author meeting->meeting, else we
    would write an unauthored type. Fatal + exit."""
    problems: list[str] = []
    if MEETING_TYPE != 'meeting':
        problems.append(f"resolve_type('meeting')={MEETING_TYPE!r} (expected 'meeting')")
    if problems:
        print(json.dumps({
            'ts': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
            'status': 'fatal',
            'reason': 'type_resolution_mismatch',
            'detail': '; '.join(problems),
        }, sort_keys=True), file=sys.stderr, flush=True)
        sys.exit(1)


class TypeResolutionError(RuntimeError):
    """Raised per-meeting when type resolution drifts at processing time.
    Causes the meeting to be skipped — never write an unauthored type."""


class FirefliesClient(Protocol):
    def fetch_transcript(self, meeting_id: str) -> dict[str, Any]:
        """Return a normalized-ish Fireflies transcript payload."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def load_secret(path: pathlib.Path) -> bytes:
    try:
        secret = path.read_text(encoding='utf-8').strip()
    except FileNotFoundError:
        raise RuntimeError(f'secret file missing: {path}')
    if not (16 <= len(secret) <= 128):
        raise RuntimeError('secret length is outside expected bounds')
    return secret.encode('utf-8')


def resolve_secret_value(item: str, field: str = 'credential') -> str:
    """Resolve a secret through the canonical helper without logging its value."""
    if not SECRET_HELPER.exists():
        return ''
    proc = subprocess.run(
        ['bash', str(SECRET_HELPER), item, field],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=15,
    )
    if proc.returncode != 0:
        return ''
    return proc.stdout.strip()


def load_hmac_secret(secret_file: pathlib.Path) -> bytes:
    """HMAC webhook secret: try get-secret.sh FIREFLIES_WEBHOOK_SECRET first,
    fall back to the re-homed secret file (D6)."""
    value = resolve_secret_value('FIREFLIES_WEBHOOK_SECRET')
    if value:
        if not (16 <= len(value) <= 128):
            raise RuntimeError('FIREFLIES_WEBHOOK_SECRET length is outside expected bounds')
        return value.encode('utf-8')
    return load_secret(secret_file)


def valid_signature(header_value: str, body: bytes, secret: bytes) -> bool:
    if not header_value:
        return False
    supplied = header_value.strip()
    expected_hex = hmac.new(secret, body, hashlib.sha256).hexdigest()
    candidates = {expected_hex, f'sha256={expected_hex}'}
    return any(hmac.compare_digest(supplied, candidate) for candidate in candidates)


def normalize_event_type(value: str) -> str:
    return re.sub(r'\s+', ' ', str(value or '').strip().lower())


def supported_event_type(event_type: str) -> bool:
    # --- REMEDIATION B3: an empty/absent eventType now fails CLOSED (returns
    # False -> 202 ignored, zero writes). An unknown non-empty type already fails
    # closed; treating empty as supported let unlabeled payloads slip through. ---
    normalized = normalize_event_type(event_type)
    return normalized in SUPPORTED_EVENT_TYPES


def append_jsonl(path: pathlib.Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n')


def write_dead_letter(dead_letter_dir: pathlib.Path, *, run_id: str, payload: dict[str, Any], error: Exception) -> str:
    dead_letter_dir.mkdir(parents=True, exist_ok=True)
    meeting_id = str(payload.get('meetingId') or payload.get('meeting_id') or 'unknown')
    path = dead_letter_dir / f"{safe_run_id(meeting_id)}-{run_id}.json"
    record = {
        'ts': utc_now(),
        'run_id': run_id,
        'meetingId': meeting_id,
        'eventType': str(payload.get('eventType') or payload.get('event') or ''),
        'error_type': type(error).__name__,
        'error': str(error)[:512],
        'payload': payload,
    }
    with path.open('w', encoding='utf-8') as handle:
        json.dump(record, handle, indent=2, sort_keys=True)
        handle.write('\n')
    return str(path)


def safe_run_id(meeting_id: str) -> str:
    keep = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '-' for ch in meeting_id)[:64]
    return f"webhook-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{keep or 'unknown'}"


def parse_bool(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def slugify(text: str, *, fallback: str = 'meeting') -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
    slug = re.sub(r'-{2,}', '-', slug)
    return (slug or fallback)[:80].strip('-') or fallback


def short_id(meeting_id: str) -> str:
    cleaned = re.sub(r'[^A-Za-z0-9]', '', meeting_id)
    return (cleaned[-8:] or hashlib.sha256(meeting_id.encode('utf-8')).hexdigest()[:8]).lower()


def yaml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return "''"
    text = str(value)
    if text == '':
        return "''"
    # Single-quote everything with doubled inner quotes. It is boring and safe.
    return "'" + text.replace("'", "''") + "'"


def normalize_datetime(value: Any) -> str:
    if value is None or value == '':
        return utc_now().replace('+00:00', 'Z')
    if isinstance(value, (int, float)):
        # Fireflies payloads have historically used milliseconds in some APIs.
        ts = value / 1000 if value > 10_000_000_000 else value
        return dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    text = str(value).strip()
    if text.endswith('Z'):
        return text
    try:
        parsed = dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    except ValueError:
        return text


def date_part(isoish: str) -> str:
    match = re.match(r'(\d{4}-\d{2}-\d{2})', isoish)
    if match:
        return match.group(1)
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d')


def first_present(mapping: dict[str, Any], keys: list[str], default: Any = None) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ''):
            return value
    return default


EMAIL_RE = re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}')
PEOPLE_DIR = pathlib.Path(os.environ.get('FIREFLIES_PEOPLE_DIR', str(BRAIN_ROOT / 'people')))


def clean_label(value: str) -> str:
    value = value.strip().strip(',')
    if ' # ' in value:
        value = value.split(' # ', 1)[0].strip()
    if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
        value = value[1:-1]
    return re.sub(r'\s+', ' ', value).strip()


def normalize_person_key(value: str) -> str:
    value = clean_label(value)
    value = re.sub(r'\s*\([^)]*\)', '', value).strip()
    return slugify(value)


def attendee_identity_keys(label: str) -> set[str]:
    label = clean_label(label)
    keys = {f'label:{label.casefold()}', f'identity:{normalize_person_key(label)}'} if label else set()
    keys.update(f'email:{email.casefold()}' for email in EMAIL_RE.findall(label))
    return {key for key in keys if not key.endswith(':')}


def split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith('---\n'):
        return '', text
    end = text.find('\n---', 4)
    if end == -1:
        return '', text
    body_start = text.find('\n', end + 4)
    if body_start == -1:
        body_start = len(text)
    return text[4:end], text[body_start + 1:]


def frontmatter_scalar(frontmatter: str, key: str) -> str | None:
    match = re.search(rf'(?m)^{re.escape(key)}:\s*(.+?)\s*$', frontmatter)
    if not match:
        return None
    return clean_label(match.group(1))


def frontmatter_list(frontmatter: str, key: str) -> list[str]:
    lines = frontmatter.splitlines()
    for i, line in enumerate(lines):
        match = re.match(rf'^{re.escape(key)}:\s*(.*)$', line)
        if not match:
            continue
        inline = match.group(1).strip()
        if inline.startswith('[') and inline.endswith(']'):
            return [clean_label(part) for part in inline[1:-1].split(',') if clean_label(part)]
        out: list[str] = []
        for child in lines[i + 1:]:
            if child and not child.startswith((' ', '\t')):
                break
            item = re.match(r'\s*-\s*(.+?)\s*$', child)
            if item:
                value = clean_label(item.group(1))
                if value:
                    out.append(value)
        return out
    return []


def add_unique(index: dict[str, str], collisions: set[str], key: str, slug: str) -> None:
    key = key.strip().lower()
    if not key or key in collisions:
        return
    existing = index.get(key)
    if existing and existing != slug:
        collisions.add(key)
        index.pop(key, None)
        return
    index[key] = slug


class PeopleIdentityIndex:
    def __init__(self) -> None:
        self.alias_emails: dict[str, str] = {}
        self.names: dict[str, str] = {}
        self.single_names: dict[str, str] = {}


def parse_people_identity_index(people_dir: pathlib.Path | None = None) -> PeopleIdentityIndex:
    # --- REMEDIATION B2: late-bind the PEOPLE_DIR default so tests can redirect
    # the module-level PEOPLE_DIR via setattr; an import-time default arg would
    # capture the original and defeat the fixture redirect. ---
    if people_dir is None:
        people_dir = PEOPLE_DIR
    index = PeopleIdentityIndex()
    alias_email_collisions: set[str] = set()
    name_collisions: set[str] = set()
    single_name_collisions: set[str] = set()
    for path in sorted(people_dir.glob('*.md')):
        if path.name.lower() == 'readme.md':
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        frontmatter, _body = split_frontmatter(text)
        slug = f'people/{path.stem}'
        title = frontmatter_scalar(frontmatter, 'title') or path.stem.replace('-', ' ')
        aliases = frontmatter_list(frontmatter, 'aliases')
        labels = [title, path.stem, path.stem.replace('-', ' '), *aliases]
        for label in labels:
            if not label:
                continue
            add_unique(index.names, name_collisions, normalize_person_key(label), slug)
        for label in (title, path.stem.replace('-', ' ')):
            key = normalize_person_key(label)
            if key and '-' not in key:
                add_unique(index.single_names, single_name_collisions, key, slug)
        for alias in aliases:
            for email in EMAIL_RE.findall(alias):
                add_unique(index.alias_emails, alias_email_collisions, email.lower(), slug)
    return index


def extract_attendee_labels(item: Any) -> list[str]:
    if isinstance(item, str):
        return [item.strip()] if item.strip() else []
    if isinstance(item, dict):
        labels: list[str] = []
        for key in ('email', 'user_email'):
            value = clean_label(str(item.get(key) or ''))
            if value:
                labels.append(value)
        for key in ('name', 'displayName', 'display_name'):
            value = clean_label(str(item.get(key) or ''))
            if value and value not in labels:
                labels.append(value)
        return labels
    return []


GENERIC_SPEAKER_RE = re.compile(r'^(?:speaker|participant|attendee|guest|user)\s*(?:[#-]?\s*[0-9]+)?$', re.I)
NON_PERSON_SPEAKER_LABELS = {
    'ai notetaker',
    'bot',
    'fireflies',
    'fireflies ai',
    'fireflies.ai',
    'note taker',
    'notetaker',
    'recorder',
    'unknown',
}


def probable_person_speaker_label(label: str) -> bool:
    label = clean_label(label)
    if not label:
        return False
    folded = re.sub(r'\s+', ' ', label.casefold())
    if folded in NON_PERSON_SPEAKER_LABELS or 'fireflies' in folded:
        return False
    if GENERIC_SPEAKER_RE.fullmatch(label):
        return False
    return True


def extract_speaker_labels(item: dict[str, Any]) -> list[str]:
    value = first_present(item, ['speaker_name', 'speaker', 'name', 'user_name', 'displayName', 'display_name'])
    if isinstance(value, dict):
        return extract_attendee_labels(value)
    if value not in (None, ''):
        return [str(value).strip()]
    return []


def extract_speaker_attendee_candidates(transcript: dict[str, Any]) -> list[str]:
    raw = first_present(transcript, ['sentences', 'transcript', 'utterances', 'segments'], [])
    if not isinstance(raw, list):
        return []
    speakers: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        for label in extract_speaker_labels(item):
            speaker = clean_label(label)
            key = speaker.casefold()
            if probable_person_speaker_label(speaker) and key not in seen:
                seen.add(key)
                speakers.append(speaker)
    return speakers


def extract_attendee_candidates(webhook_payload: dict[str, Any], transcript: dict[str, Any]) -> list[str]:
    attendees: list[str] = extract_speaker_attendee_candidates(transcript)
    organizer_labels: list[str] = []
    seen_organizer: set[str] = set()
    for source in (webhook_payload, transcript):
        organizer = first_present(source, ['organizer', 'host', 'owner', 'organizer_email'])
        if organizer:
            labels = extract_attendee_labels(organizer) if isinstance(organizer, dict) else [str(organizer).strip()]
            for label in labels:
                label = clean_label(label)
                key = label.casefold()
                if label and key not in seen_organizer:
                    seen_organizer.add(key)
                    organizer_labels.append(label)
        for key in ('attendees', 'meeting_attendees', 'participants', 'users', 'fireflies_users'):
            raw = source.get(key)
            if isinstance(raw, list):
                for item in raw:
                    attendees.extend(extract_attendee_labels(item))
    organizer_label = next((label for label in organizer_labels if EMAIL_RE.search(label)), organizer_labels[0] if organizer_labels else '')
    if organizer_label:
        attendees.append(organizer_label)
    organizer_identity_keys = set().union(*(attendee_identity_keys(label) for label in organizer_labels)) if organizer_labels else set()
    seen: set[str] = set()
    unique: list[str] = []
    for attendee in attendees:
        attendee = clean_label(attendee)
        key = attendee.casefold()
        if organizer_identity_keys and key != organizer_label.casefold() and attendee_identity_keys(attendee) & organizer_identity_keys:
            continue
        if attendee and key not in seen:
            seen.add(key)
            unique.append(attendee)
    return unique


# --- CHANGE-CLASS 2 (compressed-slug probe) helper ---
# `gbrain get <slug>` returns exit 0 even when the page is missing (it prints an
# `Error [page_not_found]` line). So a hit is detected by stdout that begins with
# frontmatter (`---`) and does NOT contain the page_not_found marker.
def _gbrain_page_exists(slug: str) -> bool:
    gbrain_bin = os.environ.get('GBRAIN_BIN', str(RUNTIME_GBRAIN_BIN))
    try:
        proc = subprocess.run(
            [gbrain_bin, 'get', slug],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            # Verified-correct GBRAIN_HOME handling: never set it to ~/.gbrain
            # (double-nests → wrong pack). Leave inherited env as-is.
            # GBRAIN_DISABLE_DIRECT_POOL=1 matches brain_type_resolver.py: on an
            # IPv6-only direct-pool host a plain `gbrain get` getaddrinfo-fails →
            # probe returns False → re-mints the compressed-slug bug silently.
            env={**os.environ, 'GBRAIN_DISABLE_DIRECT_POOL': '1', 'PATH': RUNTIME_EXEC_PATH},
        )
    except Exception:
        return False
    out = (proc.stdout or '')
    combined = out + (proc.stderr or '')
    if 'page_not_found' in combined or 'Page not found' in combined:
        return False
    return out.lstrip().startswith('---')


def probe_compressed_person_slug(label: str) -> str | None:
    """After name/email/single-token lookups MISS, probe the brain for an
    existing person page under the dash-stripped (compressed) and dashed slug
    forms before we let a new page be minted. Fixes the rektdiomedes class:
    `Rekt Diomedes` must resolve to people/rektdiomedes, never mint
    people/rekt-diomedes."""
    base = normalize_person_key(label)  # e.g. 'rekt-diomedes'
    if not base:
        return None
    compressed = base.replace('-', '')  # e.g. 'rektdiomedes'
    candidates: list[str] = []
    for cand in (compressed, base):
        if cand and cand not in candidates:
            candidates.append(cand)
    for cand in candidates:
        slug = f'people/{cand}'
        if _gbrain_page_exists(slug):
            return slug
    return None


def resolve_attendee_label(label: str, index: PeopleIdentityIndex) -> str | None:
    label = clean_label(label)
    if not label:
        return None
    if '@' in label:
        emails = EMAIL_RE.findall(label)
        for email in emails:
            hit = index.alias_emails.get(email.lower())
            if hit:
                return hit
        return None
    candidates = [label, re.sub(r'\bTailored\b', '', label, flags=re.I).strip(), re.sub(r'^\bVirtual\b\s+', '', label, flags=re.I).strip()]
    for candidate in candidates:
        key = normalize_person_key(candidate)
        hit = index.names.get(key)
        if hit:
            return hit
    raw_tokens = [token for token in re.split(r'[^a-z0-9]+', label.lower()) if token]
    hits = {(token, hit) for token in raw_tokens if (hit := index.single_names.get(token))}
    if len(hits) == 1:
        return next(iter(hits))[1]
    # --- CHANGE-CLASS 2 (compressed-slug probe): last resort before minting ---
    probed = probe_compressed_person_slug(label)
    if probed:
        return probed
    return None


def resolve_attendees(raw_attendees: list[str], index: PeopleIdentityIndex | None = None) -> tuple[list[str], list[str]]:
    index = index or parse_people_identity_index()
    resolved: list[str] = []
    unresolved: list[str] = []
    seen_resolved: set[str] = set()
    seen_unresolved: set[str] = set()
    resolved_identity_keys: set[str] = set()
    prepared: list[tuple[str, str | None, set[str]]] = []
    # Email aliases are strongest identity evidence, so try email-like candidates first.
    for raw in sorted(raw_attendees, key=lambda value: 0 if '@' in value else 1):
        raw = clean_label(raw)
        if not raw:
            continue
        identity_keys = attendee_identity_keys(raw)
        slug = resolve_attendee_label(raw, index)
        prepared.append((raw, slug, identity_keys))
        if slug:
            resolved_identity_keys.update(identity_keys)
            resolved_identity_keys.add(f'slug:{slug.casefold()}')
    for raw, slug, identity_keys in prepared:
        if slug:
            if slug not in seen_resolved:
                seen_resolved.add(slug)
                resolved.append(slug)
        else:
            key = raw.casefold()
            if identity_keys & resolved_identity_keys:
                continue
            if key not in seen_unresolved:
                seen_unresolved.add(key)
                unresolved.append(raw)
    return resolved, unresolved


def extract_transcript_lines(transcript: dict[str, Any]) -> list[str]:
    raw = first_present(transcript, ['sentences', 'transcript', 'utterances', 'segments'], [])
    lines: list[str] = []
    if isinstance(raw, str):
        return [line.rstrip() for line in raw.splitlines() if line.strip()]
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                if item.strip():
                    lines.append(item.strip())
                continue
            if not isinstance(item, dict):
                continue
            speaker = first_present(item, ['speaker_name', 'speaker', 'name', 'user_name'], 'Unknown')
            text = first_present(item, ['text', 'sentence', 'content', 'message'], '')
            start = first_present(item, ['start_time', 'startTime', 'start', 'time'], '')
            text_s = str(text).strip()
            if not text_s:
                continue
            prefix = f'[{start}] ' if start not in (None, '') else ''
            lines.append(f'{prefix}{speaker}: {text_s}')
    return lines


def render_frontmatter(metadata: dict[str, Any], attendees: list[str], attendees_raw: list[str]) -> str:
    """Lean frontmatter per the staging-shell contract: type, date, id (dedup),
    status: captured (completer flips to ingested), attendees (resolved slugs only).
    No packet-page references, no redundant fields, no AI-generated content."""
    lines = [
        '---',
        f'type: {MEETING_TYPE}',
        f"date: {yaml_scalar(date_part(metadata['date_recorded']))}",
        f"id: {yaml_scalar('fireflies-' + metadata['meeting_id'])}",
        'status: captured',
        'attendees:',
    ]
    if attendees:
        lines.extend(f'  - {yaml_scalar(attendee)}' for attendee in attendees)
    else:
        lines.append('  []')
    lines.append('---')
    return '\n'.join(lines)


def render_meeting_markdown(webhook_payload: dict[str, Any], transcript: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Render a DETERMINISTIC STAGING SHELL — no AI summaries, no key points, no action
    items. Those sections hallucinate framing. The shell carries only what the webhook +
    transcript deterministically provide: title, date, provider id, best-effort attendee
    resolution, unresolved speakers (so nothing is silently lost), provenance, and the
    raw diarized transcript. The completer (meeting-complete.py) runs the meeting-ingestion
    skill over this shell to produce the analysis layer."""
    meeting_id = str(first_present(transcript, ['id', 'meetingId', 'meeting_id'], webhook_payload.get('meetingId') or webhook_payload.get('meeting_id'))).strip()
    if not meeting_id:
        raise ValueError('missing transcript id')
    title = str(first_present(transcript, ['title', 'meeting_title', 'name'], webhook_payload.get('title') or 'Untitled Meeting')).strip()
    date_recorded = normalize_datetime(first_present(transcript, ['date', 'dateString', 'date_recorded', 'started_at', 'start_time'], webhook_payload.get('date') or webhook_payload.get('createdAt')))
    created = normalize_datetime(first_present(webhook_payload, ['createdAt', 'created_at', 'timestamp'], first_present(transcript, ['created_at', 'createdAt', 'updated_at'], date_recorded)))
    raw_attendees = extract_attendee_candidates(webhook_payload, transcript)
    attendees, unresolved_attendees = resolve_attendees(raw_attendees)
    transcript_lines = extract_transcript_lines(transcript)
    meeting_type = str(first_present(transcript, ['meeting_type', 'type'], webhook_payload.get('meetingType') or 'meeting')).strip() or 'meeting'
    source_uri = str(first_present(transcript, ['url', 'fireflies_url', 'transcript_url', 'meeting_link', 'meeting_url'], f'{FIREFLIES_VIEW_BASE}{meeting_id}'))
    slug = f"meetings/{date_part(date_recorded)}-{slugify(title)}-ff-{short_id(meeting_id)}"
    metadata = {
        'meeting_id': meeting_id,
        'title': title,
        'date_recorded': date_recorded,
        'created': created,
        'meeting_type': meeting_type,
        'source_uri': source_uri,
        'slug': slug,
    }
    # Compute transcript checksum for the provenance line.
    transcript_text = '\n'.join(transcript_lines)
    transcript_checksum = sha256_text(transcript_text)
    attendees_raw = unresolved_attendees
    frontmatter = render_frontmatter(metadata, attendees, attendees_raw)

    # --- STAGING SHELL BODY CONTRACT ---
    # title + deterministic-capture notice + ## Details + ## Attendees
    # (with ### Unresolved speakers subsection) + provenance + --- + ## Transcript.
    # NO AI-generated sections (Summary / Key Points / Action Items).
    body: list[str] = [
        frontmatter,
        '',
        f'# {title}',
        '',
        '> Captured by the GBrain Fireflies webhook receiver. This is a deterministic staging shell — no AI-generated summaries or analysis. The meeting-ingestion skill runs next to produce the analysis layer.',
        '',
        '## Details',
        f'- Date: {date_part(date_recorded)}',
        f'- Provider ID: `{meeting_id}`',
        '',
        '## Attendees',
    ]
    if attendees:
        body.extend(f'- {attendee}' for attendee in attendees)
    else:
        body.append('- (none resolved)')
    if unresolved_attendees:
        body.extend([
            '',
            '### Unresolved speakers',
            '> The following speaker labels were extracted from the transcript but could not be resolved to a brain people page. The completer skill will resolve or create them.',
        ])
        body.extend(f'- {label}' for label in unresolved_attendees)
    body.extend([
        '',
        # ONE provenance line — placed immediately above the transcript separator.
        f'**Source:** Fireflies — {source_uri} (transcript sha256: {transcript_checksum})',
        '',
        '---',
        '',
        '## Transcript',
    ])
    body.extend(transcript_lines or ['No transcript lines supplied.'])
    body.append('')
    return '\n'.join(body), metadata | {'attendees': attendees, 'attendees_raw': attendees_raw, 'unresolved_attendees': unresolved_attendees, 'raw_attendees': raw_attendees, 'transcript_line_count': len(transcript_lines)}


def persist_raw_json(meeting_id: str, raw_payload: dict[str, Any], transcript: dict[str, Any], raw_json_dir: pathlib.Path) -> str:
    """Persist the raw Fireflies JSON payload to a non-indexed location for
    dead-letter recovery. Never writes inside the brain repo.
    Returns the path written."""
    raw_json_dir.mkdir(parents=True, exist_ok=True)
    path = raw_json_dir / f'{meeting_id}.json'
    record = {
        'meeting_id': meeting_id,
        'persisted_at': utc_now(),
        'webhook_payload': raw_payload,
        'transcript': transcript,
    }
    with path.open('w', encoding='utf-8') as handle:
        json.dump(record, handle, indent=2, sort_keys=True)
        handle.write('\n')
    return str(path)


def load_json_file(path: pathlib.Path) -> dict[str, Any]:
    if path.stat().st_size > MAX_TRANSCRIPT_BYTES:
        raise RuntimeError(f'fixture too large: {path}')
    with path.open('r', encoding='utf-8') as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError(f'fixture must be a JSON object: {path}')
    return data


class FixtureFirefliesClient:
    def __init__(self, fixture_file: pathlib.Path | None = None, fixture_dir: pathlib.Path | None = None) -> None:
        self.fixture_file = fixture_file
        self.fixture_dir = fixture_dir

    def fetch_transcript(self, meeting_id: str) -> dict[str, Any]:
        if self.fixture_file:
            data = load_json_file(self.fixture_file)
        elif self.fixture_dir:
            data = load_json_file(self.fixture_dir / f'{meeting_id}.json')
        else:
            raise RuntimeError('fixture client requires FIREFLIES_FIXTURE_TRANSCRIPT_FILE or FIREFLIES_FIXTURE_TRANSCRIPT_DIR')
        data.setdefault('id', meeting_id)
        return data


class LiveFirefliesClient:
    """Fireflies GraphQL client. Implemented for the live gate, not used in fixture tests."""

    def __init__(self, api_key: str, endpoint: str = 'https://api.fireflies.ai/graphql') -> None:
        if not api_key:
            raise RuntimeError('FIREFLIES_API_KEY is required for live Fireflies client')
        self.api_key = api_key
        self.endpoint = endpoint

    def fetch_transcript(self, meeting_id: str) -> dict[str, Any]:
        query = '''
        query Transcript($id: String!) {
          transcript(id: $id) {
            id
            title
            date
            dateString
            duration
            organizer_email
            fireflies_users
            participants
            transcript_url
            meeting_link
            meeting_attendees { displayName email name }
            summary { short_summary overview action_items keywords }
            sentences { index speaker_name text start_time end_time }
          }
        }
        '''
        body = json.dumps({'query': query, 'variables': {'id': meeting_id}}).encode('utf-8')
        req = urllib.request.Request(
            self.endpoint,
            data=body,
            headers={
                'content-type': 'application/json',
                'authorization': f'Bearer {self.api_key}',
            },
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        if data.get('errors'):
            raise RuntimeError(f"Fireflies GraphQL error: {data['errors'][0].get('message', 'unknown')}")
        transcript = (data.get('data') or {}).get('transcript')
        if not isinstance(transcript, dict):
            raise RuntimeError('Fireflies transcript not found')
        # Flatten Fireflies summary object into the renderer's simple fields.
        summary = transcript.get('summary')
        if isinstance(summary, dict):
            transcript.setdefault('short_summary', summary.get('short_summary') or summary.get('overview'))
            transcript.setdefault('action_items', summary.get('action_items') or [])
            transcript.setdefault('key_points', summary.get('keywords') or [])
        return transcript


def build_fireflies_client() -> FirefliesClient:
    mode = os.environ.get('FIREFLIES_CLIENT_MODE', 'fixture').strip().lower()
    if mode == 'live':
        api_key = os.environ.get('FIREFLIES_API_KEY', '').strip()
        if not api_key:
            api_key = resolve_secret_value('FIREFLIES_API_KEY') or resolve_secret_value('Fireflies_API_Key')
        return LiveFirefliesClient(
            api_key=api_key,
            endpoint=os.environ.get('FIREFLIES_API_URL', 'https://api.fireflies.ai/graphql'),
        )
    return FixtureFirefliesClient(
        fixture_file=pathlib.Path(os.environ['FIREFLIES_FIXTURE_TRANSCRIPT_FILE']) if os.environ.get('FIREFLIES_FIXTURE_TRANSCRIPT_FILE') else None,
        fixture_dir=pathlib.Path(os.environ['FIREFLIES_FIXTURE_TRANSCRIPT_DIR']) if os.environ.get('FIREFLIES_FIXTURE_TRANSCRIPT_DIR') else None,
    )


# --- REMEDIATION B4: ThreadingHTTPServer runs concurrent webhooks; a lockless
# read-modify-write of the index JSON loses entries. Serialize the whole
# read -> mutate -> write sequence with a module-level lock. ---
_IDEMPOTENCY_LOCK = threading.Lock()


@contextlib.contextmanager
def corpus_writer_lock(owner: str):
    """Serialize each live capture/kickstart with every other corpus writer."""
    lock_dir = pathlib.Path(
        os.environ.get(
            'GBRAIN_CORPUS_WRITER_LOCK_DIR',
            str(GBRAIN_HOME / 'locks/corpus-writer.lock'),
        )
    ).expanduser().resolve()
    token_dir = pathlib.Path(
        os.environ.get('FIREFLIES_LOCK_TOKEN_DIR', str(MEETING_STATE / 'locks'))
    ).expanduser().resolve()
    token_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(token_dir, 0o700)
    token_file = token_dir / f"corpus-writer-{os.getpid()}-{threading.get_ident()}-{time.time_ns()}.json"
    wait_seconds = os.environ.get('FIREFLIES_CORPUS_WRITER_WAIT_SECONDS', '120')
    if not RUN_LOCK_HELPER.is_file():
        raise RuntimeError(f'run lock helper missing: {RUN_LOCK_HELPER}')
    acquire = subprocess.run(
        [
            sys.executable,
            str(RUN_LOCK_HELPER),
            'acquire',
            '--lock-dir',
            str(lock_dir),
            '--token-file',
            str(token_file),
            '--owner',
            owner,
            '--owner-pid',
            str(os.getpid()),
            '--wait-seconds',
            wait_seconds,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if acquire.returncode != 0:
        raise RuntimeError(f'corpus writer lock unavailable: rc={acquire.returncode}')
    try:
        yield
    finally:
        subprocess.run(
            [
                sys.executable,
                str(RUN_LOCK_HELPER),
                'release',
                '--lock-dir',
                str(lock_dir),
                '--token-file',
                str(token_file),
                '--owner',
                owner,
                '--owner-pid',
                str(os.getpid()),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


def read_idempotency_index(path: pathlib.Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with path.open('r', encoding='utf-8') as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_idempotency_index(path: pathlib.Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w', encoding='utf-8') as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write('\n')
    tmp.replace(path)


def write_text_if_new(path: pathlib.Path, content: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding='utf-8') == content:
        return False
    path.write_text(content, encoding='utf-8')
    return True


def capture_or_send_ingest(markdown: str, metadata: dict[str, Any], *, dry_run: bool, dry_run_dir: pathlib.Path, ingest_url: str, page_type: str = MEETING_TYPE) -> dict[str, Any]:
    source_id = os.environ.get('FIREFLIES_GBRAIN_SOURCE_ID', 'default')
    headers = {
        'content-type': 'text/markdown; charset=utf-8',
        'x-gbrain-content-type': 'text/markdown',
        'x-gbrain-page-type': page_type,
        'x-gbrain-slug': metadata['slug'],
        'x-gbrain-source-id': source_id,
        'x-gbrain-source-uri': f"fireflies:{metadata['meeting_id']}",
        'user-agent': 'gbrain-fireflies-webhook/2.0',
    }
    token = os.environ.get('GBRAIN_INGEST_BEARER_TOKEN')
    if token:
        headers['authorization'] = f'Bearer {token}'
    content_hash = sha256_text(markdown)
    request_record = {
        'method': 'POST',
        'url': ingest_url,
        'headers': {key: ('Bearer <redacted>' if key == 'authorization' else value) for key, value in headers.items()},
        'body_sha256': content_hash,
        'body_bytes': len(markdown.encode('utf-8')),
        'slug': metadata['slug'],
        'page_type': page_type,
        'source_uri': f"fireflies:{metadata['meeting_id']}",
    }
    if dry_run:
        capture_path = dry_run_dir / f"{metadata['slug'].replace('/', '__')}-{content_hash[:12]}.ingest-request.json"
        capture_path.parent.mkdir(parents=True, exist_ok=True)
        with capture_path.open('w', encoding='utf-8') as handle:
            json.dump(request_record | {'body': markdown}, handle, indent=2, sort_keys=True)
            handle.write('\n')
        return {'mode': 'dry_run', 'status': 'captured', 'path': str(capture_path), 'content_hash': content_hash, 'headers': request_record['headers'], 'slug': metadata['slug'], 'page_type': page_type}

    ingest_mode = os.environ.get('FIREFLIES_GBRAIN_INGEST_MODE', 'cli').strip().lower()
    if ingest_mode == 'cli':
        gbrain_bin = os.environ.get('GBRAIN_BIN', str(RUNTIME_GBRAIN_BIN))
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', suffix='.md', delete=False) as tmp:
            tmp.write(markdown)
            tmp_path = pathlib.Path(tmp.name)
        try:
            proc = subprocess.run(
                [gbrain_bin, 'capture', '--file', str(tmp_path), '--slug', metadata['slug'], '--type', page_type, '--source', source_id, '--json'],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=90,
                env={**os.environ, 'PATH': RUNTIME_EXEC_PATH},
            )
        finally:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass
        if proc.returncode != 0:
            raise RuntimeError(f'GBrain capture failed: {(proc.stderr or proc.stdout).strip()[:512]}')
        response_excerpt = (proc.stdout or '').strip()[:512]
        return {'mode': 'cli_capture', 'status': 'ok', 'content_hash': content_hash, 'response_excerpt': response_excerpt, 'slug': metadata['slug'], 'page_type': page_type}

    req = urllib.request.Request(ingest_url, data=markdown.encode('utf-8'), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            response_body = resp.read(4096).decode('utf-8', errors='replace')
            return {'mode': 'live', 'status': f'http_{resp.status}', 'content_hash': content_hash, 'response_excerpt': response_body[:512], 'page_type': page_type}
    except urllib.error.HTTPError as exc:
        excerpt = exc.read(4096).decode('utf-8', errors='replace')
        raise RuntimeError(f'GBrain ingest failed http_{exc.code}: {excerpt[:512]}') from exc


def process_fireflies_payload(webhook_payload: dict[str, Any], *, client: FirefliesClient, dry_run: bool, dry_run_dir: pathlib.Path, transcript_dir: pathlib.Path, ingest_url: str, idempotency_index: pathlib.Path, raw_json_dir: pathlib.Path | None = None) -> dict[str, Any]:
    meeting_id = str(webhook_payload.get('meetingId') or webhook_payload.get('meeting_id') or '').strip()
    if not meeting_id:
        raise ValueError('missing_meetingId')
    # SINCE-FLOOR: skip meetings dated before cutover to prevent webhook replays
    # from double-ingesting pre-existing brain pages. Floor is env-configurable.
    since_floor = os.environ.get('FIREFLIES_SINCE', FIREFLIES_SINCE_DEFAULT).strip()
    if since_floor and since_floor != '1970-01-01':
        raw_date = str(webhook_payload.get('createdAt') or webhook_payload.get('date') or '').strip()
        if raw_date:
            meeting_date = date_part(normalize_datetime(raw_date))
            if meeting_date < since_floor:
                return {
                    'meeting_id': meeting_id,
                    'slug': None,
                    'skipped': True,
                    'reason': 'before_since_floor',
                    'meeting_date': meeting_date,
                    'since_floor': since_floor,
                }
    # --- CHANGE-CLASS 1 (fail-closed type guard): re-verify the pack still
    # authors meeting/transcript before any write. A drift here would otherwise
    # write an unauthored type — skip the meeting instead. ---
    # --- REMEDIATION B5: clear the resolver's lru_cache first so a long-lived
    # receiver actually SEES an operator mid-life pack flip; without this the
    # cached pack/maps defeat the drift re-check. Webhooks are infrequent, so the
    # extra `gbrain schema show` per payload is acceptable. ---
    try:
        import brain_type_resolver as _btr
        _btr._pack.cache_clear()
        _btr._maps.cache_clear()
    except AttributeError:
        pass
    if resolve_type('meeting') != 'meeting':
        raise TypeResolutionError(
            f"type resolution drift: meeting={resolve_type('meeting')!r} (expected 'meeting')"
        )
    transcript = client.fetch_transcript(meeting_id)
    markdown, metadata = render_meeting_markdown(webhook_payload, transcript)
    content_hash = sha256_text(markdown)
    idempotency_key = f"fireflies:{meeting_id}:{content_hash}"
    # --- REMEDIATION B4: serialize the entire read -> mutate -> write of the
    # idempotency index under a module-level lock so concurrent webhooks for
    # distinct meetings never lose each other's entries (last-writer-wins on a
    # lockless read-modify-write). ---
    raw_json_dir = raw_json_dir or DEFAULT_RAW_JSON_DIR
    with contextlib.ExitStack() as stack:
        if not dry_run:
            stack.enter_context(corpus_writer_lock(f"fireflies-{safe_run_id(meeting_id)}"))
        stack.enter_context(_IDEMPOTENCY_LOCK)
        index = read_idempotency_index(idempotency_index)
        existing = index.get(idempotency_key)
        if existing:
            return {
                'meeting_id': meeting_id,
                'slug': existing.get('slug', metadata['slug']),
                'idempotency_key': idempotency_key,
                'duplicate': True,
                'ingest': existing.get('ingest', {}),
                'raw_json_path': existing.get('raw_json_path'),
                'content_hash': content_hash,
            }

        # Persist raw JSON outside the brain for dead-letter recovery.
        raw_json_path: str | None = None
        try:
            raw_json_path = persist_raw_json(meeting_id, webhook_payload, transcript, raw_json_dir)
        except Exception as exc:
            print(json.dumps({'ts': utc_now(), 'status': 'raw_json_persist_failed', 'meeting_id': meeting_id, 'error_type': type(exc).__name__, 'error': str(exc)[:256]}, sort_keys=True, separators=(',', ':')), file=sys.stderr, flush=True)

        ingest_result = capture_or_send_ingest(markdown, metadata, dry_run=dry_run, dry_run_dir=dry_run_dir, ingest_url=ingest_url)
        record = {
            'ts': utc_now(),
            'meeting_id': meeting_id,
            'slug': metadata['slug'],
            'content_hash': content_hash,
            'ingest': ingest_result,
            'raw_json_path': raw_json_path,
        }
        index[idempotency_key] = record
        write_idempotency_index(idempotency_index, index)

        # After a successful non-dry-run capture, best-effort kickstart the
        # meeting-complete lane so completion happens promptly instead of waiting
        # for the 05:00 cron. The lane's single-flight lock makes concurrent
        # kickstarts safe; the nightly cron is the backstop if this fails.
        # RUNBOOK: launchctl kickstart gui/<uid>/com.gbrain.meeting-complete
        if not dry_run:
            try:
                import subprocess as _sp
                _uid = str(os.getuid())
                _sp.Popen(
                    ['launchctl', 'kickstart', f'gui/{_uid}/com.gbrain.meeting-complete'],
                    stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
                    close_fds=True,
                )
            except Exception as _exc:
                print(json.dumps({'ts': utc_now(), 'status': 'kickstart_failed', 'meeting_id': meeting_id, 'error': str(_exc)[:256]}, sort_keys=True, separators=(',', ':')), file=sys.stderr, flush=True)

    return record | {'idempotency_key': idempotency_key, 'duplicate': False}


def handle_fireflies_webhook_request(
    *,
    body: bytes,
    headers: Any,
    secret: bytes,
    audit_log: pathlib.Path,
    fireflies_client: FirefliesClient,
    dry_run: bool,
    dry_run_dir: pathlib.Path,
    transcript_dir: pathlib.Path,
    ingest_url: str,
    idempotency_index: pathlib.Path,
    dead_letter_dir: pathlib.Path,
    raw_json_dir: pathlib.Path | None = None,
    remote: str = '',
) -> tuple[int, dict[str, Any]]:
    signature = headers.get('x-hub-signature') or headers.get('X-Hub-Signature') or ''
    if not valid_signature(signature, body, secret):
        append_jsonl(audit_log, {
            'ts': utc_now(),
            'status': 'rejected',
            'reason': 'invalid_signature',
            'remote': remote,
        })
        return 401, {'error': 'invalid_signature'}

    try:
        payload = json.loads(body.decode('utf-8'))
    except Exception:
        return 400, {'error': 'invalid_json'}
    if not isinstance(payload, dict):
        return 400, {'error': 'invalid_json'}

    meeting_id = str(payload.get('meetingId') or payload.get('meeting_id') or '').strip()
    event_type = str(payload.get('eventType') or payload.get('event') or '').strip()
    client_reference_id = str(payload.get('clientReferenceId') or payload.get('client_reference_id') or '').strip()
    if not meeting_id:
        return 400, {'error': 'missing_meetingId'}

    run_id = safe_run_id(meeting_id)
    if not supported_event_type(event_type):
        append_jsonl(audit_log, {
            'ts': utc_now(),
            'status': 'ignored',
            'reason': 'unsupported_event_type',
            'meetingId': meeting_id,
            'eventType': event_type,
            'clientReferenceId': client_reference_id,
            'run_id': run_id,
        })
        return 202, {
            'status': 'ignored',
            'reason': 'unsupported_event_type',
            'meetingId': meeting_id,
            'run_id': run_id,
        }

    append_jsonl(audit_log, {
        'ts': utc_now(),
        'status': 'accepted',
        'meetingId': meeting_id,
        'eventType': event_type,
        'clientReferenceId': client_reference_id,
        'run_id': run_id,
    })

    try:
        result = process_fireflies_payload(
            payload,
            client=fireflies_client,
            dry_run=dry_run,
            dry_run_dir=dry_run_dir,
            transcript_dir=transcript_dir,
            ingest_url=ingest_url,
            idempotency_index=idempotency_index,
            raw_json_dir=raw_json_dir,
        )
    except TypeResolutionError as exc:
        # --- CHANGE-CLASS 1 (fail-closed): never write an unauthored type.
        # Alert + SKIP this meeting; no dead-letter retry would help (the pack
        # is the problem), so we surface it loudly and return a 503. ---
        append_jsonl(audit_log, {
            'ts': utc_now(),
            'status': 'skipped',
            'reason': 'type_resolution_miss',
            'meetingId': meeting_id,
            'eventType': event_type,
            'clientReferenceId': client_reference_id,
            'run_id': run_id,
            'error': str(exc)[:256],
        })
        print(json.dumps({'ts': utc_now(), 'status': 'type_resolution_miss', 'meetingId': meeting_id, 'error': str(exc)[:256]}, sort_keys=True), file=sys.stderr, flush=True)
        return 503, {
            'error': 'type_resolution_miss',
            'meetingId': meeting_id,
            'run_id': run_id,
        }
    except Exception as exc:
        dead_letter_path = write_dead_letter(dead_letter_dir, run_id=run_id, payload=payload, error=exc)
        append_jsonl(audit_log, {
            'ts': utc_now(),
            'status': 'failed',
            'meetingId': meeting_id,
            'eventType': event_type,
            'clientReferenceId': client_reference_id,
            'run_id': run_id,
            'error_type': type(exc).__name__,
            'dead_letter_path': dead_letter_path,
        })
        return 500, {
            'error': 'transform_failed',
            'meetingId': meeting_id,
            'run_id': run_id,
            'dead_letter': dead_letter_path,
        }

    append_jsonl(audit_log, {
        'ts': utc_now(),
        'status': 'transformed',
        'meetingId': meeting_id,
        'eventType': event_type,
        'clientReferenceId': client_reference_id,
        'run_id': run_id,
        'slug': result.get('slug'),
        'duplicate': bool(result.get('duplicate')),
        'dry_run': bool(dry_run),
        'content_hash': str(result.get('content_hash', ''))[:16],
        'raw_json_path': result.get('raw_json_path'),
    })

    # Legacy Hermes forwarding is disabled by default and intentionally gated
    # behind an explicit env flag. This path is retained only as a rollback
    # bridge; it is not part of the native P6 receiver transform.
    forward_status = 'disabled'
    if parse_bool(os.environ.get('FIREFLIES_ENABLE_HERMES_FORWARD'), default=False):
        forward_url = os.environ.get('FIREFLIES_HERMES_FORWARD_URL', '')
        if forward_url:
            try:
                forward_payload = dict(payload)
                forward_payload.setdefault('meetingId', meeting_id)
                forward_payload.setdefault('eventType', event_type)
                forward_payload.setdefault('clientReferenceId', client_reference_id)
                forward_body = json.dumps(forward_payload, separators=(',', ':')).encode('utf-8')
                req = urllib.request.Request(forward_url, data=forward_body, headers={'content-type': 'application/json'}, method='POST')
                with urllib.request.urlopen(req, timeout=10) as resp:
                    forward_status = f'http_{resp.status}'
            except Exception as exc:
                forward_status = f'failed:{type(exc).__name__}'
            append_jsonl(audit_log, {
                'ts': utc_now(),
                'status': 'forwarded',
                'meetingId': meeting_id,
                'eventType': event_type,
                'clientReferenceId': client_reference_id,
                'run_id': run_id,
                'forward_status': forward_status,
            })

    return 202, {
        'status': 'accepted',
        'meetingId': meeting_id,
        'run_id': run_id,
        'slug': result.get('slug'),
        'duplicate': bool(result.get('duplicate')),
        'ingest_mode': (result.get('ingest') or {}).get('mode'),
        'raw_json_path': result.get('raw_json_path'),
        'forward': forward_status,
    }


class FirefliesHandler(BaseHTTPRequestHandler):
    server_version = 'GBrainFirefliesWebhook/2.0'

    def log_message(self, fmt: str, *args: Any) -> None:  # keep launchd stderr clean
        return

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, sort_keys=True).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == '/health':
            self._json(200, {'status': 'ok', 'service': 'fireflies-webhook'})
        else:
            self._json(404, {'error': 'not_found'})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split('?', 1)[0] != self.server.webhook_path:  # type: ignore[attr-defined]
            self._json(404, {'error': 'not_found'})
            return

        try:
            content_length = int(self.headers.get('Content-Length') or '0')
        except ValueError:
            self._json(400, {'error': 'bad_content_length'})
            return
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._json(413, {'error': 'bad_body_size'})
            return

        body = self.rfile.read(content_length)
        status, payload = handle_fireflies_webhook_request(
            body=body,
            headers=self.headers,
            secret=self.server.secret,  # type: ignore[attr-defined]
            audit_log=self.server.audit_log,  # type: ignore[attr-defined]
            fireflies_client=self.server.fireflies_client,  # type: ignore[attr-defined]
            dry_run=self.server.dry_run,  # type: ignore[attr-defined]
            dry_run_dir=self.server.dry_run_dir,  # type: ignore[attr-defined]
            transcript_dir=self.server.transcript_dir,  # type: ignore[attr-defined]
            ingest_url=self.server.ingest_url,  # type: ignore[attr-defined]
            idempotency_index=self.server.idempotency_index,  # type: ignore[attr-defined]
            dead_letter_dir=self.server.dead_letter_dir,  # type: ignore[attr-defined]
            raw_json_dir=self.server.raw_json_dir,  # type: ignore[attr-defined]
            remote=self.client_address[0],
        )
        self._json(status, payload)


def main() -> int:
    # --- CHANGE-CLASS 1 (types-from-pack): fail closed at startup if the active
    # pack does not author meeting->meeting. ---
    assert_types_from_pack()

    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default=os.environ.get('FIREFLIES_WEBHOOK_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('FIREFLIES_WEBHOOK_PORT', '8796')))
    parser.add_argument('--path', default=os.environ.get('FIREFLIES_WEBHOOK_PATH', DEFAULT_PATH))
    parser.add_argument('--secret-file', type=pathlib.Path, default=pathlib.Path(os.environ.get('FIREFLIES_WEBHOOK_SECRET_FILE', str(DEFAULT_SECRET_FILE))))
    parser.add_argument('--audit-log', type=pathlib.Path, default=pathlib.Path(os.environ.get('FIREFLIES_WEBHOOK_AUDIT_LOG', str(DEFAULT_AUDIT_LOG))))
    parser.add_argument('--dry-run', action=argparse.BooleanOptionalAction, default=parse_bool(os.environ.get('FIREFLIES_DRY_RUN'), default=True))
    parser.add_argument('--dry-run-dir', type=pathlib.Path, default=pathlib.Path(os.environ.get('FIREFLIES_DRY_RUN_DIR', str(DEFAULT_DRY_RUN_DIR))))
    parser.add_argument('--dead-letter-dir', type=pathlib.Path, default=pathlib.Path(os.environ.get('FIREFLIES_DEAD_LETTER_DIR', str(DEFAULT_DEAD_LETTER_DIR))))
    parser.add_argument('--transcript-dir', type=pathlib.Path, default=pathlib.Path(os.environ.get('FIREFLIES_TRANSCRIPT_DIR', str(DEFAULT_DREAM_TRANSCRIPTS_DIR))))
    parser.add_argument('--raw-json-dir', type=pathlib.Path, default=pathlib.Path(os.environ.get('FIREFLIES_RAW_JSON_DIR', str(DEFAULT_RAW_JSON_DIR))))
    parser.add_argument('--ingest-url', default=os.environ.get('GBRAIN_INGEST_URL', DEFAULT_INGEST_URL))
    parser.add_argument('--idempotency-index', type=pathlib.Path, default=pathlib.Path(os.environ.get('FIREFLIES_IDEMPOTENCY_INDEX', str(MEETING_STATE / 'idempotency-index.json'))))
    args = parser.parse_args()

    secret = load_hmac_secret(args.secret_file)
    httpd = ThreadingHTTPServer((args.host, args.port), FirefliesHandler)
    httpd.secret = secret  # type: ignore[attr-defined]
    httpd.webhook_path = args.path  # type: ignore[attr-defined]
    httpd.audit_log = args.audit_log  # type: ignore[attr-defined]

    httpd.fireflies_client = build_fireflies_client()  # type: ignore[attr-defined]
    httpd.dry_run = args.dry_run  # type: ignore[attr-defined]
    httpd.dry_run_dir = args.dry_run_dir  # type: ignore[attr-defined]
    httpd.dead_letter_dir = args.dead_letter_dir  # type: ignore[attr-defined]
    httpd.transcript_dir = args.transcript_dir  # type: ignore[attr-defined]
    httpd.raw_json_dir = args.raw_json_dir  # type: ignore[attr-defined]
    httpd.ingest_url = args.ingest_url  # type: ignore[attr-defined]
    httpd.idempotency_index = args.idempotency_index  # type: ignore[attr-defined]
    print(json.dumps({'status': 'listening', 'host': args.host, 'port': args.port, 'path': args.path, 'dry_run': args.dry_run}), flush=True)
    httpd.serve_forever(poll_interval=0.5)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f'fireflies-webhook fatal: {exc}', file=sys.stderr, flush=True)
        raise
