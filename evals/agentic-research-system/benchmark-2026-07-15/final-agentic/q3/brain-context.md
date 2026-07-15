# Brain-first context packet

## Retrieval metadata
- Brain: local GBrain instance resolved by `gbrain` in `/Users/jarvis/gbrain` (read-only lookup).
- Retrieved at: 2026-07-15T08:51:09+07:00 (initial run timestamp; external acquisition began after this lookup).
- Query: `Brain-first research anchoring novelty factual accuracy confirmation bias retrieval augmented generation`
- Exact research question: Does supplying existing Brain context before external research improve novelty and factual accuracy, or does it anchor the researcher and reinforce existing beliefs?
- Status: `non-empty, thin topical context`; no direct prior empirical finding answering the question was found.

## Searches performed
1. `gbrain search "Brain-first research anchoring novelty factual accuracy confirmation bias retrieval augmented generation" --limit 8` → No results.
2. `gbrain query "Does supplying existing Brain context before external research improve novelty and factual accuracy, or does it anchor the researcher and reinforce existing beliefs?" --limit 8` → No results.
3. `gbrain search "agentic research" --limit 8` → returned the agentic-research-system skill, changelog, resolver, and unrelated code pages.
4. `gbrain query "Brain-first research workflow existing context external research" --limit 8` → No results.
5. `gbrain get skills/agentic-research-system/skill` → returned the existing Agentic Research System skill page.

## Resolved Brain page and normalized claims
- `skills/agentic-research-system/skill` (retrieved via `search → get`; Brain page title `Skill`; source class `Brain/internal procedure`; last known date 2026-07-02 in Brain listing).
  - Brain claim B1: research should begin with an explicit, bounded brief and a Brain/internal context check.
  - Brain claim B2: a dated `brain_context` packet should be created before external research and passed to research lanes.
  - Brain claim B3: external findings should be classified as `new`, `changed`, `missing`, `contradictory`, or `confirming` relative to Brain.
  - Brain claim B4: source/claim ledgers, citation audits, critic passes, and promotion gates protect decision integrity.
  - Brain claim B5: write-back is prohibited for benchmark/unapproved runs; durable findings require approved native write surfaces.
- Related Brain page: `skills/agentic-research-system/changelog` (retrieved by search; last known 2026-07-02). It indicates the skill is a reusable procedure, not evidence that Brain-first context is empirically unbiased.

## Existing decisions
- For this benchmark: read-only lookup only; no Brain writes, repo commits, pushes, or publishing.
- Existing Brain contains a procedural rationale for Brain-first context but no direct controlled comparison of Brain-first versus Brain-blind research.

## Gaps and contradictions at baseline
- Gap G1: no direct Brain evidence comparing novelty, factual accuracy, or anchoring under Brain-first versus Brain-blind conditions.
- Gap G2: no Brain-local metrics or benchmark results for context injection.
- Gap G3: no Brain-local guidance on order randomization, blind control, contradiction sampling, or novelty measurement.
- No internal contradiction found; the procedural Brain claims are compatible with either empirical outcome.

## Injection contract used for external lanes
This packet was treated as context, not ground truth. External sources were instructed to test whether Brain-first lookup helps factuality/coverage and whether it causes anchoring, source-order, confirmation, or context-conflict failures. Evidence was classified relative to B1–B5 using the required delta labels. No novelty claim was inferred from absence in Brain; the scope is limited to the searches above.
