#!/usr/bin/env bash
# ============================================================================
# qa-meeting.sh — STRICT per-meeting QA gate for the meeting-ingestion skill.
# A meeting is NOT "ingested" until this exits 0.
#
# Usage:  qa-meeting.sh <slug>            # slug with or without 'meetings/' prefix
# Env (deployment config — set from the brain's meeting-ingestion doctrine):
#   GBRAIN_BIN     gbrain binary           (default: gbrain on PATH)
#   BRAIN_DIR      brain repo dir          (default: $HOME/brain)
#   GBRAIN_SOURCE  source id               (default: default)
#   EXEMPT_PAGES   space-sep people/<slug> that are timeline-CAPPED — owner +
#                  recurring team: keep the forward `attended` edge, no reverse
#                  timeline line. (default: empty — i.e. no cap)
#
# Gates: file presence; frontmatter conformance (type/title/date/status/id:
# <recorder>); two-layer structure (analysis above ---, transcript below);
# people-only body links; EVERY attendee resolves + (non-exempt) back-links in
# a dated ## Timeline entry; live-DB: page retrievable, attended edges MATCH the
# Attendees line exactly, no meeting->company/contract edge, reverse backlinks
# present (unless all attendees are capped).
#
# NOTE: pipefail + `gbrain | grep -q` SIGPIPEs the live process -> false fail.
# Always capture gbrain output into a var / use here-strings.
# ============================================================================
set -uo pipefail
GB="${GBRAIN_BIN:-gbrain}"
BRAIN="${BRAIN_DIR:-$HOME/brain}"
SRC="${GBRAIN_SOURCE:-default}"
EXEMPT_PAGES="${EXEMPT_PAGES:-}"

raw="${1:?usage: qa-meeting.sh <slug>}"; slug="${raw#meetings/}"; mpath="meetings/$slug"
file="$BRAIN/$mpath.md"; fail=0
P(){ printf '  \033[32mPASS\033[0m %s\n' "$*"; }
F(){ printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
gb(){ "$GB" "$@" --source "$SRC" 2>/dev/null | grep -v "Prepared statements disabled" ; }
is_exempt(){ case " $EXEMPT_PAGES " in *" $1 "*) return 0;; *) return 1;; esac; }

printf '== QA %s ==\n' "$mpath"
if [ -f "$file" ]; then P "file present"; else F "file missing: $file"; printf '== %s: HAS-FAILURES ==\n' "$mpath"; exit 1; fi

fm="$(awk 'NR==1&&/^---$/{f=1;next} f&&/^---$/{exit} f' "$file")"
grep -q '^type: meeting'                   <<<"$fm" && P "fm type=meeting" || F "fm type!=meeting"
grep -q '^title:'                          <<<"$fm" && P "fm title"       || F "fm title missing"
grep -q '^date:'                           <<<"$fm" && P "fm date"        || F "fm date missing"
grep -qE '^status: (ingested|lean-ingest)' <<<"$fm" && P "fm status"      || F "fm status missing/invalid"
grep -qE '^id: '                           <<<"$fm" && P "fm id (dedup hook)" || F "fm 'id:' dedup hook missing"
grep -qE '^(attendees|source|duration_min|fireflies_id):' <<<"$fm" && printf '  \033[33mWARN\033[0m drop inert frontmatter key(s) (belong in body)\n' || P "fm minimal"

body="$(awk 'c>=2{print} /^---$/{c++}' "$file")"
[ "$(grep -cE '^---$' "$file")" -ge 3 ] && P "two-layer --- separator" || F "missing body '---' separator (need >=3)"
grep -qE '^## (Transcript|Full Transcript)' <<<"$body" && P "transcript layer present" || F "no '## Transcript' layer"
grep -qiE '^## .*(crux|summary|analysis|what changed)' <<<"$body" && P "analysis header" || F "no analysis header (## Crux/Summary)"
grep -qiE '^## .*action'   <<<"$body" && P "action items header" || F "no ## Action items header"
grep -qiE '^## .*decision' <<<"$body" && P "decisions header"    || F "no ## Decisions header"

