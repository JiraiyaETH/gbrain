#!/bin/bash
# ~/.gbrain/enrich-thin-run.sh — launchd entrypoint for the daily thin-entity enrichment lane
# (com.gbrain.enrich-thin @ 05:45, after the 05:15 eval lane; no collisions).
#
# WHY THIS EXISTS: native `cycle.enrich_thin` is DISABLED (upstream pricing bug + the
# operator wants frontier-quality enrichment, not Haiku/DeepSeek). This lane mirrors the
# native thin-candidate predicate (src/core/postgres-engine.ts listEnrichCandidates) via
# psql, then runs the /enrich SKILL per candidate through a subscription-billed
# `claude -p` (creds hard-scrubbed like meeting-complete-run.sh → bills the Max
# subscription, CLI default = frontier model; no --model flag on purpose).
#
# Candidate predicate (mirror of listEnrichCandidates, v0.41.39 #1700):
#   type IN ('person','company'), source_id='default', not deleted,
#   char_length(compiled_truth)+char_length(COALESCE(timeline,'')) < 400,
#   frontmatter enriched_at 30-day recency guard (lexical ISO compare; NULL eligible),
#   ORDER BY inbound non-mentions links DESC, source_id, slug — LIMIT $GBRAIN_ENRICH_THIN_MAX.
#
# Env knobs: GBRAIN_ENRICH_THIN_MAX (default 2), GBRAIN_ENRICH_THIN_TIMEOUT (default 900s).
# Logging: one RESULT line per candidate (OK/FAIL slug) to stdout (launchd routes to
# ~/.gbrain/enrich-thin.log). Nonzero exit if any candidate FAILs. NEVER logs the DB URL.
set -o pipefail   # NOT -u: sourcing ~/.zshenv under launchd's minimal env may hit unset vars

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
WRAPPER_PATH="$SCRIPT_DIR/$(basename "$0")"
PYTHON_BIN="${GBRAIN_ENRICH_PYTHON:-/usr/bin/python3}"
GBRAIN_BIN="${GBRAIN_BIN:-$SCRIPT_DIR/gbrain}"
DB_PIN_HELPER="${GBRAIN_DB_PIN_HELPER:-$SCRIPT_DIR/dream-db-pin.sh}"
SKILL_FILE="${GBRAIN_ENRICH_SKILL_FILE:-$SCRIPT_DIR/skills/enrich/SKILL.md}"
RECEIPT_WRITER="${GBRAIN_ENRICH_RECEIPT_WRITER:-$SCRIPT_DIR/write-enrich-thin-receipt.py}"
POSTCONDITION_HELPER="${GBRAIN_ENRICH_POSTCONDITION_HELPER:-$SCRIPT_DIR/enrich-thin-postcondition.py}"
LOCK_HELPER="${GBRAIN_RUN_LOCK_HELPER:-$SCRIPT_DIR/run-lock.py}"
RUN_ID="${GBRAIN_ENRICH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
STARTED_AT="${GBRAIN_ENRICH_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
SAFE_RUN_ID="$(printf '%s' "$RUN_ID" | tr -c 'A-Za-z0-9_.-' '-')"
[ -n "$SAFE_RUN_ID" ] || SAFE_RUN_ID="enrich-thin-$$"
RESULT_ARGS=()
CAND_COUNT=0

