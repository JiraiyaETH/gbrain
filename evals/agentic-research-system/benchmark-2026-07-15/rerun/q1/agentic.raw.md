# Q1 — Agentic Research System raw answer

## Scope and evidence boundary

Benchmark date: **2026-07-15**. The last-90-days window is **2026-04-16 through 2026-07-15 inclusive**, using publication or release dates. This answer uses only the already-collected Agentic source corpus in `agentic-B/` and the refactored Agentic Research System contract. The internal baseline is the supplied Brain packet: the existing workflow already has a protocol brief, Brain lookup, bounded scouts, source/claim/citation ledgers, critic and competing-hypotheses gates, citation audit, constrained synthesis, cross-model evaluation, a run receipt, and controlled proposal-only Brain write-back.

The corpus supports several concrete operational changes. It does **not** establish global novelty: “new” below means a dated mechanism with an operational delta against that bounded Brain baseline and a primary source in the corpus. Older or adjacent patterns are labeled baseline/repackaged or investigate.

## Decision summary

1. **Change the execution graph, not the safety boundary.** Add a shared, structured evidence state across parallel investigators; let the orchestrator verify coverage, contradictions, and unsupported claims before dispatching targeted follow-ups. [S2]
2. **Make provenance source-specific and repairable.** Preserve stable source/tool identifiers through extraction, decompose answers into atomic claims, check support and source ownership separately, and require repair plus re-verification before release. [S4]
3. **Make stopping coverage-aware.** A completed-looking answer is not evidence that the research task is complete. Add explicit subgoal coverage, evidence-to-output binding, stale-source checks, and trace diagnostics for redundant search, early termination, and synthesis collapse. [S5]
4. **Separate exploration from exploitation.** Maintain an outline/blueprint state with gap-specific queries and an iterative critic–retriever loop; treat dynamic rubrics as a test-time scaffold rather than as proof of correctness. [S3][S6]
5. **Treat memory write-back as a governed, reversible evidence commit.** Explore factorized working context plus durable structured snapshots, query-driven retrieval, provenance, supersession/contradiction handling, and a staged proposal state. Do not execute Brain writes in this run. [S7][S8][S9][S10]

## Candidate mechanisms

