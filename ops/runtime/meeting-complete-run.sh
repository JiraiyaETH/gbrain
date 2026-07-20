#!/bin/bash
# Immutable-runtime entrypoint for the fail-closed meeting completion lane.
# The Python controller owns completion. This wrapper owns only environment
# hygiene, single-flight exclusion, an atomic wrapper receipt, and exact exit-code
# propagation.
set -o pipefail
umask 077

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="${MEETING_COMPLETE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export MEETING_COMPLETE_RUN_ID="$RUN_ID"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv" 2>/dev/null || true
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true

# Subscription-only guard. Values are never printed or persisted in receipts.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL

export PATH="$SCRIPT_DIR:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.nvm/versions/node/v22.22.0/bin:/opt/homebrew/opt/python@3.12/libexec/bin:$HOME/Library/Python/3.12/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

STATE_DIR="${MEETING_COMPLETE_STATE_DIR:-$HOME/.gbrain/meeting-complete-state}"
mkdir -p "$STATE_DIR" || exit 1
chmod 700 "$STATE_DIR" || exit 1
WRAPPER_RECEIPT="$STATE_DIR/wrapper-$RUN_ID.json"
LOCK_DIR="${MEETING_COMPLETE_LOCK_DIR:-$STATE_DIR/meeting-complete.lock}"
LOCK_TOKEN="$STATE_DIR/.meeting-complete-lock-token.$$"
LOCK_WAIT="${MEETING_COMPLETE_LOCK_WAIT_SECONDS:-0}"
PY="${MEETING_COMPLETE_PYTHON:-$(command -v python3.12 || command -v python3 || true)}"
SCRIPT="${MEETING_COMPLETE_SCRIPT:-$SCRIPT_DIR/meeting-complete.py}"
GB="${GBRAIN_BIN:-$SCRIPT_DIR/gbrain}"
CLAUDE="${CLAUDE_BIN:-claude}"
DB_PIN="$SCRIPT_DIR/dream-db-pin.sh"
LOCK_HELPER="${GBRAIN_RUN_LOCK_HELPER:-$SCRIPT_DIR/run-lock.py}"
CORPUS_WRITER_LOCK="${GBRAIN_CORPUS_WRITER_LOCK_DIR:-$HOME/.gbrain/locks/corpus-writer.lock}"
CORPUS_WRITER_TOKEN="$STATE_DIR/.corpus-writer-token.$$"
CORPUS_WRITER_WAIT="${MEETING_CORPUS_WRITER_WAIT_SECONDS:-7200}"
DB_PIN_EXPECTED_SHA256="8ef8386d283763a23652482050cf0e6901521109cb71d9575859855460a7722b"
DB_PIN_ACTUAL_SHA256=""
LOCK_HELPER_ACTUAL_SHA256=""
LOCK_HELD=0
CORPUS_WRITER_HELD=0

write_wrapper_receipt() {
  local primary_rc="$1" final_rc="$2" outcome="$3"
  [ -n "$PY" ] || return 1
  WR_PATH="$WRAPPER_RECEIPT" WR_RUN_ID="$RUN_ID" WR_STARTED="$STARTED_AT" \
  WR_PRIMARY_RC="$primary_rc" WR_FINAL_RC="$final_rc" WR_OUTCOME="$outcome" \
  WR_SCRIPT="$SCRIPT" WR_DB_PIN_SHA="$DB_PIN_ACTUAL_SHA256" \
  WR_LOCK_HELPER="$LOCK_HELPER" WR_LOCK_HELPER_SHA="$LOCK_HELPER_ACTUAL_SHA256" \
  WR_CORPUS_WRITER_LOCK="$CORPUS_WRITER_LOCK" "$PY" - <<'PY'
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

path = Path(os.environ["WR_PATH"])
payload = {
    "schema_version": 1,
    "run_id": os.environ["WR_RUN_ID"],
    "started_at": os.environ["WR_STARTED"],
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "primary_rc": int(os.environ["WR_PRIMARY_RC"]),
    "final_rc": int(os.environ["WR_FINAL_RC"]),
    "outcome": os.environ["WR_OUTCOME"],
    "driver": os.environ["WR_SCRIPT"],
    "db_pin_sha256": os.environ.get("WR_DB_PIN_SHA") or None,
    "lock_helper": os.environ.get("WR_LOCK_HELPER") or None,
    "lock_helper_sha256": os.environ.get("WR_LOCK_HELPER_SHA") or None,
    "corpus_writer_lock": os.environ.get("WR_CORPUS_WRITER_LOCK") or None,
}
path.parent.mkdir(parents=True, exist_ok=True)
os.chmod(path.parent, 0o700)
fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_name, path)
    os.chmod(path, 0o600)
except Exception:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(tmp_name)
    except OSError:
        pass
    raise
PY
}

