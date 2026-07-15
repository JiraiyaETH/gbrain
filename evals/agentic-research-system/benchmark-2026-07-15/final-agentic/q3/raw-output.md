# Decision memo: Brain-first research and anchoring

## Verdict

Supplying existing Brain context before external research is **conditionally useful, not categorically superior**. It can improve factual accuracy and decision usefulness when the packet is relevant, current, provenance-rich, and used as a set of hypotheses/gaps. But the same packet can anchor the researcher or model, suppress novelty, and reinforce a stale or one-sided belief—especially when it is long, presented first as authoritative, or left unchallenged.

The evidence supports a **staged Brain-first workflow**, not “Brain as truth”: consult Brain first, but separate context from evidence; run an external lane that is blind to the packet; run a delta lane that receives it; then compare, contradict, and audit.

**Evidence confidence:** moderate overall. High for the narrower findings that relevant retrieval can improve factuality and that prior context/order/context conflict can bias search or model use. Low for the exact causal question “Brain-first versus Brain-blind research,” because no direct randomized comparison was found.

**Recommendation strength:** directional. Use Brain-first context for coverage, continuity, and explicit delta classification, but do not inject it as the sole or first narrative in the evidence-forming lane.

## What the evidence says

### 1. External context can improve factuality—but only when it is relevant and usable

Lewis et al. (RAG) combined parametric and non-parametric memory and reported better open-domain QA performance plus more specific, diverse, and factual language than a parametric-only baseline; in one human evaluation, RAG was judged more factual than BART in 42.7% of pairs versus 7.1% in the reverse direction (S3). Self-RAG similarly improved factuality and citation accuracy by making retrieval conditional and adding relevance/factuality critique rather than blindly appending a fixed number of passages (S4).

This supports the positive case for a Brain: it can provide durable facts, prior decisions, entity aliases, known gaps, and useful retrieval cues. It may reduce rediscovery and make changes relative to prior knowledge visible.

### 2. “More context” is not the same as “better context”

Self-RAG explicitly warns that indiscriminate or off-topic retrieval can reduce versatility and produce unhelpful generations (S4). Lost in the Middle found a strong position effect: models often used information best at the beginning or end of a long context and substantially worse in the middle; in some settings, adding many documents produced little gain and could lower performance below a closed-book baseline (S5). A Brain dump can therefore hurt through volume, ordering, redundancy, and salience even if every page is individually relevant.

### 3. Prior context can anchor human search and interpretation

In a prospective and retrospective study of online health-information search, pre-search belief significantly affected post-search answer (p < .001 in both analyses), with additional prospective order and exposure effects (S1). A review of more than thirty empirical information-retrieval studies finds anchoring, confirmation, exposure, and position effects across search tasks; it also notes that biases can compound, while positive effects are possible and findings are not universal (S2).

This is direct evidence for the human side of the risk. It does not prove that a Brain packet will have the same magnitude of effect on an LLM or agent, but it makes the risk operationally credible: the packet may change query wording, source selection, relevance judgments, and willingness to update.

### 4. LLM context conflict can produce reinforcement without truth tracking

In controlled conflicting-context experiments, GPT-3.5/4 and Llama2 often preferred generated contexts even when those contexts were wrong and retrieved contexts were correct. The authors attribute much of the effect to question similarity and semantic completeness, not simply confirmation with parametric memory (S6). A separate RALM conflict study reports that capable models can favor faulty internal memory despite correct evidence, follow majority frequency, and prefer evidence consistent with internal memory; its proposed contrastive calibration reduced the conflict in evaluated open models (S8).

The practical lesson is broader than “the model is biased”: a Brain page can be selected because it is familiar, semantically similar, complete, repeated, or framed as an expert decision—not because it is true. External citations do not automatically defeat a salient internal context.

### 5. Diversity helps coverage but can transfer source bias

STORM uses diverse perspectives and simulated follow-up questions in pre-writing. Its project report describes gains over a retrieval-augmented baseline in organization and breadth, while expert feedback identified source-bias transfer and red herrings as persistent challenges (S7). This is a useful design analogue for Brain-first research: use Brain to generate perspectives and questions, not to settle the answer.

## Direct answer on novelty vs factual accuracy

### Novelty

