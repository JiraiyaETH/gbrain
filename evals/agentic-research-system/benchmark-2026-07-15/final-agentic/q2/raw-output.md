# Decision memo: concurrent AI agents over a Supabase/Postgres knowledge graph

## Verdict

**Recommend a queue-backed, bounded single-writer architecture (hybrid CQRS-lite): concurrent agents may read and submit commands, but only a small writer service/worker pool may commit graph mutations. Persist an immutable provenance/event ledger and update query-oriented graph projections transactionally (or through an idempotent projector when eventual consistency is acceptable). Put all runtime traffic behind one shared Supavisor/PgBouncer transaction-mode pool with an explicit global concurrency budget.**

This is the best default for GBrain because it makes provenance, conflict policy, retries, and connection usage properties of one enforced write path instead of conventions every agent must remember. It preserves GBrain's existing write-scope, source-scoping, and link-provenance direction without requiring pure event sourcing.

**Confidence:** high for the pattern choice; medium for sizing because GBrain's Supabase plan, workload, and hot-key distribution were not available.

**Recommendation strength:** **strong** for a prototype/production direction; **directional** for exact worker/pool counts until measured.

## Why this pattern wins

1. **Connection budget is explicit.** Agents do not hold database connections while thinking, calling tools, or waiting on models. They enqueue a command and release the client. A bounded writer pool and read semaphore cap active Postgres work. Supabase documents transaction pooling for transient clients and distinguishes pooler client limits from backend connection limits [S1].
2. **Conflicts are centralized.** Every mutation passes the same idempotency, authorization, expected-version, lock, validation, and projection code. No agent can silently bypass the policy by issuing a direct table update.
3. **Provenance is first-class.** The command is linked to an agent run, model/provider, prompt/tool-call hash, source references, retrieval timestamp, confidence, and causal parent. The immutable event is the audit fact; the current graph is a rebuildable projection.
4. **Failure is recoverable.** PGMQ visibility timeouts, archival, and retryable consumption provide durable work handoff [S2]. A failed worker does not lose the command; a duplicate delivery is harmless when the command/event key is unique and the projector is idempotent.
5. **It avoids overbuilding.** Pure event sourcing/CQRS is a valid upper bound, but Microsoft warns that it changes concurrency, schema evolution, and query behavior and is costly to migrate to/from [S8]. GBrain should retain the useful event/provenance ledger and projection boundary without making every read a replay.

## Recommended logical architecture

```text
AI agents (many, bursty, untrusted writers)
  ├─ scoped read API/RPC/Data API + RLS  ───────────────┐
  └─ command API: {command_id, aggregate, expected_version, payload, provenance}
                                                        │
                                     one shared client pool + semaphore
                                                        │
                         Postgres transaction pooler (Supavisor/PgBouncer)
                                                        │
                          PGMQ command queue (durable, visibility timeout)
                                                        │
                1..W bounded writer workers; no per-agent DB pools
                                                        │
          ┌────────────────────── one short DB transaction ─────────────────────┐
          │ authorize/RLS context → idempotency check → per-aggregate gate      │
          │ validate expected version → append immutable event/provenance        │
          │ update current node/edge/fact projection → outbox/projector marker  │
          └─────────────────────────────────────────────────────────────────────┘
                                                        │
                         read projections: nodes, edges, facts, search/vector
                                                        │
                         audit/replay: immutable event + provenance ledger
```

### Command and provenance records

Minimum durable tables (names illustrative):

- `agent_runs(run_id, agent_id, model, provider, prompt_hash, started_at, parent_run_id, tool_trace_hash, tenant/source scope)`.
- `kg_commands(command_id, idempotency_key, aggregate_key, expected_version, command_type, payload, provenance, status, attempts, enqueued_at, completed_at)` with a unique key on `(source_id, idempotency_key)`.
- `kg_events(event_id, source_id, aggregate_key, aggregate_version, event_type, payload, actor_agent_id, run_id, source_refs, retrieved_at, model/provider, confidence, content_hash, causal_parent_id, created_at)`; immutable, append-only, unique `(source_id, aggregate_key, aggregate_version)` and usually unique `command_id`.
- `kg_nodes` / `kg_edges` / `kg_facts` as query projections, each carrying `source_id`, `current_version`, `valid_from/valid_to` or supersession metadata, and `last_event_id`. For edges, retain `link_source`/`link_type` rather than anonymous adjacency.
- `projection_checkpoints` and `dead_letter_commands` for lag, replay, and poison-message operations.

