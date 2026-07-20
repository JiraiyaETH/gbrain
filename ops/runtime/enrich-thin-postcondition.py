#!/usr/bin/env python3
"""Controller-owned postconditions and retry state for enrich-thin."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


AUDIT_SCHEMA = "gbrain-enrich-thin-postcondition/v1"
LEDGER_SCHEMA = "gbrain-enrich-thin-retry-ledger/v1"


class AuditFailure(Exception):
    def __init__(self, reason: str, detail: str, exit_code: int) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail
        self.exit_code = exit_code


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False
    ) as handle:
        temporary = Path(handle.name)
        os.chmod(temporary, 0o600)
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    with tempfile.NamedTemporaryFile("wb", dir=str(path.parent), prefix=f".{path.name}.", delete=False) as handle:
        temporary = Path(handle.name)
        os.chmod(temporary, 0o600)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def parse_timestamp(value: str, label: str, *, reason: str = "invalid_timestamp") -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise AuditFailure(reason, f"{label} is not an ISO-8601 timestamp", 74) from exc
    if parsed.tzinfo is None:
        raise AuditFailure(reason, f"{label} must be timezone-aware", 74)
    return parsed.astimezone(dt.timezone.utc)


def validate_slug(slug: str) -> str:
    if not slug or any(token in slug for token in ("\x00", "\n", "\r", "\\", "=", "|")):
        raise AuditFailure("invalid_slug", "slug contains a forbidden character", 65)
    path = PurePosixPath(slug)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise AuditFailure("invalid_slug", "slug is not a safe relative path", 65)
    if any(any(ord(char) < 32 or ord(char) == 127 for char in part) for part in path.parts):
        raise AuditFailure("invalid_slug", "slug contains a control character", 65)
    return slug


def resolve_target(brain_dir: Path, slug: str) -> Path:
    validate_slug(slug)
    root = brain_dir.expanduser().resolve(strict=True)
    candidate = Path(str(root.joinpath(*PurePosixPath(slug).parts)) + ".md")
    cursor = root
    for part in PurePosixPath(slug).parts[:-1]:
        cursor = cursor / part
        if cursor.is_symlink():
            raise AuditFailure("target_invalid", "target path traverses a symlink", 71)
    try:
        metadata = candidate.lstat()
    except FileNotFoundError as exc:
        raise AuditFailure("target_missing", "exact target markdown file is missing", 70) from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise AuditFailure("target_invalid", "exact target is not a regular non-symlink file", 71)
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise AuditFailure("target_invalid", "exact target resolves outside the Brain directory", 71) from exc
    return resolved


def split_frontmatter(content: str) -> tuple[list[str], str]:
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if "\x00" in normalized:
        raise AuditFailure("frontmatter_invalid", "target contains a NUL byte", 76)
    lines = normalized.split("\n")
    if not lines or lines[0].strip() != "---":
        raise AuditFailure("frontmatter_invalid", "target has no opening frontmatter delimiter", 76)
    closing = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if closing is None:
        raise AuditFailure("frontmatter_invalid", "target has no closing frontmatter delimiter", 76)
    return lines[1:closing], "\n".join(lines[closing + 1 :])


def enriched_at_from_lines(lines: list[str], *, required: bool) -> str | None:
    values: list[str] = []
    for line in lines:
        match = re.match(r"^enriched_at\s*:\s*(.*?)\s*$", line)
        if not match:
            continue
        value = match.group(1).strip()
        if value and value[0] not in {"'", '"'}:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values.append(value)
    if not values or not values[0]:
        if not required:
            return None
        raise AuditFailure("missing_enriched_at", "frontmatter is missing enriched_at", 73)
    if len(values) != 1:
        raise AuditFailure("frontmatter_invalid", "frontmatter contains duplicate enriched_at keys", 76)
    return values[0]


def split_body(body: str) -> tuple[str, str]:
    lines = body.split("\n")
    split_at: int | None = None
    for index, line in enumerate(lines):
        trimmed = line.strip()
        if trimmed in {"<!-- timeline -->", "<!--timeline-->"}:
            split_at = index
            break
        if re.match(r"^---\s+timeline\s+---$", trimmed, flags=re.IGNORECASE):
            split_at = index
            break
        if trimmed == "---" and "\n".join(lines[:index]).strip():
            for following in lines[index + 1 :]:
                following = following.strip()
                if not following:
                    continue
                if re.match(r"^##\s+(timeline|history)\b", following, flags=re.IGNORECASE):
                    split_at = index
                break
            if split_at is not None:
                break
    if split_at is None:
        return body.strip(), ""
    return "\n".join(lines[:split_at]).strip(), "\n".join(lines[split_at + 1 :]).strip()


def parse_page(path: Path, *, require_enriched_at: bool = True) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AuditFailure("frontmatter_invalid", "target is not valid UTF-8", 76) from exc
    frontmatter, body = split_frontmatter(content)
    enriched_at = enriched_at_from_lines(frontmatter, required=require_enriched_at)
    compiled_truth, timeline = split_body(body)
    return {
        "sha256": sha256_bytes(raw),
        "bytes": len(raw),
        "enriched_at": enriched_at,
        "compiled_truth": compiled_truth,
        "timeline": timeline,
        "body_sha256": sha256_bytes((compiled_truth + "\n<!-- timeline -->\n" + timeline).encode("utf-8")),
    }


def audit_payload(command: str, status: str, reason: str, **values: Any) -> dict[str, Any]:
    return {"schema": AUDIT_SCHEMA, "command": command, "status": status, "reason": reason, **values}


def load_snapshot(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AuditFailure("snapshot_invalid", "snapshot receipt cannot be read", 67) from exc
    if payload.get("schema") != AUDIT_SCHEMA or payload.get("command") != "snapshot" or payload.get("status") != "pass":
        raise AuditFailure("snapshot_invalid", "snapshot receipt is not a successful snapshot", 67)
    return payload


def recheck_snapshot_target(snapshot: dict[str, Any]) -> Path:
    target = Path(snapshot["target_path"])
    try:
        metadata = target.lstat()
    except FileNotFoundError as exc:
        raise AuditFailure("target_missing", "exact target disappeared after snapshot", 70) from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise AuditFailure("target_invalid", "exact target is no longer a regular non-symlink file", 71)
    if target.resolve(strict=True) != target:
        raise AuditFailure("target_invalid", "exact target path changed resolution after snapshot", 71)
    return target


def command_snapshot(args: argparse.Namespace) -> dict[str, Any]:
    started = parse_timestamp(args.started_at, "started_at")
    target = resolve_target(Path(args.brain_dir), args.slug)
    raw = target.read_bytes()
    page = parse_page(target, require_enriched_at=False)
    atomic_write_bytes(Path(args.backup).expanduser().resolve(), raw)
    return audit_payload(
        "snapshot",
        "pass",
        "snapshotted",
        slug=args.slug,
        target_path=str(target),
        started_at=started.isoformat(),
        before_sha256=sha256_bytes(raw),
        before_bytes=len(raw),
        before_body_sha256=page["body_sha256"],
        backup_sha256=sha256_file(Path(args.backup).expanduser().resolve()),
    )


def command_verify_source(args: argparse.Namespace) -> dict[str, Any]:
    snapshot = load_snapshot(Path(args.snapshot).expanduser().resolve())
    started = parse_timestamp(args.started_at, "started_at")
    target = recheck_snapshot_target(snapshot)
    current_raw = target.read_bytes()
    if sha256_bytes(current_raw) == snapshot["before_sha256"]:
        raise AuditFailure("source_unchanged", "Claude exited without changing the exact target file", 72)
    current = parse_page(target)
    if current["body_sha256"] == snapshot["before_body_sha256"]:
        raise AuditFailure("body_unchanged", "only metadata changed; the page body/timeline is unchanged", 72)
    enriched_at = parse_timestamp(current["enriched_at"], "enriched_at", reason="invalid_enriched_at")
    if enriched_at < started:
        raise AuditFailure("stale_enriched_at", "enriched_at predates the controller run", 75)
    return audit_payload(
        "verify_source",
        "pass",
        "source_verified",
        slug=snapshot["slug"],
        target_path=str(target),
        started_at=started.isoformat(),
        before_sha256=snapshot["before_sha256"],
        after_sha256=current["sha256"],
        after_bytes=current["bytes"],
        enriched_at=enriched_at.isoformat(),
    )


def command_verify_parity(args: argparse.Namespace) -> dict[str, Any]:
    snapshot = load_snapshot(Path(args.snapshot).expanduser().resolve())
    started = parse_timestamp(args.started_at, "started_at")
    source = parse_page(recheck_snapshot_target(snapshot))
    database = parse_page(Path(args.db_markdown).expanduser().resolve())
    source_stamp = parse_timestamp(source["enriched_at"], "source enriched_at", reason="invalid_enriched_at")
    database_stamp = parse_timestamp(database["enriched_at"], "database enriched_at", reason="invalid_enriched_at")
    if source_stamp < started or database_stamp < started:
        raise AuditFailure("stale_enriched_at", "source or database enriched_at predates the controller run", 75)
    if source_stamp != database_stamp:
        raise AuditFailure("db_status_mismatch", "database enriched_at does not match the exact source", 77)
    if source["compiled_truth"] != database["compiled_truth"] or source["timeline"] != database["timeline"]:
        raise AuditFailure("db_body_mismatch", "database body/timeline does not match the exact source", 78)
    return audit_payload(
        "verify_parity",
        "pass",
        "verified",
        slug=snapshot["slug"],
        target_path=snapshot["target_path"],
        started_at=started.isoformat(),
        source_sha256=source["sha256"],
        database_markdown_sha256=database["sha256"],
        enriched_at=source_stamp.isoformat(),
        body_sha256=source["body_sha256"],
    )


def empty_ledger() -> dict[str, Any]:
    return {"schema": LEDGER_SCHEMA, "entries": {}}


def load_ledger(path: Path) -> dict[str, Any]:
    if not path.exists():
        return empty_ledger()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AuditFailure("retry_ledger_invalid", "retry ledger cannot be read", 68) from exc
    if payload.get("schema") != LEDGER_SCHEMA or not isinstance(payload.get("entries"), dict):
        raise AuditFailure("retry_ledger_invalid", "retry ledger has an invalid schema", 68)
    for slug, entry in payload["entries"].items():
        validate_slug(slug)
        if not isinstance(entry, dict):
            raise AuditFailure("retry_ledger_invalid", "retry ledger entry is not an object", 68)
    return payload


def command_candidates(args: argparse.Namespace) -> int:
    maximum = int(args.max)
    if maximum < 0:
        raise AuditFailure("invalid_max", "candidate maximum is negative", 65)
    if maximum == 0:
        return 0
    ledger = load_ledger(Path(args.ledger).expanduser().resolve())
    query_lines = Path(args.query_file).read_text(encoding="utf-8").splitlines()
    ordered = list(sorted(ledger["entries"])) + query_lines
    seen: set[str] = set()
    selected: list[str] = []
    for raw_slug in ordered:
        slug = raw_slug.strip()
        if not slug or slug in seen:
            continue
        validate_slug(slug)
        seen.add(slug)
        selected.append(slug)
        if len(selected) >= maximum:
            break
    if selected:
        print("\n".join(selected))
    return 0


def command_ledger_mark(args: argparse.Namespace) -> int:
    validate_slug(args.slug)
    event_at = parse_timestamp(args.at, "at")
    ledger_path = Path(args.ledger).expanduser().resolve()
    ledger = load_ledger(ledger_path)
    previous = ledger["entries"].get(args.slug, {})
    ledger["entries"][args.slug] = {
        "first_failed_at": previous.get("first_failed_at", event_at.isoformat()),
        "last_failed_at": event_at.isoformat(),
        "last_reason": args.reason,
        "last_run_id": args.run_id,
        "attempts": int(previous.get("attempts", 0)) + 1,
    }
    atomic_write_json(ledger_path, ledger)
    return 0


def command_ledger_clear(args: argparse.Namespace) -> int:
    validate_slug(args.slug)
    ledger_path = Path(args.ledger).expanduser().resolve()
    ledger = load_ledger(ledger_path)
    ledger["entries"].pop(args.slug, None)
    atomic_write_json(ledger_path, ledger)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--brain-dir", required=True)
    snapshot.add_argument("--slug", required=True)
    snapshot.add_argument("--started-at", required=True)
    snapshot.add_argument("--backup", required=True)
    snapshot.add_argument("--output", required=True)

    source = subparsers.add_parser("verify-source")
    source.add_argument("--snapshot", required=True)
    source.add_argument("--started-at", required=True)
    source.add_argument("--output", required=True)

    parity = subparsers.add_parser("verify-parity")
    parity.add_argument("--snapshot", required=True)
    parity.add_argument("--db-markdown", required=True)
    parity.add_argument("--started-at", required=True)
    parity.add_argument("--output", required=True)

    candidates = subparsers.add_parser("candidates")
    candidates.add_argument("--ledger", required=True)
    candidates.add_argument("--query-file", required=True)
    candidates.add_argument("--max", required=True)

    mark = subparsers.add_parser("ledger-mark")
    mark.add_argument("--ledger", required=True)
    mark.add_argument("--slug", required=True)
    mark.add_argument("--reason", required=True)
    mark.add_argument("--run-id", required=True)
    mark.add_argument("--at", required=True)

    clear = subparsers.add_parser("ledger-clear")
    clear.add_argument("--ledger", required=True)
    clear.add_argument("--slug", required=True)
    return parser


def run_audit_command(args: argparse.Namespace) -> int:
    output = Path(args.output).expanduser().resolve()
    try:
        if args.command == "snapshot":
            payload = command_snapshot(args)
        elif args.command == "verify-source":
            payload = command_verify_source(args)
        elif args.command == "verify-parity":
            payload = command_verify_parity(args)
        else:
            raise AssertionError(args.command)
    except AuditFailure as exc:
        payload = audit_payload(args.command, "fail", exc.reason, detail=exc.detail)
        atomic_write_json(output, payload)
        print(exc.reason)
        return exc.exit_code
    except (OSError, ValueError, KeyError, TypeError):
        payload = audit_payload(
            args.command,
            "fail",
            "controller_error",
            detail="postcondition controller could not complete its audit",
        )
        atomic_write_json(output, payload)
        print("controller_error")
        return 66
    atomic_write_json(output, payload)
    print(payload["reason"])
    return 0


def main() -> int:
    args = build_parser().parse_args()
    if args.command in {"snapshot", "verify-source", "verify-parity"}:
        return run_audit_command(args)
    if args.command == "candidates":
        return command_candidates(args)
    if args.command == "ledger-mark":
        return command_ledger_mark(args)
    if args.command == "ledger-clear":
        return command_ledger_clear(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AuditFailure, OSError, ValueError, KeyError, TypeError) as exc:
        reason = exc.reason if isinstance(exc, AuditFailure) else "controller_error"
        print(f"{reason}: {exc}", file=os.sys.stderr)
        raise SystemExit(exc.exit_code if isinstance(exc, AuditFailure) else 66)
