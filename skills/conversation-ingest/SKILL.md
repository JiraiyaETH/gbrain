---
name: conversation-ingest
version: 1.1.1
description: |
  Ingest chat and dialog history (Telegram, iMessage, WhatsApp, Discord, Signal,
  Teams, IRC, Matrix) into the brain as `conversation`-type pages that compound
  with the rest of the system via enrichment. Handles both the inline-posture
  (small/active threads: full transcript in-page below a separator, matching
  the meeting-page standard) and the sidecar posture (bulk/archive history:
  summary in-page, gzipped raw transcript in `.raw/`, index kept clean).
  After the retrieval smoke passes, typed-edge enrichment for substantive
  dialogs is a STANDARD phase (not optional): resolve counterparties, create
  stubs, write structured edges, add timeline rows, re-compile entity pages.
  Scope: chat-and-dialog history only. Meetings → meeting-ingestion.
  Single links/ideas → idea-ingest. Media files → media-ingest.
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

> **MECE boundary.**
> - Structured meetings with an agenda/attendee list → `skills/meeting-ingestion/SKILL.md`
> - Single links, articles, or ideas → `skills/idea-ingest/SKILL.md`
> - Video, audio, PDF, book, screenshot → `skills/media-ingest/SKILL.md`
> - Bulk archive with unknown content type → `skills/cold-start/SKILL.md` for
>   sequencing; return here once the archive is identified as chat exports.
> - This skill handles everything else: chat logs, DMs, group threads, and
>   multi-day dialogs from any messaging platform.

## Contract

This skill guarantees:
- **Idempotent**: re-ingesting a grown dialog is an in-place update, never a
  duplicate page. The peer-based slug + `id:` frontmatter field together form
  the dedup anchor.
- **Anti-clobber by construction**: slugs are derived from stable peer IDs
  (`conversations/telegram-<peer_id>`), not display names. A renamed dialog
  does not produce a new slug.
- **No typed/traversable edges at write time**: no typed graph edges are
  created from raw chat prose. Prose `[[wikilinks]]` in the raw transcript
  are neutralized before import (see Phase 2). `mentions`-type edges from
  the link extractor are acceptable (they are not traversable back-links);
  typed/traversable edges come from enrichment (Phase 6) only.
- **Index hygiene**: bulk/archive transcripts stay out of the search index
  via the sidecar posture; the in-page posture is reserved for small/active
  threads where the transcript is search-relevant.
- **Typed-edge enrichment is STANDARD** (not optional): for every substantive
  dialog, Phase 6 executes counterparty resolution, entity stub creation,
  structured-edge writing, and timeline row insertion. A dialog that has
  passed the Phase 5 smoke but skipped Phase 6 is INCOMPLETE.
- **Verified**: a dialog is not "done" until the Phase 5 retrieval smoke
  passes AND Phase 6 enrichment has executed or been explicitly logged as
  skipped (trivial/one-off contact).

## Phases

### Phase 0: MECE check + idempotency (MANDATORY — run first)

1. **Route check.** Was this recorded by a meeting tool (Zoom, Circleback,
   Granola, Fireflies, Otter) OR does the content have multiple named
   attendees and a session-like structure (agenda, facilitator, formal
   action items with owners)? → route to
   `skills/meeting-ingestion/SKILL.md` instead, regardless of whether
   the meeting had a formal agenda. The meeting-ingestion skill handles
   all recorder transcripts; this skill is for personal chat/DM history
   only. Note: many DMs contain decisions and action items — that alone
   is not a routing signal. Route on "was this a meeting session
   captured by a recorder or structured meeting tool?" When in doubt,
   prefer meeting-ingestion.
   Otherwise continue.

