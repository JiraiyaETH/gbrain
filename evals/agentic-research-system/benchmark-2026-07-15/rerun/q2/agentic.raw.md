## Recommendation

Use a **queue-mediated, partitioned single-writer command path** in front of Supabase/Postgres:

- Agents are read-heavy clients and submit graph mutations as idempotent commands rather than opening database pools of their own.
- Commands are serialized per graph scope—preferably a Brain/workspace/source partition—by a logical writer implemented with the existing worker/queue machinery.
- Each accepted command appends a provenance-bearing revision/event and updates the materialized pages, facts, and edges in one database transaction.
- The writer performs an expected-version check. A stale command is rejected or routed to an explicit merge/reconciliation path; it is never silently applied over a newer revision.
- Reads use the shared pooler path. Long-running DDL/bulk work remains on the capped direct/session path already provided by the connection manager.

This is a design recommendation derived from the current GBrain contracts and the stated requirements. The packet does not contain a finalized command-log schema, partition key, or Supabase plan-specific connection limit; those remain deployment decisions.

## Existing GBrain facts

The available Brain source corpus establishes the following:

- PostgresEngine plus Supabase is the production path for multi-user or multi-device use; PGLite is a single-process/local engine whose concurrent-access model is limited. The BrainEngine contract includes transactions, page versions, links and recursive graph traversal, raw data, and ingest-log operations. [S1]
- The connection manager routes reads through the Supabase transaction pooler on port 6543, with a default read pool size of 10. DDL and bulk work use a direct/session route on port 5432, with a default direct pool size of 3 and a longer statement timeout. The direct pool is initialized lazily behind a cached promise, so concurrent first callers share one initialization. Worker engines and transaction clones can inherit a parent manager and share pools. A kill switch can fall back to a single-pool path. [S2]
- Link operations retain `link_source` and `link_type`; reconciliation-managed sources are rejected for manual writes, and omitted manual provenance defaults to `manual`. Remote reads and graph/link reads are source-scoped. `put_page`'s local Markdown write-through is atomic through a temporary sibling followed by rename. [S3]
- MinionWorker already processes jobs concurrently with isolated per-job state, lock renewal, token-fenced completion, stall detection, retry handling, and connection-error recovery behavior. [S4]

These facts support centralizing admission and reusing shared pools. They do not, by themselves, prove that a command log or any particular partition key already exists in GBrain.

## Viable patterns

### 1. Shared writer with optimistic concurrency

All agents write to the same graph tables through the database, with transactions and an expected-version predicate such as `UPDATE ... WHERE version = expected_version`.

**Properties:**

- Lowest coordination overhead and the simplest synchronous write path.
- Provenance can be stored on each row or edge, but provenance recording does not prevent two agents from proposing contradictory facts.
- Optimistic checks detect collisions after concurrent agents have attempted the same logical mutation. The system must then reject, create a new revision, or reconcile asynchronously.
- Connection safety depends on every agent using a shared, bounded manager. Per-agent pools would undermine the connection-budget requirement.

This pattern is suitable when eventual convergence is acceptable and conflicts are ordinary, low-cost duplicates. It is not the default fit when the requirement is to prevent conflicting writes rather than merely detect or repair them.

### 2. Global single writer with a command log

Agents append commands to one serialized write stream. A writer validates and applies commands, records immutable revisions, and projects the current graph state for readers.

**Properties:**

- Gives the clearest ordering and strongest prevention of silent overwrites.
- Makes provenance a first-class part of the write record: agent identity, source/operation provenance, command ID, timestamp, input revision, and resulting revision can be retained for replay and audit.
- Keeps write connections concentrated in a small number of workers.
- Creates a global throughput and availability bottleneck. A slow or blocked scope can delay unrelated work unless the log is partitioned.
- Requires explicit idempotency, retry, projection, and replay semantics; none of those schemas is present in the current packet.

This is a strong integrity model but is unnecessarily coarse if independent Brains or workspaces can proceed concurrently.

### 3. Partitioned or sharded writers

Use single-writer semantics per stable scope—such as Brain, workspace, tenant, or source—while allowing different scopes to progress in parallel on the same physical Postgres database.

**Properties:**

- Preserves the conflict guarantees of serialization inside a scope while avoiding a single global bottleneck.
- Lets each command carry the partition key and provenance policy used to validate it.
- Fits the existing multi-source/source-scoped behavior and shared connection-manager inheritance. [S2][S3]
- Requires a defined ownership rule for every mutation. Cross-partition transactions, global aliases, and queries spanning scopes need an explicit coordinator or a carefully limited exception.
- The correct key is not established by the current Brain pages. Workspace/Brain is a reasonable default hypothesis, not an existing GBrain decision.

This is the preferred serialization granularity if the workload has meaningful independent scopes.

### 4. Read/write split and queue-mediated variants

Readers use pooled database access while writes enter a queue and are applied by workers. The queue is an admission-control and durability layer; the actual conflict policy can be global single-writer or partitioned single-writer.

**Properties:**

- Prevents agents from multiplying database pools and centralizes retries, idempotency, authorization, and write validation.
- Matches the existing MinionWorker capabilities for concurrent jobs, lock renewal, token fencing, stall handling, and retries. [S4]
- Allows a small fixed worker fleet to serve many logical agents.
- Introduces asynchronous visibility unless the command API waits for commit/projection acknowledgement. Read-after-write behavior must therefore be explicit.
- A queue alone does not prevent conflicting graph mutations; the worker must enforce scope serialization and expected-version checks.

For GBrain, queue mediation is best treated as the delivery mechanism for the partitioned single-writer design, not as a substitute for a conflict protocol.

## Provenance and conflict protocol

The recommended write contract is:

