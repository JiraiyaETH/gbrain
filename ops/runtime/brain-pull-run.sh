#!/bin/bash
# Immutable-r3 default-source pull with shared corpus-writer exclusion.
set -uo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
PYTHON_BIN="${GBRAIN_LOCK_PYTHON:-/usr/bin/python3}"
LOCK_HELPER="${GBRAIN_RUN_LOCK_HELPER:-$SCRIPT_DIR/run-lock.py}"
GBRAIN_BIN="${GBRAIN_BIN:-$SCRIPT_DIR/gbrain}"
LOCK_DIR="${GBRAIN_CORPUS_WRITER_LOCK_DIR:-$HOME/.gbrain/locks/corpus-writer.lock}"
TOKEN_FILE="$HOME/.gbrain/locks/.brain-pull-token.$$"
WAIT_SECONDS="${GBRAIN_BRAIN_PULL_LOCK_WAIT_SECONDS:-1800}"

[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv" 2>/dev/null || true
source "$HOME/.zshrc" 2>/dev/null || source "$HOME/.bashrc" 2>/dev/null || true
if [ ! -d /Users/jarvis/brain/.git ]; then
  echo "$(date -u +%FT%TZ) [cron] path gone, skipping: /Users/jarvis/brain" >> "$HOME/.gbrain/brain-push.log" 2>/dev/null || true
  exit 0
fi
[ -f "$LOCK_HELPER" ] || exit 69
[ -x "$GBRAIN_BIN" ] || exit 69

"$PYTHON_BIN" "$LOCK_HELPER" acquire --lock-dir "$LOCK_DIR" --token-file "$TOKEN_FILE" --owner brain-pull-default --owner-pid $$ --wait-seconds "$WAIT_SECONDS"
primary_rc=$?
[ "$primary_rc" -eq 0 ] || exit "$primary_rc"
release_lock() {
  "$PYTHON_BIN" "$LOCK_HELPER" release --lock-dir "$LOCK_DIR" --token-file "$TOKEN_FILE" --owner brain-pull-default --owner-pid $$ >/dev/null 2>&1 || true
}
trap release_lock EXIT HUP INT TERM

"$GBRAIN_BIN" sources pull --path /Users/jarvis/brain --branch main
primary_rc=$?
exit "$primary_rc"
