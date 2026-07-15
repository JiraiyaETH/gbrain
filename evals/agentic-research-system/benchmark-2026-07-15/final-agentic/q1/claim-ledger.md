# Claim Ledger and Citation Audit

## Material claims

| Claim ID | Finding / classification vs Brain | Type | Source IDs | Confidence | Audit disposition |
|---|---|---|---|---|---|
| C1 | **New mechanism:** replace flat parallel-rollout aggregation with a shared evidence/claim graph whose nodes encode evidence and tentative claims and whose edges encode support/contradiction. | method | S1 | high | approved; directly described in source body |
| C2 | **Changed:** parallel investigation should be gap-directed: the coordinator computes missing or under-supported parts and dispatches targeted searchers rather than blindly adding more independent rollouts. | method/judgment | S1, S2 | high | approved; independently convergent in two primary sources |
| C3 | **New combination:** retain a compact graph view for synthesis so searcher count/token volume does not linearly inflate writer context; Argus reports 25.6M searcher tokens compressed to 21.5K graph-view tokens. | number/method | S1 | medium-high | approved with benchmark-specific caveat |
| C4 | **Changed:** make the research plan an editable, dependency-aware DAG with coarse-to-fine expansion, reflection, backtracking, and parallel ready-frontier execution. | method | S2, S6 | high | approved; PaperPilot shows the same first-class workflow idea in literature search |
| C5 | **New boundary:** recursive nested search agents can own local retrieval loops while the outer planner retains global strategy, isolating retrieval noise from synthesis/control. | method | S2 | medium-high | approved; technical-report evidence, no direct GBrain ablation |
| C6 | **Changed:** turn rubrics/checklists into live control state that guides retrieval, claim grounding, stopping, and synthesis—not merely a post-hoc judge. | method | S2 | medium | approved with downgrade: one primary technical report |
| C7 | **Changed:** give source discovery first-class typed operations (query expansion/frontier selection, evidence extraction, progress/sufficiency checks) and log their intermediate state; do not rely only on hidden chain-of-thought. | method | S2, S6 | high | approved as workflow/state design; Q+ boundary comparator excluded from 90-day novelty count |
| C8 | **New operational substrate:** separate evidence accumulation from report writing in a persistent workspace containing raw sources, structured notes, todos, checklists, and logs; let the writer load facts on demand. | method | S3 | high | approved; ACL primary source; filesystem is a substrate, not a Brain write policy |
| C9 | **Changed training/eval target:** research quality must include open-ended synthesis, planning, file/artifact handling, and skill use, not only closed-ended search/answer verification. | judgment/method | S7 | medium-high | approved; relevant to eval design, not direct runtime architecture |
| C10 | **New critique mechanism:** the evaluator/critic should have capability parity with the researcher—independent retrieval, temporal checks, extrinsic factuality, and reasoning probes—because citation alignment alone can create a “Mirage of Synthesis.” | method | S4 | high | approved; ACL primary source |
| C11 | **Changed memory write-back:** use evidence-before-belief: preserve immutable source evidence, validate extracted claims against source/hard anchors, link every proposal to provenance, and keep retrieval separate from answer policy. | method | S5, S3 | high | approved as architecture proposal; no canonical Brain write in this run |
| C12 | **Changed promotion rule:** research findings should first land as provenance-linked, versioned proposals/receipts; only verified, novel, non-contradictory findings with operator approval may become durable Brain knowledge. | recommendation | B1, B2, S5 | high | approved; follows current Brain gate plus new provenance evidence |
| C13 | **Repackaged pattern, not genuinely new:** “use multiple agents,” “search in parallel,” “reflect,” “cite sources,” “use an external memory,” and “have a critic” were already in B1/source basis. The genuinely new contribution is making the coordination/evidence/memory/eval state explicit, typed, queryable, and auditable. | judgment | B1, S1-S7 | high | approved synthesis distinction |

## Contradiction / competing-hypotheses check

| Hypothesis | Evidence for | Evidence against / limitation | What would disconfirm |
|---|---|---|---|
| H1: More independent parallel rollouts are the main route to better deep research. | B1/Anthropic baseline and S1 show parallelism can help. | S1 explicitly finds duplication and context saturation; its main gain comes from verify/dispatch before scaling. | A GBrain A/B where flat fan-out consistently beats gap-directed graph dispatch at equal compute. |
| H2: Structured shared evidence state is the leverage point. | S1 support/contradiction graph; S2 dynamic plan/evidence state; S3 persistent KB; S6 executable DAGs. | Most evidence is self-reported and system-specific; no GBrain transfer test. | A controlled GBrain trial showing no quality, coverage, or auditability gain after controlling for compute. |
| H3: Citation alignment is sufficient critique. | Existing B1 citation audit catches unsupported/uncited claims. | S4 shows aligned citations can still mask stale/extrinsically false claims and weak reasoning. | A live benchmark where citation alignment tracks independent temporal/factual verification across task types. |
| H4: Write-back should store extracted canonical facts directly. | Compact facts are efficient for retrieval; current Brain has promotion gates. | S5 identifies coverage, grounding, revision, scope, temporal, retrieval, and synthesis gaps; immutable evidence-before-belief makes repair/deletion possible. | A provenance-free GBrain memory store matching provenance-first performance and auditability on repeat research tasks. |

## Pre-synthesis gates

- `CLAIM_WITHOUT_SOURCE_ID`: **0** material claims; judgment claims are explicitly marked and mapped.
- `SNIPPET_CITED_AS_SOURCE`: **0**; all included sources were read from arXiv HTML or ACL PDF bodies.
- `DECISION_CRITICAL_SOURCE_WEAK`: **none unresolved**; mechanism claims use original papers/reports; generalization is downgraded where appropriate.
- `SOURCE_STALE_FOR_BRIEF`: **0 included**; all S1-S7 fall in 2026-04-16 through 2026-07-15. Q+ is disclosed as a rejected 2026-04-09 boundary comparator.
- `CONTRADICTION_NOT_DISCLOSED`: **0**; H1-H4 and limitations are disclosed.
- `SCOUT_BOUNDARY_BREACH`: **0**; no logins, submissions, mutations, or Brain writes.

## Citation registry

Approved source IDs: **S1, S2, S3, S4, S5, S6, S7, B1, B2**. The raw output may cite only these IDs. Each source's canonical URL, title, publisher/author, date, access route, authority, and caveats are in `source-ledger.md`.
