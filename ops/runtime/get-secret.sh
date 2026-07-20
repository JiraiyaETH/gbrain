#!/bin/bash
# get-secret.sh — Retrieve a secret from the 1Password "jarvis-agent" vault.
#
# CANONICAL LOCATION: ~/bin/get-secret.sh (on PATH as `get-secret`).
# All agents (Hermes profiles and Claude Code) share this single copy. The
# historical per-agent paths are now symlinks to this file:
#   ~/.hermes/profiles/<profile>/scripts/get-secret.sh -> ~/bin/get-secret.sh
# Do NOT recreate per-agent copies — edit this file only.
#
# Priority: local cache > 1Password CLI > macOS Keychain > profile .env
# Usage: get-secret.sh [--flush] KEY_NAME [FIELD]
#
# FIELD defaults to auto-detect: tries credential → password → first concealed field.
# Explicit FIELD overrides auto-detect (e.g., "refresh_token", "private_key") and
# fails rather than silently substituting a different field.
#
# Vault: jarvis-agent
# Token architecture:
#   Shared read-only token:  $HOME/.config/op/service_account_token  — used here (all agents)
#   CEO-only read/write:     <profile>/secrets/op-rw-token (or legacy
#                            ~/.config/op/op-rw-token) — store-secret.sh only
# Convention: API keys use "credential" field. Login items use "password".
# Values are printed only as command output for the requested key; callers must not log them.
#
# Path overrides (env): HERMES_HOME, HERMES_ENV_FILE, HERMES_SECRET_CACHE,
#                       HERMES_SECRET_INCIDENT_FLAG. Cache + incident flag default
#                       to a single machine-global location so reads and rotations
#                       (store-secret.sh) stay consistent across all agents.

set -euo pipefail

# launchd and host wrappers often provide a minimal PATH. Ensure Homebrew tools
# like `op`, `timeout`, and `gtimeout` remain discoverable in non-interactive runs.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

FLUSH=0
if [[ "${1:-}" == "--flush" ]]; then
    FLUSH=1
    shift
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "Usage: $(basename "$0") [--flush] KEY_NAME [FIELD]" >&2
    exit 1
fi

KEY_NAME="$1"
FIELD="${2:-}"

# Profile home is derived from where the script is *invoked* (BASH_SOURCE follows
# the symlink path, not its target), so a call through
# ~/.hermes/profiles/alex/scripts/get-secret.sh still resolves HERMES_HOME to the
# alex profile. A direct ~/bin call resolves to $HOME, in which case we skip the
# per-profile .env entirely rather than read a stray ~/.env.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HERMES_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
HERMES_PROFILE_HOME="${HERMES_HOME:-$DEFAULT_HERMES_HOME}"

if [[ "$HERMES_PROFILE_HOME" != "$HOME" ]]; then
    ENV_FILE="${HERMES_ENV_FILE:-$HERMES_PROFILE_HOME/.env}"
else
    ENV_FILE="${HERMES_ENV_FILE:-}"
fi

OP_TOKEN_FILE="$HOME/.config/op/service_account_token"
OP_TOKEN_FILE_FALLBACK="/Users/jarvis/.config/op/service_account_token"
OP_BIN=$(command -v op 2>/dev/null || echo "/opt/homebrew/bin/op")
TIMEOUT_CMD=$(
    command -v timeout 2>/dev/null \
    || command -v gtimeout 2>/dev/null \
    || {
        for candidate in \
            "/opt/homebrew/bin/timeout" \
            "/opt/homebrew/bin/gtimeout" \
            "/usr/local/bin/timeout" \
            "/usr/local/bin/gtimeout"
        do
            [[ -x "$candidate" ]] && { echo "$candidate"; break; }
        done
    } \
    || true
)

# Cache + incident flag default to a single machine-global location (shared vault,
# shared read token → a shared cache is correct and keeps store-secret rotations
# invalidating exactly what reads serve). Override per-agent via env if needed.
SECRET_CACHE="${HERMES_SECRET_CACHE:-$HOME/.config/jarvis/secret-cache.json}"
INCIDENT_FLAG="${HERMES_SECRET_INCIDENT_FLAG:-$HOME/.config/jarvis/1password-service-account-incident.json}"
mkdir -p "$(dirname "$SECRET_CACHE")" "$(dirname "$INCIDENT_FLAG")" 2>/dev/null || true

