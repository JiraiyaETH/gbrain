#!/usr/bin/env bash
# E2E smoke for the meeting-ingestion skill (run against a live brain — like the
# DATABASE_URL-gated e2e suite). Proves: (1) the Phase-7 QA gate runs green on an
# already-ingested meeting (full structure + edge contract end-to-end), and (2) a
# meeting trigger routes to this skill in the resolver.
#
# Env (deployment-specific; method in ../references/doctrine.md, values supplied per-brain):
#   SMOKE_SLUG    an already-ingested meeting slug to verify (required for the live check)
#   BRAIN_DIR, GBRAIN_SOURCE, GBRAIN_BIN, EXEMPT_PAGES   passed through to the QA gate
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

# 2. resolver routes a meeting trigger to this skill (offline; always runs)
if grep -rq "meeting-ingestion" "$DIR/../RESOLVER.md" 2>/dev/null; then
  echo "PASS: resolver routes meeting trigger -> meeting-ingestion"
else echo "FAIL: no meeting-ingestion entry in skills/RESOLVER.md"; fail=1; fi

# 1. live QA-gate smoke (skipped when SMOKE_SLUG unset — keeps it CI-safe offline)
if [ -n "${SMOKE_SLUG:-}" ]; then
  if bash "$DIR/scripts/qa-meeting.sh" "$SMOKE_SLUG" | tail -1 | grep -q ALL-PASS; then
    echo "PASS: Phase-7 QA gate green on $SMOKE_SLUG"
  else echo "FAIL: Phase-7 QA gate on $SMOKE_SLUG"; fail=1; fi
else
  echo "SKIP: live QA-gate smoke (set SMOKE_SLUG=<ingested-meeting> to run)"
fi

[ $fail -eq 0 ] && echo "E2E SMOKE: PASS" || echo "E2E SMOKE: FAIL"
exit $fail
