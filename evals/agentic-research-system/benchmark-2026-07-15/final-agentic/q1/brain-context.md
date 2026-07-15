# Brain Context Packet

```yaml
brain_context:
  retrieved_at: 2026-07-15T08:51:00+07:00
  brain_id: gbrain repo (/Users/jarvis/gbrain)
  source_id: gbrain search -> query -> get (read-only)
  query: "What important advances in agentic ‘deep research’ systems from the last 90 days should change how GBrain’s Agentic Research System works? Focus on source discovery, parallel investigation, evidence tracking, critique, synthesis, and memory write-back. Distinguish genuinely new mechanisms from repackaged patterns."
  status: partial_topic_match
  pages:
    - slug: skills/agentic-research-system/skill
      title: Agentic Research System
      retrieved_via: search|query|get
      claims:
        - The current protocol already requires Brain-first lookup, a protocol-lite brief, bounded read-only scouts, source/claim/citation ledgers, critic and competing-hypotheses checks, citation audit, constrained synthesis, cross-model evaluation, and promotion gates.
        - Existing source basis includes orchestrator-worker parallelism, CitationAgent-style citation placement, dynamic search, corrective retrieval, and external memory/context management.
        - Canonical Brain write-back is gated and prohibited for benchmark/unapproved runs.
      last_known_at: 2026-07-01 (changelog baseline; skill file retrieved 2026-07-15)
    - slug: skills/agentic-research-system/changelog
      title: Agentic Research System Changelog
      retrieved_via: query|get
      claims:
        - v1.0.0 was created 2026-07-01.
        - Prior review already fixed generic sourcing, hard gates, reviewer-target confusion, trigger ambiguity, and tool-capability declarations.
      last_known_at: 2026-07-01
  known_decisions:
    - Preserve source-level provenance; snippets discover but do not support final claims.
    - Keep scouts bounded and read-only; only the lead owns judgment.
    - Keep Brain writes behind explicit approval and a dry-run/readback gate.
  gaps:
    - No Brain page was found that records post-2026-07-01 advances in evidence graphs, executable research workflows, agentic evaluation, or provenance-first memory.
    - No Brain evidence directly measures whether a particular write-back policy improves later research quality.
    - No current GBrain head-to-head benchmark against the newly published mechanisms.
  contradictions: []
```

## Lookup receipt

- `gbrain search "agentic deep research source discovery parallel investigation evidence critique synthesis memory write-back" --limit 8` returned no results.
- `gbrain query` with the full question returned no topic-specific result.
- Fallback read-only lookup `gbrain search "deep research"`, `gbrain search "research system"`, and `gbrain query "agentic research" --limit 8` found the existing skill and changelog; both were read with `gbrain get`.
- Therefore novelty claims below are relative to this partial Brain baseline, not to an empty Brain.
