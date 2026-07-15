# Q3 rerun manifest

## Package scope

- **Run:** `agentic-research-system/benchmark-2026-07-15/rerun/q3`
- **Lane:** recovery-only packaging from existing artifacts
- **Completed:** `2026-07-15` (local packaging; no external, Brain, or API calls made)
- **Write boundary:** only this `q3/` directory was modified
- **Evaluation status:** raw outputs only; no scores, ranking, or provider comparison

## Exact prompt

The exact execution prompt is preserved verbatim at [`prompt-agentic.txt`](prompt-agentic.txt).

The exact Q3 question embedded in that prompt is:

> Does supplying existing Brain context before external research improve novelty and factual accuracy, or does it anchor the researcher and reinforce existing beliefs? Evaluate the evidence and propose safeguards for a Brain-first research workflow.

Prompt artifact integrity:

- `prompt-agentic.txt`
- bytes: `7940`
- SHA-256: `51ebbe6150253611b23fed6f459f93586395a24b0c61d9722af5e6cba1d10b9a`

The bounded protocol brief is preserved at [`research-brief.md`](research-brief.md), SHA-256 `31abd16fa5cdfcf7cd4799ba5370db67f6003e6c2df84d39dbbd4007bc7a0fdf`.

## Brain packet

The lossless Brain context packet used by the workflow is [`brain-context.yaml`](brain-context.yaml).

- bytes: `6104`
- SHA-256: `171974085e18596b8485927a4d38b31b3f9faf4fcc25d1e64f9e8ca082ab653f`
- status recorded in packet: `thin_and_indirect`
- retrieval chain and page claims: preserved in the packet
- supporting read-only receipts: [`brain-search-*.txt`](.) artifacts, [`brain-get-receipt.json`](brain-get-receipt.json), [`brain-status-receipt.json`](brain-status-receipt.json)
- write-back status: `not_run` / prohibited for this recovery lane

The Brain packet is treated as design context only. It contains no direct controlled Brain-first versus Brain-blind outcome evidence.

## Raw outputs

### Perplexity raw output

- Answer extracted verbatim from `choices[0].message.content` in [`perplexity.raw.json`](perplexity.raw.json)
- Raw answer: [`perplexity.raw.md`](perplexity.raw.md)
- JSON preserved unchanged as the source artifact
- `perplexity.raw.json` bytes: `32118`
- `perplexity.raw.json` SHA-256: `d43eec9be8ddcdde7a15fced7e913a19cb80c539742cbed7c13747a69e078574`
- `perplexity.raw.md` bytes: `23999`
- `perplexity.raw.md` SHA-256: `d1c93bb2fbdbbb065f1c635780368fa89ddbb9a05292a976e81e71db67bfaff1`
- exact extraction check: `true`
- provider telemetry: [`perplexity.meta.json`](perplexity.meta.json)
- Perplexity metadata reports HTTP `200`, model `sonar-pro`, latency `55.736575` seconds, `6460` total tokens, and total request cost `0.084`; credential value was not persisted or logged.

### Agentic raw output

- Direct source-backed answer: [`agentic.raw.md`](agentic.raw.md)
- bytes: `18227`
- SHA-256: `08cf1e5ad03d4e62a7d46c7a47c9ef79ca291f2053dc9131bddce12433c4c5d5`
- includes: direct answer, evidence boundary, safeguards, ACH-style H1/H2/H3 assessment, source ledger, claim provenance, and caveats
- no scores, ranking, provider comparison, Brain write, or external action

## Source corpus and ledger

The already-collected Agentic source corpus is preserved under [`agentic-sources/`](agentic-sources/):

- 8 extracted source bodies (`*.txt`)
- 8 original PDFs (`*.pdf`)
- 2 original PMC XML files (`*.xml`)
- fetch receipt: [`agentic-fetch-receipt.json`](agentic-fetch-receipt.json)
- fetch receipt SHA-256: `a9db00732e0a25acd3a59dbf82bb1b35c6afeadff08da8e736818f8142848b6c`

The source/claim ledger and provenance registry are embedded in [`agentic.raw.md`](agentic.raw.md), section **“Source ledger and claim provenance”**. It defines and maps `S1`–`S8` to the preserved source bodies and records URL, title, authors, publication date, access timestamp, retrieval method, source class/authority, supported claims, and caveats.

Source IDs in the packaged answer:

- `S1` human online-search anchoring/order/exposure study
- `S2` active information sampling and confirmation-bias study
- `S3` LLM anchoring experiment
- `S4` authority bias in RAG and conflict-detection mitigation
- `S5` generated-versus-retrieved context conflict study
- `S6` context faithfulness, memory strength, and evidence style
- `S7` RAGTruth hallucination corpus
- `S8` AI idea-diversity prompting study

## Missing or non-observable telemetry

- No direct Brain-first versus Brain-blind controlled outcome telemetry exists in the supplied artifacts.
- No completed agentic-lead usage/cost/latency/tool-call receipt exists beyond the preserved source-fetch receipt and its per-source latency/status/hash fields.
- No agentic scout transcript, critic receipt, citation-audit receipt, or cross-model run-output evaluation receipt was present in the supplied artifacts; none was fabricated or re-run.
- No direct novelty or factual-accuracy measurement for this Q3 run is available.
- Per the brief and execution contract, Brain write-back, scoring, shared-report edits, commits, and external/API research remain not run in this recovery lane.

## Verification readback

Verified locally after writing:

1. `perplexity.raw.json` parses as JSON.
2. `perplexity.raw.md` equals the JSON value at `choices[0].message.content` byte-for-byte after UTF-8 serialization (`perplexity_exact=true`).
3. `agentic.raw.md` is present and contains citations for every source ID `S1`–`S8` used in the answer.
4. The agentic answer explicitly states the direct-evidence boundary and does not claim Brain-relative novelty from absence of Brain results.
5. All source IDs in the answer resolve to preserved local corpus files and entries in the embedded ledger.
6. No file outside `q3/` was modified by this packaging step.

## Package index

- [`manifest.md`](manifest.md) — this manifest
- [`prompt-agentic.txt`](prompt-agentic.txt) — exact Agentic prompt
- [`research-brief.md`](research-brief.md) — protocol-lite brief
- [`brain-context.yaml`](brain-context.yaml) — Brain packet
- [`agentic.raw.md`](agentic.raw.md) — Agentic source-backed raw answer
- [`perplexity.raw.md`](perplexity.raw.md) — verbatim extracted Perplexity answer
- [`perplexity.raw.json`](perplexity.raw.json) — preserved original Perplexity response
- [`perplexity.meta.json`](perplexity.meta.json) — Perplexity telemetry
- [`agentic-sources/`](agentic-sources/) — preserved Agentic source corpus and fetch receipt
