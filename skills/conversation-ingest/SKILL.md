---
name: conversation-ingest
version: 2.0.0
description: |
  Ingest chat and dialog history (Telegram, iMessage, WhatsApp, Discord, Signal,
  Teams, IRC, Matrix) into the brain as `conversation`-type pages. Handles the
  inline posture (small/active threads: full transcript in-page) and the sidecar
  posture (bulk/archive: summary in-page, gzipped raw in `.raw/`). After the
  retrieval smoke passes, typed-edge enrichment for substantive dialogs executes
  as a standard phase. Scope: chat-and-dialog history only. Meetings →
  meeting-ingestion. Single links/ideas → idea-ingest. Media files → media-ingest.
triggers:
  - "ingest telegram dialogs"
  - "import chat history"
  - "conversation ingest"
  - "process iMessage export"
  - "import WhatsApp"
  - "ingest discord export"
  - "import signal messages"
  - "chat history to brain"
  - "ingest my telegram"
  - "process chat export"
  - "import dm history"
tools:
  - exec
  - read
  - write
  - search
  - get_page
  - put_page
mutating: true
writes_pages: true
writes_to:
  - conversations/
---

# Conversation Ingest Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any page.
> Conversations file to `conversations/` under the `conversation` type.

## MECE Boundary

- Structured meetings with agenda/attendees or captured by a meeting recorder → `skills/meeting-ingestion/SKILL.md`
- Single links, articles, or ideas → `skills/idea-ingest/SKILL.md`
- Video, audio, PDF, book, screenshot → `skills/media-ingest/SKILL.md`
- This skill: chat logs, DMs, group threads, multi-day dialogs from any messaging platform.

## Contract

- **Idempotent.** Re-ingesting a grown dialog updates in place — never a duplicate page. The stable peer-ID slug + `id:` frontmatter form the dedup anchor.
- **Anti-clobber by construction.** Slugs derive from stable peer IDs, not display names. A renamed dialog does not produce a new slug.
- **Edge-free at write time.** No typed graph edges are created at ingest. Prose wikilinks in the raw transcript are neutralized before import (Phase 2). `mentions`-type edges from the link extractor are acceptable; typed edges come from Phase 6 only.
- **Index hygiene.** Bulk/archive transcripts stay out of the search index via the sidecar posture; inline posture is reserved for small/active threads.
- **Typed-edge enrichment is STANDARD** (not optional). For every substantive dialog, Phase 6 executes counterparty resolution, stub creation, structured-edge writing, and timeline insertion. A dialog that passed Phase 5 but skipped Phase 6 is incomplete.
- **Verified.** A dialog is done only when the Phase 5 retrieval smoke passes AND Phase 6 has executed or been explicitly logged as skipped.

---

## Phase 0: MECE check + idempotency

**Source reachability check (run first):**
```bash
gbrain sources list   # must show a 'default' source with a local_path
```
If no default source appears, stop and resolve source configuration before writing any pages.

**Route check.** Was this captured by a meeting recorder (Zoom, Circleback, Granola, Fireflies, Otter) OR does it have a session-like structure (multiple named attendees, agenda, formal action items)? → route to `skills/meeting-ingestion/SKILL.md`. DMs that contain decisions or action items are NOT a routing signal — route on "was this a meeting captured by a recorder?" When in doubt, prefer meeting-ingestion.

**Compute the target slug.** Define two variables:

```
page_path = conversations/<platform>-<stable-id>[-<period>]
id_key    = <platform>-<stable-id>[-<period>]   # used in id: frontmatter
```

Platform patterns:

| Platform | page_path pattern |
|---|---|
| Telegram | `conversations/telegram-<peer_id>` (numeric ID from export) |
| iMessage/SMS | `conversations/imessage-<E164-phone-no-plus>` |
| WhatsApp | `conversations/whatsapp-<normalized-phone>` or `whatsapp-<group-hash>` |
| Discord | `conversations/discord-<channel-id>` |
| Signal | `conversations/signal-<uuid>` |
| Teams | `conversations/teams-<thread-id>` |
| IRC/Matrix/other | `conversations/<platform>-<stable-channel-id>` |

Add a `-<period>` suffix (e.g. `-2026-q2`) for oversized dialogs split into sub-pages (use when a single dialog exceeds ~2 MB raw or ~10,000 messages). The primary page (no period suffix) still exists as the canonical stub/index entry; sub-pages carry the full content for their period. Sidecar path: `.raw/${id_key}.json.gz` (use `$id_key`, NOT `$page_path`).