Brain-first context can improve **novelty relative to Brain** by exposing what is already known, making omissions and changes explicit, and generating targeted “what is missing?” queries. However, that is not evidence of novelty in the world. If Brain context determines the initial framing, query vocabulary, source domains, and acceptance criteria, it can reduce exploration and make the output look novel merely because the Brain was thin or incomplete.

No included study directly measures Brain-first versus Brain-blind novelty. Therefore the correct claim is: **Brain-first is a useful novelty baseline and delta detector, not a proven novelty generator.**

### Factual accuracy

Brain-first context can improve factual accuracy when it is accurate, fresh, relevant, and accompanied by external verification. RAG and Self-RAG support this conditional mechanism (S3–S4). But stale or incorrect Brain context can be an error prior. Long-context and conflict studies show that context quantity, order, similarity, completeness, internal consistency, and repetition can override correct evidence (S5–S8). Therefore: **Brain-first improves factuality only under evidence and conflict controls; otherwise it can lower it.**

## Safeguards for a Brain-first workflow

1. **Consult first, inject in stages.** Perform the required read-only Brain lookup and create the dated packet. Do not let the packet be the only input to the evidence-forming lane. Run at least one external scout with the raw question and no Brain claims, and a separate delta scout with the packet.
2. **Use a structured packet, not a narrative.** Separate each Brain item into claim, source/provenance, date, confidence, decision, gap, and contradiction. Put uncertain claims and old pages in a visibly lower-confidence section. Never label the packet “ground truth.”
3. **Create an anti-hypothesis lane.** For every material Brain claim, issue an explicit query such as “find primary evidence that would falsify or qualify this claim.” Require at least one search path that does not reuse Brain vocabulary.
4. **Diversify perspectives and sources.** Include primary/official sources, independent academic or benchmark work, opposing viewpoints, and—where relevant—data or replication evidence. Treat a source-family majority as corroboration, not truth.
5. **Control order and context length.** Keep the injected packet concise; place the research question and evaluation criteria before the packet; randomize source order in evaluation; rerank or truncate context; and test whether conclusions change when Brain items move from first to last or are omitted.
6. **Make provenance beat familiarity.** Every material claim must map to a directly read source ID. Prefer primary/official evidence for decision-critical claims. Do not allow a Brain assertion, model summary, search snippet, or repeated claim to substitute for source support.
7. **Resolve conflicts explicitly.** Maintain a table of Brain claim, external evidence for, external evidence against, source authority, freshness, and disposition. Do not majority-vote conflicting claims; use source quality, directness, methods, recency, and uncertainty.
8. **Retrieve on demand and critique.** Avoid appending all Brain pages. Retrieve only when the claim is relevant; grade relevance; then run a separate support/completeness check. If evidence is weak or contradictory, downgrade or leave unresolved rather than harmonize.
9. **Measure the workflow, not just the prose.** On a repeated question set, compare Brain-on/delta, Brain-blind, and optionally Brain-after-first-search conditions. Track factual precision/recall, claim entailment, citation correctness, correction rate, contradiction detection, calibration, source diversity, unique new-to-Brain claims, new-to-corpus claims, and decision usefulness.
10. **Gate write-back.** Never write findings into Brain during research. Promote only claims that are novel or verified corrections, source-backed, contradiction-disclosed, schema-checked, operator-approved, and read-back verified.

## Recommended benchmark design

For each question, create three randomized conditions:

- **Blind:** external search receives only the question.
- **Brain-first delta:** external search receives the structured Brain packet.
- **Brain-after:** external search runs first; Brain is revealed only for comparison and gap classification.

Use held-out questions and inject controlled stale, incomplete, and incorrect Brain claims. Blind reviewers score claim support and novelty without seeing the condition. The winning workflow is the one with the best supported-fact rate and useful coverage at an acceptable cost, not the one with the most “new” bullets.

## Evidence boundary

This run found strong adjacent evidence, not a direct Brain-first causal trial. Human search studies establish anchoring risk; RAG studies establish conditional factuality benefits; long-context and knowledge-conflict studies establish failure modes; STORM establishes a multi-perspective coverage pattern. None alone proves the net effect of a personal Brain packet on a general agent. A/B evaluation is required before making Brain-first the default evidence-forming order for high-stakes research.

## Source key

S1–S8 are fully recorded in `source-ledger.md`; material claims and support are mapped in `claim-ledger.md`.
