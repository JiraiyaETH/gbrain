# Claim Ledger

Evidence confidence is about the claim's support; recommendation strength is assessed separately. All included sources were read beyond search snippets using source-body retrieval. Relative labels refer to Brain context packet B1–B5 in `brain-context.md`.

| Claim ID | Material claim | Relative classification | Source IDs | Evidence confidence | Caveats / audit disposition |
|---|---|---|---|---|---|
| C1 | Relevant, accurate external context can improve factuality, coverage, updateability, and provenance compared with relying only on parametric memory. | confirming mechanism + new empirical detail | S3, S4 | high for RAG benchmark settings; moderate for Brain-first workflow | Direct support in RAG/Self-RAG; do not generalize to arbitrary Brain content without quality/freshness controls |
| C2 | Context is not automatically beneficial: irrelevant/off-topic passages, fixed indiscriminate retrieval, long context, and poor ordering can reduce accuracy or usefulness. | new | S4, S5 | high in controlled model experiments | The studies test model context use, not a personal knowledge base exactly |
| C3 | Existing prior beliefs can anchor search and interpretation: human pre-search beliefs significantly predicted post-search answers, and review evidence finds anchoring/confirmation/position effects in information seeking. | new | S1, S2 | moderate-high for human information search | S1 is health-search-specific; S2 is a critical review and notes heterogeneity/possible positive effects |
| C4 | A Brain packet can steer an agent toward the Brain's framing even when external evidence conflicts; this is a plausible risk, not directly quantified by the retrieved literature. | missing / hypothesis | S1, S2, S5, S8 (mechanism analogues) | moderate as mechanism inference; low as direct causal estimate | Must be labeled hypothesis in final answer; no direct Brain-first trial found |
| C5 | Models may resolve conflicts using salience, similarity, completeness, majority frequency, or internal-memory consistency rather than truth; correct retrieved evidence can lose to a faulty internal/generated context. | new and contradictory to naive “retrieval fixes truth” assumption | S6, S8 | moderate-high in evaluated RALM setups | S6 explicitly finds similarity/completeness effects; S8 finds internal-memory/majority effects; transfer to all models uncertain |
| C6 | Multi-perspective question asking and follow-up research can improve breadth and organization, but can transfer source bias and introduce red herrings. | new; partially confirming B4 | S7 | moderate | Official project summary, not a direct controlled Brain-first comparison |
| C7 | Current evidence does not establish that Brain-first context improves *novelty* relative to Brain, nor that it improves *net factual accuracy* versus a Brain-blind control. | missing | S1–S8 | high confidence in evidence boundary; no direct study found | Do not claim a causal net benefit; design an A/B benchmark |
| C8 | Best current verdict: Brain-first is conditionally useful as a structured hypothesis/coverage prior, but unsafe as an authority or first narrative. It is likely to improve accuracy when relevant, current, and source-grounded; it can reduce novelty and accuracy when stale, one-sided, overlong, or presented as settled truth. | synthesis / decision claim | C1–C7 | moderate overall | Directional recommendation only; subject to direct benchmark |
| C9 | Safeguards should separate Brain context from evidence, create blind/context-aware parallel lanes, force anti-hypothesis and contradiction searches, cap/rerank context, require claim-level citations, and measure drift/novelty/factuality. | new operational proposal grounded in S2, S4–S8 | S2, S4, S5, S6, S7, S8 | moderate for components; low for exact combined protocol | Proposal, not an experimentally validated package |

## Competing hypotheses / ACH pass

### H1 — Brain-first improves research quality
- Evidence for: S3 and S4 show relevant retrieved context can improve factuality and citation accuracy; S7 shows perspective-guided, multi-perspective pre-writing improves breadth/organization; a Brain packet exposes prior claims, gaps, and decisions that a fresh search may miss.
- Evidence against: S4 says indiscriminate retrieval can hurt; S5 shows more context and position can reduce performance; S6/S8 show incorrect or internally consistent context can beat correct external evidence.
- What would disconfirm: paired evaluations show no gain or a net loss in supported factual claims, coverage, or calibration when Brain is supplied.

### H2 — Brain-first anchors and reinforces beliefs
- Evidence for: S1 finds prior belief predicts post-search answer; S2 reviews anchoring, confirmation, and position effects and notes compounding; S8 finds RALMs favor internal-memory-consistent evidence; S5 shows primacy/recency effects.
- Evidence against: S3/S4 show external evidence can improve factuality when relevant and critiqued; S7 shows deliberate perspective diversity can increase breadth; S6 finds one observed conflict bias was driven more by similarity/completeness than parametric confirmation.
- What would disconfirm: randomized context-on/off and order-swapped trials show equal or better novelty, contradiction detection, and correction rates with Brain context.

## Citation audit

- Material claims C1–C3 and C5–C6 have direct source IDs.
- C4 and C7 are explicitly labeled hypothesis/missing evidence rather than asserted facts.
- C8–C9 are synthesis/proposal claims and are not presented as direct empirical findings.
- No search snippet is used as sole evidence; S1–S8 source bodies/abstracts/sections were retrieved and inspected.
- Decision-critical claim “Brain-first is net superior” was not made; evidence boundary is disclosed.