**Set `id:` frontmatter.** Use `$id_key` (slug without `conversations/` prefix, including any period suffix). Each sub-page must have a unique `id:` — a shared id causes the dedup write to skip all but the first. Express the parent thread via a body metadata line `thread_id: <parent-id_key>` (plain prose, not frontmatter).

**Idempotency check.**
```bash
gbrain get conversations/<slug> --source default
gbrain search "<peer-name> <platform>" --source default
```
- Page with full transcript body → **update in place** (Phase 3 re-ingest posture).
- Thin stub → reconcile, fill missing fields, do not clobber.
- No page → proceed to Phase 1.

---

## Phase 1: Normalize the export

The gbrain parser recognizes 14 built-in formats. If the export is not in the table below, pre-process to the canonical `imessage-slack` shape (inline dates remove date-ambiguity for multi-day threads):

```
**Speaker Name** (YYYY-MM-DD HH:MM AM/PM): message text
```

| Platform | Built-in pattern |
|---|---|
| Telegram (bracket style) | `telegram-bracket` | `[Alice] (2026-06-01 10:15:00) hello` |
| Telegram (text export) | `telegram-text-export` | `Alice, [01.06.2026 10:15]` then message on next line |
| iMessage (canonical) | `imessage-slack` |
| WhatsApp (ISO locale) | `whatsapp-iso` |
| WhatsApp (US locale) | `whatsapp-us` |
| Discord (export tool) | `discord-export` |
| Discord (in-app copy) | `discord-classic` |
| Signal | `signal-export` |
| Teams | `teams-export` |
| Matrix/Element | `matrix-element` |
| IRC (irssi/weechat) | `irc-classic` / `irc-weechat` |
| Meeting-recorder formats (`bold-paren-time`, `bold-name-no-time`) | → route to meeting-ingestion |

---

## Phase 2: Neutralize live edge tokens (fail-closed)

**Before writing any page**, scan for tokens that gbrain's link extractor treats as graph edges:

```bash
# Wikilinks
rg '\[\[(?!.*#)([^\]]+)\]\]' <export-file> | head -20

# Bare slug paths (FS-path extraction mints edges from these)
rg '\b(people|companies|meetings|contracts|concepts|ideas|projects|notes|conversations)/[a-z0-9-]+' \
  <export-file> | head -20
```

If either returns hits:
- **Refuse to import** the transcript as-is.
- Wikilinks: replace `[[` with `\[\[` or convert to plain text.
- Bare slug paths: replace with display names (`people/alice` → `Alice`).
- Log the count of neutralized tokens in the ingest receipt.

---

## Phase 3: Determine posture and build the page

### Inline posture (< 450 KB raw transcript)

Full transcript lives below a `---` separator. Use for active threads where the full text is search-relevant.

```markdown
---
title: "Conversation with <Peer Name>"
type: conversation
id: <id_key>
date: YYYY-MM-DD
# timezone: America/Los_Angeles  # add for time-only formats (telegram-bracket, discord-classic, matrix-element, irc-*)
tags:
  - <platform>
  - conversation
participants:
  - <peer-display-name>   # plain metadata, no graph edges — conversation type has no frontmatter_links for participants
---

# Conversation with <Peer Name>

**Platform:** <platform>
**Participants:** <display names, plain prose — no wikilinks>
**Date range:** YYYY-MM-DD to YYYY-MM-DD
**Message count:** <N>

## Summary
<What the conversation is about, what was decided or exchanged, why it matters. Cite only evidenced facts; mark uncertainty explicitly.>

## Relationship
<How the owner knows this person; what the thread represents.>

## Highlights
<3–5 notable moments, decisions, or signals worth surfacing in search.>

---

## Transcript
<full diarized transcript>
```

### Sidecar posture (>= 450 KB raw transcript)

Summary in-page (indexed). Raw transcript in `.raw/<id_key>.json.gz` — out of index by construction. Page is identical to inline posture above the `---` separator, minus the Transcript section; add one metadata line:

```
**Raw transcript:** `.raw/<id_key>.json.gz` (out of index by construction)
```

Write sidecar (preferred — routes and records the file):
```bash
gbrain files upload-raw <raw-export-file> --page "$page_path" --type transcript
```

Direct fallback:
```bash
BRAIN_ROOT=$(gbrain sources get default --json | jq -r '.local_path')
gzip -c <raw-export-file> > "${BRAIN_ROOT}/.raw/${id_key}.json.gz"
```

