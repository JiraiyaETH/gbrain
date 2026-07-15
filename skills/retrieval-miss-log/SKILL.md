---
name: retrieval-miss-log
version: 1.0.0
description: |
  Turn retrieval misses into eval-goldset candidates automatically, so the
  gating goldset grows from real usage forever. Fires whenever an agent finishes
  a task using page(s) that were NOT in its first brain-search results, or the
  operator corrects the agent to a specific page, or the agent concludes a page
  is absent. Diagnoses each miss by BROWSING the brain repo (not search alone)
  into retrieval-gap (page exists, first search missed it → eval candidate) vs
  coverage-gap (page genuinely absent → capture-queue item, never an eval
  candidate). Appends one JSON line per miss to the qrels candidates log with
  zero ceremony; periodic verified promotion moves retrieval-gaps into the
  gating goldset.
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
mutating: true
---

# Retrieval Miss Log

The eval goldset is only as good as the misses it has seen. This skill closes the
loop: every real retrieval miss that happens during ordinary work becomes a
verified candidate for the gating goldset, so retrieval quality is measured
against how the brain is *actually* queried — forever, without an operator having
to remember to file anything.

## Contract

This skill guarantees:
- A self-detectable **trigger** (no operator flag required): the miss is captured
  whenever the page(s) an agent actually USED were not in its FIRST brain-search
  results for that task, OR the operator corrects the agent to a specific page,
  OR an agent concludes a page is absent.