if [ "${GBRAIN_ENRICH_SKIP_SHELL_ENV:-0}" != "1" ]; then
  [ -f "$HOME/.zshenv" ]   && source "$HOME/.zshenv"   2>/dev/null || true
  [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true
  [ -f "$HOME/.profile" ]  && source "$HOME/.profile"  2>/dev/null || true
fi
# Supabase pooler IP-pin (same DNS-wedge bypass as the dream/meeting lanes).
if [ "${GBRAIN_ENRICH_SKIP_DB_PIN:-0}" != "1" ] && [ -f "$DB_PIN_HELPER" ]; then
  source "$DB_PIN_HELPER"
fi

# SUBSCRIPTION GUARD: scrub metered-API creds so `claude` can only bill the Max subscription.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL

export PATH="$SCRIPT_DIR:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/opt/libpq/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export GBRAIN_BIN
# per-shelf ranking tune 2026-07-13 — revert: delete these 2 lines
export GBRAIN_RECENCY_DECAY="personal/:365:0.3,personal/taste/:0:0,contracts/:365:0.2,projects/:120:0.6,ideas/:365:0.2,research/:90:0.8,notes/:180:0.3,sources/:180:0.4,reports/:30:1.2,workout/:21:1.2,food/:21:1.2,conversations/:60:0.5,dream-cycle-summaries/:21:1.2,inbox/:14:1.0"
export GBRAIN_SOURCE_BOOST="personal/:1.3,personal/taste/:1.4,contracts/:1.2,projects/:1.2,ideas/:1.1,research/:1.1,sources/:0.9,reports/:0.9,workout/:0.9,food/:0.9,conversations/:0.8,dream-cycle-summaries/:0.7,inbox/:0.7"

PSQL="${GBRAIN_ENRICH_PSQL:-/opt/homebrew/opt/libpq/bin/psql}"
CLAUDE_BIN="${GBRAIN_ENRICH_CLAUDE_BIN:-claude}"
BRAIN_DIR="${GBRAIN_BRAIN_DIR:-/Users/jarvis/brain}"
MAX="${GBRAIN_ENRICH_THIN_MAX:-2}"
PER_CAND_TIMEOUT="${GBRAIN_ENRICH_THIN_TIMEOUT:-900}"
log() { echo "[enrich-thin $RUN_ID] $*"; }

STATE_DIR="${GBRAIN_ENRICH_STATE_DIR:-$HOME/.gbrain/enrich-thin-state}"
RECEIPT_DIR="${GBRAIN_ENRICH_RECEIPT_DIR:-$STATE_DIR/receipts}"
RETRY_LEDGER="${GBRAIN_ENRICH_RETRY_LEDGER:-$STATE_DIR/retry-ledger.json}"
CORPUS_WRITER_LOCK="${GBRAIN_CORPUS_WRITER_LOCK_DIR:-$HOME/.gbrain/locks/corpus-writer.lock}"
CORPUS_WRITER_TOKEN="$STATE_DIR/.corpus-writer-token.$$"
CORPUS_WRITER_WAIT="${GBRAIN_ENRICH_CORPUS_WRITER_WAIT_SECONDS:-7200}"
CORPUS_WRITER_HELD=0
LANE_LOCK_DIR="${GBRAIN_ENRICH_LOCK_DIR:-$STATE_DIR/enrich-thin.lock}"
LANE_LOCK_TOKEN="$STATE_DIR/.enrich-thin-lock-token.$$"
LANE_LOCK_WAIT="${GBRAIN_ENRICH_SINGLE_FLIGHT_WAIT_SECONDS:-0}"
LANE_LOCK_HELD=0
RUN_AUDIT_DIR="$STATE_DIR/audits/$SAFE_RUN_ID"
umask 077
mkdir -p "$STATE_DIR" "$RECEIPT_DIR" "$RUN_AUDIT_DIR"
chmod 700 "$STATE_DIR" "$RECEIPT_DIR" "$STATE_DIR/audits" "$RUN_AUDIT_DIR" 2>/dev/null || true

write_terminal_receipt() {
  receipt_status="$1"
  receipt_reason="$2"
  primary_rc="$3"
  finished_at="${GBRAIN_ENRICH_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  receipt_args=(
    "$PYTHON_BIN" "$RECEIPT_WRITER"
    --receipt-dir "$RECEIPT_DIR"
    --run-id "$RUN_ID"
    --status "$receipt_status"
    --reason "$receipt_reason"
    --primary-exit "$primary_rc"
    --started-at "$STARTED_AT"
    --finished-at "$finished_at"
    --candidate-count "$CAND_COUNT"
    --artifact "wrapper=$WRAPPER_PATH"
    --artifact "gbrain=$GBRAIN_BIN"
    --artifact "skill=$SKILL_FILE"
    --artifact "db_pin=$DB_PIN_HELPER"
    --artifact "postcondition=$POSTCONDITION_HELPER"
    --artifact "receipt_writer=$RECEIPT_WRITER"
  )
  receipt_args+=("${RESULT_ARGS[@]}")
  "${receipt_args[@]}" >/dev/null
}