### Re-ingest posture (existing page, grown dialog)

1. `gbrain get conversations/<slug>` — read the existing page.
2. Determine new message range (last ingested date → now).
3. Update in place: rewrite Summary/Highlights; append to inline transcript or re-gzip sidecar.
4. Bump `date:` to the latest message date.
5. `gbrain put conversations/<slug> --source default` to overwrite.

---

## Phase 4: Write and sync

```bash
gbrain put conversations/<slug> --source default --json > /tmp/conv-put-receipt.json
cat /tmp/conv-put-receipt.json | jq '.auto_links'
gbrain sync --no-pull --no-embed
```

**Source routing:** When running from the gbrain source repo, `--source default` is required on every `get`, `search`, `query`, and `put` call to target the brain's prose source. Omitting it routes to `gbrain-code`. `gbrain sync` does not accept `--source`.

**auto_links check:** Expect `created=0` or only `mentions`-type edges. Verify via `gbrain backlinks conversations/<slug> --source default` — result should be empty at ingest time. Unexpected back-links mean a live edge token survived Phase 2; fix and rewrite.

---

## Phase 5: Retrieval smoke (MANDATORY)

Two-stage gate.

**Stage 1 — Lexical (pass immediately after Phase 4 sync):**
```bash
gbrain search "<peer-display-name>" --source default
```
The conversation page must appear in results. If not: verify `gbrain sync` completed without error; check `type: conversation` in frontmatter.

**Stage 2 — Semantic (pass after embeddings):**
```bash
gbrain embed --stale
gbrain query "what have I discussed with <peer-name> about <topic>" --source default
```

Record `PASS` or `FAIL` with a note in the ingest receipt before proceeding.

---

## Phase 6: Typed-edge enrichment (STANDARD — execute for every substantive dialog)

Raw pages are edge-free at write time. Phase 6 is not optional. Execute the following steps for every dialog after Phase 5 passes.

### Step 6.0 — THREE-TIER classification

**Tier 1 — PRIMARY COUNTERPARTY (page creation MANDATORY).** The person or persons the dialog is *with*. The operator's choice to export/curate this dialog is the substance gate — do not second-guess it for the primary counterparty. Only exceptions: bots, automated systems, service accounts with no real-world identity.

**Tier 2 — MATERIALLY DISCUSSED entities (create as-needed).** People or companies the dialog substantively discusses (deals, roles, relationships) — not passing name-drops.

**Tier 3 — SKIP (log the reason).** Bots/service accounts; passing name-drops with no substance; purely transactional noise (< 5 substantive messages — greetings, delivery confirmations, and one-liners that convey no relational or informational content do not count) — Tier 1 does not apply to noise dialogs either.

Log every skip in the ingest receipt with a one-line reason. A missing Phase 6 receipt entry (neither executed nor logged skip) is an incomplete ingest.

**Group conversations:** Apply steps 6a–6f individually to each participant that clears the substantive threshold. Do NOT create `associate_of` edges between all co-participants by default — write an edge only when the dialog provides specific evidence of a direct relationship.

### Step 6a — Resolve the counterparty (brain-first, fail-closed, RECEIPTED)

Before creating anything, search by name AND all known aliases:

```bash
gbrain search "<counterparty name>" --source default
gbrain search "<handle / @handle / 0x-prefix / display-name variants>" --source default
gbrain query "who is <counterparty name>" --source default
```

Try obvious variants: with/without `0x`, `crypto-`/platform prefixes, handle vs display name, first-name-only. **Record in the ingest receipt: searches run, top-3 hits of each, and — if creating — an explicit one-line justification that none of them is this person.**

If ANY hit is a plausible match (shared handle fragment, same company/deal, same platform id) → treat it as the match: add the new name to `aliases:` and use the EXISTING slug. Never create a parallel page on uncertainty.

If genuinely unresolvable → create a stub (step 6b), log the open identity in the receipt.

**Resolution receipt block (write for every entity, whether matched or created):**
```
resolution:
  entity: "<display name>"
  searches_run:
    - query: "<counterparty name>"   top_hits: ["<slug1>", "<slug2>", "<slug3>"]
    - query: "<handle variant>"      top_hits: []
  outcome: matched_existing | created_stub | deferred
  matched_slug: <slug or null>
  create_justification: "<one-line: why no existing hit is this person>"
```

### Step 6b — Create entity stubs (taxonomist-routed, THIN)

**Path and type from the active schema pack — never hardcode.** Consult `skills/brain-taxonomist/SKILL.md`:
> "I need to file a new [person | company | …] page for <name> — what path and type does the active pack assign?"

