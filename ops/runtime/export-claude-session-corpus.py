#!/usr/bin/env python3
"""Export Claude Code session transcripts into the Hermes GBrain dream-synthesis corpus format.

Source : ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl  (one JSON object per line)
         subagent sidechains at  <sessionId>/subagents/agent-<id>.jsonl
Output : <corpus-dir>/claude-code/YYYY/MM/<YYYY-MM-DD>__claude-code__<sessionId>.md
         + <corpus-dir>/.manifest.jsonl

Mirrors the LIVE Hermes dream-synthesis corpus render shape (frontmatter block keyed
source/profile/session_id/platform/.../empty_assistant_rows_skipped[+part], and a
`### ROLE <iso-ts>` turn body), plus redaction, sha256 dedup, manifest record schema,
and atomic write-if-changed — swapping only source specifics + Claude-only frontmatter
extras (cwd/git_branch/title) appended after the live-matching block.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


# --- source / output convention -------------------------------------------------------
CLAUDE_PROJECTS_ROOT = Path("/Users/jarvis/.claude/projects")
DEFAULT_CORPUS_DIR = "~/brain-intake/sessions"
PROFILE = "claude-code"
SOURCE_KIND = "claude-code-session-export"
SOURCE_NAMESPACE = "claude-code"
EXPORTER_OWNER = "gbrain:claude-session-export"
IDENTITY_VERSION = 1
LOCAL_TZ = ZoneInfo("Asia/Bangkok")
DEFAULT_QUIET_MINUTES = 180
AUTOMATION_ORIGIN_TOKENS = ("gbrain", "dream", "cron", "autopilot", "automation")

# Conversation roles we keep; everything else (thinking / tool_use / tool_result /
# metadata lines / attachments) is excluded from the body.
KEEP_ROLES = ("user", "assistant")

# User-content STRING wrappers that are harness noise, not genuine typed prose.
NOISE_PREFIXES = (
    "<local-command-caveat>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<system-reminder>",
)

# Credential redaction — same pattern set as the Hermes exporter.
SECRET_LINE_RE = re.compile(
    r"(api[_-]?key|token|secret|password|credential|authorization:|bearer |sk-|xoxb-|ghp_|BEGIN .*PRIVATE KEY)",
    re.IGNORECASE,
)

SPLIT_THRESHOLD_CHARS = 600_000  # 2026-07-02: was 35_000 (predates native gbrain chunking); whole-session synthesis kills cross-part near-dup pages. gbrain chunks internally at ~630K chars.
MIN_SPLIT_PART_CHARS = 2_000

USER_TITLE_TRUNCATE = 100


# --- CLI -------------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Claude Code session transcripts as deterministic Markdown corpus files."
    )
    parser.add_argument(
        "--corpus-dir",
        default=DEFAULT_CORPUS_DIR,
        help=f"Corpus root. Default: {DEFAULT_CORPUS_DIR}",
    )
    parser.add_argument(
        "--projects",
        default=None,
        help="Substring/glob to scope which ~/.claude/projects/<slug> dirs to scan. Default: all.",
    )
    parser.add_argument(
        "--since",
        default=None,
        help="Only export sessions whose start date is on/after this YYYY-MM-DD.",
    )
    parser.add_argument(
        "--settled-through",
        default="yesterday",
        help=(
            "Only export sessions whose final source event is on/before this Bangkok date "
            "(YYYY-MM-DD, today, or yesterday). Default: yesterday."
        ),
    )
    parser.add_argument(
        "--quiet-minutes",
        type=int,
        default=DEFAULT_QUIET_MINUTES,
        help=f"Required source timestamp and file-mtime quiet window. Default: {DEFAULT_QUIET_MINUTES}.",
    )
    parser.add_argument(
        "--scheduled",
        action="store_true",
        help="Fail closed unless --settled-through is a prior closed Bangkok day.",
    )
    parser.add_argument(
        "--projects-root",
        default=os.environ.get("GBRAIN_CLAUDE_PROJECTS_ROOT", str(CLAUDE_PROJECTS_ROOT)),
        help="Claude projects root (fixture override supported).",
    )
    parser.add_argument(
        "--summary-file",
        default=None,
        help="Atomically write a mode-0600 machine-readable run summary.",
    )
    parser.add_argument(
        "--quarantine-dir",
        default=None,
        help="Quarantine root for retired automated exports. Default: sibling of the active corpus.",
    )
    parser.add_argument(
        "--now",
        default=os.environ.get("GBRAIN_EXPORT_NOW"),
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--include-subagents",
        dest="include_subagents",
        action="store_true",
        default=True,
        help="Fold subagent sidechain reports into the transcript (default: on).",
    )
    parser.add_argument(
        "--no-include-subagents",
        dest="include_subagents",
        action="store_false",
        help="Disable subagent folding.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Render + summarize into a temp preview dir; never touch the real corpus.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Stop after exporting N sessions.",
    )
    return parser.parse_args()


# --- helpers (mirrored from the Hermes exporter) --------------------------------------
def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contributing_source_paths(jsonl_path: Path, include_subagents: bool) -> list[Path]:
    paths = [jsonl_path]
    if include_subagents:
        sub_root = jsonl_path.with_suffix("") / "subagents"
        if sub_root.is_dir():
            paths.extend(sorted(path for path in sub_root.iterdir() if path.is_file()))
    return paths


def source_tree_sha256(jsonl_path: Path, paths: list[Path]) -> str:
    digest = hashlib.sha256()
    base = jsonl_path.parent.resolve(strict=False)
    for path in sorted(paths):
        resolved = path.resolve(strict=False)
        try:
            relative = resolved.relative_to(base)
        except ValueError:
            relative = Path(path.name)
        digest.update(str(relative).encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def latest_source_timestamp(meta: dict[str, Any], paths: list[Path]) -> dt.datetime | None:
    latest = meta.get("ts_max")
    for path in paths:
        if path.suffix != ".jsonl":
            continue
        for row in load_jsonl(path):
            parsed = parse_iso(row.get("timestamp"))
            if parsed is not None and (latest is None or parsed > latest):
                latest = parsed
    return latest


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


def atomic_copy_secure(source: Path, destination: Path) -> None:
    """Atomically copy an already-sealed registry without reserializing it."""
    payload = source.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(destination.parent, 0o700)
    with tempfile.NamedTemporaryFile(
        "wb", dir=str(destination.parent), prefix=f".{destination.name}.", delete=False
    ) as handle:
        tmp_name = handle.name
        os.chmod(tmp_name, 0o600)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_name, destination)
    os.chmod(destination, 0o600)


def parse_frontmatter_document(text: str) -> tuple[dict[str, Any], str]:
    """Parse the exporter's deliberately JSON-scalar YAML subset.

    This is intentionally narrower than general YAML: accepting aliases,
    duplicate keys, or multiline values would make a legacy migration
    ambiguous.  Both the legacy and v1 exporters emit exactly this subset.
    """
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


def local_now(value: str | None = None) -> dt.datetime:
    if value:
        parsed = parse_iso(value)
        if parsed is None:
            raise ValueError(f"invalid --now timestamp: {value}")
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=LOCAL_TZ)
        return parsed.astimezone(LOCAL_TZ)
    return dt.datetime.now(LOCAL_TZ)


def requested_local_date(value: str, now: dt.datetime) -> dt.date:
    lowered = value.lower()
    if lowered == "today":
        return now.date()
    if lowered == "yesterday":
        return now.date() - dt.timedelta(days=1)
    return dt.date.fromisoformat(value)


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(yaml_scalar(item) for item in value) + "]"
    text = str(value)
    return json.dumps(text, ensure_ascii=False)


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


def render_frontmatter(frontmatter: dict[str, Any]) -> list[str]:
    rendered = ["---"]
    for key, value in frontmatter.items():
        rendered.append(f"{key}: {yaml_scalar(value)}")
    rendered.extend(["---", ""])
    return rendered


def render_document(
    frontmatter: dict[str, Any],
    session_id: str,
    blocks: list[str],
    subagent_blocks: list[str] | None = None,
) -> str:
    rendered = render_frontmatter(frontmatter)
    # Live-format body: `# <Profile> Session <id>` then a flat sequence of
    # `### ROLE <iso-ts>` turn blocks (no `## Transcript` wrapper).
    rendered.extend([f"# Claude Code Session {session_id}", ""])
    rendered.extend(blocks)
    if subagent_blocks:
        rendered.extend(subagent_blocks)
    return "\n".join(rendered).rstrip() + "\n"


# --- ISO-8601 timestamp handling ------------------------------------------------------
def parse_iso(ts: str | None) -> dt.datetime | None:
    if not ts or not isinstance(ts, str):
        return None
    raw = ts.replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(raw)
    except ValueError:
        return None


def normalize_iso(ts: str | None) -> str:
    """Canonical UTC ISO-8601 (mirrors how Hermes stores 'first/last_timestamp')."""
    parsed = parse_iso(ts)
    if parsed is None:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.isoformat()


# --- source parsing -------------------------------------------------------------------
def is_noise_user_string(content: str) -> bool:
    stripped = content.lstrip()
    return any(stripped.startswith(prefix) for prefix in NOISE_PREFIXES)


def extract_assistant_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text)
    return "\n\n".join(parts).strip()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    rows.append(obj)
    except OSError:
        return []
    return rows


def parse_session(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Walk source rows once; collect kept conversation turns, title hints, counts, metadata."""
    turns: list[dict[str, Any]] = []  # {role, timestamp(iso), text}
    counts = {
        "conversation_lines": 0,
        "assistant_kept": 0,
        "user_kept": 0,
        "tool_rows_excluded": 0,        # tool_use blocks + tool_result-dominated user lines
        "tool_metadata_rows_excluded": 0,  # metadata lines (no `message`) + attachments + noise
        "thinking_excluded": 0,
        "first_user_prose": None,
    }
    ai_title: str | None = None
    custom_title: str | None = None
    cwd: str | None = None
    git_branch: str | None = None
    version: str | None = None
    entrypoint: str | None = None
    prompt_source: str | None = None
    permission_mode: str | None = None
    explicit_automation = False
    automation_origins: set[str] = set()
    explicit_ended = False
    session_id: str | None = None
    ts_min: dt.datetime | None = None
    ts_max: dt.datetime | None = None

    for obj in rows:
        otype = obj.get("type")

        # SDK automation metadata is present on the first user row. Capture it
        # independently of whether that row later survives body filtering so
        # generated sessions can be excluded by provenance, not prompt text.
        if entrypoint is None and isinstance(obj.get("entrypoint"), str):
            entrypoint = obj["entrypoint"]
        if prompt_source is None and isinstance(obj.get("promptSource"), str):
            prompt_source = obj["promptSource"]
        if permission_mode is None and isinstance(obj.get("permissionMode"), str):
            permission_mode = obj["permissionMode"]

        # Capture explicit producer provenance independently of conversation
        # content. These keys cover current SDK records and intentionally allow
        # future launchers to make automation provenance unambiguous.
        metadata = obj.get("metadata") if isinstance(obj.get("metadata"), dict) else {}
        obj_provenance = obj.get("provenance") if isinstance(obj.get("provenance"), dict) else {}
        meta_provenance = (
            metadata.get("provenance") if isinstance(metadata.get("provenance"), dict) else {}
        )
        for container in (obj, metadata, obj_provenance, meta_provenance):
            for key in ("automated", "isAutomated", "automation", "gbrainGenerated", "dreamGenerated"):
                marker = container.get(key)
                if marker is True or (
                    isinstance(marker, str)
                    and marker.strip().lower() in {"true", "yes", "1", "automated", "gbrain", "dream", "cron"}
                ):
                    explicit_automation = True
            for key in (
                "automationOrigin",
                "automation_origin",
                "generatedBy",
                "generated_by",
                "producer",
                "origin",
                "jobType",
                "job_type",
                "provenanceKind",
                "provenance_kind",
            ):
                value = container.get(key)
                if isinstance(value, str) and value.strip():
                    automation_origins.add(value.strip().lower())

        if entrypoint is None and isinstance(metadata.get("entrypoint"), str):
            entrypoint = metadata["entrypoint"]
        if prompt_source is None:
            candidate_prompt_source = metadata.get("promptSource") or metadata.get("prompt_source")
            if isinstance(candidate_prompt_source, str):
                prompt_source = candidate_prompt_source
        if permission_mode is None:
            candidate_permission_mode = metadata.get("permissionMode") or metadata.get("permission_mode")
            if isinstance(candidate_permission_mode, str):
                permission_mode = candidate_permission_mode
        if cwd is None and isinstance(metadata.get("cwd"), str):
            cwd = metadata["cwd"]

        if (
            obj.get("sessionEnded") is True
            or obj.get("isSessionEnd") is True
            or metadata.get("sessionEnded") is True
            or metadata.get("isSessionEnd") is True
            or str(otype or "").lower() in {"session-end", "session_end", "conversation-end", "conversation_end"}
        ):
            explicit_ended = True

        if otype == "custom-title":
            ct = obj.get("customTitle")
            if isinstance(ct, str) and ct.strip():
                custom_title = ct.strip()
            continue
        if otype == "ai-title":
            at = obj.get("aiTitle")
            if isinstance(at, str) and at.strip():
                ai_title = at.strip()
            continue

        if otype not in KEEP_ROLES:
            # last-prompt / mode / permission-mode / system / file-history-snapshot /
            # queue-operation / attachment / etc. — body noise.
            if otype is not None:
                counts["tool_metadata_rows_excluded"] += 1
            continue

        # Conversation line.
        counts["conversation_lines"] += 1
        session_id = session_id or obj.get("sessionId")
        if cwd is None and obj.get("cwd"):
            cwd = obj.get("cwd")
        if git_branch is None and obj.get("gitBranch"):
            git_branch = obj.get("gitBranch")
        if version is None and obj.get("version"):
            version = obj.get("version")

        parsed_ts = parse_iso(obj.get("timestamp"))
        if parsed_ts is not None:
            ts_min = parsed_ts if ts_min is None or parsed_ts < ts_min else ts_min
            ts_max = parsed_ts if ts_max is None or parsed_ts > ts_max else ts_max

        message = obj.get("message") or {}
        content = message.get("content")
        iso = normalize_iso(obj.get("timestamp"))

        if otype == "assistant":
            # Count thinking / tool_use blocks as excluded; keep text.
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        bt = block.get("type")
                        if bt == "thinking":
                            counts["thinking_excluded"] += 1
                        elif bt == "tool_use":
                            counts["tool_rows_excluded"] += 1
            text = extract_assistant_text(content)
            if not text:
                continue
            counts["assistant_kept"] += 1
            turns.append({"role": "assistant", "timestamp": iso, "text": text})
            continue

        # user
        if isinstance(content, str):
            if not content.strip() or is_noise_user_string(content):
                counts["tool_metadata_rows_excluded"] += 1
                continue
            counts["user_kept"] += 1
            if counts["first_user_prose"] is None:
                counts["first_user_prose"] = content.strip()
            turns.append({"role": "user", "timestamp": iso, "text": content.strip()})
        elif isinstance(content, list):
            # tool_result-dominated user line = noise.
            counts["tool_rows_excluded"] += 1
        else:
            counts["tool_metadata_rows_excluded"] += 1

    title = custom_title or ai_title
    if not title:
        prose = counts["first_user_prose"]
        if prose:
            flat = " ".join(prose.split())
            title = flat[:USER_TITLE_TRUNCATE] + ("…" if len(flat) > USER_TITLE_TRUNCATE else "")

    return {
        "turns": turns,
        "counts": counts,
        "title": title,
        "cwd": cwd,
        "git_branch": git_branch,
        "version": version,
        "entrypoint": entrypoint,
        "prompt_source": prompt_source,
        "permission_mode": permission_mode,
        "explicit_automation": explicit_automation,
        "automation_origins": sorted(automation_origins),
        "explicit_ended": explicit_ended,
        "session_id": session_id,
        "ts_min": ts_min,
        "ts_max": ts_max,
    }