2. **Compute the target slug.** Use a stable peer-based identifier.
   The slug is the FULL page path (including `conversations/` prefix).
   Define two variables to avoid double-path errors in subsequent commands:

   ```
   page_path = conversations/<platform>-<stable-id>[-<period>]
   id_key    = <platform>-<stable-id>[-<period>]   # used in id: frontmatter
   ```

   Platform patterns:
   - Telegram: `page_path=conversations/telegram-<peer_id>`, `id_key=telegram-<peer_id>`
     (numeric ID from the export; `-<period>` suffix for sub-pages,
     e.g. `page_path=conversations/telegram-123456789-2026-q2`).
   - iMessage/SMS: `page_path=conversations/imessage-<phone>` (E.164 without `+`,
     e.g. `conversations/imessage-14155551234`).
   - WhatsApp: `conversations/whatsapp-<normalized-phone>` or
     `conversations/whatsapp-<group-hash>` for groups.
   - Discord: `conversations/discord-<channel-id>`.
   - Signal: `conversations/signal-<uuid>` (from the backup export).
   - Teams: `conversations/teams-<thread-id>`.
   - IRC/Matrix/other: `conversations/<platform>-<stable-channel-id>`.

   All subsequent `gbrain get`, `gbrain put`, `gbrain search`, and sidecar
   commands use `$page_path` — never concatenate `conversations/` again.
   Sidecar: `.raw/${id_key}.json.gz` (NOT `.raw/${page_path}.json.gz`).

   - **Never use display names in slugs** — a renamed contact or channel
     would generate a new slug, leaving the old page orphaned with no
     dedup hook.

3. **Set the `id:` field.** Use `$id_key` (the slug WITHOUT the
   `conversations/` prefix, including any period suffix):
   - Primary page: `id: telegram-123456789`
   - Period sub-page: `id: telegram-123456789-2026-q2`

   The `id:` must be unique per page. `put_page` / import skips writes
   when `frontmatter.id` collides with an existing page — so if every
   sub-page shared `id: telegram-123456789`, only the first sub-page
   would ever be written. If you need to express the parent thread, add
   a `thread_id: telegram-123456789` body metadata line (plain prose,
   not frontmatter — keeps it out of the dedup key).

4. **Idempotency check.**
   ```bash
   gbrain get conversations/<slug> --source default
   gbrain search "<peer-name> <platform>" --source default
   ```
   - If a page already exists for this peer + platform and has a full
     transcript body: **update in place** (see Phase 3 — re-ingest posture).
     Do NOT create a second page.
   - If only a thin stub exists: reconcile (fill missing fields, never
     clobber a richer existing page).
   - If no page exists: proceed to Phase 1.

### Phase 1: Normalize the export

GBrain's conversation parser (`src/core/conversation-parser/builtins.ts`)
recognizes 14 built-in format patterns. Ensure the export is in a
recognized shape before passing it to the parser, or pre-process it into
the canonical inline-date format:

```
**Speaker Name** (YYYY-MM-DD HH:MM AM/PM): message text
```

(This is the `imessage-slack` pattern — the most explicit format, preferred
for pre-processed output because inline dates anchor each line to its exact
date even in multi-day threads.)

**Platform-specific notes:**

| Platform | Built-in pattern id | Common export path |
|---|---|---|
| Telegram (bracket style) | `telegram-bracket` | Settings → Advanced → Export Telegram Data → JSON or TXT |
| Telegram (text export) | `telegram-text-export` | Same export, plain text variant |
| iMessage (gbrain canonical) | `imessage-slack` | Use iExporter / Bulk Media Exporter; reformat to bold-paren-date |
| WhatsApp (ISO locale) | `whatsapp-iso` | Chat → Export Chat → Without Media |
| WhatsApp (US locale) | `whatsapp-us` | Same, locale-dependent format |
| Discord (export tool) | `discord-export` | DiscordChatExporter TXT output |
| Discord (in-app copy) | `discord-classic` | In-app message copy |
| Signal | `signal-export` | signal-cli JSON-to-text render |
| Teams | `teams-export` | Teams chat export (web/desktop) |
| Matrix / Element | `matrix-element` | matrix-archive script |
| IRC (irssi/weechat) | `irc-classic` / `irc-weechat` | Native log files |
| Circleback / Granola / Zoom (elapsed-time format) | `bold-paren-time` | `**Speaker** (HH:MM): text` — ROUTE TO meeting-ingestion instead |
| Circleback / Granola / Zoom (no-timestamp format) | `bold-name-no-time` | `**Speaker:** text` — ROUTE TO meeting-ingestion instead |

