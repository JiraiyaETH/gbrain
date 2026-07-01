---
name: agentic-research-system
version: 1.0.0
description: |
  Use when running high-caliber agentic research: Brain-first brief, bounded
  subagent scouts, source/claim ledgers, citation audit, cross-model eval,
  decision memo, and promotion into Brain/skills/evals only after evidence
  gates pass.
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
tools:
  - query
  - search
  - get_page
  - web_search
  - web_extract
  - delegate_task
  - browser
  - x_search
  - terminal
  - eval
metadata:
  hermes:
    tags: [research, subagents, citations, evals, source-ledger, decision-memo]
    related_skills: [brain-ops, data-research, perplexity-research, academic-verify, cross-modal-review, skillify]
---

# Agentic Research System

## Overview

Use this skill when the user wants serious research that should survive scrutiny: technical diligence, vendor/tool selection, market/current-state research, protocol comparisons, academic or benchmark synthesis, or any question where a polished answer without traceable evidence would be dangerous.

The skill turns research into a bounded operating system:

```text
protocol-lite brief
→ Brain/internal context check
→ source acquisition router
→ scout fan-out
→ search log + inclusion ledger
→ source cards
→ claim cards
→ critic / competing-hypotheses gate
→ follow-up retrieval loop when weak
→ citation audit
→ constrained synthesis
→ cross-model eval when quality matters
→ run receipt
→ promotion decision: Brain / skill / eval case / nothing
```

The point is not to imitate a generic “deep research” product. The point is decision integrity: separate facts from judgment, show evidence boundaries, and compound useful lessons into Brain, skills, and evals.

## Source Basis

This protocol is grounded in the research memo that produced it and in the following source-backed patterns:

- Anthropic's multi-agent research system: lead agent decomposition, 3-5 parallel subagents, CitationAgent, token/tool-call scaling, tool-description optimization, and explicit effort scaling. Source: https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI Deep Research / Agents SDK: triage/clarifier/instruction-builder/research-agent patterns, background mode, handoffs, tools-as-agents, and guardrails. Source: https://developers.openai.com/api/docs/guides/deep-research
- STORM: multi-perspective pre-writing research and perspective-guided question asking. Source: https://storm-project.stanford.edu/research/storm/
- PaperQA2: agentic literature search, citation traversal, re-ranking, and contextual summarization. Source: https://arxiv.org/html/2409.13740v2
- Self-RAG / CRAG / RAGChecker pattern family: retrieval decisions, source relevance grading, claim support, and corrective retrieval. Sources: https://arxiv.org/abs/2310.11511 and https://arxiv.org/abs/2401.15884
- GAIA, WebArena, τ-bench, and BFCL V3: realistic tool-use, web, multi-turn, and repeated-run evals. Sources: https://arxiv.org/abs/2311.12983, https://webarena.dev/og/, https://arxiv.org/abs/2406.12045, https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html
- PRISMA/GRADE/Cochrane/ACH: protocol-lite evidence flow, confidence downgrades, claim-level risk assessment, and competing-hypotheses checks. Sources: https://www.prisma-statement.org/, https://gradepro.org/handbook/, https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-08

See `references/filled-mini-example.md` for a complete miniature source card, claim card, citation registry, and decision memo.

## Contract

When this skill is used, the agent guarantees:

1. **Brain-first lookup** before external research when the topic touches people, companies, projects, decisions, prior context, or durable claims.
2. **Explicit brief** before scout fan-out: decision, scope, freshness, source classes, output shape, and stop rules.
3. **Bounded subagents**: scouts collect evidence; they do not write the final answer or take external action.
4. **No snippet citations**: search snippets may discover sources, but only extracted/read source bodies support claims.
5. **Claim-level evidence mapping**: every material claim maps to source IDs or is labeled as hypothesis.
6. **Confidence and recommendation strength are separate**: evidence can be weak while a cheap probe is still justified, or strong while action is not.
7. **Cross-model eval for high-stakes output** before finalizing or skillifying behavior.
8. **Promotion discipline**: durable fact → Brain; repeated procedure → skill; failure trap → eval case; one-off noise → nothing.