def is_gbrain_runtime_cwd(value: Any) -> bool:
    """Match Dream's GBrain runtime-path gate without prompt inspection."""
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        lexical = Path(value).expanduser()
        resolved = lexical.resolve(strict=False)
    except OSError:
        return False
    return any(
        part.lower() in {".gbrain", "gbrain"}
        for path in (lexical, resolved)
        for part in path.parts
    )


def is_automated_gbrain_session(meta: dict[str, Any]) -> bool:
    """True for non-human Claude SDK sessions launched from GBrain home.

    This intentionally uses stable session provenance instead of matching the
    synthesis prompt. Prompt matching is brittle and risks leaking generated
    output into the corpus when wording changes.
    """
    if meta.get("explicit_automation") is True:
        return True
    origins = meta.get("automation_origins") or []
    if any(any(token in str(origin).lower() for token in AUTOMATION_ORIGIN_TOKENS) for origin in origins):
        return True

    sdk_automation = (
        meta.get("entrypoint") == "sdk-cli"
        and meta.get("prompt_source") == "sdk"
        and meta.get("permission_mode") == "auto"
    )
    if not sdk_automation:
        return False
    return is_gbrain_runtime_cwd(meta.get("cwd"))


def load_subagent_reports(session_dir: Path) -> list[dict[str, Any]]:
    """Final assistant text (the returned report) of each subagent sidechain."""
    sub_root = session_dir / "subagents"
    if not sub_root.is_dir():
        return []
    reports: list[dict[str, Any]] = []
    for agent_path in sorted(sub_root.glob("agent-*.jsonl")):
        rows = load_jsonl(agent_path)
        final_text = ""
        last_ts = ""
        for obj in rows:
            if obj.get("type") != "assistant":
                continue
            text = extract_assistant_text((obj.get("message") or {}).get("content"))
            if text:
                final_text = text
                last_ts = normalize_iso(obj.get("timestamp")) or last_ts
        if not final_text:
            continue
        agent_id = agent_path.stem.replace("agent-", "")
        agent_type = None
        description = None
        meta_path = agent_path.with_suffix("").with_suffix(".meta.json")
        # meta sibling is "agent-<id>.meta.json"
        meta_sibling = sub_root / f"{agent_path.stem}.meta.json"
        for candidate in (meta_sibling, meta_path):
            if candidate.exists():
                try:
                    meta = json.loads(candidate.read_text(encoding="utf-8"))
                    agent_type = meta.get("agentType")
                    description = meta.get("description")
                except (OSError, json.JSONDecodeError):
                    pass
                break
        reports.append(
            {
                "agent_id": agent_id,
                "agent_type": agent_type,
                "description": description,
                "timestamp": last_ts,
                "text": final_text,
            }
        )
    return reports


