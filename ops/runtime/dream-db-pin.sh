# ~/.gbrain/dream-db-pin.sh — sourceable Supabase pooler IP-pin (DNS-wedge bypass).
#
# Mirrors autopilot-run.sh's pin: the long-/short-lived Bun worker's resolver wedges on
# flaky-upstream DNS (observed 100% getaddrinfo ENOTFOUND, 0 TCP failures). Resolve the
# pooler IP once in a fresh process and pin it via GBRAIN_DATABASE_URL +
# GBRAIN_DIRECT_DATABASE_URL (Session pooler :5432, IPv4 — the minion queue + write-through
# route through the DIRECT pool) so the connection never does a wedge-prone lookup.
# Re-resolves on every run, so AWS IP rotation self-heals. Adds no secret beyond what
# ~/.gbrain/config.json already holds. Sourced by dream-dispatch.sh and dream-synthesis-worker.sh.
__PH="aws-1-ap-southeast-1.pooler.supabase.com"
__PIP="$(dig +short A "$__PH" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
[ -z "$__PIP" ] && __PIP="$(dig +short A "$__PH" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
if [ -n "$__PIP" ]; then
  __IPURL="$(python3 -c "import json;u=json.load(open('$HOME/.gbrain/config.json'))['database_url'];print(u.replace('$__PH','$__PIP'))" 2>/dev/null)"
  __SESS="$(printf '%s' "$__IPURL" | sed 's|:6543/|:5432/|')"
  if [ -n "$__SESS" ]; then
    export GBRAIN_DATABASE_URL="$__SESS"
    export GBRAIN_DIRECT_DATABASE_URL="$__SESS"
    export GBRAIN_PREPARE="${GBRAIN_PREPARE:-false}"
    echo "[dream-db-pin] pinned pooler -> ${__PIP}:5432"
  fi
else
  echo "[dream-db-pin] WARN: could not resolve $__PH; falling back to config.json url (may ENOTFOUND)"
fi
unset __PH __PIP __IPURL __SESS