finish_run() {
  finish_status="$1"
  finish_reason="$2"
  primary_rc="$3"
  write_terminal_receipt "$finish_status" "$finish_reason" "$primary_rc"
  receipt_rc=$?
  if [ "$primary_rc" -ne 0 ]; then
    exit "$primary_rc"
  fi
  if [ "$receipt_rc" -ne 0 ]; then
    log "FATAL: terminal receipt failed rc=$receipt_rc"
    exit "$receipt_rc"
  fi
  exit 0
}

fatal() {
  log "FATAL: $1"
  finish_run failure "$2" 1
}

cleanup_locks() {
  if [ "$CORPUS_WRITER_HELD" -eq 1 ]; then
    "$PYTHON_BIN" "$LOCK_HELPER" release --lock-dir "$CORPUS_WRITER_LOCK" --token-file "$CORPUS_WRITER_TOKEN" --owner enrich-thin --owner-pid $$ >/dev/null 2>&1 || true
    CORPUS_WRITER_HELD=0
  fi
  if [ "$LANE_LOCK_HELD" -eq 1 ]; then
    "$PYTHON_BIN" "$LOCK_HELPER" release --lock-dir "$LANE_LOCK_DIR" --token-file "$LANE_LOCK_TOKEN" --owner enrich-thin-single-flight --owner-pid $$ >/dev/null 2>&1 || true
    LANE_LOCK_HELD=0
  fi
}

[ -f "$LOCK_HELPER" ] || fatal "run lock helper missing at $LOCK_HELPER" missing_lock_helper
# Fail busy before the paid candidate loop instead of queueing a duplicate retry
# behind the corpus writer lock. The sealed helper provides exact-owner release
# and race-safe stale recovery for this lane-specific single-flight boundary.
"$PYTHON_BIN" "$LOCK_HELPER" acquire --lock-dir "$LANE_LOCK_DIR" --token-file "$LANE_LOCK_TOKEN" --owner enrich-thin-single-flight --owner-pid $$ --wait-seconds "$LANE_LOCK_WAIT"
lane_lock_rc=$?
[ "$lane_lock_rc" -eq 0 ] || finish_run failure single_flight_busy "$lane_lock_rc"
LANE_LOCK_HELD=1
trap cleanup_locks EXIT

"$PYTHON_BIN" "$LOCK_HELPER" acquire --lock-dir "$CORPUS_WRITER_LOCK" --token-file "$CORPUS_WRITER_TOKEN" --owner enrich-thin --owner-pid $$ --wait-seconds "$CORPUS_WRITER_WAIT"
writer_lock_rc=$?
[ "$writer_lock_rc" -eq 0 ] || finish_run failure corpus_writer_lock_timeout "$writer_lock_rc"
CORPUS_WRITER_HELD=1

command -v "$CLAUDE_BIN" >/dev/null 2>&1 || fatal "claude not on PATH" missing_claude
[ -x "$PSQL" ]                    || fatal "$PSQL not found" missing_psql
[ -x "$GBRAIN_BIN" ]              || fatal "pinned gbrain missing at $GBRAIN_BIN" missing_gbrain
[ -f "$SKILL_FILE" ]              || fatal "enrich skill missing at $SKILL_FILE" missing_skill
[ -f "$DB_PIN_HELPER" ]           || fatal "DB pin helper missing at $DB_PIN_HELPER" missing_db_pin
[ -f "$POSTCONDITION_HELPER" ]     || fatal "postcondition helper missing at $POSTCONDITION_HELPER" missing_postcondition
[ -f "$RECEIPT_WRITER" ]          || { log "FATAL: receipt writer missing at $RECEIPT_WRITER"; exit 1; }
TIMEOUT_BIN="${GBRAIN_ENRICH_TIMEOUT_BIN:-$(command -v timeout || command -v gtimeout || true)}"
[ -n "$TIMEOUT_BIN" ] && [ -x "$TIMEOUT_BIN" ] || fatal "coreutils timeout not found" missing_timeout
case "$MAX" in (*[!0-9]*|'') fatal "GBRAIN_ENRICH_THIN_MAX must be a non-negative integer" invalid_max;; esac
case "$PER_CAND_TIMEOUT" in (*[!0-9]*|'') fatal "GBRAIN_ENRICH_THIN_TIMEOUT must be a non-negative integer" invalid_timeout;; esac

