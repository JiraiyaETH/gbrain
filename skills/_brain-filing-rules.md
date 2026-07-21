# Brain Filing Rules -- MANDATORY for all skills that write to the brain

## Source of Truth

The **active schema pack** is canonical for file-backed Brain shelves. Use:

```bash
gbrain schema show --json
gbrain schema active
```

`_brain-filing-rules.json` is the machine-readable sidecar used by
`gbrain check-resolvable` to audit skill frontmatter (`writes_pages: true` +
`writes_to:`). It must mirror the active schema pack's file-backed
`page_types[].path_prefixes`, with `sources_dir` kept as the explicit raw-source
exception.

Do not add stale or generic shelves here just because they existed in another
pack. If the active pack changes, update the schema pack first via
`schema-author`, then sync this JSON/MD sidecar and run the gates.

## Current active file-backed shelves

The canonical, always-current shelf table is the **ACTIVE schema pack** itself —
read it via `gbrain schema show --json` (or consult `skills/brain-taxonomist/SKILL.md`,
which reads the same pack as data), with the generated `_brain-filing-rules.json`
sidecar as its machine-readable mirror. Do not hardcode a shelf table here: it drifts
out of date as the pack evolves.

## The Rule

The PRIMARY SUBJECT of the content determines where it goes. Not the format,
not the source, not the skill that's running.

## Decision Protocol

1. Identify the primary subject and whether it maps to an active schema type.
2. File in the directory that matches that active schema type.
3. Cross-link from related directories.
4. When in doubt: what would you search for to find this page again?
5. If no active schema type fits, do not invent a shelf. Route to
   `schema-author` / EIIRP schema-check for a proposed pack evolution.

## Common Misfiling Patterns -- DO NOT DO THESE

| Wrong | Right | Why |
|-------|-------|-----|
| Analysis of a topic -> `sources/` | -> appropriate subject directory | `sources/` is for raw/source artifacts only |
| Cron/job backend output -> notification body only | -> `reports/{category}/...` when it is a durable report; otherwise deliver only | Reports and operator messages are different documents |
| Article about a person -> `sources/` | -> `people/` if the primary subject is the person | Primary subject wins |
| Meeting-derived company info -> `meetings/` only | -> ALSO update `companies/` | Entity propagation is mandatory |
| Research about a company -> `sources/` | -> `companies/` or `research/` depending on primary subject | Raw source and synthesized research are different |
| Reusable framework/thesis -> `sources/` | -> `concepts/` | It is a mental model |
| User-authored prose -> `concepts/` or stale `originals/` | -> `writing/` | Authorship is the primary frame |
| Random working tracker -> `projects/` | -> `notes/` unless owner/outcome/active work exists | Projects are active workstreams, not scratch |

## What `sources/` Is Actually For

`sources/` is ONLY for:

- Bulk data imports: API dumps, CSV exports, snapshots.
- Raw data that feeds multiple brain pages, such as guest/contact exports.
- Periodic captures or raw external content where the source artifact itself is
  the primary evidence layer.

If the content has a clear primary subject, it does NOT go in `sources/`.

## Removed / stale shelves

Do not file new pages into these unless the active schema pack explicitly brings
them back:

- `originals/` -> use `writing/`, `concepts/`, `ideas/`, or `notes/`.
- `voice-notes/` -> use `sources/` for raw transcripts or subject shelves for distilled content.
- `media/books/`, `media/articles/`, broad `media/` -> not active in this local schema.
- `deals/`, `analysis/`, `civic/`, `guides/`, `tech/`, `finance/`, `daily/`, `openclaw/` -> old/generic-pack leftovers, not active `jiraiya-brain` shelves.
- `wiki/*` dream-cycle paths -> stale for this pack; use the active shelves in `_brain-filing-rules.json`.

## Cron Brain-Report Contract

Any scheduled job that writes a Brain report must guarantee the page is
well-formed before reporting success.

1. Prefer `gbrain report <category> --dir <brain-dir>` or a native GBrain write
   path so frontmatter and DB import stay coupled.
