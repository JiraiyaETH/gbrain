# Skillify refactor receipt — agentic-research-system

Date: 2026-07-15
Mode: audit/upgrade
Scope: `/Users/jarvis/gbrain/skills/agentic-research-system`

## Outcome

PASS for the structural refactor. `SKILL.md` decreased from **590 to 106 lines** (82.0% reduction), while the detailed v1.1 protocol was preserved verbatim in a linked reference and the existing templates/script were not changed. Version advanced to 1.2.0.

## 11-item Skillify audit

1. SKILL.md: PASS — frontmatter, contract, phases, gates, output contract.
2. Code: PASS — existing deterministic script retained; no new runner needed.
3. Cross-modal eval: WAIVED/BLOCKED — `gbrain providers test` reports embedding provider not configured; no safe configured cross-modal surface was available. Existing prior benchmark/eval evidence was not altered.
4. Unit tests: PASS — targeted Bun tests, 3 unit assertions groups pass.
5. Integration tests: NOT APPLICABLE to this documentation-only refactor; existing fixtures remain.
6. LLM evals: NOT RUN — no configured provider; no fabricated result.
7. Resolver trigger: PASS — existing resolver entry and triggers preserved.
8. Resolver eval: PASS at fixture level — routing fixture schema test passes; repository resolver emits existing fixture warnings.
9. Check-resolvable: PASS non-strict; strict has 12 pre-existing warnings (7 design-heist manifest warnings and 5 routing-eval schema warnings).
10. E2E: PASS — existing fixture proves trigger → protocol/brief → ledgers/memo/receipt artifact chain and no-write-by-default contract.
11. Brain filing: PASS/not applicable — skill writes only through gated native Brain surfaces; no Brain resolver change required.

## Preserved contract

Brain-first dated context injection; bounded scout/source routing; provider neutrality; `new`/`changed`/`missing`/`contradictory`/`confirming` delta classification; source/evidence/claim/citation/run/eval ledgers; critic, competing hypotheses, pre-synthesis and citation audit; anti-anchoring/no-novelty-from-absence safeguards; memo/output contract; controlled canonical Brain promotion and no-write gate.

## Moved material map

- `references/operating-protocol-v1.1.md`: source basis, effort tiers/caps, Brain packet schema, acquisition/source hygiene, scout handoff/output schema, evidence definitions/downgrades, critic rubric, hard gates, provenance minimum, synthesis rubric, cross-modal rubric/reconciliation, self-evaluation, promotion rules, anti-patterns, verification checklist, and filled-example link.
- Existing `templates/*`: brief, source/claim/citation/eval/memo/receipt schemas retained and linked from the concise entrypoint.
- Existing `scripts/agentic-research-system.mjs`: retained; no deterministic extraction added.

## Commands and results

- `bun test test/agentic-research-system.test.ts test/e2e/agentic-research-system.test.ts` — PASS (4 tests, 37 expectations).
- `bun src/cli.ts check-resolvable --skills-dir skills/` — PASS advisory mode; 12 warnings unrelated to this refactor.
- `bun src/cli.ts check-resolvable --strict --skills-dir skills/` — FAIL on same 12 warnings: design-heist manifest orphan warnings and repository routing-eval fixture schema warnings; not changed.
- `gbrain providers test` — BLOCKED: embedding provider not configured; cross-modal eval safely skipped.
- custom Markdown-link existence check — PASS (2 links, 0 missing).
- `wc -l` — 590 → 102 main lines; reference 590 lines.

## Known gaps

- Formal cross-modal review/eval could not run without configured providers; this is explicitly recorded, not represented as a pass.
- Repository-wide strict resolver remains red from unrelated pre-existing warnings; the agentic routing fixture itself passes its current unit schema test, while the CLI checker expects the older `input`/`expect` shape.
- No Brain content or canonical Brain writes were made.

## Exact changed files

- `skills/agentic-research-system/SKILL.md`
- `skills/agentic-research-system/references/operating-protocol-v1.1.md` (new, preserved detailed protocol)
- `skills/agentic-research-system/CHANGELOG.md`
- `evals/agentic-research-system/skillify-refactor-2026-07-15.md` (this receipt)
