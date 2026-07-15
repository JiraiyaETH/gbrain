---
name: agentic-research-system
version: 1.2.0
description: |
  Use for high-caliber, source-backed agentic research: Brain-first context,
  bounded scouts, evidence ledgers, citation/critique gates, decision memo,
  cross-model review, and controlled promotion into Brain, skills, or evals.
triggers:
  - "agentic research"
  - "deep research system"
  - "run a research memo"
  - "research memo"
  - "decision-grade memo"
  - "source-backed memo"
  - "cross-model eval memo"
  - "skillify research process"
mutating: true
brain_first: required
tools: [query, search, get_page, web_search, web_extract, delegate_task, browser, x_search, terminal, eval]
metadata:
  hermes:
    tags: [research, subagents, citations, evals, source-ledger, decision-memo]
    related_skills: [brain-ops, data-research, perplexity-research, academic-verify, cross-modal-review, skillify]
---

# Agentic Research System

## Contract

For serious research, produce a bounded, source-backed research artifact and a compact user-facing verdict. The lead owns judgment; scouts are read-only evidence collectors. The process MUST:

1. Check Brain first when the topic touches prior people, companies, projects, decisions, or durable claims, and inject a dated `brain_context` packet into every external lane.
2. Create a protocol-lite brief before research (objective, decision, scope, freshness, source classes, tier, output, quality bar, stop rules).
3. Route acquisition by target: known URL → extract; unknown → search; known domain → map/selective extract; corpus → crawl; current discourse → social/current search; UI-only → browser receipt; data/PDF → code/data lane; academic/method → original papers.
4. Keep fan-out bounded and provider-neutral. Scouts return provenance, claims, caveats, gaps, and follow-ups; they never synthesize, mutate, log in, send, purchase, post, edit the repo, or write Brain.
5. Classify findings against Brain as `new`, `changed`, `missing`, `contradictory`, or `confirming`; absence is never novelty.
6. Maintain search/inclusion, evidence/source, claim, citation, run, and (when applicable) eval ledgers. No snippet, model-summary, or uncited provider output may support a material claim.
7. Run critic/competing-hypotheses and pre-synthesis gates, then citation audit; every material claim maps to approved source IDs or is labeled hypothesis.
8. Separate facts, judgment, hypotheses, evidence confidence, and recommendation strength; run cross-model review for high-stakes or reusable output.
9. End with a receipt and explicit promotion decision: Brain, skill, eval case, or nothing.
10. Treat canonical Brain write-back as a proposal until the controlled gate passes; no native write call before operator-approved scope, taxonomy/schema check, dry-run diff, and provenance/contradiction review.

## When to use

Use for deep/decision-grade, technical/vendor/market/protocol/academic diligence, benchmark synthesis, or reusable research process review. Do not use for a single-URL summary, one-canonical-source lookup, unsafe/private investigation, external action, or recurring watch before manual evidence/eval validation.

## Operating phases

1. **Brief and Brain packet.** Use `templates/research-brief.md`; run Brain search → query if thin → get. Record `brain_context_status: empty` when applicable and do not claim novelty.
2. **Route through the source acquisition router and scout.** Select the smallest tier that fits (Quick, Standard, Deep, Ocean). Give each lane scope, allowed tools, source classes, stop condition, caveats, and the delta contract. Apply the caps and downgrade rules in [operating protocol](references/operating-protocol-v1.1.md).
3. **Ledger and audit.** Use the templates below. Reject snippet-only support, disclose contradictions, downgrade weak evidence, and run the critic before synthesis.
4. **Synthesize and evaluate.** Use `templates/research-memo.md`; the Citation Auditor controls allowed source IDs. For high-stakes work use `templates/eval-report.md` and the cross-modal gate described in the reference.
5. **Receipt and promotion.** Use `templates/run-receipt.md`. For benchmark/unapproved runs, promotion is `not_run` and write-back is prohibited. Only GBrain-native write surfaces may write Brain; never raw filesystem edits.

## Required artifact set

- Brief: `templates/research-brief.md`
- Source/inclusion ledger: `templates/source-ledger.md`, `templates/source-card.json`
- Claim ledger/cards: `templates/claim-card.json`
- Citation registry: `templates/citation-registry.json`
- Memo: `templates/research-memo.md`
- Eval: `templates/eval-report.md`, `templates/eval-case.json`
- Receipt: `templates/run-receipt.md`
- Complete methodology, rubrics, schemas, source basis, and examples: [references/operating-protocol-v1.1.md](references/operating-protocol-v1.1.md)

## Compatibility anchors

## Phase 4 — Subagent Structure

## Phase 9 — Cross-Model Eval Gate

The detailed phases remain in the linked protocol: **Pre-Synthesis Validator** and **Citation Auditor**. No snippet citations are permitted.

## Hard gates

Fail and retrieve again (or explicitly downgrade/remove) on: `CLAIM_WITHOUT_SOURCE_ID`, `SNIPPET_CITED_AS_SOURCE`, `DECISION_CRITICAL_SOURCE_WEAK`, `SOURCE_STALE_FOR_BRIEF`, `CONTRADICTION_NOT_DISCLOSED`, or `SCOUT_BOUNDARY_BREACH`. Deep/Ocean targets are zero unsupported material claims, zero snippet citations, and direct support or explicit downgrade for every decision-critical claim.

## Controlled canonical Brain promotion gate

Record `WRITE_BACK_GATE` before any `put_page`, `add_timeline_entry`, `add_link`, or equivalent:

- Brain/source and context packet resolved;
- durable findings have claim IDs and approved source IDs;
- contradictions disclosed/dispositioned and citation/provenance audit passed;
- finding is novel or verified correction;
- brain-taxonomist/schema path check passed;
- operator approved the specific scope;
- dry-run/rendered diff reviewed;
- after an approved write, read back and run `gbrain sync --no-pull --no-embed`.

Without every applicable checkbox, keep proposed updates in the research artifact and do not write Brain.

## Output contract

```text
Verdict: <decision-first summary>
Confidence: <evidence confidence>
Recommendation strength: <strong|directional|speculative|do-not-act-yet>
Why: <2-4 bullets>
Evidence boundary: <what was/was not checked>
Artifacts: <memo, ledgers, receipt paths>
Next move: <one clear action or blocker>
```

### Verification

Confirm the brief, Brain packet, bounded scouts, source/claim/citation ledgers, critic, memo, eval disposition, receipt, and promotion decision. Detailed checklists and anti-anchoring safeguards remain in the linked reference.