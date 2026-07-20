#!/bin/bash
set -uo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
python_bin="${GBRAIN_EXPORT_PYTHON:-/usr/bin/python3}"
exporter="${GBRAIN_HERMES_EXPORTER:-$script_dir/export-gbrain-session-corpus.py}"
receipt_helper="${GBRAIN_EXPORT_RECEIPT_HELPER:-$script_dir/export-receipt.py}"
lock_helper="${GBRAIN_RUN_LOCK_HELPER:-$script_dir/run-lock.py}"
corpus_dir="${GBRAIN_SESSION_CORPUS_DIR:-/Users/jarvis/brain-intake/sessions}"
receipt_dir="${GBRAIN_EXPORT_RECEIPT_DIR:-/Users/jarvis/.gbrain/export-receipts}"
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
  expected_receipt="$receipt_dir/${night_id}__hermes__success.json"
  claude_receipt="$receipt_dir/${night_id}__claude__success.json"
  printf 'EXPECTED receipt_path=%s\n' "$expected_receipt"
  printf 'EXPECTED prerequisite_path=%s\n' "$claude_receipt"
  if GBRAIN_RECEIPT_NOW="${GBRAIN_EXPORT_NOW:-}" "$python_bin" - "$claude_receipt" "$night_id" <<'PY'
import datetime as dt
import json
import os
import stat
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

path = Path(sys.argv[1])
night_id = sys.argv[2]
if not path.is_file() or path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o600:
    raise SystemExit(1)
value = json.loads(path.read_text(encoding="utf-8"))
if (
    value.get("schema") != "gbrain-export-success-receipt/v2"
    or value.get("status") != "success"
    or value.get("exporter") != "claude"
    or value.get("night_id") != night_id
):
    raise SystemExit(1)
tz = ZoneInfo("Asia/Bangkok")
raw_now = os.environ.get("GBRAIN_RECEIPT_NOW")
now = dt.datetime.fromisoformat(raw_now.replace("Z", "+00:00")) if raw_now else dt.datetime.now(tz)
if now.tzinfo is None:
    now = now.replace(tzinfo=tz)
now = now.astimezone(tz)
created = dt.datetime.fromisoformat(str(value.get("created_at") or "").replace("Z", "+00:00"))
if created.tzinfo is None:
    raise SystemExit(1)
age = now - created.astimezone(tz)
if created.astimezone(tz).date() != now.date() or age < -dt.timedelta(minutes=5) or age > dt.timedelta(minutes=180):
    raise SystemExit(1)
PY
  then
    printf 'PASS claude_prerequisite\n'
  else
    printf 'FAIL claude_prerequisite: Hermes exits before export when this receipt is absent or invalid\n'
    exit 65
  fi
  summary_file="$("$python_bin" - "$receipt_dir" "$night_id" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
candidates = [
    path for path in root.glob(f"{sys.argv[2]}__hermes__summary.*.json")
    if path.is_file() and not path.is_symlink()
]
if not candidates:
    raise SystemExit(1)
