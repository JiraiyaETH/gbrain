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
- Idempotency: jobs can run twice without duplicate side effects
- Results saved as reports: `reports/{job-name}/{YYYY-MM-DD-HHMM}.md`

## Phases

1. **Define job.** Name, schedule (cron expression), skill to run, timeout.
2. **Validate schedule.** Check no collision with existing jobs (5-minute offset rule).
   - Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50
   - If collision detected, suggest the next available slot
3. **Check quiet hours.** Default: 11 PM - 8 AM local time.
   - Override: user-awake flag (if user is active, quiet hours suspended)
   - During quiet hours: save output to held queue
   - Morning contact releases the backlog
4. **Register with host scheduler.** OpenClaw cron, Railway cron, crontab, or process manager. **Each registered entry should execute via Minions, not `agentTurn`.** See `skills/conventions/cron-via-minions.md` for the rewrite pattern (PGLite uses `--follow`, Postgres uses fire-and-forget + `--idempotency-key` on the cycle slot). GBrain's v0.11.0 migration auto-rewrites entries for built-in handlers; host-specific handlers need a code-level registration per `docs/guides/plugin-handlers.md`.
5. **Write thin prompt.** Job prompt is one line: "Read skills/{name}/SKILL.md and run it."

## Idempotency Requirement

Every cron job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use checkpoint state files to track progress and resume interrupted runs
- Check for existing output before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Operational Audit / Removal

When asked which jobs are enabled, operational, stale, or safe to delete:
1. List jobs from the scheduler and check scheduler health/status.
2. For any job with a recent `last_run_at`, inspect the matching cron output artifact, not just `last_status`.
   - Hermes scheduler `last_status: ok` means the cron runner completed, not necessarily that the job's domain checks passed.
   - A job can be runner-OK while its final response reports a maintenance failure, missing skill attachment, timeout, or manual follow-up.
3. For removals, confirm user approval unless the request explicitly authorizes deletion. Then remove by job ID and verify with a fresh list/status.
4. After deletion, report the remaining active jobs and any suspicious-but-not-fatal findings from output artifacts.

Typical Hermes output path: `~/.hermes/profiles/<profile>/cron/output/<job_id>/<timestamp>.md`.

## Anti-Patterns

- Treating scheduler `ok` as proof the underlying maintenance/audit succeeded
- Deleting paused/stale jobs before explicit approval
- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in cron jobs (use skill file references)
- Running cron jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (no duplicate pages, no duplicate timeline entries)
- Sending notifications during quiet hours (save to held queue instead)