# DB URL: prefer the IP-pinned session-pooler URL from dream-db-pin; fall back to config.json.
# NEVER log either value.
DBURL="${GBRAIN_DATABASE_URL:-}"
if [ -z "$DBURL" ]; then
  DBURL="$("$PYTHON_BIN" -c "import json;print(json.load(open('$HOME/.gbrain/config.json'))['database_url'])" 2>/dev/null)"
fi
[ -n "$DBURL" ] || fatal "could not resolve database_url" missing_database_url

GUARD_TS="$(GBRAIN_ENRICH_NOW="${GBRAIN_ENRICH_NOW:-}" "$PYTHON_BIN" - <<'PY'
from datetime import datetime, timedelta, timezone
import os

raw = os.environ.get("GBRAIN_ENRICH_NOW")
now = datetime.fromisoformat(raw.replace("Z", "+00:00")) if raw else datetime.now(timezone.utc)
if now.tzinfo is None:
    now = now.replace(tzinfo=timezone.utc)
print((now.astimezone(timezone.utc) - timedelta(days=30)).isoformat())
PY
)" || fatal "could not compute enrichment guard" guard_timestamp_failed

log "start  oauth=${CLAUDE_CODE_OAUTH_TOKEN:+present}  api_key=${ANTHROPIC_API_KEY:+SET!}${ANTHROPIC_API_KEY:-unset}  max=$MAX timeout=${PER_CAND_TIMEOUT}s"

# Mirror of listEnrichCandidates (postgres-engine.ts ~5641) incl. the enriched_at guard.
QUERY_FILE="$RUN_AUDIT_DIR/query-candidates.txt"
if ! "$PSQL" "$DBURL" -Atc "
SELECT p.slug
FROM pages p
WHERE p.deleted_at IS NULL
  AND p.type = ANY(ARRAY['person','company'])
  AND p.source_id = 'default'
  AND (char_length(p.compiled_truth) + char_length(COALESCE(p.timeline,''))) < 400
  AND NOT (
        p.frontmatter ->> 'enriched_at' IS NOT NULL
    AND p.frontmatter ->> 'enriched_at' > '$GUARD_TS'
  )
ORDER BY COALESCE((
    SELECT COUNT(*) FROM links l
    WHERE l.to_page_id = p.id AND l.link_source IS DISTINCT FROM 'mentions'
  ),0) DESC, p.source_id ASC, p.slug ASC
LIMIT $MAX;" > "$QUERY_FILE"; then
  fatal "candidate query failed" candidate_query_failed
fi
chmod 600 "$QUERY_FILE" 2>/dev/null || true

# Retry state is independent of the DB recency stamp. A partial import therefore
# cannot make a failed candidate disappear from the next scheduled run.
CANDIDATES="$("$PYTHON_BIN" "$POSTCONDITION_HELPER" candidates \
  --ledger "$RETRY_LEDGER" --query-file "$QUERY_FILE" --max "$MAX")" \
  || fatal "could not reconcile retry candidates" retry_ledger_invalid

if [ -z "$CANDIDATES" ]; then
  log "no candidates"
  finish_run success no_candidates 0
fi

cd "$BRAIN_DIR" || fatal "cannot cd $BRAIN_DIR" brain_directory_unavailable
FAILS=0
TODAY_ISO="${GBRAIN_ENRICH_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

mark_retry() {
  "$PYTHON_BIN" "$POSTCONDITION_HELPER" ledger-mark \
    --ledger "$RETRY_LEDGER" --slug "$1" --reason "$2" --run-id "$RUN_ID" --at "$STARTED_AT" \
    >/dev/null 2>&1
}

clear_retry() {
  "$PYTHON_BIN" "$POSTCONDITION_HELPER" ledger-clear --ledger "$RETRY_LEDGER" --slug "$1" \
    >/dev/null 2>&1
}