cleanup_lock() {
  if [ "$CORPUS_WRITER_HELD" -eq 1 ]; then
    "$PY" "$LOCK_HELPER" release --lock-dir "$CORPUS_WRITER_LOCK" --token-file "$CORPUS_WRITER_TOKEN" --owner meeting-complete --owner-pid $$ >/dev/null 2>&1 || true
    CORPUS_WRITER_HELD=0
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    "$PY" "$LOCK_HELPER" release --lock-dir "$LOCK_DIR" --token-file "$LOCK_TOKEN" --owner meeting-complete-single-flight --owner-pid $$ >/dev/null 2>&1 || true
    LOCK_HELD=0
  fi
}

finish() {
  local primary_rc="$1" outcome="$2" final_rc="$1"
  if ! write_wrapper_receipt "$primary_rc" "$final_rc" "$outcome"; then
    echo "[meeting-complete $RUN_ID] FATAL: atomic wrapper receipt failed" >&2
    [ "$final_rc" -ne 0 ] || final_rc=4
  fi
  cleanup_lock
  echo "[meeting-complete $RUN_ID] exit primary_rc=$primary_rc final_rc=$final_rc outcome=$outcome"
  exit "$final_rc"
}

if [ -z "$PY" ]; then
  echo "[meeting-complete $RUN_ID] FATAL: python3 not found" >&2
  exit 1
fi

# The DB routing helper is part of the immutable r3 runtime. Never source the
# mutable ~/.gbrain copy, and fail closed before any controller work if its exact
# bytes drift from the sealed checksum.
[ -f "$DB_PIN" ] || finish 1 "db-pin-missing"
DB_PIN_ACTUAL_SHA256="$($PY - "$DB_PIN" <<'PY'
import hashlib
import sys
from pathlib import Path
print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)" || finish 1 "db-pin-hash-failed"
[ "$DB_PIN_ACTUAL_SHA256" = "$DB_PIN_EXPECTED_SHA256" ] || finish 1 "db-pin-checksum-mismatch"
source "$DB_PIN" || finish 1 "db-pin-source-failed"
[ -f "$LOCK_HELPER" ] || finish 1 "lock-helper-missing"
LOCK_HELPER_ACTUAL_SHA256="$($PY - "$LOCK_HELPER" <<'PY'
import hashlib
import sys
from pathlib import Path
print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)" || finish 1 "lock-helper-hash-failed"

# Use the sealed inode-locked helper for the lane single-flight boundary too.
# A contender fails busy before it can queue a second paid retry behind the
# shared corpus lock. Unique token paths make release ownership explicit.
"$PY" "$LOCK_HELPER" acquire --lock-dir "$LOCK_DIR" --token-file "$LOCK_TOKEN" --owner meeting-complete-single-flight --owner-pid $$ --wait-seconds "$LOCK_WAIT"
meeting_lock_rc=$?
[ "$meeting_lock_rc" -eq 0 ] || finish "$meeting_lock_rc" "single-flight-busy"
LOCK_HELD=1
trap cleanup_lock EXIT
trap 'finish 129 "signal-hup"' HUP
trap 'finish 130 "signal-int"' INT
trap 'finish 143 "signal-term"' TERM

"$PY" "$LOCK_HELPER" acquire --lock-dir "$CORPUS_WRITER_LOCK" --token-file "$CORPUS_WRITER_TOKEN" --owner meeting-complete --owner-pid $$ --wait-seconds "$CORPUS_WRITER_WAIT"
writer_lock_rc=$?
[ "$writer_lock_rc" -eq 0 ] || finish "$writer_lock_rc" "corpus-writer-lock-timeout"
CORPUS_WRITER_HELD=1

[ -f "$SCRIPT" ] || finish 1 "driver-missing"
command -v "$GB" >/dev/null 2>&1 || finish 1 "gbrain-missing"
if [ "${MEETING_COMPLETE_REQUIRE_CLAUDE:-1}" = "1" ]; then
  command -v "$CLAUDE" >/dev/null 2>&1 || finish 1 "claude-missing"
fi

export GBRAIN_BIN="$GB"
export CLAUDE_BIN="$CLAUDE"
export MEETING_COMPLETE_STATE_DIR="$STATE_DIR"
export MEETING_INGESTION_SKILL_DIR="${MEETING_INGESTION_SKILL_DIR:-$SCRIPT_DIR/skills/meeting-ingestion}"
export MEETING_QA_SCRIPT="${MEETING_QA_SCRIPT:-$SCRIPT_DIR/skills/meeting-ingestion/scripts/qa-meeting.sh}"
export MEETING_QA_ADAPTER="${MEETING_QA_ADAPTER:-$SCRIPT_DIR/qa-gbrain-adapter.py}"
echo "[meeting-complete $RUN_ID] start driver=$SCRIPT"
cd "${MEETING_COMPLETE_CWD:-$HOME/.gbrain}" 2>/dev/null || finish 1 "cwd-missing"
"$PY" "$SCRIPT" "$@"
primary_rc=$?
finish "$primary_rc" "driver-exit"
