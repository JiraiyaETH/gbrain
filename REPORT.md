# MinionQueue Idempotency Terminal Re-arm Report

## Summary

Implemented the preferred re-arm approach in `MinionQueue.add()`.

Actual job status vocabulary from code/schema:

- Live/non-terminal: `waiting`, `active`, `delayed`, `waiting-children`, `paused`
- Terminal: `completed`, `failed`, `dead`, `cancelled`

Live rows with a matching `idempotency_key` still dedup exactly as before. Terminal
rows with a matching key no longer satisfy dedup forever: `add()` now reuses the
same row id, atomically updates it back to a fresh waiting/delayed state, resets
attempt/lock/progress/result/error/timestamp state, replaces data/options from the
new submission, and returns the row as claimable work.

The race guard is on the update itself:

`WHERE id = $... AND status IN ('completed', 'failed', 'dead', 'cancelled')`

If another concurrent submitter re-arms first, the losing transaction returns the
current row as-is.

## Choice: re-arm, not insert

I chose re-arm because the existing unique partial index on `minion_jobs(idempotency_key)`
can stay unchanged and stable job ids are preserved. I did not find a safer need for
a fresh-row insert/migration path in this code path. `jobs get`, stats, watchdogs,
and worker claim all read the current row state; re-arm intentionally treats the row
as the next invocation rather than preserving terminal history under the same id.

## Files Changed

- `src/core/minions/queue.ts` - terminal idempotency-key hits re-arm instead of
  returning terminal rows forever.
- `test/minions.test.ts` - added regressions for live dedup, completed/failed/dead/
  cancelled re-arm, and the stable recommendation-key wedge.
- `docs/architecture/KEY_FILES.md` - updated the current behavior entry for
  `queue.ts`.

No VERSION or CHANGELOG edits.

## Test Results

- `bun run typecheck > /tmp/qidem-typecheck.txt 2>&1; echo EXIT=$?`
  - `EXIT=0`
  - Output: `$ tsc --noEmit`
- `bun test test/minions.test.ts > /tmp/qidem-tests.txt 2>&1; echo EXIT=$?`
  - `EXIT=0`
  - Summary: `183 pass`, `0 fail`, `628 expect() calls`, `Ran 183 tests across 1 file.`
- Broader minions unit cluster:
  - `EXIT=0`
  - Summary: `642 pass`, `0 fail`, `2421 expect() calls`, `Ran 642 tests across 35 files.`
- `bun run build:llms > /tmp/qidem-build-llms.txt 2>&1; echo EXIT=$?`
  - `EXIT=0`
  - Regenerated command completed; no generated bundle diff remained.
- `bun test test/build-llms.test.ts > /tmp/qidem-build-llms-test.txt 2>&1; echo EXIT=$?`
  - `EXIT=0`
  - Summary: `12 pass`, `0 fail`, `98 expect() calls`, `Ran 12 tests across 1 file.`

## Parity and Migration Notes

- No schema migration was needed.
- The existing unique idempotency-key index remains valid because terminal rows are
  re-armed in place.
- JSONB values continue to use the repo-sanctioned raw bind style (`$N::jsonb`);
  no `JSON.stringify(... )::jsonb` pattern was introduced.
- PGLite coverage passed. Real Postgres E2E was not run because this environment has
  no configured `DATABASE_URL`/`.env.testing`, and Docker is unavailable:
  `Cannot connect to the Docker daemon at unix:///Users/jarvis/.orbstack/run/docker.sock.`

## Upstream PR Readiness

Ready for upstream PR review. The change is scoped to queue idempotency behavior,
keeps live dedup intact, avoids migrations, documents the current behavior, and
adds regressions for the wedge scenario and every terminal status.
