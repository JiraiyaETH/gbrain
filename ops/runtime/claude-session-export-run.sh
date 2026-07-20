#!/bin/bash
set -uo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
python_bin="${GBRAIN_EXPORT_PYTHON:-/usr/bin/python3}"
exporter="${GBRAIN_CLAUDE_EXPORTER:-$script_dir/export-claude-session-corpus.py}"
receipt_helper="${GBRAIN_EXPORT_RECEIPT_HELPER:-$script_dir/export-receipt.py}"
lock_helper="${GBRAIN_RUN_LOCK_HELPER:-$script_dir/run-lock.py}"
corpus_dir="${GBRAIN_SESSION_CORPUS_DIR:-/Users/jarvis/brain-intake/sessions}"
receipt_dir="${GBRAIN_EXPORT_RECEIPT_DIR:-/Users/jarvis/.gbrain/export-receipts}"
quiet_minutes="${GBRAIN_CLAUDE_SETTLE_QUIET_MINUTES:-180}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"

night_id="$(GBRAIN_EXPORT_NOW="${GBRAIN_EXPORT_NOW:-}" "$python_bin" - <<'PY'
import datetime as dt
import os
from zoneinfo import ZoneInfo

tz = ZoneInfo("Asia/Bangkok")
raw = os.environ.get("GBRAIN_EXPORT_NOW")
if raw:
    now = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if now.tzinfo is None:
        now = now.replace(tzinfo=tz)
    now = now.astimezone(tz)
else:
    now = dt.datetime.now(tz)
print((now.date() - dt.timedelta(days=1)).isoformat())
PY
)" || exit $?

if [[ "${1:-}" = "--verify" ]]; then
  expected_receipt="$receipt_dir/${night_id}__claude__success.json"
  printf 'EXPECTED receipt_path=%s\n' "$expected_receipt"
  summary_file="$("$python_bin" - "$receipt_dir" "$night_id" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
candidates = [
    path for path in root.glob(f"{sys.argv[2]}__claude__summary.*.json")
    if path.is_file() and not path.is_symlink()
]
if not candidates:
    raise SystemExit(1)
print(max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name)))
PY
)"
  if [[ "$?" -ne 0 ]]; then
    printf 'FAIL summary_exists: no %s__claude__summary.*.json\n' "$night_id"
    exit 65
  fi
  printf 'PASS summary_exists path=%s\n' "$summary_file"
  verify_args=(
    "$python_bin" "$receipt_helper"
    --verify
    --exporter claude
    --night-id "$night_id"
    --summary "$summary_file"
    --corpus "$corpus_dir"
    --manifest "$corpus_dir/.manifest.jsonl"
    --receipt-dir "$receipt_dir"
    --artifact "python=$python_bin"
    --artifact "exporter=$exporter"
    --artifact "wrapper=$0"
    --artifact "receipt_helper=$receipt_helper"
    --artifact "lock_helper=$lock_helper"
  )
  if [[ -n "${GBRAIN_EXPORT_NOW:-}" ]]; then
    verify_args+=(--now "$GBRAIN_EXPORT_NOW")
  fi
  "${verify_args[@]}"
  exit $?
fi

mkdir -p "$receipt_dir"
chmod 700 "$receipt_dir"
lock_dir="${GBRAIN_CORPUS_WRITER_LOCK_DIR:-${GBRAIN_EXPORT_LOCK_DIR:-$HOME/.gbrain/locks/corpus-writer.lock}}"
lock_wait_seconds="${GBRAIN_EXPORT_LOCK_WAIT_SECONDS:-7200}"
lock_token="$receipt_dir/.session-export.lock-token.$$"
"$python_bin" "$lock_helper" acquire --lock-dir "$lock_dir" --token-file "$lock_token" --owner claude-session-export --owner-pid $$ --wait-seconds "$lock_wait_seconds"
if [[ "$?" -ne 0 ]]; then
  printf '[claude-session-export %s] failed exit=75 reason=export-lock-busy\n' "$run_id"
  exit 75
fi
trap '"$python_bin" "$lock_helper" release --lock-dir "$lock_dir" --token-file "$lock_token" --owner claude-session-export --owner-pid $$ >/dev/null 2>&1 || true' EXIT
summary_file="$receipt_dir/${night_id}__claude__summary.${run_id}.json"
success_receipt="$receipt_dir/${night_id}__claude__success.json"
if [[ -f "$success_receipt" ]]; then
  invalid_dir="$receipt_dir/invalidated"
  mkdir -p "$invalid_dir"
  chmod 700 "$invalid_dir"
  mv "$success_receipt" "$invalid_dir/${night_id}__claude__success.${run_id}.json"
fi

printf '[claude-session-export %s] start night=%s settled=closed-day quiet_minutes=%s\n' \
  "$run_id" "$night_id" "$quiet_minutes"

export_args=(
  "$python_bin" "$exporter"
  --corpus-dir "$corpus_dir"
  --since 2026-07-01
  --scheduled
  --settled-through "$night_id"
  --quiet-minutes "$quiet_minutes"
  --summary-file "$summary_file"
)
if [[ -n "${GBRAIN_EXPORT_NOW:-}" ]]; then
  export_args+=(--now "$GBRAIN_EXPORT_NOW")
fi
"${export_args[@]}"
rc=$?
if [[ "$rc" -ne 0 ]]; then
  printf '[claude-session-export %s] failed exit=%d receipt=absent\n' "$run_id" "$rc"
  exit "$rc"
fi

receipt_args=(
  "$python_bin" "$receipt_helper"
  --exporter claude
  --night-id "$night_id"
  --summary "$summary_file"
  --corpus "$corpus_dir"
  --manifest "$corpus_dir/.manifest.jsonl"
  --receipt-dir "$receipt_dir"
  --artifact "python=$python_bin"
  --artifact "exporter=$exporter"
  --artifact "wrapper=$0"
  --artifact "receipt_helper=$receipt_helper"
  --artifact "lock_helper=$lock_helper"
)
if [[ -n "${GBRAIN_EXPORT_NOW:-}" ]]; then
  receipt_args+=(--now "$GBRAIN_EXPORT_NOW")
fi
"${receipt_args[@]}"
rc=$?
printf '[claude-session-export %s] done exit=%d night=%s\n' "$run_id" "$rc" "$night_id"
exit "$rc"