# --- render ---------------------------------------------------------------------------
def build_transcript_blocks(turns: list[dict[str, Any]]) -> tuple[list[list[str]], int]:
    """One block per kept turn, live format: '### ROLE <iso-ts>' header (uppercase role),
    blank line, redacted prose, blank line. Returns (blocks, redactions)."""
    blocks: list[list[str]] = []
    redactions = 0
    for turn in turns:
        role = "USER" if turn["role"] == "user" else "ASSISTANT"
        ts = turn["timestamp"]
        header = f"### {role} {ts}" if ts else f"### {role}"
        lines, count = redacted_lines(turn["text"])
        redactions += count
        block = [header, ""]
        block.extend(lines)
        block.append("")
        blocks.append(block)
    return blocks, redactions


def build_subagent_blocks(reports: list[dict[str, Any]]) -> list[str]:
    """Fold each subagent's returned report into the transcript as a
    `### SUBAGENT <agentType> <iso-ts>` block — consistent with the live
    `### ROLE <ts>` turn convention."""
    out: list[str] = []
    redactions = 0
    for rep in reports:
        agent_label = rep.get("agent_type") or rep["agent_id"]
        ts = rep.get("timestamp") or ""
        header = f"### SUBAGENT {agent_label} {ts}".rstrip()
        lines, count = redacted_lines(rep["text"])
        redactions += count
        out.append(header)
        out.append("")
        out.extend(lines)
        out.append("")
    return out, redactions


def block_first_timestamp(block: list[str]) -> str | None:
    if not block:
        return None
    # Matches the live turn header `### ROLE <iso-ts>` (role is one uppercase word;
    # SUBAGENT blocks carry an agentType token before the ts, so anchor on the trailing
    # ISO timestamp).
    match = re.match(r"^###\s+\w+(?:\s+\S+)*?\s+(\d{4}-\d\d-\d\dT\S+)\s*$", block[0])
    if match:
        return match.group(1).strip() or None
    return None


def flatten_blocks(blocks: list[list[str]]) -> list[str]:
    flattened: list[str] = []
    for block in blocks:
        flattened.extend(block)
    return flattened


# --- output path ----------------------------------------------------------------------
def output_path(corpus_dir: Path, target_date: dt.date, session_id: str, part: int | None = None) -> Path:
    suffix = f"__part{part}.md" if part is not None else ".md"
    return (
        corpus_dir
        / PROFILE
        / f"{target_date:%Y}"
        / f"{target_date:%m}"
        / f"{target_date.isoformat()}__{PROFILE}__{session_id}{suffix}"
    )


# --- splitting (mirrors Hermes message-boundary split) --------------------------------
def base_frontmatter_for(
    meta: dict[str, Any], target_date: dt.date, settlement_policy: str
) -> dict[str, Any]:
    counts = meta["counts"]
    logical_session_id = stable_identity(
        IDENTITY_VERSION, SOURCE_NAMESPACE, PROFILE, meta["session_id"], target_date.isoformat()
    )
    # LIVE-MATCHING keys first (exact order/shape of ~/brain-intake/sessions/*.md),
    # then Claude-only extras appended at the end (dream synthesis splits frontmatter,
    # so trailing additive keys are harmless).
    return {
        "source": "claude-code",
        "source_namespace": SOURCE_NAMESPACE,
        "profile": PROFILE,
        "session_id": meta["session_id"],
        "platform": "claude-code",
        "chat_type": None,
        "display_name": None,
        "exported_for": "gbrain_dream_synthesize",
        "dream_generated": False,
        "exporter_owner": EXPORTER_OWNER,
        "provenance_kind": "human-session",
        "automated": False,
        "automation_origin": None,
        "settled": True,
        "settlement_policy": settlement_policy,
        "settled_at": normalize_iso(meta["source_ts_max"].isoformat()) if meta.get("source_ts_max") else None,
        "logical_identity_version": IDENTITY_VERSION,
        "logical_session_id": logical_session_id,
        "export_date": target_date.isoformat(),
        "first_timestamp": None,
        "last_timestamp": None,
        "message_count": 0,
        "redactions": meta.get("_redactions", 0),
        "tool_rows_excluded": counts["tool_rows_excluded"],
        "empty_assistant_rows_skipped": 0,
        # --- Claude-only extras (additive, after the live-matching block) ---
        "cwd": meta.get("cwd"),
        "git_branch": meta.get("git_branch"),
        "title": meta.get("title"),
        "session_entrypoint": meta.get("entrypoint"),
        "session_prompt_source": meta.get("prompt_source"),
        "session_permission_mode": meta.get("permission_mode"),
        "session_cwd": meta.get("cwd"),
    }


