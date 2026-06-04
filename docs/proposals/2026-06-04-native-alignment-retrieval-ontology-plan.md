# Native alignment retrieval + ontology plan

## Goal

Keep this deployment aligned with upstream GBrain's operating model while making only small, evidence-backed local adaptations where the local corpus needs them.

The immediate standard is: no sprawl, no graph soup, no hidden source-boundary drift, and no autonomy that writes before the retrieval and extraction gates are clean.

## Source-of-truth read

- Upstream runtime docs treat `sources/` and `.raw/` as provenance/evidence surfaces, not ordinary answer material.
- Runtime default hard excludes already hide `test/`, `archive/`, `attachments/`, `.raw/`, and `sources/` unless an explicit `include_slug_prefixes` opt-in is used.
- The local Brain resolver treats `sources/` as raw imported evidence and `inbox/` as uncertain/temporary triage.
- Live behavior currently lets `inbox/` appear in normal query results. That is the concrete drift to fix first.

## Alignment rules

1. Preserve native GBrain primitives first: schema packs, source-scoped pages, default source, typed links, explicit opt-in retrieval, exact readback, and dry-run before write.
2. Keep `sources/` retrievable through exact reads, source listing, provenance/citation drilldown, and explicit opt-in retrieval. Do not make it normal answer fodder.
3. Keep `attachments/` and `.raw/` hidden from default retrieval. Use them only as evidence drilldown surfaces.
4. Add `inbox/` to default retrieval hard-excludes. Keep exact `get_page`, explicit listing, and triage/review workflows available.
5. Implement ontology changes as a small policy layer over native extraction, not as local regex sprawl.

## Implementation slice 1 — retrieval hygiene

Files likely to change:

- `src/core/search/source-boost.ts`
- `test/sql-ranking.test.ts`
- `test/e2e/search-exclude.test.ts`
- possibly `test/e2e/engine-parity.test.ts`

Steps:

1. Add failing tests proving `inbox/` is excluded by default and opt-in retrievable.
2. Add `inbox/` to `DEFAULT_HARD_EXCLUDES`.
3. Run targeted tests:
   - `bun test test/sql-ranking.test.ts`
   - `bun test test/e2e/search-exclude.test.ts`
   - `bun test test/e2e/engine-parity.test.ts` if touched
4. Run `bun run typecheck`.
5. Run `bun run verify` if the targeted slice is green.
6. Live/default proof after code proof: normal query should not return `inbox/`; exact `get_page inbox/readme` and explicit inbox listing should still work.

## Implementation slice 2 — ontology matrix

Files likely to change later:

- `src/core/link-ontology.ts` as the pure policy module
- `src/core/link-extraction.ts` as the candidate-discovery caller
- `src/core/extract-ner.ts` for NER/schema-pack enforcement
- `src/commands/extract.ts` for dry-run reporting and anomaly caps
- `test/link-extraction.test.ts` and adjacent extraction tests

Design:

- Candidate discovery remains native GBrain extraction.
- New ontology policy decides whether a candidate can become a typed edge.
- The policy owns page-pair rules, allowed verbs, evidence gates, canonical direction, downgrade behavior, and review hints.
- Unsafe or weak evidence downgrades to `mentions`.
- Deprecated/unsafe inferred labels remain available only for explicit/manual or specialized schema-pack lanes where appropriate.

Proof before live graph writes:

1. Unit tests for page-pair/evidence gates.
2. Regression that generic person-company co-occurrence cannot become investor-style truth.
3. Positive tests for local business labels only with explicit evidence.
4. Regression for hard roles requiring explicit evidence.
5. Full typecheck/verify.
6. Source-scoped dry-run extraction only.
7. Explicit operator approval before live extraction writes or recurring Minion/Autopilot use.

## Autonomy gate

Minions/Supervisor can run bounded deterministic jobs after this retrieval hygiene slice is green. Autopilot remains observe/propose until retrieval hygiene and ontology dry-run proof are both clean.

## Dirty-state note

Current runtime worktree has pre-existing meeting-intelligence edits in `src/core/meeting-intelligence/index.ts` and `test/meeting-intelligence.test.ts`. Do not overwrite, stage, or commit those as part of retrieval/ontology alignment unless separately classified and approved.
