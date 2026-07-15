---
name: retrieval-miss-log
version: 1.0.0
description: |
  Turn retrieval misses into eval-goldset candidates automatically, so the
  gating goldset grows from real usage forever. Fires whenever an agent finishes
  a task using page(s) that were NOT in its first brain-search results, or the
  operator corrects the agent to a specific page, or the agent concludes a page
  is absent. Diagnoses each miss by BROWSING the actually-searched sources (not
  search alone) into a small set of source-aware classes — the one that matters
  is retrieval-gap (the page exists in a searched source, first search missed or
  underranked it → eval candidate) vs coverage-gap (page genuinely absent →
  capture-queue item, never an eval candidate). Appends one source-aware JSON
  line per miss to the qrels candidates log with zero ceremony; periodic verified
  promotion moves confirmed retrieval-gaps into the gating goldset.
triggers:
  - "log this retrieval miss"
  - "that was a search miss"
  - "no, I meant page X"
  - "that page should have come up"
  - "promote the miss-log candidates"
  - "review the retrieval-miss candidates"
tools:
  - search
  - query
  - get_page
  - resolve_slugs
  - sources_list
mutating: true
---

# Retrieval Miss Log

The eval goldset is only as good as the misses it has seen. This skill closes the
loop: every real retrieval miss that happens during ordinary work becomes a
verified candidate for the gating goldset, so retrieval quality is measured
against how the brain is *actually* queried — forever, without an operator having
to remember to file anything.

## Activation (this skill is NOT a background daemon)

Nothing runs this skill in the background — a skill only executes when it is
loaded. "Self-triggering" here means **you, the agent, must recognize the miss
and load this skill at task-completion.** For that to work you have to keep the
raw retrieval trace of your task's brain searches (the exact query strings you
issued, the ranked slugs each returned, and the `k` you requested) so it's still
in hand when the miss becomes obvious. If your harness doesn't retain that trace,
you cannot honestly log a candidate — mark the trace `reconstructed` and lower
your confidence accordingly (see the schema). The trigger phrases below are the
operator-facing hooks; the durable hook is the discipline of running Phase 1 at
the end of any brain-search-driven task.

## Contract

This skill guarantees:
- A self-recognized **trigger** (no operator flag required): the miss is captured
  whenever the page(s) an agent actually USED were not in the results of its
  FIRST brain search for that task (not returned at all, OR returned but ranked
  below the depth the agent actually read), OR the operator corrects the agent to
  a specific page, OR an agent concludes a page is absent.