record_failure() {
  result_slug="$1"; result_rc="$2"; result_reason="$3"; result_audit="${4:-}"
  if ! mark_retry "$result_slug" "$result_reason"; then
    result_rc=68
    result_reason="retry_ledger_write_failed"
    result_audit=""
  fi
  RESULT_ARGS+=(--result "$result_slug=$result_rc|$result_reason|$result_audit")
  FAILS=$((FAILS+1))
  log "RESULT FAIL $result_slug rc=$result_rc reason=$result_reason"
}

while IFS= read -r SLUG; do
  [ -n "$SLUG" ] || continue
  CAND_COUNT=$((CAND_COUNT+1))
  log "enriching $SLUG"
  CAND_AUDIT_DIR="$RUN_AUDIT_DIR/candidates/$SLUG"
  mkdir -p "$CAND_AUDIT_DIR"
  chmod 700 "$CAND_AUDIT_DIR" 2>/dev/null || true
  SNAPSHOT_AUDIT="$CAND_AUDIT_DIR/snapshot.json"
  SOURCE_AUDIT="$CAND_AUDIT_DIR/source-postcondition.json"
  PARITY_AUDIT="$CAND_AUDIT_DIR/db-parity.json"
  TARGET_FILE="$BRAIN_DIR/$SLUG.md"

  # Mark in-progress before any paid/side-effecting child work. An abrupt exit
  # leaves a durable retry candidate even if the DB was partially mutated.
  if ! mark_retry "$SLUG" in_progress; then
    record_failure "$SLUG" 68 retry_ledger_write_failed
    continue
  fi

  SNAPSHOT_REASON="$("$PYTHON_BIN" "$POSTCONDITION_HELPER" snapshot \
    --brain-dir "$BRAIN_DIR" --slug "$SLUG" --started-at "$STARTED_AT" \
    --backup "$CAND_AUDIT_DIR/before.md" --output "$SNAPSHOT_AUDIT")"
  SNAPSHOT_RC=$?
  if [ "$SNAPSHOT_RC" -ne 0 ]; then
    record_failure "$SLUG" "$SNAPSHOT_RC" "${SNAPSHOT_REASON:-preflight_failed}" "$SNAPSHOT_AUDIT"
    continue
  fi

  PROMPT="Read ${SKILL_FILE} and follow its research, citation, filing-quality, timeline, and subject-assignment rules to enrich ${SLUG} (source default). The scheduled controller owns persistence: edit only the exact existing file ${TARGET_FILE}; do not run gbrain put, capture, import, sync, embed, delete, or any database write; do not edit or commit any other file. Consolidate what the Brain already knows first with read-only ${GBRAIN_BIN} search/query/get/get_backlinks/facts calls, then do web research per the skill tier. Preserve valid frontmatter/body structure, add only sourced durable claims, and stamp the exact target frontmatter enriched_at: ${TODAY_ISO}. If nothing beyond the stub is supportable, make the minimal sourced tier-3 improvement. Do not fabricate. Exit nonzero unless the exact target was changed and stamped."
  T0=$(date +%s)
  "$TIMEOUT_BIN" "$PER_CAND_TIMEOUT" "$CLAUDE_BIN" -p "$PROMPT" \
    --dangerously-skip-permissions --max-turns "${GBRAIN_ENRICH_THIN_MAX_TURNS:-80}" \
    --allowedTools "Bash" "Read" "Glob" "Grep" "Write" "Edit" "WebSearch" "WebFetch" \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --no-session-persistence \
    --add-dir "$BRAIN_DIR" \
    --add-dir "$SCRIPT_DIR/skills" \
    < /dev/null > "$STATE_DIR/last-$(echo "$SLUG" | tr '/' '_').out" 2>&1
  RC=$?
  T1=$(date +%s)
  if [ "$RC" -ne 0 ]; then
    [ $RC -eq 124 ] && log "candidate timed out after ${PER_CAND_TIMEOUT}s"
    record_failure "$SLUG" "$RC" claude_failed "$SNAPSHOT_AUDIT"
    continue
  fi

  SOURCE_REASON="$("$PYTHON_BIN" "$POSTCONDITION_HELPER" verify-source \
    --snapshot "$SNAPSHOT_AUDIT" --started-at "$STARTED_AT" --output "$SOURCE_AUDIT")"
  SOURCE_RC=$?
  if [ "$SOURCE_RC" -ne 0 ]; then
    record_failure "$SLUG" "$SOURCE_RC" "${SOURCE_REASON:-source_postcondition_failed}" "$SOURCE_AUDIT"
    continue
  fi

  # Validate exactly one file while preserving its Brain-relative slug. Passing
  # the file directly would make frontmatter validation derive the slug from an
  # absolute path; the one-file validation root avoids that false mismatch.
  VALIDATE_ROOT="$CAND_AUDIT_DIR/validate-root"
  if ! mkdir -p "$VALIDATE_ROOT/$(dirname "$SLUG")" \
      || ! cp "$TARGET_FILE" "$VALIDATE_ROOT/$SLUG.md"; then
    record_failure "$SLUG" 66 validation_copy_failed "$SOURCE_AUDIT"
    continue
  fi
  chmod 600 "$VALIDATE_ROOT/$SLUG.md" 2>/dev/null || true
  FRONTMATTER_TMP="$CAND_AUDIT_DIR/.frontmatter.json.tmp"
  FRONTMATTER_AUDIT="$CAND_AUDIT_DIR/frontmatter.json"
  GBRAIN_SOURCE=default "$GBRAIN_BIN" frontmatter validate "$VALIDATE_ROOT" --json > "$FRONTMATTER_TMP" 2>&1
  FRONTMATTER_RC=$?
  mv "$FRONTMATTER_TMP" "$FRONTMATTER_AUDIT"
  chmod 600 "$FRONTMATTER_AUDIT" 2>/dev/null || true
  if [ "$FRONTMATTER_RC" -ne 0 ]; then
    record_failure "$SLUG" "$FRONTMATTER_RC" frontmatter_invalid "$FRONTMATTER_AUDIT"
    continue
  fi

  IMPORT_TMP="$CAND_AUDIT_DIR/.import.out.tmp"
  IMPORT_LOG="$CAND_AUDIT_DIR/import.out"
  GBRAIN_SOURCE=default "$GBRAIN_BIN" put "$SLUG" < "$TARGET_FILE" > "$IMPORT_TMP" 2>&1
  IMPORT_RC=$?
  mv "$IMPORT_TMP" "$IMPORT_LOG"
  chmod 600 "$IMPORT_LOG" 2>/dev/null || true
  if [ "$IMPORT_RC" -ne 0 ]; then
    record_failure "$SLUG" "$IMPORT_RC" import_failed "$IMPORT_LOG"
    continue
  fi

  DB_TMP="$CAND_AUDIT_DIR/.database-page.md.tmp"
  DB_MARKDOWN="$CAND_AUDIT_DIR/database-page.md"
  GBRAIN_SOURCE=default "$GBRAIN_BIN" get "$SLUG" > "$DB_TMP" 2>&1
  GET_RC=$?
  mv "$DB_TMP" "$DB_MARKDOWN"
  chmod 600 "$DB_MARKDOWN" 2>/dev/null || true
  if [ "$GET_RC" -ne 0 ]; then
    record_failure "$SLUG" "$GET_RC" get_failed "$DB_MARKDOWN"
    continue
  fi

  PARITY_REASON="$("$PYTHON_BIN" "$POSTCONDITION_HELPER" verify-parity \
    --snapshot "$SNAPSHOT_AUDIT" --db-markdown "$DB_MARKDOWN" \
    --started-at "$STARTED_AT" --output "$PARITY_AUDIT")"
  PARITY_RC=$?
  if [ "$PARITY_RC" -ne 0 ]; then
    record_failure "$SLUG" "$PARITY_RC" "${PARITY_REASON:-parity_failed}" "$PARITY_AUDIT"
    continue
  fi

  if ! clear_retry "$SLUG"; then
    record_failure "$SLUG" 68 retry_ledger_clear_failed "$PARITY_AUDIT"
    continue
  fi
  RESULT_ARGS+=(--result "$SLUG=0|verified|$PARITY_AUDIT")
  log "RESULT OK $SLUG verified ($((T1-T0))s plus controller audit)"
done <<< "$CANDIDATES"

log "done fails=$FAILS"
if [ "$FAILS" -ne 0 ]; then
  finish_run failure candidate_failure 1
fi
finish_run success completed 0