## When to Use

Use this for:

- “go deep on this” research requests;
- source-backed research memos;
- technical architecture/tool/vendor selection;
- academic/benchmark synthesis;
- market, protocol, competitor, or ecosystem diligence;
- any research whose output should become reusable capability;
- cross-model review of a research memo or research skill.

Do not use for:

- a single URL summary;
- a quick fact lookup where one canonical source answers it;
- private/secrets-bearing investigation that cannot be safely delegated;
- public/external actions, outreach, posts, purchases, account changes, or destructive changes;
- recurring watches before this protocol has passed real manual runs.

## Effort Scaling

Do not spawn every lane every time.

| Tier | Use when | Shape |
|---|---|---|
| Quick | one narrow factual question | Lead + one source check |
| Standard | useful decision memo, modest uncertainty | Lead + Brain Scout + Web/Docs Scout + Critic |
| Deep | high-value question with multiple evidence classes | Lead + 3-5 scouts + Critic + Citation Auditor |
| Ocean | strategic/high-stakes research | Deep + follow-up loops + cross-model eval + eval-case creation |

## Phase 1 — Protocol-Lite Brief

Create a brief before research. Use `templates/research-brief.md`.

Required fields:

- objective;
- decision this informs;
- scope and out-of-scope;
- freshness requirement;
- source classes needed;
- budget/effort tier;
- side-effect boundary;
- output artifact shape;
- quality bar and failure conditions;
- proposed scout lanes.

Ask only ambiguities that materially change source selection, safety, cost, or output shape. If the default is obvious, proceed.

## Phase 2 — Brain/Internal Context Check

Run Brain lookup first when relevant:

```bash
gbrain search "<topic keywords>" --limit 8
gbrain query "<question plus known entities>" --limit 8
gbrain get <slug>        # for high-value pages found by search/query
```

Capture:

- relevant slugs;
- existing claims and decisions;
- stale assumptions;
- contradictions or unresolved gaps;
- related skills or prior procedures.

This phase is read-only. Brain writes happen only after the final promotion decision and through GBrain-native write surfaces.

## Phase 3 — Source Acquisition Router

Choose source routes deliberately:

```text
known URL → extract/scrape
unknown target → search
known domain → map then selective extract
whole corpus/theme → crawl and summarize by community/topic
entity/list enrichment → semantic search + structured extraction
current discourse → social/current search, labeled as discourse evidence
UI-only evidence → browser automation with screenshot/log receipt
numbers/tables/PDFs → data/code scout with script receipts
academic/method claim → papers and benchmarks, original source preferred
```

Source hygiene rules:

| Source class | Can support | Extra caution |
|---|---|---|
| Official docs / primary source | product, API, legal, policy facts | check freshness |
| Paper / benchmark | method/eval/science claims | inspect methodology and version |
| Expert blog / engineering post | implementation lessons | corroborate hard factual claims |
| Media | event reporting | corroborate technical/financial claims |
| Social/forum | sentiment/discourse | never sole truth source unless topic is discourse |
| Vendor comparison page | vendor self-claims | never sole support for competitor claims |
| Unknown SEO page | discovery only | cannot support final claims alone |

## Phase 4 — Subagent Structure

The default structure is cockpit plus bounded specialists:

```text
Lead Researcher / Cockpit
  ├─ Brain Scout
  ├─ Source Acquisition Router / Web Scout
  ├─ Academic Scout
  ├─ Primary Docs / Tooling Scout
  ├─ Browser / UI Scout
  ├─ Social / Current Scout
  ├─ Data / Code Scout
  ├─ Critic / Gap Analyzer
  ├─ Citation Auditor
  ├─ Synthesis Writer
  └─ Skill / Eval Distiller
```

Only the Lead Researcher owns final judgment. Scouts collect evidence; they do not conclude. The Citation Auditor controls what evidence the Synthesis Writer may cite.

### Scout Handoff Contract

Every scout gets:

1. scope and out-of-scope;
2. source classes to use;
3. side-effect boundary: read-only by default;
4. exact output schema;
5. stop condition;
6. caveat and gap requirements;
7. `allowed_tools` list, usually read-only tools only.

Default prohibitions for scouts unless the user explicitly approves the exact exception:

- no logins or credential entry;
- no form submissions;
- no contacting third parties;
- no purchases, bookings, sends, posts, DMs, follows, or account changes;
- no executing downloaded files or untrusted code;
- no Brain writes, repo edits, external mutations, or recurring job creation.

Cost/latency stop rules for V1 manual runs:

| Tier | Default cap |
|---|---|
| Quick | 1-3 sources, no subagent fan-out, no cross-model eval unless safety-critical |
| Standard | up to 2 scouts, up to 10 extracted sources, one critic pass |
| Deep | 3-5 scouts, up to 25 extracted sources, max 2 follow-up loops, citation audit required |
| Ocean | explicit operator approval; state budget, max sources, and stop rules before launch |

Terminate or downgrade a lane when it finds fewer than 2 useful sources after 5 focused queries, hits auth/paywall/secrets UI, or needs side effects outside the approved boundary.

Scout output shape:

```json
{
  "lane": "web_scout|academic_scout|docs_scout|data_scout|social_scout|browser_scout|brain_scout",
  "queries_run": [],
  "sources": [
    {
      "source_id": "S1",
      "url": "...",
      "title": "...",
      "source_type": "official|paper|docs|blog|media|forum|vendor|unknown|brain",
      "authority": "primary|secondary|tertiary",
      "freshness": "YYYY-MM-DD or unknown",
      "claims": [],
      "caveats": []
    }
  ],
  "gaps": [],
  "recommended_followups": []
}
```

## Phase 5 — Search Log, Source Cards, and Claim Cards

Use these templates:

- `templates/source-ledger.md`
- `templates/source-card.json`
- `templates/claim-card.json`

Definitions:

| Term | Meaning | Evidence bar |
|---|---|---|
| Material claim | A claim a reader could reasonably rely on for the answer | at least one source ID or hypothesis label |
| Decision-critical claim | A material claim that changes spend, safety, public action, legal/reputation risk, architecture, or strategy | primary/official source preferred; otherwise two independent source classes or explicit downgrade |
| Support | The cited source directly says or demonstrates the claim | no adjacent-only support unless labeled indirect |
| Hypothesis | Plausible interpretation not fully supported | must be marked and kept out of factual summary |

For serious work, record:

- what was searched;
- what was included;
- what was rejected;
- why a source can or cannot support claims;
- each material claim and its source IDs;
- evidence confidence and downgrade reasons.

Downgrade evidence confidence for:

- source incentive or bias;
- inconsistency;
- indirectness;
- imprecision;
- publication/visibility bias;
- stale evidence;
- missing primary source;
- weak methodology or unverifiable data.

## Phase 6 — Critic / Gap Analyzer

Before writing, run a critic pass. The critic answers:

- Are the right source classes represented?
- Are primary sources missing?
- Did scouts duplicate effort?
- Are important entities missing?
- Are contradictions surfaced?
- Did any source look like SEO/vendor/social slop?
- Are high-leverage claims weakly supported?
- Is the answer useful for the decision?

For judgment-heavy questions, add an ACH-style competing-hypotheses check:

```text
Hypothesis A:
Evidence for:
Evidence against:
What would disconfirm:

Hypothesis B:
...
```

If the critic fails the packet, do not let the writer improvise. Trigger targeted follow-up retrieval.

## Phase 6.5 — Pre-Synthesis Validator

Before synthesis, fail the run and return to targeted retrieval if any hard gate trips:

