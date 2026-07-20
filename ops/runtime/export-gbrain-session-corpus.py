#!/usr/bin/env python3
"""Export user-facing Hermes session transcripts for GBrain dream synthesis."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


PROFILES = ("alex", "bestie", "seksi")
HERMES_PROFILES_ROOT = Path("/Users/jarvis/.hermes/profiles")
USER_FACING_PLATFORMS = {"telegram", "whatsapp"}
CLI_PLATFORMS = {"cli", "tui"}
ALWAYS_EXCLUDED_PLATFORMS = {"cron"}
LOCAL_TZ = ZoneInfo("Asia/Bangkok")
SOURCE_NAMESPACE = "hermes"
EXPORTER_OWNER = "gbrain:hermes-session-export"
IDENTITY_VERSION = 1
SECRET_LINE_RE = re.compile(
    r"(api[_-]?key|token|secret|password|credential|authorization:|bearer |sk-|xoxb-|ghp_|BEGIN .*PRIVATE KEY)",
    re.IGNORECASE,
)
SPLIT_THRESHOLD_CHARS = 600_000  # 2026-07-02: was 35_000 (predates native gbrain chunking); whole-session synthesis kills cross-part near-dup pages. gbrain chunks internally at ~630K chars.
MIN_SPLIT_PART_CHARS = 2_000



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Hermes SQLite session transcripts as deterministic Markdown corpus files."
    )
    parser.add_argument(
        "--corpus-dir",
        default="./test-corpus/sessions",
        help="Corpus root. Default: ./test-corpus/sessions",
    )
    parser.add_argument(
        "--date",
        default=None,
        help="Closed Bangkok date to export as YYYY-MM-DD, 'today', or 'yesterday'. Default: yesterday.",
    )
    parser.add_argument(
        "--profile",
        action="append",
        choices=PROFILES,
        help="Profile to export. Repeatable. Default: alex, bestie, seksi.",
    )
    parser.add_argument(
        "--include-cli",
        action="store_true",
        help="Also export cli/tui sessions. cron remains excluded.",
    )
    parser.add_argument(
        "--scheduled",
        action="store_true",
        help="Fail closed unless exactly yesterday Bangkok is selected.",
    )
    parser.add_argument(
        "--profiles-root",
        default=os.environ.get("GBRAIN_HERMES_PROFILES_ROOT", str(HERMES_PROFILES_ROOT)),
        help="Hermes profiles root (fixture override supported).",
    )
    parser.add_argument(
        "--summary-file",
        default=None,
        help="Atomically write a mode-0600 machine-readable run summary.",
    )
    parser.add_argument(
        "--now",
        default=os.environ.get("GBRAIN_EXPORT_NOW"),
        help=argparse.SUPPRESS,
    )
    return parser.parse_args()


def local_now(value: str | None = None) -> dt.datetime:
    if value:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=LOCAL_TZ)
        return parsed.astimezone(LOCAL_TZ)
    return dt.datetime.now(LOCAL_TZ)


def requested_dates(value: str | None, now: dt.datetime) -> list[dt.date]:
    today = now.date()
    if value is None:
        return [today - dt.timedelta(days=1)]
    lowered = value.lower()
    if lowered == "today":
        return [today]
    if lowered == "yesterday":
        return [today - dt.timedelta(days=1)]
    return [dt.date.fromisoformat(value)]


def local_day_start(value: dt.date) -> dt.datetime:
    return dt.datetime.combine(value, dt.time.min, tzinfo=LOCAL_TZ)


def epoch_to_local_iso(value: float | int | None) -> str | None:
    if value is None:
        return None
    return dt.datetime.fromtimestamp(float(value), LOCAL_TZ).isoformat()


def redacted_lines(text: str) -> tuple[list[str], int]:
    output: list[str] = []
    redactions = 0
    for line in text.splitlines() or [""]:
        if SECRET_LINE_RE.search(line):
            output.append("[REDACTED: possible secret line]")
            redactions += 1
        else:
            output.append(line.rstrip())
    return output, redactions


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    text = str(value)
    return json.dumps(text, ensure_ascii=False)


def read_only_state_connection(profiles_root: Path, profile: str) -> sqlite3.Connection:
    db_path = profiles_root / profile / "state.db"
    uri = f"{db_path.as_uri()}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def stable_identity(*parts: Any) -> str:
    payload = "\0".join(str(part) for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def atomic_write_secure(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False
    ) as handle:
        tmp_name = handle.name
        os.chmod(tmp_name, 0o600)
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_name, path)
    os.chmod(path, 0o600)


def parse_frontmatter_document(text: str) -> tuple[dict[str, Any], str]:
    """Parse only the canonical JSON-scalar frontmatter emitted by exporters."""
    match = re.match(r"^\ufeff?---\r?\n([\s\S]*?)\r?\n---\r?\n", text)
    if not match:
        raise ValueError("transcript is missing a bounded frontmatter block")
    metadata: dict[str, Any] = {}
    for line_number, line in enumerate(match.group(1).splitlines(), start=2):
        if not line.strip() or ":" not in line:
            raise ValueError(f"invalid frontmatter line {line_number}")
        key, raw = line.split(":", 1)
        key = key.strip()
        if not key or key in metadata:
            raise ValueError(f"duplicate or empty frontmatter key at line {line_number}")
        try:
            metadata[key] = json.loads(raw.strip())
        except json.JSONDecodeError as exc:
            raise ValueError(f"non-canonical frontmatter scalar at line {line_number}") from exc
    return metadata, text[match.end():]


def is_literal_identity_version_one(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value == IDENTITY_VERSION


def included_sources(include_cli: bool) -> set[str]:
    sources = set(USER_FACING_PLATFORMS)
    if include_cli:
        sources.update(CLI_PLATFORMS)
    return sources


def source_is_included(source: str, include_cli: bool) -> bool:
    lowered = source.lower()
    if lowered in ALWAYS_EXCLUDED_PLATFORMS:
        return False
    return lowered in included_sources(include_cli)


def render_frontmatter(frontmatter: dict[str, Any]) -> list[str]:
    rendered = ["---"]
    for key, value in frontmatter.items():
        rendered.append(f"{key}: {yaml_scalar(value)}")
    rendered.extend(["---", ""])
    return rendered


def render_document(frontmatter: dict[str, Any], session_id: str, blocks: list[str]) -> str:
    rendered = render_frontmatter(frontmatter)
    rendered.extend([f"# Hermes Session {session_id}", ""])
    rendered.extend(blocks)
    return "\n".join(rendered).rstrip() + "\n"


def block_timestamp(block: list[str]) -> str | None:
    if not block:
        return None
    match = re.match(r"^###\s+\S+\s+(.+)$", block[0])
    if not match:
        return None
    timestamp = match.group(1).strip()
    return timestamp or None


def flatten_blocks(blocks: list[list[str]]) -> list[str]:
    flattened: list[str] = []
    for block in blocks:
        flattened.extend(block)
    return flattened


def part_frontmatter(base: dict[str, Any], blocks: list[list[str]], part_number: int | None, part_total: int | None) -> dict[str, Any]:
    frontmatter = dict(base)
    timestamps = [ts for block in blocks if (ts := block_timestamp(block))]
    frontmatter["first_timestamp"] = timestamps[0] if timestamps else None
    frontmatter["last_timestamp"] = timestamps[-1] if timestamps else None
    frontmatter["message_count"] = len(blocks)
    part_index = part_number or 1
    effective_part_total = part_total or 1
    frontmatter["part_index"] = part_index
    frontmatter["part_total"] = effective_part_total
    frontmatter["logical_transcript_id"] = stable_identity(
        frontmatter["logical_session_id"], part_index
    )
    if part_number is not None and part_total is not None:
        frontmatter["part"] = f"{part_number}/{part_total}"
    return frontmatter


def rendered_part_length(base: dict[str, Any], session_id: str, blocks: list[list[str]], part_number: int | None, part_total: int | None) -> int:
    return len(render_document(part_frontmatter(base, blocks, part_number, part_total), session_id, flatten_blocks(blocks)))


def split_message_blocks(
    *,
    base_frontmatter: dict[str, Any],
    session_id: str,
    message_blocks: list[list[str]],
    threshold: int = SPLIT_THRESHOLD_CHARS,
    min_part_chars: int = MIN_SPLIT_PART_CHARS,
) -> list[list[list[str]]]:
    """Split rendered session at message boundaries.

    A single message larger than threshold remains intact; we never split inside a message.
    Tiny tail parts are merged backward so discovery-floor chunks stay useful.
    """
    if rendered_part_length(base_frontmatter, session_id, message_blocks, None, None) <= threshold:
        return [message_blocks]

    parts: list[list[list[str]]] = []
    current: list[list[str]] = []
    for block in message_blocks:
        candidate = current + [block]
        # Use a conservative 999/999 placeholder while choosing boundaries so adding final
        # part metadata cannot push ordinary parts over the target.
        if current and rendered_part_length(base_frontmatter, session_id, candidate, 999, 999) > threshold:
            parts.append(current)
            current = [block]
        else:
            current = candidate
    if current:
        parts.append(current)

    while len(parts) > 1:
        tail_len = rendered_part_length(base_frontmatter, session_id, parts[-1], len(parts), len(parts))
        if tail_len >= min_part_chars:
            break
        parts[-2].extend(parts[-1])
        parts.pop()

    return parts


def render_session(
    *,
    profile: str,
    db_path: Path,
    target_date: dt.date,
    session: dict[str, Any],
    rows: list[dict[str, Any]],
) -> tuple[list[tuple[str, dict[str, Any]]], dict[str, Any]]:
    session_id = str(session["id"])
    row_counts = {
        "user": 0,
        "assistant": 0,
        "tool": 0,
        "tool_metadata": 0,
        "skipped_empty_assistant": 0,
    }
    redactions = 0
    message_blocks: list[list[str]] = []
    first_ts: str | None = None
    last_ts: str | None = None
    message_count = 0

    for row in rows:
        role = str(row.get("role") or "")
        if role in row_counts:
            row_counts[role] += 1
        has_tool_metadata = bool(row.get("tool_name") or row.get("tool_call_id") or row.get("tool_calls"))
        if role == "tool":
            continue
        if has_tool_metadata:
            row_counts["tool_metadata"] += 1
            continue
        if role not in {"user", "assistant"}:
            continue

        content = row.get("content")
        if not isinstance(content, str):
            content = ""
        if role == "assistant" and not content.strip():
            row_counts["skipped_empty_assistant"] += 1
            continue
        if not content.strip():
            continue

        timestamp = epoch_to_local_iso(row.get("timestamp")) or ""
        if timestamp:
            first_ts = first_ts or timestamp
            last_ts = timestamp
        message_count += 1
        lines, count = redacted_lines(content)
        redactions += count
        block = [f"### {role.upper()} {timestamp}".rstrip(), ""]
        block.extend(lines)
        block.append("")
        message_blocks.append(block)

    platform = str(session.get("source") or "").lower()
    logical_session_id = stable_identity(
        IDENTITY_VERSION, SOURCE_NAMESPACE, profile, session_id, target_date.isoformat()
    )
    source_sha256 = sha256_text(
        json.dumps(rows, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    )
    frontmatter = {
        "source": "hermes",
        "source_namespace": SOURCE_NAMESPACE,
        "profile": profile,
        "session_id": session_id,
        "platform": platform,
        "chat_type": None,
        "display_name": None,
        "exported_for": "gbrain_dream_synthesize",
        "dream_generated": False,
        "exporter_owner": EXPORTER_OWNER,
        "provenance_kind": "human-session",
        "automated": False,
        "automation_origin": None,
        "settled": True,
        "settlement_policy": "closed-bangkok-day",
        "settled_at": last_ts,
        "logical_identity_version": IDENTITY_VERSION,
        "logical_session_id": logical_session_id,
        "export_date": target_date.isoformat(),
        "first_timestamp": first_ts,
        "last_timestamp": last_ts,
        "message_count": message_count,
        "redactions": redactions,
        "tool_rows_excluded": row_counts["tool"] + row_counts["tool_metadata"],
        "empty_assistant_rows_skipped": row_counts["skipped_empty_assistant"],
    }

    base_manifest = {
        "source_namespace": SOURCE_NAMESPACE,
        "profile": profile,
        "session_id": session_id,
        "exporter_owner": EXPORTER_OWNER,
        "provenance_kind": "human-session",
        "automated": False,
        "automation_origin": None,
        "dream_generated": False,
        "settled": True,
        "settlement_policy": "closed-bangkok-day",
        "settled_at": last_ts,
        "logical_identity_version": IDENTITY_VERSION,
        "logical_session_id": logical_session_id,
        "source_path": str(db_path),
        "source_sha256": source_sha256,
        "source_started_at": session.get("started_at"),
        "source_ended_at": session.get("ended_at"),
        "source_message_count": session.get("message_count"),
        "message_count": message_count,
        "redactions": redactions,
        "tool_rows_excluded": row_counts["tool"] + row_counts["tool_metadata"],
        "tool_metadata_rows_excluded": row_counts["tool_metadata"],
        "export_date": target_date.isoformat(),
    }

    if message_count == 0:
        text = render_document(frontmatter, session_id, [])
        manifest = dict(base_manifest)
        manifest["rendered_sha256"] = sha256_text(text)
        manifest["part"] = None
        manifest["part_total"] = 1
        return [(text, manifest)], base_manifest

    split_blocks = split_message_blocks(base_frontmatter=frontmatter, session_id=session_id, message_blocks=message_blocks)
    total_parts = len(split_blocks)
    rendered_parts: list[tuple[str, dict[str, Any]]] = []
    for index, blocks in enumerate(split_blocks, start=1):
        is_split = total_parts > 1
        fm = part_frontmatter(frontmatter, blocks, index if is_split else None, total_parts if is_split else None)
        text = render_document(fm, session_id, flatten_blocks(blocks))
        manifest = dict(base_manifest)
        manifest.update(
            {
                "rendered_sha256": sha256_text(text),
                "message_count": len(blocks),
                "first_timestamp": fm["first_timestamp"],
                "last_timestamp": fm["last_timestamp"],
                "part": index if is_split else None,
                "part_index": index,
                "part_total": total_parts,
                "logical_transcript_id": stable_identity(logical_session_id, index),
                "split_threshold_chars": SPLIT_THRESHOLD_CHARS if is_split else None,
            }
        )
        rendered_parts.append((text, manifest))
    return rendered_parts, base_manifest

def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest_index(corpus_dir: Path) -> dict[tuple[str, str, str, int], dict[str, Any]]:
    manifest_path = corpus_dir / ".manifest.jsonl"
    by_key: dict[tuple[str, str, str, int], dict[str, Any]] = {}
    if not manifest_path.exists():
        return by_key
    for line_number, line in enumerate(manifest_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid manifest JSON at line {line_number}") from exc
        if not isinstance(entry, dict):
            raise ValueError(f"invalid manifest row at line {line_number}: expected object")
        key = (
            str(entry.get("profile") or ""),
            str(entry.get("session_id") or ""),
            str(entry.get("export_date") or ""),
            int(entry.get("part") or 0),
        )
        if key in by_key and by_key[key] != entry:
            raise ValueError(f"conflicting duplicate manifest key at line {line_number}: {key}")
        by_key[key] = entry
    return by_key


def manifest_entry_owned(entry: dict[str, Any], profiles: set[str]) -> bool:
    if str(entry.get("profile") or "") not in profiles:
        return False
    return entry.get("exporter_owner") in (None, "", EXPORTER_OWNER)


def prior_logical_entries(
    by_key: dict[tuple[str, str, str, int], dict[str, Any]],
    profile: str,
    session_id: str,
    target_date: dt.date,
) -> list[dict[str, Any]]:
    return [
        entry
        for entry in by_key.values()
        if manifest_entry_owned(entry, {profile})
        and str(entry.get("session_id") or "") == session_id
        and str(entry.get("export_date") or "") == target_date.isoformat()
    ]


def manifest_entry_is_settled_v1(
    entry: dict[str, Any], profile: str, session_id: str, target_date: dt.date
) -> bool:
    part_index = int(entry.get("part") or 1)
    part_total = int(entry.get("part_total") or 1)
    logical_session_id = stable_identity(
        IDENTITY_VERSION, SOURCE_NAMESPACE, profile, session_id, target_date.isoformat()
    )
    return (
        entry.get("settled") is True
        and is_literal_identity_version_one(entry.get("logical_identity_version"))
        and entry.get("source_namespace") == SOURCE_NAMESPACE
        and entry.get("profile") == profile
        and entry.get("session_id") == session_id
        and entry.get("export_date") == target_date.isoformat()
        and entry.get("exporter_owner") == EXPORTER_OWNER
        and int(entry.get("part_index") or 0) == part_index
        and int(entry.get("part_total") or 0) == part_total
        and entry.get("logical_session_id") == logical_session_id
        and entry.get("logical_transcript_id") == stable_identity(logical_session_id, part_index)
    )


def prepare_legacy_migration(
    *,
    corpus_dir: Path,
    db_path: Path,
    profile: str,
    target_date: dt.date,
    session_id: str,
    prior: list[dict[str, Any]],
    rendered_parts: list[tuple[str, dict[str, Any]]],
    stale_quarantine_dir: Path,
) -> list[tuple[str, dict[str, Any]]]:
    """Validate path, body, part, source, and identity before any rewrite."""
    prior_by_part: dict[int, dict[str, Any]] = {}
    for entry in prior:
        if "settled" in entry and entry.get("settled") is not True:
            raise ValueError("legacy manifest contains a non-literal settlement assertion")
        if "logical_identity_version" in entry and not is_literal_identity_version_one(
            entry.get("logical_identity_version")
        ):
            raise ValueError("legacy manifest contains a contradictory identity version")
        part = int(entry.get("part") or 0)
        if part in prior_by_part:
            raise ValueError(f"duplicate legacy manifest part {part}")
        prior_by_part[part] = entry

    rendered_by_part = {
        int(manifest.get("part") or 0): (text, manifest)
        for text, manifest in rendered_parts
    }
    if set(prior_by_part) != set(rendered_by_part):
        raise ValueError(
            f"legacy/current part set mismatch: legacy={sorted(prior_by_part)} "
            f"current={sorted(rendered_by_part)}"
        )

    migrated: list[tuple[str, dict[str, Any]]] = []
    for part_key in sorted(rendered_by_part):
        new_text, current_manifest = rendered_by_part[part_key]
        legacy = prior_by_part[part_key]
        part = current_manifest.get("part")
        expected_path = output_path(corpus_dir, profile, target_date, session_id, part)
        raw_output = legacy.get("output_path")
        if not isinstance(raw_output, str) or not raw_output:
            raise ValueError(f"legacy output_path is missing for part {part_key}")
        legacy_output = Path(raw_output).expanduser()
        if not legacy_output.is_absolute():
            legacy_output = corpus_dir / legacy_output
        if legacy_output.resolve(strict=False) != expected_path.resolve(strict=False):
            raise ValueError(f"legacy output path mismatch for part {part_key}")
        raw_source = legacy.get("source_path")
        if not isinstance(raw_source, str) or not raw_source:
            raise ValueError(f"legacy source_path is missing for part {part_key}")
        if Path(raw_source).expanduser().resolve(strict=False) != db_path.resolve(strict=False):
            raise ValueError(f"legacy source_path mismatch for part {part_key}")

        legacy_hash = legacy.get("legacy_rendered_sha256") or legacy.get("rendered_sha256")
        if not isinstance(legacy_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", legacy_hash):
            raise ValueError(f"legacy rendered hash is missing or invalid for part {part_key}")
        expected_meta, expected_body = parse_frontmatter_document(new_text)
        quarantine_path = quarantine_destination(
            expected_path, corpus_dir, stale_quarantine_dir, legacy_hash
        )
        active_text: str | None = None
        if expected_path.exists():
            if expected_path.is_symlink() or not expected_path.is_file():
                raise ValueError(f"legacy output is not a regular file for part {part_key}")
            active_text = expected_path.read_text(encoding="utf-8")
        quarantined_text: str | None = None
        if quarantine_path.is_file() and not quarantine_path.is_symlink():
            if sha256_file(quarantine_path) != legacy_hash:
                raise ValueError(f"stale partial quarantine hash mismatch for part {part_key}")
            quarantined_text = quarantine_path.read_text(encoding="utf-8")
        active_is_v1 = active_text == new_text
        if active_text is not None and not active_is_v1:
            if sha256_text(active_text) != legacy_hash:
                raise ValueError(f"legacy output hash mismatch for part {part_key}")
            legacy_text: str | None = active_text
        elif quarantined_text is not None:
            legacy_text = quarantined_text
        elif active_is_v1:
            legacy_text = None
        else:
            raise ValueError(f"legacy output and deterministic quarantine are missing for part {part_key}")

        actual_body = expected_body
        if legacy_text is not None:
            actual_meta, actual_body = parse_frontmatter_document(legacy_text)
            required = {
                "source": "hermes",
                "profile": profile,
                "session_id": session_id,
                "platform": expected_meta.get("platform"),
                "exported_for": "gbrain_dream_synthesize",
                "dream_generated": False,
                "export_date": target_date.isoformat(),
            }
            for key, value in required.items():
                if actual_meta.get(key) != value:
                    raise ValueError(f"legacy frontmatter mismatch: {key} part {part_key}")
            for key in ("first_timestamp", "last_timestamp", "message_count"):
                if actual_meta.get(key) != legacy.get(key):
                    raise ValueError(f"legacy file/manifest mismatch: {key} part {part_key}")
            if actual_meta.get("part") != expected_meta.get("part"):
                raise ValueError(f"legacy frontmatter part mismatch for part {part_key}")
            for key in ("source_namespace", "exporter_owner", "logical_session_id", "logical_transcript_id"):
                if key in actual_meta and actual_meta.get(key) != expected_meta.get(key):
                    raise ValueError(f"contradictory legacy frontmatter: {key} part {part_key}")
            if "settled" in actual_meta and actual_meta.get("settled") is not True:
                raise ValueError(f"non-literal legacy frontmatter settlement for part {part_key}")
            if "logical_identity_version" in actual_meta and not is_literal_identity_version_one(
                actual_meta.get("logical_identity_version")
            ):
                raise ValueError(f"contradictory frontmatter identity version for part {part_key}")

        body_drift = actual_body != expected_body
        migration_kind = "legacy-to-settled-identity-v1"
        if body_drift:
            legacy_first = legacy.get("first_timestamp")
            current_first = current_manifest.get("first_timestamp")
            legacy_last_raw = legacy.get("last_timestamp")
            current_last_raw = current_manifest.get("last_timestamp")
            try:
                legacy_last = dt.datetime.fromisoformat(str(legacy_last_raw))
                current_last = dt.datetime.fromisoformat(str(current_last_raw))
            except ValueError as exc:
                raise ValueError(
                    f"legacy body drift lacks comparable day timestamps for part {part_key}"
                ) from exc
            legacy_day_count = legacy.get("message_count")
            current_day_count = current_manifest.get("message_count")
            legacy_session_count = legacy.get("source_message_count")
            current_session_count = current_manifest.get("source_message_count")
            if not (
                legacy_first == current_first
                and current_last >= legacy_last
                and isinstance(legacy_day_count, int)
                and not isinstance(legacy_day_count, bool)
                and isinstance(current_day_count, int)
                and not isinstance(current_day_count, bool)
                and current_day_count > legacy_day_count
                and isinstance(legacy_session_count, int)
                and not isinstance(legacy_session_count, bool)
                and isinstance(current_session_count, int)
                and not isinstance(current_session_count, bool)
                and current_session_count > legacy_session_count
            ):
                raise ValueError(
                    f"legacy body drift is not explained by monotonic closed-day source growth for part {part_key}"
                )
            migration_kind = "stale-partial-to-settled-identity-v1"
        elif active_is_v1 and quarantined_text is not None:
            # A deterministic quarantine alongside the exact v1 bytes means a
            # stale replacement was interrupted before manifest replacement.
            migration_kind = "stale-partial-to-settled-identity-v1"

        migrated_manifest = dict(legacy)
        migrated_manifest.update(current_manifest)
        migrated_manifest.update(
            {
                "output_path": str(expected_path),
                "legacy_rendered_sha256": legacy_hash,
                "legacy_body_sha256": sha256_text(actual_body),
                "body_sha256": sha256_text(expected_body),
                "metadata_migration": migration_kind,
                "rendered_sha256": sha256_text(new_text),
            }
        )
        if migration_kind == "stale-partial-to-settled-identity-v1":
            migrated_manifest.update(
                {
                    "stale_partial_quarantined_path": str(quarantine_path),
                    "stale_partial_tombstone": True,
                    "stale_partial_disposition": "quarantined-and-replaced-after-closed-day-settlement",
                }
            )
        if not manifest_entry_is_settled_v1(
            migrated_manifest, profile, session_id, target_date
        ):
            raise ValueError(f"prepared manifest failed v1 identity validation for part {part_key}")
        migrated.append((new_text, migrated_manifest))
    return migrated


def settled_source_drifted(
    prior: list[dict[str, Any]], rendered_parts: list[tuple[str, dict[str, Any]]]
) -> bool:
    current_hashes = {str(manifest.get("source_sha256")) for _, manifest in rendered_parts}
    prior_source_hashes = {
        str(entry.get("source_sha256"))
        for entry in prior
        if isinstance(entry.get("source_sha256"), str) and entry.get("source_sha256")
    }
    if prior_source_hashes:
        return prior_source_hashes != current_hashes

    # Legacy manifests: compare the day-specific transcript boundaries and
    # message counts. Regardless of this diagnostic, the logical day is never
    # rewritten once it exists.
    current_shape = sorted(
        (
            item.get("first_timestamp"),
            item.get("last_timestamp"),
            int(item.get("message_count") or 0),
            int(item.get("part") or 0),
        )
        for _, item in rendered_parts
    )
    prior_shape = sorted(
        (
            item.get("first_timestamp"),
            item.get("last_timestamp"),
            int(item.get("message_count") or 0),
            int(item.get("part") or 0),
        )
        for item in prior
    )
    return current_shape != prior_shape


def output_path(corpus_dir: Path, profile: str, target_date: dt.date, session_id: str, part: int | None = None) -> Path:
    suffix = f"__part{part}.md" if part is not None else ".md"
    return (
        corpus_dir
        / profile
        / f"{target_date:%Y}"
        / f"{target_date:%m}"
        / f"{target_date.isoformat()}__{profile}__{session_id}{suffix}"
    )


def quarantine_destination(
    path: Path, corpus_dir: Path, quarantine_dir: Path, digest: str
) -> Path:
    try:
        relative = path.resolve(strict=False).relative_to(corpus_dir.resolve(strict=False))
    except (OSError, ValueError) as exc:
        raise ValueError("quarantine candidate escapes the owned corpus") from exc
    destination = quarantine_dir / relative
    return destination.with_name(f"{destination.name}.{digest[:16]}.quarantined")


def quarantine_output(path: Path, corpus_dir: Path, quarantine_dir: Path) -> str | None:
    if not path.is_file() or path.is_symlink():
        return None
    digest = sha256_file(path)
    try:
        destination = quarantine_destination(path, corpus_dir, quarantine_dir, digest)
    except ValueError:
        return None
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(quarantine_dir, 0o700)
    os.chmod(destination.parent, 0o700)
    if destination.exists():
        if sha256_file(destination) != digest:
            destination = destination.with_name(f"{destination.name}.{digest}")
        else:
            path.unlink()
            return str(destination)
    os.replace(path, destination)
    os.chmod(destination, 0o600)
    return str(destination)


def write_stale_partial_tombstones(path: Path, records: list[dict[str, Any]]) -> str:
    existing: dict[str, dict[str, Any]] = {}
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"invalid stale-partial tombstone registry: {path}") from exc
        if (
            not isinstance(payload, dict)
            or payload.get("schema") != "gbrain-stale-partial-tombstones/v1"
            or not isinstance(payload.get("records"), list)
        ):
            raise RuntimeError(f"invalid stale-partial tombstone registry: {path}")
        for record in payload["records"]:
            if not isinstance(record, dict) or not isinstance(record.get("logical_transcript_id"), str):
                raise RuntimeError(f"invalid stale-partial tombstone registry: {path}")
            existing[record["logical_transcript_id"]] = record
    for record in records:
        key = str(record["logical_transcript_id"])
        previous = existing.get(key)
        if previous is not None and previous != record:
            raise RuntimeError(f"conflicting stale-partial tombstone for logical transcript {key}")
        existing[key] = record
    atomic_write_secure(
        path,
        json.dumps(
            {
                "schema": "gbrain-stale-partial-tombstones/v1",
                "records": [existing[key] for key in sorted(existing)],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    return sha256_file(path)


def remove_stale_outputs(corpus_dir: Path, profile: str, target_date: dt.date, session_id: str, expected_paths: set[Path]) -> list[str]:
    base = output_path(corpus_dir, profile, target_date, session_id)
    candidates = [base, *sorted(base.parent.glob(f"{target_date.isoformat()}__{profile}__{session_id}__part*.md"))]
    removed: list[str] = []
    for path in candidates:
        if path.exists() and path not in expected_paths:
            path.unlink()
            removed.append(str(path))
    return removed


def write_if_changed(path: Path, text: str) -> str:
    existed = path.exists()
    if path.exists():
        current = path.read_text(encoding="utf-8")
        if sha256_text(current) == sha256_text(text):
            return "unchanged"

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False
    ) as handle:
        tmp_name = handle.name
        handle.write(text)
    os.replace(tmp_name, path)
    return "changed" if existed else "created"


def write_manifest(corpus_dir: Path, entries: list[dict[str, Any]]) -> str:
    manifest_path = corpus_dir / ".manifest.jsonl"
    existed = manifest_path.exists()
    by_key = load_manifest_index(corpus_dir)
    incoming_base_keys = {
        (
            str(entry.get("profile") or ""),
            str(entry.get("session_id") or ""),
            str(entry.get("export_date") or ""),
        )
        for entry in entries
    }
    for key in list(by_key):
        if key[:3] in incoming_base_keys:
            del by_key[key]

    for entry in entries:
        key = (
            str(entry.get("profile") or ""),
            str(entry.get("session_id") or ""),
            str(entry.get("export_date") or ""),
            int(entry.get("part") or 0),
        )
        by_key[key] = entry

    merged = [by_key[key] for key in sorted(by_key)]
    content = "".join(json.dumps(entry, sort_keys=True, ensure_ascii=False) + "\n" for entry in merged)
    if manifest_path.exists():
        current = manifest_path.read_text(encoding="utf-8")
        if sha256_text(current) == sha256_text(content):
            return "unchanged"
    corpus_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(corpus_dir), prefix=".manifest.", delete=False
    ) as handle:
        tmp_name = handle.name
        handle.write(content)
    os.replace(tmp_name, manifest_path)
    return "changed" if existed else "created"


def migrate_legacy_corpus(
    *,
    corpus_dir: Path,
    profiles_root: Path,
    profiles: list[str],
    include_cli: bool,
    manifest_index: dict[tuple[str, str, str, int], dict[str, Any]],
    closed_before: dt.date,
) -> dict[str, Any]:
    """Upgrade every selected-profile legacy row only after a full source proof.

    All groups are validated before the first write. Transcript replacements
    and the manifest replacement are individually atomic; the strict Dream
    frontmatter+manifest gate makes an interrupted cross-file update fail
    closed, and the exact-v1 resume branch above completes it on the next run.
    """
    selected_profiles = set(profiles)
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for entry in manifest_index.values():
        profile = str(entry.get("profile") or "")
        if not manifest_entry_owned(entry, selected_profiles):
            continue
        session_id = str(entry.get("session_id") or "")
        raw_date = str(entry.get("export_date") or "")
        try:
            target_date = dt.date.fromisoformat(raw_date)
        except ValueError as exc:
            raise ValueError("legacy Hermes manifest has an invalid export_date") from exc
        if manifest_entry_is_settled_v1(entry, profile, session_id, target_date):
            continue
        groups.setdefault((profile, session_id, raw_date), []).append(entry)

    prepared: list[tuple[str, dict[str, Any]]] = []
    migrated_logical: list[dict[str, Any]] = []
    for profile, session_id, raw_date in sorted(groups):
        target_date = dt.date.fromisoformat(raw_date)
        if target_date >= closed_before:
            raise ValueError(
                f"legacy Hermes transcript is not a closed day: profile={profile} date={target_date}"
            )
        db_path = profiles_root / profile / "state.db"
        if not db_path.is_file() or db_path.is_symlink():
            raise ValueError(f"legacy Hermes source database is unavailable for profile={profile}")
        try:
            con = read_only_state_connection(profiles_root, profile)
        except sqlite3.Error as exc:
            raise ValueError(f"cannot open legacy Hermes source for profile={profile}") from exc
        try:
            session_rows = [
                dict(row)
                for row in con.execute(
                    """
                    SELECT id, source, user_id, started_at, ended_at, message_count
                    FROM sessions WHERE id = ?
                    """,
                    (session_id,),
                )
            ]
            if len(session_rows) != 1:
                raise ValueError(
                    f"legacy Hermes source session is missing or ambiguous: profile={profile}"
                )
            session = session_rows[0]
            source = str(session.get("source") or "").lower()
            if not source_is_included(source, include_cli):
                raise ValueError(
                    f"legacy Hermes source is no longer an allowed human lane: profile={profile}"
                )
            window_start = local_day_start(target_date).timestamp()
            window_end = (local_day_start(target_date) + dt.timedelta(days=1)).timestamp()
            day_rows = [
                dict(row)
                for row in con.execute(
                    """
                    SELECT session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp
                    FROM messages
                    WHERE session_id = ? AND timestamp >= ? AND timestamp < ?
                    ORDER BY timestamp, id
                    """,
                    (session_id, window_start, window_end),
                )
            ]
        finally:
            con.close()
        if not day_rows:
            raise ValueError(f"legacy Hermes source day has no rows: profile={profile} date={target_date}")
        rendered_parts, base_manifest = render_session(
            profile=profile,
            db_path=db_path,
            target_date=target_date,
            session=session,
            rows=day_rows,
        )
        if int(base_manifest.get("message_count") or 0) <= 0:
            raise ValueError(
                f"legacy Hermes source day has no human transcript body: profile={profile} date={target_date}"
            )
        migrated_parts = prepare_legacy_migration(
            corpus_dir=corpus_dir,
            db_path=db_path,
            profile=profile,
            target_date=target_date,
            session_id=session_id,
            prior=groups[(profile, session_id, raw_date)],
            rendered_parts=rendered_parts,
            stale_quarantine_dir=corpus_dir.parent
            / "quarantine"
            / "stale-settled-hermes",
        )
        prepared.extend(migrated_parts)
        migrated_logical.append(
            {"profile": profile, "session_id": session_id, "export_date": raw_date}
        )

    changed = 0
    unchanged = 0
    upgraded_entries: list[dict[str, Any]] = []
    output_paths: list[str] = []
    selected_manifest_keys: list[dict[str, Any]] = []
    selected_outputs: list[dict[str, Any]] = []
    stale_partial_records: list[dict[str, Any]] = []
    for text, manifest in prepared:
        out_path = Path(str(manifest["output_path"]))
        if manifest.get("metadata_migration") == "stale-partial-to-settled-identity-v1":
            legacy_hash = str(manifest["legacy_rendered_sha256"])
            quarantine_path = Path(str(manifest["stale_partial_quarantined_path"]))
            if out_path.exists() and sha256_file(out_path) == legacy_hash:
                moved = quarantine_output(
                    out_path,
                    corpus_dir,
                    corpus_dir.parent / "quarantine" / "stale-settled-hermes",
                )
                if moved is None or Path(moved).resolve(strict=False) != quarantine_path.resolve(strict=False):
                    raise RuntimeError("stale Hermes partial did not reach its deterministic quarantine")
            elif out_path.exists() and sha256_file(out_path) == sha256_text(text):
                if not quarantine_path.is_file() or sha256_file(quarantine_path) != legacy_hash:
                    raise RuntimeError("Hermes replacement exists without its sealed stale-partial quarantine")
            elif not out_path.exists():
                if not quarantine_path.is_file() or sha256_file(quarantine_path) != legacy_hash:
                    raise RuntimeError("stale Hermes partial and deterministic quarantine are both missing")
            else:
                raise RuntimeError("active stale Hermes path contains unrecognized bytes")
            stale_partial_records.append(
                {
                    "logical_transcript_id": manifest["logical_transcript_id"],
                    "logical_session_id": manifest["logical_session_id"],
                    "legacy_rendered_sha256": legacy_hash,
                    "legacy_body_sha256": manifest["legacy_body_sha256"],
                    "replacement_rendered_sha256": manifest["rendered_sha256"],
                    "replacement_body_sha256": manifest["body_sha256"],
                    "quarantine_path": str(quarantine_path),
                    "output_path": str(out_path),
                    "settled_at": manifest.get("settled_at"),
                    "disposition": "quarantined-and-replaced-after-closed-day-settlement",
                }
            )
        status = write_if_changed(out_path, text)
        changed += int(status != "unchanged")
        unchanged += int(status == "unchanged")
        upgraded_entries.append(manifest)
        output_paths.append(str(out_path))
        key_object = {
            "profile": manifest["profile"],
            "session_id": manifest["session_id"],
            "export_date": manifest["export_date"],
            "part": manifest.get("part"),
        }
        selected_manifest_keys.append(key_object)
        selected_outputs.append({"manifest_key": key_object, "output_path": str(out_path)})

    stale_registry = (
        corpus_dir.parent
        / "quarantine"
        / "stale-settled-hermes"
        / "stale-partial-tombstones.json"
    )
    stale_registry_sha256 = (
        write_stale_partial_tombstones(stale_registry, stale_partial_records)
        if stale_partial_records or stale_registry.exists()
        else None
    )
    manifest_status = write_manifest(corpus_dir, upgraded_entries) if upgraded_entries else "unchanged"
    final_index = load_manifest_index(corpus_dir)
    remaining: list[list[Any]] = []
    for key, entry in final_index.items():
        profile = str(entry.get("profile") or "")
        if not manifest_entry_owned(entry, selected_profiles):
            continue
        try:
            entry_date = dt.date.fromisoformat(str(entry.get("export_date") or ""))
            is_v1 = manifest_entry_is_settled_v1(
                entry, profile, str(entry.get("session_id") or ""), entry_date
            )
        except (TypeError, ValueError):
            is_v1 = False
        if not is_v1:
            remaining.append([*key])
    if remaining:
        raise ValueError(f"Hermes legacy migration left {len(remaining)} active manifest rows")

    return {
        "schema": "gbrain-legacy-export-migration/v1",
        "status": "success",
        "logical_sessions": len(migrated_logical),
        "parts": len(upgraded_entries),
        "changed_files": changed,
        "unchanged_files": unchanged,
        "manifest": manifest_status,
        "logical_transcripts": migrated_logical,
        "selected_manifest_keys": selected_manifest_keys,
        "selected_outputs": selected_outputs,
        "output_paths": sorted(output_paths),
        "remaining_legacy_manifest_rows": 0,
        "stale_partial_replacements": len(
            {
                str(entry["logical_session_id"])
                for entry in stale_partial_records
            }
        ),
        "stale_partial_tombstones": {
            "records_written": len(stale_partial_records),
            "registry": str(stale_registry) if stale_registry_sha256 else None,
            "sha256": stale_registry_sha256,
        },
    }


def export_for_date(
    corpus_dir: Path,
    profiles_root: Path,
    target_date: dt.date,
    profiles: list[str],
    include_cli: bool,
    manifest_index: dict[tuple[str, str, str, int], dict[str, Any]],
) -> dict[str, Any]:
    window_start = local_day_start(target_date)
    window_end = window_start + dt.timedelta(days=1)
    window_start_ts = window_start.timestamp()
    window_end_ts = window_end.timestamp()
    totals: dict[str, Any] = {
        "date": target_date.isoformat(),
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "profiles": {},
        "created": 0,
        "changed": 0,
        "unchanged": 0,
        "skipped": 0,
        "warnings": 0,
        "settled_drift": 0,
        "existing_output_drift": 0,
        "selected_manifest_keys": [],
        "output_paths": [],
    }
    manifest_entries: list[dict[str, Any]] = []

    for profile in profiles:
        profile_stats = {
            "exported": 0,
            "messages_exported": 0,
            "created": 0,
            "changed": 0,
            "unchanged": 0,
            "scanned": 0,
            "included": 0,
            "excluded": 0,
            "excluded_cron": 0,
            "excluded_cli_tui": 0,
            "excluded_other_source": 0,
            "skipped_no_day_messages": 0,
            "skipped_empty": 0,
            "tool_rows_excluded": 0,
            "tool_metadata_rows_excluded": 0,
            "split_sessions": 0,
            "part_files": 0,
            "stale_removed": 0,
            "already_settled": 0,
            "settled_drift": 0,
            "existing_output_drift": 0,
        }
        db_path = profiles_root / profile / "state.db"
        if not db_path.exists():
            totals["warnings"] += 1
            print(f"warning: missing state database for {profile}: {db_path}", file=sys.stderr)
            totals["profiles"][profile] = profile_stats
            continue

        try:
            con = read_only_state_connection(profiles_root, profile)
        except sqlite3.Error as exc:
            totals["warnings"] += 1
            print(f"warning: failed to open read-only state database for {profile}: {exc}", file=sys.stderr)
            totals["profiles"][profile] = profile_stats
            continue

        with con:
            sessions = [
                dict(row)
                for row in con.execute(
                    """
                    SELECT id, source, user_id, started_at, ended_at, message_count
                    FROM sessions
                    ORDER BY started_at, id
                    """
                )
            ]

            for session in sessions:
                profile_stats["scanned"] += 1
                session_id = str(session["id"])
                source = str(session.get("source") or "").lower()
                if source in ALWAYS_EXCLUDED_PLATFORMS:
                    profile_stats["excluded"] += 1
                    profile_stats["excluded_cron"] += 1
                    continue
                if source in CLI_PLATFORMS and not include_cli:
                    profile_stats["excluded"] += 1
                    profile_stats["excluded_cli_tui"] += 1
                    continue
                if not source_is_included(source, include_cli):
                    profile_stats["excluded"] += 1
                    profile_stats["excluded_other_source"] += 1
                    continue

                profile_stats["included"] += 1
                day_rows = [
                    dict(row)
                    for row in con.execute(
                        """
                        SELECT session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp
                        FROM messages
                        WHERE session_id = ?
                          AND timestamp >= ?
                          AND timestamp < ?
                        ORDER BY timestamp, id
                        """,
                        (session_id, window_start_ts, window_end_ts),
                    )
                ]
                if not day_rows:
                    profile_stats["skipped_no_day_messages"] += 1
                    continue

                rendered_parts, base_manifest = render_session(
                    profile=profile,
                    db_path=db_path,
                    target_date=target_date,
                    session=session,
                    rows=day_rows,
                )
                profile_stats["tool_rows_excluded"] += base_manifest["tool_rows_excluded"]
                profile_stats["tool_metadata_rows_excluded"] += base_manifest["tool_metadata_rows_excluded"]
                if base_manifest["message_count"] == 0:
                    profile_stats["skipped_empty"] += 1
                    continue

                prior = prior_logical_entries(
                    manifest_index, profile, session_id, target_date
                )
                if prior:
                    if settled_source_drifted(prior, rendered_parts):
                        profile_stats["settled_drift"] += 1
                        totals["settled_drift"] += 1
                        print(
                            f"error: settled Hermes logical transcript drift: profile={profile} "
                            f"session={session_id} date={target_date}; refusing rewrite",
                            file=sys.stderr,
                        )
                    else:
                        profile_stats["already_settled"] += 1
                    continue

                expected_paths = {
                    output_path(corpus_dir, profile, target_date, session_id, manifest.get("part"))
                    for _, manifest in rendered_parts
                }
                conflicting = [
                    out_path
                    for text, manifest in rendered_parts
                    if (out_path := output_path(corpus_dir, profile, target_date, session_id, manifest.get("part"))).exists()
                    and sha256_text(out_path.read_text(encoding="utf-8")) != sha256_text(text)
                ]
                if conflicting:
                    profile_stats["existing_output_drift"] += 1
                    totals["existing_output_drift"] += 1
                    print(
                        f"error: orphan settled Hermes output drift: profile={profile} "
                        f"session={session_id} date={target_date}; refusing rewrite",
                        file=sys.stderr,
                    )
                    continue

                removed = remove_stale_outputs(corpus_dir, profile, target_date, session_id, expected_paths)
                profile_stats["stale_removed"] += len(removed)
                totals["changed"] += len(removed)
                if len(rendered_parts) > 1:
                    profile_stats["split_sessions"] += 1
                    profile_stats["part_files"] += len(rendered_parts)

                for text, manifest in rendered_parts:
                    out_path = output_path(corpus_dir, profile, target_date, session_id, manifest.get("part"))
                    before_exists = out_path.exists()
                    status = write_if_changed(out_path, text)
                    if status == "unchanged":
                        profile_stats["unchanged"] += 1
                        totals["unchanged"] += 1
                    elif before_exists:
                        profile_stats["changed"] += 1
                        totals["changed"] += 1
                    else:
                        profile_stats["created"] += 1
                        totals["created"] += 1
                    profile_stats["exported"] += 1
                    profile_stats["messages_exported"] += manifest["message_count"]
                    manifest["output_path"] = str(out_path)
                    manifest_entries.append(manifest)
                    totals["output_paths"].append(str(out_path))
                    totals["selected_manifest_keys"].append(
                        {
                            "profile": manifest["profile"],
                            "session_id": manifest["session_id"],
                            "export_date": manifest["export_date"],
                            "part": manifest.get("part"),
                        }
                    )

        totals["skipped"] += (
            profile_stats["excluded"]
            + profile_stats["skipped_no_day_messages"]
            + profile_stats["skipped_empty"]
        )
        totals["profiles"][profile] = profile_stats

    manifest_entries.sort(key=lambda item: (item["profile"], item["session_id"], item["export_date"], int(item.get("part") or 0)))
    manifest_status = write_manifest(corpus_dir, manifest_entries)
    totals["manifest"] = manifest_status
    # settled_drift is not fatal (same-lineage resumed sessions; excluded from
    # export anyway) — mirror of scheduled_export_status in the Claude exporter.
    totals["status"] = (
        "failed"
        if totals["warnings"] or totals["existing_output_drift"]
        else "success"
    )
    return totals


def main() -> int:
    args = parse_args()
    now = local_now(args.now)
    corpus_dir = Path(args.corpus_dir).expanduser().resolve()
    profiles_root = Path(args.profiles_root).expanduser().resolve()
    profiles = args.profile or list(PROFILES)
    dates = requested_dates(args.date, now)
    yesterday = now.date() - dt.timedelta(days=1)
    if args.scheduled and dates != [yesterday]:
        print("error: scheduled Hermes export must select exactly yesterday Bangkok", file=sys.stderr)
        return 2
    try:
        legacy_migration = migrate_legacy_corpus(
            corpus_dir=corpus_dir,
            profiles_root=profiles_root,
            profiles=profiles,
            include_cli=args.include_cli,
            manifest_index=load_manifest_index(corpus_dir),
            closed_before=now.date(),
        )
    except (OSError, RuntimeError, sqlite3.Error, ValueError) as exc:
        summary = {
            "exporter": EXPORTER_OWNER,
            "scheduled": bool(args.scheduled),
            "selected_dates": [value.isoformat() for value in dates],
            "profiles": profiles,
            "dates": [],
            "selected_manifest_keys": [],
            "output_paths": [],
            "legacy_migration": {
                "schema": "gbrain-legacy-export-migration/v1",
                "status": "failed",
                "error": str(exc),
            },
            "status": "failed",
        }
        if args.summary_file:
            atomic_write_secure(
                Path(args.summary_file).expanduser().resolve(),
                json.dumps(summary, indent=2, sort_keys=True) + "\n",
            )
        print(json.dumps(summary, indent=2, sort_keys=True))
        print(f"error: safe Hermes legacy migration refused: {exc}", file=sys.stderr)
        return 3
    all_stats = []
    for target_date in dates:
        stats = export_for_date(
            corpus_dir,
            profiles_root,
            target_date,
            profiles,
            args.include_cli,
            load_manifest_index(corpus_dir),
        )
        all_stats.append(stats)
        print(json.dumps(stats, indent=2, sort_keys=True))
        for profile, profile_stats in stats["profiles"].items():
            print(
                "profile_breakdown: "
                f"date={stats['date']} profile={profile} "
                f"included={profile_stats['included']} "
                f"excluded={profile_stats['excluded']} "
                f"excluded_cron={profile_stats['excluded_cron']} "
                f"excluded_cli_tui={profile_stats['excluded_cli_tui']} "
                f"excluded_other_source={profile_stats['excluded_other_source']} "
                f"files={profile_stats['exported']} "
                f"messages={profile_stats['messages_exported']}"
            )

    total_changed = sum(item["created"] + item["changed"] for item in all_stats)
    print(
        f"summary: dates={len(all_stats)} changed_files={total_changed} "
        f"corpus_dir={corpus_dir}"
    )
    summary = {
        "exporter": EXPORTER_OWNER,
        "scheduled": bool(args.scheduled),
        "selected_dates": [value.isoformat() for value in dates],
        "profiles": profiles,
        "dates": all_stats,
        "selected_manifest_keys": [
            key
            for key in legacy_migration["selected_manifest_keys"]
            if key["export_date"] in {value.isoformat() for value in dates}
        ] + [key for item in all_stats for key in item["selected_manifest_keys"]],
        "output_paths": sorted(
            [
                item["output_path"]
                for item in legacy_migration["selected_outputs"]
                if item["manifest_key"]["export_date"]
                in {value.isoformat() for value in dates}
            ]
            + [path for item in all_stats for path in item["output_paths"]]
        ),
        "legacy_migration": legacy_migration,
        "status": "success"
        if all(item["status"] == "success" for item in all_stats)
        else "failed",
    }
    if args.summary_file:
        atomic_write_secure(
            Path(args.summary_file).expanduser().resolve(),
            json.dumps(summary, indent=2, sort_keys=True) + "\n",
        )
    return 0 if summary["status"] == "success" else 3


if __name__ == "__main__":
    raise SystemExit(main())