Provenance must travel with the command/event, not be reconstructed from logs after the fact. For source-backed facts, store the canonical source identifier/URL, exact locator or excerpt hash where available, retrieval time, and extraction method. Do not store only a model's free-form citation string.

### One command transaction

1. Validate schema, tenant/source scope, agent authorization, and command TTL.
2. Insert-or-return by idempotency key. PostgreSQL's atomic conflict handling is appropriate for this boundary; do not treat an upsert alone as semantic conflict resolution.
3. Serialize only the affected aggregate(s): prefer an `entities.version` row lock for ordinary node mutations; use `pg_advisory_xact_lock(hash(source_id, aggregate_key))` for a short-lived cross-row graph operation. PostgreSQL documents transaction-level advisory locks as auto-releasing at transaction end [S3]. Do **not** use session-level advisory locks through transaction pooling.
4. Check `expected_version` against the aggregate version. If stale, return `CONFLICT_STALE_VERSION` and let the agent re-read/reason; do not silently overwrite. If the operation is commutative (for example, adding a new provenance-tagged observation), append it with the next version rather than merging text in place.
5. Append one immutable event with all provenance fields and increment the aggregate version. Unique constraints and `ON CONFLICT` make retries idempotent; they do not decide which conflicting semantic assertion is true.
6. Update the current projection in the same transaction for commands that require read-your-write semantics. For expensive work (embeddings, enrichment, cross-source indexing), commit the event plus an outbox/queue message and project asynchronously. Supabase's own automatic-embedding pattern uses triggers, PGMQ, scheduled workers, batching, and visibility-timeout retries [S7].
7. Commit before acknowledging/deleting the queue message. On transient deadlock/serialization failure, retry with bounded exponential backoff; PostgreSQL requires retry handling for Serializable failures (`40001`) [S4]. After the retry budget, move the command to a dead-letter table/queue with the full provenance.

### Connection-budget policy

Use one application-wide pool per service, not one pool per agent or worker. Choose exactly one runtime pooler topology unless there is a measured reason otherwise; Supabase warns that combining poolers can increase the risk of hitting the database maximum [S1]. Prefer transaction mode for short RPC/command transactions; transaction mode does not support prepared statements [S1].

Define the budget before deploying:

```text
P_app = P_db_max - P_supabase_reserved - P_admin_safety
P_app = W_writer + R_read + H_headroom
active_queries <= P_app
```

`W_writer` is a small fixed worker pool, `R_read` is a semaphore for concurrent read/RPC operations, and `H_headroom` absorbs migrations, health checks, and retries. The numeric values must come from the project plan and observed `pg_stat_activity`/pool metrics, not from agent count. Do not let model calls occupy a checked-out connection. Keep transactions short and never wait for an LLM or network call inside them. PostgreSQL explicitly recommends controlling active connections and avoiding long/idle transactions when using strong isolation [S4].

If queue latency grows, scale workers only up to the measured connection ceiling; do not let autoscaling create unbounded pools. If the system needs more write throughput, partition commands by aggregate key and increase `W_writer` only after observing lock wait, serialization-failure, queue age, and connection saturation.

## Viable patterns compared

| Pattern | Provenance | Conflict behavior | Connection budget | Operational fit for GBrain | Verdict |
|---|---|---|---|---|---|
| **A. Direct CRUD from every agent via pooler** | Weak unless every caller uses a shared write API; audit often becomes an afterthought | Row locks/upserts prevent some races but stale read-modify-write can overwrite or lose intent; requires version checks | Poor by default: fan-out creates client/pool pressure; can be improved with one shared pool | Simple, low latency, but unsafe as the default trust boundary | Use only for low-risk reads or tightly wrapped commands |
| **B. Direct writes + optimistic concurrency** | Better if each command carries run/source/version metadata | Good for low contention; stale versions fail and retry; cross-aggregate invariants remain hard | Moderate with a single shared pool and bounded clients | Good incremental migration; still relies on every writer using the protocol | Viable building block, not the whole architecture |
| **C. Direct writes + row/advisory locks** | Locks serialize but do not create an audit history | Strong for hot aggregates if all writers cooperate; deadlocks/lock waits and lock ordering matter; `SKIP LOCKED` is for queue consumers, not general graph consistency [S3, S5] | Moderate; locks can lengthen transactions and consume scarce connections | Useful inside the writer transaction, not as a distributed agent protocol | Use transaction-level locks narrowly |
| **D. Queue + single writer / bounded writer pool** | Strong: one command envelope and one immutable commit path | Strong: queue ordering/backpressure plus idempotency/version/lock checks; async projection trade-off | Best: fixed writer count and queueing absorb bursts | Matches Supabase PGMQ and GBrain's scoped/provenance direction | **Recommended default** |
| **E. Pure event sourcing + CQRS** | Strongest: immutable event stream, replay, temporal audit | Optimistic append/versioning is clear; projections are eventually consistent and rebuildable | Excellent write-path control, but replay/projector workloads add complexity | Appropriate only if temporal reconstruction/replay is a primary requirement | Defer; adopt the ledger/projection subset now |
| **F. Serializable everywhere** | Neutral by itself; add provenance separately | Strong anomaly prevention, but aborts/retries (`40001`) and predicate-lock overhead increase under contention [S4] | Requires especially disciplined active-connection limits | Apply to narrow cross-aggregate commands, not every read/write | Targeted tool, not default isolation for all work |

