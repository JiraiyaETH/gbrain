# Agentic Research System Changelog

## 1.3.0 — 2026-07-16

- Upgraded from broad fan-out to an editable research DAG and gap-frontier dispatch.
- Added durable task-scoped workspace, shared evidence/claim state, paired Brain-aware/blind lanes, parity verification, contradiction search, and evidence-before-belief promotion proposals.
- Clarified bounded-writer ownership: workers propose; one lead serializes judgment and native GBrain promotion. No queue infrastructure is implied.
- Added DAG/state templates, upgrade protocol reference, validator coverage, and read-only E2E expectations.
- Repaired sequential phase numbering and integrated legacy validator phrases without inert headings.
- Added `references/source-basis-v1.3.md` with source classes, enforcement rules, and a filled claim/source audit mapping in response to cross-modal sourcing feedback.
- QA receipt: current `SKILL.md` is exactly 135 lines. Final commands/output: `node skills/agentic-research-system/scripts/agentic-research-system.mjs skills/agentic-research-system` → `ok:true, missing:[]`; `gbrain check-resolvable --strict` → `resolver_health: OK — 57 skills, all reachable`; `gbrain skillpack-check` → `healthy: true`, `57/57 skills pass`; `bun test test/agentic-research-system.test.ts` → `3 pass, 0 fail, 40 expect() calls`; `bun test test/e2e/agentic-research-system.test.ts` → `1 pass, 0 fail, 12 expect() calls`.
- Corrected Skillify cross-modal gate: the prior task (`Review the upgraded Agentic Research System skill...`) was malformed because it asked the output to review/evaluate itself, causing the OpenAI slot to judge the specification as a review report. Re-ran with the desired-output task: `Produce a concise, operational Agentic Research System skill specification that enforces evidence integrity, paired Brain-aware/blind lanes, gap-directed dispatch, bounded single-owner promotion, explicit source-basis rules, and deterministic testability.` Preserved `SKILL.md` unchanged. Before receipt `95de1f15`: overall `7.9`; dimensions GOAL `9.0`, DEPTH `8.3`, SOURCING `5.0`, SPECIFICITY `8.7`, USEFULNESS `8.3`; verdict `FAIL` (sourcing mean below 7). Corrected receipt `ac6917b8`: overall `9.3`; dimensions GOAL `10.0`, DEPTH `9.5`, SOURCING `8.0`, SPECIFICITY `9.0`, USEFULNESS `10.0`; verdict `PASS` across 2/3 successful configured providers (DeepSeek and Google). Configured OpenAI slot `openai:gpt-5.6` was unavailable (`Model "gpt-5.6" is not listed for OpenAI chat`); no substantive one-model improvements were applied. Durable receipt: `/Users/jarvis/.gbrain/eval-receipts/agentic-research-system-ac6917b8.json`.

## 1.2.0 — 2026-07-15

- Refactored the 590-line operational skill into a concise contract and phase router.
- Moved detailed methodology, source basis, schemas, rubrics, anti-anchoring safeguards, and promotion/evidence protocols to `references/operating-protocol-v1.1.md`.
- Preserved validated Brain-first injection, bounded/provider-neutral routing, delta classifications, ledgers, critique/citation gates, output contract, and controlled Brain promotion gate.
- Added a Skillify audit/E2E receipt under `evals/agentic-research-system/skillify-refactor-2026-07-15.md`.

## 1.0.0 — 2026-07-01

- Created shared GBrain skill from the agentic research system memo.
- Added protocol-lite brief, scout contracts, source/claim/citation templates, run receipt, eval report, resolver entry, manifest entry, unit tests, and e2e fixture.
- Cross-modal eval cycle 1 failed on sourcing/specificity/usefulness. Applied hard gates, source basis, material-claim definitions, reviewer reconciliation, and example artifacts before rerun.
- Claude Opus review found blockers around mutating frontmatter, eval target laundering, trigger ambiguity, and implied tool capability. Fixed by setting `mutating: true`, separating skillification vs run-output evals, tightening triggers, and declaring Browser/Social/Data-Code tool needs.
