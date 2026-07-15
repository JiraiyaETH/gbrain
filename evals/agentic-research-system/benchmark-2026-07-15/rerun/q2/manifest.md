# Q2 recovery packet manifest

## Scope and status

- **Benchmark lane:** Q2
- **Workspace:** `/Users/jarvis/gbrain/evals/agentic-research-system/benchmark-2026-07-15/rerun/q2/`
- **Run mode:** recovery-only; existing artifacts only
- **External/API/Brain research in this recovery:** none
- **Brain writes, scoring, commits, shared-report edits, and skill edits:** none
- **Package status:** raw outputs created; original Perplexity JSON preserved; readback verification passed

## Exact prompt

The exact benchmark question is:

> What is the best architecture for multiple concurrent AI agents sharing a Supabase/Postgres-backed knowledge graph while preserving provenance, preventing conflicting writes, and staying within a strict database connection budget? Compare viable patterns and recommend one for GBrain.

The full preserved lane prompt—including the required architecture patterns, Brain packet, source/citation instructions, and no-file-modification instruction—is stored verbatim in [`perplexity-prompt.txt`](./perplexity-prompt.txt).

- Prompt bytes: `5532`
- Prompt SHA-256: `c51369f930ebc79798442297ad97f7f06e850b9fc5cce0c29ccc67e97458ad3c`

## Brain packet

Primary bounded packet:

- [`brain-context.yaml`](./brain-context.yaml)
  - `retrieved_at: 2026-07-15T00:35:14Z`
  - `brain_id: default`
  - `source_id: gbrain-code`
  - `status: thin_broadened`
  - primary query returned no results; broadened Brain searches were recorded in the packet
  - known decisions, gaps, and contradictions are preserved verbatim
  - SHA-256: `d54054a944ae7f60747ab0d76bc096b2daa05e363fb8e0ce5e6883d8569ce808`

Supporting Brain readback artifacts:

- [`brain-get-connection-manager.txt`](./brain-get-connection-manager.txt) — `src-core-connection-manager-ts`
- [`brain-get-engines.txt`](./brain-get-engines.txt) — `docs/engines`
- [`brain-get-key-files.txt`](./brain-get-key-files.txt) — `docs/architecture/key_files`
- [`brain-get-minions-worker.txt`](./brain-get-minions-worker.txt) — `src-core-minions-worker-ts`
- [`brain-query-concurrency.txt`](./brain-query-concurrency.txt)
- [`brain-search-primary.txt`](./brain-search-primary.txt)
- [`brain-search-broadened.txt`](./brain-search-broadened.txt)
- [`brain-search-provenance.txt`](./brain-search-provenance.txt)
- [`brain-search-connection-pool.txt`](./brain-search-connection-pool.txt)
- [`lookup-retrieved-at.txt`](./lookup-retrieved-at.txt) — `2026-07-15T00:36:53Z`
- [`brain-status.json`](./brain-status.json) — preserved status output; it reports the pre-existing Brain health result and was not changed

## Raw outputs

### Perplexity raw output

- [`perplexity.raw.md`](./perplexity.raw.md) — extracted verbatim from `choices[0].message.content` in the completed response
  - `finish_reason: stop`
  - model: `sonar-pro`
  - output bytes: `26532`
  - SHA-256: `79283f672af9e7c97ac75ab87593c644cb6786d87b5ffc928c84ab45485f9418`
- [`perplexity-raw.json`](./perplexity-raw.json) — original response JSON preserved unchanged
  - bytes: `33727`
  - SHA-256: `e6a158b215411f964e4405dfb24e7de1387cd06299b226a4e1a6955e5d3d1a03`
- [`perplexity-meta.json`](./perplexity-meta.json) — preserved provider telemetry and citation URL list
  - SHA-256: `fcd1d5a2afff5f42ba35a19998b0b416020cb6f192ce45100580c9a7c07de239`
- [`perplexity-output.md`](./perplexity-output.md) — pre-existing extracted output retained for provenance; it matched the newly extracted raw Markdown byte-for-byte

### Agentic Research System raw output

- [`agentic.raw.md`](./agentic.raw.md) — direct source-backed answer to the exact Q2 question, with claim provenance and explicit fact/judgment boundaries
  - bytes: `13959`
  - SHA-256: `e7259282644bf24f065487cef7f14a2e306a2bc9a3303e1f7d3e3390517d6d48`
  - no scores, evaluation verdict, provider comparison, or write-back instructions are included in the answer

