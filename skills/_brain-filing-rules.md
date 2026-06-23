# Brain Filing Rules -- MANDATORY for all skills that write to the brain

## The Rule

The PRIMARY SUBJECT of the content determines where it goes. Not the format,
not the source, not the skill that's running.

## Decision Protocol

1. Identify the primary subject (a person? company? concept? policy issue?)
2. File in the directory that matches the subject
3. Cross-link from related directories
4. When in doubt: what would you search for to find this page again?

## Cron Brain-Report Contract (MANDATORY for any scheduled/cron job that writes a Brain page)

Any cron job — Hermes `cronjob` (jobs.json), gbrain `cron-scheduler`, native CronCreate/schedule, or a `no_agent` script — that writes a page into the Brain (anything under `/Users/jarvis/brain`, especially `reports/`) MUST guarantee the page is well-formed BEFORE it lands. No exceptions, including quiet-on-green jobs whose report write is side-channel only. A page with no opening `---` / bad YAML wedges the autopilot commit phase AND fact extraction (this exact failure happened 2026-06-18).

1. WRITE PATH — prefer `gbrain report <category> --dir /Users/jarvis/brain` (emits valid frontmatter AND imports to the DB), or the `put_page` MCP tool. NEVER hand-append raw markdown into `reports/` via echo/cat/file-write without a frontmatter block.

2. REQUIRED FRONTMATTER on every Brain report page — open with `---` on line 1, close with `---` before the first heading:

       ---
       title: <descriptive, <60 chars>
       type: report          # the reports/ shelf
       category: <job-name / stable category>
       date: <YYYY-MM-DD>
       time: <HH:MM TZ>
       ---

   Single-quote any value containing `: " ' # [ ] { }`; no null bytes; no `slug` field unless it matches the path.

3. SELF-VERIFY AT THE SOURCE (the nip-it-at-the-bud step) — before reporting success, run `gbrain frontmatter validate <written-file> --json` (exit 0 = clean; exit 1 = fix and re-validate, never report done on a dirty page). For `no_agent` scripts this validate call MUST be baked into the script after the write and treated as a hard failure. The brain-repo pre-commit hook (`gbrain frontmatter install-hook`) is the catch-all backstop. When a generator's defect surfaces on one file, validate the WHOLE containing folder and fix every confirmed sibling in one pass — dated cron/report generators often emit several pages sharing the same `MISSING_OPEN`/YAML defect — then re-run folder-level validation. Minimal-frontmatter auto-fix (`title`, `type: report`, `category`, `date`, `time`, modeled on adjacent known-good files) is acceptable for clearly-generated report output once the operator approves; NEVER silently wrap an unfinished human-authored draft in `---`.

4. ROUTING — a cron prompt that writes Brain pages MUST follow `skills/reports/SKILL.md` + `skills/frontmatter-guard/SKILL.md`. Do not inline a malformed template.

5. ONE-SHOT JOBS DON'T REPORT — a one-shot / run-once cron (`schedule.kind` != `cron`, e.g. `once` with a `run_at`, or a `delay`/`at` job) MUST NOT write a Brain `reports/` page at all. Do the task and deliver the result; only RECURRING scheduled jobs produce a durable `reports/` artifact. One-shots are ephemeral — a `reports/` page per run pollutes the shelf and is a needless frontmatter-wedge risk.

## Canonical Top-Level Shelves (this Brain: /Users/jarvis/brain, source `default`)

Use these shelves only. Each is a first-class filing target when it is the primary subject, not an overflow bucket:

- `people/` — humans only.
- `companies/` — companies, protocols, products, vendors, clients, prospects, funds, organizations.
- `projects/` — durable workstreams, initiatives, implementation plans.
- `meetings/` — dated calls, meeting records, transcript-derived meeting pages.
- `sources/` — raw/provider/evidence packets: transcripts, contracts, Telegram/X/web captures, imports.
- `concepts/` — reusable ideas, frameworks, mental models.
- `ideas/` — rough seeds, theses, possibilities not yet hardened.
- `reflections/` — user-originated self-knowledge and decision-pattern notes.
- `dream-cycles/` — Dream maintenance receipts/indexes, not live scheduler state.
- `capabilities/` — system/agent/tool capability cards with boundaries, owner, and live-truth pointers.
- `lessons/` — durable operational lessons that should change future behavior.
- `decisions/` — durable decision records: what was decided, why, evidence, owner, and revisit trigger.
- `reference/` — stable maps, registries, role maps, proof indexes, resolver-like indexes.
- `reports/` — cron/job output artifacts and operational receipts. Full backend detail goes here; Telegram/operator messages remain separate styled summaries.
- `analysis/` — synthesized market, competitive, commercial, technical, and research intelligence. Not raw source dumps.
- `media/` — processed content objects and synthesized reading/listening/watching artifacts.
- `writing/` — Jiraiya/Tailored-authored drafts and posts.
- `food/` and `workout/` — health/coaching operating data, separated from business retrieval.
- `inbox/` — triage only. Not durable truth; resolve and refile before import.