Page shape (follow `skills/enrich/SKILL.md` stub conventions):

```markdown
---
title: "<Full Name>"
type: <pack-assigned-type>
aliases:
  - "<alternate name or handle, if known>"
date: YYYY-MM-DD
status: stub
---

# <Full Name>

**Exec summary:** <ONE sentence: role/relationship, sourced from the dialog>. *[Stub from conversation ingest; enrichment pending.]*

**State**
- Role: <one line, or [No data yet]>
- Relationship: <one line, or [No data yet]>

**Contact**
- Handle: <if known, else [No data yet]>

## Timeline
- **YYYY-MM-DD** | <one grounded event line> → [[conversations/<slug>]]
```

A stub carries: identity + relationship + one timeline row + pointer to source. No `## Compiled Truth`, no synthesis, no narrative, no conversation content copied over. Richer content is the enrich skill's job later.

Write: `gbrain put <pack-assigned-path> --source default` then `gbrain sync --no-pull --no-embed`.

### Step 6c — Write typed edges (structure only, pack-validated)

Typed edges come ONLY from pack `frontmatter_links` fields or explicit `gbrain link` commands — never inferred from prose.

Before writing any edge, verify the type is declared in the active pack:
```bash
gbrain pack show --json | jq '.frontmatter_links[] | select(.type == "<edge-type>")'
```
If the command fails or returns no output: halt Phase 6c entirely and log `phase_6c: blocked — pack unavailable or edge type not declared`. Do not fall back to guessing edge types; proceed to step 6d (provenance edge) only if `relevant_to` is a confirmed pack type.

Every edge must be grounded in a specific message or passage. Common patterns (verify against active pack before use):

```bash
gbrain link <entity-path> works_at <company-path> \
  --source default --note "stated in conversations/<slug> on YYYY-MM-DD"

gbrain link <entity-path> associate_of <other-entity-path> \
  --source default --note "direct relationship evidenced in conversations/<slug>"
```

Alternatively, write via frontmatter fields when the pack defines `frontmatter_links` rules for them; sync after: `gbrain sync --no-pull --no-embed`.

### Step 6d — Add `relevant_to` provenance edge

For each entity meaningfully sourced from this dialog, write a directional `relevant_to` edge (entity → conversation).

Check idempotency first:
```bash
gbrain backlinks "$page_path" --source default | grep "<entity-slug>"
```
If it exists, skip. If not:
```bash
gbrain link <entity-path> relevant_to "$page_path" \
  --source default --note "dialog is a primary source for this entity"
```

### Step 6e — Add one timeline row per entity per meaningful event

Bold+pipe format is the only format `extract timeline` parses:

```markdown
## Timeline
- **YYYY-MM-DD** | <one-line event description> → [[conversations/<slug>]]
```

**Merge protocol (mandatory — do not clobber existing rows):**
1. Re-fetch fresh: `gbrain get <entity-path> --source default`
2. For each candidate row, check for an existing row with the same date AND conversation slug. If yes, skip. If no, insert chronologically.
3. Preserve all existing rows exactly — do not reorder, summarize, or remove entries.
4. Overwrite: `gbrain put <entity-path> --source default` → `gbrain sync --no-pull --no-embed`.

Additional rules:
- One row per distinct meaningful event (first contact, funding announcement, role change, joint decision) — not one row per mention.
- **OWNER EXCEPTION:** Never add per-dialog timeline rows to the brain owner's page. Owner timeline rows are for major milestones only, filed manually.

### Step 6f — Re-compile entity compiled-truth (never stack)

Applies only to pre-existing entity pages that already have a `## Compiled Truth` section. Stubs from step 6b are exempt (they get compiled truth from the enrich skill, not here).

1. Re-fetch fresh: `gbrain get <entity-path> --source default`
2. Rewrite the `## Compiled Truth` section as a single coherent synthesis incorporating prior compiled-truth + new facts from this dialog.
3. Overwrite: `gbrain put <entity-path> --source default`

Do NOT append a new paragraph below the existing section — stacking creates contradictions and makes future passes harder.

### Facts arm (PARKED — do not run)

`extract-conversation-facts` and `conversation_facts_backfill` are parked pending upstream fixes: facts are written with `visibility='private'` (invisible to hybrid retrieval by construction), and the extractor resolves entity slugs by heuristic rather than brain-first lookup. Running either command wastes budget without improving search. The typed-edge workflow in steps 6a–6f is the operative enrichment path.

