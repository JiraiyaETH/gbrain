The most robust architecture for GBrain is a **single-writer / command‑log layer in front of Postgres, with partitioned logical writers per “graph scope,” optimistic read‑side concurrency, and a queue‑mediated write path that stays within a small, capped connection pool**. Facts and provenance are preserved via immutable event logs and versioned entities; conflicts are prevented by serializing writes per scope and using optimistic checks; connection budget is controlled by reusing a small number of pooled Supabase/Postgres connections.

Below is a decision‑oriented comparison of architectures and a concrete recommendation for GBrain, grounded in current technical research and the Brain packet.

---

## 1. Context: What GBrain Already Assumes (Confirming / Missing)

From the Brain packet:

- **Supabase/Postgres is the production backend.** PostgresEngine + Supabase is the documented path for multi‑user/multi‑device use; PGLite is single‑process/local and explicitly limited in concurrency.[docs/engines] *(confirming)*  
- **Connection manager already differentiates pooled vs direct connections.** Reads go through Supabase’s transaction pooler (port 6543) with a default pool size of 10; DDL/bulk work uses a direct pool (port 5432) with a default size of 3, created lazily and shared across workers.[src-core-connection-manager-ts] *(confirming)*  
- **Graph/link operations already carry provenance.** Links expose `link_source` and `link_type`, reject reconciliation‑managed sources for manual writes, and default omitted provenance to “manual.”[docs/architecture/key_files] *(confirming)*  
- **Local Markdown write‑through is atomic.** `put_page` uses temp‑sibling + rename for atomicity.[docs/architecture/key_files] *(confirming)*  
- **There is an in‑process job worker with lock renewal and retries.** MinionWorker processes jobs concurrently with per‑job isolation, lock renewal, token‑fenced completion, stall detection, and retry handling.[src-core-minions-worker-ts] *(confirming)*  

What’s **missing** in existing Brain context:

- No explicit **global write protocol** for pages, graph edges, facts, and provenance under concurrent AI agents.  
- No direct comparison of **shared‑writer vs single‑writer vs partitioned writers** for multi‑agent graph writes.  
- No quantified **connection budget** tied to Supabase/Supavisor limits or plan tiers.  
- No decision whether a **queue/worker** should be the sole write coordinator vs a softer “admission control” layer.

The recommendation below fills these gaps with external research and explicit assumptions.

---

## 2. Supabase/Postgres Mechanics: Connection Budget & Pooling (New)

### 2.1 Supabase & Supavisor connection pooling

Supabase uses **Supavisor** as a built‑in connection pooler in front of Postgres.[10] Supavisor keeps a relatively small number of database connections and multiplexes them across many client sessions, which is critical for AI agents that can otherwise exhaust connection limits.

- Supabase documentation and ecosystem guides emphasize using its managed Postgres for AI agents and multi‑tenant applications, with Row Level Security (RLS) and built‑in pooling.[9][10]  
- Connection limits depend on plan, but the architectural pattern is: **keep app‑side connection pools small and reuse them**, relying on Supavisor to fan out requests.[10]  

**Fact vs assumption:**

- **Fact:** Supabase provides a pooler (Supavisor) in front of Postgres and is positioned as “managed Postgres with auth, storage, and realtime subscriptions — best for full‑stack teams.”[10]  
- **Assumption (GBrain‑specific):** The current GBrain connection manager (10 pooled read, 3 direct) is close to the safe budget for typical Supabase plans; tightening this to ~5 pooled read connections and ~2 direct connections would better respect stricter quotas without harming throughput given agent workloads. This assumption is based on typical Postgres deployment patterns, not an explicit Supabase limit.

### 2.2 Read vs write pattern for agents on Supabase

External guides on AI agents with Supabase recommend:

- Use **Postgres for structured agent state and history**, plus pgvector for semantic memory.[9][7]  
- Use **Realtime channels for coordination**, and row‑level locks for exclusive access when multiple agents must mutate the same resource.[7]  