Relationship labels (client, prospect, vendor, TAP member, creator, account owner) are
metadata/links/statuses on `companies/`, `people/`, and `projects/` pages — never shelves.

## Retired Shelves — DO NOT CREATE

`clients/`, `agents/`, `domains/`, `ops/`, `memory/`, `personal/`, `deals/`, `daily/`,
`civic/`, `guides/`, `tech/`, `finance/`, `research/`, `originals/`, `voice-notes/`,
`conversations/`, `openclaw/`, `wiki/`, `tweets/`, `articles/`, and brand roots
(`tailored/`, `bedsy/`, `jarvis/`). Route by primary subject instead: client/prospect
state → `companies/` metadata; agent/fleet maps → `reference/` or `capabilities/`;
domain findings → `analysis/`/`concepts/`; live ops truth stays OUTSIDE the Brain;
personal content → `reflections/`/`food/`/`workout/`/`people/`; chat/voice raw captures
→ `sources/`; research output → `analysis/`; user-originated theses → `ideas/` or
`reflections/`. Corpus governance and the pre-import gate live in
`/Users/jarvis/brain/RESOLVER.md`.

## Common Misfiling Patterns -- DO NOT DO THESE

| Wrong | Right | Why |
|-------|-------|-----|
| Analysis of a topic -> `sources/` | -> appropriate subject directory | sources/ is for raw data only |
| Cron/job backend output -> Telegram body | -> full artifact in `reports/{category}/YYYY-MM-DD-HHMM.md`; styled digest stays separate | Jiraiya never receives raw dumps; report and message are different documents |
| Article about a person -> `sources/` | -> `people/` | Primary subject is a person |
| Meeting-derived company info -> `meetings/` only | -> ALSO update `companies/` | Entity propagation is mandatory |
| Research about a company -> `sources/` | -> `companies/` | Primary subject is a company |
| Reusable framework/thesis -> `sources/` | -> `concepts/` | It's a mental model |
| Tweet thread about a topic -> `media/` | -> `concepts/` or `analysis/` | media/ is for processed content objects, not topical knowledge |

## Sanctioned exception: synthesis output is sui generis

The "file by primary subject" rule is for raw ingest. Synthesized output that
is one-of-one to a single source AND a specific reader (a personalized book
mirror, a strategic-reading playbook tied to one problem) does not fit any
subject directory cleanly: filing by topic loses the "this is the book"
dimension; filing by author muddles authorship pages with synthesis pages.

Format-prefixed paths under `media/<format>/<slug>` are the sanctioned
exception:

- `media/books/<slug>-personalized.md` (book-mirror output)
- `media/articles/<slug>-personalized.md` (long-form article personalization)

If you find yourself wanting `media/<format>/` for raw ingest, that is still
the anti-pattern in the table above. The exception is narrow: synthesized,
one-of-one, sui generis to a single source.

## What `sources/` Is Actually For

`sources/` is ONLY for:
- Bulk data imports (API dumps, CSV exports, snapshots)
- Raw data that feeds multiple brain pages (e.g., a guest export, contact sync)
- Periodic captures (quarterly snapshots, sync exports)

If the content has a clear primary subject (a person, company, concept, policy
issue), it does NOT go in sources/. Period.

## Notability Gate

Not everything deserves a brain page. Before creating a new entity page:
- **People:** Will you interact with them again? Are they relevant to your work?
- **Companies:** Are they relevant to your work or interests?
- **Concepts:** Is this a reusable mental model worth referencing later?
- **When in doubt, DON'T create.** A missing page can be created later.
  A junk page wastes attention and degrades search quality.

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. This is bidirectional:
the new page links to the entity, AND the entity's page links back.

Format for back-links (append to Timeline or See Also):
```
- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- brief context
```

An unlinked mention is a broken brain. The graph is the intelligence.

## Citation Requirements (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

Three formats:
- **Direct attribution:** `[Source: User, {context}, YYYY-MM-DD]`
- **API/external:** `[Source: {provider}, YYYY-MM-DD]` or `[Source: {publication}, {URL}]`
- **Synthesis:** `[Source: compiled from {list of sources}]`

Source precedence (highest to lowest):
1. User's direct statements (highest authority)
2. Compiled truth (pre-existing brain synthesis)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search -- lowest)

When sources conflict, note the contradiction with both citations. Don't
silently pick one.

## Raw Source Preservation

Every ingested item should have its raw source preserved for provenance.

**Size routing (automatic via `gbrain files upload-raw`):**
- **< 100 MB text/PDF**: stays in the brain repo (git-tracked) in a `.raw/`
  sidecar directory alongside the brain page
- **>= 100 MB OR media files** (video, audio, images): uploaded to cloud
  storage (Supabase Storage, S3, etc.) with a `.redirect.yaml` pointer left
  in the brain repo. Files >= 100 MB use TUS resumable upload (6 MB chunks
  with retry) for reliability.

**Upload command:**
```bash
gbrain files upload-raw <file> --page <page-slug> --type <type>
```
Returns JSON: `{storage: "git"}` for small files, `{storage: "supabase", storagePath, reference}` for cloud.

