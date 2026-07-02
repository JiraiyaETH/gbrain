---
name: cron-scheduler
version: 1.0.0
description: |
  Schedule management with staggering, quiet hours, and wake-up override.
  Validates schedules, prevents collisions, and gates delivery during quiet hours.
triggers:
  - "schedule a job"
  - "cron"
  - "quiet hours"
  - "what jobs are running"
tools:
  - search
  - get_page
  - put_page
mutating: true
---

# Cron Scheduler

> **Convention:** See `skills/conventions/test-before-bulk.md` — test every cron job on 3-5 items first.

## Contract

This skill guarantees:
- Schedule staggering: max 1 job per 5-minute slot, no collisions
- Quiet hours gating: timezone-aware, with user-awake override
- Thin job prompts: jobs say "Read skills/X/SKILL.md and run it" (no inline 3000-word prompts)
- Explicit execution surface at creation time: deterministic jobs use no-agent/script or Minions shell; LLM cron jobs pre-define the narrowest `enabled_toolsets` exposed to that specific job
- Tool least-privilege: a scheduled job must not inherit the whole agent cockpit unless Jiraiya explicitly approves the broad surface
- Idempotency: jobs can run twice without duplicate side effects
- Results saved as reports: `reports/{job-name}/{YYYY-MM-DD-HHMM}.md`

## Phases

1. **Define job.** Name, schedule (cron expression), skill to run, timeout, delivery target, and execution surface.
2. **Pre-define job tool exposure.** Before creation, choose one:
   - Deterministic/status/watchdog/change-detection job → use `script` with `no_agent=true`; green/no-change runs print nothing.
   - GBrain durable shell/background work → submit via Minions shell with an idempotency key; do not wrap it in an LLM `agentTurn`.
   - LLM synthesis/research/review job → set explicit `enabled_toolsets` to the smallest adequate set for this job, e.g. `['web']`, `['terminal','file']`, `['gbrain']`, or `['telegram_mtproto_readonly','gbrain']`.
   - Reject or revise any agentic cron spec where `enabled_toolsets` is null, unless the operator explicitly approves broad inherited tools.
3. **Validate schedule.** Check no collision with existing jobs (5-minute offset rule).
   - Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50
   - If collision detected, suggest the next available slot
4. **Check quiet hours.** Default: 11 PM - 8 AM local time.
   - Override: user-awake flag (if user is active, quiet hours suspended)
   - During quiet hours: save output to held queue
   - Morning contact releases the backlog
5. **Register with host scheduler.** OpenClaw cron, Railway cron, crontab, or process manager. **Each registered entry should execute via Minions, not `agentTurn`.** See `skills/conventions/cron-via-minions.md` for the rewrite pattern (PGLite uses `--follow`, Postgres uses fire-and-forget + `--idempotency-key` on the cycle slot). GBrain's v0.11.0 migration auto-rewrites entries for built-in handlers; host-specific handlers need a code-level registration per `docs/guides/plugin-handlers.md`.
6. **Write thin prompt.** Job prompt is one line: "Read skills/{name}/SKILL.md and run it." Store detailed procedure in the skill, not inline in the cron prompt.

## Idempotency Requirement

Every cron job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use checkpoint state files to track progress and resume interrupted runs
- Check for existing output before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Multi-source brains: use `sync --all`, not per-source entries

When the brain has 2+ active sources (anything `gbrain sources list` shows
with a non-null `local_path` that isn't archived), use one consolidated
cron line instead of N per-source entries.

**Preferred (multi-source)**:

```cron
*/5 * * * * gbrain sync --all --parallel 4 --workers 4 --skip-failed
```

This replaces N per-source lines AND auto-picks-up future sources without
a crontab edit. Concurrency budget: `parallel × workers × 2 ≈ 32`
connections during the wave (each per-file worker opens its own
2-connection pool). Stay under your Postgres `max_connections` setting.

**Avoid (legacy)**: separate `gbrain sync --source default` and
`gbrain sync --source zion-brain` entries staggered by 5 minutes. They
require manual deconfliction every time a new source is added, and a
slow source can race a fast source on the legacy global `gbrain-sync`
lock (v0.40.3.0+ uses per-source `gbrain-sync:<sourceId>` locks but the
per-source cron pattern doesn't benefit from the parallelism that
`--all --parallel` actually delivers).

`gbrain doctor` surfaces the recommended line as a `sync_consolidation`
check whenever it detects 2+ active sources. Paste-ready from there.

## Migrating Ad-Hoc Cron Into Managed Jobs

When replacing a hand-written system cron entry with a managed scheduler job,
prove delivery and duplicate-run safety before cleanup:

1. Inspect the existing entry and preserve its schedule, command, log path, and
   delivery intent.
2. Move deterministic behavior into a small script or command. For script-only
   monitors, prefer an agentless/no-agent path; green/no-change runs should
   print nothing so they do not generate noise.
3. Let the scheduler own routing/delivery when possible. Avoid direct delivery
   code inside the watcher if scheduler delivery can handle it.
4. Smoke the command locally before scheduling: syntax/compile check, a forced
   harmless alert mode, and a normal green run proving stdout is empty.
5. Create the managed job with explicit schedule, delivery target, command, and
   enabled state; verify the job list reflects those values.
6. Prove delivery with a temporary smoke job or dry-run artifact before removing
   the old cron block.
7. Only after successful delivery proof, remove the old system cron entry and
   re-check for zero stale matches.
8. Re-list managed jobs and run the production command normally once more.

Report-producing jobs must also satisfy the Cron Brain-Report Contract in
`skills/_brain-filing-rules.md`: write valid frontmatter, validate it before
claiming success, and keep full report artifacts separate from short operator
notifications.

## Anti-Patterns

- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in cron jobs (use skill file references)
- Running cron jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (not idempotent)
- Sending notifications during quiet hours (save to held queue instead)
- Separate per-source `gbrain sync --source <id>` cron entries when
  `gbrain sync --all --parallel N --workers N` would replace them with
  one line that auto-picks-up future sources.
- Leaving an old cron entry active after the managed scheduler replacement is
  proved
- Reporting a brain page write as complete before frontmatter validation passes
