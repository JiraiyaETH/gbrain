#!/usr/bin/env python3
"""Fail-closed prerequisite gate for the scheduled GBrain Dream run."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


LOCAL_TZ = ZoneInfo("Asia/Bangkok")
EXPORT_RECEIPT_SCHEMA = "gbrain-export-success-receipt/v2"
GATE_RECEIPT_SCHEMA = "gbrain-scheduled-dream-gate/v1"
EXPECTED_PROFILES = {
    "claude": ("claude-code",),
    "hermes": ("alex", "seksi"),
}
EXPORTER_OWNER = {
    "claude": "gbrain:claude-session-export",
    "hermes": "gbrain:hermes-session-export",
}
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt-dir", required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--gbrain", required=True)
    parser.add_argument("--wrapper", required=True)
    parser.add_argument("--receipt-writer", required=True)
    parser.add_argument("--filing-rules", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--now", default=None)
    parser.add_argument("--max-age-minutes", type=int, default=180)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def local_now(value: str | None) -> dt.datetime:
    if not value:
        return dt.datetime.now(LOCAL_TZ)
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=LOCAL_TZ)
    return parsed.astimezone(LOCAL_TZ)


def parse_timestamp(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a timezone-aware ISO timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed.astimezone(LOCAL_TZ)


def require_exact_mode(path: Path, expected: int, label: str) -> None:
    actual = stat.S_IMODE(path.stat().st_mode)
    if actual != expected:
        raise ValueError(f"{label} mode must be {expected:04o}, got {actual:04o}")


def require_sealed_artifact(path: Path, label: str) -> Path:
    if path.is_symlink():
        raise ValueError(f"{label} must not be a symlink")
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError(f"{label} is not a regular file")
    if stat.S_IMODE(resolved.stat().st_mode) & 0o022:
        raise ValueError(f"{label} is group/world writable")
    return resolved


def atomic_write_secure(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False
    ) as handle:
        tmp_name = handle.name
        os.chmod(tmp_name, 0o600)
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_name, path)
    os.chmod(path, 0o600)


def manifest_key(entry: dict[str, Any]) -> tuple[str, str, str, int]:
    return (
        str(entry.get("profile") or ""),
        str(entry.get("session_id") or ""),
        str(entry.get("export_date") or ""),
        int(entry.get("part") or 0),
    )


def load_manifest(path: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, int]] = set()
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"manifest row {line_no} is not an object")
        key = manifest_key(value)
        if not all(key[:3]):
            raise ValueError(f"manifest row {line_no} has an incomplete logical key")
        if key in seen:
            raise ValueError(f"duplicate manifest logical key: {key}")
        seen.add(key)
        entries.append(value)
    return entries


def resolve_corpus_path(corpus: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} is missing")
    raw = Path(value).expanduser()
    path = (corpus / raw).resolve() if not raw.is_absolute() else raw.resolve()
    try:
        path.relative_to(corpus)
    except ValueError as exc:
        raise ValueError(f"{label} escapes corpus") from exc
    return path


def stable_identity(*parts: Any) -> str:
    return hashlib.sha256("\0".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def is_receiptable_manifest_entry(entry: dict[str, Any], exporter: str) -> bool:
    try:
        profile, session_id, export_date, manifest_part = manifest_key(entry)
        part_index = entry.get("part_index")
        part_total = entry.get("part_total")
        if not (
            isinstance(part_index, int) and not isinstance(part_index, bool) and part_index > 0
            and isinstance(part_total, int) and not isinstance(part_total, bool)
            and part_total >= part_index
        ):
            return False
        expected_part = part_index if part_total > 1 else 0
        namespace = "claude-code" if exporter == "claude" else "hermes"
        logical_session = stable_identity(1, namespace, profile, session_id, export_date)
        return (
            manifest_part == expected_part
            and entry.get("logical_identity_version") == 1
            and entry.get("settled") is True
            and entry.get("source_namespace") == namespace
            and entry.get("exporter_owner") == EXPORTER_OWNER[exporter]
            and entry.get("provenance_kind") == "human-session"
            and entry.get("automated") is False
            and entry.get("dream_generated") is False
            and entry.get("logical_session_id") == logical_session
            and entry.get("logical_transcript_id") == stable_identity(logical_session, part_index)
        )
    except (TypeError, ValueError):
        return False


def projection_for(
    exporter: str, entries: list[dict[str, Any]], night: dt.date
) -> list[dict[str, Any]]:
    owner = EXPORTER_OWNER[exporter]
    if exporter == "claude":
        projection = [
            entry
            for entry in entries
            if str(entry.get("profile") or "") == "claude-code"
            and entry.get("exporter_owner") in (None, "", owner)
            and is_receiptable_manifest_entry(entry, exporter)
            and dt.date.fromisoformat(str(entry.get("export_date"))) <= night
        ]
    else:
        projection = [
            entry
            for entry in entries
            if str(entry.get("profile") or "") in EXPECTED_PROFILES["hermes"]
            and entry.get("exporter_owner") in (None, "", owner)
            and is_receiptable_manifest_entry(entry, exporter)
            and dt.date.fromisoformat(str(entry.get("export_date"))) <= night
        ]
    return sorted(projection, key=manifest_key)


def declared_live_exporter_output(path: Path, exporter: str) -> bool:
    metadata: dict[str, Any] = {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            if handle.readline().rstrip("\r\n") != "---":
                return False
            for _ in range(256):
                line = handle.readline()
                if not line or line.rstrip("\r\n") == "---":
                    break
                key, separator, raw = line.partition(":")
                if separator:
                    try:
                        metadata[key.strip()] = json.loads(raw.strip())
                    except json.JSONDecodeError:
                        return False
    except (OSError, UnicodeError):
        return False
    return (
        metadata.get("exporter_owner") == EXPORTER_OWNER[exporter]
        and metadata.get("logical_identity_version") == 1
        and metadata.get("settled") is True
    )


def active_tree(
    exporter: str, corpus: Path, night: dt.date, covered_paths: set[Path]
) -> set[Path]:
    paths = set(covered_paths)
    if exporter == "claude":
        root = corpus / "claude-code"
        if root.exists():
            paths.update(
                path.resolve()
                for path in root.rglob("*.md")
                if path.is_file() and declared_live_exporter_output(path, exporter)
            )
        return paths
    for profile in EXPECTED_PROFILES["hermes"]:
        root = corpus / profile
        if root.exists():
            paths.update(
                path.resolve()
                for path in root.rglob("*.md")
                if path.is_file()
                and output_is_covered_through(path, night)
                and declared_live_exporter_output(path, exporter)
            )
    return paths


def output_is_covered_through(path: Path, night: dt.date) -> bool:
    try:
        return dt.date.fromisoformat(path.name[:10]) <= night
    except ValueError:
        return True


def expected_artifacts(runtime_dir: Path, python: Path, exporter: str) -> dict[str, str]:
    paths = {
        "python": python,
        "exporter": runtime_dir
        / ("export-claude-session-corpus.py" if exporter == "claude" else "export-gbrain-session-corpus.py"),
        "wrapper": runtime_dir
        / ("claude-session-export-run.sh" if exporter == "claude" else "session-export-run.sh"),
        "receipt_helper": runtime_dir / "export-receipt.py",
        "lock_helper": runtime_dir / "run-lock.py",
    }
    return {
        label: sha256_file(require_sealed_artifact(path, f"{exporter} artifact {label}"))
        for label, path in sorted(paths.items())
    }


def expected_dream_artifacts(args: argparse.Namespace) -> dict[str, str]:
    paths = {
        "python": Path(args.python),
        "gbrain": Path(args.gbrain),
        "wrapper": Path(args.wrapper),
        "verifier": Path(__file__),
        "receipt_writer": Path(args.receipt_writer),
        "filing_rules": Path(args.filing_rules),
        "lock_helper": Path(args.runtime_dir) / "run-lock.py",
    }
    return {
        label: sha256_file(require_sealed_artifact(path, f"Dream artifact {label}"))
        for label, path in sorted(paths.items())
    }


def receipt_path(receipt_dir: Path, night: dt.date, exporter: str) -> Path:
    return receipt_dir / f"{night.isoformat()}__{exporter}__success.json"


def validate_receipt_shape(
    receipt: dict[str, Any], exporter: str, night: dt.date, now: dt.datetime, max_age: dt.timedelta
) -> dt.datetime:
    if receipt.get("schema") != EXPORT_RECEIPT_SCHEMA:
        raise ValueError(f"{exporter} receipt schema is not {EXPORT_RECEIPT_SCHEMA}")
    if receipt.get("status") != "success" or receipt.get("exporter") != exporter:
        raise ValueError(f"{exporter} receipt is not successful or has the wrong exporter")
    if receipt.get("night_id") != night.isoformat():
        raise ValueError(f"{exporter} receipt has the wrong intended night")
    created = parse_timestamp(receipt.get("created_at"), f"{exporter}.created_at")
    if created.date() != now.date():
        raise ValueError(f"{exporter} receipt was not created on this Bangkok run date")
    age = now - created
    if age < -dt.timedelta(minutes=5):
        raise ValueError(f"{exporter} receipt is dated in the future")
    if age > max_age:
        raise ValueError(f"{exporter} receipt is stale ({int(age.total_seconds() // 60)} minutes)")
    return created


def validate_selection(
    receipt: dict[str, Any], exporter: str, night: dt.date, by_key: dict[tuple[str, str, str, int], dict[str, Any]], corpus: Path
) -> None:
    selection = receipt.get("selection")
    if not isinstance(selection, dict):
        raise ValueError(f"{exporter} selection is missing")
    if tuple(selection.get("profiles") or ()) != EXPECTED_PROFILES[exporter]:
        raise ValueError(f"{exporter} receipt has the wrong covered profiles")
    dates = list(selection.get("dates") or [])
    if exporter == "hermes":
        if dates != [night.isoformat()] or selection.get("settled_through") is not None:
            raise ValueError("Hermes receipt does not select exactly the intended closed day")
    else:
        if selection.get("settled_through") != night.isoformat():
            raise ValueError("Claude receipt has the wrong settled-through day")
        if dates != sorted(set(dates)) or any(dt.date.fromisoformat(value) > night for value in dates):
            raise ValueError("Claude receipt has invalid selected settlement dates")

    raw_keys = selection.get("manifest_keys") or []
    if not isinstance(raw_keys, list) or any(not isinstance(value, dict) for value in raw_keys):
        raise ValueError(f"{exporter} selection keys are invalid")
    keys = [manifest_key(value) for value in raw_keys]
    if keys != sorted(keys) or len(keys) != len(set(keys)):
        raise ValueError(f"{exporter} selection keys are not unique and canonical")
    if any(key not in by_key for key in keys):
        raise ValueError(f"{exporter} selected key is missing from the current manifest")
    if any(key[0] not in EXPECTED_PROFILES[exporter] for key in keys):
        raise ValueError(f"{exporter} selected key has the wrong profile")
    if exporter == "hermes" and any(key[2] != night.isoformat() for key in keys):
        raise ValueError("Hermes selected key has the wrong date")
    if exporter == "claude" and any(dt.date.fromisoformat(key[2]) > night for key in keys):
        raise ValueError("Claude selected key is not settled")

    output_values = selection.get("output_paths") or []
    if not isinstance(output_values, list):
        raise ValueError(f"{exporter} selection output paths are invalid")
    output_paths = [resolve_corpus_path(corpus, value, f"{exporter} selection output") for value in output_values]
    if output_paths != sorted(set(output_paths)):
        raise ValueError(f"{exporter} selection output paths are not unique and canonical")
    manifest_outputs = {
        resolve_corpus_path(corpus, by_key[key].get("output_path"), f"{exporter} manifest output")
        for key in keys
    }
    if set(output_paths) != manifest_outputs:
        raise ValueError(f"{exporter} selected outputs do not match selected keys")

    counts = receipt.get("selected_counts")
    expected_counts = {
        "logical_sessions": len({(key[0], key[1], key[2]) for key in keys}),
        "parts": len(keys),
        "files": len(output_paths),
    }
    if counts != expected_counts:
        raise ValueError(f"{exporter} selected counts do not match sealed selection")


def validate_projection(
    receipt: dict[str, Any], exporter: str, entries: list[dict[str, Any]], corpus: Path, night: dt.date
) -> dict[str, Any]:
    projection = projection_for(exporter, entries, night)
    projection_payload = "".join(canonical_json(entry) + "\n" for entry in projection).encode("utf-8")
    outputs = [
        resolve_corpus_path(corpus, entry.get("output_path"), f"{exporter} covered output")
        for entry in projection
    ]
    if len(outputs) != len(set(outputs)):
        raise ValueError(f"{exporter} projection maps multiple keys to one output")
    covered = set(outputs)
    active = active_tree(exporter, corpus, night, covered)
    if active != covered:
        raise ValueError(
            f"{exporter} active tree differs from its manifest projection "
            f"(active={len(active)} covered={len(covered)})"
        )
    tree_rows: list[dict[str, str]] = []
    for path in sorted(covered):
        if not path.is_file():
            raise ValueError(f"{exporter} covered output is missing")
        tree_rows.append({"path": str(path.relative_to(corpus)), "sha256": sha256_file(path)})
    tree_payload = "".join(canonical_json(value) + "\n" for value in tree_rows).encode("utf-8")
    expected_manifest = {
        "path": ".manifest.jsonl",
        "projection_sha256": sha256_bytes(projection_payload),
        "projection_rows": len(projection),
    }
    manifest_block = receipt.get("manifest")
    if not isinstance(manifest_block, dict):
        raise ValueError(f"{exporter} manifest seal is missing")
    for key, expected in expected_manifest.items():
        if manifest_block.get(key) != expected:
            raise ValueError(f"{exporter} manifest {key} does not match current projection")
    if not HEX_SHA256.fullmatch(str(manifest_block.get("snapshot_sha256") or "")):
        raise ValueError(f"{exporter} manifest snapshot hash is malformed")
    expected_tree = {
        "projection_sha256": sha256_bytes(tree_payload),
        "projection_files": len(tree_rows),
    }
    if receipt.get("tree") != expected_tree:
        raise ValueError(f"{exporter} tree seal does not match current covered tree")
    expected_covered = {"manifest_rows": len(projection), "files": len(tree_rows)}
    if receipt.get("covered_counts") != expected_covered:
        raise ValueError(f"{exporter} covered counts do not match current projection")
    if not HEX_SHA256.fullmatch(str(receipt.get("summary_sha256") or "")):
        raise ValueError(f"{exporter} summary hash is malformed")
    return {
        "manifest_projection_sha256": expected_manifest["projection_sha256"],
        "manifest_rows": len(projection),
        "tree_projection_sha256": expected_tree["projection_sha256"],
        "files": len(tree_rows),
    }


def reject_unsettled_residue(entries: list[dict[str, Any]], corpus: Path, night: dt.date) -> None:
    for entry in entries:
        profile = str(entry.get("profile") or "")
        owner = entry.get("exporter_owner")
        if profile == "claude-code" and owner in (None, "", EXPORTER_OWNER["claude"]):
            if dt.date.fromisoformat(str(entry.get("export_date"))) > night:
                raise ValueError("current/future Claude manifest residue is not settled")
        if profile in EXPECTED_PROFILES["hermes"] and owner in (None, "", EXPORTER_OWNER["hermes"]):
            if dt.date.fromisoformat(str(entry.get("export_date"))) > night:
                raise ValueError("current/future Hermes manifest residue is not settled")

    future_prefix = (night + dt.timedelta(days=1)).isoformat()
    for profile in EXPECTED_PROFILES["hermes"]:
        root = corpus / profile
        if not root.exists():
            continue
        for path in root.rglob("*.md"):
            name_date = path.name[:10]
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", name_date) and name_date >= future_prefix:
                raise ValueError("current/future Hermes output residue is not settled")


def main() -> int:
    args = parse_args()
    if args.max_age_minutes <= 0:
        raise ValueError("--max-age-minutes must be positive")
    now = local_now(args.now)
    night = now.date() - dt.timedelta(days=1)
    max_age = dt.timedelta(minutes=args.max_age_minutes)
    receipt_dir = Path(args.receipt_dir).expanduser().resolve()
    corpus = Path(args.corpus).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser().resolve()
    runtime_dir = Path(args.runtime_dir).expanduser().resolve()
    python = Path(args.python).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not receipt_dir.is_dir() or not corpus.is_dir() or not manifest_path.is_file() or not runtime_dir.is_dir():
        raise ValueError("receipt directory, corpus, manifest, and runtime directory must exist")
    require_exact_mode(receipt_dir, 0o700, "receipt directory")
    if stat.S_IMODE(runtime_dir.stat().st_mode) & 0o022:
        raise ValueError("runtime directory is group/world writable")

    entries = load_manifest(manifest_path)
    by_key = {manifest_key(entry): entry for entry in entries}
    reject_unsettled_residue(entries, corpus, night)
    receipts: dict[str, dict[str, Any]] = {}
    created: dict[str, dt.datetime] = {}
    projections: dict[str, dict[str, Any]] = {}
    prerequisites: dict[str, dict[str, Any]] = {}
    for exporter in ("claude", "hermes"):
        path = receipt_path(receipt_dir, night, exporter)
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"{exporter} success receipt is missing or is a symlink")
        require_exact_mode(path, 0o600, f"{exporter} receipt")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"{exporter} receipt is not an object")
        receipts[exporter] = value
        created[exporter] = validate_receipt_shape(value, exporter, night, now, max_age)
        validate_selection(value, exporter, night, by_key, corpus)
        projections[exporter] = validate_projection(value, exporter, entries, corpus, night)
        expected = expected_artifacts(runtime_dir, python, exporter)
        if value.get("runtime_artifacts") != expected:
            raise ValueError(f"{exporter} runtime artifact checksums do not match sealed runtime")
        prerequisites[exporter] = {
            "path": path.name,
            "sha256": sha256_file(path),
            "created_at": value["created_at"],
        }

    if created["claude"] > created["hermes"]:
        raise ValueError("Hermes receipt must be the later shared-manifest snapshot")
    current_manifest_sha = sha256_file(manifest_path)
    if receipts["hermes"]["manifest"].get("snapshot_sha256") != current_manifest_sha:
        raise ValueError("current full manifest does not match the later Hermes snapshot")

    dream_artifacts = expected_dream_artifacts(args)

    gate = {
        "schema": GATE_RECEIPT_SCHEMA,
        "status": "success",
        "night_id": night.isoformat(),
        "created_at": now.isoformat(),
        "expected_profiles": {key: list(value) for key, value in EXPECTED_PROFILES.items()},
        "current_manifest_sha256": current_manifest_sha,
        "prerequisites": prerequisites,
        "verified_projections": projections,
        "runtime_artifacts": dream_artifacts,
    }
    atomic_write_secure(output, gate)
    print(json.dumps(gate, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"scheduled Dream prerequisite gate failed: {exc}", file=os.sys.stderr)
        raise SystemExit(65)