**The `.redirect.yaml` pointer format:**
```yaml
target: supabase://brain-files/page-slug/filename.mp4
bucket: brain-files
storage_path: page-slug/filename.mp4
size: 524288000
size_human: 500 MB
hash: sha256:abc123...
mime: video/mp4
uploaded: 2026-04-11T...
type: transcript
```

**Accessing stored files:**
```bash
gbrain files signed-url <storage-path>    # Generate 1-hour signed URL
gbrain files restore <dir>                # Download back to local
```

This ensures any derived brain page can be traced back to its original source,
and large files don't bloat the git repo.

## Dream-cycle synthesize / patterns directories (v0.23)

The `synthesize` and `patterns` phases of `gbrain dream` write to a configured
allow-list of paths sourced from `_brain-filing-rules.json`'s
`dream_synthesize_paths.globs` array, and their prompt examples come from
`dream_synthesize_paths.routes`. Editing that JSON is the ONLY way to add a new
directory or route template the synthesis subagent may write to:

| Output type | Slug pattern | What goes here |
|-------------|--------------|----------------|
| Reflection | `reflections/YYYY-MM-DD-<topic>` | Self-knowledge, emotional processing, pattern recognition. Verbatim quotes from the user, with analysis. |
| Original idea | `ideas/YYYY-MM-DD-<idea>` | New frames, theses, mental models. Capture the user's exact phrasing — that's the artifact. |
| People enrichment | `people/<existing-slug>` | Timeline entries appended to existing people pages from session mentions. Stub pages for new substantive people. |
| Pattern | `reflections/patterns/<theme>` | Cross-session theme detected across ≥3 reflections. Decision-pattern notes live in `reflections/` in this Brain. |
| Cycle summary | `dream-cycle-summaries/YYYY-MM-DD` | Index of every page produced by one dream cycle. Auto-written deterministically by the orchestrator. (Legacy summaries through 2026-06-11 live in `dream-cycles/`; the current shelf — matching the engine at `synthesize.ts` — is `dream-cycle-summaries/`.) |

`{hash}` is supported by the engine for upstream/backward-compatible route
templates, but Jarvis's active routes intentionally omit it for human-readable
slugs. Date + topic is the operator-facing identity; if the same topic is
re-synthesized for the same day, `put_page` updates that page rather than
creating a hash-noise duplicate.

**Iron Law for synthesize output:**
1. Quote the user verbatim. Do not paraphrase memorable phrasings.
2. Cross-reference compulsively: every new page MUST link to existing brain content.
3. Slug discipline: lowercase alphanumeric and hyphens only, slash-separated. NO underscores, NO file extensions.
4. Do not write outside `dream_synthesize_paths.globs`; retired `wiki/` paths are rejected in this Brain.

## Takes attribution (v0.32+)

When writing a `<!--- gbrain:takes:begin -->` fence, the **holder** column says
WHO BELIEVES the claim, not who it's ABOUT. Cross-modal eval over 100K
production takes scored attribution at 6.5/10 — holder/subject confusion was
the #1 error. These six rules are the contract. Long form with worked
examples lives in `docs/takes-vs-facts.md`.

1. **Holder ≠ subject.** The test: did this person SAY or CLEARLY IMPLY this?
   - YES → `holder = people/<slug>`
   - NO, it's your analysis OF them → `holder = brain`
   - Example: "Garry has a hero/rescuer pattern" → `holder=brain` (analysis ABOUT Garry, not stated BY Garry)
2. **Atomic claims.** Split compound rows into separate rows. One claim per row.
3. **Amplification ≠ endorsement.** A retweet-only signal caps at `weight 0.55`.
   The user shared something; they didn't necessarily endorse every clause.
4. **Self-reported ≠ verified.** "Saif reports 7 figures" → `holder=people/saif`,
   `weight=0.75`, NOT `holder=world/1.0`. Self-report is a strong individual
   signal, not consensus fact.
5. **No false precision.** Use 0.05 increments only (`0.35`, `0.55`, `0.75`).
   `0.74` and `0.82` imply calibration accuracy that doesn't exist. The engine
   layer rounds on insert — match the grid in your fence and avoid the warning.
6. **"So what" test.** Skip metadata-style trivia (Twitter handles, follower
   counts, obvious bio fields). A take has to be load-bearing for some future
   query.

**Holder format (enforced as a parser warning in v0.32, error in v0.33+):**
- `world` (consensus fact, no individual claimant)
- `brain` (AI-inferred, holder genuinely ambiguous)
- `people/<slug>` (individual's stated belief)
- `companies/<slug>` (institutional fact, no individual claimant)

Slugs use the standard grammar (`[a-z0-9._-]+`). `Garry`, `people/Garry-Tan`,
and `world/garry-tan` all fail validation.

**Founder-describing-own-company rule.** When a founder describes their own
company, the holder is the FOUNDER, not the company. "We can hit $10M ARR"
said by Bo Lu → `holder=people/bo-lu`, NOT `holder=companies/clipboard-health`.
Companies don't speak; their employees do.
