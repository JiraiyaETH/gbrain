#!/usr/bin/env python3
"""Fail-closed meeting completion orchestrator.

The judgment agent may enrich meeting/entity content, but it is never allowed to
consume the retry candidate.  It runs in a disposable corpus copy with an
allowlisted read surface and no database credentials or tools.  This controller
owns status completion and marks a meeting complete only after an authoritative
filesystem diff, narrow DB imports, shadow QA, a content-hash gate, edge
materialization, and DB postcondition checks.

The retry ledger is independent of page status.  A crash leaves an ``in_progress``
entry whose lease expires into a retry; an audited checkpoint lets the next run
resume deterministic poststeps without paying for or duplicating agent work.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import difflib
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


# PyYAML is a runtime dependency, not mutable operator state.  Resolve the
# vendored pure-Python package before importing it so launchd cannot silently
# substitute ~/Library/Python/site-packages.
_EARLY_SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_DIR = _EARLY_SCRIPT_DIR / "vendor"
sys.path.insert(0, str(VENDOR_DIR))
import yaml  # type: ignore  # noqa: E402


# Runtime paths are explicit so the immutable runtime pins every helper beside the
# controller. Tests override mutable data paths and never touch the live corpus or DB.
SCRIPT_DIR = _EARLY_SCRIPT_DIR
RUNTIME_SKILLS_DIR = SCRIPT_DIR / "skills"
HOME = Path(os.environ.get("GBRAIN_HOME", os.path.expanduser("~"))).resolve()
BRAIN_DIR = Path(os.environ.get("BRAIN_DIR", str(HOME / "brain"))).resolve()
MEETINGS_DIR = BRAIN_DIR / "meetings"
SKILL_DIR = Path(
    os.environ.get("MEETING_INGESTION_SKILL_DIR", str(SCRIPT_DIR / "meeting-ingestion"))
).resolve()
QA_SCRIPT = Path(
    os.environ.get("MEETING_QA_SCRIPT", str(SKILL_DIR / "scripts/qa-meeting.sh"))
).resolve()
QA_ADAPTER = Path(
    os.environ.get("MEETING_QA_ADAPTER", str(SCRIPT_DIR / "qa-gbrain-adapter.py"))
).resolve()
STATE_DIR = Path(
    os.environ.get("MEETING_COMPLETE_STATE_DIR", str(HOME / ".gbrain/meeting-complete-state"))
).resolve()
RUNTIME_CWD = Path(os.environ.get("MEETING_COMPLETE_CWD", str(HOME / ".gbrain"))).resolve()
SOURCE_ID = os.environ.get("GBRAIN_SOURCE", "default")
GBRAIN_BIN = os.environ.get("GBRAIN_BIN") or "gbrain"
CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or "claude"
DEFAULT_MODEL = os.environ.get("MEETING_COMPLETE_MODEL") or "claude-sonnet-4-6"
LEDGER_PATH = Path(
    os.environ.get("MEETING_RETRY_LEDGER", str(STATE_DIR / "retry-ledger.json"))
).resolve()

PINNED_RESOLVER_SHA256 = "df26188415474b5d095d628648bf396688d2001ca43dc236e2677df2b50d106b"
PINNED_SKILL_SHA256 = "137fcdef9d84840d8639a11150b07bc0f8281aa18df9595748fee0c1efccf31c"
PINNED_QA_SHA256 = "cdd9b74ee70fa41ca017358e6e01db7b889441d3dc05b2f3e3a296106f6d38eb"
PINNED_QA_ADAPTER_SHA256 = "bbd429fca521c4823af26dd94a4aa176efc3250f0fc3ad6b311e616ff5d4ab1e"
PINNED_DOCTRINE_SHA256 = "d16ebf724d906b76036810732394eaf0361b9fe4c8a6297f9f3a6452e6d4b397"
PINNED_TAXONOMIST_SHA256 = "b276c2f5e20fef3f55a2edcd1fca3862649ed37a5ee7c6e2ff07195c936c0365"
PINNED_FILING_RULES_SHA256 = "f92957ad839f7dc6ffcd6776850729c4da85856aeb243047ae2a4dac60a6ef41"
PINNED_FILING_RULES_JSON_SHA256 = "eda2aeee58f6836ea50d031730960fb294be4c6ee6af5b7cd210f082c4233469"
PINNED_QUALITY_SHA256 = "3119afbb795b594ca1f5aae1e7fdb5e24866b87c408734e1fd3c976aa32b4468"
PINNED_RETRIEVAL_GATE_SHA256 = "06205b69d55620c7987d470ef83f14184db103044beeae4a9ef1160aee5889d2"
PINNED_YAML_TREE_SHA256 = "b63ed19b09b0a04efc9cabddfce3d4d6c21fb9b517eb6a884a54a097b2061de4"
_resolver_path = SCRIPT_DIR / "brain_type_resolver.py"
try:
    _resolver_sha = hashlib.sha256(_resolver_path.read_bytes()).hexdigest()
except OSError as exc:
    raise RuntimeError(f"pinned resolver missing: {_resolver_path}: {exc}") from exc
if _resolver_sha != PINNED_RESOLVER_SHA256:
    raise RuntimeError(
        f"pinned resolver checksum mismatch: expected={PINNED_RESOLVER_SHA256} actual={_resolver_sha}"
    )

sys.path.insert(0, str(SCRIPT_DIR))
try:
    from brain_type_resolver import resolve_type  # type: ignore  # noqa: E402
except Exception:
    if os.environ.get("MEETING_COMPLETE_TEST_TYPES") == "1":
        def resolve_type(name):  # type: ignore[no-redef]
            return {"person": "person", "company": "company", "meeting": "meeting"}.get(
                name, name
            )
    else:
        raise

if os.environ.get("MEETING_COMPLETE_TEST_TYPES") == "1":
    PERSON_TYPE = "person"
    COMPANY_TYPE = "company"
    MEETING_TYPE = "meeting"
else:
    PERSON_TYPE = resolve_type("person")
    COMPANY_TYPE = resolve_type("company")
    MEETING_TYPE = resolve_type("meeting")

ALLOWED_PREFIXES = ("people/", "companies/", "meetings/")
FORBIDDEN_SCAN_PREFIXES = ("wiki/", "personal/", "wiki/personal/")
COMPLETION_KEYS = ("status", "completed_at", "completed_model")
ELIGIBLE_LEDGER_STATES = {"pending", "in_progress", "retry"}
_FM_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.S)


PROMPT_TEMPLATE = r"""You are the GBrain MEETING-COMPLETE content agent. Work on exactly
one captured meeting by following the meeting-ingestion skill for its analysis and
entity-enrichment work.

MEETING
- slug: __MEETING_SLUG__
- path: __MEETING_PATH__
- title: __MEETING_TITLE__
- date: __MEETING_DATE__
- attendees:
__ATTENDEE_LIST__

AUTHORITATIVE METHOD
Read __SKILL_FILE__ in full. Execute its content and entity phases for this meeting,
including Crux, What changed, Action items, Decisions, transcript preservation,
attendee resolution, citations, and entity timeline backlinks.
Its exact immutable dependencies are rooted at __SKILLS_DIR__. The active filing
snapshot is __SCHEMA_SNAPSHOT__; do not substitute mutable host skill files.

CONTROLLER-OWNED FIELDS — ABSOLUTE PROHIBITION
- Do NOT add, remove, or modify `status`, `completed_at`, or `completed_model`.
- Leave the meeting's current completion fields byte-for-byte semantically unchanged,
  even if the skill normally tells you to mark the meeting ingested.
- Do NOT run the final QA script, gbrain sync/import/put, link extraction, or completion
  stamping. The deterministic controller performs those after auditing your writes.
- A meeting is not consumed merely because your content work finishes.

WRITE BOUNDARY
- You may create only people/, companies/, and the target meetings/ page.
- You may update an existing out-of-prefix page only if it is in final relevant_to,
  or by a Timeline-only dated row linking to [[__MEETING_SLUG__]].
- Never use `gbrain timeline-add` and never create other shelves.

