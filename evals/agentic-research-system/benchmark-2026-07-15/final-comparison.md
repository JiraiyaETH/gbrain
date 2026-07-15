# Perplexity vs Agentic Research — Final Comparison

**Benchmark date:** 2026-07-15  
**Scope:** exact three preserved Perplexity `sonar-pro` raw outputs versus the three fresh completed Agentic Research outputs in `final-agentic/q1–q3`. No workflow was rerun. Quality is scored independently of latency/cost.

## Decision

**Recommendation: keep Agentic and absorb Perplexity as an optional backend.**

Agentic wins the benchmark on evidence discipline, Brain-relative novelty accounting, completeness of the decision packet, and write-back usefulness. Perplexity remains useful as a fast discovery/draft backend—especially where a concise first pass is wanted—but its raw outputs do not consistently provide the source/claim ledgers, evidence boundaries, or promotion-safe provenance required for canonical GBrain research.

## Scores (0–5 each; 25 points per question)

| Question | System | Correctness / source quality | Novelty relative to Brain | Completeness | Citations / traceability | Write-back usefulness | Total / 25 |
|---|---|---:|---:|---:|---:|---:|---:|
| Q1 — recent deep-research advances | Agentic | 5 | 5 | 5 | 5 | 5 | **25** |
| Q1 — recent deep-research advances | Perplexity | 2 | 2 | 2 | 1 | 2 | **9** |
| Q2 — concurrent agents over Supabase/Postgres graph | Agentic | 5 | 4 | 5 | 5 | 5 | **24** |
| Q2 — concurrent agents over Supabase/Postgres graph | Perplexity | 3 | 3 | 4 | 2 | 3 | **15** |
| Q3 — Brain-first context, novelty, and anchoring | Agentic | 5 | 4 | 5 | 5 | 5 | **24** |
| Q3 — Brain-first context, novelty, and anchoring | Perplexity | 3 | 3 | 4 | 2 | 3 | **15** |
| **Aggregate** | **Agentic** | 15 | 13 | 15 | 15 | 15 | **73 / 75** |
| **Aggregate** | **Perplexity** | 8 | 8 | 10 | 5 | 8 | **39 / 75** |

Scores are comparative judgments against the same rubric, not claims of absolute truth. Agentic Q1/Q3 used seven/eight body-checked sources as recorded; Q2 used eight authoritative sources. The perfect-looking Q1 score reflects the unusually strong artifact and citation result, not a claim that the underlying papers are all independently replicated.

## Head-to-head findings

### Q1 — recent advances in agentic deep research

**Agentic is decisively stronger.** It identifies a coherent mechanism-level thesis—evidence/claim graphs with gap-directed dispatch, editable research DAGs, persistent workspaces, capability-parity evaluation, and evidence-before-belief memory—then explicitly separates genuinely new mechanisms from existing Brain patterns. It preserves a source ledger, claim ledger, Brain context, competing hypotheses, evidence gaps, freshness boundary, and a no-write promotion decision. It also labels preprints/technical reports and self-reported results rather than presenting them as settled transfer evidence.

Perplexity's output is shorter and directionally plausible, but the raw answer says that only one source is clearly in-window and then recommends a model-router change based on a secondary mid-2026 article. It does not preserve a comparable claim/source registry, does not establish the claimed evidence base at body level, and gives weaker novelty accounting. Its citations are opaque numeric markers with no usable provenance in the raw artifact.

### Q2 — concurrent agents sharing Supabase/Postgres

**Both converge on the same broad architecture; Agentic is more decision-safe.** Both recommend a queue-mediated bounded writer / single logical writer pattern with immutable provenance and projections. Agentic is stronger because it grounds the recommendation in official Supabase/PostgreSQL documentation, distinguishes authorization (RLS) from serialization, distinguishes queue delivery from exactly-once business execution, records stale-version/idempotency/lock/retry behavior, and refuses to invent numeric pool sizes without plan/workload telemetry.

Perplexity supplies a useful architecture narrative and compares shared-writer, single-writer, partitioned-writer, and queue variants. However, it mixes Brain/code facts, community/vendor guidance, and unspecified numbered citations; it proposes example pool reductions (for example, roughly five pooled and two-to-three direct connections) without measured capacity and includes several source references that are not reconstructable from the raw output alone. This is useful design input, but not promotion-ready evidence.

### Q3 — Brain-first research and anchoring

**Agentic is materially more disciplined, while Perplexity reaches a similar directional conclusion.** Agentic correctly says there is no direct randomized Brain-first versus Brain-blind causal study, distinguishes human-search evidence from LLM context-conflict analogues, labels the Brain-induced anchoring claim as a hypothesis/inference, and proposes a staged workflow with blind, delta, and Brain-after lanes plus measurable novelty/factuality outcomes.

Perplexity also states the central uncertainty and recommends safeguards such as cold takes, disconfirming searches, order randomization, and blind review. Its weakness is evidentiary traceability: many citations point to generic guides, secondary material, or opaque numeric references, and the prose sometimes upgrades indirect anchoring evidence into a stronger direct statement that Brain-first ordering “increases anchoring risk.” That is a reasonable hypothesis, but the raw output does not maintain the Agentic distinction between direct evidence, mechanism analogue, and inference consistently enough for write-back.

## Citation / claim sample checks

At least two decisive claims were checked per question against preserved local source bodies or authoritative URLs where accessible. A failed retrieval is recorded as a failure, not silently treated as a pass.

### Q1 checks