STALE_CACHE_MAX_AGE_SECONDS="${STALE_SECRET_CACHE_MAX_AGE_SECONDS:-2592000}"
CACHE_FIELD="${FIELD:-credential}"
INCIDENT_REVALIDATE_INTERVAL_SECONDS="${OP_INCIDENT_REVALIDATE_INTERVAL_SECONDS:-300}"

_run_op() {
    if [[ -n "$TIMEOUT_CMD" ]]; then
        "$TIMEOUT_CMD" 5 "$OP_BIN" "$@" < /dev/null 2>/dev/null
    else
        "$OP_BIN" "$@" < /dev/null 2>/dev/null
    fi
}

_incident_probe_due() {
    local _interval="${1:-300}"
    python3 -c '
import os,sys,time
path=sys.argv[1]
interval=int(sys.argv[2])
if not os.path.exists(path):
    sys.exit(0)
sys.exit(0 if time.time() - os.path.getmtime(path) >= interval else 1)
' "$INCIDENT_FLAG" "$_interval" 2>/dev/null
}

_touch_incident_flag() {
    touch "$INCIDENT_FLAG" 2>/dev/null || true
}

_clear_incident_flag() {
    [[ -f "$INCIDENT_FLAG" ]] || return 0
    rm -f "$INCIDENT_FLAG" 2>/dev/null || true
}

_cache_read() {
    local _key="$1"
    local _max_age="${2:-900}"
    python3 -c '
import json,time,sys
try:
    data=json.load(open(sys.argv[1]))
    entry=data.get(sys.argv[2], {})
    max_age=int(sys.argv[3])
    if isinstance(entry, str):
        sys.exit(1)
    if time.time() - entry.get("ts", 0) < max_age:
        print(entry["v"], end="")
    else:
        sys.exit(1)
except Exception:
    sys.exit(1)
' "$SECRET_CACHE" "$_key" "$_max_age" 2>/dev/null
}

_cache_write() {
    local _key="$1" _val="$2"
    echo -n "$_val" | python3 -c '
import json,time,os,sys,tempfile
path=sys.argv[1]
key=sys.argv[2]
val=sys.stdin.read()
try:
    data=json.load(open(path))
except Exception:
    data={}
for existing_key in list(data):
    if isinstance(data[existing_key], str):
        data[existing_key] = {"v": data[existing_key], "ts": 0}
data[key] = {"v": val, "ts": int(time.time())}
os.makedirs(os.path.dirname(path), exist_ok=True)
fd,tmp = tempfile.mkstemp(dir=os.path.dirname(path))
os.write(fd, json.dumps(data).encode())
os.close(fd)
os.chmod(tmp, 0o600)
os.rename(tmp, path)
' "$SECRET_CACHE" "$_key" 2>/dev/null || true
}

_cache_delete() {
    local _key="$1"
    python3 -c '
import json,os,sys,tempfile
path=sys.argv[1]
key=sys.argv[2]
if not os.path.exists(path):
    sys.exit(0)
try:
    data=json.load(open(path))
except Exception:
    data={}
data.pop(key, None)
os.makedirs(os.path.dirname(path), exist_ok=True)
fd,tmp = tempfile.mkstemp(dir=os.path.dirname(path))
os.write(fd, json.dumps(data).encode())
os.close(fd)
os.chmod(tmp, 0o600)
os.rename(tmp, path)
' "$SECRET_CACHE" "$_key" 2>/dev/null || true
}

if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    if [[ -f "$OP_TOKEN_FILE" ]]; then
        export OP_SERVICE_ACCOUNT_TOKEN
        OP_SERVICE_ACCOUNT_TOKEN=$(cat "$OP_TOKEN_FILE")
    elif [[ -f "$OP_TOKEN_FILE_FALLBACK" ]]; then
        export OP_SERVICE_ACCOUNT_TOKEN
        OP_SERVICE_ACCOUNT_TOKEN=$(cat "$OP_TOKEN_FILE_FALLBACK")
    fi