Supabase Realtime is suggested as a coordination layer: agents subscribe to channels, receive updates, and can build locking systems on database rows (lock rows indicate exclusive access).[7]

This supports a design where:

- Reads and light writes go through **pooled connections**.  
- Heavy DDL/bulk operations use a **capped direct pool** (which GBrain already does).[src-core-connection-manager-ts]  

For GBrain, the **strict connection budget** means:

- Avoid giving each agent its own connection pool.  
- Share one **process‑global connection manager** with small pools across MinionWorker jobs, as GBrain already supports via inheritance.[src-core-connection-manager-ts]  

---

## 3. Provenance & Integrity for Multi‑Agent Knowledge Graphs (New / Confirming)

### 3.1 Provenance as a first‑class dimension

External research on agent memory and knowledge graphs emphasizes provenance:

- TrustGraph frames “context backends” where provenance is first‑class: you must know *where answers came from* and track relationships and ontology-level facts.[1]  
- Armalo AI’s integrity guidance recommends **strict write access control**, **source credibility tiers**, and **staging environments** where updates are reviewed before entering production graphs.[3]  
- SuperLocalMemory stores **per‑agent provenance** locally to support trust scoring and memory poisoning defense.[5]  

These confirm that GBrain’s existing provenance fields (`link_source`, `link_type`) are aligned with broader practice, but external work adds:

- **Source tiers** (e.g., human‑curated vs agent‑generated) as part of provenance.  
- **Staging vs production graphs**, where agent writes go into a staging graph and are promoted after validation.[3]  

### 3.2 Graph‑native memory and immutable revisions

Graph‑native cognitive memory architectures use:

- **Immutable revisions**, typed edges, and versioned entities as primitives for multi‑agent collaboration.[6]  
- A **single shared graph** for both memory and asset management; agents build upon each other’s outputs using versioned nodes and edges.[6]  

For GBrain, this suggests:

- Treat graph updates as **immutable events** (append‑only) with provenance, and derive the current state from those events.  
- Use **version IDs / revision hashes** in the graph so agents never silently overwrite each other—only create new versions or explicit merges.

This is consistent with GBrain’s atomic page write‑through and versioned link provenance but needs extension to a **global event log** for multi‑agent writes.

---

## 4. Architecture Patterns for Concurrent Agents (Comparison)

This section compares the required patterns:

- **A. Shared‑writer with optimistic concurrency**  
- **B. Single‑writer / command log**  
- **C. Partitioned / sharded writers**  
- **D. Read/write split or queue‑mediated variants**

Evaluation criteria:

- Provenance preservation  
- Conflict prevention  
- Connection budget compliance  
- Fit for Supabase/Postgres + GBrain’s existing contracts

### 4.1 Shared‑writer with optimistic concurrency

**Pattern:** All agents can write directly to the shared knowledge graph tables through the same pooled connections, using optimistic concurrency controls (e.g., version columns, transactional checks) to detect conflicts.

**Research analogues:**

- The Hive’s “shared agent memory” uses one Postgres table with pgvector index, no locks, no serialization; convergence is handled asynchronously via deduplication.[4]  
- This architecture intentionally avoids per‑process protocols; any agent can write at any time to the shared corpus; duplicates and conflicts are resolved later.[4]  

**Strengths:**

- **Low coordination overhead** — no central writer or queue; simple write path.[4]  
- **Horizontal scalability** — many agents across machines can share the same corpus.[4]  
- Works well when **corpus convergence** is acceptable and when conflicts are mainly semantic duplicates that can be collapsed.

**Weaknesses for GBrain’s goals:**

- **Conflict prevention is weak.** The Hive explicitly rejects locking; double‑writes and contradictory facts are allowed to land and only later reconciled.[4]  
- **Provenance can be preserved**, but provenance alone does not prevent conflicting writes—agents can still overwrite or contradict each other’s facts.  
- **Connection budget risk:** If each agent opens its own pooled connections to Supabase, Supavisor can handle many logical connections, but the shared‑writer pattern typically encourages “write‑anywhere” behavior that may increase contention and heavier transactional traffic.[10]  

