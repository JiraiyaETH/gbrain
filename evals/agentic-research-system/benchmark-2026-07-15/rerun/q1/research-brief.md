# Q1 protocol-lite brief

## Objective
Identify important, source-backed advances in agentic “deep research” systems published or released from 2026-04-16 through 2026-07-15 (the last 90 days relative to the benchmark date) that should change GBrain’s Agentic Research System. Analyze source discovery, parallel investigation, evidence tracking, critique, synthesis, and memory write-back. Separate genuinely new mechanisms from earlier/repackaged patterns.

## Decision this informs
Whether to change the canonical GBrain research workflow, and if so which mechanisms deserve a skill/template change, a runner/workflow change, an eval case, or no change.

## Scope
- Public papers, official engineering/product documentation, released systems, benchmarks, and primary implementation artifacts with dates in the window.
- Mechanisms, not marketing labels: what is operationally new, what is merely a new wrapper around known patterns, and what evidence exists that it works.
- Comparison baseline: `brain-context.yaml` plus canonical `skills/agentic-research-system/SKILL.md` v1.1.0 and preserved pre-refactor Perplexity `sonar-pro` output.

## Out of scope
- Brain writes, skill edits, repo edits, commits, publication, external mutations, or scoring.
- Treating an undated page, search snippet, or model assertion as proof of a last-90-days advance.
- Claiming global novelty from absence in the checked sources.

## Freshness requirement
Strict: 2026-04-16 through 2026-07-15 inclusive by publication/release date where available. Older foundational mechanisms are retained only as explicit “repackaged / baseline” comparisons.

## Source classes needed
- Primary: official engineering posts, product/API docs, release notes, papers/preprints, benchmark reports, and code repositories.
- Secondary only for discovery or corroboration: reputable technical reporting/analysis.
- Brain pages for the internal baseline (read-only).

## Effort tier and limits
Deep, manually executed. Four bounded web lanes in parallel, up to 4 focused queries each, max 20 extracted/read sources total, followed by one critic pass and targeted follow-up only if a decision-critical claim is weak. No external side effects.

## Output artifacts
Two independent, side-by-side raw result packets:
- A: pre-refactor Perplexity Research via `sonar-pro`, exact same question and Brain context.
- B: executed Agentic Research System workflow using Brain-first context, parallel web source discovery, source/claim/citation ledgers, critic, synthesis, and proposed (not executed) memory write-back.

Both packets retain exact prompt, complete raw output, provenance, claim ledger, latency, observable usage/cost/tool data, and execution receipt. No score is assigned.

## Quality bar / failure conditions
- No snippet-only citations; source bodies must be extracted/read.
- Every material claim has one or more source IDs, or is labeled hypothesis / not found in checked scope.
- Last-90-days status is explicit per source.
- Contradictions and evidence gaps are disclosed.
- “Genuinely new” requires a dated mechanism with operational delta against the Brain baseline and at least one primary source; otherwise label repackaged, corroborating, or unverified.
- Write-back remains proposal-only and records target paths, dedupe keys, provenance, and the controlled gate status.

## Proposed lanes
1. Source discovery / research planning: new search, browse, query-planning, or evidence-acquisition mechanisms.
2. Parallel investigation / tool orchestration: fan-out, delegation, context sharing, cost/latency controls.
3. Evidence tracking / critique: claim support, citation correctness, provenance, verifier/critic loops, retrieval correction.
4. Synthesis / memory write-back: structured synthesis, uncertainty handling, durable memory updates, eval/feedback loops.