Emit as the final line one JSON object listing every page actually changed:
{"written":["meetings/...","people/..."],"skipped":[],"notes":"short"}
The controller compares this receipt with a full before/after corpus diff. Unreported
edits, deletions, phantom writes, or completion-field changes fail closed.
"""


class PipelineFailure(RuntimeError):
    """A named deterministic gate failed."""

    def __init__(self, stage: str, message: str, receipt: dict[str, Any] | None = None):
        super().__init__(message)
        self.stage = stage
        self.receipt = receipt or {}


def log(message: str) -> None:
    print(f"[meeting-complete] {message}", flush=True)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value: str | None) -> datetime | None:
    raw = (value or "").strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tree_sha256(root: Path) -> str:
    """Hash path names and bytes for a symlink-free immutable dependency tree."""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise OSError(f"symlink is not permitted in runtime tree: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(root.parent).as_posix().encode("utf-8")
        payload = path.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        # The file itself is already fsynced. Some filesystems reject directory fsync.
        pass


def atomic_write_bytes(path: Path, payload: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        os.chmod(path, mode)
        _fsync_dir(path.parent)
    except Exception:
        with contextlib.suppress(OSError):
            os.close(fd)
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


def atomic_write_text(path: Path, text: str, mode: int | None = None) -> None:
    if mode is None:
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError:
            mode = 0o644
    atomic_write_bytes(path, text.encode("utf-8"), mode)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, indent=2, sort_keys=True, default=str).encode("utf-8") + b"\n"
    atomic_write_bytes(path, encoded, 0o600)


def _split_frontmatter(text: str) -> tuple[dict[str, Any] | None, str | None, str | None]:
    if text.startswith("\ufeff"):
        text = text[1:]
    match = _FM_RE.match(text.replace("\r\n", "\n"))
    if not match:
        return None, None, None
    try:
        parsed = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        parsed = None
    return (parsed if isinstance(parsed, dict) else None), match.group(1), match.group(2)


def _render_page(frontmatter: dict[str, Any], body: str) -> str:
    fm_text = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).strip()
    return f"---\n{fm_text}\n---\n{body}"


def read_meeting_meta(path: Path) -> dict[str, Any] | None:
    try:
        frontmatter, _, _ = _split_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None
    return frontmatter


def completion_snapshot(frontmatter: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        key: {"present": key in frontmatter, "value": copy.deepcopy(frontmatter.get(key))}
        for key in COMPLETION_KEYS
    }


def completion_snapshot_from_text(text: str) -> dict[str, dict[str, Any]]:
    frontmatter, _, _ = _split_frontmatter(text)
    if frontmatter is None:
        raise PipelineFailure("frontmatter", "meeting page has no parseable frontmatter")
    return completion_snapshot(frontmatter)


def page_slug(path: Path, brain_dir: Path | None = None) -> str:
    root = brain_dir or BRAIN_DIR
    relative = path.relative_to(root).as_posix()
    return relative[:-3] if relative.endswith(".md") else relative


def valid_slug(slug: str) -> bool:
    return bool(slug and not slug.startswith("/") and ".." not in slug.split("/") and "\\" not in slug)


def snapshot_brain_pages(brain_dir: Path | None = None) -> dict[str, str]:
    root = brain_dir or BRAIN_DIR
    pages: dict[str, str] = {}
    if not root.exists():
        return pages
    for path in sorted(root.rglob("*.md")):
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if ".git" in relative.parts:
            continue
        try:
            pages[relative.as_posix()[:-3]] = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
    return pages


def snapshot_brain_inventory(brain_dir: Path | None = None) -> dict[str, str]:
    """Hash every non-git corpus file, including non-Markdown side effects."""
    root = brain_dir or BRAIN_DIR
    inventory: dict[str, str] = {}
    if not root.exists():
        return inventory
    for path in sorted(root.rglob("*")):
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        if ".git" in relative.parts or path.is_dir():
            continue
        key = relative.as_posix()
        try:
            if path.is_symlink():
                inventory[key] = "symlink:" + os.readlink(path)
            elif path.is_file():
                inventory[key] = "file:" + sha256_bytes(path.read_bytes())
        except OSError as exc:
            inventory[key] = f"unreadable:{type(exc).__name__}"
    return inventory


def diff_page_snapshots(before: dict[str, str], after: dict[str, str]) -> dict[str, list[str]]:
    before_keys, after_keys = set(before), set(after)
    return {
        "created": sorted(after_keys - before_keys),
        "deleted": sorted(before_keys - after_keys),
        "modified": sorted(slug for slug in before_keys & after_keys if before[slug] != after[slug]),
    }


def meeting_relevant_to(meeting_path: Path) -> set[str]:
    frontmatter = read_meeting_meta(meeting_path) or {}
    raw = frontmatter.get("relevant_to") or []
    values = raw if isinstance(raw, list) else [raw]
    result: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        slug = value.strip()
        if slug.startswith("[[") and slug.endswith("]]" ):
            slug = slug[2:-2].split("|", 1)[0].strip()
        if slug.endswith(".md"):
            slug = slug[:-3]
        if valid_slug(slug):
            result.add(slug)
    return result


def is_timeline_append_only(before: str, after: str, meeting_slug: str) -> bool:
    before_lines = before.replace("\r\n", "\n").splitlines()
    after_lines = after.replace("\r\n", "\n").splitlines()
    timeline_start = next(
        (index for index, line in enumerate(after_lines) if line.strip() == "## Timeline"), None
    )
    if timeline_start is None:
        return False
    timeline_end = next(
        (
            index
            for index in range(timeline_start + 1, len(after_lines))
            if re.match(r"^##\s+", after_lines[index])
        ),
        len(after_lines),
    )
    inserted: list[str] = []
    matcher = difflib.SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in {"delete", "replace"}:
            return False
        if tag == "insert":
            for index in range(j1, j2):
                if after_lines[index].strip() and not timeline_start <= index < timeline_end:
                    return False
                inserted.append(after_lines[index])
    if not inserted:
        return False
    row = re.compile(
        r"^\s*-\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|.*"
        + re.escape("[[" + meeting_slug)
        + r"(?:\||\]\])"
    )
    meaningful = [line for line in inserted if line.strip() and line.strip() != "## Timeline"]
    return bool(meaningful) and all(row.search(line) for line in meaningful)


def parse_agent_receipt(data: dict[str, Any] | None) -> tuple[list[str], list[Any], str, bool]:
    if not data:
        return [], [], "", False
    result = data.get("result") or ""
    if not isinstance(result, str):
        return [], [], "", False
    for line in reversed(result.strip().splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            receipt = json.loads(line)
        except json.JSONDecodeError:
            continue
        written = receipt.get("written")
        if not isinstance(written, list):
            continue
        return written, receipt.get("skipped") or [], str(receipt.get("notes") or ""), True
    return [], [], "", False


def audit_agent_changes(
    before: dict[str, str],
    after: dict[str, str],
    agent_written: Iterable[Any],
    meeting_slug: str,
    meeting_path: Path,
    expected_completion: dict[str, dict[str, Any]],
    inventory_before: dict[str, str] | None = None,
    inventory_after: dict[str, str] | None = None,
    brain_dir: Path | None = None,
) -> dict[str, Any]:
    root = brain_dir or BRAIN_DIR
    diff = diff_page_snapshots(before, after)
    violations: list[str] = []
    written: set[str] = set()
    for raw in agent_written:
        if not isinstance(raw, str) or not valid_slug(raw):
            violations.append(f"invalid receipt slug: {raw!r}")
        else:
            written.add(raw)

    changed = set(diff["created"]) | set(diff["modified"]) | set(diff["deleted"])
    for slug in sorted(changed - written):
        violations.append(f"unreported corpus change: {slug}")
    for slug in sorted(written - changed):
        violations.append(f"phantom/stale receipt write: {slug}")
    for slug in diff["deleted"]:
        violations.append(f"page deletion forbidden: {slug}")
    if meeting_slug not in changed:
        violations.append(f"target meeting was not materially changed: {meeting_slug}")
    if meeting_slug not in written:
        violations.append(f"target meeting absent from receipt: {meeting_slug}")

    relevant_to = meeting_relevant_to(meeting_path) if meeting_path.exists() else set()
    legal_external: set[str] = set()
    for slug in diff["created"]:
        if not any(slug.startswith(prefix) for prefix in ALLOWED_PREFIXES):
            violations.append(f"out-of-allow-list page creation: {slug}")
        if slug.startswith("meetings/") and slug != meeting_slug:
            violations.append(f"agent created a non-target meeting: {slug}")
    for slug in diff["modified"]:
        if slug.startswith("meetings/") and slug != meeting_slug:
            violations.append(f"agent modified a non-target meeting: {slug}")
            continue
        if any(slug.startswith(prefix) for prefix in ALLOWED_PREFIXES):
            continue
        old, new = before[slug], after[slug]
        if slug in relevant_to or is_timeline_append_only(old, new, meeting_slug):
            legal_external.add(slug)
        else:
            violations.append(f"illegal out-of-allow-list page update: {slug}")

    for prefix in FORBIDDEN_SCAN_PREFIXES:
        for slug in sorted(changed):
            if slug.startswith(prefix) and slug not in legal_external:
                violations.append(f"forbidden shelf change under {prefix}: {slug}")

    for slug in sorted(set(diff["created"]) | set(diff["modified"])):
        path = root / f"{slug}.md"
        frontmatter = read_meeting_meta(path)
        if slug.startswith("people/"):
            expected_type = PERSON_TYPE
        elif slug.startswith("companies/"):
            expected_type = COMPANY_TYPE
        elif slug == meeting_slug:
            expected_type = MEETING_TYPE
        else:
            expected_type = None
        if expected_type is not None and (frontmatter or {}).get("type") != expected_type:
            violations.append(
                f"unauthored type on {slug}: got {(frontmatter or {}).get('type')!r}, "
                f"expected {expected_type!r}"
            )

    if meeting_path.exists():
        try:
            actual_completion = completion_snapshot_from_text(after[meeting_slug])
            if actual_completion != expected_completion:
                violations.append("agent modified controller-owned completion fields")
        except (KeyError, PipelineFailure) as exc:
            violations.append(f"meeting completion audit unreadable: {exc}")
    else:
        violations.append("agent deleted target meeting")

    inventory_diff = {"created": [], "deleted": [], "modified": []}
    if inventory_before is not None and inventory_after is not None:
        before_files, after_files = set(inventory_before), set(inventory_after)
        inventory_diff = {
            "created": sorted(after_files - before_files),
            "deleted": sorted(before_files - after_files),
            "modified": sorted(
                path
                for path in before_files & after_files
                if inventory_before[path] != inventory_after[path]
            ),
        }
        expected_markdown_paths = {f"{slug}.md" for slug in changed}
        for category, paths in inventory_diff.items():
            for relative in paths:
                if relative not in expected_markdown_paths:
                    action = {"created": "creation", "deleted": "deletion", "modified": "modification"}[category]
                    violations.append(f"non-page corpus {action}: {relative}")

    return {
        "diff": diff,
        "inventory_diff": inventory_diff,
        "written": sorted(written),
        "legal_external_updates": sorted(legal_external),
        "violations": sorted(set(violations)),
    }


class RetryLedger:
    """Atomic, flock-protected retry state independent of meeting frontmatter."""

    def __init__(self, path: Path = LEDGER_PATH, lease_seconds: int = 7200):
        self.path = path
        self.lock_path = path.with_suffix(path.suffix + ".lock")
        self.lease_seconds = lease_seconds

    def _blank(self) -> dict[str, Any]:
        return {"schema_version": 1, "updated_at": iso_now(), "meetings": {}}

    def _load_unlocked(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._blank()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PipelineFailure("retry-ledger", f"cannot read retry ledger: {exc}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("meetings"), dict):
            raise PipelineFailure("retry-ledger", "retry ledger shape is invalid")
        return data

    @contextlib.contextmanager
    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        os.chmod(self.lock_path, 0o600)
        with os.fdopen(fd, "r+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            data = self._load_unlocked()
            yield data
            data["updated_at"] = iso_now()
            atomic_write_json(self.path, data)
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def snapshot(self) -> dict[str, Any]:
        with self._locked() as data:
            return copy.deepcopy(data)

    def discover(self, slug: str, page_status: str, path: Path) -> None:
        if page_status != "captured":
            return
        with self._locked() as data:
            meetings = data["meetings"]
            entry = meetings.get(slug)
            if entry is None or entry.get("state") == "completed":
                meetings[slug] = {
                    "state": "pending",
                    "attempts": int((entry or {}).get("attempts", 0)),
                    "path": str(path),
                    "discovered_at": iso_now(),
                    "updated_at": iso_now(),
                }
            else:
                entry["path"] = str(path)
                entry["updated_at"] = iso_now()

    def claim(
        self,
        slug: str,
        run_id: str,
        page_status: str,
        path: Path,
        completion_before: dict[str, dict[str, Any]],
        content_sha_before: str,
    ) -> dict[str, Any] | None:
        now = time.time()
        with self._locked() as data:
            meetings = data["meetings"]
            entry = meetings.get(slug) or {"state": "pending", "attempts": 0}
            state = str(entry.get("state") or "pending")
            if state == "completed" and page_status != "captured":
                return None
            if state == "in_progress":
                lease_until = float(entry.get("lease_until_epoch") or 0)
                if lease_until > now and entry.get("owner_run_id") != run_id:
                    return None
            elif state not in {"pending", "retry", "completed"} and page_status != "captured":
                return None
            previous_resume = copy.deepcopy(entry.get("resume"))
            original_completion = copy.deepcopy(entry.get("completion_before") or completion_before)
            entry.update(
                {
                    "state": "in_progress",
                    "path": str(path),
                    "attempts": int(entry.get("attempts", 0)) + 1,
                    "owner_run_id": run_id,
                    "lease_until_epoch": now + self.lease_seconds,
                    "attempt_started_at": iso_now(),
                    "updated_at": iso_now(),
                    "completion_before": original_completion,
                    "content_sha_before": content_sha_before,
                    "resume": previous_resume,
                }
            )
            meetings[slug] = entry
            return copy.deepcopy(entry)

    def checkpoint_resume(self, slug: str, run_id: str, resume: dict[str, Any]) -> None:
        with self._locked() as data:
            entry = data["meetings"].get(slug)
            if not entry or entry.get("state") != "in_progress" or entry.get("owner_run_id") != run_id:
                raise PipelineFailure("retry-ledger", f"lost ledger ownership for {slug}")
            entry["resume"] = copy.deepcopy(resume)
            entry["checkpointed_at"] = iso_now()
            entry["updated_at"] = iso_now()

    def fail(
        self,
        slug: str,
        run_id: str,
        error: str,
        resume: dict[str, Any] | None = None,
    ) -> None:
        with self._locked() as data:
            entry = data["meetings"].get(slug) or {"attempts": 0}
            owner = entry.get("owner_run_id")
            lease_until = float(entry.get("lease_until_epoch") or 0)
            if owner not in {None, run_id} and lease_until > time.time():
                raise PipelineFailure("retry-ledger", f"cannot fail {slug}; owned by {owner}")
            entry.update(
                {
                    "state": "retry",
                    "last_error": error,
                    "last_failed_at": iso_now(),
                    "owner_run_id": None,
                    "lease_until_epoch": 0,
                    "updated_at": iso_now(),
                    "resume": copy.deepcopy(resume),
                }
            )
            data["meetings"][slug] = entry

    def complete(self, slug: str, run_id: str, final_sha: str, db_verified_at: str) -> None:
        with self._locked() as data:
            entry = data["meetings"].get(slug)
            if not entry or entry.get("owner_run_id") != run_id:
                raise PipelineFailure("retry-ledger", f"lost ledger ownership for {slug}")
            entry.update(
                {
                    "state": "completed",
                    "completed_at": iso_now(),
                    "db_verified_at": db_verified_at,
                    "final_sha256": final_sha,
                    "owner_run_id": None,
                    "lease_until_epoch": 0,
                    "last_error": None,
                    "resume": None,
                    "updated_at": iso_now(),
                }
            )


def select_meetings(limit: int, only: str | None, ledger: RetryLedger) -> list[dict[str, Any]]:
    if not MEETINGS_DIR.exists():
        raise PipelineFailure("selection", f"meetings directory not found: {MEETINGS_DIR}")
    rows_by_slug: dict[str, dict[str, Any]] = {}
    for path in sorted(MEETINGS_DIR.glob("*.md")):
        slug = f"meetings/{path.stem}"
        frontmatter = read_meeting_meta(path)
        if frontmatter is None:
            log(f"WARN: skipping unparseable meeting frontmatter: {path.name}")
            continue
        status = str(frontmatter.get("status") or "").strip().lower()
        ledger.discover(slug, status, path)
        date_value = str(frontmatter.get("date") or frontmatter.get("date_recorded") or "")
        date_ts = parse_ts(date_value)
        rows_by_slug[slug] = {
            "slug": slug,
            "path": str(path),
            "title": str(frontmatter.get("title") or path.stem),
            "date_recorded": date_ts.astimezone(timezone.utc).strftime("%Y-%m-%d") if date_ts else "",
            "date_ts": date_ts,
            "sort_key": date_ts or datetime.max.replace(tzinfo=timezone.utc),
            "attendees": [v for v in (frontmatter.get("attendees") or []) if isinstance(v, str)],
            "current_status": status,
            "missing": False,
        }

    ledger_data = ledger.snapshot()
    selected: list[dict[str, Any]] = []
    for slug, entry in ledger_data["meetings"].items():
        state = str(entry.get("state") or "")
        row = rows_by_slug.get(slug)
        page_captured = bool(row and row["current_status"] == "captured")
        if state not in ELIGIBLE_LEDGER_STATES and not page_captured:
            continue
        if only and only not in slug:
            continue
        if row is None:
            path = Path(entry.get("path") or (BRAIN_DIR / f"{slug}.md"))
            row = {
                "slug": slug,
                "path": str(path),
                "title": slug,
                "date_recorded": "",
                "date_ts": None,
                "sort_key": datetime.min.replace(tzinfo=timezone.utc),
                "attendees": [],
                "current_status": "missing",
                "missing": True,
            }
        row = dict(row)
        row["ledger_state"] = state
        selected.append(row)
    selected.sort(key=lambda row: (row["sort_key"], row["slug"]))
    return selected[:limit] if limit > 0 else selected


def build_prompt(meeting: dict[str, Any], skill_dir: Path | None = None) -> str:
    agent_skill_dir = skill_dir or SKILL_DIR
    attendees = meeting.get("attendees") or []
    attendee_list = "\n".join(f"  - {value}" for value in attendees) if attendees else "  - derive from transcript"
    return (
        PROMPT_TEMPLATE.replace("__MEETING_PATH__", meeting["path"])
        .replace("__MEETING_SLUG__", meeting["slug"])
        .replace("__MEETING_TITLE__", meeting["title"])
        .replace("__MEETING_DATE__", meeting.get("date_recorded") or "<unknown>")
        .replace("__ATTENDEE_LIST__", attendee_list)
        .replace("__SKILL_FILE__", str(agent_skill_dir / "SKILL.md"))
        .replace("__SKILLS_DIR__", str(agent_skill_dir.parent))
        .replace("__SCHEMA_SNAPSHOT__", str(agent_skill_dir.parent / "_brain-filing-rules.json"))
    )


def assert_subscription_env() -> None:
    leaked = [
        key
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
        if os.environ.get(key)
    ]
    if leaked:
        raise PipelineFailure("subscription-guard", f"metered API environment present: {leaked}")
    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        log("WARN: subscription OAuth token absent; relying on local Claude credentials")


def assert_entity_types_from_pack() -> None:
    expected = {"person": "person", "company": "company", "meeting": "meeting"}
    drift = [f"{key}={resolve_type(key)!r}" for key, value in expected.items() if resolve_type(key) != value]
    if drift:
        raise PipelineFailure("schema-types", "active pack type resolution drift: " + "; ".join(drift))


def assert_runtime_helpers() -> None:
    expected = {
        SCRIPT_DIR / "brain_type_resolver.py": PINNED_RESOLVER_SHA256,
        SKILL_DIR / "SKILL.md": PINNED_SKILL_SHA256,
        QA_SCRIPT: PINNED_QA_SHA256,
        QA_ADAPTER: PINNED_QA_ADAPTER_SHA256,
        SKILL_DIR / "references/doctrine.md": PINNED_DOCTRINE_SHA256,
        RUNTIME_SKILLS_DIR / "brain-taxonomist/SKILL.md": PINNED_TAXONOMIST_SHA256,
        RUNTIME_SKILLS_DIR / "_brain-filing-rules.md": PINNED_FILING_RULES_SHA256,
        RUNTIME_SKILLS_DIR / "_brain-filing-rules.json": PINNED_FILING_RULES_JSON_SHA256,
        RUNTIME_SKILLS_DIR / "conventions/quality.md": PINNED_QUALITY_SHA256,
        RUNTIME_SKILLS_DIR / "conventions/post-run-retrieval-gate.md": PINNED_RETRIEVAL_GATE_SHA256,
    }
    mismatches: list[str] = []
    for path, expected_sha in expected.items():
        try:
            actual_sha = sha256_bytes(path.read_bytes())
        except OSError as exc:
            mismatches.append(f"{path}: unreadable ({exc})")
            continue
        if actual_sha != expected_sha:
            mismatches.append(f"{path}: expected={expected_sha} actual={actual_sha}")
    try:
        yaml_tree_sha = tree_sha256(VENDOR_DIR / "yaml")
    except OSError as exc:
        mismatches.append(f"{VENDOR_DIR / 'yaml'}: unreadable ({exc})")
    else:
        if yaml_tree_sha != PINNED_YAML_TREE_SHA256:
            mismatches.append(
                f"{VENDOR_DIR / 'yaml'}: expected={PINNED_YAML_TREE_SHA256} actual={yaml_tree_sha}"
            )
    if not Path(yaml.__file__).resolve().is_relative_to(VENDOR_DIR.resolve()):
        mismatches.append(f"yaml imported outside sealed vendor tree: {yaml.__file__}")
    if mismatches:
        raise PipelineFailure("runtime-checksums", "; ".join(mismatches))


DB_ENV_TOKENS = (
    "DATABASE",
    "POSTGRES",
    "SUPABASE",
    "PGLITE",
    "NEON",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "PGSERVICE",
    "DB_URL",
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
)


def is_db_environment_key(key: str) -> bool:
    upper = key.upper()
    return (
        upper.startswith("GBRAIN_DB")
        or re.search(r"(^|_)DB($|_)", upper) is not None
        or any(token in upper for token in DB_ENV_TOKENS)
    )


def resolve_claude_executable() -> Path:
    configured = Path(CLAUDE_BIN).expanduser()
    if configured.is_absolute() or configured.parent != Path("."):
        candidate = configured
    else:
        resolved = shutil.which(CLAUDE_BIN)
        if not resolved:
            raise PipelineFailure("agent-sandbox", "Claude executable is not resolvable")
        candidate = Path(resolved)
    try:
        executable = candidate.resolve(strict=True)
    except OSError as exc:
        raise PipelineFailure(
            "agent-sandbox", f"Claude executable is unreadable: {candidate}: {exc}"
        ) from exc
    if not executable.is_file():
        raise PipelineFailure("agent-sandbox", f"Claude executable is not a file: {executable}")
    return executable


def claude_resource_roots(executable: Path) -> list[Path]:
    """Return only the installed Claude package tree, if one can be identified."""
    roots: list[Path] = []
    for ancestor in executable.parents:
        package_json = ancestor / "package.json"
        if not package_json.is_file():
            continue
        try:
            package = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if package.get("name") == "@anthropic-ai/claude-code":
            roots.append(ancestor.resolve())
            break
    return roots


def _sandbox_filter(kind: str, path: Path) -> str:
    return f"({kind} {json.dumps(str(path.resolve()))})"


def sandbox_profile_text(
    agent_root: Path,
    claude_executable: Path,
    *,
    canary_tools: bool = False,
) -> str:
    """Build a deny-default profile with no global filesystem-read grant."""
    root = agent_root.resolve()
    read_filters: list[tuple[str, Path]] = [
        ("subpath", root),
        ("path-ancestors", root),
        ("subpath", Path("/Library/Apple")),
        ("subpath", Path("/Library/Filesystems/NetFSPlugins")),
        ("subpath", Path("/Library/Preferences/Logging")),
        ("subpath", Path("/System")),
        ("subpath", Path("/usr/lib")),
        ("subpath", Path("/usr/share")),
        ("subpath", Path("/private/var/db/timezone")),
        ("subpath", Path("/private/var/select")),
        ("subpath", Path("/private/etc/ssl")),
        ("literal", Path("/")),
        ("literal", Path("/etc")),
        ("literal", Path("/tmp")),
        ("literal", Path("/var")),
        ("literal", Path("/private/etc/localtime")),
        ("literal", Path("/private/var/db/DarwinDirectory/local/recordStore.data")),
        ("literal", Path("/private/etc/hosts")),
        ("literal", Path("/private/etc/resolv.conf")),
        ("literal", Path("/private/etc/services")),
        ("literal", Path("/private/etc/protocols")),
        ("literal", Path("/dev/null")),
        ("literal", Path("/dev/random")),
        ("literal", Path("/dev/urandom")),
        ("literal", claude_executable),
    ]
    read_filters.extend(("subpath", path) for path in claude_resource_roots(claude_executable))
    if canary_tools:
        # These exact system executables are present only in the no-model canary
        # profile. The model-facing profile cannot read or execute a shell/cat.
        read_filters.extend(
            ("literal", path)
            for path in (Path("/bin/sh"), Path("/bin/bash"), Path("/bin/cat"))
        )
    read_clause = "\n    ".join(_sandbox_filter(kind, path) for kind, path in read_filters)
    exec_filters: list[tuple[str, Path]] = [("literal", claude_executable), ("subpath", root)]
    exec_filters.extend(
        ("subpath", path) for path in claude_resource_roots(claude_executable)
    )
    if canary_tools:
        exec_filters.extend(
            ("literal", path)
            for path in (Path("/bin/sh"), Path("/bin/bash"), Path("/bin/cat"))
        )
    exec_clause = "\n    ".join(_sandbox_filter(kind, path) for kind, path in exec_filters)
    denied_reads: list[tuple[str, Path]] = [
        ("subpath", BRAIN_DIR),
        ("literal", HOME / ".gbrain/config.json"),
        ("literal", HOME / ".zshenv"),
        ("literal", HOME / ".zprofile"),
        ("literal", HOME / ".pgpass"),
        ("subpath", HOME / ".ssh"),
        ("subpath", HOME / ".aws"),
        ("subpath", HOME / ".config/gcloud"),
        ("subpath", HOME / ".supabase"),
        ("subpath", HOME / "Library/Keychains"),
    ]
    denied_clause = "\n".join(
        f"(deny file-read* {_sandbox_filter(kind, path)})"
        for kind, path in denied_reads
    )
    # macOS 26's dyld requires bootstrap operations outside the old version-1
    # deny-default vocabulary. Start with the OS operation baseline, then enforce
    # filesystem and process-exec allowlists using complement-deny filters. The
    # canary below proves the resulting effective policy, including credential
    # denial, on the exact host runtime before any model invocation.
    return f"""(version 3)