**Assessment for GBrain:**  
Good for “eventual convergence” corpora; misaligned with GBrain’s requirement to *prevent* conflicting writes and maintain a strict connection budget. This pattern would require adding substantial reconciliation and conflict resolution layers, which reintroduce complexity that the pattern originally avoids.

### 4.2 Single‑writer / command log

**Pattern:** All writes go through a **single logical writer** (not necessarily a single process, but a single **serialized stream**), often modeled as an append‑only command/event log. Readers see materialized views derived from the log.

**Research analogues:**

- Event‑sourced and CQRS architectures in general: write side is a command/event log; read sides are projections. (This is general system design knowledge; not directly cited.)  
- Graph‑native cognitive memory uses **immutable revisions** and typed edges, essentially treating every change as an event and deriving current graph state.[6]  

**Strengths:**

- **Strong conflict prevention:** All mutations are serialized in a controlled sequence. Conflicting commands can be rejected or merged at the log level before hitting the materialized graph.  
- **Provenance by design:** Each log entry includes source, agent, time, and context; the graph becomes a projection of a provenance‑rich log.[6][3]  
- **Connection budget control:** Only the command‑log writer needs write access; read‑only clients use pooled connections. GBrain’s existing connection manager (10 pooled, 3 direct) can be tightened and shared by the single writer and read‑side projections.[src-core-connection-manager-ts]  
- **Auditability:** You can replay the log to reconstruct states or run integrity analyses, aligning with Armalo’s emphasis on anomaly detection and staging.[3]  

**Weaknesses:**

- **Write throughput bottleneck:** If the single writer process cannot keep up, write latency rises. This can be mitigated by batching and partitioning (see next pattern).  
- **Complexity:** Requires building and maintaining event schemas, projections, and idempotency semantics.

**Assessment for GBrain:**  
Matches GBrain’s ACID transaction needs and provenance handling.[docs/engines][docs/architecture/key_files] It provides clear conflict prevention and strong audit trails while naturally respecting connection budgets by centralizing writes. The MinionWorker infrastructure already supports queue‑driven jobs with lock renewal and retries,[src-core-minions-worker-ts] which is a good fit for a **command‑log worker**.

### 4.3 Partitioned / sharded writers

**Pattern:** Writes are serialized per **partition** (e.g., per workspace, per graph, per tenant). Each partition has a logical writer, often still command‑log‑based, but multiple writers run in parallel.

**Research analogues:**

- Multi‑tenant knowledge graph integrity: Armalo suggests **staging environments** and **source tiers**, implying logical partitions where different data sources and workflows are separated.[3]  
- SuperLocalMemory’s local‑first design strongly isolates per‑user/agent memory; partitions can be thought of as per‑user graphs.[5]  

**Strengths:**

- **Scalable conflict prevention:** Within a partition, you get single‑writer semantics; across partitions, conflicts are irrelevant.  
- **Connection budget friendly:** You can run a small number of writers, each sharing a common connection manager, while agents interact via queues rather than direct DB connections.  
- **Provenance preserved:** Each partition can enforce its own provenance policies (e.g., source tiers, trust scores).[3][5]  

**Weaknesses:**

- **Cross‑partition queries are harder.** Multi‑graph queries require aggregation from multiple partitions or a higher‑level “global index.”  
- **Complexity in partitioning scheme:** GBrain must choose clear partition keys (e.g., per project/workspace, per user, per “graph instance”).

**Assessment for GBrain:**  
Well‑aligned with GBrain’s multi‑user/multi‑device use case.[docs/engines] GBrain can treat each “Brain” or “workspace” as a partition with its own logical writer, while still using a single physical Postgres database. This avoids global contention and respects connection limits.