1. **Argus / evidence graph and gap-directed dispatch:** preserved source material under `rerun/q1/agentic-B` was searched/read. The Agentic claim ledger's S1 mapping is consistent with the preserved body-level evidence described in the run packet: shared support/contradiction state and targeted search allocation are directly represented. The raw Perplexity output's model-routing claim was **not independently confirmed** from a preserved primary body in the supplied packet; its own evidence boundary calls the source secondary.
2. **Argus token-compression and score figures:** Agentic reports the exact figures as paper-specific and caveated (`25.6M` searcher tokens to `21.5K` graph-view tokens; benchmark-specific improvement). The preserved source/claim packet supports that these are reported benchmark numbers, but this check does **not** establish independent replication or transfer to GBrain. This is a pass for faithful qualification, not for external truth beyond the paper.

### Q2 checks

1. **Supavisor/pool-budget claim:** the preserved Agentic source ledger records the official Supabase connection guidance and the receipt records body reading; a fresh `web_extract` attempt against the authoritative URL failed with Firecrawl `Payment Required / insufficient credits`. Therefore the current evaluator could not re-open the official body; this check is **preserved-receipt supported but not freshly reverified**. Agentic appropriately states that exact capacity is plan-specific and does not invent a number. Perplexity's analogous pooling claim is directionally consistent, but its raw citations do not identify the exact passage/source reliably.
2. **PGMQ visibility timeout / retry and advisory-lock behavior:** the Agentic ledger and receipt record official PGMQ and PostgreSQL bodies as read, and the memo carefully limits the conclusion to retryable queue handling and transaction-level locks. The same fresh URL retrieval failure prevented a new body check. **No fabricated pass:** this is an unavailable recheck, with the preserved run receipt as the evidence available to the evaluator.

### Q3 checks

1. **LLM anchoring:** preserved `rerun/q3/agentic-sources/llm-anchoring.txt` states that initial biased hints influence LLM answers and that simple CoT/reflection are insufficient without comprehensive angles. This directly supports Agentic's narrower claim that anchoring is a relevant mechanism and that mitigation needs perspective diversity; it does not prove Brain-first causality.
2. **Generated/retrieved or internal/external conflict:** preserved Q3 source bodies include the conflict-study materials (`generated-vs-retrieved-context.txt`, `context-faithfulness-memory.txt`, and related PDFs/TXT). They support the Agentic framing that model context conflict is an analogue and that correct retrieved evidence can lose to a salient/generated/internal context in evaluated setups. Again, this supports the mechanism analogue, not a direct Brain-first benchmark.

**Citation failure pattern:** Perplexity's raw outputs use numbered citations and source-like labels, but the preserved raw artifacts do not provide a stable source registry, exact locator, retrieval date, or body excerpt for each material claim. That materially lowers traceability even where the underlying proposition is plausible.

## Operational tradeoffs (separate from quality)

Only recorded receipts/metadata are used here; no missing provider telemetry is inferred.

- **Agentic:** Q1 acquisition stopped before minute 12; Q2 completed acquisition at about 08:55 after starting around 08:51; Q3 acquisition ran 08:52–08:54:46 and the receipt says the full artifact write was under 10 minutes. Recorded source counts were 7, 8, and 8. No subagents were spawned in these fresh runs, and exact provider token/cost telemetry was unavailable.
- **Perplexity:** preserved metadata identifies `sonar-pro`, but the supplied receipts do not expose a comparable complete wall-clock, token, or dollar-cost record for all three raw outputs. Do not claim that Perplexity was cheaper or faster from these artifacts alone.
- **Tradeoff:** Agentic has materially higher process overhead—Brain lookup, source-body acquisition, ledgers, audit, and artifact persistence—but that overhead buys inspectability and safer write-back. Perplexity is operationally attractive as a low-friction discovery/draft lane, but its benchmark evidence packet does not expose enough telemetry or provenance to compare total cost fairly.

## Fairness limitations

- This is one three-question benchmark, not a repeated-run statistical evaluation.
- The systems are not identical in execution envelope: Agentic used an explicit Brain-first protocol, bounded source acquisition, and artifact ledgers; Perplexity was evaluated from its exact preserved raw output and metadata. That difference is part of the workflow comparison, but it prevents isolating model/provider quality from workflow quality.
- Perplexity was `sonar-pro`; no provider/model-equivalent Agentic lane or formal cross-model reviewer was available during execution. The Agentic receipts explicitly record that the formal cross-modal eval surface was unavailable.
- Source freshness and access differ by question. Q1/Q3 Agentic bodies are preserved locally; Q2 authoritative URL rechecks were blocked by the current Firecrawl credit error, so the evaluator relied on preserved source-ledger/receipt claims and disclosed the limitation.
- Novelty is only relative to the bounded Brain packets, not to the whole Brain or the world. Q1 Brain context was partial; Q2/Q3 contexts were thin/non-empty.
- Latency/cost is not part of the 25-point quality score and cannot be compared symmetrically from the recorded receipts.

## Recommendation and next step

**Keep Agentic as the canonical research workflow and absorb Perplexity as an optional backend.** Route Perplexity into discovery, breadth expansion, or fast first-draft use, but require the Agentic source/claim/citation audit and provenance/write-back gates before any Perplexity-derived finding can enter canonical Brain. The next fair test should be repeated matched questions with equal source/body-access budgets, preserved provider telemetry, and blind scoring of claim correctness, citation entailment, novelty, and write-back safety.