**Note on meeting-tool formats:** `bold-paren-time` and `bold-name-no-time`
are included in the parser's built-in set for completeness (they appear in
Circleback/Granola reformatted exports). If the transcript came from a
meeting recorder, route it to `skills/meeting-ingestion/SKILL.md` before
reaching this step — the parser recognizing the format does not mean
this skill is the right one to ingest it.

If the export format is not in the table, pre-process it to `imessage-slack`
shape before import (the inline date removes the "what day was this?" ambiguity
for multi-day threads).

### Phase 2: Safety check — neutralize live edge tokens

**Before writing any page**, scan the raw transcript for two classes of
tokens that gbrain's link extractor treats as graph edges:

```bash
# 1. Wikilinks: [[slug]] or [[dir/slug]] tokens (rg preferred over grep -P on macOS)
rg '\[\[(?!.*#)([^\]]+)\]\]' <export-file> | head -20

# 2. Bare slug paths: prose like `people/alice`, `companies/acme`,
#    `meetings/2026-07-01-foo` — FS-path extraction can mint edges from these
rg '\b(people|companies|meetings|contracts|concepts|ideas|projects|notes|conversations)/[a-z0-9-]+' \
  <export-file> | head -20
```

If either grep returns hits:
- **Refuse to import** the transcript as-is.
- For wikilinks: replace `[[` with `\[\[` (or convert to plain text).
- For bare slug paths in prose: replace with display names
  (e.g. `people/alice` → `Alice`).
- Log the count of neutralized tokens in the ingest report.

Why: `mentions-only` link inference means prose body text is generally safe,
but a raw chat transcript can contain literal `[[wikilink]]` strings (e.g.
someone shared an Obsidian link) OR bare path strings (bots, note references).
Both are recognized by FS-path extraction and would create false typed edges.
The fail-closed rule here (refuse, fix, then import) prevents the class of
mistyping errors documented in the memory file
`telegram-rebuild-and-extract-linktype-bug.md`.

### Phase 3: Determine posture and build the page

Choose between two postures based on dialog size:

#### Inline posture (small / active threads, < 450 KB raw transcript)

Full transcript lives below a `---` separator in the page file. Matches
the two-layer meeting-page standard. Use for active threads where the
full conversation text is search-relevant.

```markdown
---
title: "Conversation with <Peer Name>"
type: conversation
id: <platform>-<peer-id>[-<period>]   # matches $id_key; include period suffix for sub-pages
date: YYYY-MM-DD
# Optional — add for time-only patterns (telegram-bracket, discord-classic,
# matrix-element, irc-*) to avoid UTC-assumed warnings from the parser.
# timezone: America/Los_Angeles
tags:
  - <platform>
  - conversation
participants:
  - <peer-display-name>
  # NOTE: `participants:` is plain inert metadata (display names, no slugs).
  # The conversation type has no frontmatter_links rule for participants,
  # so this field creates NO graph edges. Use it for human readability only.
---

# Conversation with <Peer Name>

**Platform:** <telegram | imessage | whatsapp | ...>
**Participants:** <display names, plain prose — no wikilinks>
**Date range:** YYYY-MM-DD to YYYY-MM-DD
**Message count:** <N>

## Summary
<Derive from the transcript: what the conversation is about, what was
decided or exchanged, and why it matters. Cite only what is evidenced
in the text; mark uncertain inferences explicitly (e.g. "appears to be",
"unclear from context"). Do not fabricate details not present in the
transcript.>

## Relationship
<How the owner knows this person, what the thread represents.>

## Highlights
<3-5 notable moments, decisions, or signals worth surfacing in search.>

---

## Transcript
<full diarized transcript>
```

#### Sidecar posture (bulk / archive history, >= 450 KB raw transcript)

Summary stays in the page file (indexed, searchable). Raw transcript lives
in a gzipped sidecar at `.raw/<slug>.json.gz` — outside the search index
by construction. Use for archive ingestion where bulk transcripts would
otherwise dominate the chunk index.