| Gate | Failure message | Remediation |
|---|---|---|
| Unsupported material claim | `CLAIM_WITHOUT_SOURCE_ID` | add source, downgrade to hypothesis, or remove claim |
| Snippet-only evidence | `SNIPPET_CITED_AS_SOURCE` | extract/read the source body or remove citation |
| Missing decision-critical primary source | `DECISION_CRITICAL_SOURCE_WEAK` | find primary/official evidence or explicitly downgrade |
| Stale source against freshness requirement | `SOURCE_STALE_FOR_BRIEF` | find fresher source or mark stale boundary |
| Unresolved contradiction | `CONTRADICTION_NOT_DISCLOSED` | add contradiction table and evidence-boundary note |
| Scout side-effect breach | `SCOUT_BOUNDARY_BREACH` | discard tainted output and rerun inside boundary |

Quantitative pass thresholds for Deep/Ocean runs:

- 0 unsupported material claims in the final memo;
- 0 snippet-only citations;
- 100% decision-critical claims have direct support or explicit downgrade;
- at least 2 independent source classes for non-primary decision-critical claims, unless the evidence boundary says why unavailable;
- cross-model eval: no reviewer blocker may be averaged away; blocker disposition must be pass/fixed/accepted-risk.

## Phase 7 — Citation Audit

Use `templates/citation-registry.json`.

Citation Auditor rules:

- dedupe sources;
- classify authority and freshness;
- map every material claim to source IDs;
- reject unsupported claims;
- downgrade weak claims to hypotheses;
- forbid citations from snippets, summaries, or inaccessible bodies unless the claim is only about the summary itself.

The Synthesis Writer may cite only approved source IDs from this registry.

## Phase 8 — Synthesis Writer

Use `templates/research-memo.md`.

The memo must separate:

- facts;
- judgment;
- hypotheses;
- confidence;
- recommendation strength;
- what would change the answer.

Recommendation strength labels:

| Label | Meaning |
|---|---|
| strong | evidence and action economics both support acting |
| directional | useful for low-cost/reversible next move |
| speculative | interesting, not enough to rely on |
| do-not-act-yet | evidence/action risk too weak for action |

## Phase 9 — Cross-Model Eval Gate

Use this when the output is high-stakes, skillifying behavior, or likely to become a reusable operating pattern.

There are two different eval targets. Do not mix them:

| Target | Artifact being evaluated | Purpose |
|---|---|---|
| Skillification eval | `SKILL.md` and templates | proves this reusable procedure is sound |
| Run-output eval | produced research memo + source ledger + claim cards + citation registry | proves a specific research answer is safe to finalize |

Preferred formal skillification gate:

```bash
gbrain eval cross-modal \
  --task "Evaluate whether this skill enables source-backed agentic research with safe subagent boundaries, citation discipline, cross-model eval, usable decision memos, and promotion gates." \
  --output /Users/jarvis/gbrain/skills/agentic-research-system/SKILL.md
```

Preferred run-output gate:

```bash
gbrain eval cross-modal \
  --task "Evaluate this research memo and evidence packet for unsupported material claims, citation laundering, missing contradictions, weak source classes, unclear confidence, and unsafe recommendations." \
  --output /path/to/research-run/research-memo.md
```

For run-output evals, attach or inline the source ledger / claim cards / citation registry in the memo packet when the eval surface only accepts one output file. A green SKILL.md receipt never proves a specific memo is correct.

If the formal GBrain eval provider surface is unavailable, use subscription-backed reviewer lanes and write a receipt under the task artifact directory:

- OpenAI/Codex/GPT family reviewer;
- Claude/Opus reviewer via `call-claude`;
- Grok/xAI reviewer via `call-grok` or Hermes xAI provider.

Reviewer rubric:

| Dimension | Question |
|---|---|
| Goal fit | Does the skill solve decision-grade research, not generic summary? |
| Subagent boundaries | Are roles bounded enough to avoid agent soup? |
| Evidence discipline | Are source/claim/citation rules concrete and enforceable? |
| Usability | Can an agent run the process from the skill without asking broad questions? |
| Safety/governance | Are side effects, Brain writes, costs, and eval promotion gated? |

Reconciliation rules:

