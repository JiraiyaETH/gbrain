# Carry branch port receipt — 2026-06-11

Carry worktree: /Users/jarvis/worktrees/gbrain/20260610-pack-frontmatter-links/repo
Carry branch commit: 9625d05d fix: port subagent stall and facts drain carry fixes
Pushed to fork: JiraiyaETH/gbrain alex/gbrain/dream-fixes-20260610

## Ported fixes
- Subagent stall fix from /Users/jarvis/gbrain commit ec7263ca: per-tool timeout/retry in gateway + subagent handler; retryJob started_at/timeout_at reset; minion/subagent timeout regression tests.
- facts:absorb drain fix: CLI background drain 1s/default → 30s, disconnect hard guard 10s → 45s, regression test for both CLI disconnect paths.
- AGENTS.md wrapper-discipline note added.

## Verification on carry branch
- `bun test test/subagent-tool-timeout.test.ts test/minions.test.ts test/cli-background-drain-timeout.test.ts --max-concurrency=2` → 182 pass, 0 fail.
- `bun run typecheck` → `tsc --noEmit` passed.
- `git diff --cached --check` passed before commit.
- Heuristic cached secret scan only matched test token-count field names (`input_tokens`, `output_tokens`, cache token counters); no credentials.

## Wrapper / daemon discipline
- Did not run `bun link`, `bun install -g`, or install any binary over `~/.local/bin/gbrain` or `~/.bun/bin/gbrain`.
- Verified both `~/.local/bin/gbrain` and `~/.bun/bin/gbrain` are shell scripts pointing at `/Users/jarvis/worktrees/gbrain/20260610-pack-frontmatter-links/repo/src/cli.ts`.
- `~/.bun/bin/gbrain` had drifted back to `/Users/jarvis/gbrain/src/cli.ts`; corrected it to the carry worktree wrapper target.
- No daemon restart performed. Already-running long-lived processes only load source changes on respawn/restart. Per cockpit instruction, no immediate restart is required if the cockpit-managed supervisor/worker will respawn before tonight's run; if a currently-running worker must use these exact changes before its next respawn, cockpit must restart/respawn that worker.

## Upstream PR
- Clean upstream branch from `origin/master`: `/Users/jarvis/worktrees/gbrain/subagent-stall-upstream-20260611`
- Commit: 005c721a fix: bound subagent tool stalls and retry timestamps
- PR: https://github.com/garrytan/gbrain/pull/2086
- Upstream verification: `bun install --ignore-scripts`; `bun test test/subagent-tool-timeout.test.ts test/minions.test.ts --max-concurrency=2` → 180 pass, 0 fail; `bun run typecheck` passed.
- GitHub PR state: mergeable; checks are `action_required` on fork workflows, not failing.

## Left untouched / out of commits
- `skills/_brain-filing-rules.{json,md}` symlink typechanges left unstaged.
- Existing carry dirty files from prior cockpit work left unstaged: `src/commands/recall.ts`, `src/commands/report.ts`, `src/core/operations.ts`, `test/facts-recall-render.test.ts`, and previous untracked specs directories.
