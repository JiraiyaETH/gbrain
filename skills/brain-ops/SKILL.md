---
name: brain-ops
version: 1.0.1
description: |
  Brain knowledge base operations. The core read/write cycle: brain-first lookup,
  read-enrich-write loop, source attribution, ambient enrichment, back-linking.
  Read this before any brain interaction.
triggers:
  - any brain read/write/lookup/citation
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - get_backlinks
  - sync_brain
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/

x-session-reference-notes:
  - references/scoped-gbrain-health-log-sync-extract-2026-06-26.md
  - deals/
  - concepts/
  - meetings/
---

# Brain Operations — The Ambient Context Layer

The brain is not an archive. It is a live context membrane that every interaction
flows through in both directions.

> **Convention:** See `skills/conventions/brain-first.md` for the 5-step lookup protocol.
> **Convention:** See `skills/conventions/quality.md` for citation and back-link rules.
> See `skills/conventions/graph-safe-writing.md` before any Brain write that can
> create links or typed edges.

## Contract

This skill guarantees:
- Brain is checked BEFORE any external API call (brain-first lookup)
- Every inbound signal triggers the READ → ENRICH → WRITE loop
- Every outbound response checks brain for relevant context
- Source attribution on every fact written (inline `[Source: ...]` citations)
- User's direct statements are highest-authority data
- Back-links maintained on every brain write (Iron Law)

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/conventions/quality.md` for format.

> **Downstream upgrade note — auto-link Iron Law qualification**
> Auto-link satisfies the Iron Law for ordinary entity-reference links on every
> `put_page`: the agent's job is to include resolvable page references in
> markdown/frontmatter and verify the `auto_links` response. Manual `gbrain link`
> / `add_link` calls are reserved for relationships that cannot be expressed in
> page content, or for explicit repair/backfill work.

## Phases

### Phase 1: Brain-First Lookup (MANDATORY)

Before using ANY external API to research a person, company, or topic:

1. `gbrain search "name"` — keyword search for existing pages
2. `gbrain query "natural question about name"` — hybrid search for context
3. `gbrain get <slug>` — if you know the slug, read the full page
4. Check backlinks: who references this entity?
5. Check timeline: recent events involving this entity

The brain almost always has something. External APIs fill gaps, not start from scratch.

### Phase 2: On Every Inbound Signal (READ → ENRICH → WRITE)

Every message, meeting, email, or conversation that references a person or company:

1. **Detect entities** — people, companies, deals mentioned
2. **Load brain pages** — read existing pages for context before responding
3. **Identify new information** — what does this signal tell us that the page doesn't know?
4. **Write it back** — update the brain page with new info + timeline entry + source citation
5. **Create if missing** — if notable and no page exists, create via enrich skill

**User's direct statements are the highest-value data source.** Write them to brain
pages immediately with attribution `[Source: User, YYYY-MM-DD]`.

### Phase 2.5: Structured Graph Updates (automatic)

Every `put_page` call automatically extracts entity references and writes them
to the graph (`links` table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

**Graph-safe writing gate:** auto-link is useful only when page text is clean
graph evidence. Before writing, decide the intended edge budget. Use wikilinks,
markdown entity links, slug paths, and relationship-shaped frontmatter only when
the resulting edge should exist. If the relationship is contextual or uncertain,
prefer `mentions` / `relates_to`; if it is provenance-only, keep it as citation
text unless traversal to that exact page is intended.

- No manual `add_link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- The `put_page` MCP response includes `auto_links: { created, removed, errors }`
  so the agent can verify outcomes.
- Inspect `auto_links` after every link-producing write. Resolve or log
  `unresolved`; graph-query high-value pages; repair suspicious edge shapes before
  reporting the write done. See `skills/conventions/graph-safe-writing.md`.
- To disable: `gbrain config set auto_link false`. Default is on.
- Timeline entries with specific dates still need explicit `gbrain timeline-add`
  (or batch via `gbrain extract timeline --source db`).

### Phase 3: On Every Outbound Response (READ → PULL → RESPOND)

Before answering any question about a person, company, or topic:

1. **Check the brain** — read relevant pages
2. **Pull context** — use compiled truth + recent timeline
3. **Respond with context** — the brain makes every answer better

Don't answer from general knowledge when a brain page exists.

### Phase 4: Ambient Enrichment

This is not a special mode. This is the default. Everything the user says is an
ingest event.

- Person mentioned → check brain, create/enrich if needed (spawn background)
- Company mentioned → same
- Link shared → ingest it (delegate to idea-ingest)
- Data shared → delegate to appropriate skill

**Rules:**
- Never interrupt the conversation to do enrichment
- Spawn sub-agents for anything that would slow down the response
- Never announce "I'm enriching the brain" — just do it silently

## Output Format

No separate output. Brain-ops is an always-on behavior layer, not a report generator.
The output is updated brain pages and enriched responses.

## Active planning notes source model

For live personal/project planning pages built directly from the user's current
chat/input, do not litter every checklist bullet with `[Source: User / Telegram]`.
Use a compact `## Source / evidence model` on the project hub naming the active
inputs (operator updates, vendor page, extracted form, etc.) and treat the hub +
linked notes as the current working source of truth. Create or link `sources/`
pages only for durable raw artifacts such as invoices, completed form exports,
signed agreements, vendor PDFs, booking confirmations, or raw guest/contact
exports. This keeps planning notes legible while preserving provenance at the
right layer.

## Cross-source citation format (v0.18.0+)

When a brain has multiple sources (wiki, gstack, yc-media, etc.), every
citation MUST include the source id: `[source-id:slug]`. Example:

> You told me about the retry budget approach — see
> [wiki:topics/resilience] and [gstack:plans/retry-policy] for where
> this came from.

Rules:
- The key is `sources.id` (immutable), never `sources.name` (mutable display).
- Single-source brains still write `[default:slug]` OR may omit the prefix
  for backward compat.
- Every page payload returned by `search`, `query`, `get_page`, `list_pages`
  carries `source_id` — always use it when citing, never guess.

If a search result has `source_id: "gstack"` and `slug: "plans/foo"`,
the citation is `[gstack:plans/foo]`. That's the whole rule.

## Deletion / Purge Protocol

When deleting brain pages from local files and the database, use targeted
soft-delete first and verify each target before any hard purge:

1. Resolve the exact brain/source and exact slugs to delete.
2. Delete each page with the normal delete operation (`gbrain delete <slug>` or
   `delete_page`).
3. Verify each target with `get_page include_deleted=true` before claiming it is
   gone.
4. Remove matching local `.md` files only after the DB delete is confirmed; prune
   only empty local directories.
5. Verify representative deleted slugs with `get_links` and `get_backlinks`;
   deleted-page graph edges should be empty.
6. Treat hard purge as global over matching soft-deleted pages, not scoped to the
   slugs just handled. Use immediate purge only when the user explicitly wants
   permanent deletion and report that global scope.
7. Prove absence with structural checks (`list_pages`, slug-specific `get_page`)
   before using semantic query as an extra smoke test. Semantic query can surface
   unrelated topic-adjacent pages and is not deletion proof by itself.

Before resetting or recreating a brain path, freeze active writers first:
scheduled sync, autopilot, webhooks, ingestion workers, and queued jobs. Record
what was paused and how to reverse it before moving paths or creating a fresh
brain.

## Anti-Patterns

- Answering questions about people/companies without checking the brain first
- Using external APIs before checking the brain
- Writing facts without inline `[Source: ...]` citations
- Blocking the response to do enrichment
- Overwriting user's direct statements with lower-authority sources
- Creating brain pages for non-notable entities
- Renaming or recreating a brain path while scheduled writers, webhooks, or job
  workers can still write into that path or database

## Tools Used

- `search` — keyword search
- `query` — hybrid vector+keyword search
- `get_page` — read a brain page
- `put_page` — create/update brain pages
- `add_link` — cross-reference entities
- `add_timeline_entry` — record events
- `get_backlinks` — check who references an entity
- `sync_brain` — sync changes to the index
