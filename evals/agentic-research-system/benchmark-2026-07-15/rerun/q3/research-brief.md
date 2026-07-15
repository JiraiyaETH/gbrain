# Q3 protocol-lite brief

## Objective
Evaluate the causal alternatives in the exact question: whether supplying existing Brain context before external research improves novelty and factual accuracy, or instead anchors the researcher and reinforces existing beliefs. Synthesize empirical evidence and propose safeguards for Brain-first research.

## Decision this informs
Whether Brain-first should remain the default research ordering, and what controls are required before treating Brain-relative novelty or factual accuracy as reliable.

## Scope
- Evidence on anchoring, confirmation bias, prior/context effects, retrieval-augmented or memory-augmented research, novelty/diversity, factual accuracy, and debiasing.
- Workflow safeguards that can be implemented in the canonical agentic-research-system v1.1.0.
- Explicit separation of empirical findings, design rationale, and hypotheses.

## Out of scope
- Editing Brain, skills, benchmark shared reports, or source repositories.
- Scoring this benchmark or claiming causal superiority from one run.
- Treating implementation notes in the Brain as outcome evidence.

## Freshness
Evergreen evidence is acceptable for cognitive/ML research; include publication dates and access timestamps. Current workflow design and Brain state are captured at run time (2026-07-15 UTC).

## Source classes needed
- Original papers/benchmarks or systematic reviews for cognitive and ML evidence.
- Primary technical documentation or research papers for RAG/memory/context effects.
- Expert/engineering sources only for implementation patterns, corroborated where material.

## Effort tier
Deep/manual: bounded multi-source research, source/claim ledger, competing hypotheses, citation audit, no cross-model scoring.

## Side-effect boundary
Read-only external research; no login, send, post, purchase, account change, Brain write, skill edit, shared report edit, commit, push, or publication. Writes are limited to this isolated q3 directory.

## Required output shape
- Exact prompt and Brain context packet.
- Full unedited raw output for pre-refactor Perplexity sonar-pro.
- Full raw evidence/tool outputs for the Brain-first agentic lane.
- Source ledger, claim ledger, citation/provenance registry.
- Latency, usage/cost/tool data where observable.
- Short execution receipt.
- No score.

## Quality bar / failure conditions
- No claim of Brain-relative novelty from absence of search results.
- No snippet-only citations; source bodies must be read/extracted.
- Material claims map to source IDs or are labeled hypothesis.
- Contradictions and evidence boundaries are disclosed.
- If context is thin, say so and distinguish Brain design claims from external effectiveness evidence.

## Proposed lanes
1. Pre-refactor Perplexity baseline: old brain-augmented prompt, sonar-pro.
2. Agentic lead: same packet, independent web search/extraction lanes for cognitive evidence, RAG/memory evidence, and safeguard/measurement evidence; critic + ACH pass + citation audit.