| Area | Dated mechanism and operational delta | New vs. repackaged | GBrain implication | Evidence |
|---|---|---|---|---|
| **Source discovery** | **AgentSearchBench** treats agent discovery as retrieval/ranking under execution-dependent capability uncertainty rather than documentation similarity alone. It evaluates both executable tasks and high-level task descriptions and studies lightweight execution-aware probing. | **Genuinely new operational signal in-window.** The relevant delta is bounded behavioral probing of candidate agents/tools, not another embedding or description index. The benchmark’s results are evidence that semantic similarity and actual task performance can diverge; they do not prove a production router for GBrain. | Add an optional, low-budget probe stage for newly discovered providers, tools, or research lanes. Store the probe task, observed behavior, timestamp, and scope; never promote a probe result into a durable capability claim without provenance. | [S1] |
| **Parallel investigation** | **Argus** uses stateless Searchers plus a Navigator over a shared evidence/claim DAG. Parallel searches target distinct queries; the Navigator deduplicates by source URL, labels claims supported/contradicted/unverified, identifies missing question regions, and dispatches targeted follow-ups. | **Genuinely new architecture relative to the current baseline.** Bounded scouts and parallel fan-out already exist in GBrain; the new part is a shared evidence state that makes complementarity, gaps, and contradictions computable instead of aggregating isolated scout reports. | Replace “fan-out then merge” with “fan-out → integrate → verify/dispatch.” Keep Searchers read-only and stateless; keep judgment with the lead/orchestrator. Make each follow-up query point to a specific uncovered sub-question or conflict. | [S2] |
| **Parallel investigation / synthesis** | **AggAgent** makes aggregation itself an agentic, on-demand read over completed trajectories. The aggregator can inspect final solutions, search within a trajectory, and read selected segments without loading every transcript into context. | **New operational variant, but adjacent to known aggregation.** It is not a new parallel-search primitive; it is a useful full-fidelity, coarse-to-fine aggregator for long trajectories. | If multiple research lanes are run, expose trajectory metadata and bounded search/read operations to a synthesis agent instead of concatenating all raw traces or relying only on final answers. Preserve raw traces outside the synthesis context. | [S11] |
| **Critique and source discovery** | **AgentDisCo** separates information exploitation (outline and references) from information exploration (blueprints and targeted queries). A critic evaluates outline completeness, emits gap-aware queries, and a generator retrieves and revises the outline; the loop can maintain reusable query policies. | **Genuinely new operational decomposition, built from repackaged ingredients.** Critique, query reformulation, and iterative planning are known baseline patterns; the explicit dual state and blueprint-to-query contract are the material delta. The policy-bank/meta-optimization portion is promising but not necessary for the first GBrain change. | Represent the research brief as a coverage blueprint. Require the critic to emit missing claims/questions and targeted queries, not merely prose criticism. Feed results back into the outline with claim/source links. Defer automatic policy-bank learning until repeated runs provide an eval gate. | [S3] |
| **Evidence tracking** | **ProvenanceGuard** preserves stable MCP tool IDs, source IDs, and raw outputs; decomposes an answer into atomic claims; routes each claim to source-specific evidence; checks entailment/alignment and attribution separately; and can repair blocked answers before re-verification. | **Genuinely new control point in-window.** GBrain already requires claim-level support and no snippet citations, but the corpus adds source ownership as an independent gate and makes repair/reverification explicit. | Extend the claim ledger with `source_id` ownership, evidence span, attribution status, and a release decision. A claim supported by the corpus but attributed to the wrong source remains blocked. Any repair must create a new revision and rerun verification. | [S4] |
| **Critique / stopping / synthesis** | **Parallel WebBench** exposes a completion–correctness gap in multi-subgoal web work: agents can finish with missing fields, unsupported inclusions, stale evidence, or collapsed row-to-fact bindings. Its trace diagnostics identify context-bound search loops, premature termination, and synthesis collapse, and point to coverage-aware stopping and evidence-bound synthesis. | **New evaluation and diagnostic evidence, not a complete architecture.** Parallel decomposition, partial-credit scoring, and trace inspection are established patterns; the dated contribution is a concrete failure taxonomy for parallel evidence collection and explicit separation of finishing from solving. | Add an eval case and runtime checks for: subgoal coverage, redundant-query loops, early stop with open gaps, unsupported output elements, and evidence-to-field binding. Do not treat a parseable final answer or more tool calls as a completeness signal. | [S5] |
| **Planning / synthesis** | **DuMate-DeepResearch** combines graph-based coarse-to-fine planning, reflection/re-planning/backtracking/parallel branches, recursive inner search agents, and dynamically generated rubrics used as live reasoning scaffolds and adaptive stopping signals. Intermediate decisions and tool calls are explicitly traceable. | **Mostly repackaged mechanisms with a useful composition.** Dynamic planning, recursive delegation, reflection, and rubric-guided reasoning predate the window or are already represented in the current contract. The operationally useful delta is to make the rubric an explicit, task-specific stopping and synthesis contract and to preserve intermediate decisions. | Add a per-run rubric with required coverage, evidence, contradiction, and output-format checks. Keep recursive delegation bounded and read-only. A rubric is a gate specification, not evidence and not a substitute for the citation audit. | [S6] |
| **Memory write-back** | **Cognitive Scaffold** factorizes state into a Fluid Working Context and persistent Knowledge Graph. On saturation it crystallizes selected history into structured event snapshots with atomic constraints, then uses thought-driven dual-path retrieval and lazy reinjection. The ACL artifact reports reduced compression hallucination and preserves entities/numbers as explicit design targets. | **Genuinely new memory workflow in-window, but not yet a GBrain write protocol.** Context folding and graph memory are established directions; the density-triggered crystallization, atomic fidelity constraint, and thought-driven retrieval loop are the concrete delta. | Prototype proposal-only “memory notes” for completed research runs: atomic claim, source IDs, timestamp, validity, uncertainty, and links to the raw packet. Keep the note outside canonical Brain until the controlled write-back gate passes. | [S7] |
| **Memory write-back** | **MemSearch-o1** grows fine-grained memory fragments from query seed tokens, retraces them with a contribution function, and organizes them into a globally connected path for multi-hop reasoning instead of stream-like concatenation. | **New memory-selection mechanism in-window; evidence is limited to the collected ACL artifact.** It is complementary to Cognitive Scaffold, not a replacement for provenance or governance. | For long runs, retain query-linked evidence fragments and bridge relations, not only a summary. Use this as an experiment for retrieval/readback; do not use it to bypass claim ledgers or write-back approval. | [S8] |
| **Memory write-back / governance** | **WorldDB** proposes content-addressed immutable nodes, bitemporal validity/ingestion times, typed edges with write-time handlers for supersession, contradiction, and merge proposals, and a no-raw-append reconciliation path. **ContextNest** proposes governed context packs, version/checkpoint integrity, audit traces, and a staged source-node lifecycle before durable publication. | **New substrate patterns in the corpus, not validated GBrain integrations.** They strengthen the design space for safe memory commits; they do not justify changing GBrain’s native Brain schema or gate by themselves. | Adopt the invariants at the proposal layer: immutable raw packet, explicit `valid_at`/`ingested_at`, provenance, supersedes/contradicts relations, dedupe key, and staged `proposed → reviewed → published` lifecycle. Keep canonical publication on GBrain-native surfaces only. | [S9][S10] |