## Important distinctions

- **RLS is authorization, not serialization.** Enable RLS on exposed graph tables and write policies for source/tenant and operation; Supabase documents `USING`/`WITH CHECK` semantics and warns about service-role bypass [S6]. Still enforce expected versions and provenance in the writer.
- **A queue is not exactly-once business execution.** PGMQ visibility timeouts make failed messages visible again; duplicates can occur after a timeout. The command idempotency key, immutable event uniqueness, and idempotent projector are the correctness layer [S2].
- **A lock is not provenance.** Advisory locks coordinate cooperating transactions but do not say which agent asserted what or why [S3].
- **Event sourcing is not required for auditability.** A durable append-only `kg_events` table plus current projections provides most provenance value at lower migration cost; go full event sourcing only when replay/time-travel requirements justify it [S8].
- **`ON CONFLICT` is not semantic conflict resolution.** It prevents duplicate-key races atomically, but the writer must still reject stale versions or record competing observations instead of silently choosing a winner.

## GBrain-specific rollout

1. Introduce a command envelope and immutable `agent_runs`/`kg_events` tables; retain existing page/link provenance fields and source scopes.
2. Route all subagent/remote mutation operations through one write RPC/service. Keep direct table writes disabled for agent roles; use RLS and least-privilege grants [S6].
3. Start with one writer worker and one shared transaction-mode pool. Add a queue for expensive enrichment/embedding/index jobs; use PGMQ visibility timeout and a dead-letter path [S2, S7].
4. Implement `expected_version`, unique idempotency keys, transaction-level aggregate locks only where needed, and bounded retries for `40001`/deadlocks [S3, S4].
5. Measure queue age, writer utilization, lock waits, serialization failures, projection lag, duplicate command rate, and `pg_stat_activity`. Increase writers/read permits only under the predeclared budget.
6. Add replay/rebuild tooling for projections before considering full event sourcing. A cheap load test should vary agent fan-out, hot-aggregate skew, duplicate delivery, worker crash, and pool saturation.

## What would change the answer

- If GBrain proves that all writes are rare, synchronous, and low-contention, Pattern B (optimistic concurrency with one shared pool) may be enough.
- If historical reconstruction, multi-version truth, or audit/regulatory requirements dominate, promote Pattern E toward full event sourcing and CQRS.
- If cross-aggregate invariants become frequent and strict, use narrowly scoped Serializable command transactions with retry, not a global serializable setting.
- If queue lag violates product latency, keep queueing at the command boundary but apply the projection inline for the latency-critical aggregate, retaining the same event/provenance/idempotency protocol.

## Evidence boundary

External acquisition was capped at eight strong sources and completed before synthesis. The Brain lookup was real but thin: it found GBrain's architecture index, atomic write-through, operation trust scopes, source-scoped reads, and link provenance; it did not contain a prior Supabase/Postgres multi-agent write decision. Exact Supabase plan limits, GBrain contention distribution, and driver behavior were not tested. The recommendation is therefore an evidence-backed architecture direction, not a claimed benchmark result.

## Citation audit status

Every material external fact in this memo maps to S1–S8. Architecture judgments are labeled as recommendation, inference, or rollout guidance. No search snippet is used as a citation; browser DOM reads were used for the included source bodies. See `source-ledger.md` and `claim-ledger.md`.
