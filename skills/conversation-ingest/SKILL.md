---
name: conversation-ingest
version: 1.0.0
description: |
  Ingest chat and dialog history (Telegram, iMessage, WhatsApp, Discord, Signal,
  Teams, IRC, Matrix) into the brain as `conversation`-type pages that compound
  with the rest of the system via enrichment. Handles both the inline-posture
  (small/active threads: full transcript in-page below a separator, matching
  the meeting-page standard) and the sidecar posture (bulk/archive history:
  summary in-page, gzipped raw transcript in `.raw/`, index kept clean).
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
- **Edge-free at write time**: no typed graph edges are created from raw chat
  prose. Prose `[[wikilinks]]` in the raw transcript are neutralized before
  import (see Phase 2). Typed edges and facts come from enrichment only.
- **Index hygiene**: bulk/archive transcripts stay out of the search index
  via the sidecar posture; the in-page posture is reserved for small/active
  threads where the transcript is search-relevant.
- **Enrichment hand-off documented**: both downstream arms (facts extraction,
  typed-edge synthesis) are stated, gated, and operator-controlled. Neither
  runs by default.
- **Verified**: a dialog is not "done" until the Phase 5 retrieval smoke
  passes — a direct search for the counterparty surfaces the page.

## Phases

### Phase 0: MECE check + idempotency (MANDATORY — run first)

1. **Route check.** Was this recorded by a meeting tool (Zoom, Circleback,
   Granola, Fireflies, Otter) OR does the content have attendees, an
   agenda, decisions, or action items? → route to
   `skills/meeting-ingestion/SKILL.md` instead, regardless of whether
   the meeting had a formal agenda. The meeting-ingestion skill handles
   all recorder transcripts; this skill is for personal chat/DM history
   only. When in doubt, prefer meeting-ingestion.
   Otherwise continue.

2. **Compute the target slug.** Use a stable peer-based identifier:
   - Telegram: `conversations/telegram-<peer_id>` (numeric ID from the
     export; `-<period>` suffix for sub-pages when the dialog is split,
     e.g. `telegram-123456789-2026-q2`).
   - iMessage/SMS: `conversations/imessage-<normalized-phone>` (E.164
     without the `+`, e.g. `imessage-14155551234`).
   - WhatsApp: `conversations/whatsapp-<normalized-phone>` or
     `conversations/whatsapp-<group-hash>` for groups.
   - Discord: `conversations/discord-<channel-id>`.
   - Signal: `conversations/signal-<uuid>` (from the backup export).
   - Teams: `conversations/teams-<thread-id>`.
   - IRC/Matrix/other: `conversations/<platform>-<stable-channel-id>`.
   - **Never use display names in slugs** — a renamed contact or channel
     would generate a new slug, leaving the old page orphaned with no
     dedup hook.

3. **Set the `id:` field.** Use the FULL slug root (including any period
   suffix) as the `id:`:
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
id: <platform>-<peer-id>
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
<Curated 3-5 sentence synthesis of what the conversation is about,
what was decided or exchanged, and why it matters. This is YOUR
analysis, not an AI auto-summary.>

## Relationship
<How you know this person, what the thread represents.>

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
id: <platform>-<peer-id>
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
<Curated synthesis.>

## Relationship
<How you know this person, what the thread represents.>

## Highlights
<3-5 notable moments.>
```

Sidecar write (slug may contain `/`, so mkdir -p is required):
```bash
SIDECAR_PATH="/path/to/brain/.raw/${slug}.json.gz"
mkdir -p "$(dirname "$SIDECAR_PATH")"
gzip -c <raw-export-file> > "$SIDECAR_PATH"
```

Alternative for larger/binary exports: use `gbrain files upload-raw`
(preferred by `_brain-filing-rules.md`) which handles size routing and
leaves a `.redirect.yaml` pointer in the brain repo:
```bash
gbrain files upload-raw <raw-export-file> \
  --page conversations/<slug> --type transcript
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
is required on every `get`, `search`, `query`, `put`, and `sync` call to
target the brain's default source. Omitting it routes to the `gbrain-code`
source (the code index), not the prose brain. Verify with
`gbrain sources list` if uncertain. All `gbrain search`, `gbrain get`,
and `gbrain query` examples below also require `--source default`.

**auto_links check:** The `put_page` JSON response carries
`auto_links: { created, removed, errors, unresolved }`. Expect
`created=0` or only `mentions`-type edges from a conversation page at
write time. To verify no typed graph edges were created, inspect via
`gbrain backlinks conversations/<slug> --source default` — the result
should be empty at ingest time (mentions edges are not traversable
back-links). If unexpected back-links appear, a live edge token survived
Phase 2 neutralization. Fix the page and re-write.