if grep -nE '(\[\[|\]\()(companies|contracts)/' "$file" >/dev/null; then
  F "meeting links company/contract (spurious 'attended' edge):"; grep -nE '(\[\[|\]\()(companies|contracts)/' "$file" | sed 's/^/      /'
else P "no company/contract links (prose-only)"; fi
grep -qE '\[\[people/|\]\(people/' "$file" && P "people links present" || F "no [[people/]] or [..](people/) links in body"

for px in $(grep -oE '(\[\[|\]\()people/[a-z0-9-]+' "$file" | sed -E 's/^(\[\[|\]\()//' | sort -u); do
  pf="$BRAIN/$px.md"
  if [ ! -f "$pf" ]; then F "iron-law: $px page MISSING (dangling link)"; continue; fi
  if is_exempt "$px"; then P "cap-exempt (forward attended edge only): $px"; continue; fi
  if grep -qE "\[\[$mpath\]\]|\]\($mpath\)" "$pf"; then P "iron-law back-link: $px"; else F "iron-law: $px has NO link to $mpath"; fi
  if grep -qE "^- (\*\*)?[0-9]{4}-[0-9]{2}-[0-9]{2}.*(\[\[$mpath\]\]|\]\($mpath\))" "$pf"; then P "timeline entry dated+links: $px"; else F "no dated ## Timeline entry linking $mpath: $px"; fi
done
for ex in $EXEMPT_PAGES; do
  if grep -q "\[\[$mpath\]\]" "$BRAIN/$ex.md" 2>/dev/null; then F "cap: $ex has a per-meeting entry for $mpath (omit — reachable via attended back-links)"; else P "cap respected: $ex"; fi
done

dbpage="$(gb get "$mpath")"; [ -n "$dbpage" ] && P "DB: page retrievable" || F "DB: $mpath not retrievable"
graphjson="$(gb graph "$mpath" --depth 1)"
own="$(printf '%s' "$graphjson" | jq -r --arg s "$mpath" '.[]|select(.slug==$s)|.links[]?|.to_slug+" ("+.link_type+")"' 2>/dev/null)"
bad="$(grep -E '^(companies|contracts)/' <<<"$own" || true)"
[ -z "$bad" ] && P "DB: meeting edges people-only" || { F "DB: meeting has edge to company/contract:"; sed 's/^/      /' <<<"$bad"; }
attline="$(grep -m1 '^\*\*Attendees:\*\*' "$file" | grep -oE 'people/[a-z0-9-]+' | sort -u)"
dbatt="$(printf '%s' "$graphjson" | jq -r --arg s "$mpath" '.[]|select(.slug==$s)|.links[]?|select(.link_type=="attended" and (.to_slug|startswith("people/")))|.to_slug' 2>/dev/null | sort -u)"
miss="$(comm -23 <(printf '%s' "$attline") <(printf '%s' "$dbatt") | grep . || true)"
extra="$(comm -13 <(printf '%s' "$attline") <(printf '%s' "$dbatt") | grep . || true)"
if [ -z "$miss" ] && [ -z "$extra" ] && [ -n "$dbatt" ]; then P "DB: attended edges match Attendees line ($(printf '%s' "$dbatt"|grep -c .))"
else F "DB: attendee/edge mismatch — missing=[$(echo $miss)] spurious=[$(echo $extra)]"; fi
bl="$(gb backlinks "$mpath" | jq -r '[.[]|select(.from_slug|startswith("people/")or startswith("companies/"))]|length' 2>/dev/null || echo 0)"
nc=0; for px in $dbatt; do is_exempt "$px" || { nc=1; break; }; done
if [ "${bl:-0}" -ge 1 ]; then P "DB: $bl incoming entity back-link(s) — traversable"
elif [ "$nc" = 0 ]; then P "DB: all-capped attendees — no reverse back-links expected"
else F "DB: no incoming back-links (a non-capped attendee should reverse-link)"; fi

printf '== %s: %s ==\n' "$mpath" "$( [ $fail -eq 0 ] && echo ALL-PASS || echo HAS-FAILURES )"
exit $fail
