#!/bin/bash
# Scheduled-only Dream entrypoint. Manual `gbrain dream` remains intentionally ungated.
set -uo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
runtime_dir="${GBRAIN_DREAM_RUNTIME_DIR:-$script_dir}"
python_bin="${GBRAIN_EXPORT_PYTHON:-/usr/bin/python3}"
gbrain_bin="${GBRAIN_DREAM_BINARY:-$runtime_dir/gbrain}"
verifier="${GBRAIN_DREAM_GATE_VERIFIER:-$runtime_dir/verify-export-receipts.py}"
receipt_writer="${GBRAIN_DREAM_RECEIPT_WRITER:-$runtime_dir/write-scheduled-dream-receipt.py}"
lock_helper="${GBRAIN_RUN_LOCK_HELPER:-$runtime_dir/run-lock.py}"
filing_rules="${GBRAIN_DREAM_FILING_RULES:-$runtime_dir/skills/_brain-filing-rules.json}"
corpus_dir="${GBRAIN_SESSION_CORPUS_DIR:-/Users/jarvis/brain-intake/sessions}"
manifest="${GBRAIN_SESSION_MANIFEST:-$corpus_dir/.manifest.jsonl}"
receipt_dir="${GBRAIN_EXPORT_RECEIPT_DIR:-/Users/jarvis/.gbrain/export-receipts}"
max_age_minutes="${GBRAIN_DREAM_EXPORT_RECEIPT_MAX_AGE_MINUTES:-180}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"

