#!/usr/bin/env python3
"""Seal a successful scheduled transcript export into an atomic receipt.

The receipt carries enough selection detail for the scheduled Dream gate to
recompute the selected counts, exporter-owned manifest projection, and exact
covered output tree without trusting the transient exporter summary.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


SCHEMA = "gbrain-export-success-receipt/v2"
EXPORTER_OWNER = {
    "claude": "gbrain:claude-session-export",
    "hermes": "gbrain:hermes-session-export",
}
EXPECTED_PROFILES = {
    "claude": ("claude-code",),
    "hermes": ("alex", "seksi"),
}
REQUIRED_ARTIFACT_LABELS = {
    "python", "exporter", "wrapper", "receipt_helper", "lock_helper",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exporter", required=True, choices=("claude", "hermes"))
    parser.add_argument("--night-id", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--receipt-dir", required=True)
    parser.add_argument("--artifact", action="append", default=[])
    parser.add_argument("--now", default=None)
    parser.add_argument(
        "--verify",
        action="store_true",
        help="validate and print the expected receipt path without writing it",
    )
    return parser.parse_args()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def manifest_key(entry: dict[str, Any]) -> tuple[str, str, str, int]:
    return (
        str(entry.get("profile") or ""),
        str(entry.get("session_id") or ""),
        str(entry.get("export_date") or ""),
        int(entry.get("part") or 0),
    )


def key_object(key: tuple[str, str, str, int]) -> dict[str, Any]:
    return {
        "profile": key[0],
        "session_id": key[1],
        "export_date": key[2],
        "part": key[3],
    }


def stable_identity(*parts: Any) -> str:
    return hashlib.sha256("\0".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def assert_settled_identity_v1(entry: dict[str, Any], exporter: str) -> None:
    profile, session_id, export_date, manifest_part = manifest_key(entry)
    namespace = "claude-code" if exporter == "claude" else "hermes"
    owner = EXPORTER_OWNER[exporter]
    version = entry.get("logical_identity_version")
    if not (isinstance(version, int) and not isinstance(version, bool) and version == 1):
        raise ValueError("covered manifest row lacks literal identity version 1")
    part_index = entry.get("part_index")
    part_total = entry.get("part_total")
    if not (
        isinstance(part_index, int)
        and not isinstance(part_index, bool)
        and part_index > 0
        and isinstance(part_total, int)
        and not isinstance(part_total, bool)
        and part_total >= part_index
    ):
        raise ValueError("covered manifest row has invalid part identity")
    expected_manifest_part = part_index if part_total > 1 else 0
    if manifest_part != expected_manifest_part:
        raise ValueError("covered manifest row part key conflicts with part identity")
    logical_session_id = stable_identity(1, namespace, profile, session_id, export_date)
    if not (
        entry.get("settled") is True
        and entry.get("source_namespace") == namespace
        and entry.get("exporter_owner") == owner
        and entry.get("provenance_kind") == "human-session"
        and entry.get("automated") is False
        and entry.get("dream_generated") is False
        and entry.get("logical_session_id") == logical_session_id
        and entry.get("logical_transcript_id")
        == stable_identity(logical_session_id, part_index)
    ):
        raise ValueError("covered manifest row fails settled provenance/identity contract")


def is_receiptable_manifest_entry(entry: dict[str, Any], exporter: str) -> bool:
    try:
        assert_settled_identity_v1(entry, exporter)
    except (TypeError, ValueError):
        return False
    return True


def load_manifest(path: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, int]] = set()
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        entry = json.loads(line)
        if not isinstance(entry, dict):
            raise ValueError(f"manifest row {line_no} is not an object")
        key = manifest_key(entry)
        if not all(key[:3]):
            raise ValueError(f"manifest row {line_no} has an incomplete logical key")
        if key in seen:
            raise ValueError(f"duplicate manifest logical key: {key}")
        seen.add(key)
        entries.append(entry)
    return entries


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


def parse_artifacts(values: list[str]) -> dict[str, str]:
    artifacts: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise ValueError("--artifact must be label=/absolute/path")
        label, raw_path = value.split("=", 1)
        path = Path(raw_path).expanduser().resolve()
        if not label or label in artifacts or not path.is_file():
            raise ValueError(f"invalid artifact: {label}")
        artifacts[label] = sha256_file(path)
    if set(artifacts) != REQUIRED_ARTIFACT_LABELS:
        raise ValueError(
            "runtime artifact labels must be exactly: "
            + ",".join(sorted(REQUIRED_ARTIFACT_LABELS))
        )
    return dict(sorted(artifacts.items()))


def resolve_output(corpus: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError("selected output path is missing")
    path = Path(value).expanduser().resolve()
    try:
        path.relative_to(corpus)
    except ValueError as exc:
        raise ValueError("selected output escapes corpus") from exc
    return path


def projection_for(
    exporter: str,
    entries: list[dict[str, Any]],
    night: dt.date,
    profiles: tuple[str, ...],
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
        profile_set = set(profiles)
        projection = [
            entry
            for entry in entries
            if str(entry.get("profile") or "") in profile_set
            and entry.get("exporter_owner") in (None, "", owner)
            and is_receiptable_manifest_entry(entry, exporter)
            and dt.date.fromisoformat(str(entry.get("export_date"))) <= night
        ]
    projection.sort(key=manifest_key)
    return projection


def declared_live_exporter_output(path: Path, exporter: str) -> bool:
    """Recognize only an explicit current-owner identity-v1 frontmatter."""
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
    exporter: str,
    corpus: Path,
    night: dt.date,
    profiles: tuple[str, ...],
    covered_paths: set[Path],
) -> set[Path]:
    # Every manifest-covered path remains active even if its file is missing;
    # the later file/hash checks then fail closed. Preserved historical files
    # without the current identity-v1 assertion are evidence, not live
    # exporter outputs. A current-owner identity-v1 orphan is still drift.
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

    # Nightly selection remains exactly ``night``.  Coverage is deliberately
    # wider: a run can migrate legacy settled rows from earlier dates, so the
    # success receipt must seal the complete exporter-owned tree rather than
    # attest only the newly selected night.
    for profile in profiles:
        profile_root = corpus / profile
        if profile_root.exists():
            paths.update(
                path.resolve()
                for path in profile_root.rglob("*.md")
                if path.is_file()
                and output_is_covered_through(path, night)
                and declared_live_exporter_output(path, exporter)
            )
    return paths


def output_is_covered_through(path: Path, night: dt.date) -> bool:
    """Include settled outputs through ``night``; expose malformed names as drift."""
    try:
        return dt.date.fromisoformat(path.name[:10]) <= night
    except ValueError:
        # The manifest/tree equality check must see malformed exporter-owned
        # markdown instead of silently excluding it from the receipt.
        return True


def main() -> int:
    args = parse_args()
    night = dt.date.fromisoformat(args.night_id)
    receipt_dir = Path(args.receipt_dir).expanduser().resolve()
    receipt_path = receipt_dir / f"{night.isoformat()}__{args.exporter}__success.json"
    if args.verify:
        print(f"EXPECTED receipt_path={receipt_path}")
    summary_path = Path(args.summary).expanduser().resolve()
    corpus = Path(args.corpus).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser().resolve()
    if not summary_path.is_file() or not manifest_path.is_file() or not corpus.is_dir():
        raise ValueError("summary, manifest, and corpus must exist")
    if args.verify:
        print("PASS inputs_exist")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    expected_owner = EXPORTER_OWNER[args.exporter]
    if (
        not isinstance(summary, dict)
        or summary.get("status") != "success"
        or summary.get("scheduled") is not True
        or summary.get("exporter") != expected_owner
    ):
        raise ValueError("export summary is not a successful scheduled run of this exporter")
    if args.verify:
        print("PASS scheduled_summary")

    expected_profiles = EXPECTED_PROFILES[args.exporter]
    if args.exporter == "hermes":
        profiles = tuple(sorted(str(value) for value in summary.get("profiles") or []))
        if profiles != expected_profiles:
            raise ValueError("Hermes scheduled export must cover exactly profiles alex and seksi")
        selected_dates = [str(value) for value in summary.get("selected_dates") or []]
        if selected_dates != [night.isoformat()]:
            raise ValueError("Hermes scheduled receipt must cover exactly the intended night")
        settled_through: str | None = None
    else:
        profiles = expected_profiles
        settled_through = str(summary.get("settled_through") or "")
        if settled_through != night.isoformat():
            raise ValueError("Claude settled-through date does not match intended night")
        selected_dates = sorted(
            set(str(value) for value in summary.get("selected_settlement_dates") or [])
        )
        if any(dt.date.fromisoformat(value) > night for value in selected_dates):
            raise ValueError("Claude receipt includes an unsettled future date")
        export_dates = [str(value) for value in summary.get("selected_export_dates") or []]
        if any(dt.date.fromisoformat(value) > night for value in export_dates):
            raise ValueError("Claude receipt includes a future export date")

    manifest_entries = load_manifest(manifest_path)
    by_key = {manifest_key(entry): entry for entry in manifest_entries}
    raw_selected_keys = list(summary.get("selected_manifest_keys") or [])
    if any(not isinstance(entry, dict) for entry in raw_selected_keys):
        raise ValueError("selected manifest keys must be objects")
    selected_keys = [manifest_key(entry) for entry in raw_selected_keys]
    if len(selected_keys) != len(set(selected_keys)):
        raise ValueError("selected manifest keys contain duplicates")
    missing = [key for key in selected_keys if key not in by_key]
    if missing:
        raise ValueError(f"selected manifest projection is incomplete ({len(missing)} missing)")
    if any(key[0] not in expected_profiles for key in selected_keys):
        raise ValueError("selected manifest key has an unexpected profile")
    if args.exporter == "hermes" and any(key[2] != night.isoformat() for key in selected_keys):
        raise ValueError("Hermes selected manifest key has the wrong date")
    if args.exporter == "claude" and any(dt.date.fromisoformat(key[2]) > night for key in selected_keys):
        raise ValueError("Claude selected manifest key has a future date")

    selected_outputs = sorted(
        {resolve_output(corpus, value) for value in summary.get("output_paths") or []}
    )
    selected_manifest_outputs = {
        resolve_output(corpus, by_key[key].get("output_path")) for key in selected_keys
    }
    if set(selected_outputs) != selected_manifest_outputs:
        raise ValueError("selected output paths do not match selected manifest keys")
    if args.verify:
        print("PASS exact_selection")

    projection = projection_for(args.exporter, manifest_entries, night, profiles)
    for entry in projection:
        assert_settled_identity_v1(entry, args.exporter)
    projection_payload = "".join(
        canonical_json(entry) + "\n" for entry in projection
    ).encode("utf-8")
    projection_outputs = [resolve_output(corpus, entry.get("output_path")) for entry in projection]
    if len(projection_outputs) != len(set(projection_outputs)):
        raise ValueError("covered manifest projection maps multiple keys to one output")
    covered_paths = set(projection_outputs)
    active_paths = active_tree(args.exporter, corpus, night, profiles, covered_paths)
    if active_paths != covered_paths:
        raise ValueError(
            "active exporter tree does not match covered manifest projection "
            f"(active={len(active_paths)} covered={len(covered_paths)})"
        )
    if args.verify:
        print("PASS manifest_tree_projection")

    tree_projection: list[dict[str, str]] = []
    for path in sorted(covered_paths):
        relative = path.relative_to(corpus)
        if not path.is_file():
            raise ValueError(f"covered output is missing: {relative}")
        output_sha256 = sha256_file(path)
        entry = next(
            item
            for item in projection
            if Path(str(item["output_path"])).expanduser().resolve() == path
        )
        if entry.get("rendered_sha256") != output_sha256:
            raise ValueError(f"manifest/output hash mismatch: {relative}")
        tree_projection.append({"path": str(relative), "sha256": output_sha256})
    tree_payload = "".join(
        canonical_json(entry) + "\n" for entry in tree_projection
    ).encode("utf-8")

    logical_sessions = {(key[0], key[1], key[2]) for key in selected_keys}
    selection_keys = [key_object(key) for key in sorted(selected_keys)]
    selection_paths = [str(path.relative_to(corpus)) for path in selected_outputs]
    created_at = args.now or dt.datetime.now(dt.timezone.utc).isoformat()
    runtime_artifacts = parse_artifacts(args.artifact)
    if args.verify:
        print("PASS runtime_artifacts")
    receipt = {
        "schema": SCHEMA,
        "status": "success",
        "exporter": args.exporter,
        "night_id": night.isoformat(),
        "created_at": created_at,
        # Kept at top level for backwards-compatible receipt consumers; v2
        # validation uses the complete selection block below.
        "selected_dates": selected_dates,
        "selection": {
            "profiles": list(profiles),
            "settled_through": settled_through,
            "dates": selected_dates,
            "manifest_keys": selection_keys,
            "output_paths": selection_paths,
        },
        "selected_counts": {
            "logical_sessions": len(logical_sessions),
            "parts": len(selection_keys),
            "files": len(selection_paths),
        },
        "covered_counts": {
            "manifest_rows": len(projection),
            "files": len(tree_projection),
        },
        "manifest": {
            "path": ".manifest.jsonl",
            "snapshot_sha256": sha256_file(manifest_path),
            "projection_sha256": sha256_bytes(projection_payload),
            "projection_rows": len(projection),
        },
        "tree": {
            "projection_sha256": sha256_bytes(tree_payload),
            "projection_files": len(tree_projection),
        },
        "summary_sha256": sha256_file(summary_path),
        "runtime_artifacts": runtime_artifacts,
    }
    if args.verify:
        print("PASS receipt_would_be_accepted")
        return 0
    atomic_write_secure(receipt_path, json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(str(receipt_path))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        if "--verify" in os.sys.argv:
            print(f"FAIL receipt_validation: {exc}", file=os.sys.stderr)
            raise SystemExit(65)
        raise
