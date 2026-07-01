---
name: meeting-ingestion
version: 1.6.1
description: |
  Ingest meeting transcripts into brain pages with attendee enrichment, entity
  propagation, and timeline merge. A meeting is NOT fully ingested until the
  enrich skill has processed every entity.
triggers:
  - "meeting transcript"
  - "process this meeting"
  - "meeting notes"
  - meeting transcript received
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - people/
  - companies/
---

# Meeting Ingestion Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- **Idempotent**: a meeting already ingested is detected and SKIPPED (Phase 0), never duplicated or overwritten — safe to re-point at the same corpus
- Meeting page created with attendees, summary, key decisions, action items
- EVERY attendee gets a people page (created or updated)
- EVERY company discussed gets entity propagation
- Timeline entries on all material entities discussed in the meeting (timeline merge)
- Meeting is NOT fully ingested until enrich runs for every attendee and
  materially discussed entity that needs propagation
- Back-links created bidirectionally
- **Verified**: a meeting is NOT "done" until the Phase 7 QA gate AND a cache-busted before/after `/query` back-test both pass (structure, edges, traversal). "Looks fine" is not a gate.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.
> **Convention:** See `skills/conventions/graph-safe-writing.md` for the
> cross-skill rule that wikilinks/slug paths are graph evidence, not decoration.
> **Convention:** See `skills/conventions/post-run-retrieval-gate.md`; the
> Phase 7 query back-test is this skill's mandatory retrieval gate.

Every attendee and every materially discussed company/project/concept MUST get a
back-link from its page to the meeting page. Passing names in transcript noise or
context-only examples stay plain prose unless they need entity propagation.

> **Deployment config (read FIRST).** This skill is brain-portable. The method and
> conventions — source routing, the timeline-CAP concept (the owner + recurring
> internal team keep the forward `attended` edge but drop the reverse per-meeting
> timeline line so their pages don't balloon), enrichment depth, the edge model, and
> entity/dedup rules — live in `references/doctrine.md` next to this skill. Read it
> first. This brain's specific VALUES (which slugs are capped, the source name, the
> repo + binary paths) are supplied by the deploying agent at run time via env
> (`BRAIN_DIR`, `GBRAIN_SOURCE`, `GBRAIN_BIN`, `EXEMPT_PAGES`) — those carry real
> names, so they stay out of this shipped reference.

**House style (edges + citations) — load-bearing:**
- **Bare wikilinks** `[[people/<slug>]]`, not piped `[[people/<slug>|Display]]` (identical edge; bare is the convention).
- **No self-citations in the meeting body** — the meeting page IS the source; provenance is the `id:` frontmatter + the transcript below the line.
- **Entity-page source model:** edges/back-links provide traversal and source-set traceability; inline citations provide claim-level provenance. On people/company/project pages enriched from a meeting, cite/link the meeting in the dated `## Timeline` entry and avoid a top-of-page source note or repeated per-bullet `[Source: Meeting ...]` wallpaper. Use inline citations only for claims where source ambiguity, authority, conflict, sensitivity, dates, numbers, contact fields, or cross-source synthesis require claim-level proof.
- **Never write a slug PATH (`people/x`, `companies/x`, `contracts/x`) in body PROSE** — only inside the attendee `[[people/x]]` links. FS-path extraction turns a bare path in prose into a real (false) edge; in prose use display NAMES.
- **Wikilink ONLY actual attendees** in the body; people merely mentioned go in a `**Mentioned**` line, by name.
- **DEDUP by date, not title**: a different DATE = a different meeting even with an identical title (recurring "Monday Meeting" / "tailored-sync" / weekly syncs). Only collapse a SAME-DATE + SAME-PARTICIPANT dup-pair (two recorder ids of one call); note the sibling id in body provenance, never `delete` a distinct meeting.

## Phases

### Phase 0: Idempotency — skip if already ingested (MANDATORY, run FIRST)

A corpus often contains meetings already in the brain (re-runs, overlapping batches,
Fireflies recording the same call under two recorder ids). Before ANY other work:

1. Compute the target slug `meetings/<YYYY-MM-DD>-<kebab-title>` AND the deterministic
   page **`id: fireflies-<recording_id>`** (see "Minimal frontmatter" below). That `id`
   is the ENGINE's cross-slug dedup hook — `put_page`/import skips a re-ingest of the
   same recording even under a different slug (matched on `frontmatter->>'id'`), so it
   closes the unattended-batch dedup gap on its own.
2. `gbrain get meetings/<slug>` (and `gbrain search "<title> <date>"`). If a page for
   THIS SAME meeting already exists (same date + participants, has a transcript body,
   `status: ingested` or `lean-ingest`) → **STOP. Do not re-ingest or overwrite.**
   Report "already ingested — skipped". Re-ingest ONLY when explicitly asked to
   re-process a specific meeting.
