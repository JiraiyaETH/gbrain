# Codex Enrich Fixes Report

Branch: `fix/enrich-silent-skip-wave`

## Boundary Notes

- Worked only in `/Users/jarvis/worktrees/gbrain/enrich-fixes`.
- Did not touch `/Users/jarvis/gbrain`.
- Did not edit `VERSION` or `CHANGELOG.md`.
- Did not push.
- Installed local dependencies with `bun install --ignore-scripts` because `node_modules` was absent; no lockfile/package churn resulted.

## Fix 1: Hash-Dedup Enrich Skip Loop

Changed `runEnrichCore` so a content-identical synthesis is not counted as enriched. The `put_page` result is now inspected:

- `status !== 'skipped'` increments `pages_enriched`.
- `status === 'skipped'` performs a narrow `mergePageFrontmatter()` update to stamp `enriched_at` / `enriched_by`, then increments `pages_unchanged`.

Added engine-parity surface:

- `BrainEngine.mergePageFrontmatter(...)`
- PGLite implementation using a JSONB merge parameter.
- Postgres implementation using `sql.json(...)`, not `JSON.stringify(...)`.

Also excluded `enriched_at` and `enriched_by` from import content hashes so provenance-only enrich stamps do not defeat the import dedup contract.

## Fix 2: Alias and Diacritic Evidence Recall

Changed enrich evidence retrieval to query a bounded merged set:

- original title
- ASCII/diacritic-folded title when different
- frontmatter aliases via `normalizeAliasList`

Results are deduped and interleaved under the existing `HYBRID_SEARCH_LIMIT` budget before backlinks/facts are added.

## Fix 3: Explicit DeepSeek Model Availability

Confirmed `deepseek_api_key` already maps into gateway config. Fixed the actual short-circuit by making enrich availability checks model-aware:

- CLI: `isAvailable('chat', parsed.model)`
- cycle phase: `isAvailable('chat', cfg.model)`

Added a specific unavailable-model error message so explicit provider/model failures are not framed as budget stops.

## Tests

Commands were run with output redirected to `/tmp` and `echo EXIT=$?`, per brief.

`bun run typecheck > /tmp/gbrain-enrich-typecheck.txt 2>&1; echo EXIT=$?`

Summary:

```text
$ tsc --noEmit
EXIT=0
```

`bun test test/e2e/enrich-pglite.test.ts test/enrich/idempotency.test.ts test/ai/build-gateway-config.test.ts test/import-file.test.ts test/enrich-cycle-phase.test.ts > /tmp/gbrain-enrich-targeted-tests.txt 2>&1; echo EXIT=$?`

Summary:

```text
65 pass
0 fail
182 expect() calls
Ran 65 tests across 5 files. [3.26s]
EXIT=0
```

Extra JSONB guard:

`bun run check:jsonb > /tmp/gbrain-enrich-check-jsonb.txt 2>&1; echo EXIT=$?`

Summary:

```text
OK: no JSON.stringify(x)::jsonb interpolation pattern in src/
OK: max_stalled defaults are 5 in all schema sources
check-jsonb-params: clean (no positional $N::jsonb + JSON.stringify double-encodes)
EXIT=0
```

Also ran `git diff --check`; no whitespace errors.

## Upstream History Check

Latest `origin/master` history exists for every touched file; no fork-only file interference found.

```text
src/commands/enrich.ts: 5c49225e
src/core/cycle/enrich-thin.ts: 662a6e27
src/core/engine.ts: c023a604
src/core/import-file.ts: 7c27fa12
src/core/pglite-engine.ts: c023a604
src/core/postgres-engine.ts: c023a604
test/ai/build-gateway-config.test.ts: 430d784a
test/e2e/enrich-pglite.test.ts: 662a6e27
test/enrich/idempotency.test.ts: 662a6e27
test/import-file.test.ts: 6f26d5e4
```

## Upstream PR Readiness

- Engine parity preserved for the new metadata-only frontmatter merge.
- Postgres JSONB write uses `sql.json(...)`; JSONB guard is clean.
- Regression tests cover unchanged enrich attempts, recency exit on second run, diacritic/alias evidence retrieval, DeepSeek config-key availability, and corrected unavailable-model messaging.
