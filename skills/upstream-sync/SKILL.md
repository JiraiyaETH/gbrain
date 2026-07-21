---
name: upstream-sync
version: 1.0.0
description: >
  Pull Garry's upstream (origin/master) into this fork safely. The whole
  procedure for the operator ask "Garry moved upstream — pull his commits."
  Validated end-to-end on the 2026-07-21 sync (28 commits, v0.42.63.1).
triggers:
  - "pull Garry's commits"
  - "sync with upstream"
  - "Garry moved upstream"
tools: [git, bash, gbrain]
mutating: true
writes_to: /Users/jarvis/gbrain (master), bin/gbrain, ~/.gbrain/runtimes/
---

# Upstream sync — the fork's standing pull procedure

Strategy: **merge commit resolved in a throwaway worktree, fast-forwarded onto
master**. Never rebase (116-commit replay re-litigates every seam per commit
and rewrites shared history on the live checkout); never per-commit cherry-pick
(re-hits the version trio N times). Master NEVER leaves master (IRON RULE — the
checkout is shared by all live sessions).

## Procedure

1. **Recon + safety net**
   ```sh
   cd /Users/jarvis/gbrain && git fetch origin
   git rev-list --left-right --count master...origin/master   # ahead/behind
   git log --oneline master..origin/master                    # what's coming
   git tag pre-upstream-sync-$(date +%Y%m%d)
   ```
   Working tree must be clean. Read the incoming commits: anything touching
   `src/core/migrate.ts` gets the migration-collision check below.

2. **Worktree merge** (temp branch — two worktrees can't share master)
   ```sh
   git worktree add -b sync/upstream-$(date +%Y%m%d) \
     ~/worktrees/gbrain/upstream-sync-$(date +%Y%m%d) master
   cd ~/worktrees/gbrain/upstream-sync-$(date +%Y%m%d)
   git merge origin/master --no-commit --no-ff
   ```

3. **Resolve seams.** Standing rules:
   - **Version trio**: `VERSION`/`package.json`/`CHANGELOG.md` → new version
     strictly greater than BOTH sides, `.MICRO` channel preferred
     (`0.42.63.0` + fork `0.42.62.1` → `0.42.63.1`). Keep both CHANGELOG
     entries, ordered by version descending, new sync entry on top. Run the
     3-line trio audit (CLAUDE.md) before committing.
   - **MIGRATION VERSION COLLISION (the silent killer):** if both sides added
     a migration with the same `version:` number, git may AUTO-MERGE it
     without conflict — check EXPLICITLY:
     `grep -n "version: 1" src/core/migrate.ts | sort | uniq -d` on the
     version numbers. The fork's number WINS (the live brain already recorded
     it); renumber upstream's to the next free number and leave a comment.
     Skipping this means upstream's migration NEVER RUNS on the live brain —
     no error, just silently missing behavior.
   - `src/core/schema-embedded.ts` is GENERATED — never hand-merge; run
     `bun run build:schema` after `migrate.ts`/`schema.sql` settle.
   - Engine parity: any new engine method/SQL must land in BOTH
     `postgres-engine.ts` and `pglite-engine.ts` (the parity e2e test pins it).
   - Fork conventions that win on conflict: model-aware `isAvailable('chat',
     model)` in enrich, `sourceId` scoping in cycle/jobs handlers, the rearm
     guard in `minions/queue.ts`. Upstream additions (e.g. `deadlineAtMs`)
     COMPOSE alongside — keep both.
   - `skills/RESOLVER.md` + `skills/manifest.json`: accept-both; fork rows are
     additive inserts.

4. **Validate in the worktree**
   ```sh
   bun install && bun run build:schema
   bun run typecheck > /tmp/sync_tc.txt 2>&1; echo EXIT=$?
   bun test > /tmp/sync_units.txt 2>&1; echo EXIT=$?   # file-redirect, never pipe
   ```
   Full-suite quirk on this Mac: PGLite WASM tests flake/hang under load
   (macOS WASM bug + contention). If the suite hangs or mass-fails with
   "PGLite failed to initialize its WASM runtime / Out of memory": kill it,
   extract the failing FILES (`grep -oE 'test/[a-z0-9./-]+\.test\.ts'` on the
   error stacks), and re-run each file in isolation with `timeout 300`.
   Isolated-pass = suite artifact, not a regression. Never run the suite while
   other heavy work (workflows, second suites) shares the machine.

5. **Commit merge → land on master (append-only)**
   ```sh
   git add -A && git commit          # in the worktree
   cd /Users/jarvis/gbrain
   git merge --ff-only <merge-sha>
   git worktree remove ~/worktrees/gbrain/upstream-sync-<date>
   git branch -d sync/upstream-<date>
   ```

6. **Deploy (the part everyone forgets)**
   ```sh
   bun build --compile --outfile bin/gbrain src/cli.ts
   GBRAIN_DISABLE_DIRECT_POOL=1 ./bin/gbrain doctor   # fires pending migrations; verify schema_version = latest
   # Sealed runtime for the nightly lanes:
   ops/runtime/build-runtime.sh ~/.gbrain/runtimes/versioned-$(git rev-parse --short=12 HEAD)
   #   (build-runtime.sh verifies every PINNED_*_SHA256 vs its payload — a
   #    mismatch means a skill edit shipped without its pin; fix the pin in
   #    ops/runtime/meeting-complete.py first.)
   # Repoint every plist on the old runtime + reload:
   cd ~/Library/LaunchAgents && grep -l "versioned-<OLD>" *.plist
   #   sed old→new in each, then per plist: launchctl bootout gui/$UID/<label>;
   #   launchctl bootstrap gui/$UID <plist>
   launchctl kickstart -k gui/$(id -u)/com.gbrain.serve-http
   curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3131/health  # expect 200
   ```

7. **Close**
   ```sh
   git push fork master --tags
   GBRAIN_DISABLE_DIRECT_POOL=1 ./bin/gbrain eval gate --qrels ~/.gbrain/qrels/jiraiya/  # goldsets still PASS
   ```
   Next morning: confirm the dream receipt + lanes ran clean on the new
   runtime (`~/.gbrain/export-receipts/`, lane logs).

## Rollback

`git reset --hard pre-upstream-sync-<date>` on the main checkout, rebuild
`bin/gbrain`, rebuild/repoint the runtime from that tag, kickstart lanes. An
already-applied upstream migration is usually benign (verify its body before
assuming); no reverse migration exists.

## Anti-patterns

- Rebasing master or branch-swapping the live checkout (shared by all sessions).
- Trusting git's auto-merge on `migrate.ts` — the version-collision check is
  manual and mandatory.
- Landing without rebuilding BOTH the binary AND the sealed runtime — lanes
  keep executing old skill text otherwise.
- Piping test output through tail/head (exit code lies, failures truncated).
