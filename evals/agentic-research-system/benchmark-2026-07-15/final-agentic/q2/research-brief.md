# Protocol-lite research brief

## Objective
Select a concurrency/provenance/connection architecture for many AI agents sharing a Supabase/Postgres knowledge graph, with a concrete GBrain recommendation.

## Decision this informs
- Decision owner: GBrain maintainers.
- Action horizon: architecture/prototype decision.
- Cost of being wrong: lost provenance, graph corruption, write conflicts, or connection exhaustion.

## Scope
Included: direct CRUD, optimistic concurrency, advisory/row locking, queue-backed single-writer or bounded-writer, CQRS/event-sourcing hybrid, Supabase poolers/PGMQ/RLS, provenance schema and retry semantics.
Out of scope: benchmark-specific throughput numbers, provider/model selection, live migration, production mutation, and Perplexity (baseline already exists).

## Freshness and source classes
Current as accessed 2026-07-15. Primary/official docs preferred; one authoritative architecture-pattern source for event sourcing. Cap: 8 strong sources; acquisition closed before synthesis.

## Effort and boundaries
Deep, bounded run. Read-only Brain lookup and read-only external research. No Brain writes, repo edits outside the artifact directory, commits, pushes, publishes, or external mutations.

## Scout lanes and stop rules
- Brain Scout: `gbrain search/query/get`; stop after bounded context packet.
- Web/Docs Scout: Supabase connection pooling, PGMQ, RLS, automatic-embedding queue pattern; stop at 4 included sources.
- PostgreSQL Scout: transaction isolation, advisory locks, `SKIP LOCKED`; stop at 3 included sources.
- Architecture Scout: event sourcing/CQRS trade-offs; stop at 1 included source.
- Critic/Citation Auditor: test contradictions, support every material claim, reject snippets-only evidence.

## Quality bar
No unsupported material claims; no snippet-only citations; decision-critical claims directly supported by official docs or explicitly marked inference; compare viable patterns; separate evidence confidence from recommendation strength; disclose Brain delta and evidence boundary.

## Output shape
Decision-useful architecture memo plus source ledger, claim ledger, Brain packet, exact prompt, and run receipt.