if [[ "${GBRAIN_DREAM_SKIP_SHELL_ENV:-0}" != "1" ]]; then
  [[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
  [[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"
  [[ -f "$HOME/.profile" ]] && source "$HOME/.profile"
fi
export PATH="$runtime_dir:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export GBRAIN_DREAM_STRICT=1
# Preserve the existing scheduled Dream ranking policy inside the sealed wrapper.
export GBRAIN_RECENCY_DECAY="personal/:365:0.3,personal/taste/:0:0,contracts/:365:0.2,projects/:120:0.6,ideas/:365:0.2,research/:90:0.8,notes/:180:0.3,sources/:180:0.4,reports/:30:1.2,workout/:21:1.2,food/:21:1.2,conversations/:60:0.5,dream-cycle-summaries/:21:1.2,inbox/:14:1.0"
export GBRAIN_SOURCE_BOOST="personal/:1.3,personal/taste/:1.4,contracts/:1.2,projects/:1.2,ideas/:1.1,research/:1.1,sources/:0.9,reports/:0.9,workout/:0.9,food/:0.9,conversations/:0.8,dream-cycle-summaries/:0.7,inbox/:0.7"

night_id="$(GBRAIN_DREAM_NOW="${GBRAIN_DREAM_NOW:-}" "$python_bin" - <<'PY'
import datetime as dt
import os
from zoneinfo import ZoneInfo

tz = ZoneInfo("Asia/Bangkok")
raw = os.environ.get("GBRAIN_DREAM_NOW")
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

mkdir -p "$receipt_dir"
chmod 700 "$receipt_dir"
gate_receipt="$receipt_dir/${night_id}__scheduled-dream-gate__${run_id}.json"
result_receipt="$receipt_dir/${night_id}__scheduled-dream__${run_id}.json"
claude_receipt="$receipt_dir/${night_id}__claude__success.json"
hermes_receipt="$receipt_dir/${night_id}__hermes__success.json"

receipt_common=(
  "$python_bin" "$receipt_writer"
  --output "$result_receipt"
  --night-id "$night_id"
  --run-id "$run_id"
  --prerequisite "claude=$claude_receipt"
  --prerequisite "hermes=$hermes_receipt"
  --artifact "python=$python_bin"
  --artifact "gbrain=$gbrain_bin"
  --artifact "wrapper=$0"
  --artifact "verifier=$verifier"
  --artifact "receipt_writer=$receipt_writer"
  --artifact "filing_rules=$filing_rules"
  --artifact "lock_helper=$lock_helper"
)
if [[ -n "${GBRAIN_DREAM_NOW:-}" ]]; then
  receipt_common+=(--now "$GBRAIN_DREAM_NOW")
fi

write_failure_receipt() {
  local phase="$1"
  local primary_rc="$2"
  local gate_rc="$3"
  local dream_rc="${4:-}"
  local args=("${receipt_common[@]}" --status failure --phase "$phase" --exit-code "$primary_rc" --gate-exit-code "$gate_rc")
  if [[ -n "$dream_rc" ]]; then
    args+=(--dream-exit-code "$dream_rc" --gate-receipt "$gate_receipt")
  fi
  "${args[@]}"
}

lock_dir="${GBRAIN_DREAM_LOCK_DIR:-$receipt_dir/.scheduled-dream.lock}"
lock_token="$receipt_dir/.scheduled-dream.lock-token.$$"
dream_lock_wait="${GBRAIN_DREAM_SINGLE_FLIGHT_WAIT_SECONDS:-300}"
"$python_bin" "$lock_helper" acquire --lock-dir "$lock_dir" --token-file "$lock_token" --owner scheduled-dream --owner-pid $$ --wait-seconds "$dream_lock_wait"
if [[ "$?" -ne 0 ]]; then
  printf '[dream-daily %s] failed exit=75 phase=lock night=%s\n' "$run_id" "$night_id"
  write_failure_receipt prerequisite-gate 75 75 || true
  exit 75
fi
export_lock_dir="${GBRAIN_CORPUS_WRITER_LOCK_DIR:-${GBRAIN_EXPORT_LOCK_DIR:-$HOME/.gbrain/locks/corpus-writer.lock}}"
export_lock_token="$receipt_dir/.session-export.lock-token.$$"
export_lock_held=0
cleanup_locks() {
  if [[ "$export_lock_held" -eq 1 ]]; then
    "$python_bin" "$lock_helper" release --lock-dir "$export_lock_dir" --token-file "$export_lock_token" --owner scheduled-dream-export-gate --owner-pid $$ >/dev/null 2>&1 || true
    export_lock_held=0
  fi
  "$python_bin" "$lock_helper" release --lock-dir "$lock_dir" --token-file "$lock_token" --owner scheduled-dream --owner-pid $$ >/dev/null 2>&1 || true
}
trap cleanup_locks EXIT

if [[ "${GBRAIN_DREAM_SKIP_DB_PIN:-0}" != "1" && -f "$HOME/.gbrain/config.json" ]]; then
  pooler_host="aws-1-ap-southeast-1.pooler.supabase.com"
  pooler_ip="$(dig +short A "$pooler_host" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
  [[ -z "$pooler_ip" ]] && pooler_ip="$(dig +short A "$pooler_host" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
  if [[ -n "$pooler_ip" ]]; then
    pinned_url="$(GBRAIN_PIN_HOST="$pooler_host" GBRAIN_PIN_IP="$pooler_ip" "$python_bin" - <<'PY'
import json
import os
from pathlib import Path

config = json.loads((Path.home() / ".gbrain/config.json").read_text(encoding="utf-8"))
url = str(config.get("database_url") or "")
print(url.replace(os.environ["GBRAIN_PIN_HOST"], os.environ["GBRAIN_PIN_IP"]))
PY
)"
    if [[ -n "$pinned_url" ]]; then
      session_url="${pinned_url/:6543\//:5432/}"
      export GBRAIN_DATABASE_URL="$session_url"
      export GBRAIN_DIRECT_DATABASE_URL="$session_url"
      export GBRAIN_PREPARE="${GBRAIN_PREPARE:-false}"
    fi
  fi
  unset pooler_host pooler_ip pinned_url session_url
fi

printf '[dream-daily %s] gate start night=%s\n' "$run_id" "$night_id"
gate_args=(
  "$python_bin" "$verifier"
  --receipt-dir "$receipt_dir"
  --corpus "$corpus_dir"
  --manifest "$manifest"
  --runtime-dir "$runtime_dir"
  --python "$python_bin"
  --gbrain "$gbrain_bin"
  --wrapper "$0"
  --receipt-writer "$receipt_writer"
  --filing-rules "$filing_rules"
  --output "$gate_receipt"
  --max-age-minutes "$max_age_minutes"
)
if [[ -n "${GBRAIN_DREAM_NOW:-}" ]]; then
  gate_args+=(--now "$GBRAIN_DREAM_NOW")
fi
prereq_wait_seconds="${GBRAIN_DREAM_PREREQ_WAIT_SECONDS:-7200}"
prereq_poll_seconds="${GBRAIN_DREAM_PREREQ_POLL_SECONDS:-30}"
prereq_lock_slice="${GBRAIN_DREAM_PREREQ_LOCK_SLICE_SECONDS:-60}"
prereq_deadline=$(( $(date +%s) + prereq_wait_seconds ))
gate_rc=75
while true; do
  "$python_bin" "$lock_helper" acquire --lock-dir "$export_lock_dir" --token-file "$export_lock_token" --owner scheduled-dream-export-gate --owner-pid $$ --wait-seconds "$prereq_lock_slice"
  lock_rc=$?
  if [[ "$lock_rc" -eq 0 ]]; then
    export_lock_held=1
    "${gate_args[@]}"
    gate_rc=$?
    if [[ "$gate_rc" -eq 0 ]]; then
      break
    fi
    "$python_bin" "$lock_helper" release --lock-dir "$export_lock_dir" --token-file "$export_lock_token" --owner scheduled-dream-export-gate --owner-pid $$ >/dev/null 2>&1 || true
    export_lock_held=0
  else
    gate_rc="$lock_rc"
  fi
  if [[ "$(date +%s)" -ge "$prereq_deadline" ]]; then
    printf '[dream-daily %s] failed exit=%d phase=prerequisite-gate night=%s reason=prerequisite-wait-exhausted\n' "$run_id" "$gate_rc" "$night_id"
    write_failure_receipt prerequisite-gate "$gate_rc" "$gate_rc" || true
    exit "$gate_rc"
  fi
  sleep "$prereq_poll_seconds"
done

printf '[dream-daily %s] dream start strict=1 night=%s\n' "$run_id" "$night_id"
if ! cd "$runtime_dir"; then
  dream_rc=74
  printf '[dream-daily %s] failed exit=%d phase=dream-runtime-cwd night=%s\n' "$run_id" "$dream_rc" "$night_id"
  write_failure_receipt dream "$dream_rc" 0 "$dream_rc" || true
  exit "$dream_rc"
fi
"$gbrain_bin" dream --source default --dir /Users/jarvis/brain --night-id "$night_id"
dream_rc=$?
if [[ "$dream_rc" -ne 0 ]]; then
  printf '[dream-daily %s] failed exit=%d phase=dream night=%s\n' "$run_id" "$dream_rc" "$night_id"
  # Receipt failures must never replace the primary Dream failure code.
  write_failure_receipt dream "$dream_rc" 0 "$dream_rc" || true
  exit "$dream_rc"
fi

success_args=(
  "${receipt_common[@]}"
  --status success
  --phase dream
  --exit-code 0
  --gate-exit-code 0
  --dream-exit-code 0
  --gate-receipt "$gate_receipt"
)
"${success_args[@]}"
receipt_rc=$?
if [[ "$receipt_rc" -ne 0 ]]; then
  printf '[dream-daily %s] failed exit=%d phase=success-receipt night=%s\n' "$run_id" "$receipt_rc" "$night_id"
  exit "$receipt_rc"
fi

printf '[dream-daily %s] done exit=0 night=%s receipt=%s\n' "$run_id" "$night_id" "$(basename "$result_receipt")"
exit 0