### 4.4 Read/write split and queue‑mediated variants

**Pattern:** Reads go directly to the database via pooled connections; writes are **mediated by a queue** and processed by worker processes that own the write path. This can coexist with single‑writer or partitioned writers.

**Research analogues:**

- Supabase guides recommend **Realtime channels** and row‑based locks as coordination mechanisms when multiple agents work on shared resources.[7]  
- GBrain’s MinionWorker already implements concurrent job processing, lock renewal, token‑fenced completion, stall detection, and retries.[src-core-minions-worker-ts]  
- Event‑driven knowledge graph ingestion pipelines (Graphiti and similar systems) isolate graph‑core operations in separate processes for robustness.[8]  

**Strengths:**

- **Strict connection budget:** Only workers use write connections, and connection manager pools are shared and capped.[src-core-connection-manager-ts]  
- **Conflict prevention:** Workers can implement per‑resource locks (at the logical level) and optimistic checks while still benefiting from transactional DB guarantees.[7]  
- **Resilience:** Queue + worker semantics allow retries and stalled job detection.[src-core-minions-worker-ts]  

**Weaknesses:**

- **Latency:** Writes are asynchronous; agents must tolerate eventual consistency on graph updates.  
- **Operational complexity:** Requires queue infrastructure and monitoring.

**Assessment for GBrain:**  
Strong synergy with existing MinionWorker and connection manager. This pattern is more an **implementation detail** of how single‑writer / partitioned writers are realized rather than an alternative.

---

## 5. Provenance, Conflict Prevention, and Connection Budget: Pattern Comparison

### 5.1 Summary comparison

| Pattern | Provenance | Conflict Prevention | Connection Budget | Fit for Supabase/Postgres | Fit for GBrain |
|--------|------------|---------------------|-------------------|---------------------------|----------------|
| Shared‑writer + optimistic | Can record provenance; relies on app layer | Weak; conflicts allowed, reconciled later[4] | Potentially high per‑agent connections | Compatible, but promotes write‑anywhere | Misaligned with “prevent conflicts”; adds reconciliation burden |
| Single‑writer / command log | Strong; provenance in each event[6][3] | Strong; serialized commands | Strong; few write connections, shared pools[src-core-connection-manager-ts] | Well‑aligned with Postgres ACID | Strong fit for GBrain’s provenance + ACID contracts[docs/engines] |
| Partitioned writers | Strong; per‑partition provenance policies[3][5] | Strong within partition; none needed across | Strong; controlled number of writers | Good for multi‑tenant Postgres | Good fit for multi‑user GBrain[docs/engines] |
| Read/write split + queue | Strong; worker writes can enforce provenance[8][src-core-minions-worker-ts] | Strong; worker‑side locks & checks[7] | Strong; capped connection pools | Recommended for Supabase agent coordination[7] | Good fit with existing MinionWorker and connection manager |

---

## 6. Recommended Architecture for GBrain (Judgment + Assumptions)

### 6.1 Recommendation (core judgment)

**Recommended architecture for GBrain:**

> A **queue‑mediated, partitioned single‑writer / command‑log architecture** on Supabase/Postgres, where:
> 
> - All AI agents are **read‑heavy clients** using Supabase’s pooled connections (through GBrain’s connection manager).
> - All graph mutations go through **MinionWorker‑based writer processes** consuming write commands from a queue.
> - Each **graph partition** (e.g., per workspace or Brain) has a **logical writer** that serializes commands and maintains an append‑only **event log with provenance**.
> - The event log is materialized into Postgres tables (nodes, edges, versions) via transactional projections, respecting the **strict connection budget** by reusing a small, shared connection pool.

This is a judgment grounded in the following facts and assumptions:

