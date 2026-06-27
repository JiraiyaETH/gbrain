# Meeting-ingestion doctrine (fat reference)

The `SKILL.md` is the thin method; this is the load-bearing detail it defers to.
Portable across brains — it carries the METHOD and the CONCEPTS, never one brain's
real names. The deploying agent supplies this brain's specific values (owner, the
recurring-team cap list, source, paths) at run time via env (see the gate template
below). Where those values live is the brain's call; they are NOT committed here,
because this file ships in the skillpack to downstream installs.

## Routing
- Pass `--source <brain-primary>` on every `gbrain` command (or export `GBRAIN_SOURCE`).
  Running from a code repo's cwd can otherwise resolve to a *code* source and return
  empty results — the #1 footgun. Confirm the source before the first write.
- Pages are write-through on `put` (DB + file). The engine's `Prepared statements
  disabled` stderr line (managed Postgres) is benign.

## Timeline cap (owner + recurring internal team)
High-frequency internal attendees — the owner and the people who attend most internal
syncs — keep the forward `attended` edge (wikilink them in the body) but get **NO
per-meeting reverse timeline line**: across hundreds of meetings their page would
balloon, and their meetings are already reachable via `gbrain backlinks people/<x>`.
- The own-company page: prose only, NO per-meeting timeline entry unless the meeting is
  materially about the company's own build/strategy.
- EXTERNAL attendees (clients, founders, partners, KOLs) get **FULL** per-meeting
  timelines — that is the high-value signal the cap is protecting.

The deploying agent determines who the capped set is for this brain (owner from the
brain's owner doc; recurring team = the internal people who recur) and passes them as
`EXEMPT_PAGES` to the QA gate.

## Enrichment depth (HYBRID — by call type)
- EXTERNAL call (client / founder / partner / KOL) → **FULL**: each non-capped attendee
  and the primary company gets a Compiled-Truth page (one-paragraph exec summary + State
  + What-they-believe + Open threads + `## Contact` + `## Timeline`).
- INTERNAL team sync → **LEAN** (thin stub + timeline only).
- The meeting PAGE itself is always full analysis (two-layer body), regardless of type.

## Attendees + entities
- Attendees come from the transcript SPEAKERS (`.speakers` / `.sentences[].speaker_name`),
  NOT the `participants` field (unreliable — frequently only the owner).
- An AI/tool name that appears as a "speaker" is NOT a person — no page.
- Canonical slugs: prefer the short canonical form; dedup against alias variants
  (second email, name-with-surname, handle) BEFORE creating a page.
- **Edge model (decided, do NOT flip): keep `meeting --attended--> person`.** It lets a
  meeting forward-traverse to its attendees, and onward to their company at 2 hops via
  `works_at`. Relational-retrieval depth defaults to 2, so the company is reachable
  without a direct edge. Do NOT mint a direct `meeting --> company` edge (auto-extract
  types every wikilink target in a meeting body as `attended`, so only wikilink PEOPLE
  in the body; companies/contracts go in prose by display name).

## Phase 7 — QA gate invocation (template)
```bash
BRAIN_DIR=<brain-repo>  GBRAIN_SOURCE=<brain-primary> \
GBRAIN_BIN=<path-to-gbrain> \
EXEMPT_PAGES="people/<owner> people/<recurring-team...>" \
bash skills/meeting-ingestion/scripts/qa-meeting.sh <slug>
```
Then a **back-test**: a cache-busted before/after `/query` with NOVEL phrasing each time
(`query` caches by ~0.92 string-similarity for ~3600s, so reusing a phrasing returns the
cached pre-ingest answer and hides the gain). The after-query must show the new meeting
reachable via links/extraction/backlinks — not just keyword presence.

A meeting is not "done" until the gate is GREEN **and** the back-test shows richer intel.
