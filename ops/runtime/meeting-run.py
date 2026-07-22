#!/usr/bin/env python3
"""Thin meeting-completion runner — Garry's shape (recipes/meeting-sync.md).

    webhook -> meeting page materialized (status: captured)
    -> this runner wakes `claude -p` to run the meeting-ingestion skill
       with FULL brain access (live skill, live gbrain, live corpus)
    -> verify the page is good (status stamped + frontmatter valid)
    -> nightly launchd run is the backstop for anything the webhook missed.

Replaces the 2026-07-16 sandbox controller (meeting-complete.py: brain
copytree, seatbelt profiles, canary, deny shims, promotion journal, double
hash gates — ~2,300 lines). That layer caused three of the four meeting
outages in its own first week (sandbox broke on a Claude CLI update, then
un-masked a flag bug, then raced its own enrichment at the hash gate).
Trust model here is Garry's: your agent + your git-backed brain. Every
write lands as a commit via the autocommit lane; rollback is `git revert`.
The skill itself carries the quality machinery (attendee resolution, stub
discipline, citations, QA script, Phase 7 retrieval gate, status stamp).

Operator ruling 2026-07-22: "webhook -> materialize page -> run the skill
and check the page is good." Simple ledger for retries; run-lock so the
webhook kickstart and the nightly backstop never overlap.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HOME = Path(os.environ.get("GBRAIN_HOME", os.path.expanduser("~"))).resolve()
BRAIN_DIR = Path(os.environ.get("BRAIN_DIR", str(HOME / "brain"))).resolve()
MEETINGS_DIR = BRAIN_DIR / "meetings"
SKILL_FILE = Path(
    os.environ.get(
        "MEETING_INGESTION_SKILL_FILE",
        "/Users/jarvis/gbrain/skills/meeting-ingestion/SKILL.md",
    )
).resolve()
STATE_DIR = Path(
    os.environ.get("MEETING_COMPLETE_STATE_DIR", str(HOME / ".gbrain/meeting-complete-state"))
).resolve()
LEDGER = STATE_DIR / "retry-ledger.json"
LOCK_FILE = STATE_DIR / "meeting-run.lock"
GBRAIN_BIN = os.environ.get("GBRAIN_BIN", "/Users/jarvis/gbrain/bin/gbrain")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
MAX_ATTEMPTS_PER_DAY = 3


def log(msg: str) -> None:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[meeting-run {ts}] {msg}", flush=True)


def assert_subscription_env() -> None:
    """The agent must run on subscription billing — refuse leaked API creds."""
    leaked = [
        k for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
        if os.environ.get(k)
    ]
    if leaked:
        raise SystemExit(f"refusing to run: API credential env leaked into lane: {leaked}")


def read_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}
    fields: dict[str, str] = {}
    for line in text[4:end].splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if m:
            fields[m.group(1)] = m.group(2).strip().strip("'\"")
    return fields


def load_ledger() -> dict:
    try:
        return json.loads(LEDGER.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_ledger(ledger: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LEDGER.with_suffix(".tmp")
    tmp.write_text(json.dumps(ledger, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(LEDGER)


def select_meetings(only: str | None, limit: int) -> list[Path]:
    today = dt.date.today().isoformat()
    ledger = load_ledger()
    out: list[Path] = []
    for path in sorted(MEETINGS_DIR.glob("*.md")):
        if path.name == "README.md":
            continue
        fm = read_frontmatter(path)
        if fm.get("status") != "captured":
            continue
        slug = f"meetings/{path.stem}"
        if only and slug != only:
            continue
        entry = ledger.get(slug) or {}
        if entry.get("day") == today and entry.get("attempts", 0) >= MAX_ATTEMPTS_PER_DAY:
            log(f"skip {slug}: {entry['attempts']} attempts today (retries resume tomorrow)")
            continue
        out.append(path)
        if len(out) >= limit:
            break
    return out


def bump_ledger(slug: str, ok: bool) -> None:
    today = dt.date.today().isoformat()
    ledger = load_ledger()
    if ok:
        ledger.pop(slug, None)
    else:
        entry = ledger.get(slug) or {}
        if entry.get("day") != today:
            entry = {"day": today, "attempts": 0}
        entry["attempts"] = int(entry.get("attempts", 0)) + 1
        ledger[slug] = entry
    save_ledger(ledger)


def build_prompt(slug: str, path: Path) -> str:
    return (
        f"Run the meeting-ingestion skill for the captured meeting `{slug}` "
        f"(file: {path}).\n\n"
        f"Read {SKILL_FILE} IN FULL first and follow every phase it defines — "
        "analysis above the transcript line, attendee resolution against the "
        "live brain (gbrain search/get), entity stubs per the skill's stub "
        "discipline, typed backlinks and timeline entries in the skill's "
        "format, citations, its QA and retrieval gates, and its completion "
        "stamp. Use the gbrain CLI/native tools for brain lookups and the "
        "skill's prescribed write paths. When the skill says the meeting is "
        "fully ingested, ensure the meeting page frontmatter carries "
        "`status: ingested`. Work on this one meeting only."
    )


def run_agent(slug: str, path: Path, model: str, timeout: int) -> int:
    cmd = [
        CLAUDE_BIN, "-p", build_prompt(slug, path),
        "--model", model,
        "--max-turns", "80",
        "--permission-mode", "acceptEdits",
        "--no-session-persistence",
        "--add-dir", str(BRAIN_DIR),
        "--add-dir", str(SKILL_FILE.parent.parent),
    ]
    try:
        proc = subprocess.run(cmd, timeout=timeout, cwd=str(HOME),
                              capture_output=True, text=True)
    except subprocess.TimeoutExpired:
        log(f"agent timeout after {timeout}s for {slug}")
        return 124
    tail = (proc.stderr or "")[-400:].replace("\n", " ")
    if proc.returncode != 0:
        log(f"agent rc={proc.returncode} for {slug}: {tail}")
    return proc.returncode


def verify_meeting(path: Path) -> tuple[bool, str]:
    """Garry's 'check the page is good': stamped + valid frontmatter."""
    fm = read_frontmatter(path)
    if fm.get("status") != "ingested":
        return False, f"status is {fm.get('status')!r}, expected 'ingested'"
    v = subprocess.run(
        [GBRAIN_BIN, "frontmatter", "validate", str(path)],
        capture_output=True, text=True,
        env={**os.environ, "GBRAIN_DISABLE_DIRECT_POOL": "1"},
    )
    if v.returncode != 0:
        return False, f"frontmatter validate failed: {(v.stdout or v.stderr)[-200:]}"
    return True, "ok"


