#!/usr/bin/env python3
"""Atomically write the terminal receipt for a scheduled Dream wrapper run."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any


SCHEMA = "gbrain-scheduled-dream-result/v1"
GATE_SCHEMA = "gbrain-scheduled-dream-gate/v1"
REQUIRED_ARTIFACTS = {
    "python",
    "gbrain",
    "wrapper",
    "verifier",
    "receipt_writer",
    "filing_rules",
    "lock_helper",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--night-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--status", choices=("success", "failure"), required=True)
    parser.add_argument("--phase", choices=("prerequisite-gate", "dream"), required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--gate-exit-code", type=int, required=True)
    parser.add_argument("--dream-exit-code", type=int, default=None)
    parser.add_argument("--gate-receipt", default=None)
    parser.add_argument("--prerequisite", action="append", default=[])
    parser.add_argument("--artifact", action="append", default=[])
    parser.add_argument("--now", default=None)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_named_paths(values: list[str], require_files: bool) -> dict[str, Path | None]:
    output: dict[str, Path | None] = {}
    for value in values:
        if "=" not in value:
            raise ValueError("named path must be label=/absolute/path")
        label, raw = value.split("=", 1)
        if not label or label in output:
            raise ValueError(f"invalid or duplicate named path label: {label}")
        unresolved = Path(raw).expanduser()
        if require_files and unresolved.is_symlink():
            raise ValueError(f"required artifact is a symlink: {label}")
        path = unresolved.resolve()
        if require_files and not path.is_file():
            raise ValueError(f"required artifact is missing: {label}")
        output[label] = path if path.is_file() else None
    return output


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


def main() -> int:
    args = parse_args()
    night = dt.date.fromisoformat(args.night_id)
    if args.status == "success" and (
        args.phase != "dream"
        or args.exit_code != 0
        or args.gate_exit_code != 0
        or args.dream_exit_code != 0
    ):
        raise ValueError("success receipt requires successful gate and Dream exits")
    if args.phase == "prerequisite-gate" and args.dream_exit_code is not None:
        raise ValueError("Dream exit must be absent when the prerequisite gate did not pass")

    prerequisite_paths = parse_named_paths(args.prerequisite, require_files=False)
    if set(prerequisite_paths) != {"claude", "hermes"}:
        raise ValueError("prerequisites must name exactly claude and hermes")
    prerequisites: dict[str, dict[str, Any]] = {}
    for label, path in sorted(prerequisite_paths.items()):
        prerequisites[label] = {
            "exists": path is not None,
            "path": path.name if path is not None else None,
            "sha256": sha256_file(path) if path is not None else None,
        }

    artifact_paths = parse_named_paths(args.artifact, require_files=True)
    if set(artifact_paths) != REQUIRED_ARTIFACTS:
        raise ValueError("runtime artifacts must name exactly: " + ",".join(sorted(REQUIRED_ARTIFACTS)))
    artifacts: dict[str, str] = {}
    for label, path in sorted(artifact_paths.items()):
        assert path is not None
        if stat.S_IMODE(path.stat().st_mode) & 0o022:
            raise ValueError(f"runtime artifact is group/world writable: {label}")
        artifacts[label] = sha256_file(path)

    gate: dict[str, Any] | None = None
    if args.gate_receipt:
        unresolved_gate_path = Path(args.gate_receipt).expanduser()
        if unresolved_gate_path.is_symlink():
            raise ValueError("gate receipt must not be a symlink")
        gate_path = unresolved_gate_path.resolve()
        if not gate_path.is_file():
            raise ValueError("gate receipt is missing or is a symlink")
        if stat.S_IMODE(gate_path.stat().st_mode) != 0o600:
            raise ValueError("gate receipt mode must be 0600")
        gate_value = json.loads(gate_path.read_text(encoding="utf-8"))
        if (
            not isinstance(gate_value, dict)
            or gate_value.get("schema") != GATE_SCHEMA
            or gate_value.get("status") != "success"
            or gate_value.get("night_id") != night.isoformat()
        ):
            raise ValueError("gate receipt is invalid for this intended night")
        gate_prerequisites = gate_value.get("prerequisites")
        if not isinstance(gate_prerequisites, dict):
            raise ValueError("gate receipt prerequisite seals are missing")
        for label, current in prerequisites.items():
            sealed = gate_prerequisites.get(label)
            if (
                not current["exists"]
                or not isinstance(sealed, dict)
                or sealed.get("sha256") != current["sha256"]
            ):
                raise ValueError(f"{label} prerequisite changed after the gate")
        if gate_value.get("runtime_artifacts") != artifacts:
            raise ValueError("Dream runtime artifacts changed after the gate")
        gate = {"path": gate_path.name, "sha256": sha256_file(gate_path)}
    elif args.status == "success" or args.phase == "dream":
        raise ValueError("a successful gate receipt is required once Dream is invoked")

    created_at = args.now or dt.datetime.now(dt.timezone.utc).isoformat()
    payload = {
        "schema": SCHEMA,
        "status": args.status,
        "phase": args.phase,
        "night_id": night.isoformat(),
        "run_id": args.run_id,
        "created_at": created_at,
        "primary_exit_code": args.exit_code,
        "gate_exit_code": args.gate_exit_code,
        "dream_exit_code": args.dream_exit_code,
        "prerequisites": prerequisites,
        "gate_receipt": gate,
        "runtime_artifacts": artifacts,
        "poststeps": [],
    }
    atomic_write_secure(Path(args.output).expanduser().resolve(), payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"scheduled Dream receipt write failed: {exc}", file=os.sys.stderr)
        raise SystemExit(66)