fi

ORIGINAL_OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"

# Headless service-account mode must not inherit Connect auth or desktop-app
# settings, otherwise the CLI can stall while touching app-integrated state
# instead of using the service-account token directly.
if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    unset OP_CONNECT_HOST OP_CONNECT_TOKEN OP_SESSION OP_ACCOUNT
    export OP_LOAD_DESKTOP_APP_SETTINGS="${OP_LOAD_DESKTOP_APP_SETTINGS:-false}"
fi

if [[ "$FLUSH" -eq 1 ]]; then
    _cache_delete "${KEY_NAME}/${CACHE_FIELD}"
fi

if [[ "$FLUSH" -eq 0 ]] && [[ -f "$SECRET_CACHE" ]]; then
    cached=$(_cache_read "${KEY_NAME}/${CACHE_FIELD}") && [[ -n "$cached" ]] && {
        echo "$cached"
        exit 0
    }
fi

if [[ -f "$INCIDENT_FLAG" ]]; then
    incident_probe_due=0
    if [[ "$FLUSH" -eq 1 ]]; then
        incident_probe_due=1
    elif _incident_probe_due "$INCIDENT_REVALIDATE_INTERVAL_SECONDS"; then
        incident_probe_due=1
    fi

    # Keep the circuit breaker, but periodically re-test the live op path so
    # a stale incident flag does not permanently pin the host in cache-only mode.
    if [[ "$incident_probe_due" -eq 1 ]] && [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]] && [[ -x "$OP_BIN" ]] \
        && _run_op whoami --format json >/dev/null; then
        :
    else
        if [[ "$FLUSH" -eq 0 ]] && [[ -f "$SECRET_CACHE" ]]; then
            cached=$(_cache_read "${KEY_NAME}/${CACHE_FIELD}" "$STALE_CACHE_MAX_AGE_SECONDS") && [[ -n "$cached" ]] && {
                echo "$cached"
                exit 0
            }
        fi
        if [[ "$incident_probe_due" -eq 1 ]]; then
            _touch_incident_flag
        fi
        OP_SERVICE_ACCOUNT_TOKEN=""
        OP_SERVICE_ACCOUNT_DISABLED_BY_INCIDENT=1
    fi
fi

_op_auth_ready() {
    [[ -x "$OP_BIN" ]] || return 1
    _run_op whoami --format json >/dev/null
}