## What should change in the canonical workflow

### 1. Replace flat parallel aggregation with an evidence board

The lead should create a structured board containing source nodes, atomic claim nodes, support/contradiction edges, question coverage, and unresolved gaps. Scouts/Searchers contribute read-only traces. The lead or a bounded Navigator deduplicates source URLs, updates claim status, and dispatches targeted follow-ups. This is the strongest cross-cutting change supported by the corpus. [S2]

### 2. Add source ownership and repair/reverification to the citation gate

The existing “no snippet citations” and claim-level mapping rules should be extended, not removed. Every material claim should carry: `claim_id`, exact claim text, `source_id`, source URL, evidence span or excerpt location, support status, attribution status, and revision status. Release is blocked when support is absent, the source is misattributed, or a repair has not been re-verified. [S4]

### 3. Make completeness a first-class stopping condition

The run should stop only when each brief/blueprint item is covered, each decision-critical claim has direct evidence or an explicit downgrade, contradictions have a disposition, and the final output binds claims to the correct evidence. Add trace diagnostics for repeated near-duplicate searches, unfilled list items, early termination, stale evidence, and synthesis bindings. [S3][S5][S6]

### 4. Keep synthesis compact but full-fidelity

Do not concatenate all scout transcripts, and do not rely solely on lossy summaries. Use coarse-to-fine inspection of trajectory segments or a compact evidence graph, retaining links back to the raw source and trace. This preserves context limits without discarding the details needed for citation and contradiction checks. [S2][S11]

### 5. Make write-back a staged evidence commit

The safe proposal shape is:

```yaml
memory_proposal:
  status: proposed
  run_id: <immutable run identifier>
  claim_id: <claim ledger identifier>
  content: <atomic durable finding>
  source_ids: [<approved source IDs>]
  provenance: [{url: <canonical URL>, accessed_at: <timestamp>, evidence_span: <locator>}]
  valid_at: <publication/event date or unknown>
  ingested_at: <run ingestion timestamp>
  relation: new|confirming|supersedes|contradicts|derived_from
  dedupe_key: <stable normalized key>
  target: <Brain page/section, unresolved until taxonomy check>
  gate: not_run
```

This run must not execute the proposal. [S7][S8][S9][S10]

## Do not change yet

- Do not remove Brain-first lookup, bounded read-only scouts, source hygiene, claim-level mapping, evidence-confidence separation, cross-model evaluation, or the controlled write-back gate; the corpus reinforces these controls rather than displacing them. [S2][S4][S5]
- Do not treat URL-health checking as a last-90-days advance: the collected `urlhealth` paper is dated **2026-04-03**, before the required window. It is useful baseline evidence for adding URL liveness and stale-vs-hallucinated checks, but it cannot establish a Q1 window advance. [S12]
- Do not adopt an automatic learned policy bank, recursive agent swarm, or new memory engine as a canonical dependency from this corpus alone. These require implementation probes, cost/latency telemetry, and a separate eval gate. [S3][S6][S9][S10]

## Evidence boundary and missing primary evidence

The collected corpus is strong on shared evidence structures, source-aware verification, parallel-task failure diagnostics, and memory representation. It is weaker on provider-internal production telemetry, durable Brain write-back behavior, and direct evidence that any one mechanism transfers unchanged to GBrain. The corpus contains no completed GBrain run receipt, no Agentic lane cost/latency/tool-call log, and no post-write readback because write-back was prohibited. Novelty is therefore bounded to the dated primary artifacts listed in the source ledger and the supplied Brain baseline.

## Source citations

See `source-ledger.md` for the full provenance ledger, local artifact paths, dates, source classes, and claim mapping.
