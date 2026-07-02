# Health Scope Fix Report

## Changes

- Added `getHealth(opts?: { sourceIds?: string[] })` to the shared engine contract.
- Implemented scoped health SQL in both Postgres and PGLite engines. Omitted opts keep the existing global behavior; `sourceIds: []` is an explicit empty universe.
- Moved autopilot source eligibility into shared helpers in `autopilot-fanout.ts`:
  - eligible: `config.federated === true && config.strategy !== 'code'`
  - skipped: code-strategy and isolated/non-federated sources
- `runAutopilot` now loads that source universe once per tick, passes it to both health scoring and fanout dispatch, and computes recommendations from the same scoped health.
- Brain-wide onboard remediation extras are skipped when autopilot health is scoped, because those checks are intentionally global and would make the plan disagree with the scoped score.
- Updated `docs/ENGINES.md` and regenerated `llms-full.txt`.

## Live Default-Only Score Arithmetic

Read-only probe using this worktree's engine code against the configured brain, scoped to `sourceIds: ['default']`.

Real scoped counts:

- `page_count = 2,297`
- `chunk_count = 5,039`, `embedded_count = 5,039`, `missing_embeddings = 0`
- `link_count = 14,474`
- `pages_with_timeline = 345`
- `orphan_pages = 331`
- `dead_links = 0`

Current scoped score:

- Embed: `round(5039 / 5039 * 35) = 35`
- Links: `round(min(14474 / 2297, 1) * 25) = 25`
- Timeline now: `round(345 / 2297 * 15) = 2`
- Orphans: `round((1 - 331 / 2297) * 15) = 13`
- Dead links: `round((1 - min(0 / 2297, 1)) * 10) = 10`
- Current total: `35 + 25 + 2 + 13 + 10 = 85`

Post-heal expected score for the same live shape, once timeline coverage is filled:

- Timeline post-heal: `round(2297 / 2297 * 15) = 15`
- Expected post-heal total: `35 + 25 + 15 + 13 + 10 = 98`

For comparison, the unscoped live health remains wedged by unserviced sources:

- Global `page_count = 8,528`
- Global `orphan_pages = 6,526`
- Global `brain_score = 75`
- Global `no_orphans_score = 4`

## Verification

- `bun test test/brain-score-breakdown.test.ts test/autopilot-health-scope.test.ts test/autopilot-fanout.test.ts test/autopilot-fanout-wiring.test.ts test/e2e/engine-parity.test.ts test/build-llms.test.ts > /tmp/hscope-tests.txt 2>&1; echo EXIT=$?`
  - `EXIT=0`
  - `58 pass`, `29 skip`, `0 fail`
  - The skips are the `DATABASE_URL`-gated Postgres E2E lane.
- `bun run typecheck > /tmp/hscope-typecheck.txt 2>&1; echo EXIT=$?`
  - `EXIT=0`

Additional checks:

- `scripts/check-test-isolation.sh` fails on pre-existing env mutations in `test/link-extraction.test.ts` and `test/sql-ranking.test.ts`; no new violation was reported for `test/autopilot-health-scope.test.ts`.
- Attempted to start the repo Postgres test service with `docker compose -f docker-compose.test.yml up -d postgres`; Docker daemon was unavailable at `/Users/jarvis/.orbstack/run/docker.sock`, so the real Postgres parity lane could not be executed locally.

## Upstream PR Readiness

- The engine API change is additive and keeps global health as the default for doctor/status/operations consumers.
- Postgres and PGLite use the same scoped metric semantics and have parity coverage added in `test/e2e/engine-parity.test.ts`.
- Autopilot now shares one source-universe partition between scoring and dispatch, avoiding duplicated eligibility policy.
- No `VERSION` or `CHANGELOG` changes. No pushes or merges.
