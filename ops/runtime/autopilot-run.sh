#!/bin/bash
# Immutable-r3 Autopilot launcher. Subscription Dream phases remain structurally
# excluded from Autopilot code and available only through deliberate/manual or
# receipt-gated scheduled Dream entrypoints.
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
DB_PIN="$SCRIPT_DIR/dream-db-pin.sh"
DB_PIN_SHA256="8ef8386d283763a23652482050cf0e6901521109cb71d9575859855460a7722b"
RUN_LOCK_HELPER="$SCRIPT_DIR/run-lock.py"
RUN_LOCK_SHA256="5592258b3d417a67bbe5c188c441947a1919ef3881224b94a1f4eb1d4b1b1f82"

[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"
[ -f "$HOME/.profile" ] && source "$HOME/.profile"
export PATH="$SCRIPT_DIR:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export GBRAIN_WORKER_CONCURRENCY="${GBRAIN_WORKER_CONCURRENCY:-2}"
export GBRAIN_AUTOPILOT_MAX_WORKER_CRASHES="${GBRAIN_AUTOPILOT_MAX_WORKER_CRASHES:-30}"
export GBRAIN_CONNECT_ATTEMPTS="${GBRAIN_CONNECT_ATTEMPTS:-15}"
export GBRAIN_POOL_SIZE="${GBRAIN_POOL_SIZE:-2}"
export GBRAIN_DIRECT_POOL_SIZE="${GBRAIN_DIRECT_POOL_SIZE:-1}"
export GBRAIN_MAX_CONNECTIONS="${GBRAIN_MAX_CONNECTIONS:-8}"
export GBRAIN_ALLOW_SHELL_JOBS="${GBRAIN_ALLOW_SHELL_JOBS:-1}"
export GBRAIN_DB_FAIL_EXIT_AFTER="${GBRAIN_DB_FAIL_EXIT_AFTER:-6}"
export GBRAIN_DB_PROBE_TIMEOUT_MS="${GBRAIN_DB_PROBE_TIMEOUT_MS:-20000}"
export GBRAIN_PHASE_TIMEOUT_SECONDS="${GBRAIN_PHASE_TIMEOUT_SECONDS:-600}"
export GBRAIN_RUN_LOCK_HELPER="$RUN_LOCK_HELPER"
export GBRAIN_PYTHON_BIN="/usr/bin/python3"
export GBRAIN_CORPUS_WRITER_LOCK_DIR="$HOME/.gbrain/locks/corpus-writer.lock"
export GBRAIN_AUTOPILOT_CORPUS_LOCK_WAIT_SECONDS="${GBRAIN_AUTOPILOT_CORPUS_LOCK_WAIT_SECONDS:-15}"
export GBRAIN_AUTOPILOT_CORPUS_LOCK_POLL_SECONDS="${GBRAIN_AUTOPILOT_CORPUS_LOCK_POLL_SECONDS:-1}"
export GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS="${GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS:-30}"
export GBRAIN_RECENCY_DECAY="personal/:365:0.3,personal/taste/:0:0,contracts/:365:0.2,projects/:120:0.6,ideas/:365:0.2,research/:90:0.8,notes/:180:0.3,sources/:180:0.4,reports/:30:1.2,workout/:21:1.2,food/:21:1.2,conversations/:60:0.5,dream-cycle-summaries/:21:1.2,inbox/:14:1.0"
export GBRAIN_SOURCE_BOOST="personal/:1.3,personal/taste/:1.4,contracts/:1.2,projects/:1.2,ideas/:1.1,research/:1.1,sources/:0.9,reports/:0.9,workout/:0.9,food/:0.9,conversations/:0.8,dream-cycle-summaries/:0.7,inbox/:0.7"

[ -f "$DB_PIN" ] || { echo "[autopilot] missing sealed DB pin helper" >&2; exit 1; }
ACTUAL_DB_PIN_SHA256="$(/usr/bin/shasum -a 256 "$DB_PIN" | /usr/bin/awk '{print $1}')"
[ "$ACTUAL_DB_PIN_SHA256" = "$DB_PIN_SHA256" ] || {
  echo "[autopilot] sealed DB pin checksum mismatch" >&2
  exit 1
}
source "$DB_PIN" || exit 1

[ -f "$RUN_LOCK_HELPER" ] || { echo "[autopilot] missing sealed writer-lock helper" >&2; exit 1; }
ACTUAL_RUN_LOCK_SHA256="$(/usr/bin/shasum -a 256 "$RUN_LOCK_HELPER" | /usr/bin/awk '{print $1}')"
[ "$ACTUAL_RUN_LOCK_SHA256" = "$RUN_LOCK_SHA256" ] || {
  echo "[autopilot] sealed writer-lock checksum mismatch" >&2
  exit 1
}

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -x "$SCRIPT_DIR/get-secret.sh" ]; then
  export ANTHROPIC_API_KEY="$("$SCRIPT_DIR/get-secret.sh" ANTHROPIC_API_KEY 2>/dev/null || true)"
fi

cd /Users/jarvis/.gbrain || exit 1
exec "$SCRIPT_DIR/gbrain" autopilot --repo /Users/jarvis/brain --interval 1800