1. **Command envelope.** Require a stable idempotency key, agent/service identity, scope key, operation type, target entity or edge, expected entity revision, source/provenance fields, and the input/content hash observed by the agent.
2. **Immutable acceptance record.** Append the command outcome with received time, actor, source, parent revision, resulting revision, and validation status. Existing `link_source` and `link_type` remain the minimum link-level provenance fields. [S3]
3. **Transactional projection.** In one Postgres transaction, insert the accepted revision/event and update the materialized page/edge/fact rows. Store a pointer from the materialized row to the accepted revision/event.
4. **Expected-version fence.** Apply a mutation only when the stored version equals the command's expected version. On mismatch, return a conflict and retain the attempted command; do not overwrite the current row.
5. **Explicit merge path.** A merge or reconciliation operation creates a new revision with its own provenance. It must not erase the conflicting inputs.
6. **Idempotent retry.** Replaying the same command ID returns the original outcome. A worker retry after a connection failure must not create a second revision.
7. **Read semantics.** Return the committed revision or a durable pending status so an agent can distinguish “accepted,” “projected,” and “not applied.”

The existing version, transaction, link, raw-data, and ingest-log surfaces provide useful extension points for this protocol. [S1] The append-only command/event schema and the exact conflict states are recommended additions, not facts already implemented in the packet.

## Connection-budget mechanics

Use the connection manager as the sole pool owner within each worker process:

- Do not instantiate a pool per AI agent, job, transaction clone, or subagent. Pass/inherit the parent manager so clones share the same pool instances. [S2]
- Keep reads on the port-6543 pooler route and keep long-running DDL/bulk operations on the port-5432 direct/session route. The current defaults are 10 read connections and 3 direct connections; these are implementation defaults, not proof of a safe Supabase plan limit. [S2]
- Set explicit deployment caps below the account's measured connection allowance, reserving headroom for health checks, migrations, operator access, and other services. The q2 packet contains no account/plan limit, so no numeric reduction can be justified from the existing evidence alone.
- Bound the writer fleet and let queue depth provide backpressure. Increasing logical agent count must not automatically increase database pool size.
- Use the existing lazy, cached direct-pool initialization and connection-event audit rather than allowing concurrent workers to construct duplicate direct pools. [S2]
- Keep transactions short and separate long-running bulk/DDL work from command commits. The command path should not hold a pool slot while an agent performs model inference or waits on an external service.
- Treat a connection failure as infrastructure failure and make the command retry/idempotency path distinguish it from a rejected command. This matches the worker's existing handling of connection drops and lock-renewal failures. [S4]

## Recommended GBrain shape

The concrete target is therefore:

```text
AI agents
   │ reads: shared, bounded pooler access
   │ writes: idempotent commands
   ▼
command admission API / queue
   ▼
logical writer keyed by Brain/workspace (partition)
   ├─ expected-version + provenance validation
   ├─ append immutable command/revision record
   └─ transactionally project pages, facts, and edges
   ▼
Supabase/Postgres materialized graph
   │
   └─ pooled reads, graph traversal, versions, and audit/replay queries
```

Start with one logical writer per active scope and a small fixed worker fleet. Add partitions only when queue latency or scope independence justifies them. Keep a global serialization path for the small set of operations that truly cross scopes rather than weakening all local writes.

This design preserves provenance by retaining every accepted attempt and its actor/source context, prevents silent conflicting writes through per-scope ordering plus expected-version fencing, and makes the physical connection budget an operator-controlled property of the worker fleet rather than an emergent property of the number of AI agents.

## Assumptions and change conditions

The recommendation assumes that:

- GBrain can tolerate queued or otherwise explicitly acknowledged writes rather than requiring every mutation to be synchronously visible to every agent.
- Most mutations have a natural Brain/workspace/source scope.
- A small number of worker processes can provide sufficient write throughput.
- The database plan limit can be measured and configured; the current artifacts do not contain that limit.

Use shared optimistic writers if conflict prevention is relaxed to conflict detection and later convergence. Use a coarser global writer if cross-scope atomicity dominates and throughput is modest. Increase the number of partition writers only with a measured queue/connection budget and a clear ownership key. If strict read-after-write is required, provide a synchronous command-commit acknowledgement without allowing agents to bypass the writer.

## Evidence boundary and provenance

No new web, API, or Brain research was performed. Claims about current GBrain behavior are supported by the extracted Brain artifacts listed below. The q2 directory contains no separately named Agentic fetched-source corpus or Agentic run receipt; consequently, this answer makes no unverified external-source claims and labels the command-log, partition key, conflict schema, and budget-sizing rules as recommendations or assumptions.

- **[S1]** `brain-get-engines.txt`, Brain slug `docs/engines`, full extracted page body. Supports the Postgres/Supabase versus PGLite deployment/concurrency facts and the BrainEngine transaction/version/link/raw/ingest contract.
- **[S2]** `brain-get-connection-manager.txt`, Brain slug `src-core-connection-manager-ts`, full extracted source body. Supports pool routing, default pool sizes, lazy cached direct initialization, parent inheritance, kill switch, and connection auditing.
- **[S3]** `brain-get-key-files.txt`, Brain slug `docs/architecture/key_files`, full extracted page body. Supports provenance fields, source scoping, atomic Markdown write-through, and related write/read invariants.
- **[S4]** `brain-get-minions-worker.txt`, Brain slug `src-core-minions-worker-ts`, full extracted source body. Supports worker concurrency, isolated state, lock renewal, token fencing, stall detection, retry, and connection-failure handling.
- **[S5]** `brain-context.yaml`, dated Brain context packet retrieved at `2026-07-15T00:35:14Z`. Establishes the prior-context claims, known decisions, gaps, and contradiction status against which the answer is classified.
