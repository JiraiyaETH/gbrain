#!/usr/bin/env python3
"""Write a secure atomic terminal receipt for the enrich-thin runtime lane."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


SCHEMA = "gbrain-enrich-thin-result/v2"
ARTIFACT_LABELS = {"wrapper", "gbrain", "skill", "db_pin", "postcondition", "receipt_writer"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt-dir", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--status", choices=("success", "failure", "no_op"), required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--primary-exit", type=int, required=True)
    parser.add_argument("--started-at", required=True)
    parser.add_argument("--finished-at", required=True)
    parser.add_argument("--candidate-count", type=int, required=True)
    parser.add_argument("--result", action="append", default=[])
    parser.add_argument("--artifact", action="append", default=[])
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_timestamp(value: str, label: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must be timezone-aware")
    return parsed


def parse_results(values: list[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in values:
        if "=" not in value:
            raise ValueError("--result must be slug=exit_code|reason|audit_path")
        slug, result_payload = value.split("=", 1)
        fields = result_payload.split("|", 2)
        raw_rc = fields[0]
        reason = fields[1] if len(fields) > 1 and fields[1] else "child_exit"
        audit_value = fields[2] if len(fields) > 2 else ""
        if not slug or slug in seen or any(token in slug for token in ("\n", "\r", "=", "|")):
            raise ValueError("result slug is empty, duplicated, or malformed")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", reason):
            raise ValueError("result reason is malformed")
        rc = int(raw_rc)
        if rc < 0 or rc > 255:
            raise ValueError("result exit code is outside 0..255")
        audit: dict[str, Any] | None = None
        if audit_value:
            audit_path = Path(audit_value).expanduser().resolve()
            if not audit_path.is_file():
                raise ValueError("result audit file is missing")
            audit = {"name": audit_path.name, "sha256": sha256_file(audit_path)}
        if rc == 0 and (reason != "verified" or audit is None):
            raise ValueError("successful candidate requires a verified audit")
        if rc != 0 and reason == "verified":
            raise ValueError("failed candidate cannot be verified")
        seen.add(slug)
        results.append(
            {
                "slug": slug,
                "exit_code": rc,
                "status": "ok" if rc == 0 else "failure",
                "reason": reason,
                "evidence": audit,
            }
        )
    return results


def parse_artifacts(values: list[str], *, require_all: bool) -> dict[str, dict[str, Any]]:
    raw: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise ValueError("--artifact must be label=/absolute/path")
        label, path_value = value.split("=", 1)
        if not label or label in raw:
            raise ValueError(f"invalid or duplicate artifact label: {label}")
        raw[label] = Path(path_value).expanduser().resolve()
    if set(raw) != ARTIFACT_LABELS:
        raise ValueError("artifact labels must be exactly: " + ",".join(sorted(ARTIFACT_LABELS)))
    output: dict[str, dict[str, Any]] = {}
    for label, path in sorted(raw.items()):
        exists = path.is_file()
        if require_all and not exists:
            raise ValueError(f"successful run artifact is missing: {label}")
        output[label] = {
            "exists": exists,
            "name": path.name,
            "sha256": sha256_file(path) if exists else None,
        }
    return output


def atomic_write(path: Path, payload: dict[str, Any]) -> None:
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


def main() -> int:
    args = parse_args()
    started = parse_timestamp(args.started_at, "started_at")
    finished = parse_timestamp(args.finished_at, "finished_at")
    if finished < started:
        raise ValueError("finished_at precedes started_at")
    if args.candidate_count < 0:
        raise ValueError("candidate count must be non-negative")
    if args.status in {"success", "no_op"} and args.primary_exit != 0:
        raise ValueError("non-failure receipt requires primary exit 0")
    if args.status == "failure" and args.primary_exit == 0:
        raise ValueError("failure receipt requires a non-zero primary exit")
    results = parse_results(args.result)
    if len(results) != args.candidate_count:
        raise ValueError("candidate count does not match result rows")
    failed = sum(result["exit_code"] != 0 for result in results)
    if args.status == "success" and failed:
        raise ValueError("successful receipt contains failed candidates")
    if args.reason == "candidate_failure" and not failed:
        raise ValueError("candidate_failure receipt has no failed candidate")

    safe_run_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", args.run_id).strip("-")
    if not safe_run_id:
        raise ValueError("run id is empty after normalization")
    payload = {
        "schema": SCHEMA,
        "status": args.status,
        "reason": args.reason,
        "run_id": args.run_id,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "primary_exit_code": args.primary_exit,
        "candidate_counts": {
            "selected": args.candidate_count,
            "succeeded": args.candidate_count - failed,
            "failed": failed,
        },
        "results": results,
        "runtime_artifacts": parse_artifacts(args.artifact, require_all=args.status == "success"),
    }
    receipt_dir = Path(args.receipt_dir).expanduser().resolve()
    receipt_path = receipt_dir / f"enrich-thin-{safe_run_id}.json"
    atomic_write(receipt_path, payload)
    print(receipt_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"enrich-thin receipt failed: {exc}", file=os.sys.stderr)
        raise SystemExit(66)