(allow default)
(deny file-read* file-test-existence
    (require-not
        (require-any
            {read_clause})))
(deny file-write*
    (require-not
        (require-any
            (subpath {json.dumps(str(root))})
            (literal \"/dev/null\"))))
(deny process-exec
    (require-not
        (require-any
            {exec_clause})))
(deny mach-lookup (global-name \"com.apple.securityd\"))
(deny mach-lookup (global-name \"com.apple.securityd.xpc\"))
{denied_clause}
"""


def write_deny_shim(path: Path, tool: str) -> None:
    script = (
        "#!/bin/sh\n"
        f"printf '%s\\n' '{tool}: denied by meeting agent sandbox' >> \"$AGENT_DENY_LOG\"\n"
        "exit 126\n"
    )
    atomic_write_text(path, script, 0o700)


@contextlib.contextmanager
def isolated_agent_workspace():
    """Yield a disposable corpus copy and a deny-default macOS sandbox profile."""
    if not Path("/usr/bin/sandbox-exec").exists():
        raise PipelineFailure("agent-sandbox", "sandbox-exec unavailable; refusing model execution")
    parent = STATE_DIR / "agent-sandboxes"
    parent.mkdir(parents=True, exist_ok=True)
    os.chmod(parent, 0o700)
    with tempfile.TemporaryDirectory(prefix="meeting-agent-", dir=str(parent)) as raw_root:
        root = Path(raw_root).resolve()
        os.chmod(root, 0o700)
        sandbox_brain = root / "brain"
        sandbox_skills = root / "skills"
        sandbox_skill = sandbox_skills / "meeting-ingestion"
        sandbox_home = root / "home"
        sandbox_tmp = root / "tmp"
        deny_bin = root / "deny-bin"
        for directory in (sandbox_home, sandbox_tmp, deny_bin):
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o700)
        shutil.copytree(
            BRAIN_DIR,
            sandbox_brain,
            symlinks=True,
            ignore=shutil.ignore_patterns(".git"),
        )
        shutil.copytree(RUNTIME_SKILLS_DIR, sandbox_skills, symlinks=False)
        shutil.copytree(SKILL_DIR, sandbox_skill, symlinks=False)
        deny_log = root / "denied-tools.log"
        atomic_write_text(deny_log, "", 0o600)
        for tool in ("gbrain", "psql", "pg_dump", "pg_restore", "createdb", "dropdb", "supabase"):
            write_deny_shim(deny_bin / tool, tool)
        claude_executable = resolve_claude_executable()
        profile = root / "agent.sb"
        canary_profile = root / "agent-canary.sb"
        atomic_write_text(
            profile,
            sandbox_profile_text(root, claude_executable),
            0o600,
        )
        atomic_write_text(
            canary_profile,
            sandbox_profile_text(root, claude_executable, canary_tools=True),
            0o600,
        )
        context = {
            "root": root,
            "brain_dir": sandbox_brain,
            "skill_dir": sandbox_skill,
            "skills_dir": sandbox_skills,
            "home_dir": sandbox_home,
            "tmp_dir": sandbox_tmp,
            "deny_bin": deny_bin,
            "deny_log": deny_log,
            "profile": profile,
            "canary_profile": canary_profile,
            "claude_executable": claude_executable,
        }
        yield context


def isolated_agent_environment(context: dict[str, Path]) -> tuple[dict[str, str], list[str]]:
    # Build from an allowlist. The controller needs production DB routing, but the
    # untrusted model child receives neither those variables nor unrelated host
    # credentials inherited from the launchd/login environment.
    scrubbed: list[str] = []
    environment: dict[str, str] = {}
    passthrough = {
        "CLAUDE_CODE_OAUTH_TOKEN",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "NO_COLOR",
        "TERM",
        "TZ",
    }
    for key, value in os.environ.items():
        if is_db_environment_key(key):
            scrubbed.append(key)
            continue
        if key in passthrough or key.startswith("LC_"):
            environment[key] = value
    # The subscription OAuth token is the only credential intentionally retained.
    # Metered Anthropic keys are rejected by assert_subscription_env and named here
    # again so the canary receipt can prove they were scrubbed if present in tests.
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        if key in os.environ:
            scrubbed.append(key)
    environment.update(
        {
            "HOME": str(context["home_dir"]),
            "TMPDIR": str(context["tmp_dir"]),
            "CLAUDE_CONFIG_DIR": str(context["home_dir"] / ".claude"),
            "PATH": str(context["deny_bin"]) + os.pathsep + "/usr/bin:/bin:/usr/sbin:/sbin",
            "GBRAIN_BIN": str(context["deny_bin"] / "gbrain"),
            "AGENT_DENY_LOG": str(context["deny_log"]),
            "USER": "meeting-agent",
            "LOGNAME": "meeting-agent",
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1",
            "CLAUDE_CODE_SKIP_UPDATE_CHECK": "1",
            "CLAUDE_CODE_AUTO_CONNECT_IDE": "0",
        }
    )
    return environment, sorted(set(scrubbed))


def build_claude_command(
    prompt: str,
    model: str,
    max_turns: int,
    context: dict[str, Path],
) -> list[str]:
    return [
        "/usr/bin/sandbox-exec",
        "-f",
        str(context["profile"]),
        str(context["claude_executable"]),
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "json",
        "--max-turns",
        str(max_turns),
        "--permission-mode",
        "acceptEdits",
        "--safe-mode",
        "--setting-sources",
        "",
        "--tools",
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        "--disallowedTools",
        "Bash",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-session-persistence",
        "--add-dir",
        str(context["brain_dir"]),
        "--add-dir",
        str(context["skills_dir"]),
    ]


def run_claude(
    prompt: str,
    model: str,
    max_turns: int,
    timeout: int,
    context: dict[str, Path],
):
    command = build_claude_command(prompt, model, max_turns, context)
    environment, scrubbed = isolated_agent_environment(context)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=environment,
            cwd=str(context["root"]),
        )
    except subprocess.TimeoutExpired:
        return 124, None, "", "timeout", {
            "sandboxed": True,
            "bash_available": False,
            "db_environment_keys_scrubbed": scrubbed,
        }
    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        data = None
    return result.returncode, data, result.stdout, result.stderr, {
        "sandboxed": True,
        "sandbox_profile_sha256": sha256_bytes(context["profile"].read_bytes()),
        "bash_available": False,
        "dangerous_permissions": False,
        "db_environment_keys_scrubbed": scrubbed,
        "denied_tool_attempts": context["deny_log"].read_text(encoding="utf-8").splitlines(),
    }


def run_isolation_canary(context: dict[str, Path], protected_path: Path) -> dict[str, Any]:
    """No-model proof of read/write isolation, tool denial, and Claude startup."""
    environment, scrubbed = isolated_agent_environment(context)
    sensitive_sentinel = STATE_DIR / f".agent-sensitive-canary-{uuid.uuid4().hex}"
    atomic_write_text(sensitive_sentinel, "canary-secret-must-not-be-readable\n", 0o600)
    config_path = HOME / ".gbrain/config.json"
    ssh_dir = HOME / ".ssh"
    try:
        ssh_probe = next(path for path in sorted(ssh_dir.iterdir()) if path.is_file())
    except (OSError, StopIteration):
        ssh_probe = ssh_dir / ".meeting-canary-nonexistent"
    environment["PROTECTED_PATH"] = str(protected_path)
    environment["PROTECTED_READ_PATH"] = str(BRAIN_DIR / "meetings/test.md")
    environment["SENSITIVE_SENTINEL"] = str(sensitive_sentinel)
    environment["CONFIG_PATH"] = str(config_path)
    environment["SSH_PROBE_PATH"] = str(ssh_probe)
    environment["SANDBOX_MEETING"] = str(context["brain_dir"] / "meetings/test.md")
    environment["SANDBOX_SKILL"] = str(context["skill_dir"] / "SKILL.md")
    environment["CLAUDE_EXECUTABLE"] = str(context["claude_executable"])
    script = (
        'printf mutation > "$PROTECTED_PATH" 2>/dev/null; write_rc=$?; '
        '/bin/cat "$PROTECTED_READ_PATH" >/dev/null 2>&1; live_read_rc=$?; '
        '/bin/cat "$SENSITIVE_SENTINEL" >/dev/null 2>&1; sentinel_read_rc=$?; '
        '/bin/cat "$CONFIG_PATH" >/dev/null 2>&1; config_read_rc=$?; '
        '/bin/cat "$SSH_PROBE_PATH" >/dev/null 2>&1; ssh_read_rc=$?; '
        '/bin/cat "$SANDBOX_MEETING" >/dev/null 2>&1; sandbox_meeting_rc=$?; '
        '/bin/cat "$SANDBOX_SKILL" >/dev/null 2>&1; sandbox_skill_rc=$?; '
        'gbrain put meetings/test >/dev/null 2>&1; gbrain_rc=$?; '
        'psql -c "select 1" >/dev/null 2>&1; psql_rc=$?; '
        '"$CLAUDE_EXECUTABLE" --version >/dev/null 2>&1; claude_version_rc=$?; '
        'printf "%s %s %s %s %s %s %s %s %s %s\\n" '
        '"$write_rc" "$live_read_rc" "$sentinel_read_rc" "$config_read_rc" '
        '"$ssh_read_rc" "$sandbox_meeting_rc" "$sandbox_skill_rc" "$gbrain_rc" "$psql_rc" '
        '"$claude_version_rc"'
    )
    command = [
        "/usr/bin/sandbox-exec",
        "-f",
        str(context["canary_profile"]),
        "/bin/sh",
        "-c",
        script,
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=30,
            env=environment,
            cwd=str(context["root"]),
        )
        fields = (result.stdout or "").strip().split()
        attempt_rcs = [int(value) for value in fields[-10:]] if len(fields) >= 10 else []
        labels = (
            "outside_write",
            "live_brain_read",
            "sensitive_sentinel_read",
            "gbrain_config_read",
            "ssh_credential_read",
            "sandbox_meeting_read",
            "sandbox_skill_read",
            "gbrain_exec",
            "psql_exec",
            "claude_version",
        )
        attempts = dict(zip(labels, attempt_rcs))
        protected_created = protected_path.exists()
        passed = bool(
            result.returncode == 0
            and len(attempts) == len(labels)
            and all(attempts[name] != 0 for name in labels[:5])
            and all(attempts[name] == 0 for name in labels[5:7])
            and all(attempts[name] != 0 for name in labels[7:9])
            and attempts["claude_version"] == 0
            and not protected_created
        )
        return {
            "passed": passed,
            "rc": result.returncode,
            "attempts": attempts,
            "protected_created_by_attempt": protected_created,
            "sensitive_sentinel_existed": True,
            "gbrain_config_existed": config_path.exists(),
            "ssh_probe_existed": ssh_probe.exists(),
            "read_policy": "allowlist",
            "environment_policy": "allowlist",
            "db_environment_keys_scrubbed": scrubbed,
            "denied_tool_attempts": context["deny_log"].read_text(encoding="utf-8").splitlines(),
            "claude_executable_sha256": sha256_bytes(context["claude_executable"].read_bytes()),
            "stderr_tail": (result.stderr or "")[-1000:],
        }
    finally:
        sensitive_sentinel.unlink(missing_ok=True)
        protected_path.unlink(missing_ok=True)


def command_receipt(command: list[str], result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    return {
        "command": command,
        "rc": result.returncode,
        "stdout_tail": (result.stdout or "")[-2000:],
        "stderr_tail": (result.stderr or "")[-2000:],
    }


def narrow_import_pages(slugs: Iterable[str], stage: str = "narrow-import") -> list[dict[str, Any]]:
    receipts: list[dict[str, Any]] = []
    environment = {**os.environ, "GBRAIN_SOURCE": SOURCE_ID, "GBRAIN_DISABLE_DIRECT_POOL": "1"}
    for slug in sorted(set(slugs)):
        if not valid_slug(slug):
            raise PipelineFailure(stage, f"invalid import slug: {slug}")
        path = BRAIN_DIR / f"{slug}.md"
        if not path.exists():
            raise PipelineFailure(stage, f"cannot import missing page: {slug}")
        content = path.read_text(encoding="utf-8", errors="replace")
        command = [GBRAIN_BIN, "put", slug, "--source", SOURCE_ID]
        try:
            result = subprocess.run(
                command,
                input=content,
                capture_output=True,
                text=True,
                timeout=600,
                cwd=str(RUNTIME_CWD),
                env=environment,
            )
        except Exception as exc:
            raise PipelineFailure(stage, f"put failed to execute for {slug}: {exc}", {"receipts": receipts}) from exc
        receipt = command_receipt(command, result)
        receipt["slug"] = slug
        receipt["input_sha256"] = sha256_text(content)
        receipts.append(receipt)
        if result.returncode != 0:
            raise PipelineFailure(stage, f"narrow import failed for {slug}", {"receipts": receipts})
    return receipts


def read_db_page_snapshot(slug: str) -> dict[str, Any]:
    command = [GBRAIN_BIN, "get", slug, "--source", SOURCE_ID]
    environment = {**os.environ, "GBRAIN_SOURCE": SOURCE_ID, "GBRAIN_DISABLE_DIRECT_POOL": "1"}
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=str(RUNTIME_CWD),
        env=environment,
    )
    receipt = command_receipt(command, result)
    if result.returncode == 0:
        content = _extract_markdown(result.stdout)
        return {
            "active": True,
            "content": content,
            "sha256": sha256_text(content),
            "receipt": receipt,
        }
    combined = ((result.stdout or "") + "\n" + (result.stderr or "")).lower()
    if "not found" in combined or "no page" in combined:
        return {"active": False, "content": None, "sha256": None, "receipt": receipt}
    raise PipelineFailure("db-snapshot", f"cannot snapshot DB page {slug}", receipt)


def capture_db_snapshots(slugs: Iterable[str]) -> dict[str, dict[str, Any]]:
    return {slug: read_db_page_snapshot(slug) for slug in sorted(set(slugs))}


def _journal_manifest_path(journal_dir: Path) -> Path:
    return journal_dir / "manifest.json"


def read_journal(journal_dir: Path) -> dict[str, Any]:
    try:
        data = json.loads(_journal_manifest_path(journal_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PipelineFailure("promotion-journal", f"cannot read {journal_dir}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("pages"), dict):
        raise PipelineFailure("promotion-journal", f"invalid journal shape: {journal_dir}")
    return data


def write_journal(journal_dir: Path, manifest: dict[str, Any]) -> None:
    manifest["updated_at"] = iso_now()
    atomic_write_json(_journal_manifest_path(journal_dir), manifest)


def set_journal_state(journal_dir: Path, state: str) -> None:
    manifest = read_journal(journal_dir)
    manifest["state"] = state
    write_journal(journal_dir, manifest)


def create_promotion_journal(
    run_id: str,
    meeting_slug: str,
    written: Iterable[str],
    candidate_brain: Path,
    live_before_pages: dict[str, str],
    db_before: dict[str, dict[str, Any]],
) -> Path:
    journals = STATE_DIR / "promotion-journals"
    journals.mkdir(parents=True, exist_ok=True)
    os.chmod(journals, 0o700)
    journal_id = f"{run_id}-{hashlib.sha256(meeting_slug.encode()).hexdigest()[:12]}"
    journal_dir = journals / journal_id
    if journal_dir.exists():
        raise PipelineFailure("promotion-journal", f"journal already exists: {journal_dir}")
    journal_dir.mkdir(mode=0o700)
    pages: dict[str, Any] = {}
    for slug in sorted(set(written)):
        if not valid_slug(slug):
            raise PipelineFailure("promotion-journal", f"invalid journal slug: {slug}")
        candidate_path = candidate_brain / f"{slug}.md"
        if not candidate_path.exists():
            raise PipelineFailure("promotion-journal", f"candidate missing: {slug}")
        candidate = candidate_path.read_text(encoding="utf-8", errors="replace")
        candidate_rel = f"candidate/{slug}.md"
        atomic_write_text(journal_dir / candidate_rel, candidate, 0o600)
        before = live_before_pages.get(slug)
        before_rel = f"before/{slug}.md" if before is not None else None
        if before_rel:
            atomic_write_text(journal_dir / before_rel, before, 0o600)
        db_snapshot = db_before[slug]
        db_rel = f"db-before/{slug}.md" if db_snapshot.get("active") else None
        if db_rel:
            atomic_write_text(journal_dir / db_rel, str(db_snapshot["content"]), 0o600)
        pages[slug] = {
            "before_exists": before is not None,
            "before_rel": before_rel,
            "before_sha256": sha256_text(before) if before is not None else None,
            "candidate_rel": candidate_rel,
            "candidate_sha256": sha256_text(candidate),
            "db_before_active": bool(db_snapshot.get("active")),
            "db_before_rel": db_rel,
            "db_before_sha256": db_snapshot.get("sha256"),
        }
    manifest = {
        "schema_version": 1,
        "journal_id": journal_id,
        "meeting": meeting_slug,
        "created_at": iso_now(),
        "state": "prepared",
        "pages": pages,
    }
    write_journal(journal_dir, manifest)
    return journal_dir


def promote_promotion_journal(journal_dir: Path) -> dict[str, Any]:
    manifest = read_journal(journal_dir)
    if manifest.get("state") != "prepared":
        raise PipelineFailure(
            "promotion", f"journal state must be prepared, got {manifest.get('state')!r}"
        )
    # Compare-and-swap gate against the live corpus snapshot taken before the
    # isolated agent started. No candidate overwrites concurrent user work.
    for slug, spec in manifest["pages"].items():
        live_path = BRAIN_DIR / f"{slug}.md"
        if spec["before_exists"]:
            if not live_path.exists():
                raise PipelineFailure("promotion-toctou", f"live page disappeared: {slug}")
            actual = sha256_bytes(live_path.read_bytes())
            if actual != spec["before_sha256"]:
                raise PipelineFailure("promotion-toctou", f"live page changed during agent run: {slug}")
        elif live_path.exists():
            raise PipelineFailure("promotion-toctou", f"live page was concurrently created: {slug}")
        candidate = journal_dir / spec["candidate_rel"]
        if sha256_bytes(candidate.read_bytes()) != spec["candidate_sha256"]:
            raise PipelineFailure("promotion-journal", f"candidate checksum drift: {slug}")
    manifest["state"] = "promotion_in_progress"
    write_journal(journal_dir, manifest)
    promoted: list[dict[str, Any]] = []
    try:
        for slug, spec in manifest["pages"].items():
            candidate = (journal_dir / spec["candidate_rel"]).read_text(
                encoding="utf-8", errors="replace"
            )
            live_path = BRAIN_DIR / f"{slug}.md"
            atomic_write_text(live_path, candidate, 0o644 if not live_path.exists() else None)
            promoted.append({"slug": slug, "sha256": sha256_bytes(live_path.read_bytes())})
    except Exception as exc:
        raise PipelineFailure("promotion", f"candidate promotion failed: {exc}") from exc
    manifest["state"] = "promoted"
    manifest["promoted_at"] = iso_now()
    write_journal(journal_dir, manifest)
    return {"journal": str(journal_dir), "promoted": promoted}


def restore_db_snapshot(slug: str, spec: dict[str, Any], journal_dir: Path) -> dict[str, Any]:
    environment = {**os.environ, "GBRAIN_SOURCE": SOURCE_ID, "GBRAIN_DISABLE_DIRECT_POOL": "1"}
    if spec["db_before_active"]:
        content = (journal_dir / spec["db_before_rel"]).read_text(
            encoding="utf-8", errors="replace"
        )
        command = [GBRAIN_BIN, "put", slug, "--source", SOURCE_ID]
        result = subprocess.run(
            command,
            input=content,
            capture_output=True,
            text=True,
            timeout=600,
            cwd=str(RUNTIME_CWD),
            env=environment,
        )
    else:
        command = [GBRAIN_BIN, "delete", slug, "--source", SOURCE_ID]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(RUNTIME_CWD),
            env=environment,
        )
    receipt = command_receipt(command, result)
    if result.returncode != 0:
        combined = ((result.stdout or "") + "\n" + (result.stderr or "")).lower()
        if not spec["db_before_active"] and ("not found" in combined or "no page" in combined):
            receipt["already_absent"] = True
            return receipt
        raise PipelineFailure("promotion-rollback-db", f"DB rollback failed for {slug}", receipt)
    return receipt


def rollback_promotion_journal(journal_dir: Path) -> dict[str, Any]:
    manifest = read_journal(journal_dir)
    state = str(manifest.get("state") or "")
    receipt: dict[str, Any] = {
        "journal": str(journal_dir),
        "state_before": state,
        "corpus": [],
        "db": [],
        "errors": [],
    }
    if state in {"prepared", "rolled_back", "abandoned"}:
        manifest["state"] = "abandoned" if state == "prepared" else state
        write_journal(journal_dir, manifest)
        receipt["no_live_mutation_had_started"] = True
        return receipt
    for slug, spec in manifest["pages"].items():
        live_path = BRAIN_DIR / f"{slug}.md"
        try:
            if spec["before_exists"]:
                before = (journal_dir / spec["before_rel"]).read_text(
                    encoding="utf-8", errors="replace"
                )
                atomic_write_text(live_path, before)
                receipt["corpus"].append({"slug": slug, "restored": True})
            elif live_path.exists():
                live_path.unlink()
                receipt["corpus"].append({"slug": slug, "removed_created_candidate": True})
            else:
                receipt["corpus"].append({"slug": slug, "already_absent": True})
        except Exception as exc:
            receipt["errors"].append(f"corpus {slug}: {exc}")
    for slug, spec in manifest["pages"].items():
        try:
            receipt["db"].append({"slug": slug, **restore_db_snapshot(slug, spec, journal_dir)})
        except Exception as exc:
            receipt["errors"].append(f"db {slug}: {exc}")
    try:
        receipt["edges"] = materialize_edges()
    except Exception as exc:
        receipt["errors"].append(f"edges: {exc}")
    manifest["state"] = "rollback_failed" if receipt["errors"] else "rolled_back"
    manifest["rollback_at"] = iso_now()
    manifest["rollback_errors"] = receipt["errors"]
    write_journal(journal_dir, manifest)
    if receipt["errors"]:
        raise PipelineFailure("promotion-rollback", "; ".join(receipt["errors"]), receipt)
    return receipt


def complete_promotion_journal(
    journal_dir: Path, final_sha256: str, completed_at: str, completed_model: str
) -> None:
    manifest = read_journal(journal_dir)
    manifest["state"] = "completed"
    manifest["completed_at"] = iso_now()
    manifest["final_sha256"] = final_sha256
    manifest["meeting_completed_at"] = completed_at
    manifest["meeting_completed_model"] = completed_model
    write_journal(journal_dir, manifest)


def shadow_ingested_text(text: str, model: str) -> str:
    frontmatter, _, body = _split_frontmatter(text)
    if frontmatter is None or body is None:
        raise PipelineFailure("shadow-qa", "cannot parse meeting for shadow QA")
    frontmatter["status"] = "ingested"
    frontmatter["completed_at"] = "2000-01-01T00:00:00Z"
    frontmatter["completed_model"] = model
    return _render_page(frontmatter, body)


def run_shadow_qa(
    meeting_slug: str,
    meeting_path: Path,
    model: str,
    source_brain_dir: Path | None = None,
    live_meeting_path: Path | None = None,
) -> dict[str, Any]:
    source_root = source_brain_dir or BRAIN_DIR
    if not QA_SCRIPT.exists():
        raise PipelineFailure("shadow-qa", f"QA script missing: {QA_SCRIPT}")
    if not QA_ADAPTER.exists():
        raise PipelineFailure("shadow-qa", f"QA adapter missing: {QA_ADAPTER}")
    temp_root = STATE_DIR / "tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    os.chmod(temp_root, 0o700)
    with tempfile.TemporaryDirectory(prefix="meeting-shadow-", dir=str(temp_root)) as raw_shadow:
        shadow = Path(raw_shadow)
        os.chmod(shadow, 0o700)
        for shelf in ("people", "companies"):
            source = source_root / shelf
            if source.exists():
                shutil.copytree(source, shadow / shelf, copy_function=shutil.copy2)
        shadow_meeting = shadow / f"{meeting_slug}.md"
        shadow_meeting.parent.mkdir(parents=True, exist_ok=True)
        original = meeting_path.read_text(encoding="utf-8", errors="replace")
        atomic_write_text(shadow_meeting, shadow_ingested_text(original, model), 0o600)
        adapter = shadow / "qa-gbrain-adapter.py"
        shutil.copy2(QA_ADAPTER, adapter)
        os.chmod(adapter, 0o700)
        qa_environment = {
            key: value for key, value in os.environ.items() if not is_db_environment_key(key)
        }
        scrubbed_qa_keys = sorted(
            key for key in os.environ if is_db_environment_key(key)
        )
        environment = {
            **qa_environment,
            "BRAIN_DIR": str(shadow),
            "GBRAIN_BIN": str(adapter),
            "GBRAIN_SOURCE": SOURCE_ID,
            "EXEMPT_PAGES": os.environ.get("MEETING_QA_EXEMPT_PAGES", "people/jiraiya"),
            "MEETING_QA_LIVE_PATH": str(live_meeting_path or meeting_path),
        }
        command = ["bash", str(QA_SCRIPT), meeting_slug]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=int(os.environ.get("MEETING_QA_TIMEOUT", "1200")),
                cwd=str(RUNTIME_CWD),
                env=environment,
            )
        except Exception as exc:
            raise PipelineFailure("shadow-qa", f"QA failed to execute: {exc}") from exc
        receipt = command_receipt(command, result)
        receipt.update(
            {
                "shadow_meeting_sha256": sha256_bytes(shadow_meeting.read_bytes()),
                "source_meeting_sha256": sha256_bytes(meeting_path.read_bytes()),
                "live_meeting_sha256": (
                    sha256_bytes(live_meeting_path.read_bytes())
                    if live_meeting_path and live_meeting_path.exists()
                    else None
                ),
                "entity_shelves": [shelf for shelf in ("people", "companies") if (shadow / shelf).exists()],
                "copies_not_symlinks": True,
                "database": "isolated file projection; no production DB connection",
                "qa_adapter_sha256": sha256_bytes(adapter.read_bytes()),
                "db_environment_keys_scrubbed": scrubbed_qa_keys,
            }
        )
        if result.returncode != 0:
            raise PipelineFailure("shadow-qa", "shadow QA returned nonzero", receipt)
        return receipt


def verify_audited_hashes(resume: dict[str, Any], brain_dir: Path | None = None) -> None:
    root = brain_dir or BRAIN_DIR
    for slug, expected in sorted((resume.get("hashes") or {}).items()):
        path = root / f"{slug}.md"
        if not path.exists():
            raise PipelineFailure("hash-gate", f"audited page disappeared: {slug}")
        actual = sha256_bytes(path.read_bytes())
        if actual != expected:
            raise PipelineFailure(
                "hash-gate", f"audited page changed after audit: {slug} expected={expected} actual={actual}"
            )


def stamp_meeting_ingested(
    meeting_path: Path,
    model: str,
    expected_sha256: str,
    expected_completion: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    raw = meeting_path.read_bytes()
    actual_sha = sha256_bytes(raw)
    if actual_sha != expected_sha256:
        raise PipelineFailure(
            "stamp-hash-gate",
            f"meeting changed before stamp expected={expected_sha256} actual={actual_sha}",
        )
    text = raw.decode("utf-8", errors="replace")
    frontmatter, _, body = _split_frontmatter(text)
    if frontmatter is None or body is None:
        raise PipelineFailure("stamp", "meeting frontmatter is not parseable")
    if completion_snapshot(frontmatter) != expected_completion:
        raise PipelineFailure("stamp-hash-gate", "completion fields changed before controller stamp")
    completed_at = iso_now()
    frontmatter["status"] = "ingested"
    frontmatter["completed_at"] = completed_at
    frontmatter["completed_model"] = model
    rendered = _render_page(frontmatter, body)
    atomic_write_text(meeting_path, rendered)
    return {
        "before_sha256": actual_sha,
        "after_sha256": sha256_text(rendered),
        "completed_at": completed_at,
        "completed_model": model,
    }


def materialize_edges() -> dict[str, Any]:
    command = [GBRAIN_BIN, "extract", "links", "--include-frontmatter", "--source", SOURCE_ID]
    environment = {**os.environ, "GBRAIN_SOURCE": SOURCE_ID, "GBRAIN_DISABLE_DIRECT_POOL": "1"}
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=1200,
            cwd=str(RUNTIME_CWD),
            env=environment,
        )
    except Exception as exc:
        raise PipelineFailure("edge-materialization", f"edge command failed to execute: {exc}") from exc
    receipt = command_receipt(command, result)
    if result.returncode != 0:
        raise PipelineFailure("edge-materialization", "edge materialization returned nonzero", receipt)
    return receipt


def _extract_markdown(stdout: str) -> str:
    normalized = (stdout or "").replace("\r\n", "\n")
    start = normalized.find("---\n")
    return normalized[start:] if start >= 0 else normalized


def verify_db_postcondition(
    meeting_slug: str,
    meeting_path: Path,
    expected_status: Any,
    expected_completed_at: Any,
    expected_model: Any,
) -> dict[str, Any]:
    command = [GBRAIN_BIN, "get", meeting_slug, "--source", SOURCE_ID]
    environment = {**os.environ, "GBRAIN_SOURCE": SOURCE_ID, "GBRAIN_DISABLE_DIRECT_POOL": "1"}
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=str(RUNTIME_CWD),
        env=environment,
    )
    receipt = command_receipt(command, result)
    if result.returncode != 0:
        raise PipelineFailure("db-postcondition", "gbrain get returned nonzero", receipt)
    db_text = _extract_markdown(result.stdout)
    db_frontmatter, _, db_body = _split_frontmatter(db_text)
    file_frontmatter, _, file_body = _split_frontmatter(
        meeting_path.read_text(encoding="utf-8", errors="replace")
    )
    if db_frontmatter is None or file_frontmatter is None or db_body is None or file_body is None:
        raise PipelineFailure("db-postcondition", "file or DB page is not parseable", receipt)
    expected = {
        "status": expected_status,
        "completed_at": expected_completed_at,
        "completed_model": expected_model,
    }
    actual = {key: db_frontmatter.get(key) for key in COMPLETION_KEYS}
    if actual != expected:
        receipt.update({"expected_completion": expected, "actual_completion": actual})
        raise PipelineFailure("db-postcondition", "DB completion fields do not match controller stamp", receipt)
    # The CLI renderer may add or remove terminal blank lines. This is an
    # intentional presentation normalization; internal body bytes remain strict.
    canonical_file_body = file_body.replace("\r\n", "\n").rstrip() + "\n"
    canonical_db_body = db_body.replace("\r\n", "\n").rstrip() + "\n"
    file_body_hash = sha256_text(canonical_file_body)
    db_body_hash = sha256_text(canonical_db_body)
    receipt.update(
        {
            "file_body_sha256": file_body_hash,
            "db_body_sha256": db_body_hash,
            "intentional_normalization": (
                "frontmatter may gain engine-managed ingestion fields; terminal body blank lines normalize"
            ),
        }
    )
    if file_body_hash != db_body_hash:
        raise PipelineFailure("db-postcondition", "DB body differs from corpus body", receipt)
    return receipt


def make_resume_checkpoint(
    written: Iterable[str],
    completion_before: dict[str, dict[str, Any]],
    audit_receipt: dict[str, Any],
    brain_dir: Path | None = None,
) -> dict[str, Any]:
    root = brain_dir or BRAIN_DIR
    hashes = {
        slug: sha256_bytes((root / f"{slug}.md").read_bytes()) for slug in sorted(set(written))
    }
    meeting_slugs = [slug for slug in hashes if slug.startswith("meetings/")]
    if len(meeting_slugs) != 1:
        raise PipelineFailure("checkpoint", f"expected one changed meeting, got {meeting_slugs}")
    meeting_text = (root / f"{meeting_slugs[0]}.md").read_text(
        encoding="utf-8", errors="replace"
    )
    _, meeting_frontmatter_text, _ = _split_frontmatter(meeting_text)
    if meeting_frontmatter_text is None:
        raise PipelineFailure("checkpoint", "meeting frontmatter unavailable for exact rollback")
    return {
        "schema_version": 1,
        "checkpointed_at": iso_now(),
        "written": sorted(hashes),
        "hashes": hashes,
        "completion_before": copy.deepcopy(completion_before),
        "meeting_frontmatter_text": meeting_frontmatter_text,
        "audit": copy.deepcopy(audit_receipt),
    }


def process_meeting(
    meeting: dict[str, Any],
    model: str,
    max_turns: int,
    timeout: int,
    ledger: RetryLedger,
    run_id: str,
) -> dict[str, Any]:
    slug = meeting["slug"]
    live_path = Path(meeting["path"])
    result: dict[str, Any] = {
        "meeting": slug,
        "title": meeting.get("title"),
        "ok": False,
        "agent_corpus": "isolated disposable copy",
        "stages": {},
    }
    if not live_path.exists():
        error = f"retry candidate file missing: {live_path}"
        ledger.fail(slug, run_id, error)
        result["error"] = error
        return result
    initial_text = live_path.read_text(encoding="utf-8", errors="replace")
    current_frontmatter, _, _ = _split_frontmatter(initial_text)
    if current_frontmatter is None:
        error = "meeting frontmatter unreadable"
        ledger.fail(slug, run_id, error)
        result["error"] = error
        return result
    current_completion = completion_snapshot(current_frontmatter)
    claim = ledger.claim(
        slug,
        run_id,
        str(current_frontmatter.get("status") or "").lower(),
        live_path,
        current_completion,
        sha256_text(initial_text),
    )
    if claim is None:
        result.update({"busy": True, "error": "retry candidate is actively leased by another run"})
        return result

    completion_before = copy.deepcopy(claim.get("completion_before") or current_completion)
    journal_dir: Path | None = None
    try:
        # A prior process may have died after an audited promotion began. Its
        # durable journal is rolled back before another model call is considered.
        prior_resume = claim.get("resume")
        if isinstance(prior_resume, dict) and prior_resume.get("journal"):
            prior_journal = Path(str(prior_resume["journal"]))
            prior_manifest = read_journal(prior_journal)
            if prior_manifest.get("state") == "completed":
                expected_sha = str(prior_manifest.get("final_sha256") or "")
                actual_sha = sha256_bytes(live_path.read_bytes())
                if not expected_sha or actual_sha != expected_sha:
                    error = "completed journal live hash mismatch"
                    ledger.fail(slug, run_id, error, prior_resume)
                    result.update({"error": error, "failed_stage": "crash-recovery"})
                    return result
                result["stages"]["db_postcondition"] = verify_db_postcondition(
                    slug,
                    live_path,
                    "ingested",
                    prior_manifest.get("meeting_completed_at"),
                    prior_manifest.get("meeting_completed_model"),
                )
                ledger.complete(slug, run_id, actual_sha, iso_now())
                result.update(
                    {
                        "ok": True,
                        "recovered_completed_journal": True,
                        "final_sha256": actual_sha,
                    }
                )
                return result
            try:
                result["stages"]["crash_recovery"] = rollback_promotion_journal(prior_journal)
                ledger.checkpoint_resume(slug, run_id, {})
            except Exception as exc:
                error = f"crash-recovery: {exc}"
                ledger.fail(slug, run_id, error, prior_resume)
                result.update({"error": error, "failed_stage": "crash-recovery"})
                return result
        elif prior_resume:
            # Legacy pre-isolation checkpoints are deliberately not resumed.
            ledger.checkpoint_resume(slug, run_id, {})
            result["stages"]["legacy_checkpoint"] = "discarded; no trusted isolated journal"

        live_before_pages = snapshot_brain_pages(BRAIN_DIR)
        live_before_inventory = snapshot_brain_inventory(BRAIN_DIR)
        live_target_sha = sha256_bytes(live_path.read_bytes())

        with isolated_agent_workspace() as agent_context:
            sandbox_brain = agent_context["brain_dir"]
            sandbox_path = sandbox_brain / f"{slug}.md"
            if not sandbox_path.exists():
                raise PipelineFailure("agent-sandbox", f"sandbox meeting missing: {slug}")
            canary_path = STATE_DIR / f".agent-outside-write-canary-{uuid.uuid4().hex}"
            isolation_canary = run_isolation_canary(agent_context, canary_path)
            result["stages"]["isolation_canary"] = isolation_canary
            if not isolation_canary.get("passed"):
                raise PipelineFailure(
                    "agent-sandbox-canary",
                    "read/write/tool/startup isolation canary failed; refusing model execution",
                    isolation_canary,
                )
            sandbox_meeting = dict(meeting)
            sandbox_meeting["path"] = str(sandbox_path)
            before = snapshot_brain_pages(sandbox_brain)
            inventory_before = snapshot_brain_inventory(sandbox_brain)
            rc, data, _raw_stdout, stderr, isolation = run_claude(
                build_prompt(sandbox_meeting, agent_context["skill_dir"]),
                model,
                max_turns,
                timeout,
                agent_context,
            )
            after = snapshot_brain_pages(sandbox_brain)
            inventory_after = snapshot_brain_inventory(sandbox_brain)
            written, skipped, notes, parsed = parse_agent_receipt(data)
            is_error = bool(data.get("is_error")) if isinstance(data, dict) else False
            expected_completion = completion_snapshot_from_text(before[slug])
            audit = audit_agent_changes(
                before,
                after,
                written,
                slug,
                sandbox_path,
                expected_completion,
                inventory_before,
                inventory_after,
                sandbox_brain,
            )
            result["stages"]["agent"] = {
                "rc": rc,
                "is_error": is_error,
                "receipt_parsed": parsed,
                "written": sorted(value for value in written if isinstance(value, str)),
                "skipped": skipped,
                "notes": notes,
                "stderr_tail": (stderr or "")[-1000:],
                "isolation": isolation,
            }
            result["stages"]["audit"] = audit
            failures = list(audit["violations"])
            if rc != 0:
                failures.append(f"agent rc={rc}")
            if data is None:
                failures.append("agent returned no parseable JSON envelope")
            if is_error:
                failures.append("agent envelope is_error=true")
            if not parsed:
                failures.append("agent receipt missing or invalid")
            if failures:
                # The entire agent workspace is discarded by the context manager.
                # Prove this lane did not touch the live target or production DB.
                live_after_inventory = snapshot_brain_inventory(BRAIN_DIR)
                result["stages"]["discarded_sandbox"] = {
                    "live_target_unchanged": sha256_bytes(live_path.read_bytes()) == live_target_sha,
                    "live_inventory_unchanged": live_after_inventory == live_before_inventory,
                    "db_commands_run": 0,
                }
                error = "; ".join(sorted(set(failures)))
                ledger.fail(slug, run_id, error)
                result["error"] = error
                result["failed_stage"] = "agent-audit"
                return result

            checkpoint = make_resume_checkpoint(
                audit["written"], expected_completion, audit, sandbox_brain
            )
            verify_audited_hashes(checkpoint, sandbox_brain)
            result["stages"]["isolated_qa"] = run_shadow_qa(
                slug,
                sandbox_path,
                model,
                sandbox_brain,
                live_path,
            )
            verify_audited_hashes(checkpoint, sandbox_brain)
            if sha256_bytes(live_path.read_bytes()) != live_target_sha:
                raise PipelineFailure("promotion-toctou", "live target changed during isolated agent/QA")

            db_before = capture_db_snapshots(checkpoint["written"])
            result["stages"]["db_snapshot"] = {
                page: {"active": spec["active"], "sha256": spec["sha256"]}
                for page, spec in db_before.items()
            }
            journal_dir = create_promotion_journal(
                run_id,
                slug,
                checkpoint["written"],
                sandbox_brain,
                live_before_pages,
                db_before,
            )
            ledger.checkpoint_resume(
                slug, run_id, {"journal": str(journal_dir), "phase": "prepared"}
            )
            result["stages"]["promotion"] = promote_promotion_journal(journal_dir)
            ledger.checkpoint_resume(
                slug, run_id, {"journal": str(journal_dir), "phase": "promoted"}
            )

        try:
            verify_audited_hashes(checkpoint, BRAIN_DIR)
            result["stages"]["promoted_import"] = narrow_import_pages(checkpoint["written"])
            result["stages"]["preflight_edges"] = materialize_edges()
            verify_audited_hashes(checkpoint, BRAIN_DIR)
            result["stages"]["hash_gate"] = {"passed": True, "hashes": checkpoint["hashes"]}
            set_journal_state(journal_dir, "stamping")
            stamp = stamp_meeting_ingested(
                live_path,
                model,
                checkpoint["hashes"][slug],
                completion_before,
            )
            result["stages"]["stamp"] = stamp
            set_journal_state(journal_dir, "stamped")
            result["stages"]["stamped_import"] = narrow_import_pages(
                [slug], stage="stamped-import"
            )
            result["stages"]["edges"] = materialize_edges()
            db_verify = verify_db_postcondition(
                slug,
                live_path,
                "ingested",
                stamp["completed_at"],
                model,
            )
            result["stages"]["db_postcondition"] = db_verify
            final_sha = sha256_bytes(live_path.read_bytes())
            complete_promotion_journal(
                journal_dir, final_sha, stamp["completed_at"], model
            )
            ledger.complete(slug, run_id, final_sha, iso_now())
            result["stages"]["ledger_complete"] = True
            result["ok"] = True
            result["final_sha256"] = final_sha
            return result
        except Exception as exc:
            if isinstance(exc, PipelineFailure):
                result["failed_stage"] = exc.stage
                result["stages"][exc.stage] = exc.receipt
            else:
                result["failed_stage"] = "unexpected-poststep"
            try:
                result["stages"]["rollback"] = rollback_promotion_journal(journal_dir)
                rollback_resume = None
            except Exception as rollback_exc:
                result["stages"]["rollback"] = {
                    "failed": True,
                    "error": str(rollback_exc),
                    "journal": str(journal_dir),
                }
                rollback_resume = {"journal": str(journal_dir), "phase": "rollback_failed"}
            error = f"{result['failed_stage']}: {exc}"
            ledger.fail(slug, run_id, error, rollback_resume)
            result["error"] = error
            return result
    except Exception as exc:
        if journal_dir is not None:
            with contextlib.suppress(Exception):
                result["stages"]["rollback"] = rollback_promotion_journal(journal_dir)
        error = f"orchestrator: {exc}"
        with contextlib.suppress(Exception):
            ledger.fail(slug, run_id, error)
        result["error"] = error
        result["failed_stage"] = getattr(exc, "stage", "orchestrator")
        return result


def write_run_artifact(run_id: str, payload: dict[str, Any]) -> Path:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    path = STATE_DIR / f"run-{run_id}.json"
    atomic_write_json(path, payload)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail-closed GBrain meeting completion lane")
    parser.add_argument("--limit", type=int, default=int(os.environ.get("MEETING_COMPLETE_LIMIT", "8")))
    parser.add_argument("--parallel", type=int, default=1, help="compatibility flag; only 1 is safe")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--max-turns", type=int, default=int(os.environ.get("MEETING_COMPLETE_MAX_TURNS", "120")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("MEETING_COMPLETE_TIMEOUT", "3600")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only", default=None)
    parser.add_argument("--no-watermark", action="store_true", help="accepted for compatibility; ledger is authoritative")
    parser.add_argument("--no-edges", action="store_true", help="tests only; rejected for real completion")
    args = parser.parse_args(argv)

    run_id = os.environ.get("MEETING_COMPLETE_RUN_ID") or (
        utc_now().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    )
    artifact: dict[str, Any] = {
        "schema_version": 2,
        "run_id": run_id,
        "started_at": iso_now(),
        "source_id": SOURCE_ID,
        "ledger": str(LEDGER_PATH),
        "completion_authority": "orchestrator",
        "watermark_authority": "retired; retry-ledger is authoritative",
        "results": [],
    }
    rc = 1
    try:
        assert_runtime_helpers()
        if args.parallel != 1:
            raise PipelineFailure("arguments", "parallel meeting agents are disabled for authoritative corpus diffs")
        if args.no_edges and not args.dry_run:
            raise PipelineFailure("arguments", "--no-edges is not permitted for a completing run")
        ledger = RetryLedger()
        selected = select_meetings(args.limit, args.only, ledger)
        artifact["selected"] = len(selected)
        artifact["selection"] = [
            {key: value for key, value in row.items() if key not in {"sort_key", "date_ts"}}
            for row in selected
        ]
        if not selected:
            log("NO-OP: no captured or retry-ledger-eligible meetings")
            artifact.update({"all_ok": True, "noop": True})
            rc = 0
        elif args.dry_run:
            print(build_prompt(selected[0]))
            artifact.update({"all_ok": True, "dry_run": True})
            rc = 0
        else:
            assert_subscription_env()
            assert_entity_types_from_pack()
            for meeting in selected:
                result = process_meeting(
                    meeting, args.model, args.max_turns, args.timeout, ledger, run_id
                )
                artifact["results"].append(result)
            artifact["all_ok"] = all(result.get("ok") for result in artifact["results"])
            artifact["busy_count"] = sum(bool(result.get("busy")) for result in artifact["results"])
            rc = 0 if artifact["all_ok"] else 1
    except Exception as exc:
        artifact.update(
            {
                "all_ok": False,
                "fatal_stage": getattr(exc, "stage", "orchestrator"),
                "fatal_error": str(exc),
            }
        )
        log(f"FATAL: {exc}")
        rc = 1
    finally:
        artifact["finished_at"] = iso_now()
        artifact["rc"] = rc
        try:
            receipt_path = write_run_artifact(run_id, artifact)
            log(f"atomic run receipt: {receipt_path}")
        except Exception as exc:
            log(f"FATAL: could not write atomic run receipt: {exc}")
            rc = rc or 4
    return rc


if __name__ == "__main__":
    sys.exit(main())