_resolve_via_op_current_auth() {
    local value=""
    local item_id=""
    local item_json=""

    if [[ ! -x "$OP_BIN" ]]; then
        return 1
    fi

    if [[ -n "$FIELD" ]]; then
        value=$(_run_op read "op://jarvis-agent/${KEY_NAME}/${FIELD}") && [[ -n "$value" ]] && {
            CACHE_FIELD="$FIELD"
            printf '%s' "$value"
            return 0
        }
        value=$(_run_op item get "$KEY_NAME" --vault jarvis-agent --fields "label=${FIELD}" --reveal) && [[ -n "$value" ]] && {
            CACHE_FIELD="$FIELD"
            printf '%s' "$value"
            return 0
        }
    else
        for try_field in credential password; do
            value=$(_run_op read "op://jarvis-agent/${KEY_NAME}/${try_field}") && [[ -n "$value" ]] && {
                CACHE_FIELD="$try_field"
                printf '%s' "$value"
                return 0
            }
        done
        value=$(_run_op item get "$KEY_NAME" --vault jarvis-agent --fields type=CONCEALED --format json \
            | python3 -c 'import sys,json; data=json.load(sys.stdin); print(data["value"] if isinstance(data,dict) else data[0]["value"])' 2>/dev/null) && [[ -n "$value" ]] && {
            CACHE_FIELD="concealed"
            printf '%s' "$value"
            return 0
        }
    fi

    item_id=$(_run_op item list --vault jarvis-agent --format json \
        | python3 -c 'import json,sys; items=json.load(sys.stdin); target=sys.argv[1];
for item in items:
    if (item.get("title") or "") == target:
        print(item.get("id") or "", end="")
        break' "$KEY_NAME" 2>/dev/null) || true

    [[ -n "$item_id" ]] || return 1

    item_json=$(_run_op item get "$item_id" --vault jarvis-agent --format json) || return 1
    value=$(printf '%s' "$item_json" | python3 -c 'import json,sys
obj=json.load(sys.stdin)
want=(sys.argv[1] or "").strip()
fields=obj.get("fields", []) or []

def emit(v):
    if v is None:
        raise SystemExit(1)
    print(v, end="")
    raise SystemExit(0)

if want:
    for f in fields:
        if (f.get("label") or "") == want or (f.get("id") or "") == want:
            emit(f.get("value"))
    raise SystemExit(1)
for preferred in ("credential", "password"):
    for f in fields:
        if (f.get("label") or "") == preferred or (f.get("id") or "") == preferred:
            emit(f.get("value"))
for f in fields:
    if (f.get("type") or "") == "CONCEALED":
        emit(f.get("value"))
for f in fields:
    if f.get("value") not in (None, ""):
        emit(f.get("value"))
raise SystemExit(1)
' "$FIELD" 2>/dev/null) && [[ -n "$value" ]] && {
        if [[ -n "$FIELD" ]]; then
            CACHE_FIELD="$FIELD"
        else
            CACHE_FIELD="resolved"
        fi
        printf '%s' "$value"
        return 0
    }

    return 1
}

if [[ -x "$OP_BIN" ]] && [[ -z "${OP_SERVICE_ACCOUNT_DISABLED_BY_INCIDENT:-}" ]]; then
    op_auth_succeeded=0
    op_service_account_auth_failed=0
    skip_desktop_app_fallback=0

    if _op_auth_ready; then
        op_auth_succeeded=1
        value=$(_resolve_via_op_current_auth) && [[ -n "$value" ]] && {
            _cache_write "${KEY_NAME}/${CACHE_FIELD}" "$value"
            _clear_incident_flag
            echo "$value"
            exit 0
        }
    elif [[ -n "$ORIGINAL_OP_SERVICE_ACCOUNT_TOKEN" ]]; then
        op_service_account_auth_failed=1
        skip_desktop_app_fallback=1
    fi

    if [[ -n "$ORIGINAL_OP_SERVICE_ACCOUNT_TOKEN" ]]; then
        if [[ "$skip_desktop_app_fallback" -eq 0 ]]; then
            unset OP_SERVICE_ACCOUNT_TOKEN
            if _op_auth_ready; then
                op_auth_succeeded=1
                value=$(_resolve_via_op_current_auth) && [[ -n "$value" ]] && {
                    _cache_write "${KEY_NAME}/${CACHE_FIELD}" "$value"
                    _clear_incident_flag
                    echo "$value"
                    exit 0
                }
            fi
            export OP_SERVICE_ACCOUNT_TOKEN="$ORIGINAL_OP_SERVICE_ACCOUNT_TOKEN"
        fi
    fi

    if [[ "$op_service_account_auth_failed" -eq 1 ]] && [[ "$op_auth_succeeded" -eq 0 ]]; then
        _touch_incident_flag
    fi
fi

value=$(security find-generic-password -a "hermes" -s "$KEY_NAME" -w 2>/dev/null) && {
    _cache_write "${KEY_NAME}/${CACHE_FIELD}" "$value"
    echo "$value"
    exit 0
}

if [[ -n "$ENV_FILE" ]] && [[ -f "$ENV_FILE" ]]; then
    value=$(grep "^${KEY_NAME}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2-) && [[ -n "$value" ]] && {
        _cache_write "${KEY_NAME}/${CACHE_FIELD}" "$value"
        echo "$value"
        exit 0
    }
fi

echo "ERROR: Secret '$KEY_NAME' not found in any source (1Password/Keychain/profile .env)" >&2
exit 1