> **Why sidecar?** When the 2026-07-02 conversation-transcript rollout
> moved 859 conversation pages to summary-in-page + sidecar, the indexed
> chunk count dropped from 12,979 → 987 (conversation chunks) — from 77%
> of the whole index to a negligible share. Recall was preserved and
> precision improved. (See memory: `conversation-transcript-sidecar-rollout`.)

Page file is identical to the inline posture ABOVE the `---` separator,
minus the transcript section. Frontmatter is the same (including the
optional `timezone:` key for time-only formats):

```markdown
---
title: "Conversation with <Peer Name>"
type: conversation
id: <platform>-<peer-id>[-<period>]   # matches $id_key; include period suffix for sub-pages
date: YYYY-MM-DD
# timezone: America/Los_Angeles  # add for time-only patterns
tags:
  - <platform>
  - conversation
participants:
  - <peer-display-name>  # plain metadata, no graph edges
---

# Conversation with <Peer Name>

**Platform:** <telegram | imessage | whatsapp | ...>
**Participants:** <display names>
**Date range:** YYYY-MM-DD to YYYY-MM-DD
**Message count:** <N>
**Raw transcript:** `.raw/<slug>.json.gz` (out of index by construction)

## Summary
<Derive from the transcript: what the conversation covers, what was
exchanged, why it matters. Cite only evidenced facts; mark uncertainty.>

## Relationship
<How the owner knows this person, what the thread represents.>

## Highlights
<3-5 notable moments.>
```

Sidecar write — use `gbrain files upload-raw` as the primary method
(preferred by `_brain-filing-rules.md`; handles size routing and leaves
a `.redirect.yaml` pointer in the brain repo):
```bash
# Preferred: let gbrain route and record the file
gbrain files upload-raw <raw-export-file> \
  --page "$page_path" --type transcript
```

Direct write as fallback (use `$id_key`, NOT `$page_path`, to avoid
writing to `.raw/conversations/telegram-.../...`):
```bash
# Resolve brain root first
BRAIN_ROOT=$(gbrain sources get default --json | jq -r '.local_path')
SIDECAR_PATH="${BRAIN_ROOT}/.raw/${id_key}.json.gz"
gzip -c <raw-export-file> > "$SIDECAR_PATH"
```

#### Re-ingest posture (existing page, grown dialog)

When a dialog grows between ingests (new messages since last run):
1. Read the existing page: `gbrain get conversations/<slug>`.
2. Determine the new message range (last ingested date → now).
3. Update **in place**: rewrite the Summary/Highlights sections; append
   new lines to the inline transcript OR re-gzip the sidecar. Do NOT
   create a new page.
4. Bump `date:` frontmatter to the latest message date.
5. Use `gbrain put conversations/<slug>` to overwrite.

### Phase 4: Write and sync

```bash
# Write the page and capture the JSON response (auto_links is in the PUT response, not GET)
gbrain put conversations/<slug> --source default --json > /tmp/conv-put-receipt.json
cat /tmp/conv-put-receipt.json | jq '.auto_links'

# Index immediately
gbrain sync --no-pull --no-embed
```

**Source routing (apply to ALL commands in this skill):** When running
from `/Users/jarvis/gbrain` (the gbrain source repo), `--source default`
is required on every `get`, `search`, `query`, and `put` call to target
the brain's default source. Omitting it routes to the `gbrain-code`
source (the code index), not the prose brain. Verify with
`gbrain sources list` if uncertain. Note: `gbrain sync` does NOT accept
a `--source` flag — it operates across all sources; the `--no-pull
--no-embed` flags are the correct form.

**auto_links check:** The `put_page` JSON response carries
`auto_links: { created, removed, errors, unresolved }`. Expect
`created=0` or only `mentions`-type edges from a conversation page at
write time. To verify no typed graph edges were created, inspect via
`gbrain backlinks conversations/<slug> --source default` — the result
should be empty at ingest time (mentions edges are not traversable
back-links). If unexpected back-links appear, a live edge token survived
Phase 2 neutralization. Fix the page and re-write.

### Phase 5: Retrieval smoke (MANDATORY)

Two-stage gate. Stage 1 (lexical) must pass immediately after Phase 4 sync.
Stage 2 (semantic) requires embeddings and may need `gbrain embed --stale` first.

