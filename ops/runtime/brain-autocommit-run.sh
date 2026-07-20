#!/bin/bash
# Immutable-r3 autocommit launcher with shared corpus-writer exclusion.
set -uo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
PYTHON_BIN="${GBRAIN_LOCK_PYTHON:-/usr/bin/python3}"
LOCK_HELPER="${GBRAIN_RUN_LOCK_HELPER:-$SCRIPT_DIR/run-lock.py}"
PINNED_HELPER="$SCRIPT_DIR/brain-commit-push-pinned.sh"
PINNED_HELPER_SHA256="df24cab7b473154ac01d86a4f6db8b782e51ca117dab2915293cf3db717e083c"
LOCK_DIR="${GBRAIN_CORPUS_WRITER_LOCK_DIR:-$HOME/.gbrain/locks/corpus-writer.lock}"
TOKEN_FILE="$HOME/.gbrain/locks/.brain-autocommit-token.$$"
WAIT_SECONDS="${GBRAIN_AUTOCOMMIT_LOCK_WAIT_SECONDS:-1800}"

[ -f "$PINNED_HELPER" ] || exit 69
actual_sha="$(/usr/bin/shasum -a 256 "$PINNED_HELPER" | /usr/bin/awk '{print $1}')" || exit 69
[ "$actual_sha" = "$PINNED_HELPER_SHA256" ] || exit 69
[ -f "$LOCK_HELPER" ] || exit 69

"$PYTHON_BIN" "$LOCK_HELPER" acquire --lock-dir "$LOCK_DIR" --token-file "$TOKEN_FILE" --owner brain-autocommit --owner-pid $$ --wait-seconds "$WAIT_SECONDS"
primary_rc=$?
[ "$primary_rc" -eq 0 ] || exit "$primary_rc"
release_lock() {
  "$PYTHON_BIN" "$LOCK_HELPER" release --lock-dir "$LOCK_DIR" --token-file "$TOKEN_FILE" --owner brain-autocommit --owner-pid $$ >/dev/null 2>&1 || true
}
trap release_lock EXIT HUP INT TERM

if [ "$#" -eq 0 ]; then
  set -- brain-autocommit .
fi
"$PINNED_HELPER" "$@"
primary_rc=$?
exit "$primary_rc"