def part_frontmatter(base: dict[str, Any], blocks: list[list[str]], part_number: int | None, part_total: int | None) -> dict[str, Any]:
    fm = dict(base)
    timestamps = [ts for block in blocks if (ts := block_first_timestamp(block))]
    fm["first_timestamp"] = timestamps[0] if timestamps else None
    fm["last_timestamp"] = timestamps[-1] if timestamps else None
    fm["message_count"] = len(blocks)
    part_index = part_number or 1
    effective_part_total = part_total or 1
    fm["part_index"] = part_index
    fm["part_total"] = effective_part_total
    fm["logical_transcript_id"] = stable_identity(fm["logical_session_id"], part_index)
    if part_number is not None and part_total is not None:
        # `part` only when split, matching the live conditional. Re-insert so it lands
        # AFTER the live-matching block (right before the Claude-only extras), mirroring
        # the live file where `part` is the final live key.
        cwd = fm.pop("cwd", None)
        git_branch = fm.pop("git_branch", None)
        title = fm.pop("title", None)
        session_entrypoint = fm.pop("session_entrypoint", None)
        session_prompt_source = fm.pop("session_prompt_source", None)
        session_permission_mode = fm.pop("session_permission_mode", None)
        session_cwd = fm.pop("session_cwd", None)
        fm["part"] = f"{part_number}/{part_total}"
        fm["cwd"] = cwd
        fm["git_branch"] = git_branch
        fm["title"] = title
        fm["session_entrypoint"] = session_entrypoint
        fm["session_prompt_source"] = session_prompt_source
        fm["session_permission_mode"] = session_permission_mode
        fm["session_cwd"] = session_cwd
    return fm


def rendered_part_length(base: dict[str, Any], session_id: str, blocks: list[list[str]], pn: int | None, pt: int | None, sub_blocks: list[str] | None) -> int:
    return len(render_document(part_frontmatter(base, blocks, pn, pt), session_id, flatten_blocks(blocks), sub_blocks))


def split_message_blocks(base_frontmatter, session_id, message_blocks, sub_blocks):
    """Split at turn boundaries when the rendered part exceeds the threshold (Hermes parity).
    Subagent block only attaches to the final part."""
    if rendered_part_length(base_frontmatter, session_id, message_blocks, None, None, sub_blocks) <= SPLIT_THRESHOLD_CHARS:
        return [message_blocks]
    parts: list[list[list[str]]] = []
    current: list[list[str]] = []
    for block in message_blocks:
        candidate = current + [block]
        if current and rendered_part_length(base_frontmatter, session_id, candidate, 999, 999, None) > SPLIT_THRESHOLD_CHARS:
            parts.append(current)
            current = [block]
        else:
            current = candidate
    if current:
        parts.append(current)
    while len(parts) > 1:
        tail_len = rendered_part_length(base_frontmatter, session_id, parts[-1], len(parts), len(parts), sub_blocks)
        if tail_len >= MIN_SPLIT_PART_CHARS:
            break
        parts[-2].extend(parts[-1])
        parts.pop()
    return parts


# --- atomic IO ------------------------------------------------------------------------
def write_if_changed(path: Path, text: str) -> str:
    existed = path.exists()
    if existed:
        current = path.read_text(encoding="utf-8")
        if sha256_text(current) == sha256_text(text):
            return "unchanged"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False) as handle:
        tmp_name = handle.name
        handle.write(text)
    os.replace(tmp_name, path)
    return "changed" if existed else "created"


def load_manifest_index(corpus_dir: Path) -> tuple[dict[tuple[str, str, str, int], dict[str, Any]], dict[str, str]]:
    """Returns (keyed records, {session_id: rendered_sha256_of_part0}) for dedup."""
    manifest_path = corpus_dir / ".manifest.jsonl"
    by_key: dict[tuple[str, str, str, int], dict[str, Any]] = {}
    sha_by_session: dict[str, str] = {}
    if not manifest_path.exists():
        return by_key, sha_by_session
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
        by_key[key] = entry  # preserve ALL records (incl. foreign Hermes lanes) for write-back
        # Dedup index is scoped to our own profile only.
        if str(entry.get("profile") or "") == PROFILE and int(entry.get("part") or 0) == 0:
            sha_by_session[str(entry.get("session_id") or "")] = str(entry.get("rendered_sha256") or "")
    return by_key, sha_by_session


def manifest_entry_owned(entry: dict[str, Any]) -> bool:
    if str(entry.get("profile") or "") != PROFILE:
        return False
    owner = entry.get("exporter_owner")
    # Legacy Claude exporter rows predate exporter_owner. Profile ownership and
    # their lane-constrained output path are the compatibility boundary.
    return owner in (None, "", EXPORTER_OWNER)


def manifest_entry_automated(entry: dict[str, Any]) -> bool:
    if not manifest_entry_owned(entry):
        return False
    automated_marker = entry.get("automated")
    dream_marker = entry.get("dream_generated")
    if automated_marker is True or str(automated_marker).lower() in {"true", "yes", "1"}:
        return True
    if dream_marker is True or str(dream_marker).lower() in {"true", "yes", "1"}:
        return True
    if str(entry.get("provenance_kind") or "human-session") != "human-session":
        return True
    origin_values = (
        entry.get("automation_origin"),
        entry.get("generated_by"),
        entry.get("producer"),
    )
    if any(
        any(token in str(value).lower() for token in AUTOMATION_ORIGIN_TOKENS)
        for value in origin_values
        if value not in (None, "")
    ):
        return True
    if not (
        entry.get("session_entrypoint") == "sdk-cli"
        and entry.get("session_prompt_source") == "sdk"
        and entry.get("session_permission_mode") == "auto"
    ):
        return False
    return is_gbrain_runtime_cwd(entry.get("session_cwd") or entry.get("cwd"))


def owned_session_entries(
    by_key: dict[tuple[str, str, str, int], dict[str, Any]], session_id: str
) -> list[dict[str, Any]]:
    return [
        entry
        for entry in by_key.values()
        if manifest_entry_owned(entry) and str(entry.get("session_id") or "") == session_id
    ]


