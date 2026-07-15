# Source ledger

## Search log

| Time | Lane | Query / URL | Tool | Result | Include? | Reason |
|---|---|---|---|---|---|---|
| 08:51 | Brain | Supabase/Postgres knowledge graph provenance concurrency | `gbrain search` | No results | N/A | Recorded bounded Brain gap. |
| 08:51 | Brain | shared knowledge graph provenance conflicting writes connection budget GBrain | `gbrain query` | Found `docs/architecture/key_files` | Yes (Brain) | Existing GBrain invariants; see brain-context.md. |
| 08:52 | Web/Docs | Supabase connection pooling / Supavisor modes | `web_search`, browser DOM read | S1 | Yes | Official current connection guidance and pool-budget semantics. |
| 08:52 | Web/Docs | Supabase pgmq | `web_search`, browser DOM read | S2 | Yes | Official queue semantics, visibility timeout, archive/replay. |
| 08:52 | PostgreSQL | advisory locks | `web_search`, browser DOM read | S3 | Yes | PostgreSQL current docs; transaction-vs-session lock behavior. |
| 08:52 | PostgreSQL | transaction isolation / Serializable | `web_search`, browser DOM read | S4 | Yes | PostgreSQL current docs; retry and connection-control guidance. |
| 08:52 | PostgreSQL | `SKIP LOCKED` queue consumers | `web_search`, browser DOM read | S5 | Yes | PostgreSQL current SELECT docs; queue-only suitability caveat. |
| 08:52 | Web/Docs | Supabase RLS | `web_search`, browser DOM read | S6 | Yes | Official authorization boundary guidance. |
| 08:52 | Web/Docs | Supabase automatic embeddings queue pattern | `web_search`, browser DOM read | S7 | Yes | Official queue + trigger + async worker + retry pattern analogous to projections. |
| 08:52 | Architecture | event sourcing append-only events / CQRS | `web_search`, browser DOM read | S8 | Yes | Microsoft Architecture Center; authoritative trade-offs and concurrency/provenance pattern. |

## Included source cards

| ID | Title | Canonical URL | Class / authority | Published | Accessed | Claims supported | Caveats |
|---|---|---|---|---|---|---|---|
| S1 | Connect to your database | https://supabase.com/docs/guides/database/connecting-to-postgres | Official docs / primary | unknown | 2026-07-15T08:52+0700 | Pooler modes, transaction mode for transient clients, pool-size totals, avoid accidental double-pooling, client-vs-backend limits | Supabase product guidance; exact available capacity is plan-specific. |
| S2 | PGMQ Extension | https://supabase.com/docs/guides/queues/pgmq | Official docs / primary | unknown | 2026-07-15T08:52+0700 | Postgres-native queue, visibility timeout, retryable reads, archive/replay, at-most-once `pop` caveat | “Exactly once” is bounded by visibility window and consumer behavior; do not treat it as global exactly-once processing. |
| S3 | Explicit Locking | https://www.postgresql.org/docs/current/explicit-locking.html | PostgreSQL docs / primary | PostgreSQL 18 current | 2026-07-15T08:53+0700 | Transaction-level advisory locks auto-release; session-level locks persist; locks are cooperative and visible in pg_locks; deadlock/retry caveat | Advisory locks enforce nothing unless every writer follows protocol; lock memory is finite. |
| S4 | Transaction Isolation | https://www.postgresql.org/docs/current/transaction-iso.html | PostgreSQL docs / primary | PostgreSQL 18 current | 2026-07-15T08:53+0700 | Serializable emulates serial execution, can fail SQLSTATE 40001, requires retries; control active connections and keep transactions short | Serializable is not a substitute for idempotency or provenance. |
| S5 | SELECT | https://www.postgresql.org/docs/current/sql-select.html | PostgreSQL docs / primary | PostgreSQL 18 current | 2026-07-15T08:53+0700 | `NOWAIT`/`SKIP LOCKED`; skipped rows give inconsistent view and are suitable for queue-like consumers | Not a general graph-consistency primitive. |
| S6 | Row Level Security | https://supabase.com/docs/guides/database/postgres/row-level-security | Official docs / primary | unknown | 2026-07-15T08:54+0700 | Enable RLS on exposed tables; policies act per table/operation; INSERT `WITH CHECK`, UPDATE `USING` + `WITH CHECK`; service role bypasses RLS | RLS is authorization, not write serialization; security-definer functions need careful privileges/search path. |
| S7 | Automatic embeddings | https://supabase.com/docs/guides/ai/automatic-embeddings | Official docs / primary | unknown | 2026-07-15T08:54+0700 | Triggers enqueue work, PGMQ/cron/Edge Functions process asynchronously in batches, visibility timeouts enable retries, queueing controls concurrency | Example targets embeddings; applying it to graph projections is an architectural analogy. |
| S8 | Event Sourcing pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing | Architecture Center / authoritative secondary | unknown | 2026-07-15T08:55+0700 | Append-only immutable events preserve auditability; queues decouple handlers; optimistic concurrency rejects stale appends; projections/CQRS scale reads; complexity/eventual consistency trade-offs | General pattern, not Supabase-specific; use as design evidence, not a GBrain implementation prescription. |

## Rejected / not used

| Candidate | Reason |
|---|---|
| Search-result snippets as citations | Discovery only; body evidence was obtained via browser DOM reads. |
| Vendor comparison/SEO pages | Not needed after official Supabase/PostgreSQL sources met the evidence bar. |
| Perplexity | Explicitly excluded; benchmark baseline already exists. |
| Pure Kafka/event-store prescription | No need to add an external system under the strict connection/ops budget; not researched as a required dependency. |

## Evidence gaps

| Gap | Impact | Disposition |
|---|---|---|
| GBrain's exact Supabase plan/connection ceiling | Cannot choose numeric pool sizes | Use formula and reserved-budget policy; measure `pg_stat_activity`/pool telemetry before setting caps. |
| GBrain's contention distribution and graph aggregate boundaries | Cannot prove hot-key rate | Recommend per-aggregate keys and a bounded load test before widening writer parallelism. |
| Exact Supabase transaction-pool driver behavior for every GBrain client | Driver-specific | Use short explicit transactions/RPCs; disable prepared statements where transaction mode requires it; test client. |
