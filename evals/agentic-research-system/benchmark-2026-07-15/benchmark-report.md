---
title: Agentic Research System vs Perplexity benchmark — partial execution receipt
type: report
category: research-system-benchmark
date: 2026-07-15
status: partial — Perplexity completed; Agentic workflow incomplete
---

# Benchmark status

**Decision:** the exact secret lookup succeeded without exposing the value, and all three approved Perplexity `sonar-pro` calls returned HTTP 200. The refactored Agentic Research System was invoked read-only, but its CLI returned only a scout-dispatch acknowledgement for Q1 and no completed research output; Q2/Q3 could not be completed comparably in this run. Therefore no head-to-head quality scores or marginal-value claim are fabricated.

The pre-refactor Perplexity skill was preserved at `perplexity-research.pre-refactor.SKILL.md` in this artifact directory.

## Exactly three questions

1. **Current-world delta:** Against the existing Brain context for the GBrain project, what materially changed in the latest GBrain release notes/docs during the last 90 days, and which Brain assumptions are now stale, confirmed, or missing?
2. **Deep technical synthesis:** Compare PGLite and Postgres+pgvector as production backends for a multi-source personal/company Brain, synthesizing official GBrain architecture docs, PostgreSQL/pgvector primary documentation, and relevant benchmark evidence; state operational trade-offs and evidence limits.
3. **Contradiction/fact verification:** Verify the claim “Perplexity is unnecessary because a Brain-first agentic workflow can provide equal source quality, novelty, completeness, traceability, and useful write-back without it.” Identify which parts are supported, contradicted, or untested by the available evidence.

## Comparable-run protocol (ready when credentials are restored)

For each question, run the preserved `perplexity-research` workflow and the refactored `agentic-research-system` with the same Brain context packet, freshness boundary, read-only/no-write-back boundary, and wall-clock measurement. The refactored workflow may choose any modular backend; Perplexity is not mandatory.

The Brain packet must be captured before external research and include retrieved slugs, normalized claims, known decisions, gaps, contradictions, brain/source IDs, and timestamp. Every result must retain source-level provenance and a claim-to-source ledger. Write-back remains `not_run` for this benchmark.

## Scoring rubric (0–5 each; 25-point total)

- **Correctness/source quality:** factual accuracy, primary/authoritative sources, freshness, contradiction handling.
- **Novelty relative to Brain:** useful new/changed/missing/contradictory findings; no unsupported novelty claims.
- **Completeness:** covers the question, required source classes, caveats, and decision implications.
- **Citations/traceability:** claim-level mapping, canonical URLs, dates, retrieval method, and auditable provenance.
- **Write-back usefulness:** precise durable findings, target-page/path recommendations, deduplication, and safe gate readiness. No actual write occurs.

Unavailable fields must be recorded as `NA — blocked before run`: latency, token/tool-call count, provider cost, per-question scores, aggregate scores, and marginal Perplexity value.

## Results table

| Question | Perplexity score | Agentic score | Perplexity latency/cost/tools | Agentic latency/cost/tools | Marginal value |
|---|---:|---:|---|---|---|
| 1. Current-world delta | NA — no rubric score assigned | NA — incomplete Agentic run | 31.375s / $0.05874 / tools NA | NA — dispatch acknowledgement only | Undetermined |
| 2. Deep technical synthesis | NA — no rubric score assigned | NA — not run | 40.274s / $0.06876 / tools NA | NA — not run | Undetermined |
| 3. Contradiction/fact verification | NA — no rubric score assigned | NA — not run | 49.476s / $0.05706 / tools NA | NA — not run | Undetermined |

### Execution receipts

- Secret lookup: `/Users/jarvis/bin/get-secret.sh PERPLEXITY_API_KEY` → present; value was never printed or persisted. It was assigned only to a child process and then unset.
- Perplexity raw outputs: `perplexity-results/q1.json`, `q2.json`, `q3.json`; metadata contains measured latency, provider-reported usage/cost, and citation counts.
- Perplexity measurements: Q1 31.375s / 3,595 tokens / `$0.05874` / 11 citations; Q2 40.274s / 4,269 tokens / `$0.06876` / 13 citations; Q3 49.476s / 3,492 tokens / `$0.05706` / 15 citations. Tool-call count is NA (not exposed by API response).
- Agentic invocation: `agentic-q1.txt` contains only `Brain-first scout dispatched...`; no completed source-backed answer, score, latency/cost, or tool-call receipt was available. Q2/Q3 were not run after this incomplete execution because comparable results could not be produced safely.
- Brain context lookup was attempted read-only; the returned context was empty/thin (`/tmp/gbrain-benchmark-context.txt`, 12 bytes), so Perplexity was explicitly told not to claim Brain-relative novelty.

## Recommendation

**Recommendation: keep the refactored Agentic Research System as the canonical workflow; absorb Perplexity as an optional backend, and do not remove the preserved Perplexity skill yet.** This is a workflow/governance recommendation, not an outcome-superiority result: the three Perplexity calls completed, but the Agentic runner did not produce comparable completed outputs. The refactor's provider-neutral contract and evidence/write-back gates should be retained; Perplexity remains useful as an optional source-acquisition route until a functioning Agentic execution path completes the same three questions. A rerun is required before claiming Perplexity is redundant.

## Verification receipt

- Baseline preserved: yes.
- Perplexity skill deleted/rerouted: no.
- Canonical Brain pages updated: no.
- External API calls: 3 Perplexity calls; no Brain writes.
- Secrets logged: no.
- Write-back gate: `not_run`.
- Blocker: Agentic CLI did not complete the dispatched research run; only Q1 dispatch acknowledgement was returned.
