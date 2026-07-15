# Claim ledger and citation audit

| Claim ID | Material claim | Classification vs Brain | Evidence | Confidence | Audit note |
|---|---|---|---|---|---|
| C1 | Supabase transaction-mode pooling shares backend connections among transient clients; pool size bounds backend connections, while client connections are a separate limit. | new | S1 | high | Direct official documentation. |
| C2 | A single shared application pool plus a hard concurrency semaphore is safer than one DB pool per agent; total backend load must include direct and pooler connections. | new / judgment | S1 | high | Architecture deduction from S1; exact cap must be measured. |
| C3 | PGMQ provides a Postgres-native durable queue with visibility timeout and archival; `pop` is at-most-once if processing is not guaranteed. | new | S2 | high | Direct docs; do not claim global exactly-once. |
| C4 | Queue-backed workers provide backpressure, retries, and bounded projection concurrency. | new / confirming | S2, S7 | high | S7 directly demonstrates this for embeddings; projection application is labeled analogy. |
| C5 | Transaction-level advisory locks auto-release at transaction end; session-level locks persist to session end and therefore are a poor fit for transaction-pooler requests. | new | S3 + S1 | high | First part direct; pooler-fit conclusion is a constrained architecture inference. |
| C6 | Serializable transactions can prevent serialization anomalies but must retry on SQLSTATE 40001; short transactions and controlled active connections matter. | new | S4 | high | Direct PostgreSQL docs. |
| C7 | `SKIP LOCKED` is suitable for queue-like consumers but intentionally produces an inconsistent view and is not a general graph consistency mechanism. | new | S5 | high | Direct PostgreSQL docs. |
| C8 | RLS must protect exposed tables, with operation-specific policies; it is an authorization boundary, not a concurrency/provenance mechanism. | confirming + new distinction | S6; Brain already had scope/trust boundaries | high | RLS direct; “not serialization” is a conceptual distinction. |
| C9 | Append-only immutable event records preserve auditability and support projections/replay; optimistic concurrency can reject stale appends; pure event sourcing carries material complexity and eventual-consistency costs. | new | S8 | high | Direct authoritative pattern guidance. |
| C10 | Direct writes by every agent are easy but make provenance, idempotency, conflict semantics, and connection budgeting emergent rather than enforced. | new / judgment | S1–S8 | medium-high | Synthesis from documented primitives; not a source's verbatim claim. |
| C11 | Best GBrain default: queue-backed bounded single-writer (or small per-aggregate writer pool) with an immutable provenance/event ledger plus transactional current-state projections; agents submit commands and read through scoped APIs. | new recommendation; confirms Brain's write-boundary/provenance direction | S1–S8 + Brain context | high recommendation / directional action | Recommendation, not externally stated fact. |
| C12 | Pure event sourcing for the entire GBrain graph should be deferred; use an event/provenance ledger with materialized graph projections rather than making every query replay history. | new recommendation | S8 | medium-high | Explicitly follows S8's complexity warning; validate with load test. |
| C13 | No checked source contradicts the Brain packet; Brain did not contain a prior Supabase/Postgres write-serialization decision. | confirming / missing | Brain lookup receipt + S1–S8 | medium | “No contradiction” is bounded to the queried page/search scope, not proof of global absence. |

## Competing hypotheses / critic gate

### H1 — Direct concurrent CRUD with optimistic version checks
- For: lowest moving-part count; Postgres constraints and `ON CONFLICT` can make small commands safe.
- Against: each agent becomes a writer; provenance and retries are easy to bypass; connection demand tracks agent fan-out.
- Disconfirming test: if measured contention is negligible, every write path is centrally wrapped, and agent count is capped, H1 may be sufficient.

### H2 — Queue-backed bounded writer with append-only provenance and projections (recommended)
- For: queue backpressure/visibility timeout, one enforced write protocol, fixed pool, durable audit, deterministic retries.
- Against: asynchronous latency, queue operations and projector lag, need poison-message handling and idempotent consumers.
- Disconfirming test: if GBrain requires strict synchronous cross-aggregate invariants at high throughput and queue lag is unacceptable, use inline transactional projection for those commands or a narrowly scoped serializable command path.

### H3 — Pure event sourcing/CQRS everywhere
- For: maximal replayability and historical reconstruction.
- Against: schema evolution, replay/query complexity, eventual consistency, and migration cost are disproportionate for a personal knowledge graph absent a demonstrated need.
- Disconfirming test: regulatory/temporal requirements or repeated projection rebuilds justify the complexity.

## Audit result
- Unsupported material claims in proposed memo: 0 after marking architecture deductions as judgment/inference.
- Snippet-only citations: 0; all included external sources were opened and read through browser DOM content.
- Decision-critical claims with direct official/authoritative support: C1–C9; recommendation C11 is explicitly labeled synthesis.
- Contradictions: none found in the bounded Brain context or checked external sources.
