---
name: agentic-research-system
version: 1.3.0
description: |
  Decision-grade, source-backed research with Brain-aware and Brain-blind
  lanes, bounded gap-directed scouts, evidence ledgers, citation audit, and
  operator-controlled promotion proposals.
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
    related_skills: [brain-ops, data-research, academic-verify, cross-modal-review, skillify]
---

# Agentic Research System

## Contract

Produce a bounded research artifact and decision-first verdict. The owning lead
serializes judgment and promotion; concurrent workers may only propose evidence,
claims, gaps, contradictions, and follow-ups. Native GBrain write gates are the
only canonical promotion path; this skill does not assume a queue exists.

Every serious run MUST have: protocol-lite brief; dated Brain packet; editable DAG;
task-scoped durable evidence workspace; shared evidence/claim state; source,
claim, citation, and run ledgers; paired aware/blind lanes; gap-frontier
scouting; source acquisition router; independent temporal/factual verification
with capability parity; evidence-before-belief promotion; pre-synthesis/citation
audit; and a no-write promotion proposal.

## Use / don't use

Use for deep, technical, vendor, market, academic, benchmark, current-state, or
reusable-process research. Do not use for a one-URL summary, one-canonical-source
lookup, unsafe/private investigation, or external action.

## Operating phases

1. **Brief + plan.** Fill `templates/research-brief.md`. Create an editable DAG
   in `templates/research-dag.json`; nodes have IDs, dependencies, status,
   lane, budget, and acceptance criteria. Persist all artifacts under a unique
   task workspace (never a shared mutable directory).
2. **Brain packet.** Read Brain first (`search → query if thin → get`) and write
   a dated, bounded packet into the workspace. Empty Brain means no novelty
   claim. Inject the same packet into the Brain-aware lane; the blind lane gets
   the objective and source policy but not Brain claims.
3. **Shared state.** Initialize `templates/evidence-state.json`. Workers append
   proposals with stable source/claim IDs; the lead merges/deduplicates and
   records status (`proposed|verified|rejected|contradictory`). Workers never
   overwrite judgment or canonical pages.
4. **Scout the frontier.** The lead dispatches only the highest-value open DAG
   gaps (not repeated broad fan-out). Each scout receives scope, allowed tools,
   source classes, stop condition, and a bounded budget. Preserve provider-neutral
   acquisition and downgrade/terminate on budget, auth, or side-effect breach.
5. **Paired verification.** Run temporally fresh and factual checks independently,
   with equivalent tools, source budgets, and instructions in both lanes. Search
   explicitly for contradictions and anchoring-induced omissions. Classify each
   finding against Brain: `new|changed|missing|contradictory|confirming`.
6. **Evidence-before-belief.** A claim may become `verified` only after direct
   source support, provenance, freshness check, and contradiction disposition.
   The lead proposes promotion only after citation audit and pre-synthesis gates;
   unsupported material claims remain hypotheses or are removed.
7. **Synthesize + audit.** Use `templates/research-memo.md`; facts, judgment,
   hypotheses, evidence confidence, and recommendation strength stay separate.
   No snippet, model summary, or uncited provider output supports a material claim.
8. **Promotion proposal + receipt.** Use `templates/run-receipt.md`. Proposal is
   no-write by default. Canonical Brain promotion requires operator approval,
   taxonomist/schema check, rendered diff, native write, readback, and sync.

## Bounded tiers

| Tier | Shape | Source cap |
|---|---|---:|
| Quick | lead + one focused check | 3 |
| Standard | paired lanes + critic | 10 |
| Deep | paired lanes + 3–5 directed scouts | 25 |
| Ocean | explicit operator approval and custom budget | stated in brief |

A scout returns provenance, exact supported claims, caveats, gaps, and follow-ups;
never a final conclusion or side effect. Brain-first lookup is `search → query
if thin → get`, with a dated packet. Subagent Structure is bounded proposal work:
scouts never own judgment. The Cross-Model Eval Gate uses Skillify when configured;
otherwise record the exact blocker. See [operating protocol](references/operating-protocol-v1.1.md),
[source-basis guidance](references/source-basis-v1.3.md), and [upgrade mechanisms](references/upgrade-mechanisms-v1.3.md).

## Required artifacts

Brief; `research-dag.json`; `evidence-state.json`; source/claim/citation ledgers;
Brain packet; aware/blind lane receipts; memo; eval report; and run receipt.
Templates live in `templates/`. The deterministic tree validator is
`scripts/agentic-research-system.mjs`.

## Pre-Synthesis Validator and Citation Auditor

The Pre-Synthesis Validator and Citation Auditor enforce claim/source mapping.
No snippet citations are permitted. Promotion Decision is recorded in the
receipt as a no-write proposal unless every native gate is approved.

## Hard gates and output

Fail or downgrade on `CLAIM_WITHOUT_SOURCE_ID`, `SNIPPET_CITED_AS_SOURCE`,
`CONTRADICTION_NOT_DISCLOSED`, `SOURCE_STALE_FOR_BRIEF`, `SCOUT_BOUNDARY_BREACH`,
or `BELIEF_BEFORE_EVIDENCE`. Deep/Ocean runs require zero unsupported material
claims and direct support or explicit downgrade for every decision-critical claim.

```text
Verdict: <decision-first summary>
Confidence: <evidence confidence>
Recommendation strength: <strong|directional|speculative|do-not-act-yet>
Evidence boundary: <checked and not checked>
Artifacts: <workspace paths>
Promotion: <no-write proposal|operator-approved native write|nothing>
Next move: <one action or blocker>
```

## Verification

Confirm the brief, DAG, shared state, Brain packet, both lanes, directed gap
dispatch, independent verification, contradiction search, ledgers, citation audit,
memo, eval disposition, no-write proposal, and receipt readback. Run Skillify
structural/check-resolvable/skillpack checks plus targeted unit, integration,
LLM/routing evals and the read-only E2E fixture. Cross-modal review is preferred;
if unavailable, record the exact blocker and use one independent review without
claiming provider diversity.