- A **browse-first classification** before any log line: the miss is diagnosed by
  reading the brain repo (`/Users/jarvis/brain` shelves + `git log`), never by
  re-searching. Two mutually-exclusive classes: `retrieval-gap` (page EXISTS but
  first search didn't surface it) vs `coverage-gap` (page genuinely absent).
- **Zero-ceremony capture**: one JSON line appended to
  `~/.gbrain/qrels/jiraiya/candidates.jsonl` (file created if missing), with the
  operator's phrasing preserved **verbatim**.
- **Verified promotion** (only when asked or during eval maintenance):
  retrieval-gap candidates whose `needed_slugs` are confirmed to exist get
  promoted into the gating goldset files; coverage-gap items route to the capture
  queue. An eval item is never created for a page that does not exist.

## The load-bearing distinction

| Class | Meaning | Destination | Why it matters |
|---|---|---|---|
| `retrieval-gap` | The needed page **exists** in the brain, but the first reasonable search didn't surface it. | Eval-goldset candidate → promoted into gating qrels after verification. | This is a real, measurable retrieval failure. It is exactly what the goldset should grow to cover. |
| `coverage-gap` | The needed page is **genuinely absent** — the knowledge was never captured. | Capture queue (a page/idea to create), NOT an eval candidate. | An eval expecting an absent page **fails forever and measures nothing**. Coverage gaps are a content problem, not a retrieval problem. Never conflate them. |

You cannot tell these two apart by searching harder — a search that missed the
page and a search for a page that doesn't exist look identical from the search
side. **You must browse the repo to decide.** That browse is the whole value of
this skill; skipping it produces junk candidates.

## Phases

### 1. Detect (self-triggering)
Recognize a miss the moment it happens. Any of:
- **First-search miss**: you completed a task, and the page(s) you ended up
  relying on were not in the top results of your *first* brain search for that
  task (you found them by reformulating, browsing, or by the operator pointing
  you at them).
- **Operator correction**: the operator says "no, I meant page X", "that page
  should have surfaced", or otherwise redirects you to a specific page your search
  didn't return.
- **Absence conclusion**: you concluded, after searching, that the brain has no
  page for what was asked.

Capture the raw material immediately (before it's lost): the operator's
**verbatim prompt/words**, the top slugs your **first** search returned, and the
slug(s) you actually needed (or "none — concluded absent").

**Reasonable-query gate.** Only log if a *reasonable* query missed. If your first
query was obviously bad (a typo, a wrong entity name, a malformed phrase) and an
obvious reformulation immediately fixed it, that is your own bad query, not a
retrieval failure — do NOT log it. The goldset should encode misses a competent
agent would actually hit.

### 2. Classify (BROWSE FIRST — never search-only)
Before writing anything, diagnose by reading the brain repo:
- `ls` / walk the relevant shelves under `/Users/jarvis/brain` (people/,
  companies/, projects/, meetings/, concepts/, etc.).
- `git -C /Users/jarvis/brain log --oneline -- <likely paths>` to see whether a
  page for this exists (possibly under a different slug/shelf than search
  suggested), was recently renamed, or was never created.
- Use `resolve_slugs` / `get_page` to confirm a candidate page actually exists and
  contains the needed answer.

Decide:
- **The page exists** (possibly mis-slugged or on an unexpected shelf) →
  `retrieval-gap`. Record its real slug(s) in `needed_slugs`.
- **No page exists** → `coverage-gap`. `needed_slugs` names the page that *should*
  exist (the capture-queue target), and `notes` says it's absent.

### 3. Log (zero ceremony)
Append exactly one JSON line to `~/.gbrain/qrels/jiraiya/candidates.jsonl`
(create the file and its parent dir if missing). Do not pretty-print; one object
per line. Schema:

```json
{"ts":"2026-07-15T14:32:00Z","verbatim_prompt":"what's the current status of the consortium?","first_search_returned":["companies/acme-example","meetings/2026-04-03"],"needed_slugs":["projects/consortium-status"],"class":"retrieval-gap","notes":"page exists under projects/, first search ranked two tangential entities above it"}
```

Field rules:
- `ts` — ISO 8601 UTC, second precision.
- `verbatim_prompt` — the operator's **actual words**, unedited. Never paraphrase,
  never "clean up", never summarize. The phrasing IS the test input.
- `first_search_returned` — the top slugs from your FIRST search (best effort if
  not perfectly recorded; note "(reconstructed)" in `notes` if so).
- `needed_slugs` — for retrieval-gap: the confirmed real slug(s). For
  coverage-gap: the slug the page *should* have, marked as not-yet-existing in
  `notes`.
- `class` — exactly `"retrieval-gap"` or `"coverage-gap"`.
- `notes` — one line: the browse finding that justified the class (e.g. "found via
  git log under old slug", "no page on any shelf; capture-queue item").

That's the whole capture. No brain page, no confirmation prompt, no interrupting
the task. (An optional mirrored brain note under `notes/` may be created during
promotion, not at capture time.)

### 4. Promote (only when asked, or during eval maintenance)
When the operator says "promote the miss-log candidates" or during a goldset
maintenance pass:
1. Read `candidates.jsonl`. Split by `class`.
2. For each **retrieval-gap**: re-verify every `needed_slug` still exists
   (`resolve_slugs`/`get_page`). If a slug has since been deleted/renamed,
   reclassify or drop it — never promote an item pointing at a gone page.
3. Confirm the `verbatim_prompt` is still exactly the operator's words (it must
   never have been paraphrased in step 3). Promote it into the appropriate gating
   goldset file under `~/.gbrain/qrels/jiraiya/`, matching that goldset's item
   schema (query text = the verbatim prompt; relevant slugs = the verified
   `needed_slugs`). Route to the correct family file per Phase 4 goldset
   mechanics — never relabel a task/aggregation item as a fixed retrieval-quality
   family.
4. For each **coverage-gap**: route to the capture queue (file the page-to-create,
   or hand it to the relevant ingest skill). Do NOT create an eval item.
5. Record which candidates were promoted (e.g. append a `promoted_ts` marker or
   move them to a `candidates.promoted.jsonl`) so the same miss isn't promoted
   twice.
6. After promotion, run the gating eval suite (`--source default`) to confirm the
   new items are wired and to establish their day-one baseline.

## Output Format

- **At capture time**: exactly one appended JSON line in
  `~/.gbrain/qrels/jiraiya/candidates.jsonl`. No chat ceremony beyond a one-line
  acknowledgement ("logged retrieval-gap: <verbatim_prompt>").
- **At promotion time**: a short report — N candidates read, split by class, M
  retrieval-gaps promoted into which family files, K coverage-gaps routed to the
  capture queue, any dropped (with reason), and the post-promotion eval baseline.

## Anti-Patterns

- **Logging your own bad query.** If a reasonable first query would have hit the
  page and you only missed because of a typo/wrong-entity/malformed phrase you
  then obviously fixed yourself, do NOT log it. Log only misses a competent agent
  would actually hit.
- **Paraphrasing the operator's prompt.** The verbatim words are the test input.
  Cleaning them up, summarizing, or "normalizing" them silently corrupts the
  goldset. Preserve them exactly, warts and all.
- **Logging without the browse-first diagnosis.** Classifying by searching again
  can't distinguish a missed page from an absent one. Browse the repo (shelves +
  git log) before writing the class. A search-only classification is worthless.
- **Treating a coverage-gap as an eval candidate.** An eval item expecting a page
  that doesn't exist fails forever and measures nothing. Coverage-gaps go to the
  capture queue, never into a qrels gating file.
- **Ceremony at capture time.** Do not stop to write a brain page, ask the
  operator to confirm, or interrupt the task. Append one line and move on;
  verification and any mirrored note happen at promotion.
- **Promoting an unverified needed_slug.** Re-confirm the page still exists at
  promotion. Promoting an item that points at a since-deleted/renamed page
  reintroduces a permanent-fail eval item.

## Tools Used

- `search` / `query` — to reconstruct what the first search returned (the miss
  itself is observed from the live task, not re-run to "prove" it).
- `resolve_slugs` — verify a candidate slug maps to a real page (classification +
  promotion).
- `get_page` — confirm the page actually contains the needed answer before calling
  it a retrieval-gap.
- Plus direct repo browsing (`ls` shelves, `git -C /Users/jarvis/brain log`) — the
  load-bearing classification step that search alone cannot substitute for.
