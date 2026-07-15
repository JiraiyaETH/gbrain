# Decision Memo

## Verdict

The important advance of the last 90 days is not “more agents.” It is the conversion of deep research from a set of parallel, mostly ephemeral trajectories into an explicit, inspectable state machine: a shared evidence/claim graph, an editable dependency-aware research plan, targeted gap-filling dispatch, persistent evidence artifacts, and an evaluator that can independently retrieve and challenge the report. GBrain should adopt these mechanisms as a **directional architecture change**: prototype graph-based evidence assembly and provenance-first proposal memory now, while keeping canonical Brain write-back gated until a GBrain A/B proves quality and auditability gains.

## Confidence and recommendation strength

- **Evidence confidence:** medium-high. Seven primary sources from 2026-05-15 through 2026-07-02/07-01 were read from source bodies; five are preprints/technical reports and report self-evaluated results.
- **Recommendation strength:** directional. The mechanisms are strong enough for a reversible prototype, not yet for untested canonical Brain mutation.

## What should change in GBrain

### 1. Replace flat parallel fan-out with evidence assembly

**Mechanism:** maintain a shared graph of evidence records, tentative claims, support edges, contradiction edges, and uncovered question facets. After every retrieval round, the lead computes gaps and dispatches searchers to specific missing or under-supported nodes. Synthesis consumes the compact graph, not concatenated raw trajectories. Argus reports this design improving over a raw searcher by 5.5 points with one searcher and 12.7 points with eight, while compressing 25.6M searcher tokens into a 21.5K-token graph view; treat those numbers as paper-specific evidence, not a GBrain guarantee. [S1]

**GBrain change:** add `evidence_graph` and `gap_frontier` to the run state. Every scout return must be normalized into source/evidence/claim nodes. A follow-up query must name the gap it is intended to close. Stop when decision-critical nodes are supported or explicitly downgraded, not when a fixed number of agents finishes.

**New vs repackaged:** parallel scouts are already in Brain. The new mechanism is *compositional allocation*: parallelism targets missing evidence and contradictions, and the graph makes completeness computable. [B1, S1, S2]

### 2. Make research plans executable, editable DAGs

**Mechanism:** use a dependency-aware plan with a ready frontier, coarse-to-fine expansion, reflection, backtracking, and re-planning when tools fail or evidence changes assumptions. DuMate implements this with a dynamic graph; PaperPilot makes search workflows executable and directly editable from user feedback rather than appending feedback as more query text. [S2, S6]

**GBrain change:** represent the brief’s proposed scout lanes as typed DAG nodes with dependencies, required source classes, acceptance tests, budget, and status. Allow the critic or user to edit a node/edge/constraint and re-run only affected descendants. Persist the plan and its event log as artifacts.

**New vs repackaged:** adaptive query reformulation and reflection existed in the Brain source basis. First-class, editable workflow state with dependency-local recomputation is the meaningful advance. [B1, S2, S6]

### 3. Expose typed search/evidence operations, not only hidden reasoning

Recent systems operationalize query generation, candidate-frontier management, long-page extraction, evidence normalization, and sufficiency checks as explicit tool/state transitions. DuMate’s execution layer records URLs, timestamps, summaries, and normalized evidence; PaperPilot’s DAG operators include keyword search, citation expansion, filtering, scoring, reranking, and evidence extraction. [S2, S6]

**GBrain change:** add typed operations such as `expand_query`, `select_frontier`, `extract_evidence`, `link_claim`, `check_sufficiency`, `mark_contradiction`, and `propose_followup`, each with structured inputs/outputs and receipts. This is more auditable and easier to evaluate than relying on an untyped “research” tool call.

**New vs repackaged:** query decomposition and explicit thinking are not new in the broad sense. The durable advance is that the intermediate state is typed, inspectable, replayable, and connected to the next action. A 2026-04-09 Q+ paper is a useful boundary comparator but is outside the strict 90-day window; it confirms this direction predates the newest graph/memory/eval work and should not be counted as a new-window finding. [S2, S6]

### 4. Separate evidence accumulation from synthesis with persistent artifacts

FS-Researcher separates a Context Builder from a Report Writer. The builder archives raw pages and structured, citation-grounded notes in a hierarchical knowledge base; the writer treats that KB as its source of facts and loads sections on demand. The workspace also persists todos, checklists, logs, plans, and errors, enabling iterative refinement beyond the model context window. Its ablation reports a clear degradation when the persistent workspace is removed. [S3]

**GBrain change:** keep the existing source/claim ledgers, but make them the shared research workspace rather than merely final paperwork. Store raw source snapshots or stable extracts, normalized evidence cards, plan state, critic findings, and synthesis drafts as durable run artifacts. Let the writer read approved evidence cards and source pointers, never raw scout prose by default.

**New vs repackaged:** “use external memory” and “separate workers” are already known. The new operational standard is a persistent, revisitable workspace that is the coordination medium and the writer’s factual substrate—not just a summary pasted into the lead context. [B1, S3]

### 5. Upgrade critique from citation alignment to capability-parity evaluation

DREAM identifies a “Mirage of Synthesis”: fluent reports with aligned citations can still be stale, factually wrong, or logically weak. Its evaluator creates adaptive metrics and uses tools to independently retrieve evidence, test temporal validity, assess external factuality, check key-information coverage, and probe reasoning. [S4]

**GBrain change:** run two critic passes:

1. **Intrinsic audit:** every material claim maps to a source ID, and the source directly supports it.
2. **Extrinsic/adversarial audit:** independently re-search a sample of high-risk claims, test freshness, look for superseding sources, construct competing hypotheses, and score reasoning/coverage against the decision brief.