3. If only a thin/dangling prior page exists (e.g. an old `lean-ingest` stub with
   attendee wikilinks but no backing people pages), **RECONCILE** it — fill the gaps,
   never create a second page. Treat same date + duration + participants as ONE meeting
   even if Fireflies gives two recording ids; on a real reconcile only, note the second
   recording id in the body provenance (not as a default frontmatter key).

This makes the skill idempotent: the `id` dedups at the engine, and the slug check +
manual reconcile cover the rare same-meeting-different-recording case. Pointing it at
the same corpus twice is safe.

### Phase 1: Parse the transcript

Extract from the transcript:
- Attendees (names, roles if available)
- Date, time, duration
- Key topics discussed
- Decisions made
- Action items with owners
- Companies and projects mentioned

### Phase 2: Create meeting page

**Minimal frontmatter (write THIS; push everything else to the body):**
```yaml
---
type: meeting
title: {Meeting Title}
date: 'YYYY-MM-DD'
status: ingested              # 'lean-ingest' for a stub; Phase-0 idempotency reads this
id: fireflies-{recording_id}  # deterministic dedup hook (engine-level, cross-slug)
---
```
Frontmatter is stripped before embedding and inert for retrieval; every non-excluded
key is also folded into `content_hash`, so inert/volatile keys (`attendees`,
`duration_min`, `source`, `updated`, …) bust the hash and force needless re-embeds.
**Everything else lives in the body** — the attendee graph comes from body
`[[people/<slug>]]` links (NOT a frontmatter list); duration, source, and summary are
prose. (Model verified against `import-file.ts` content_hash/dedup + `markdown.ts` strip.)

Body:
```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}

## Summary
{3-5 bullet key outcomes}

## Key Decisions
{Decisions with context}

## Action Items
{Tasks with owners and deadlines}

## Discussion Notes
{Structured notes by topic}
```

**Two-layer body (Garry's standard) — REQUIRED; supersedes the bare template above.**
A meeting page has the ANALYSIS layer ABOVE a `---` separator and the FULL DIARIZED
TRANSCRIPT below it (the transcript is the source of truth). A meeting is an immutable
EVENT, so it carries a one-time synthesis at the top — NOT an evolving "Compiled Truth +
State" block (that two-layer Compiled-Truth pattern is for the ENTITY pages: person,
company, deal, project, concept). Shape:

```markdown
# {Title} — {Date}

**Attendees:** {[[people/<slug>]] wikilinks, with (org)} — ATTENDEES ONLY
**Duration:** {N min} · **Source:** Fireflies [Source: Meeting "{Title}", {Date}]

## Crux
{YOUR analysis — what actually matters, what was decided, what was left unsaid. NOT a copy of the AI notes.}

## What changed / Key decisions
## Action items
{owner-attributed}

**Mentioned (not yet filed):** {display NAMES only — never a slug-path like people/x; a bare path mints a false edge via FS-path extraction}

---

## Transcript (diarized — source of truth)
**Speaker:** text …
{optional Fireflies auto-summary appendix, medium-trust}
```

**Entity-page ordering (prevents silently-missing edges) — REQUIRED.** Link extraction only
creates an edge to a page that EXISTS at extraction time. So create each attendee/company
page (Phases 3–4) and THEN re-write the meeting page once more (`put`) so its
`[[people/<slug>]]` resolve and the `attended` edges form. Afterward verify every attendee
in the `**Attendees:**` line has an `attended` edge (no missing, no extra).

### Downstream upgrade note — unresolved attendee/frontmatter check

After every `gbrain put` of the meeting page, inspect `auto_links.unresolved`.
For meeting ingestion, unresolved entries usually mean an attendee page does not
exist yet or a reference cannot resolve.

If unresolved entries exist:
- create/enrich missing people pages when they are real attendees;
- rewrite the meeting page after those pages exist so `attended` edges form;
- rerun the meeting QA gate;
- only accept unresolved entries when explicitly deferred and logged as a gap.

### Phase 3: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `gbrain search "{name}"` — does a people page exist?
2. If NO → create via enrich skill (this is mandatory, not optional)
3. If YES → update compiled truth with meeting context
4. Add a timeline entry IN THE PERSON'S PAGE FILE (under `## Timeline`):
   `- <date> — Attended <meeting-title>… → [[meetings/<slug>]]`, then `gbrain put`.
5. **Capture archetype signals** — when stated or reasonably inferable, record on the
   person's page **where they are from / based in the world** and their **noted
   interests or hobbies** (e.g. `Location / origin:` and `Interests:` lines in compiled
   truth). These signals are what make the enrich pass materially richer downstream;
   capture what the transcript reveals, never invent.

**DO NOT use `gbrain timeline-add` for this (v1.1.0 fix).** That command writes a
DB-only timeline row — it does NOT create the `person → meeting` graph edge and does
NOT appear in the page file, so the Iron-Law back-link is silently missing. The
brain's convention (every page) is a `## Timeline` wikilink in the FILE, which creates
BOTH the edge and the display in one write.

