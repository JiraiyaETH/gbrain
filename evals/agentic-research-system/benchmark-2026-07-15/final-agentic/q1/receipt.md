# Run Receipt

## Run metadata

- **Date:** 2026-07-15
- **Operator/request:** Alex benchmark run; exact prompt in `exact-prompt.txt`.
- **Skill:** `agentic-research-system` v1.1.0 (canonical `/Users/jarvis/gbrain/skills/agentic-research-system/SKILL.md` read before execution; not edited).
- **Effort tier:** Deep, bounded manual run.
- **Artifact root:** `/Users/jarvis/gbrain/evals/agentic-research-system/benchmark-2026-07-15/final-agentic/q1/`
- **Side-effect boundary:** read-only Brain/web/terminal acquisition; writes limited to the six requested artifacts under artifact root. No Perplexity, no canonical Brain write, no repo code change, commit, push, or publish.
- **Freshness window:** 2026-04-16 through 2026-07-15 inclusive (strict 90-day boundary used; 2026-04-09 Q+ source rejected from findings).

## Timing and acquisition budget

- **08:51:00 +07:00:** created artifact directory and exact prompt; Brain search/query started.
- **08:51:** Brain-first search/query returned no topic-specific result; fallback found and read the existing skill/changelog.
- **08:52:** web discovery queries completed; primary URLs selected.
- **08:52–08:53:** source bodies retrieved/read with `curl` + BeautifulSoup for arXiv HTML and `curl` + `pdftotext` for ACL PDFs. Included seven strong sources; acquisition stopped below the cap of eight.
- **08:53:56 +07:00:** current time checked; artifacts written after source acquisition and before final verification.
- **Acquisition stop:** before minute 12 of the requested 20-minute budget; no follow-up retrieval was needed after the critic because all decision-critical mechanism claims had direct primary support or explicit downgrades.

## Lanes used

| Lane | Tool/model | Scope | Output path | Status |
|---|---|---|---|---|
| Brain scout | `gbrain search/query/get` | existing GBrain context, decisions, gaps | `brain-context.md` | complete; partial topic match |
| Web discovery | `web_search` | locate recent candidate papers/benchmarks | `source-ledger.md` | complete |
| Primary body acquisition | `curl`, BeautifulSoup, `pdftotext`, `read_file` | read original arXiv/ACL bodies, not snippets | `source-ledger.md` + `raw-output.md` | complete; 7 included |
| Critic / gap analyzer | lead synthesis against source bodies and Brain baseline | duplication, primary coverage, contradictions, decision utility | `claim-ledger.md` | complete |
| Citation auditor | lead claim-to-source audit | no snippets, source IDs, freshness, contradictions | `claim-ledger.md` | pass |
| Synthesis writer | lead only | decision memo separated facts/judgment/hypotheses | `raw-output.md` | complete |

## Verification performed

- Read back Brain results via `gbrain get`; preserved the bounded packet verbatim in `brain-context.md`.
- Read primary source bodies for all seven included sources; search snippets were used only for discovery.
- Checked all included publication dates against the 90-day window.
- Mapped every material claim in `raw-output.md` to source IDs or Brain baseline IDs in `claim-ledger.md`.
- Disclosed competing hypotheses and the distinction between repackaged patterns and new mechanisms.
- Ran pre-synthesis gates: zero unsupported material claims, zero snippet-only citations, no unresolved contradiction, no stale included source, and no side-effect breach.
- Verified that all artifact writes target only the requested q1 directory.
- Final readback verification: pending immediately after this receipt write; see final verification result below.

## Cross-model eval

- **Required?** Yes under the skill for high-value reusable research output.
- **Method:** formal `gbrain eval cross-modal` was not run because the available CLI exposed only the generic `gbrain eval` help in this bounded run and no safe separate run-output receipt surface was available without overwriting a required artifact. This is recorded as a limitation, not a green eval.
- **Verdict:** run-output citation/claim audit **pass**; cross-model gate **waived/blocked by unavailable safe provider surface**, not passed. No promotion to canonical Brain or skill occurred.

## Failures / near misses

- Initial broad Brain search/query returned no topic-specific pages; fallback lookup found the relevant existing skill/changelog and novelty was explicitly limited to that partial baseline.
- `web_extract` failed with a payment-required scrape error. Direct read-only `curl` retrieval of the same primary source bodies succeeded; no failed scrape was cited.
- Two PDF extraction commands were blocked by a security approval heuristic for piping downloaded text to an interpreter; rerun safely via `pdftotext -o file` and `read_file`.
- Near miss: Q+ (2026-04-09) looked relevant but falls outside the strict 90-day window; it is disclosed as a rejected boundary comparator, not counted as a new-window result.

## Cost / latency roughness

- Seven external primary sources; no Perplexity; no subagent spawning; no external mutations.
- Exact provider token/cost telemetry was unavailable from the shell tools. Acquisition was completed before the 12-minute cap; total wall time remained inside the requested 20-minute window.

## Surprisingly useful

- The strongest convergence was not on “more parallel agents” but on shared structured state: Argus evidence graphs, DuMate/PaperPilot workflow DAGs, FS-Researcher workspace artifacts, and Eywa provenance graphs all make intermediate state inspectable and revisable.
- DREAM’s distinction between citation alignment and external factual/temporal validity directly sharpens GBrain’s existing citation-audit gate.

## Eval cases to save

1. Flat parallel fan-out vs gap-directed evidence-graph dispatch at matched tool/token budget.
2. Citation-aligned but temporally stale report; agentic critic should catch it.
3. Direct canonical write vs provenance-linked proposal memory under correction/supersession.
4. Contradictory primary sources requiring graph edges, explicit disclosure, and an abstention/downgrade.
5. User edits one research-plan DAG node; only affected descendants should re-run.

## Promotion decision

| Candidate | Promote to | Decision | Reason |
|---|---|---|---|
| Evidence graph + gap frontier | workflow prototype/eval case | defer canonical implementation | strong convergent evidence, but no GBrain A/B yet |
| Executable editable research DAG | workflow prototype/eval case | defer | promising; needs cost/latency and replay tests |
| Persistent workspace as writer substrate | workflow prototype | defer | likely compatible with current artifacts; validate integration |
| Agentic capability-parity critic | eval case + prototype | defer | high-value correction to citation-only critique; needs safe evaluator harness |
| Evidence-before-belief proposal write-back | Brain write-back design proposal | do not write | no operator approval for canonical Brain writes; benchmark gate remains `not_run` |
| One-off source facts | Brain | reject | this run is about mechanisms, not durable domain facts |

## Final verification result

**PASS (2026-07-15T08:54 +07:00):** `search_files` returned exactly the six requested files, `read_file` confirmed the exact prompt and decision memo/receipt headers, and a byte-size check confirmed all six are non-empty: `exact-prompt.txt` 322 B; `brain-context.md` 2,940 B; `raw-output.md` 13,241 B; `source-ledger.md` 7,752 B; `claim-ledger.md` 6,842 B; `receipt.md` 7,360 B. No files outside the requested artifact root were intentionally modified.