- Use the same artifact packet and rubric for every reviewer.
- Treat reviewer outputs as advisory until Alex verifies them against the skill files/tests.
- Do not average away red flags: any safety, citation, or side-effect blocker must be fixed, explicitly accepted as risk by the operator, or recorded as unresolved before shipment.
- If reviewers disagree, create a disagreement table: reviewer, claim, evidence, Alex disposition.
- Re-run the formal eval after material patches so the receipt hash binds to the current SKILL.md.

Apply only verified reviewer findings. Cross-model agreement is signal, not permission to mutate blindly.

## Phase 9.5 — Self-Evaluation Checklist

Before calling this skill production-ready, answer:

| Area | Pass condition |
|---|---|
| Subagent boundaries | every lane has scope, allowed tools, stop condition, and read-only default |
| Sourcing/citations | source hierarchy, no-snippet rule, claim/source mapping, and conflict protocol are explicit |
| Cross-model eval | formal receipt or manual three-family receipt exists; blockers have dispositions |
| Memo usability | final memo separates facts, judgment, hypotheses, evidence confidence, and recommendation strength |
| Promotion gates | Brain/skill/eval promotion is explicit and prevents one-anecdote overfitting |

## Phase 10 — Run Receipt and Promotion Decision

Use `templates/run-receipt.md` and `templates/eval-report.md`.

End every serious run with:

```text
What failed?
What almost failed?
What was expensive?
What was surprisingly useful?
What should become an eval case?
What should become a skill/template change only after more evidence?
```

Promotion rules:

```text
One-off lesson → run receipt.
Repeated lesson → skill patch.
Stable general mechanism → runner/workflow design.
Safety-critical failure → patch immediately after verification.
```

Brain writeback requires GBrain-native write surfaces, not direct filesystem edits. After approved Brain writes in a synced repo, run:

```bash
gbrain sync --no-pull --no-embed
```

## Output Format

The final user-facing output should be compact:

```text
Verdict: <decision-first summary>
Confidence: <evidence confidence>
Recommendation strength: <strong|directional|speculative|do-not-act-yet>
Why: <2-4 bullets>
Evidence boundary: <what was/was not checked>
Artifacts: <memo, source ledger, receipt paths>
Next move: <one clear action or blocker>
```

Long detail belongs in the memo artifact, not chat.

## Common Pitfalls

1. **Agent soup.** Too many agents with vague roles create duplication and false confidence. Keep Lead Researcher as the only judgment owner.
2. **Search-snippet citations.** Snippets discover sources; extracted/read source bodies support claims.
3. **Letting the writer outrun the auditor.** The writer may only cite approved source IDs.
4. **Confusing evidence confidence with action strength.** Keep them separate.
5. **Skipping Brain-first lookup.** This loses prior decisions and creates stale contradictions.
6. **Over-building early.** Skill + templates first; deterministic runner only after 3-5 real runs.
7. **Cron before eval.** Recurring research without proven evals creates polished noise.
8. **Mutating Brain directly.** Use GBrain write surfaces only.
9. **Reviewer laundering.** Cross-model reviewers critique the artifact; they do not replace source evidence.
10. **No postmortem.** If failures do not become eval cases or skill patches, the system does not compound.

## Verification Checklist

- [ ] Brief states objective, decision, scope, source classes, output shape, and quality bar.
- [ ] Brain/internal context was checked or explicitly not applicable.
- [ ] Scouts had bounded roles, read-only side-effect boundaries, and schema outputs.
- [ ] Source ledger contains included/rejected sources and reasons.
- [ ] Every material claim maps to source IDs or is labeled hypothesis.
- [ ] Citation registry was created before synthesis.
- [ ] Critic/gap pass ran and follow-up retrieval happened for weak high-leverage claims.
- [ ] Final memo separates facts, judgment, hypotheses, confidence, and recommendation strength.
- [ ] Cross-model eval ran for high-stakes/skillifying outputs, or a blocked/waived reason is recorded.
- [ ] Run receipt captures failures, near misses, cost/latency roughness, and eval-case candidates.
- [ ] Promotion decision is explicit: Brain, skill, eval case, or nothing.