def main() -> int:
    ap = argparse.ArgumentParser(description="Thin GBrain meeting-completion runner")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--only", help="single meeting slug (meetings/...)")
    ap.add_argument("--model", default=os.environ.get("MEETING_AGENT_MODEL", "claude-opus-4-8"))
    ap.add_argument("--timeout", type=int, default=1500)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    assert_subscription_env()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another meeting run holds the lock; exiting clean")
        return 0

    meetings = select_meetings(args.only, args.limit)
    if not meetings:
        log("no captured meetings pending")
        return 0
    log(f"{len(meetings)} meeting(s) pending: {', '.join(p.stem for p in meetings)}")
    if args.dry_run:
        return 0

    results = []
    for path in meetings:
        slug = f"meetings/{path.stem}"
        log(f"ingesting {slug} (model={args.model})")
        rc = run_agent(slug, path, args.model, args.timeout)
        ok, why = verify_meeting(path)
        if rc != 0 and ok:
            log(f"note: agent rc={rc} but page verifies — accepting")
        bump_ledger(slug, ok)
        log(f"{slug}: {'INGESTED' if ok else 'RETRY-LATER (' + why + ')'}")
        results.append({"meeting": slug, "ok": ok, "why": why, "agent_rc": rc})

    receipt = {
        "schema": "gbrain-meeting-run/v1",
        "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "results": results,
        "skill_file": str(SKILL_FILE),
    }
    rid = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (STATE_DIR / f"run-{rid}.json").write_text(json.dumps(receipt, indent=1) + "\n", encoding="utf-8")
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
