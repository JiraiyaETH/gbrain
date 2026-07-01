# Post-Run Retrieval Gate

Cross-cutting verification for skills that write or materially rewrite Brain
pages. Graph-safe writing proves edges are shaped correctly; this gate proves
the updated brain can still be found and ranked correctly.

## When to run

Run this gate after any skill creates, enriches, rewrites, or bulk-updates pages
that affect user-facing search, query, or graph traversal.

Use the smallest gate that matches the blast radius:

| Change | Gate |
|---|---|
| One low-risk page | Smoke |
| Person/company enrichment | Entity |
| Meeting/contract/media ingest | Entity + relational |
| Batch import, bulk enrichment, schema change, embedding/index work | Batch |
| Retrieval code, ranking code, graph extraction, source weighting | Full eval |

Skip only for typo-only edits, frontmatter repair that does not alter searchable
content, or pure raw-source archiving with no page/index change. If skipped,
say why.

## Smoke gate

For a small write, run 2-5 natural-language probes before reporting done:

1. A direct identity/query probe:
   ```bash
   gbrain query "who is <name>"
   gbrain search "<name>"
   ```
2. A topic probe that should surface the page:
   ```bash
   gbrain query "what do we know about <project/company/topic>"
   ```
3. A negative-ranking probe when the page is noisy: confirm logs, raw sources,
   food/workout pages, contract leaves, or transcript chunks do not outrank the
   canonical page for the canonical query.

Pass criteria:
- expected canonical page appears in top 1-3 for direct identity/company queries;
- supporting pages appear as support, not as the main answer, unless asked for;
- no low-signal page outranks a canonical page for an obvious query;
- the answer cites real brain pages and flags gaps instead of inventing.

## Entity gate

For person/company/project enrichment, verify four retrieval surfaces:

| Probe | Expected |
|---|---|
| Identity | canonical page ranks top 1-3 |
| Alias | known aliases/handles resolve to the same canonical page |
| Relationship | relevant connected pages appear through graph/query |
| Priority | canonical page outranks raw logs, contracts, and incidental mentions |

If the page is a stub or intentionally weak, the correct result may be "known
gap" rather than a rich answer. Do not promote weak evidence into confidence.

## Relational gate

For writes that create or update relationships, run both graph readback and
natural-language retrieval:

```bash
gbrain graph-query <slug> --depth 1 --direction both --source default
gbrain query "who worked with <company/project>"
gbrain query "what connects <person> and <company/project>"
```

Pass criteria:
- expected typed edges are present;
- suspicious strong edges are absent or downgraded;
- natural-language relationship questions recover the same relationship the
  graph readback shows.

## Batch gate

For bulk work, do not rely on spot checks alone.

Preferred command sequence:

```bash
export GBRAIN_CONTRIBUTOR_MODE=1
gbrain eval export --since 7d > /tmp/gbrain-before.ndjson
# run the batch change
gbrain eval gate --baseline /tmp/gbrain-before.ndjson
```

When a curated qrels/goldset exists, also run:

```bash
gbrain eval gate --qrels <brain-retrieval-smoke.qrels.json>
gbrain eval retrieval-quality <brain-retrieval-quality.jsonl> --ab-relational
```

Use `maintain` for scheduled or broad benchmark runs.

## Building a goldset

A good retrieval question has:

- a stable user-facing query;
- one or more expected canonical slugs;
- optional supporting slugs;
- optional forbidden slugs or page classes that must not outrank;
- a short reason the query matters.

Record candidate rows in this shape:

```json
{
  "id": "person-jiraiya",
  "query": "Who is Jiraiya?",
  "expected_top1": "people/jiraiya",
  "relevant": ["people/jiraiya", "companies/tailored"],
  "forbidden_top3": ["food/", "workout/"],
  "reason": "Owner identity should resolve to the canonical person page, not daily logs."
}
```

Convert mature direct-answer rows to qrels for `gbrain eval gate --qrels`.
Convert relationship and forbidden-ranking rows to retrieval-quality JSONL or a
small scripted smoke test when qrels cannot express the assertion.

## Failure handling

If the gate fails:

1. Identify whether the problem is page content, links/edges, embedding/index
   coverage, source weighting, or ranking.
2. Run `gbrain doctor --json` and compare `gbrain search` vs `gbrain query` for
   the same probe.
3. Repair the page, links, or index; then re-run the failed probes.
4. If a legitimate ranking change occurred, update the goldset with a `Why:`
   note. Never loosen expected slugs just to make a failing run green.

Do not report a meaningful brain write as complete while the relevant retrieval
gate is failing.