- **Facts:**
  - Supabase/Postgres is GBrain’s production backend.[docs/engines]  
  - GBrain already has a shared connection manager with separate pooled read and capped direct pools.[src-core-connection-manager-ts]  
  - MinionWorker already supports concurrent jobs, lock renewal, token‑fenced completion, stall detection, and retries.[src-core-minions-worker-ts]  
  - Knowledge graph integrity research advocates strict write access control, source tiers, and staging.[3]  
  - Graph‑native memory architectures use immutable revisions and typed edges, aligning with command‑log projections.[6]  
  - Supabase community guidance recommends row‑level locking patterns and Realtime channels for multi‑agent coordination.[7]  

- **Assumptions:**
  - GBrain can accept **eventual consistency** for writes (agents may not see their own updates immediately in all views).  
  - Most agent workloads are **read‑dominant**, with writes being relatively sparse but semantically important (facts, links, pages).  
  - Partitioning by workspace/brain is acceptable; cross‑workspace queries are limited or can be mediated by higher‑level aggregation.  
  - Strict connection budget means **no per‑agent connection pools**; instead, a small global pool shared via the existing connection manager.  

### 6.2 How this preserves provenance

- **Event log schema:** Each write is an event with:
  - Agent ID / service account  
  - Source type (manual, reconciliation, external API, LLM extraction)[docs/architecture/key_files][3]  
  - Workspace/Brain ID (partition key)  
  - Timestamp and optional trust/credibility tier[3][5]  
- **Materialized graph:** Nodes and edges in Postgres carry:
  - Version IDs or revision hashes (immutable revisions)[6]  
  - Pointers back to event IDs for full provenance backtracking.  

This extends GBrain’s existing link provenance (`link_source`, `link_type`) to a **global, append‑only provenance backbone**, confirming and strengthening the prior context.

### 6.3 How this prevents conflicting writes

- **Per‑partition serialization:** All commands for a partition are processed by a single logical writer (which may be sharded by workspace).  
- **Optimistic checks at the writer:** For example:
  - If a command references a particular entity version, the writer verifies that the entity’s latest version matches the expected version; otherwise it rejects or triggers a merge flow.  
- **Logical locks via event types:** Commands that require exclusivity (e.g., editing a page or restructuring a subgraph) can emit “begin edit” events and “end edit” events, effectively locking by convention, backed by MinionWorker’s lock renewal primitives.[src-core-minions-worker-ts]  

This approach:

- Avoids DB‑level blocking in most cases, relying on transactional integrity for event log writes and projections.  
- Ensures that **two agents cannot silently overwrite the same fact**; conflicting commands are either rejected or turned into separate versions that must be reconciled explicitly.

### 6.4 How this stays within a strict connection budget

- **Single connection manager instance:** As already implemented, worker engines and transaction clones inherit a parent connection manager and share pool instances.[src-core-connection-manager-ts]  
- **Capped pool sizes:**  
  - Pooled read connections: reduced from 10 to a smaller number (e.g., 5), balancing throughput and Supavisor’s multiplexing.[10]  
  - Direct/bulk connections: kept at 2–3 for projections and DDL.[src-core-connection-manager-ts]  
- **Write access restricted to workers:** Agents do **not** open direct write connections; they enqueue commands via a lightweight API and rely on workers to execute DB transactions. This matches Armalo’s **strict write access control** guidance and minimizes write load.[3]  

Supabase’s Supavisor pooler and Postgres ACID transactions handle the underlying concurrency and isolation, while GBrain’s architecture ensures that the number of physical connections remains small and controlled.

---

## 7. Tradeoffs & What Would Change the Recommendation

### 7.1 Key tradeoffs

- **Latency vs consistency:**
  - Queue‑mediated single/partitioned writers introduce **write latency**; agents may not see their updates instantly.  
  - In exchange, GBrain gains **strong conflict prevention** and better connection budget control.  

- **Complexity vs robustness:**
  - Event logs, projections, and partitioned writers increase architectural complexity.  
  - However, they provide **robust provenance**, auditability, and a clear story for multi‑agent collaboration, aligning with graph‑native cognitive memory patterns.[6]  