Do not let a perfect citation-alignment score average away a temporal/factual blocker. Record critic failures by layer: coverage, grounding, revision, scope, temporal validity, retrieval, synthesis, or measurement.

**New vs repackaged:** critic agents, claim audits, and competing hypotheses are already in Brain. The genuinely new mechanism is evaluator capability parity and explicit separation of intrinsic citation faithfulness from extrinsic world verification. [B1, S4]

### 6. Treat memory write-back as evidence-before-belief

Eywa’s key design is a write path that first preserves immutable source evidence, extracts typed signals/hard anchors, validates candidate memories against their evidence, and only then promotes a linked belief. Its deterministic multi-route read path returns bounded context separately from answer instructions, and its failure taxonomy distinguishes coverage, grounding, revision, scope, temporal, retrieval, and synthesis errors. [S5]

**GBrain change:** do not write a research conclusion directly into canonical Brain. First write a **proposal packet** containing: source evidence IDs, normalized claim IDs, claim status (`new`, `changed`, `missing`, `contradictory`, `confirming`), confidence, validity interval, supersession/contradiction links, and the exact run receipt. Validate hard anchors such as dates, versions, URLs, names, percentages, and quoted text deterministically where possible. Retrieve proposal context separately from answer/promotion instructions. Promote only after the existing operator-approval, schema/taxonomy, dry-run, and post-write readback gates pass.

**New vs repackaged:** external memory and provenance links existed conceptually in Brain. The new mechanism is the invariant that raw evidence is immutable and canonical memory is a validated, revisable index over it; extraction is not the authoritative memory. [B1, S5]

### 7. Evaluate the whole research capability, not just search accuracy

S1-DeepResearch argues that training/evaluation centered on closed-ended search misses evidence integration, open-ended synthesis, planning, file understanding, report generation, and skill use. Its trajectory construction combines graph-grounded task formulation, open-ended/closed-ended rollouts, and multi-dimensional verification. [S7]

**GBrain change:** extend eval cases beyond “did the answer find the fact?” to include: did the system cover the brief’s subgoals, preserve evidence, detect conflict, produce a citable deliverable, use the workspace, respect artifact/write boundaries, and leave a reusable provenance trail? Keep retrieval, reasoning, synthesis, and write-back as separately scored dimensions.

**New vs repackaged:** broader multi-dimensional evaluation is a known aspiration. The advance is making the trajectory and deliverable dimensions explicit and verifiable enough to train/compare against them. [B1, S7]

## What is genuinely new versus repackaged

| Pattern | Classification | Why |
|---|---|---|
| Lead + multiple specialized scouts | Repackaged | Already in Brain’s protocol/source basis; Anthropic-style orchestrator-worker pattern is prior art. |
| Query decomposition, parallel tools, reflection, citation checking | Repackaged at concept level | Existing Brain already requires these; recent work makes them typed and stateful. |
| Shared support/contradiction evidence graph with gap-targeted dispatch | Genuinely new mechanism in this window | Changes parallelism from independent sampling to compositional evidence assembly. [S1] |
| Editable dependency-aware research DAG and local descendant re-execution | Genuinely new operationalization | Turns a plan into an executable artifact users/critics can edit. [S2, S6] |
| Persistent workspace as cross-agent coordination and writer substrate | Changed/novel combination | External memory is old; raw-source archive + structured KB + controls + section-wise writer is a stronger contract. [S3] |
| Rubric as live planning/retrieval/stopping guidance | Changed, not wholly new | Rubrics/checklists are old; injecting them into control state and stopping is the useful new use. [S2] |
| Agentic critic with independent retrieval and temporal/factual probes | Genuinely new evaluation mechanism | Moves beyond citation alignment and grants the evaluator comparable tools. [S4] |
| Immutable evidence-before-belief memory | Genuinely new write-back invariant | Separates source, extracted belief, retrieval, answer policy, and repair/erasure. [S5] |
| Graph-grounded trajectory construction and multi-dimensional verification | Changed training/eval target | Expands “deep search” into report, file, skill, and open-ended research behavior. [S7] |

## Recommendation

Implement a reversible **Research State v2** prototype with four additions: (1) evidence/claim graph plus gap frontier, (2) executable plan DAG with typed research operations, (3) persistent run workspace feeding a constrained writer, and (4) provenance-first proposal memory plus a two-layer agentic critic. Keep canonical Brain write-back `not_run` for this benchmark. The first GBrain experiment should compare flat fan-out against graph-directed dispatch at matched tool/token budgets and score coverage, contradiction detection, citation faithfulness, extrinsic factuality, synthesis quality, and later-session retrieval.

## What would change this answer

- A controlled GBrain trial shows graph dispatch adds cost without improving evidence coverage, contradiction handling, or final reports.
- Independent replication finds the reported gains are mainly backbone/model-size effects rather than workflow mechanisms.
- Provenance-first proposals fail to improve correction, temporal validity, or auditability relative to direct canonical writes.
- A cheaper static evaluator matches agentic evaluator sensitivity to stale and extrinsically false claims on live tasks.

## Evidence boundary

This is a source-backed architecture recommendation, not a claim that GBrain has already implemented or validated these mechanisms. The Brain lookup found the existing skill/changelog but no post-2026-07-01 topic page. The included sources are mostly primary papers, but several are preprints or technical reports with self-reported benchmarks. No Perplexity call, canonical Brain write, code change, commit, push, or publication was performed.

## Source registry and receipt

- Full provenance and rejected-source log: `source-ledger.md`.
- Claim-level mappings and audit gates: `claim-ledger.md`.
- Run metadata, timing, tool receipts, failures, and promotion decision: `receipt.md`.
