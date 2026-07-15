# Brain-first context packet

```yaml
brain_context:
  retrieved_at: 2026-07-15T08:51:14+0700
  brain_id: gbrain-local
  source_id: docs
  query: "What is the best architecture for multiple concurrent AI agents sharing a Supabase/Postgres-backed knowledge graph while preserving provenance, preventing conflicting writes, and staying within a strict database connection budget? Compare viable patterns and recommend one for GBrain."
  brain_context_status: thin-but-nonempty
  pages:
    - slug: docs/architecture/key_files
      title: "Key files — per-file index (gbrain repo)"
      retrieved_via: query+get
      claims:
        - "GBrain's operation layer distinguishes read/write/admin scopes and applies remote trust boundaries; via-subagent page writes can be constrained by allowed slug prefixes."
        - "GBrain's page write-through uses a temp sibling plus atomic rename, so concurrent readers/sync do not observe a half-written markdown file."
        - "GBrain has a first-class link provenance surface: link_source/link_type, managed-source guards, manual default, and list_link_sources."
        - "GBrain's engine exposes batch link/timeline primitives and source-scoped/federated graph reads; the current architecture is multi-source aware."
      last_known_at: 2026-07-15 (repo-index page; no separate durable decision date exposed)
  known_decisions:
    - "Protect write surfaces with explicit scopes and trust-boundary checks."
    - "Preserve provenance for graph links rather than treating links as anonymous edges."
    - "Use atomic write-through for file-plane state."
  gaps:
    - "No prior Brain decision found for Supabase/Postgres multi-agent write serialization."
    - "No prior Brain decision found for database connection-budget sizing or pool topology."
    - "No prior Brain decision found for queue-backed graph command processing or immutable event storage."
  contradictions: []
```

## Lookup receipt

- `gbrain search "Supabase Postgres knowledge graph provenance concurrent agents connection budget" --limit 8` → no results.
- `gbrain query "...shared knowledge graph provenance conflicting writes connection budget GBrain" --limit 8` → returned `docs/architecture/key_files`.
- `gbrain get docs/architecture/key_files` → retrieved the page and the claims above.
- The packet is intentionally bounded and was passed conceptually unchanged to the external lanes; external findings below are labeled relative to this packet as `new`, `confirming`, `missing`, `changed`, or `contradictory`.
