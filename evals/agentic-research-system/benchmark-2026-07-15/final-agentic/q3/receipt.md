# Research Run Receipt

## Run metadata

- Date: 2026-07-15
- Operator/request: Benchmark Q3 final-agentic; answer the exact prompt in `exact-prompt.txt`
- Skill: `agentic-research-system` v1.1.0 (canonical skill loaded; not edited)
- Effort tier: Deep-lite / bounded benchmark run
- Artifact root: `/Users/jarvis/gbrain/evals/agentic-research-system/benchmark-2026-07-15/final-agentic/q3/`
- Side-effect boundary: read-only Brain and external research; no Perplexity, Brain writes, commits, pushes, publishes, logins, or external mutations
- Host/tool metadata: macOS 26.5.1; `gbrain` 0.42.53.0; research repo `/Users/jarvis/gbrain`

## Timing and acquisition budget

- Start / protocol inspection: 2026-07-15T08:51:09+07:00 (terminal `date -Iseconds`)
- Brain lookup: began before external search; `gbrain search`, `gbrain query`, `gbrain get` completed at the initial phase.
- External acquisition: 08:52–08:54:46+07:00.
- Acquisition stop: 2026-07-15T08:54:46+07:00, well before the 12-minute acquisition deadline.
- Included strong external sources: 8 / 8 maximum.
- Source-body methods: `web_search` for discovery; `requests` + BeautifulSoup for HTML; `requests` + pypdf for PDFs; no snippet-only citations.
- No external source required login/paywall for included evidence. SAGE and an anchoring meta-analysis were rejected when full bodies were not available in the time budget.

## Lanes used

| Lane | Tool/model | Scope | Output path | Status |
|---|---|---|---|---|
| Brain Scout | terminal `gbrain search/query/get` | Existing claims, decisions, gaps, related procedures | `brain-context.md` | pass; read-only |
| Human-search evidence | `web_search` + terminal source-body retrieval | Anchoring/confirmation/order effects in information search | `source-ledger.md`, `claim-ledger.md` | pass |
| RAG factuality | `web_search` + pypdf | Retrieval and self-reflective retrieval factuality/citation evidence | same | pass |
| Context-conflict | `web_search` + ACL/arXiv HTML/PDF retrieval | Long-context, generated-vs-retrieved, internal-vs-external conflict | same | pass |
| Multi-perspective design | `web_search` + Stanford project page retrieval | Coverage and source-bias tradeoff | same | pass |
| Critic / ACH | lead manual audit | Competing hypotheses, missing primary evidence, unsupported claims | `claim-ledger.md` | pass; no unsupported material claim left |
| Citation auditor | lead manual audit | Claim→source mapping, source-body check, reject snippet-only support | `claim-ledger.md` | pass |
| Synthesis | lead | Decision memo and safeguards | `raw-output.md` | pass |

## Brain packet and delta classification

- Brain status: non-empty but thin for this question; one relevant procedural skill page and changelog, no direct empirical comparison.
- `confirming`: external evidence supports the Brain procedure’s emphasis on bounded context packets, explicit gaps, critic passes, and citation audits (C1–C3, C9).
- `new`: human search anchoring evidence, long-context position effects, RALM conflict behavior, STORM breadth/source-bias tradeoff, and concrete evaluation safeguards (C3, C5–C6, C9).
- `changed`: none established; no Brain factual claim was directly contradicted and no direct external correction to Brain was found.
- `contradictory`: external literature contradicts the naive implication that retrieval/context is automatically beneficial or truth-preserving; this is a contradiction of an unstated assumption, not of a stored Brain claim (C2, C5).
- `missing`: direct Brain-first vs Brain-blind causal evidence, novelty metrics, human/agent transfer study (C7).

## Verification performed

- [x] Exact prompt preserved.
- [x] Brain lookup was performed before external research and packet preserved.
- [x] External acquisition was bounded to 8 included sources and stopped before minute 12.
- [x] Source bodies were retrieved/read; search snippets were discovery-only.
- [x] Source ledger records included and rejected sources, queries, authority, dates, caveats, and gaps.
- [x] Claim ledger maps material claims to source IDs and labels hypotheses/missing evidence.
- [x] ACH competing-hypotheses pass completed.
- [x] Citation audit completed: no unsupported factual claim in the memo; direct-vs-inferred boundaries disclosed.
- [x] No canonical Brain writes or repository mutations occurred.
- [ ] Formal `gbrain eval cross-modal`: unavailable in installed CLI; `gbrain eval cross-modal --help` returned the generic `gbrain eval` help instead of an executable evaluator.
- [x] Manual run-output review substituted: lead source audit + critic pass; no blocker averaged away. This is not a claim of independent cross-model agreement.

## Cross-model / eval disposition

- Required? Yes in the skill for high-value reusable research output.
- Formal method: attempted, unavailable in this environment/CLI.
- Manual method: source-backed self-critique using the skill’s blocker rubric and ACH table.
- Verdict: **pass with accepted limitation** for benchmark artifact completion; independent reviewer receipt was not available.
- Follow-up eval case: paired Brain-blind / Brain-first / Brain-after benchmark with stale and false Brain injections, randomized source order, blind claim scoring, and novelty/factuality metrics.

## Failures / near misses

- `web_extract` failed on all tested URLs with a Firecrawl “Payment Required / insufficient credits” response. Recovered by directly retrieving public HTML/PDF bodies with `requests`, BeautifulSoup, and pypdf.
- Formal GBrain cross-modal evaluator was not exposed by the installed CLI; recorded rather than fabricated.
- No direct causal study of personal Brain-first context was found. The final memo explicitly downgrades this from fact to evidence gap.
- Search-result snippets for SAGE and the anchoring meta-analysis were not cited, avoiding snippet laundering.

## Cost / latency roughness

- Wall-clock run from 08:51:09 to final artifact write: under 10 minutes at receipt time.
- Acquisition: 8 included sources, 3 rejected/discovery-only sources, 2 external retrieval mechanisms after web_extract failure.
- No subagent processes or external side effects were launched.

## What was surprisingly useful

- The strongest direct human evidence came from a prospective search experiment (S1), while the strongest agent-relevant evidence came from conflict studies (S6/S8), not generic RAG gains.
- The key distinction is not Brain-first versus Brain-never; it is Brain-as-structured-hypothesis versus Brain-as-authority.

## Promotion decision

| Candidate | Promote to | Decision | Reason |
|---|---|---|---|
| Direct claim that Brain-first improves novelty/accuracy | nothing | do not promote | Direct causal evidence missing |
| Structured Brain packet + blind/delta lanes + contradiction gate | eval | propose | Reusable hypothesis requiring paired benchmark validation |
| Safeguards in `raw-output.md` | nothing yet | hold | Evidence-backed design proposal, not validated as a package |
| Durable Brain fact | Brain | prohibited / not run | Benchmark has no write-back approval; canonical Brain untouched |

## Artifact manifest

- `exact-prompt.txt` — exact user prompt and run constraints.
- `brain-context.md` — dated, lossless-enough Brain lookup packet and gaps.
- `raw-output.md` — complete decision-useful answer.
- `source-ledger.md` — search log, 8 included sources, rejected sources, gaps.
- `claim-ledger.md` — material claims, classifications, ACH, citation audit.
- `receipt.md` — this run receipt.
