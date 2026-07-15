# Source Ledger

## Research brief

- **Objective:** identify advances published/accessed in the 90-day window 2026-04-16 through 2026-07-15 that should alter GBrain's agentic deep-research workflow.
- **Decision:** which mechanisms to adopt now, which to prototype, and which are repackaged patterns.
- **In scope:** source discovery, parallel investigation, evidence/state tracking, critique/evaluation, synthesis, and memory write-back.
- **Out of scope:** Perplexity (baseline already exists), vendor feature comparison, production code changes, canonical Brain writes, and claims not supported by read source bodies.
- **Effort tier:** Deep, bounded to 7 included external sources (cap 8); acquisition ended before 09:00 local time.
- **Side effects:** read-only web/terminal/Brain lookup; artifact writes only under this q1 directory.
- **Stop rule:** stop at 7 strong primary sources spanning the requested mechanisms; do not add weaker commentary merely to reach 8.

## Search log

| Time (local) | Lane | Query / URL | Tool | Result | Include? | Reason |
|---|---|---|---|---|---|---|
| 08:51 | Brain | agentic deep research... | gbrain search | no results | baseline | Required first lookup; preserved in brain-context.md |
| 08:51 | Brain | full question | gbrain query | no results | baseline | Required first lookup; no topic-specific page |
| 08:51 | Brain | deep research; research system; agentic research | gbrain search/query | existing skill + changelog | yes (B1/B2 baseline) | Read with gbrain get; establishes prior art in Brain |
| 08:51 | Web | agentic deep research systems Apr/May/Jun 2026 | web_search | Argus, DuMate, FS-Researcher, Q+ | discovery | Used only to locate primary bodies |
| 08:52 | Web | agentic deep research benchmark/evidence/citation critique | web_search | DREAM, DeepResearch Bench, LiveResearchBench | discovery | DREAM body included; benchmark pages not needed as separate evidence |
| 08:52 | Web | agent memory write-back/provenance 2026 | web_search | Eywa, MemQ | discovery | Eywa body included; MemQ not needed for research-system-specific write-back |
| 08:52 | Primary retrieval | S1/S2/S5/S6/S7/S8 arXiv HTML; S3/S4 ACL PDFs | curl + BeautifulSoup/pdftotext | bodies read; titles, dates, methods, limitations extracted | yes | Primary/authoritative bodies, not snippets |
| 08:52 | Web extract | same five-page batch | web_extract | Firecrawl payment-required errors | no | Retrieval route failed; source bodies were independently retrieved with curl and read |
| 08:53 | Boundary check | arXiv:2604.07927v1 (Q+) | curl/read | published 2026-04-09 | no (boundary) | Outside strict 90-day window; retained as rejected boundary comparator only |

## Included sources

| Source ID | Title | URL | Source class / authority | Published | Supports | Caveats |
|---|---|---|---|---|---|---|
| S1 | Argus: Evidence Assembly for Scalable Deep Research Agents | https://arxiv.org/html/2605.16217v1 | paper / primary | 2026-05-15 | shared evidence graph; support/contradiction edges; gap-targeted dispatch; graph-only synthesis; parallel scaling | arXiv preprint; self-reported benchmark results; 35B-A3B stack |
| S2 | DuMate-DeepResearch: An Auditable Multi-Agent System with Recursive Search and Rubric-Grounded Reasoning | https://arxiv.org/html/2606.07299v1 | technical report / primary | 2026-06-05 | dynamic DAG planning; reflection, backtracking, parallel branching; nested Search Agents; live rubrics for planning/stopping/synthesis; traceable tool calls | vendor technical report; self-reported results; Baidu-centered tool ecosystem |
| S3 | FS-Researcher: Test-Time Scaling for Long-Horizon Research Tasks with File-System-Based Agents | https://aclanthology.org/2026.acl-long.288.pdf | ACL paper / primary | ACL 2026, 2026-07-02 proceedings | persistent workspace; Context Builder/Report Writer separation; archived raw sources; citation-grounded hierarchical KB; revisable control files; external-memory test-time scaling | reported results use sampled/benchmark protocols; filesystem substrate needs GBrain-native adaptation |
| S4 | DREAM: Deep Research Evaluation with Agentic Metrics | https://aclanthology.org/2026.acl-long.448.pdf | ACL paper / primary | ACL 2026, 2026-07-02 proceedings | capability-parity evaluation; agentic retrieval for temporal validity, factuality, coverage, and reasoning probes; exposes citation-alignment fallacy | evaluator itself uses model/tool assumptions; not a production critic implementation |
| S5 | Eywa: Provenance-Grounded Long-Term Memory for AI Agents | https://arxiv.org/html/2605.30771 | paper / primary | 2026-05-29 | immutable evidence before belief; validated extraction; typed hard-anchor checks; deterministic multi-route read; separate retrieved context from answer policy; failure taxonomy | memory benchmarks, not deep-research-specific; arXiv preprint; provenance establishes support, not truth |
| S6 | Multi-Turn Agentic Scientific Literature Search via Workflow Induction (PaperPilot) | https://arxiv.org/html/2607.00597v1 | paper / primary | 2026-07-01 | executable editable DAG search workflows; user feedback edits workflow not just query text; workflow-level metrics and error tracking | literature-search domain; arXiv preprint; simulated user feedback |
| S7 | S1-DeepResearch: Beyond Search, Toward Real-World Long-Horizon Research Agents | https://arxiv.org/html/2606.15367 | paper / primary | 2026-06-13 | graph-grounded task formulation; mixed closed/open-ended trajectories; multi-dimensional trajectory verification; report/file/skill capabilities beyond search | training/data-construction focus; self-reported model results; not a deployed orchestration runtime |

## Rejected / boundary sources

| Title | URL | Reason rejected | Could still be useful for |
|---|---|---|---|
| EigentSearch-Q+: Enhancing Deep Research Agents with Structured Reasoning Tools | https://arxiv.org/html/2604.07927v1 | 2026-04-09 is outside strict 2026-04-16 to 2026-07-15 window | Boundary comparator: typed query/evidence tools, explicit search-progress checks, targeted extraction; confirms this pattern predates the window |
| DeepResearch Bench landing page | https://deepresearch-bench.github.io/ | Search result/benchmark landing page, not needed after primary method papers | Background benchmark context |
| LiveResearchBench | https://arxiv.org/html/2510.14240v2 | Outside 90-day window and evaluation baseline rather than a new mechanism in this window | Prior benchmark context for citation association/accuracy |
| web_extract outputs for source batch | tool failure | Payment-required scrape failure; not evidence | None; replaced by direct primary-body retrieval |
| Search snippets | search result text | Snippets cannot support claims under the protocol | Discovery only |

## Evidence gaps

| Gap | Why it matters | Follow-up query/source | Decision impact |
|---|---|---|---|
| No direct ablation in GBrain | New mechanisms may not transfer to Brain schemas/tools | build an A/B harness for linear fan-out vs evidence-graph dispatch | prototype, do not canonicalize yet |
| No evidence that Brain write-back improves later research | Memory write policy is an architectural recommendation, not a proven GBrain result | benchmark proposal-memory vs canonical-memory vs no-memory on repeat tasks | keep write-back gated and reversible |
| Cost/latency under GBrain provider mix unknown | Argus/DuMate gains may be compute-heavy | measure wall time, tool calls, tokens, and marginal evidence gain | add explicit budget controller |
| Peer review/replication varies | five sources are preprints or reports | track future peer-reviewed replication and open artifacts | confidence medium for cross-system generalization |