---

## Output Format

After each dialog ingested:

```
INGESTED: conversations/<slug>
================================
Posture:       <inline | sidecar | re-ingest update>
Platform:      <platform>
Date range:    YYYY-MM-DD → YYYY-MM-DD
Messages:      <N>
Sidecar:       <path | n/a>
Edge tokens neutralized: <N>
auto_links:    created=<N>, removed=<N>, errors=<N>, unresolved=<N>
back-links:    <N> (expect 0 at ingest time)
Retrieval smoke: <PASS | FAIL — note>

Phase 6 enrichment:
  Entities resolved:    <N> (existing pages matched)
  Entity stubs created: <N> (list slugs)
  Typed edges created:  <N> (list: <source> --<type>--> <target>)
  relevant_to edges:    <N>
  Timeline rows added:  <N> (list: <entity-slug> +N rows)
  Phase 6 skipped:      <yes — reason | no>
```

For bulk archive runs, append a batch summary after all dialogs:

```
BATCH COMPLETE
==============
Dialogs ingested:  <N>
Pages created:     <N>
Pages updated:     <N>
Pages skipped (already ingested): <N>
Retrieval smokes:  <N> PASS / <N> FAIL
Phase 6:
  Total entities resolved:   <N>
  Total stubs created:       <N>
  Total typed edges created: <N>
  Total timeline rows added: <N>
  Dialogs skipped (Phase 6): <N>
```

---

## Anti-Patterns

- ❌ **Title-based slugs.** `conversations/alice-johnson` breaks on rename — use stable platform IDs (`telegram-<peer_id>`, `imessage-<phone>`).
- ❌ **Indexing bulk transcripts inline.** Conversation transcripts are dense and repetitive; archived at scale they dominate the chunk index. Use sidecar for archives.
- ❌ **Skipping Phase 2 on "clean" exports.** Bot messages and shared links can contain literal `[[slug]]` tokens. Always grep before importing.
- ❌ **Creating an entity page without a recorded resolution attempt.** Name variants (`0x-`, platform prefixes, handles) routinely hide existing pages. The receipted resolution (searches + top-3 hits + justification) is mandatory before any create.
- ❌ **Creating a parallel page on uncertainty.** A plausible match → add alias to existing page. Uncertainty is never a reason to create a second page.
- ❌ **Stubs with compiled truth, narrative, or copied conversation content.** A stub carries identity + relationship + one timeline row + source pointer. Everything richer is the enrich skill's job.
- ❌ **Writing typed edges from prose mentions.** All typed edges — including `relevant_to` — come from explicit structure (frontmatter fields or `gbrain link`), never from inference.
- ❌ **Stacking compiled-truth sections.** Re-compile as a single coherent section; do not append a new paragraph below the old one.
- ❌ **Running facts extraction (Arm A) despite the PARKED status.** Output is invisible to hybrid retrieval. See Phase 6 facts arm.
- ❌ **Skipping Phase 6 without logging.** Silence after Phase 5 is not an accepted state. Every dialog requires either Phase 6 execution or an explicit logged skip with a reason.
- ❌ **Using `gbrain timeline-add` for person-conversation back-links.** That command writes a DB-only row, not a traversable graph edge, and does not appear in the page file. Write a `## Timeline` wikilink entry in the person's page file instead.
- ❌ **Clobbering a richer existing page on re-ingest.** Always re-fetch before overwriting; a page enriched by a prior pass is richer than a raw re-import.

---

## Tools Used

- `gbrain get <slug> --source default` — idempotency check; re-fetch entity before rewrite
- `gbrain search "<query>" --source default` — find existing pages (resolution step 6a)
- `gbrain query "<question>" --source default` — brain-first counterparty resolution
- `gbrain put <slug> --source default --json` — write conversation page or entity stub/update
- `gbrain link <source> <type> <target> --source default` — write typed edge (phases 6c, 6d)
- `gbrain backlinks <slug> --source default` — verify no unexpected typed edges at ingest time
- `gbrain sync --no-pull --no-embed` — index new/changed files immediately
- `gbrain embed --stale` — generate embeddings for new pages (batch)
- `gbrain files upload-raw` — write sidecar (preferred method)
- `gbrain sources list` — verify source routing
- `gbrain pack show --json` — validate edge types against active pack before writing
- `skills/brain-taxonomist/SKILL.md` — path + type for new entity stubs
- `skills/enrich/SKILL.md` — stub conventions and compiled-truth rewrite protocol