- A **browse-first classification** before any log line: the miss is diagnosed by
  reading the actually-searched sources (their registered local paths + `git
  log`), never by re-searching. The classes are source-aware and small (see the
  table); the load-bearing split is `retrieval-gap` (page EXISTS in a searched
  source, first search didn't surface it → eval candidate) vs `coverage-gap`
  (page genuinely absent → capture-queue item, never an eval candidate).
- **Relevance ≠ existence.** A class of `retrieval-gap` requires confirming (via
  `get_page`) that the page actually ANSWERS the query at the version that was
  live at miss time — not merely that a page with that slug exists.
- **Zero-ceremony capture**: one JSON line appended to
  `~/.gbrain/qrels/<profile>/candidates.jsonl` (file created if missing;
  `<profile>` = the brain's qrels profile dir, `jiraiya` on this host), with the
  operator's phrasing preserved **verbatim** AND the exact executed search
  query recorded separately.
- **Log everything, adjudicate at promotion.** Never suppress a miss at capture
  time because you judge your own query was "bad" — record a `query_quality`
  field instead and let the promotion step exclude it. The capturing agent is not
  a neutral judge of its own query.
- **Verified promotion** (only when asked or during eval maintenance):
  candidates classified `retrieval-gap`/`ranking-gap` whose needed refs are
  confirmed to still resolve (same `source_id::slug`) get promoted into the
  gating goldset files in the qrels-file federated shape; all other classes route
  to their destination (capture queue, content-maintenance, or drop). An eval
  item is never created for a page that does not exist in a searched source.

## The classes (source-aware)

A miss is classified **per needed page**, against the sources that were actually
searched. A single task can produce a `mixed` outcome (one page a retrieval-gap,
another a coverage-gap) — log one line per needed page, or one line with a
per-target class array; do not force a single verdict onto a multi-page miss.

| Class | Meaning | Eval-eligible? | Destination |
|---|---|---|---|
| `retrieval-gap` | Page EXISTS in a searched source and ANSWERS the query, but the first search did not return it at all. | Yes | Gating qrels after verification. |
| `ranking-gap` | Page WAS returned by the first search but ranked below the depth the agent read (e.g. rank 14 with `k`/inspection cutoff 10). | Yes — but promote to a family whose pipeline matches (see Phase 4). | Gating qrels (ranking family). |
| `scope-gap` | Page exists but only in a source/brain that was NOT in the search scope (federation/routing miss, not a ranking failure). | No (it's a routing/config issue) | Fix the search scope / note the routing gap; not a qrels item. |
| `stale-or-wrong` | A page was returned/exists but its content is stale or wrong for what was asked; the correct answer is elsewhere or absent. | No | Content maintenance (enrich/citation-fixer), not qrels. |
| `coverage-gap` | The needed page is **genuinely absent** from every searched source. | No | Capture queue (page/idea to create). |
| `unverified` | You could not establish absence or existence with confidence (unavailable source, shallow git history, ambiguous target). | No | Leave pending; re-adjudicate at promotion. Never guess a class. |

You cannot tell `retrieval-gap` from `coverage-gap` by searching harder — a
search that missed a page and a search for a page that doesn't exist look
identical from the search side. **You must browse the searched sources to
decide.** That browse is the whole value of this skill; skipping it produces junk
candidates. An eval expecting an absent page **fails forever and measures
nothing** — that's why coverage/scope/stale classes are never promoted.

## Phases

### 1. Detect + snapshot the trace (self-recognized)
Recognize a miss the moment it happens. Any of:
- **First-search miss**: you completed a task, and the page(s) you ended up
  relying on were not returned by your *first* brain search for that task — either
  absent from the results or present but ranked below the depth you actually read
  — and you found them by reformulating, browsing, or by the operator pointing you
  at them.
- **Operator correction**: the operator says "no, I meant page X", "that page
  should have surfaced", or otherwise redirects you to a specific page. Treat this
  as a *relevance nomination*, not ground truth — the named page still gets the
  Phase 2 existence + relevance + scope check (it may be stale, a duplicate, in an
  unsearched source, or actually not the answer).
- **Absence conclusion**: you concluded, after searching, that the searched
  sources have no page for what was asked.

Snapshot the raw material immediately from your live trace (before it's lost),
but do NOT classify yet:
- the operator's **verbatim prompt/words**,
- the **exact search query string(s)** you actually issued (often different from
  the prompt — a conversational prompt like "what about that one?" is not itself a
  reproducible query),
- the ranked slugs each first search returned and the `k`/inspection depth you
  read,
- the slug(s) you actually needed (or "none — concluded absent"),
- the `source_id`(s) that were in scope for the search.

If you don't have the live trace and must reconstruct it, say so (set
`trace: "reconstructed"`) — never re-run search and present its output as the
original ranking; index/cache/content may have moved.

**Do not suppress at capture.** There is no "reasonable-query gate" that lets you
silently drop a miss you blame on your own query. Log it and record your honest
read in `query_quality` (`clean` | `suspect_typo` | `wrong_entity` |
`context_dependent` | `malformed`); the promotion step decides whether a
bad-query case is eval-eligible. A miss you refuse to log is a miss the goldset
never learns from.

### 2. Classify (BROWSE the searched sources FIRST — never search-only)
Before writing the class, diagnose by reading the sources that were actually
searched (resolve their registered local paths via `gbrain sources list`; on this
host the personal brain is at `/Users/jarvis/brain`):
- `ls` / walk the relevant shelves (people/, companies/, projects/, meetings/,
  concepts/, …) of each searched source.
- `git -C <source-path> log --oneline -- <likely paths>` to see whether a page for
  this exists (possibly under a different slug/shelf than search suggested), was
  renamed, was deleted before the event, or was never created.
- `resolve_slugs` / `get_page` to confirm a candidate page exists AND, at the
  version live at miss time, actually contains the needed answer.

Decide the class per needed page (see the class table above):
- Exists in a searched source, answers the query, first search returned nothing →
  `retrieval-gap`.
- Was in the first search results but below your read depth → `ranking-gap`
  (record the rank).
- Exists only in an out-of-scope source/brain → `scope-gap`.
- Returned/exists but content is stale or wrong → `stale-or-wrong`.
- Absent from every searched source → `coverage-gap`.
- Can't establish it either way (unavailable source, shallow history) →
  `unverified`.

### 3. Log (zero ceremony, source-aware)
Append exactly one JSON line per needed page to
`~/.gbrain/qrels/<profile>/candidates.jsonl` (create the file and its parent dir
if missing; `<profile>` is the brain's qrels dir — `jiraiya` on this host). Do not
pretty-print; one object per line. Schema:

```json
{"id":"rml-2026-07-15-a1b2","ts":"2026-07-15T14:32:00Z","brain_id":"host","searched_sources":["default"],"verbatim_prompt":"what's the current status of the consortium?","search_query":"consortium status","first_search_returned":["companies/acme-example","meetings/2026-04-03"],"read_depth":10,"needed":[{"source_id":"default","slug":"projects/consortium-status","observed_rank":null}],"class":"retrieval-gap","query_quality":"clean","trace":"live","status":"pending","notes":"exists under projects/, git log confirms live page; not returned in first search"}
```

Field rules:
- `id` — stable dedup key: `rml-<date>-<short-hash>` where the hash is over
  (`brain_id` + sorted `searched_sources` + `search_query` + sorted `needed`
  refs). Two agents logging the same miss produce the same `id`; if the file
  already has that `id`, don't append a duplicate.
- `ts` — ISO 8601 UTC, second precision (when the miss was captured).
- `brain_id` — the brain that was searched (`host` for the personal brain).
- `searched_sources` — the `source_id`(s) that were in the search scope. Required:
  a slug is meaningless without its source (qrels compares on `source_id::slug`).
- `verbatim_prompt` — the operator's **actual words**, unedited. Never paraphrase,
  clean up, or summarize. The phrasing is preserved for context and audit.
- `search_query` — the exact query string you issued (may equal the prompt; often
  doesn't). This is the reproducible retrieval input.
- `first_search_returned` — the ranked slugs your FIRST search returned (order
  preserved). `[]` if it returned nothing.
- `read_depth` — the rank cutoff you actually inspected (so `ranking-gap` is
  distinguishable from `retrieval-gap`).
- `needed` — array of `{source_id, slug, observed_rank}` for each page you needed.
  `observed_rank` = its rank in `first_search_returned`, or `null` if not
  returned. For coverage-gap: the ref the page *should* have, with `notes` saying
  it's absent.
- `class` — one of the six class values in the table.
- `query_quality` — your honest read of the query (`clean` | `suspect_typo` |
  `wrong_entity` | `context_dependent` | `malformed`). Recorded, never used to
  suppress.
- `trace` — `live` or `reconstructed`.
- `status` — always `pending` at capture.
- `notes` — one line: the browse finding that justified the class.

That's the whole capture. No brain page, no confirmation prompt, no interrupting
the task. Append one immutable line and move on; verification, relevance-at-time
adjudication, and any mirrored note happen at promotion.

**Privacy.** `candidates.jsonl` lives under `~/.gbrain/` (private, never a git
artifact). A `verbatim_prompt` may contain names/secrets — it stays local. At
promotion, if a candidate ships into a shared/published goldset, the reviewer
supplies a redacted `query` for the public entry; never claim a redacted query is
verbatim.

### 4. Promote (only when asked, or during eval maintenance)
When the operator says "promote the miss-log candidates" or during a goldset
maintenance pass:
1. Read `candidates.jsonl`. Consider only `status: "pending"` items; group by
   `class`.
2. For each **retrieval-gap / ranking-gap**: re-verify every `needed` ref still
   resolves to a live page in that `source_id` (`resolve_slugs`/`get_page`) AND
   still answers the query. If a ref was deleted/renamed, or the page was only
   *created after* the miss (check git history — a page that didn't exist at miss
   time isn't evidence of a retrieval gap), reclassify or drop it. Never promote
   an item pointing at a gone or after-the-fact page.
3. Build the qrels entry in the **federated shape** the gate reader expects
   (`src/core/bench/qrels-file.ts`): `{"query_id": <id>, "query": <search_query,
   redacted if needed>, "relevant": [{"source_id","slug"}, …], "expected_top1":
   {...}? }`. Append it to the matching family file under
   `~/.gbrain/qrels/<profile>/` — a `retrieval-gap` goes to a direct
   retrieval-quality family; a `ranking-gap` to a ranking family whose pipeline
   matches how it was observed. Do NOT relabel across families.
4. For each **coverage-gap**: route to the capture queue — consult brain-taxonomist
   for the path, then file the page-to-create or hand it to the relevant ingest
   skill. Do NOT create an eval item now; keep the candidate linked so that once
   the page is captured, a fresh retrieval test can be opened against it.
   `scope-gap` → note/fix the search scope. `stale-or-wrong` → route to
   enrich/citation-fixer. `unverified` → leave pending.
5. Record the transition as a NEW appended line (never rewrite the original —
   JSONL lines are immutable): `{"id": <same id>, "status": "promoted"|"routed"|
   "dropped", "promoted_ts": "...", "target": "<family-file or capture-item>",
   "reviewer": "...", "reason": "..."}`. A candidate whose latest status line is
   terminal is skipped on the next pass, so the same miss isn't promoted twice.
6. After promotion, run the gate against the family you edited to wire the new
   items and set their day-one baseline:
   `gbrain eval gate --qrels ~/.gbrain/qrels/<profile>/<family>.qrels.json`
   (add `--source <searched_source>` when the family isn't `default`). This is the
   real gate command — do NOT use a bare `--source default` with no `--qrels`.

## Output Format

- **At capture time**: one appended JSON line per needed page in
  `~/.gbrain/qrels/<profile>/candidates.jsonl`. No chat ceremony beyond a one-line
  acknowledgement ("logged retrieval-gap: <search_query>").
- **At promotion time**: a short report — N candidates read, split by class, M
  retrieval/ranking-gaps promoted into which family files, K coverage-gaps routed
  to the capture queue (with their capture targets), scope/stale/unverified counts
  and where they went, any dropped (with reason), and the post-promotion gate
  baseline.

## Anti-Patterns

- **Suppressing a miss you blame on your own query.** The capturing agent is not a
  neutral judge of its own query. Never silently drop a miss because you decide the
  query was "bad" — log it and record `query_quality`. Promotion, not capture,
  decides eval-eligibility.
- **Recording a slug without its source.** A slug is meaningless without its
  `source_id` — the qrels gate compares on `source_id::slug`, so a slug-only
  candidate false-passes (or false-misses) on any multi-source brain. Always carry
  `{source_id, slug}`.
- **Existence = relevance.** A page with the right slug that doesn't actually
  answer the query (or was stale/wrong at miss time) is NOT a retrieval-gap.
  Confirm the content answers, at the version live at miss time.
- **Forcing a binary class onto a multi-page or edge-case miss.** Classify per
  needed page; use `ranking-gap`, `scope-gap`, `stale-or-wrong`, and `unverified`
  where they fit. A `scope-gap` (page in an unsearched source) promoted as a
  retrieval-gap measures a routing bug as if it were a ranking bug.
- **Paraphrasing the operator's prompt.** `verbatim_prompt` is preserved exactly
  for context/audit. The reproducible retrieval input is the separate
  `search_query`. Don't collapse the two or "normalize" the prompt.
- **Logging without the browse-first diagnosis.** Classifying by searching again
  can't distinguish a missed page from an absent one. Browse the *searched
  sources* (shelves + git log) before writing the class. A search-only
  classification is worthless.
- **Treating a coverage / scope / stale case as an eval candidate.** An eval item
  expecting an absent (or out-of-scope, or wrong-content) page fails forever and
  measures nothing. Only verified retrieval/ranking gaps enter a qrels gating file.
- **Fabricating the first-search ranking.** If you lost the live trace, mark
  `trace: "reconstructed"` — never re-run search and pass its current output off as
  the original ranking. Index, cache, and content drift.
- **Ceremony at capture time.** Do not stop to write a brain page, ask the operator
  to confirm, or interrupt the task. Append one line and move on; verification and
  any mirrored note happen at promotion.
- **Rewriting a candidate line, or promoting a gone / after-the-fact page.** JSONL
  lines are immutable — record lifecycle transitions as new appended status lines.
  At promotion, re-confirm each ref still resolves AND existed at miss time; a page
  created after the miss isn't evidence of a retrieval gap.

## Tools Used

- `search` / `query` — the miss is observed from the live task trace, NOT re-run to
  "prove" it (a rerun is only a `reconstructed`, lower-confidence fallback).
- `resolve_slugs` — verify a candidate `{source_id, slug}` maps to a real live page
  (classification + promotion).
- `get_page` — confirm the page actually contains the needed answer, at the
  miss-time version, before calling it a retrieval-gap.
- `gbrain sources list` — resolve which sources were in scope and their registered
  local paths, so the browse covers every searched source (not just the personal
  brain).
- Plus direct repo browsing (`ls` shelves, `git -C <source-path> log`) — the
  load-bearing classification step that search alone cannot substitute for.