def manifest_entry_is_settled_v1(
    entry: dict[str, Any], session_id: str, target_date: dt.date
) -> bool:
    part_index = int(entry.get("part") or 1)
    part_total = int(entry.get("part_total") or 1)
    logical_session_id = stable_identity(
        IDENTITY_VERSION, SOURCE_NAMESPACE, PROFILE, session_id, target_date.isoformat()
    )
    return (
        entry.get("settled") is True
        and is_literal_identity_version_one(entry.get("logical_identity_version"))
        and entry.get("source_namespace") == SOURCE_NAMESPACE
        and entry.get("profile") == PROFILE
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
    jsonl_path: Path,
    target_date: dt.date,
    session_id: str,
    prior: list[dict[str, Any]],
    rendered_parts: list[tuple[str, dict[str, Any], int | None]],
    stale_quarantine_dir: Path,
) -> list[tuple[str, dict[str, Any], int | None]]:
    """Prove and prepare a deterministic legacy -> settled identity v1 upgrade.

    Files are not mutated here.  The caller first validates every invariant,
    then atomically replaces each transcript and finally the manifest.  If a
    process was interrupted between those replacements, an already-upgraded
    transcript is accepted only when it is byte-identical to the expected v1
    render; the still-legacy manifest remains fail-closed until this resumes.
    """
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

    rendered_by_part = {int(part or 0): (text, manifest, part) for text, manifest, part in rendered_parts}
    if set(prior_by_part) != set(rendered_by_part):
        raise ValueError(
            f"legacy/current part set mismatch: legacy={sorted(prior_by_part)} "
            f"current={sorted(rendered_by_part)}"
        )

    migrated: list[tuple[str, dict[str, Any], int | None]] = []
    for part_key in sorted(rendered_by_part):
        new_text, current_manifest, part = rendered_by_part[part_key]
        legacy = prior_by_part[part_key]
        expected_path = output_path(corpus_dir, target_date, session_id, part)
        owned_path = safe_owned_output_path(corpus_dir, legacy)
        if owned_path is None or owned_path.resolve(strict=False) != expected_path.resolve(strict=False):
            raise ValueError(f"legacy output path mismatch for part {part_key}")

        source_path = legacy.get("source_path")
        if not isinstance(source_path, str) or not source_path:
            raise ValueError(f"legacy source_path is missing for part {part_key}")
        if Path(source_path).expanduser().resolve(strict=False) != jsonl_path.resolve(strict=False):
            raise ValueError(f"legacy source_path mismatch for part {part_key}")
        if legacy.get("source_started_at") != current_manifest.get("source_started_at"):
            raise ValueError(f"settled source invariant changed: source_started_at part {part_key}")

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
        legacy_text: str | None
        if active_text is not None and not active_is_v1:
            if sha256_text(active_text) != legacy_hash:
                raise ValueError(f"legacy output hash mismatch for part {part_key}")
            legacy_text = active_text
        elif quarantined_text is not None:
            # Resumable stale-partial replacement: a crash may have happened
            # after the deterministic quarantine move and before manifest swap.
            legacy_text = quarantined_text
        elif active_is_v1:
            legacy_text = None
        else:
            raise ValueError(f"legacy output and deterministic quarantine are missing for part {part_key}")

        actual_body = expected_body
        if legacy_text is not None:
            actual_meta, actual_body = parse_frontmatter_document(legacy_text)
            expected_part = expected_meta.get("part")
            required = {
                "source": "claude-code",
                "profile": PROFILE,
                "session_id": session_id,
                "platform": "claude-code",
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
            if actual_meta.get("part") != expected_part:
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

        source_drift_fields = [
            key
            for key in ("source_ended_at", "source_message_count")
            if legacy.get(key) != current_manifest.get(key)
        ]
        body_drift = actual_body != expected_body
        migration_kind = "legacy-to-settled-identity-v1"
        if body_drift:
            legacy_end = parse_iso(str(legacy.get("source_ended_at") or ""))
            current_end = parse_iso(str(current_manifest.get("source_ended_at") or ""))
            legacy_count = legacy.get("source_message_count")
            current_count = current_manifest.get("source_message_count")
            if not (
                legacy_end is not None
                and current_end is not None
                and current_end > legacy_end
                and isinstance(legacy_count, int)
                and not isinstance(legacy_count, bool)
                and isinstance(current_count, int)
                and not isinstance(current_count, bool)
                and current_count > legacy_count
            ):
                raise ValueError(
                    f"legacy body drift is not explained by monotonic settled source growth for part {part_key}"
                )
            migration_kind = "stale-partial-to-settled-identity-v1"
        elif active_is_v1 and source_drift_fields and quarantined_text is None:
            raise ValueError(
                f"cannot resume source-drift migration without its deterministic quarantine for part {part_key}"
            )

        migrated_manifest = dict(legacy)
        migrated_manifest.update(current_manifest)
        migrated_manifest.update(
            {
                "output_path": str(expected_path),
                "legacy_rendered_sha256": legacy_hash,
                "legacy_body_sha256": sha256_text(actual_body),
                "body_sha256": sha256_text(expected_body),
                "metadata_migration": migration_kind,
                "legacy_export_date_policy": "source-start-utc",
                "rendered_sha256": sha256_text(new_text),
            }
        )
        if source_drift_fields:
            migrated_manifest["legacy_source_drift_fields"] = source_drift_fields
        if body_drift:
            migrated_manifest.update(
                {
                    "stale_partial_quarantined_path": str(quarantine_path),
                    "stale_partial_tombstone": True,
                    "stale_partial_disposition": "quarantined-and-replaced-after-source-settlement",
                }
            )
        if not manifest_entry_is_settled_v1(migrated_manifest, session_id, target_date):
            raise ValueError(f"prepared manifest failed v1 identity validation for part {part_key}")
        migrated.append((new_text, migrated_manifest, part))
    return migrated


def safe_owned_output_path(corpus_dir: Path, entry: dict[str, Any]) -> Path | None:
    raw = entry.get("output_path")
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = corpus_dir / path
    try:
        resolved = path.resolve(strict=False)
        owned_root = (corpus_dir / PROFILE).resolve(strict=False)
        if resolved != owned_root and owned_root not in resolved.parents:
            return None
    except OSError:
        return None
    return path


def output_session_id(path: Path) -> str | None:
    match = re.match(
        rf"^\d{{4}}-\d{{2}}-\d{{2}}__{re.escape(PROFILE)}__(.+?)(?:__part\d+)?\.md$",
        path.name,
    )
    return match.group(1) if match else None


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
    if not path.exists() or not path.is_file():
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


def reconcile_automated_exports(
    corpus_dir: Path,
    quarantine_dir: Path,
    by_key: dict[tuple[str, str, str, int], dict[str, Any]],
    discovered_automated_ids: set[str],
) -> dict[str, Any]:
    automated_ids = known_automated_session_ids(
        quarantine_dir, by_key, discovered_automated_ids
    )
    tombstone_registry = quarantine_dir / "automated-session-tombstones.json"
    removed_manifest_keys: list[list[Any]] = []
    candidate_paths: set[Path] = set()
    for key, entry in list(by_key.items()):
        if not manifest_entry_owned(entry):
            continue
        if str(entry.get("session_id") or "") not in automated_ids:
            continue
        path = safe_owned_output_path(corpus_dir, entry)
        if path is not None:
            candidate_paths.add(path)
        removed_manifest_keys.append([*key])
        del by_key[key]

    # Catch legacy orphan files whose manifest row was lost. The session UUID
    # is matched inside the exporter-owned Claude lane only.
    claude_root = corpus_dir / PROFILE
    if claude_root.exists():
        candidate_paths.update(
            path
            for path in claude_root.rglob("*.md")
            if output_session_id(path) in automated_ids
        )

    quarantined = [
        moved
        for path in sorted(candidate_paths)
        if (moved := quarantine_output(path, corpus_dir, quarantine_dir)) is not None
    ]
    atomic_write_secure(
        tombstone_registry,
        json.dumps(
            {
                "schema": "gbrain-automated-session-tombstones/v1",
                "profile": PROFILE,
                "session_ids": sorted(automated_ids),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    tombstone_mirror = corpus_dir / "automated-session-tombstones.json"
    atomic_copy_secure(tombstone_registry, tombstone_mirror)
    if tombstone_registry.read_bytes() != tombstone_mirror.read_bytes():
        raise RuntimeError("automated-session tombstone mirror is not byte-identical")
    return {
        "automated_session_ids": sorted(automated_ids),
        "manifest_rows_removed": len(removed_manifest_keys),
        "manifest_keys_removed": removed_manifest_keys,
        "outputs_quarantined": quarantined,
        "tombstone_registry": str(tombstone_registry),
        "tombstone_mirror": str(tombstone_mirror),
        "tombstone_sha256": sha256_file(tombstone_registry),
    }


def known_automated_session_ids(
    quarantine_dir: Path,
    by_key: dict[tuple[str, str, str, int], dict[str, Any]],
    discovered_automated_ids: set[str] | None = None,
) -> set[str]:
    automated_ids = set(discovered_automated_ids or set())
    tombstone_registry = quarantine_dir / "automated-session-tombstones.json"
    if tombstone_registry.exists():
        try:
            stored = json.loads(tombstone_registry.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            # Corrupt safety state is fail-closed: callers cannot silently
            # proceed and risk resurrecting a known automated session.
            raise RuntimeError(
                f"invalid automated-session tombstone registry: {tombstone_registry}"
            ) from exc
        if (
            not isinstance(stored, dict)
            or stored.get("schema") != "gbrain-automated-session-tombstones/v1"
            or stored.get("profile") != PROFILE
            or not isinstance(stored.get("session_ids"), list)
        ):
            raise RuntimeError(
                f"invalid automated-session tombstone registry: {tombstone_registry}"
            )
        validated_ids: list[str] = []
        for value in stored["session_ids"]:
            if not isinstance(value, str) or not value or value != value.strip():
                raise RuntimeError(
                    f"invalid automated-session tombstone registry: {tombstone_registry}"
                )
            validated_ids.append(value)
        if len(set(validated_ids)) != len(validated_ids):
            raise RuntimeError(
                f"invalid automated-session tombstone registry: {tombstone_registry}"
            )
        automated_ids.update(validated_ids)
    automated_ids.update(
        str(entry.get("session_id") or "")
        for entry in by_key.values()
        if manifest_entry_automated(entry)
    )
    automated_ids.discard("")
    return automated_ids


def withdraw_unsettled_legacy_exports(
    corpus_dir: Path,
    quarantine_dir: Path,
    by_key: dict[tuple[str, str, str, int], dict[str, Any]],
    session_ids: set[str],
) -> dict[str, Any]:
    removed_manifest_keys: list[list[Any]] = []
    candidate_paths: set[Path] = set()
    for key, entry in list(by_key.items()):
        if not manifest_entry_owned(entry):
            continue
        if str(entry.get("session_id") or "") not in session_ids:
            continue
        # Structurally settled v1 exports are immutable. Only legacy exports,
        # which could have been written while growing, are eligible here.
        if entry.get("settled") is True:
            continue
        path = safe_owned_output_path(corpus_dir, entry)
        if path is not None:
            candidate_paths.add(path)
        removed_manifest_keys.append([*key])
        del by_key[key]

    claude_root = corpus_dir / PROFILE
    if claude_root.exists():
        # Orphans have no structural settled marker, so they are treated as
        # legacy and withdrawn until the source becomes settled.
        candidate_paths.update(
            path
            for path in claude_root.rglob("*.md")
            if output_session_id(path) in session_ids
        )
    quarantined = [
        moved
        for path in sorted(candidate_paths)
        if (moved := quarantine_output(path, corpus_dir, quarantine_dir)) is not None
    ]
    return {
        "session_ids": sorted(session_ids),
        "manifest_rows_removed": len(removed_manifest_keys),
        "manifest_keys_removed": removed_manifest_keys,
        "outputs_quarantined": quarantined,
    }


def write_manifest(corpus_dir: Path, by_key: dict, entries: list[dict[str, Any]]) -> str:
    manifest_path = corpus_dir / ".manifest.jsonl"
    existed = manifest_path.exists()
    incoming_base_keys = {
        (str(e.get("profile") or ""), str(e.get("session_id") or ""), str(e.get("export_date") or ""))
        for e in entries
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
    if existed:
        current = manifest_path.read_text(encoding="utf-8")
        if sha256_text(current) == sha256_text(content):
            return "unchanged"
    corpus_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(corpus_dir), prefix=".manifest.", delete=False) as handle:
        tmp_name = handle.name
        handle.write(content)
    os.replace(tmp_name, manifest_path)
    return "changed" if existed else "created"


# --- discovery ------------------------------------------------------------------------
def discover_sessions(projects_root: Path, projects_filter: str | None) -> list[Path]:
    if not projects_root.is_dir():
        return []
    project_dirs = [d for d in sorted(projects_root.iterdir()) if d.is_dir()]
    if projects_filter:
        project_dirs = [
            d for d in project_dirs
            if projects_filter in d.name or glob.fnmatch.fnmatch(d.name, projects_filter)
        ]
    sessions: list[Path] = []
    for d in project_dirs:
        sessions.extend(sorted(d.glob("*.jsonl")))
    return sessions


def settlement_for(
    meta: dict[str, Any],
    jsonl_path: Path,
    source_paths: list[Path],
    settled_through: dt.date,
    quiet_minutes: int,
    now: dt.datetime,
) -> tuple[str | None, str | None]:
    last = meta.get("source_ts_max") or meta.get("ts_max")
    if not isinstance(last, dt.datetime):
        return None, "skipped_no_timestamp"
    if last.tzinfo is None:
        last = last.replace(tzinfo=dt.timezone.utc)
    last_local = last.astimezone(LOCAL_TZ)
    if last_local.date() > settled_through:
        return None, "skipped_unsettled_day"
    if meta.get("explicit_ended") is True:
        return "explicit-ended", None
    cutoff = now - dt.timedelta(minutes=quiet_minutes)
    try:
        source_mtime = max(
            dt.datetime.fromtimestamp(path.stat().st_mtime, LOCAL_TZ)
            for path in source_paths
        )
    except OSError:
        return None, "skipped_source_missing"
    if last_local > cutoff or source_mtime > cutoff:
        return None, "skipped_quiet_window"
    return "closed-day-quiet-window", None


def settled_source_drifted(prior: list[dict[str, Any]], meta: dict[str, Any], source_sha256: str) -> bool:
    exact_hashes = {
        str(entry.get("source_sha256"))
        for entry in prior
        if isinstance(entry.get("source_sha256"), str) and entry.get("source_sha256")
    }
    if exact_hashes:
        return exact_hashes != {source_sha256}

    # Legacy compatibility: old manifests did not record raw source hashes.
    # A changed end timestamp or source row count is enough to flag drift. If
    # neither changes, we still never rewrite the logical session.
    current_end = meta["ts_max"].astimezone(dt.timezone.utc).isoformat() if meta.get("ts_max") else None
    current_count = meta["counts"]["conversation_lines"]
    prior_ends = {entry.get("source_ended_at") for entry in prior}
    prior_counts = {entry.get("source_message_count") for entry in prior}
    return (prior_ends and current_end not in prior_ends) or (prior_counts and current_count not in prior_counts)


# --- per-session export ---------------------------------------------------------------
def export_session(
    jsonl_path: Path,
    corpus_dir: Path,
    include_subagents: bool,
    since: dt.date | None,
    by_key: dict[tuple[str, str, str, int], dict[str, Any]],
    settled_through: dt.date,
    quiet_minutes: int,
    now: dt.datetime,
    excluded_session_ids: set[str] | None = None,
) -> dict[str, Any] | None:
    rows = load_jsonl(jsonl_path)
    if not rows:
        return {"status": "skipped_empty", "session_id": jsonl_path.stem}

    meta = parse_session(rows)
    session_id = meta["session_id"] or jsonl_path.stem
    meta["session_id"] = session_id

    # Never export GBrain's own Claude SDK jobs into the corpus consumed by
    # dream synthesis. Raw Claude JSONL remains the audit source; this only
    # closes the recursive intake edge.
    if session_id in (excluded_session_ids or set()) or is_automated_gbrain_session(meta):
        return {"status": "skipped_automated", "session_id": session_id}

    # STUB detection: zero genuine conversation turns.
    if not meta["turns"]:
        return {"status": "skipped_stub", "session_id": session_id}

    if meta["ts_min"] is None:
        return {"status": "skipped_no_timestamp", "session_id": session_id}

    source_paths = contributing_source_paths(jsonl_path, include_subagents)
    meta["source_ts_max"] = latest_source_timestamp(meta, source_paths)
    source_sha256 = source_tree_sha256(jsonl_path, source_paths)
    prior = owned_session_entries(by_key, session_id)

    # The session start date, not mutable bytes, anchors its logical identity.
    # New exports use the Bangkok date. Incident-era exports used the UTC
    # start date; migration must preserve that proven legacy date/path so old
    # path/hash completion receipts remain applicable.
    target_date = meta["ts_min"].astimezone(LOCAL_TZ).date()
    if prior:
        raw_prior_dates = {str(entry.get("export_date") or "") for entry in prior}
        try:
            if len(raw_prior_dates) != 1:
                raise ValueError("legacy logical session spans multiple export dates")
            prior_date = dt.date.fromisoformat(next(iter(raw_prior_dates)))
        except ValueError as exc:
            return {
                "status": "legacy_migration_failed",
                "session_id": session_id,
                "error": str(exc),
                "settlement_date": meta["source_ts_max"].astimezone(LOCAL_TZ).date(),
            }
        if all(manifest_entry_is_settled_v1(entry, session_id, prior_date) for entry in prior):
            return {
                "status": "settled_drift"
                if settled_source_drifted(prior, meta, source_sha256)
                else "already_settled",
                "session_id": session_id,
                "settlement_date": meta["source_ts_max"].astimezone(LOCAL_TZ).date(),
            }
        legacy_source_date = meta["ts_min"].astimezone(dt.timezone.utc).date()
        if prior_date != legacy_source_date:
            return {
                "status": "legacy_migration_failed",
                "session_id": session_id,
                "error": "legacy export_date does not match the source-start UTC policy",
                "settlement_date": meta["source_ts_max"].astimezone(LOCAL_TZ).date(),
            }
        target_date = prior_date
    if since and target_date < since:
        return {"status": "skipped_since", "session_id": session_id}

    settlement_policy, skip_status = settlement_for(
        meta, jsonl_path, source_paths, settled_through, quiet_minutes, now
    )
    if skip_status:
        return {
            "status": "withdraw_unsettled" if prior else skip_status,
            "session_id": session_id,
            "skip_reason": skip_status,
        }

    # Subagent reports.
    sub_reports: list[dict[str, Any]] = []
    if include_subagents:
        session_dir = jsonl_path.with_suffix("")  # <slug>/<sessionId>
        sub_reports = load_subagent_reports(session_dir)

    message_blocks, body_redactions = build_transcript_blocks(meta["turns"])
    sub_blocks, sub_redactions = build_subagent_blocks(sub_reports) if sub_reports else ([], 0)
    total_redactions = body_redactions + sub_redactions
    meta["_redactions"] = total_redactions

    base_fm = base_frontmatter_for(meta, target_date, settlement_policy or "closed-day-quiet-window")
    logical_session_id = base_fm["logical_session_id"]
    base_manifest = {
        "source_namespace": SOURCE_NAMESPACE,
        "profile": PROFILE,
        "session_id": session_id,
        "exporter_owner": EXPORTER_OWNER,
        "provenance_kind": "human-session",
        "automated": False,
        "automation_origin": None,
        "dream_generated": False,
        "settled": True,
        "settlement_policy": settlement_policy,
        "settled_at": normalize_iso(meta["source_ts_max"].isoformat()) if meta.get("source_ts_max") else None,
        "logical_identity_version": IDENTITY_VERSION,
        "logical_session_id": logical_session_id,
        "session_entrypoint": meta.get("entrypoint"),
        "session_prompt_source": meta.get("prompt_source"),
        "session_permission_mode": meta.get("permission_mode"),
        "session_cwd": meta.get("cwd"),
        "source_path": str(jsonl_path),
        "source_sha256": source_sha256,
        "source_started_at": meta["ts_min"].astimezone(dt.timezone.utc).isoformat(),
        "source_ended_at": meta["ts_max"].astimezone(dt.timezone.utc).isoformat() if meta["ts_max"] else None,
        "source_tree_ended_at": meta["source_ts_max"].astimezone(dt.timezone.utc).isoformat() if meta["source_ts_max"] else None,
        "source_message_count": meta["counts"]["conversation_lines"],
        "message_count": len(message_blocks),
        "redactions": total_redactions,
        "tool_rows_excluded": meta["counts"]["tool_rows_excluded"],
        "tool_metadata_rows_excluded": meta["counts"]["tool_metadata_rows_excluded"],
        "export_date": target_date.isoformat(),
    }

    split_blocks = split_message_blocks(base_fm, session_id, message_blocks, sub_blocks)
    total_parts = len(split_blocks)
    rendered_parts: list[tuple[str, dict[str, Any], int | None]] = []
    for index, blocks in enumerate(split_blocks, start=1):
        is_split = total_parts > 1
        is_last = index == total_parts
        part_subs = sub_blocks if (is_last and sub_blocks) else None
        fm = part_frontmatter(base_fm, blocks, index if is_split else None, total_parts if is_split else None)
        text = render_document(fm, session_id, flatten_blocks(blocks), part_subs)
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
        rendered_parts.append((text, manifest, index if is_split else None))

    if prior:
        try:
            rendered_parts = prepare_legacy_migration(
                corpus_dir=corpus_dir,
                jsonl_path=jsonl_path,
                target_date=target_date,
                session_id=session_id,
                prior=prior,
                rendered_parts=rendered_parts,
                stale_quarantine_dir=corpus_dir.parent
                / "quarantine"
                / "stale-settled-claude",
            )
        except (OSError, ValueError) as exc:
            return {
                "status": "legacy_migration_failed",
                "session_id": session_id,
                "error": str(exc),
                "settlement_date": meta["source_ts_max"].astimezone(LOCAL_TZ).date(),
            }
        migration_status = (
            "stale_partial_replacement"
            if any(
                manifest.get("metadata_migration")
                == "stale-partial-to-settled-identity-v1"
                for _text, manifest, _part in rendered_parts
            )
            else "legacy_migration"
        )
        return {
            "status": migration_status,
            "session_id": session_id,
            "target_date": target_date,
            "rendered_parts": rendered_parts,
            "unchanged": False,
            "subagents": len(sub_reports),
            "settlement_date": meta["source_ts_max"].astimezone(LOCAL_TZ).date(),
        }

    return {
        "status": "rendered",
        "session_id": session_id,
        "target_date": target_date,
        "rendered_parts": rendered_parts,
        "unchanged": False,
        "subagents": len(sub_reports),
        "settlement_date": meta["source_ts_max"].astimezone(LOCAL_TZ).date(),
    }


# --- main ------------------------------------------------------------------------------
def scheduled_export_status(totals: dict[str, Any]) -> str:
    fatal_keys = (
        "settled_drift",
        "existing_output_drift",
        "legacy_migration_failed",
        "stale_partial_replacement_failed",
    )
    return "failed" if any(totals.get(key) for key in fatal_keys) else "success"


def main() -> int:
    args = parse_args()
    real_corpus_dir = Path(args.corpus_dir).expanduser().resolve()
    now = local_now(args.now)
    settled_through = requested_local_date(args.settled_through, now)
    if args.quiet_minutes < 0:
        print("error: --quiet-minutes must be non-negative", file=sys.stderr)
        return 2
    if args.scheduled and settled_through >= now.date():
        print("error: scheduled export requires a prior closed Bangkok day", file=sys.stderr)
        return 2

    if args.dry_run:
        preview = Path(tempfile.mkdtemp(prefix="claude-corpus-preview-"))
        corpus_dir = preview
        print(f"[dry-run] preview corpus dir: {corpus_dir}", file=sys.stderr)
    else:
        corpus_dir = real_corpus_dir

    since = dt.date.fromisoformat(args.since) if args.since else None
    # Read the dedup index from the WRITE target (the preview dir in dry-run, so the
    # preview manifest never inherits the real corpus's foreign Hermes records).
    by_key, _ = load_manifest_index(corpus_dir)

    quarantine_dir = (
        Path(args.quarantine_dir).expanduser().resolve()
        if args.quarantine_dir
        else corpus_dir.parent / "quarantine" / "automated-claude"
    )
    known_automated_ids = known_automated_session_ids(quarantine_dir, by_key)

    sessions = discover_sessions(Path(args.projects_root).expanduser().resolve(), args.projects)

    totals = {
        "scanned": 0,
        "rendered": 0,
        "created": 0,
        "changed": 0,
        "unchanged": 0,
        "skipped_stub": 0,
        "skipped_empty": 0,
        "skipped_since": 0,
        "skipped_no_timestamp": 0,
        "skipped_unsettled_day": 0,
        "skipped_quiet_window": 0,
        "skipped_source_missing": 0,
        "skipped_automated": 0,
        "already_settled": 0,
        "settled_drift": 0,
        "legacy_migration": 0,
        "legacy_migration_parts": 0,
        "legacy_migration_failed": 0,
        "stale_partial_replacement": 0,
        "stale_partial_replacement_parts": 0,
        "stale_partial_replacement_failed": 0,
        "existing_output_drift": 0,
        "withdraw_unsettled": 0,
        "part_files": 0,
        "subagent_sessions": 0,
        "scheduled": bool(args.scheduled),
        "settled_through": settled_through.isoformat(),
        "quiet_minutes": args.quiet_minutes,
        "exporter": EXPORTER_OWNER,
    }
    manifest_entries: list[dict[str, Any]] = []
    exported_count = 0
    automated_session_ids: set[str] = set()
    unsettled_prior_ids: set[str] = set()
    selected_settlement_dates: set[str] = set()
    selected_export_dates: set[str] = set()
    selected_manifest_keys: list[dict[str, Any]] = []
    output_paths: list[str] = []
    stale_partial_records: list[dict[str, Any]] = []

    for jsonl_path in sessions:
        totals["scanned"] += 1
        result = export_session(
            jsonl_path,
            corpus_dir,
            args.include_subagents,
            since,
            by_key,
            settled_through,
            args.quiet_minutes,
            now,
            known_automated_ids,
        )
        if result is None:
            continue
        status = result["status"]
        if status not in {"rendered", "legacy_migration", "stale_partial_replacement"}:
            totals[status] = totals.get(status, 0) + 1
            if status == "skipped_automated":
                automated_session_ids.add(str(result["session_id"]))
            if status == "withdraw_unsettled":
                unsettled_prior_ids.add(str(result["session_id"]))
            if result.get("settlement_date"):
                selected_settlement_dates.add(result["settlement_date"].isoformat())
            if status == "legacy_migration_failed":
                print(
                    f"error: safe legacy migration refused for logical session "
                    f"{result['session_id']}: {result.get('error', 'unknown invariant failure')}",
                    file=sys.stderr,
                )
            continue

        if status == "legacy_migration":
            totals["legacy_migration"] += 1
            totals["legacy_migration_parts"] += len(result["rendered_parts"])
        elif status == "stale_partial_replacement":
            totals["stale_partial_replacement"] += 1
            totals["stale_partial_replacement_parts"] += len(result["rendered_parts"])
        else:
            totals["rendered"] += 1
        if result["subagents"]:
            totals["subagent_sessions"] += 1
        selected_settlement_dates.add(result["settlement_date"].isoformat())
        selected_export_dates.add(result["target_date"].isoformat())

        planned = [
            (
                text,
                manifest,
                part,
                output_path(corpus_dir, result["target_date"], result["session_id"], part),
            )
            for text, manifest, part in result["rendered_parts"]
        ]
        conflicting = [] if status in {"legacy_migration", "stale_partial_replacement"} else [
            path
            for text, _manifest, _part, path in planned
            if path.exists() and sha256_file(path) != sha256_text(text)
        ]
        if conflicting:
            totals["existing_output_drift"] += 1
            print(
                f"error: settled output drift for logical session {result['session_id']}; refusing rewrite",
                file=sys.stderr,
            )
            continue

        if status == "stale_partial_replacement":
            try:
                session_stale_records: list[dict[str, Any]] = []
                for text, manifest, _part, out_path in planned:
                    legacy_hash = str(manifest["legacy_rendered_sha256"])
                    quarantine_path = Path(str(manifest["stale_partial_quarantined_path"]))
                    if out_path.exists() and sha256_file(out_path) == legacy_hash:
                        moved = quarantine_output(
                            out_path,
                            corpus_dir,
                            corpus_dir.parent / "quarantine" / "stale-settled-claude",
                        )
                        if moved is None or Path(moved).resolve(strict=False) != quarantine_path.resolve(strict=False):
                            raise RuntimeError("stale partial did not reach its deterministic quarantine")
                    elif out_path.exists() and sha256_file(out_path) == sha256_text(text):
                        if not quarantine_path.is_file() or sha256_file(quarantine_path) != legacy_hash:
                            raise RuntimeError("replacement exists without its sealed stale-partial quarantine")
                    elif not out_path.exists():
                        if not quarantine_path.is_file() or sha256_file(quarantine_path) != legacy_hash:
                            raise RuntimeError("stale partial and deterministic quarantine are both missing")
                    else:
                        raise RuntimeError("active stale-partial path contains unrecognized bytes")
                    session_stale_records.append(
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
                            "disposition": "quarantined-and-replaced-after-source-settlement",
                        }
                    )
                stale_partial_records.extend(session_stale_records)
            except (OSError, RuntimeError) as exc:
                totals["stale_partial_replacement_failed"] += 1
                print(
                    f"error: stale partial replacement failed for logical session "
                    f"{result['session_id']}: {exc}",
                    file=sys.stderr,
                )
                continue

        for text, manifest, part, out_path in planned:
            status_w = write_if_changed(out_path, text)
            if status_w == "created":
                totals["created"] += 1
            elif status_w == "changed":
                totals["changed"] += 1
            else:
                totals["unchanged"] += 1
            if part is not None:
                totals["part_files"] += 1
            manifest["output_path"] = str(out_path)
            manifest_entries.append(manifest)
            output_paths.append(str(out_path))
            selected_manifest_keys.append(
                {
                    "profile": manifest["profile"],
                    "session_id": manifest["session_id"],
                    "export_date": manifest["export_date"],
                    "part": manifest.get("part"),
                }
            )

        exported_count += 1
        if args.limit is not None and exported_count >= args.limit:
            break

    reconciliation = reconcile_automated_exports(
        corpus_dir, quarantine_dir, by_key, automated_session_ids
    )
    unsettled_reconciliation = withdraw_unsettled_legacy_exports(
        corpus_dir,
        corpus_dir.parent / "quarantine" / "unsettled-claude",
        by_key,
        unsettled_prior_ids,
    )
    stale_registry = corpus_dir.parent / "quarantine" / "stale-settled-claude" / "stale-partial-tombstones.json"
    stale_registry_sha256 = (
        write_stale_partial_tombstones(stale_registry, stale_partial_records)
        if stale_partial_records or stale_registry.exists()
        else None
    )
    manifest_entries.sort(key=lambda item: (item["profile"], item["session_id"], item["export_date"], int(item.get("part") or 0)))
    manifest_status = write_manifest(corpus_dir, by_key, manifest_entries)
    totals["manifest"] = manifest_status
    totals["automated_reconciliation"] = reconciliation
    totals["unsettled_reconciliation"] = unsettled_reconciliation
    totals["stale_partial_tombstones"] = {
        "records_written": len(stale_partial_records),
        "registry": str(stale_registry) if stale_registry_sha256 else None,
        "sha256": stale_registry_sha256,
    }
    totals["selected_settlement_dates"] = sorted(selected_settlement_dates)
    totals["selected_export_dates"] = sorted(selected_export_dates)
    totals["selected_manifest_keys"] = selected_manifest_keys
    totals["output_paths"] = sorted(output_paths)
    final_manifest, _ = load_manifest_index(corpus_dir)
    remaining_legacy: list[list[Any]] = []
    for key, entry in final_manifest.items():
        if not manifest_entry_owned(entry):
            continue
        try:
            entry_date = dt.date.fromisoformat(str(entry.get("export_date") or ""))
            is_v1 = manifest_entry_is_settled_v1(
                entry, str(entry.get("session_id") or ""), entry_date
            )
        except (TypeError, ValueError):
            is_v1 = False
        if not is_v1:
            remaining_legacy.append([*key])
    totals["remaining_legacy_manifest_keys"] = remaining_legacy
    totals["remaining_legacy_manifest_rows"] = len(remaining_legacy)
    # Historical pre-v1 rows are preserved evidence. Scheduled Dream now
    # selects the exact settlement night and operator closeout tombstones make
    # the old backlog ineligible, so their continued presence is diagnostic,
    # not a reason to withhold the current night's exporter success receipt.
    totals["preserved_legacy_manifest_rows"] = totals["remaining_legacy_manifest_rows"]
    totals["status"] = scheduled_export_status(totals)

    if args.summary_file:
        atomic_write_secure(
            Path(args.summary_file).expanduser().resolve(),
            json.dumps(totals, indent=2, sort_keys=True) + "\n",
        )

    print(json.dumps(totals, indent=2, sort_keys=True))
    print(
        f"summary: scanned={totals['scanned']} rendered={totals['rendered']} "
        f"created={totals['created']} changed={totals['changed']} unchanged={totals['unchanged']} "
        f"stubs={totals['skipped_stub']} corpus_dir={corpus_dir}"
        + ("  [DRY-RUN — real corpus untouched]" if args.dry_run else "")
    )
    return 3 if totals["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