**Stage 1 — Lexical (must pass immediately after sync):**
```bash
gbrain search "<peer-display-name>" --source default
```
The conversation page must appear in results. If not:
- Check that `gbrain sync` in Phase 4 completed without error.
- Verify `type: conversation` in the frontmatter (wrong type = mis-shelved).

**Stage 2 — Semantic (pass after embeddings are generated):**
```bash
# If the page is newly created, generate its embeddings first
gbrain embed --stale
# Then verify topic-level retrieval
gbrain query "what have I discussed with <peer-name> about <topic>" --source default
```
Both stages must show the conversation page in top results before the dialog
is considered done. Record `PASS` or `FAIL` with a note in the ingest receipt.

### Phase 6: Typed-edge enrichment hand-off (STANDARD — execute for every substantive dialog)

Raw conversation pages are **edge-free at write time**. Phase 6 is not optional:
after the Phase 5 retrieval smoke passes, execute this sequence for every dialog.
The PRIMARY counterparty of a curated dialog always gets a page (Tier 1, step
6.0) — the upstream attendee rule applied to conversations. Log an explicit skip
(step 6.0) for anything tiered out — silence is not an acceptable substitute.

**Pilot verdict (2026-07-03):** The eval-gated typed-edge pilot concluded with a net
improvement verdict (see `reports/2026-07-03-conversation-pilot-verdict`). Phase 6 is
now a standard ingest phase, not a config-gated experiment.

#### Step 6.0 — Classify: primary counterparty vs discussed entities vs skip

This mirrors upstream meeting-ingestion's tiers (its Phase 3 makes attendee page
creation "mandatory, not optional"; its Phase 4 creates materially-discussed
entities as-needed). The conversation analog:

**Tier 1 — PRIMARY COUNTERPARTY (page creation MANDATORY):** the person (or
persons, for a group) the dialog is *with*. A curated dialog's counterparty is
the attendee-analog — if no `people/` (or `companies/`) page exists, CREATE the
stub (step 6b). The operator's curation of the export IS the substance gate;
do not second-guess it for the primary counterparty. Only exception: bots,
automated systems, and service accounts with no real-world identity.

**Tier 2 — MATERIALLY DISCUSSED entities (create as-needed):** people/companies
the dialog substantively discusses (deals, roles, relationships — not passing
name-drops). Create a stub when the dialog carries real substance about them;
otherwise log the skip.

**Tier 3 — SKIP (log the reason):** bots/service accounts; passing third-party
name-drops with no substance; exchanges that are purely transactional noise
(< 5 messages, no content) — and for such noise dialogs, Tier 1 does not apply
either.

Log skips in the ingest receipt (see Output Format) with a one-line reason.
A missing Phase 6 receipt entry (neither executed nor logged skip) is an
incomplete ingest.

**Group conversations:** List every human participant. Apply steps 6a–6f to
each participant that clears the substantive threshold individually. Do NOT
create `associate_of` edges between all co-participants by default — only write
an edge when the dialog provides specific evidence of a direct relationship.
Avoid N² blanket-edge inflation.

If the dialog is substantive for at least one participant, proceed to step 6a.

#### Step 6a — Resolve the counterparty (brain-first)

Search by name AND known aliases before creating anything new:

```bash
gbrain search "<counterparty name>" --source default
gbrain search "<alias or alternate name>" --source default
gbrain query "who is <counterparty name>" --source default
```

**Identity gaps are data gaps.** If the counterparty cannot be resolved to an
existing brain page, proceed to 6b to create a stub. If the operator later
reveals an alternate identity (e.g. "Alice is actually listed as A. Smith"),
merge the pages and add the alias to `aliases:` frontmatter — do not leave a
parallel stub. An unresolved identity at ingest time is NOT a blocking error:
log it in the ingest receipt, create a thin stub with the known display name,
and mark `aliases: []` as open for later enrichment.

#### Step 6b — Create entity stubs for substantive counterparties

A counterparty warrants a stub if the dialog reveals real substance about them
(their role, company, projects, context). Skip stub creation for trivial or
one-off contacts and log the skip (step 6.0).

