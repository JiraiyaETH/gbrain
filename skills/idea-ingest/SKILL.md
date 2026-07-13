---
name: idea-ingest
version: 1.1.0
description: |
  Ingest links, articles, tweets, and ideas into the brain. Fetch content, save
  to brain with analysis, create author people page, and cross-link. Use when the
  user shares a link or says "read this", "save this", "think about this".
triggers:
  - shares a link or URL
  - "read this"
  - "save this"
  - "think about this"
  - "put this in brain"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - file_upload
mutating: true
writes_pages: true
writes_to:
  - people/
  - concepts/
  - sources/
---

# Idea Ingest Skill

> **Filing rule:** For the path + type of any new page, consult
> `skills/brain-taxonomist/SKILL.md` — the ACTIVE schema pack via `gbrain schema show
> --json`, never a hardcoded directory. `skills/_brain-filing-rules.md` still covers the
> non-pack conventions (back-linking, citations, notability).

## Contract

This skill guarantees:
- Every ingested item has a brain page with genuine analysis (not just a summary)
- The author gets a people page (MANDATORY for anyone whose thinking is worth ingesting)
- Cross-links created bidirectionally for material relationships (source ↔
  author, source ↔ high-signal related entities)
- Raw source preserved for provenance via `gbrain files upload-raw`
- Every fact has an inline `[Source: ...]` citation
- Filing follows primary subject rules (not format-based)

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.
> Before writing relationship frontmatter, run `gbrain schema show --json`, use
> only declared `frontmatter_links` for that page type, and author typed fields
> only for evidenced material relationships. Incidental co-mentions stay as prose
> or weak mentions; create minimal stubs only for material entities that need to
> resolve.
> After write/sync, run `skills/conventions/post-run-retrieval-gate.md`; ingested
> source pages should improve related retrieval without outranking canonical
> person/company/project pages incorrectly.

Every material person/company relationship with a brain page MUST create a
back-link. Incidental names and provenance-only references stay plain prose.
Format: `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`

## Phases

1. **Fetch the content.** Use appropriate tools for the content type (web fetch for articles, API for tweets, PDF reader for documents).

2. **Upload raw source.** Save the fetched content for provenance: `gbrain files upload-raw <file> --page <slug>`

3. **Identify the author — MANDATORY people page.** Anyone whose thinking is worth ingesting is worth tracking.
   - Search brain for existing author page
   - If no page → CREATE ONE. Use a minimal `type` + `title` stub when the
     author is only needed to resolve the material author edge; use compiled
     truth + timeline when there is enough evidence.
   - If page exists → update timeline with this new publication
   - Cross-link both directions

4. **Save to brain.** File by PRIMARY SUBJECT (read `skills/_brain-filing-rules.md`):
   - About a person → `people/`
   - About a company → `companies/`
   - A reusable framework → `concepts/`
   - Raw data dump → `sources/`

   Keep links sparse and intentional. Link the author, primary source, and a
   small set of high-signal related pages. Do not wikilink incidental names
   or provenance slugs in the body; source-only references can stay as
   citation text. Strong typed edges (`advises`, `works_at`, `invested_in`, etc.)
   require clear local evidence, otherwise default to `mentions`.

   **Connective frontmatter (when the pack declares it for this page type):**
   - `relevant_to:` — 2-5 EXISTING brain pages this capture is genuinely ABOUT
     (projects, concepts, ideas, research the idea concerns). These materialize
     `--relevant_to-->` typed edges so a topic query surfaces this capture.
   - `derived_from:` — the 1-2 EXISTING source/prior pages this idea explicitly
     BUILDS ON (the article, tweet, prior concept, or research it grew out of).
     Use only when the lineage is real, not for every co-mention.
   HARD RULES: exact slugs only, and only pages you have actually SEEN exist
   (via `search`); never invent or guess a slug — if unsure a page exists, drop
   it to a body `[[wikilink]]` (a harmless mention) instead. Precision over
   recall: a few right links beat many loose ones. Confirm the field + page type
   is declared in the active pack's `frontmatter_links` before relying on it to
   materialize (e.g. `idea`/`concept`/`source` carry `relevant_to`; `idea`/
   `concept` also carry `derived_from`).

5. **Analyze for the user.** Reply with analysis that connects the content to what the brain knows. Think about:
   - Active projects — is this relevant?
   - Contradictions — does this challenge existing brain knowledge?
   - Connections — does this involve known people/companies?
   - Don't just summarize. Tell the user things they wouldn't have noticed.

6. **Graph receipt.** Inspect `auto_links` from `put_page` and run a focused
   graph readback for the ingested page if it created strong typed edges. Resolve
   or log `auto_links.unresolved` entries before reporting done.

7. **Sync.** `gbrain sync` to update the index.

8. **Retrieval gate.** Run the smoke or entity gate. Verify the source is
   discoverable for its specific topic, related canonical pages still outrank it
   for identity/company queries, and the answer uses the source as evidence
   rather than inventing unsupported conclusions.

## Output Format

```markdown
# {Title} — {Author}

**Source:** {URL}
**Author:** {Author}, {role}
**Published:** {date}
**Ingested:** {date}

## Context
{Why this matters now, connected to brain knowledge}

## Summary
{3-5 bullet core arguments}

## Key Data / Claims
{Specific facts, numbers, quotes}

## Analysis
{How this connects to existing brain knowledge. What's new. What contradicts.}
```

## Anti-Patterns

- Just summarizing without connecting to brain knowledge
- Filing everything in `sources/` (sources is for raw data dumps only)
- Skipping the author people page
- Not cross-linking material entities and relationships
- Ingesting without checking brain first for existing coverage

## Changelog

### v1.1.0 — jiraiya-brain pack v0.4.0
- Made the connective-frontmatter guidance explicit in Phase 4: name
  `relevant_to:` (2-5 existing topic pages the capture is about) and
  `derived_from:` (the 1-2 existing source/prior pages it builds on) with the
  same hard rules used by the dream-cycle writers — exact slugs, seen pages
  only, never invent, precision over recall, and confirm the field is declared
  for the page type in the active pack's `frontmatter_links`. Replaces the prior
  vague "write relationship frontmatter per the pack" note.
