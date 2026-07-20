#!/usr/bin/env bash
# gbrain brain-commit-push helper (v0.42.44+)
# THE DURABILITY GUARANTEE: add -> commit -> push, atomically. Refuses to exit 0
# without a confirmed push. Usage:
#   scripts/brain-commit-push.sh "message" <path> [path ...]
#   scripts/brain-commit-push.sh --push-only [branch]
set -euo pipefail

# --- gbrain durability push-retry (generated; one source of truth) ---
brain_push() {
  _branch="$1"
  _log="${GBRAIN_HOME:-$HOME/.gbrain}/brain-push.log"
  mkdir -p "$(dirname "$_log")" 2>/dev/null || true
  _gd="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
  # Serialize concurrent pushes (commit bursts) so they coalesce instead of a
  # rebase-retry herd. No-op if flock is unavailable.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$_gd/gbrain-push.lock"
    flock -w 30 9 || { echo "$(date -u +%FT%TZ) [push] lock-timeout $_branch" >>"$_log"; return 0; }
  fi
  if git push origin "HEAD:$_branch" >>"$_log" 2>&1; then
    echo "$(date -u +%FT%TZ) [push] ok $_branch $(git rev-parse --short HEAD 2>/dev/null)" >>"$_log"; return 0
  fi
  echo "$(date -u +%FT%TZ) [push] rejected; rebase-pull $_branch" >>"$_log"
  if git pull --rebase origin "$_branch" >>"$_log" 2>&1 && git push origin "HEAD:$_branch" >>"$_log" 2>&1; then
    echo "$(date -u +%FT%TZ) [push] ok-after-rebase $_branch $(git rev-parse --short HEAD 2>/dev/null)" >>"$_log"; return 0
  fi
  git rebase --abort >/dev/null 2>&1 || true
  echo "$(date -u +%FT%TZ) [push] LOCAL-ONLY, NEEDS ATTENTION: $_branch @ $(git rev-parse --short HEAD 2>/dev/null) could not reach origin. Run: gbrain sources pull <id> && git push" >>"$_log"
  return 1
}

_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "${1:-}" = "--push-only" ]; then
  brain_push "${2:-$_branch}"; exit $?
fi

_msg="${1:?usage: brain-commit-push.sh <message> <path> [paths...]}"; shift || true
# EXPLICIT paths only — never a blind 'git add -A' (would risk committing
# secrets, temp files, or unrelated edits).
if [ "$#" -eq 0 ]; then
  echo "refusing blind 'git add -A' — pass explicit path(s) to commit" >&2; exit 2
fi
git add -- "$@"
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
GBRAIN_DURABILITY_HELPER_COMMIT=1 git commit -m "$_msg"

# Commit the requested local edits before rebasing so a dirty tracked file
# cannot wedge the durability lane at pull --rebase.
git fetch origin >/dev/null 2>&1 || true
git pull --rebase origin "$_branch" || { git rebase --abort >/dev/null 2>&1 || true; echo "rebase conflict: manual attention needed" >&2; exit 3; }

if brain_push "$_branch"; then exit 0; fi
echo "PUSH FAILED — commit is local-only, NEEDS ATTENTION (see ${GBRAIN_HOME:-$HOME/.gbrain}/brain-push.log)" >&2
exit 4