### Phase 5: Retrieval smoke (MANDATORY)

A dialog is not "done" until this gate passes:

```bash
# Search for the counterparty — the page must surface
gbrain search "<peer-display-name>" --source default

# Query for a topic discussed in the highlights (cache-bust with novel phrasing)
gbrain query "what have I discussed with <peer-name> about <topic>" --source default
```

Both must return the new conversation page in the top results. If not:
- Check that the `gbrain sync` in Phase 4 completed without error.
- Verify `type: conversation` in the frontmatter (wrong type = mis-shelved).
- Re-run `gbrain embed --stale` if the page is not yet embedded.

### Phase 6: Enrichment hand-off (config-gated, pilot-pending)

Raw conversation pages are **edge-free by design**. Typed edges and
extracted facts require a separate enrichment pass. Two downstream arms:

#### Arm A — Facts extraction (budget-capped, operator-controlled)

GBrain's `extract-conversation-facts` command runs a 30-minute /
30-message windowed mining pass over conversation pages, inserting
anchor-rich facts into the facts table so long conversations surface in
search. To trigger manually on a single page:

```bash
# Dry run to preview segments + counts (no writes, no spend)
gbrain extract-conversation-facts --source-id default \
  --slug conversations/<slug> --dry-run

# Live run, bounded cost
gbrain extract-conversation-facts --source-id default \
  --slug conversations/<slug> --max-cost-usd 0.50

# Background job (recommended for bulk runs)
gbrain extract-conversation-facts --source-id default \
  --max-cost-usd 5 --background
# → prints job_id; monitor with: gbrain jobs follow <job_id>
```

The autopilot cycle phase `conversation_facts_backfill` triggers this
automatically when `cycle.conversation_facts_backfill.budget_usd > 0`
in config. **Default: disabled** (budget is 0 or absent). Enable only
after reviewing the eval-gated pilot results for your brain.

Note: `--max-cost-usd` is a soft cap under `--workers N` — it can be
exceeded by up to N × per-page-cost since worker reserves aren't
serialized. Use `--workers 1` for exact-ceiling compliance.

#### Arm B — Entity synthesis via enrich skill

For high-value counterparties:
1. Identify the counterparty slug (create a `people/<slug>` page if
   none exists — route to `skills/enrich/SKILL.md`).
2. Run the enrich skill citing the conversation page as a source.
3. Typed edges (`works_at`, `associate_of`, etc.) are written via
   frontmatter structure or explicit `gbrain link`, never from prose.

**Default: manual, per-entity.** Do not run bulk enrich over all
conversation pages without an eval-gated pilot.

**Arm selection:** governed by the operator's pilot results and
`cycle.conversation_facts_backfill` config. Neither arm runs by default.
Document the decision (which arm, which budget, which scope) in the brain's
canonical project/state page (e.g. `projects/gbrain-standup` or whichever
page your schema pack designates for brain-level operational state) before
running at scale.

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
Enrichment:    <pending enrichment hand-off | arm-A scheduled | arm-B queued>
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

- **Running facts extraction unscoped over the whole shelf.** An unscoped
  `conversation-facts-backfill` processes every conversation page at whatever
  token cost the models incur. The 30-message windowing is a rate limiter,
  not a cost cap. Always set `--max-usd` and scope to a specific
  counterparty or date range on first run.

- **Using `gbrain timeline-add` for person-conversation back-links.** That
  command writes a DB-only row — it does NOT create the traversable graph
  edge and does NOT appear in the page file. Write a `## Timeline` wikilink
  entry in the person's page file instead (same rule as meeting-ingestion).

- **Skipping Phase 2 on "clean" exports.** Bot messages, automated
  notifications, and shared links in chat can contain `[[slug]]` tokens.
  Always grep before importing.

## Tools Used

- `gbrain get <slug>` — check if page exists (idempotency)
- `gbrain search "<query>"` — find existing conversation pages
- `gbrain put <slug> --source default` — write page to brain
- `gbrain sync --no-pull --no-embed` — index new/changed files immediately
- `gbrain embed --stale` — generate embeddings for new pages (batch)
- `gbrain sources list` — verify source routing
- `gbrain jobs submit conversation-facts-backfill` — arm-A enrichment (gated)
- `skills/enrich/SKILL.md` — arm-B per-entity enrichment
