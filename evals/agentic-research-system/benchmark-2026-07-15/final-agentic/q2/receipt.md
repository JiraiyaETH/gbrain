# Research run receipt

## Run metadata

- Date/time start observed: 2026-07-15T08:51:14+0700
- Acquisition cutoff: 2026-07-15T08:55:00+0700 (8 included external sources; no Perplexity)
- Receipt time: 2026-07-15T08:57:07+0700
- Operator/request: delegated benchmark task; exact prompt in `exact-prompt.txt`
- Skill: `agentic-research-system` v1.1.0 (canonical `/Users/jarvis/gbrain/skills/agentic-research-system/SKILL.md`)
- Effort tier: Deep, bounded
- Artifact root: `/Users/jarvis/gbrain/evals/agentic-research-system/benchmark-2026-07-15/final-agentic/q2/`
- Side-effect boundary: read-only Brain/external research; writes only to this artifact directory; no Brain write, commit, push, publish, or external mutation.

## Lanes used

| Lane | Tool/model | Scope | Output/artifact | Status |
|---|---|---|---|---|
| Brain Scout | `gbrain search/query/get` | Bounded internal context | `brain-context.md` | completed; thin-but-nonempty |
| Web/Docs Scout | `web_search` + browser DOM reads | Supabase pooling, PGMQ, RLS, async queue pattern | `source-ledger.md` | completed; S1,S2,S6,S7 |
| PostgreSQL Scout | `web_search` + browser DOM reads | Advisory locks, Serializable, SKIP LOCKED | `source-ledger.md` | completed; S3,S4,S5 |
| Architecture Scout | `web_search` + browser DOM reads | Event sourcing/CQRS trade-offs | `source-ledger.md` | completed; S8 |
| Critic / ACH | lead synthesis against H1/H2/H3 | Contradictions, gaps, alternative patterns | `claim-ledger.md` | completed; no contradiction found |
| Citation Auditor | manual claim-to-source audit | No snippets, source authority, direct support | `claim-ledger.md` | passed; 0 unsupported claims, 0 snippet-only citations |

## Observable tool metadata

- Brain search/query/get commands and outcomes are recorded in `brain-context.md`.
- External discovery queries and retrieval routes are recorded in `source-ledger.md`.
- `web_extract` was attempted but returned a payment/credit error; it was not used as evidence. Official source bodies were instead opened with browser navigation and read via browser DOM `innerText` extraction. This is recorded as a near miss, not hidden.
- Source cap: 8 strong sources, all included source bodies read before synthesis.

## Verification performed

- Read back all six required artifacts plus `research-brief.md` after write (see verification command below).
- Checked that required artifact names exist under the exact q2 directory.
- Reconciled every material claim in the memo to S1–S8 or marked it as judgment/inference in `claim-ledger.md`.
- Verified Brain delta labels: confirming/new/missing; no contradiction within bounded context.
- Confirmed no canonical Brain write-back was attempted; `WRITE_BACK_GATE` remains `not_run` by benchmark instruction.

## Cross-model eval gate

- Required? yes, because this is a high-value architecture decision and benchmark run.
- Formal `gbrain eval cross-modal` status: unavailable in this checkout; `gbrain --help` exposes no `eval` command, so no fabricated reviewer result is claimed.
- Manual substitute: critic/ACH + citation audit by the lead; receipt records the limitation.
- Verdict: source/citation gates passed; cross-model reviewer gate is an explicitly recorded limitation, not averaged away.

## Failures / near misses

- `date -Is` failed on macOS (`invalid argument 's'`); corrected to `date '+%Y-%m-%dT%H:%M:%S%z'`.
- Initial broad Brain searches returned no results; a narrower Brain query found the architecture index. Context is therefore thin and novelty claims are bounded.
- `web_extract` failed with a Firecrawl payment/credit error. Switched to browser navigation plus DOM read of the official source bodies.
- No source-side contradiction was found, but exact plan limits, contention distribution, and driver compatibility remain unverified.

## Cost / latency roughness

- Acquisition: 8 sources, completed by ~08:55; no subagent process or external write.
- Research was bounded to browser/web/Brain reads and artifact writes; no database connection benchmark was run.
- Connection numbers in the memo are formulas/policies, not invented capacity figures.

## Surprisingly useful

- Supabase explicitly separates pooler client connections from backend connections and warns about combined pooler/direct totals [S1].
- Supabase's own automatic-embedding guide supplies a concrete queue + batch + visibility-timeout retry pattern [S7], which transfers cleanly to expensive graph projections.
- GBrain's existing architecture page already records source-scoped reads, atomic write-through, and link provenance, making the recommended centralized write boundary an incremental fit rather than a greenfield rewrite.

## Eval cases to save

- Agent bypasses the command API and performs a direct projection update.
- Duplicate queue delivery creates duplicate events or re-applies a projection.
- Stale `expected_version` is silently overwritten.
- Transaction-pooler request relies on a session-level advisory lock or prepared statement.
- Autoscaling creates one connection pool per agent and exhausts backend connections.
- Projection lag or a dead-lettered command loses its provenance chain.

## Promotion decision

| Candidate | Promote to | Decision | Reason |
|---|---|---|---|
| Queue-backed bounded writer + immutable event/provenance ledger + projections | eval case / implementation proposal | accepted directionally | Strong evidence and fit; needs GBrain-specific load test and plan-cap measurement before implementation. |
| Pure event sourcing/CQRS everywhere | nothing yet | defer | Microsoft source confirms complexity and eventual-consistency costs. |
| Exact numeric pool sizing | nothing yet | do not promote | Missing plan limits and workload telemetry. |
| Skill patch / Brain write | nothing | prohibited/not_run | Benchmark forbids canonical writes and no repeated-run evidence exists. |

## Verification operation

`search_files(target=files, path=/Users/jarvis/gbrain/evals/agentic-research-system/benchmark-2026-07-15/final-agentic/q2, pattern=*)` returned all 7 artifacts.