- **Partitioning rigidity:**
  - Partitioning by workspace/Brain may make cross‑workspace queries more complex.  
  - If GBrain’s usage shifts toward global, cross‑tenant graph operations, the architecture may need a **global index** or partial relaxation of partition boundaries.

### 7.2 Conditions that would change the recommendation

1. **If strict conflict prevention is no longer required and eventual convergence is acceptable**  
   - If GBrain’s knowledge graph becomes more like The Hive’s shared corpus, where “the convergence is the feature” and duplicates/conflicts can be collapsed asynchronously,[4] then a **shared‑writer with optimistic concurrency** pattern becomes more attractive.  
   - Provenance would still be tracked, but conflict **prevention** would be relaxed to conflict **resolution**, simplifying the protocol.

2. **If the connection budget becomes very loose (e.g., dedicated Postgres cluster with higher limits)**  
   - With a much higher connection budget, GBrain could afford **per‑agent writer connections**, reducing the need for a central queue and single writer.  
   - Partitioned writers could be pushed closer to agents, or even replaced with shared‑writer patterns plus row‑level locking as described in Supabase multi‑agent coordination guides.[7]  

3. **If GBrain shifts to a graph‑native database (Neo4j or similar)**  
   - Graph‑native cognitive memory research uses Neo4j as the storage layer.[6]  
   - In that scenario, some Postgres‑specific constraints (connection pools, Supavisor) would be less relevant, and GBrain could adopt native graph transaction semantics and locking.  
   - The **command‑log pattern** would still be useful but might be optional rather than mandatory.

4. **If write workloads become extremely high‑volume and low‑value (e.g., transient events)**  
   - For high‑volume, low‑value events (similar to telemetry), a **shared‑writer with optimistic concurrency** and coarse deduplication may be more cost‑effective, with the event log focusing only on “canonical” facts.  

---

## 8. Classification Against Brain Packet

- **New findings:**
  - Supabase/Supavisor’s role as a managed connection pooler and typical AI‑agent usage patterns with RLS and Realtime.[7][9][10]  
  - Knowledge graph integrity practices: strict write access control, source credibility tiers, staging environments.[3]  
  - Graph‑native cognitive memory primitives: immutable revisions, typed edges, single shared graph as both memory and asset manager.[6]  
  - Multi‑agent memory architectures with per‑agent provenance and trust scoring (SuperLocalMemory).[5]  
  - The Hive’s “write‑anywhere, converge‑later” shared memory pattern with no locks and no serialization.[4]  

- **Confirming findings:**
  - Using Supabase/Postgres as the backend for multi‑user agent memory.[9][10][docs/engines]  
  - GBrain’s provenance emphasis on link sources and types.[docs/architecture/key_files]  
  - GBrain’s connection manager with pooled reads and capped direct connections.[src-core-connection-manager-ts]  
  - GBrain’s MinionWorker concurrency model with lock renewal, token‑fenced completion, and retries.[src-core-minions-worker-ts]  

- **Missing (still):**
  - Explicit Supabase plan‑specific connection limits tied numerically to GBrain’s pool sizes (requires consulting Supabase account specifics).  
  - A finalized event schema for GBrain’s command log (entity types, versions, trust scores).  
  - A defined partition key strategy (per workspace, per user, per Brain) in existing Brain pages.

- **Contradictions:**  
  - None detected between Brain packet and external sources regarding architecture; patterns are complementary.

---

**Decision:**  
Implement and standardize **queue‑mediated, partitioned single‑writer / command‑log architecture** for GBrain’s Supabase/Postgres‑backed knowledge graph, leveraging the existing connection manager and MinionWorker. Preserve and extend provenance via an append‑only event log; prevent conflicting writes by per‑partition serialization and optimistic checks; and enforce a strict database connection budget by centralizing write access and sharing a small, capped pool of connections.