**Path and type MUST come from the active schema pack — never hardcode.**
Before creating a stub, consult `skills/brain-taxonomist/SKILL.md` with:
> "I need to file a new [person | company | …] page for <name> — what
> path and type does the active pack assign?"

Do NOT assume `people/<slug>` or `type: person` — use whatever path and
type the taxonomist returns. If the pack has no suitable type for this
entity, log that and defer to a future enrichment pass.

Follow `skills/enrich/SKILL.md` stub conventions for the page body:

```markdown
---
title: "<Full Name>"
type: <pack-assigned-type>
aliases:
  - "<alternate name or handle, if known>"
date: YYYY-MM-DD          # stub creation date
status: stub
---

# <Full Name>

**Source:** Inferred from [[conversations/<slug>]] — stub pending enrichment.

<2-3 sentence summary of what is known from the dialog: role, affiliation,
context. No speculation beyond what the conversation establishes.>

## Compiled Truth

<Same 2-3 sentences as above, formatted as a compiled-truth paragraph.
This section is the rewrite target for future enrichment passes — see step 6f.>
```

Write with `gbrain put <pack-assigned-path> --source default` and sync immediately.

#### Step 6c — Write typed edges via structure only

Typed edges come ONLY from pack `frontmatter_links` fields or explicit
`gbrain link` commands. Never infer edges from prose mentions.

**Before writing ANY edge, verify the edge type is declared in the active
pack:**
```bash
gbrain pack show --json | jq '.frontmatter_links[] | select(.type == "<edge-type>")'
```
If the edge type is not declared, do NOT write it. Log the gap and propose
the edge type as a pack evolution candidate. This is fail-closed: an
undeclared edge type may be silently dropped or misclassified.

Every edge must also be grounded in evidence from the dialog. If you cannot
point to a specific message or passage that establishes the relationship, do
not write the edge.

Common edge patterns (check against active pack before use):

```bash
# works_at: counterparty is employed at a company mentioned in the dialog
gbrain link <entity-path> works_at <company-path> \
  --source default \
  --note "stated in conversations/<dialog-slug> on YYYY-MM-DD"

# associate_of: ongoing DIRECT relationship (not merely co-participants)
gbrain link <entity-path> associate_of <other-entity-path> \
  --source default \
  --note "direct relationship evidenced in conversations/<dialog-slug>"

# relevant_to: entity was a major subject of this conversation (see 6d)
```

Alternatively, write edges via the entity page's frontmatter (preferred when
the pack defines `frontmatter_links` rules for the field):

```yaml
works_at: "[[<company-path>]]"
associate_of:
  - "[[<other-entity-path>]]"
```

After editing frontmatter, sync: `gbrain sync --no-pull --no-embed`.

#### Step 6d — Add `relevant_to` provenance edge

For every entity whose page was meaningfully sourced from this dialog,
write a `relevant_to` edge pointing entity → conversation. The edge is
**directional** (entity is the source, conversation is the target); traversal
from conversation → entity requires following back-links, not the edge
directly.

**Idempotency:** Before writing, check whether the edge already exists to
avoid duplicates on re-ingest:
```bash
gbrain backlinks "$page_path" --source default | grep "<entity-slug>"
```
If the edge exists, skip. If not, write it:
```bash
gbrain link <entity-path> relevant_to "$page_path" \
  --source default \
  --note "dialog is a primary source for this entity's compiled-truth"
```

Write this edge for any entity where the conversation provides non-trivial
biographical, relational, or contextual facts. Skip for entities where the
conversation is only a passing mention.

#### Step 6e — Add one timeline row per entity per meaningful event

On each entity's page, under a `## Timeline` section, add exactly ONE row
per meaningful dateable event surfaced by this dialog. Use bold+pipe format
(the only format `extract timeline` parses):

```markdown
## Timeline
- **YYYY-MM-DD** | <one-line event description> → [[conversations/<slug>]]
```

**Merge protocol (mandatory — do not clobber existing rows):**
1. Re-fetch the entity page fresh: `gbrain get <entity-path> --source default`
2. Locate or create the `## Timeline` section.
3. For each candidate row, check whether a row for the same date AND
   same conversation slug already exists. If yes, skip (idempotent on
   re-ingest). If no, insert in chronological order.
