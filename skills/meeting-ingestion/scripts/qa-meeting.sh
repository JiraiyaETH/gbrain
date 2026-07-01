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
#                  recurring team: keep the typed `attended` edge, no
#                  timeline line. (default: empty — i.e. no cap)
#
# Gates: file presence; frontmatter conformance (type/title/date/status/id:
# <recorder>); two-layer structure (analysis above ---, transcript below);
# attendees frontmatter; no body entity links; EVERY resolved attendee has
# (non-exempt) back-links in a dated ## Timeline entry; live-DB: page retrievable,
# incoming attended backlinks are person-only, no meeting->company/contract edge,
# reverse backlinks present (unless all attendees are capped).
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
W(){ printf '  \033[33mWARN\033[0m %s\n' "$*"; }
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
grep -qE '^attendees:'                     <<<"$fm" && P "fm attendees (typed edge source)" || F "fm attendees missing"
grep -qE '^(source|duration_min|fireflies_id):' <<<"$fm" && printf '  \033[33mWARN\033[0m drop inert frontmatter key(s) (belong in body)\n' || P "fm typed/minimal"
mtitle="$(awk '/^title:/{sub(/^title:[[:space:]]*/,""); gsub(/^['\''\"]|['\''\"]$/,"",$0); print; exit}' <<<"$fm")"
mdate="$(awk '/^date:/{sub(/^date:[[:space:]]*/,""); gsub(/^['\''\"]|['\''\"]$/,"",$0); print; exit}' <<<"$fm")"
msource="[Source: Meeting \"$mtitle\", $mdate]"

body="$(awk 'c>=2{print} /^---$/{c++}' "$file")"
[ "$(grep -cE '^---$' "$file")" -ge 3 ] && P "two-layer --- separator" || F "missing body '---' separator (need >=3)"
grep -qE '^## (Transcript|Full Transcript)' <<<"$body" && P "transcript layer present" || F "no '## Transcript' layer"
grep -qiE '^## .*(crux|summary|analysis|what changed)' <<<"$body" && P "analysis header" || F "no analysis header (## Crux/Summary)"
grep -qiE '^## .*action'   <<<"$body" && P "action items header" || F "no ## Action items header"
grep -qiE '^## .*decision' <<<"$body" && P "decisions header"    || F "no ## Decisions header"

if grep -nE '(\[\[|\]\()(companies|contracts)/' "$file" >/dev/null; then
  F "meeting links company/contract (spurious 'attended' edge):"; grep -nE '(\[\[|\]\()(companies|contracts)/' "$file" | sed 's/^/      /'
else P "no company/contract links (prose-only)"; fi
if grep -nE '\[\[people/|\]\(people/' "$file" >/dev/null; then
  F "meeting body links people; attendees belong in frontmatter:"; grep -nE '\[\[people/|\]\(people/' "$file" | sed 's/^/      /'
else P "no body people links (attendees frontmatter-driven)"; fi

dbpage="$(gb get "$mpath")"; [ -n "$dbpage" ] && P "DB: page retrievable" || F "DB: $mpath not retrievable"
graphjson="$(gb graph "$mpath" --depth 1)"
own="$(printf '%s' "$graphjson" | jq -r --arg s "$mpath" '.[]|select(.slug==$s)|.links[]?|.to_slug+" ("+.link_type+")"' 2>/dev/null)"
bad="$(grep -E '^(people|companies|contracts)/' <<<"$own" || true)"
[ -z "$bad" ] && P "DB: no outgoing meeting entity edges" || { F "DB: meeting has outgoing entity edge(s):"; sed 's/^/      /' <<<"$bad"; }
bljson="$(gb backlinks "$mpath")"
dbatt="$(printf '%s' "$bljson" | jq -r '.[]?|select(.link_type=="attended" and (.from_slug|startswith("people/")))|.from_slug' 2>/dev/null | sort -u)"
badatt="$(printf '%s' "$bljson" | jq -r '.[]?|select(.link_type=="attended" and ((.from_slug|startswith("people/"))|not))|.from_slug+" ("+.link_type+")"' 2>/dev/null | sort -u)"
[ -z "$badatt" ] && P "DB: attended backlinks people-only" || { F "DB: non-person attended backlink(s):"; sed 's/^/      /' <<<"$badatt"; }
fm_att_count="$(awk '
  /^attendees:[[:space:]]*$/ {in_att=1; next}
  in_att && /^[^[:space:]-][^:]*:/ {exit}
  in_att && /^[[:space:]]*-[[:space:]]*/ {c++}
  END {print c+0}
' <<<"$fm")"
dbatt_count="$(printf '%s' "$dbatt" | grep -c . || true)"
if [ "${fm_att_count:-0}" -gt 0 ] && [ "$dbatt_count" -eq "${fm_att_count:-0}" ]; then
  P "DB: attended backlinks count matches frontmatter ($dbatt_count)"
else
  F "DB: attendee/frontmatter mismatch — frontmatter=${fm_att_count:-0} resolved_backlinks=$dbatt_count"
fi

for px in $dbatt; do
  pf="$BRAIN/$px.md"
  if [ ! -f "$pf" ]; then F "iron-law: $px page MISSING (dangling link)"; continue; fi
  if grep -qE '^_Source note: unless otherwise noted, this page is derived from ' "$pf"; then
    F "entity source model: $px has top-of-page source note (use timeline/back-link + claim-level citations instead)"
  fi
  meeting_cite_count="$(awk -v pat="$msource" 'BEGIN{c=0} /^<!-- timeline -->/{exit} index($0, pat)>0{c++} END{print c+0}' "$pf")"
  if [ "${meeting_cite_count:-0}" -gt 1 ]; then
    W "entity source model: $px has $meeting_cite_count pre-timeline meeting citations; check for citation wallpaper"
  else
    P "entity source model sane: $px"
  fi
  if is_exempt "$px"; then P "cap-exempt (forward attended edge only): $px"; continue; fi
  if grep -qE "\[\[$mpath\]\]|\]\($mpath\)" "$pf"; then P "iron-law back-link: $px"; else F "iron-law: $px has NO link to $mpath"; fi
  if grep -qE "^- (\*\*)?[0-9]{4}-[0-9]{2}-[0-9]{2}.*(\[\[$mpath\]\]|\]\($mpath\))" "$pf"; then P "timeline entry dated+links: $px"; else F "no dated ## Timeline entry linking $mpath: $px"; fi
done
for ex in $EXEMPT_PAGES; do
  if grep -q "\[\[$mpath\]\]" "$BRAIN/$ex.md" 2>/dev/null; then F "cap: $ex has a per-meeting entry for $mpath (omit — reachable via attended back-links)"; else P "cap respected: $ex"; fi
done
bl="$(printf '%s' "$bljson" | jq -r '[.[]|select(.from_slug|startswith("people/")or startswith("companies/"))]|length' 2>/dev/null || echo 0)"
nc=0; for px in $dbatt; do is_exempt "$px" || { nc=1; break; }; done
if [ "${bl:-0}" -ge 1 ]; then P "DB: $bl incoming entity back-link(s) — traversable"
elif [ "$nc" = 0 ]; then P "DB: all-capped attendees — no reverse back-links expected"
else F "DB: no incoming back-links (a non-capped attendee should reverse-link)"; fi

printf '== %s: %s ==\n' "$mpath" "$( [ $fail -eq 0 ] && echo ALL-PASS || echo HAS-FAILURES )"
exit $fail