## Source ledger

### Brain/internal sources used by `agentic.raw.md`

| ID | Artifact / Brain source | Role in answer |
|---|---|---|
| S1 | [`brain-get-engines.txt`](./brain-get-engines.txt), `docs/engines` | Postgres/Supabase production path; PGLite concurrency boundary; BrainEngine transaction, version, link, graph, raw-data, and ingest-log contract |
| S2 | [`brain-get-connection-manager.txt`](./brain-get-connection-manager.txt), `src-core-connection-manager-ts` | Port 6543 read pool; port 5432 direct/session route; default sizes 10 and 3; lazy cached initialization; parent pool inheritance; kill switch; connection audit |
| S3 | [`brain-get-key-files.txt`](./brain-get-key-files.txt), `docs/architecture/key_files` | `link_source`/`link_type`; provenance defaults/restrictions; source scoping; atomic Markdown write-through and related invariants |
| S4 | [`brain-get-minions-worker.txt`](./brain-get-minions-worker.txt), `src-core-minions-worker-ts` | Concurrent worker behavior; isolated job state; lock renewal; token fencing; stall/retry and connection-failure handling |
| S5 | [`brain-context.yaml`](./brain-context.yaml) | Dated prior-context packet, known decisions, gaps, novelty boundary, and contradiction status |
| S6 | Refactored contract: `/Users/jarvis/gbrain/skills/agentic-research-system/SKILL.md`, version `1.1.0` | Governance and provenance rules only: Brain-first boundary, source/claim mapping, no-snippet rule, explicit evidence boundary, and no Brain write-back for this benchmark |

### Perplexity citation registry preserved in `perplexity-meta.json`

The existing Perplexity response cites these URLs by ordinal `[1]` through `[10]`; the registry below is copied from the preserved metadata and is not newly fetched:

1. https://trustgraph.ai/guides/key-concepts/what-is-a-context-backend/
2. https://zylos.ai/research/2026-05-09-knowledge-graph-world-models-ai-agents/
3. https://www.armalo.ai/learn/knowledge-graph-integrity-ai-agents
4. https://dev.to/the-hive-collective/concurrent-writes-to-a-shared-agent-memory-what-we-shipped-what-we-punted-on-b4l
5. https://arxiv.org/html/2603.02240v1
6. https://arxiv.org/html/2603.17244v1
7. https://fast.io/resources/ai-agent-supabase-storage/
8. https://medium.com/@saeedhajebi/building-ai-agents-with-knowledge-graph-memory-a-comprehensive-guide-to-graphiti-3b77e6084dec
9. https://www.agilesoftlabs.com/blog/2026/05/longterm-ai-agent-memory-with-langchain
10. https://www.softwareseni.com/how-postgres-became-the-ai-agent-substrate-for-memory-branching-and-modern-hosting/

## Missing telemetry and evidence boundary

The following were unavailable in the existing q2 artifacts and are recorded rather than inferred:

- No separately named Agentic fetched-source corpus or `agentic-fetch-receipt.json` exists under q2.
- No completed Agentic provider/model/tool-call/latency/cost receipt exists under q2.
- No canonical URLs, publication dates, or independent retrieval timestamps are attached to the Brain-extracted internal pages; their Brain slugs and artifact paths are retained instead.
- No Supabase account/plan-specific maximum connection budget is present. The `10` read and `3` direct values are current GBrain defaults, not a verified safe deployment limit.
- No finalized GBrain command-log schema, partition key, cross-partition transaction policy, or read-after-write SLA is present in the packet.
- No new external sources were fetched during recovery, and no claim of external-source freshness or novelty is made for `agentic.raw.md`.
- Evaluation scores, comparison verdicts, commits, shared-report edits, and Brain write-back are intentionally absent.

## Verification receipt

Readback checks performed after writing:

- Parsed [`perplexity-raw.json`](./perplexity-raw.json) successfully.
- Confirmed `finish_reason == "stop"`.
- Extracted `choices[0].message.content` to `perplexity.raw.md`.
- Confirmed extracted content matches the pre-existing `perplexity-output.md` byte-for-byte (`26532` bytes).
- Confirmed `agentic.raw.md` is non-empty and read back successfully.
- Confirmed original `perplexity-raw.json` remains present and unchanged by SHA-256 receipt.
- All created/modified artifacts are inside the q2 directory.