4. Preserve all existing rows exactly — do not reorder, summarize, or
   remove existing timeline entries.
5. Overwrite with `gbrain put <entity-path> --source default`.
6. Re-sync: `gbrain sync --no-pull --no-embed`.

Additional rules:
- **Bold+pipe ONLY.** `- **YYYY-MM-DD** | ...` is the required format.
  Any other format is silently skipped by `extract timeline`.
- **One row per distinct event.** Do not write a row for every mention —
  only for events that would be historically meaningful (first contact,
  a funding announcement, a role change, a decision made together).
- **OWNER EXCEPTION:** Never add per-dialog timeline rows to the brain
  owner's page. The owner's timeline would otherwise accumulate hundreds
  of rows from ordinary messaging history, burying genuinely significant
  events. Owner rows are filed manually for major milestones only.

#### Step 6f — Re-compile entity compiled-truth (never stack)

The compiled-truth section heading is **`## Compiled Truth`** (match exactly;
the enrich skill uses this heading as its rewrite target). Before rewriting,
re-fetch the entity page fresh:

```bash
gbrain get <entity-path> --source default
```

Then rewrite ONLY the `## Compiled Truth` section as a single coherent synthesis
incorporating everything now known (prior compiled-truth + new facts from this
dialog). Do NOT append a new synthesis paragraph below the existing one —
stacking produces contradictions and makes later passes progressively harder.
Re-compile the whole section as a single paragraph, then overwrite with:

```bash
gbrain put <entity-path> --source default
```

For new stubs created in step 6b (which already have a minimal `## Compiled Truth`),
this step is satisfied by the stub write itself — no separate re-fetch needed
unless other steps in this Phase 6 pass added new facts after stub creation.

#### Arm A — Facts extraction (PARKED — do not run)

`extract-conversation-facts` / `conversation_facts_backfill` are PARKED pending
upstream fixes. Structural finding from the 2026-07-03 pilot:

- Facts are written with `visibility='private'`, which strips them from
  search chunks — they are **invisible to hybrid retrieval** by construction.
- The extractor resolves entity slugs by heuristic, not brain-first lookup —
  extracted facts accumulate against unresolved or wrong entity slugs.
- These are upstream-class issues. Running `extract-conversation-facts` or
  enabling `cycle.conversation_facts_backfill` in config will consume budget
  and produce facts that do not surface in search.

**Do not run `extract-conversation-facts` or `conversation_facts_backfill`
until upstream fixes land.** Track at the brain's canonical state page.
The typed-edge workflow in steps 6a–6f is the operative enrichment path.

## Output Format

After each dialog ingested, report:

```
INGESTED: conversations/<slug>
================================
Posture:       <inline | sidecar | re-ingest update>
Platform:      <telegram | imessage | whatsapp | ...>
Date range:    YYYY-MM-DD → YYYY-MM-DD
Messages:      <N>
Sidecar:       <path to .raw/*.json.gz | n/a>
Edge tokens neutralized: <N>
auto_links:    created=<N>, removed=<N>, errors=<N>, unresolved=<N>
               (expect errors=0, unresolved=0; created should be only mention-type if any)
back-links:    <N> (expect 0 at ingest time — typed edges come from enrichment only)
Retrieval smoke: <PASS | FAIL — see note>

Phase 6 enrichment:
  Entities resolved:  <N> (existing brain pages matched)
  Entity stubs created: <N> (list slugs)
  Typed edges created: <N> (list: <source> --<type>--> <target>)
  relevant_to edges:  <N>
  Timeline rows added: <N> (list: <entity-slug> +N rows)
  Phase 6 skipped:   <yes — reason | no>
```

For bulk archive runs, report a batch summary after all dialogs:

```
BATCH COMPLETE
==============
Dialogs ingested:  <N>
Pages created:     <N>
Pages updated:     <N>
Pages skipped (already ingested): <N>
Index chunk delta: <before> → <after> (net <+/- N>)
Retrieval smokes:  <N> PASS / <N> FAIL
Phase 6 enrichment:
  Total entities resolved:   <N>
  Total stubs created:       <N>
  Total typed edges created: <N>
  Total timeline rows added: <N>
  Dialogs skipped (Phase 6): <N> (trivial/one-off contacts)
```