print(max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name)))
PY
)"
  if [[ "$?" -ne 0 ]]; then
    printf 'FAIL summary_exists: no %s__hermes__summary.*.json\n' "$night_id"
    exit 65
  fi
  printf 'PASS summary_exists path=%s\n' "$summary_file"
  verify_args=(
    "$python_bin" "$receipt_helper"
    --verify
    --exporter hermes
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
if [[ "${GBRAIN_HERMES_REQUIRE_CLAUDE_RECEIPT:-1}" = "1" ]]; then
  claude_receipt="$receipt_dir/${night_id}__claude__success.json"
  claude_wait_seconds="${GBRAIN_HERMES_CLAUDE_WAIT_SECONDS:-7200}"
  claude_poll_seconds="${GBRAIN_HERMES_CLAUDE_POLL_SECONDS:-30}"
  claude_max_age_minutes="${GBRAIN_HERMES_CLAUDE_MAX_AGE_MINUTES:-180}"
  claude_deadline=$(( $(date +%s) + claude_wait_seconds ))
  while ! GBRAIN_RECEIPT_NOW="${GBRAIN_EXPORT_NOW:-}" "$python_bin" - "$claude_receipt" "$night_id" "$claude_max_age_minutes" <<'PY'
import datetime as dt
import json
import os
import stat
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

path = Path(sys.argv[1])
night_id = sys.argv[2]
max_age = dt.timedelta(minutes=int(sys.argv[3]))
if not path.is_file() or path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o600:
    raise SystemExit(1)
value = json.loads(path.read_text(encoding="utf-8"))
if (
    value.get("schema") != "gbrain-export-success-receipt/v2"
    or value.get("status") != "success"
    or value.get("exporter") != "claude"
    or value.get("night_id") != night_id
):
    raise SystemExit(1)
tz = ZoneInfo("Asia/Bangkok")
raw_now = os.environ.get("GBRAIN_RECEIPT_NOW")
now = dt.datetime.fromisoformat(raw_now.replace("Z", "+00:00")) if raw_now else dt.datetime.now(tz)
if now.tzinfo is None:
    now = now.replace(tzinfo=tz)
now = now.astimezone(tz)
created = dt.datetime.fromisoformat(str(value.get("created_at") or "").replace("Z", "+00:00"))
if created.tzinfo is None:
    raise SystemExit(1)
created = created.astimezone(tz)
age = now - created
if created.date() != now.date() or age < -dt.timedelta(minutes=5) or age > max_age:
    raise SystemExit(1)
PY
  do
    if [[ "$(date +%s)" -ge "$claude_deadline" ]]; then
      printf '[session-export %s] failed exit=75 reason=claude-prerequisite-wait-exhausted night=%s\n' "$run_id" "$night_id"
      exit 75
    fi
    sleep "$claude_poll_seconds"
  done
fi
lock_dir="${GBRAIN_CORPUS_WRITER_LOCK_DIR:-${GBRAIN_EXPORT_LOCK_DIR:-$HOME/.gbrain/locks/corpus-writer.lock}}"
lock_wait_seconds="${GBRAIN_EXPORT_LOCK_WAIT_SECONDS:-7200}"
lock_token="$receipt_dir/.session-export.lock-token.$$"
"$python_bin" "$lock_helper" acquire --lock-dir "$lock_dir" --token-file "$lock_token" --owner hermes-session-export --owner-pid $$ --wait-seconds "$lock_wait_seconds"
if [[ "$?" -ne 0 ]]; then
  printf '[session-export %s] failed exit=75 reason=export-lock-busy\n' "$run_id"
  exit 75
fi
trap '"$python_bin" "$lock_helper" release --lock-dir "$lock_dir" --token-file "$lock_token" --owner hermes-session-export --owner-pid $$ >/dev/null 2>&1 || true' EXIT
summary_file="$receipt_dir/${night_id}__hermes__summary.${run_id}.json"
success_receipt="$receipt_dir/${night_id}__hermes__success.json"
if [[ -f "$success_receipt" ]]; then
  invalid_dir="$receipt_dir/invalidated"
  mkdir -p "$invalid_dir"
  chmod 700 "$invalid_dir"
  mv "$success_receipt" "$invalid_dir/${night_id}__hermes__success.${run_id}.json"
fi

printf '[session-export %s] start night=%s profiles=alex,seksi closed-day-only\n' "$run_id" "$night_id"

export_args=(
  "$python_bin" "$exporter"
  --corpus-dir "$corpus_dir"
  --profile alex
  --profile seksi
  --scheduled
  --date "$night_id"
  --summary-file "$summary_file"
)
if [[ -n "${GBRAIN_EXPORT_NOW:-}" ]]; then
  export_args+=(--now "$GBRAIN_EXPORT_NOW")
fi
"${export_args[@]}"
rc=$?
if [[ "$rc" -ne 0 ]]; then
  printf '[session-export %s] failed exit=%d receipt=absent\n' "$run_id" "$rc"
  exit "$rc"
fi

receipt_args=(
  "$python_bin" "$receipt_helper"
  --exporter hermes
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
printf '[session-export %s] done exit=%d night=%s profiles=alex,seksi\n' "$run_id" "$rc" "$night_id"
exit "$rc"