2. Required minimal report frontmatter:

   ```yaml
   ---
   title: <descriptive, under 60 chars>
   type: report
   category: <stable job/category name>
   date: <YYYY-MM-DD>
   time: <HH:MM TZ>
   ---
   ```

3. Before claiming success, run:

   ```bash
   gbrain frontmatter validate <written-file> --json
   ```

4. One-shot jobs should normally deliver the result rather than write a Brain
   report unless the report itself is the durable artifact.

## Notability Gate

Not everything deserves a Brain page. Before creating a new entity page:

- **People:** Will you interact with them again? Are they relevant to your work?
- **Companies:** Are they relevant to your work or interests?
- **Concepts:** Is this a reusable mental model worth referencing later?
- **Projects:** Is there an owner/outcome/active workstream, not just an idea?

When in doubt, don't create. A missing page can be created later. A junk page
wastes attention and degrades search quality.

## Iron Law: Back-Linking

Every material relationship to a person or company with a Brain page MUST create
a traversable back-link FROM that entity's page TO the page that establishes the
relationship.

Format for back-links:

```markdown
- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- brief context
```

An unlinked material relationship is a broken brain. Dense links for incidental
mentions are also a broken graph: they hide the relationships the graph exists
to retrieve.

## Source Traceability Requirements

Every durable fact written to a Brain page must be traceable to evidence. Inline
`[Source: ...]` citations are one mechanism; dated timeline/back-links, explicit
source edges, and raw source artifact links can also carry provenance.

Use inline `[Source: ...]` when the claim needs claim-level provenance: direct
user statements, contact fields, dates, numbers, commitments, sensitive or
conflicting facts, facts copied from external/API sources, and synthesis across
multiple sources.

Source precedence:

1. User's direct statements.
2. Compiled truth from existing Brain synthesis.
3. Timeline entries / raw evidence.
4. External sources.

When sources conflict, note the contradiction with both citations. Do not
silently pick one.

## Raw Source Preservation

Every ingested item should preserve its raw source when the source artifact is
needed for provenance.

Use native raw-file tooling when available:

```bash
gbrain files upload-raw <file> --page <page-slug> --type <type>
```

Small text/PDF files may stay in the repo as raw sidecars; large media belongs
in configured external storage with a pointer left in the Brain. Do not bloat the
Brain repo with private/bulk media when a distilled index plus external storage
is safer.

## Dream-cycle synthesize / patterns directories

The dream-cycle trusted workspace allow-list lives in
`_brain-filing-rules.json` under `dream_synthesize_paths.globs`. Keep it aligned
with active schema shelves. It should not point at stale `wiki/*` or
`originals/*` paths unless the active schema pack explicitly restores those
shelves.

Machine-generated dream "originals" route to `ideas/dream/` (2026-07-21 operator
ruling), mirroring upstream's deliberate `wiki/originals/ideas/` separation:
the `ideas/` root stays human theses only ("raw possibilities nobody is building
yet"); provenance is visible in the slug at retrieval time. Same `idea` type via
prefix match — no pack change. Do not route dream output to the `ideas/` root.

## Takes attribution

When writing a `<!--- gbrain:takes:begin -->` fence, the **holder** column says
WHO BELIEVES the claim, not who it's ABOUT. Cross-modal eval over production
takes found holder/subject confusion as the core error. These rules are the
contract:

1. **Holder ≠ subject.** Did this person SAY or CLEARLY IMPLY this?
   - YES -> `holder = people/<slug>`
   - NO, it is your analysis OF them -> `holder = brain`
2. **Atomic claims.** Split compound rows into separate rows. One claim per row.
3. **Amplification ≠ endorsement.** A retweet/share-only signal caps at low weight.
4. **Self-reported ≠ verified.** Self-report is an individual signal, not world fact.
5. **No false precision.** Use coarse confidence increments.
6. **"So what" test.** Skip metadata trivia unless it is load-bearing.

Holder format:

- `world` -- consensus fact, no individual claimant.
- `brain` -- AI-inferred, holder genuinely ambiguous.
- `people/<slug>` -- individual's stated belief.
- `companies/<slug>` -- institutional fact, no individual claimant.

Founder-describing-own-company rule: when a founder describes their own company,
the holder is the founder, not the company. Companies do not speak; their people do.