## Anti-Patterns

- **Title-based slugs.** `conversations/alice-johnson` breaks when Alice
  renames herself or changes her display name. Use the stable platform ID
  (`telegram-<peer_id>`, `imessage-<phone>`). A renamed dialog + title slug
  = new slug + same `id:` = `findDuplicatePage` SILENTLY SKIPS the write —
  the page is never updated, never surfaced as a conflict.

- **Importing transcripts wholesale into the search index.** Conversation
  transcripts are dense, repetitive, and high-volume. Indexing them
  verbatim dominates the chunk index (observed: 77% of all chunks from
  conversations before sidecar rollout). Use the sidecar posture for
  archives. Keep the inline posture for small, search-relevant threads only.

- **Trusting prose link inference for typed edges.** `mentions-only` mode
  means prose body wikilinks → `mentions` edges by design, but the fail-
  closed rule in Phase 2 exists because raw export text can contain literal
  `[[slug]]` tokens (Obsidian links, bot output, structured references) that
  FS-path extraction interprets as real typed edges. The mistyping class in
  `telegram-rebuild-and-extract-linktype-bug.md` is exactly this.

- **Bulk `put_page` clobbering richer existing pages.** Before overwriting,
  always read the existing page. A conversation page enriched by a prior
  pass (with synthesized insights, extracted entities, or typed edges) is
  richer than the raw re-import. Merge, don't replace.

- **Running facts extraction (Arm A) despite the PARKED status.** Arm A
  (`extract-conversation-facts`, `conversation_facts_backfill`) produces facts
  with `visibility='private'` that are invisible to hybrid retrieval. Running
  it wastes budget without improving search. See Phase 6 Arm A for the
  upstream issues that must be resolved before enabling it.

- **Using `gbrain timeline-add` for person-conversation back-links.** That
  command writes a DB-only row — it does NOT create the traversable graph
  edge and does NOT appear in the page file. Write a `## Timeline` wikilink
  entry in the person's page file instead (same rule as meeting-ingestion).

- **Skipping Phase 2 on "clean" exports.** Bot messages, automated
  notifications, and shared links in chat can contain `[[slug]]` tokens.
  Always grep before importing.

- **Skipping Phase 6 without logging.** Silence after Phase 5 is not an
  accepted state. Every dialog requires either Phase 6 execution or an
  explicit logged skip with a reason. A dialog that has never compounded
  via typed edges is not compounding with the brain — it is a dead-end page.

- **Stacking compiled-truth sections.** When re-compiling an entity page
  after Phase 6, always rewrite the compiled-truth as a single section.
  Appending a new synthesis below the old one creates contradictions and
  makes the page harder to read and harder to re-enrich. Re-compile, then
  overwrite.

- **Creating typed edges from prose mentions.** The `relevant_to` edge
  in step 6d is written via `gbrain link`, not inferred from wikilinks.
  Even in Phase 6, all typed edges come from explicit structure — never from
  the prose body of the conversation page.

## Tools Used

- `gbrain get <slug>` — check if page exists (idempotency) or re-fetch entity before rewrite
- `gbrain search "<query>"` — find existing conversation or entity pages
- `gbrain query "<question>"` — brain-first counterparty resolution (Phase 6a)
- `gbrain put <slug> --source default` — write conversation page or entity stub/update
- `gbrain link <source> <type> <target> --source default` — write typed edge (Phase 6c, 6d)
- `gbrain sync --no-pull --no-embed` — index new/changed files immediately
- `gbrain embed --stale` — generate embeddings for new pages (batch)
- `gbrain sources list` — verify source routing
- `gbrain backlinks <slug> --source default` — verify no unexpected typed edges at ingest time
- `skills/enrich/SKILL.md` — stub conventions and compiled-truth rewrite protocol (Phase 6b, 6f)
- `extract-conversation-facts` / `conversation_facts_backfill` — PARKED, do not run (Phase 6 Arm A)