**Attended links:** when the meeting page is written via `gbrain put`, the auto-link
hook types every body wikilink from the meeting as `attended`
(`meeting --attended--> person`). So reference each attendee in the meeting body as
`[[people/<slug>]]` (or `[Name](people/slug)`) — no manual `gbrain link` needed.

**OWNER EXCEPTION — timeline bloat (v1.1.0).** Do NOT add a per-meeting timeline entry
to the BRAIN OWNER's page: the owner attends ~every meeting, so their timeline would
balloon to hundreds of entries. The owner's meetings are already reachable via the
`meeting --attended--> owner` back-links (`gbrain backlinks people/<owner>`). Per
Garry's pattern the owner lives in `USER.md`, not the people graph; if they have a
`people/` page, keep it free of per-meeting entries. Apply the same cap to heavy
internal-team attendees who recur across most meetings.

### Phase 4: Entity propagation (MANDATORY)

For each materially discussed company, project, or concept:
1. Check brain for existing page (reconcile — never clobber a richer existing page;
   for an already-rich page, insert ONE timeline line via a surgical file edit).
2. Create/update as needed.
3. Add a `## Timeline` entry on the ENTITY page (`- <date> — … → [[meetings/<slug>]]`).
4. The entity page links to the meeting (entity → meeting). Done.

**NEVER wikilink a company/contract inside the MEETING body (v1.1.0 fix).** The
auto-link hook types every meeting-body wikilink as `attended`, so `[[companies/X]]`
in a meeting creates a nonsensical `meeting --attended--> company` edge (a company
can't attend). Reference companies/contracts in the meeting body as PLAIN PROSE — the
company is reachable from the meeting transitively via its attendees' `works_at`, and
directly via the company page's own `→ [[meetings/...]]` back-link (step 3).

### Phase 5: Timeline merge

The same event appears on all material entities' timelines — authored as a
`## Timeline` wikilink in EACH entity's page FILE (see Phase 3; NOT `timeline-add`).
If Alice met Bob at Acme Corp, the entry goes on Alice's page, Bob's page, AND Acme
Corp's page. Transcript-only incidental names do not get timeline entries.
EXCEPTION: skip the brain owner / ubiquitous internal attendees (Phase 3
owner-exception) — their meetings are reachable via the `attended` back-links.

### Phase 6: Sync

`gbrain sync` to update the index.

### Phase 7: Verify (MANDATORY) — the gate that makes ingestion rigorous

A meeting is NOT "done" until BOTH checks pass. Skipping this is the #1 way a
meeting silently lands broken (missing attendee edge, over-collapsed dup,
slug-path leak, schema drift) — every one of those was caught here, not by eye.

1. **Run the QA gate** (deterministic, ships with this skill):
   ```bash
   BRAIN_DIR=<brain> GBRAIN_SOURCE=<src> EXEMPT_PAGES="<owner + capped team>" \
     bash skills/meeting-ingestion/scripts/qa-meeting.sh <slug>
   ```
   Exit 0 = clean. It checks frontmatter conformance; two-layer structure; body
   links people-only; the DB `attended` edges MATCH the Attendees line EXACTLY
   (catches BOTH missing and spurious edges); no meeting→company/contract edge;
   reverse backlinks live (unless all attendees are capped); cap respected. FIX
   every FAIL and re-run — never proceed on HAS-FAILURES.

2. **Query back-test (traversal proof).** Run a cache-busted `/query` the meeting
   should answer, BEFORE and AFTER ingest; confirm the meeting + its attendees/
   company now surface and the answer is richer. Use a NOVEL phrasing each time —
   `gbrain query` caches by string similarity (~0.92, TTL 3600s), so the identical
   query replays a stale result. This proves the edges are live + traversable, not
   just that the page exists.

**Bulk runs** add, after the batch: `gbrain extract --stale` + `gbrain embed
--stale`; a dup-scan (same-date meetings sharing a non-capped attendee); and a
corpus normalize (de-pipe wikilinks, strip self-citations). See the brain's
convention doc + `scripts/` for the bulk helpers.

## Output Format

Meeting page created. Report: "Meeting ingested: {N} attendees enriched, {N} entities
updated, {N} action items captured."

## Anti-Patterns

- Creating the meeting page without enriching attendees
- Skipping entity propagation ("I'll do that later")
- Not merging timelines across material entities
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking to all participants
- **Using `gbrain timeline-add` for attendee back-links** — it makes a DB-only row,
  NOT the `person → meeting` edge, and isn't in the file. Author a `## Timeline`
  wikilink in the page file instead.
- **Wikilinking a company/contract in the MEETING body** — creates a spurious
  `meeting --attended--> company` edge. Reference them in prose.
- **Adding a per-meeting timeline entry to the brain owner** (timeline bloat) — their
  meetings are reachable via `attended` back-links.
- **Rewriting/clobbering an already-rich entity page on reconcile** — the autopilot
  enriches pages from other sources (e.g. DMs); insert one timeline line surgically.
