# Q1 rerun package manifest

## Package status

- **Run:** `agentic-research-system/benchmark-2026-07-15/rerun/q1`
- **Lane:** recovery-only packaging from existing artifacts
- **Benchmark date:** `2026-07-15`
- **Freshness window:** `2026-04-16` through `2026-07-15`, inclusive, by publication/release date
- **Review shape:** two independent raw outputs for side-by-side review; no score, ranking, or cross-output evaluation is included here
- **Scope guard:** no new web/API/Brain research; no Brain writes; no shared report edits; no commits; no skill edits; no filesystem changes outside `q1/`

## Exact prompt

The authoritative prompt artifact is:

- `perplexity-A.prompt.txt`
- SHA-256: `facd075a279b8b7393a05bebef4ac3bd0d06cab8293a67c4f8e65688cb847448`

The exact research question in that prompt is:

> What important advances in agentic ‘deep research’ systems from the last 90 days should change how GBrain’s Agentic Research System works? Focus on source discovery, parallel investigation, evidence tracking, critique, synthesis, and memory write-back. Distinguish genuinely new mechanisms from repackaged patterns.

The prompt also fixes the date/scope, injects the Brain context packet, requires primary-source preference and claim provenance, prohibits claiming Brain write-back, and requests a concise decision-oriented synthesis with candidate table, change/do-not-change/investigate recommendation, and evidence boundary. The full exact prompt remains unmodified at the path above.

## Brain packet and internal baseline

- `brain-context.yaml` — the bounded Brain context packet supplied to both research lanes
  - SHA-256: `181568f6d8ead81e140b9f9665309a887e7ec2974066dbb425fad2bc458ceac0`
  - Status recorded in packet: `thin_but_present`
  - Retrieved at: `2026-07-15T00:36:45Z`
  - Brain: `default`; source: `default`
  - Baseline pages: `skills/agentic-research-system/skill` and `skills/agentic-research-system/changelog`
  - Explicit gaps: no page dedicated to last-90-days advances; no prior completed Q1 Agentic output; provider-internal telemetry may be unobservable
- `brain-lookup.raw.txt` — read-only lookup receipt
- `research-brief.md` — protocol-lite brief and artifact requirements
  - SHA-256: `338cba5ddc9d822e2ec0c2d05c0cf1127ba51d4def7bba913057de9f4c4a76ad`

## Raw outputs

### A — pre-refactor Perplexity Research

- `perplexity.raw.md`
  - Extracted verbatim from `perplexity-A/raw-response.json` → `choices[0].message.content`
  - Exact extraction verification: `True`
  - SHA-256: `29fce627907a598df030ca6ce4665269e8c1e3e5660f6ef0e70f984bc776a504`
  - Size: 6,330 bytes; 33 content lines by Python readback
- Original preserved response:
  - `perplexity-A/raw-response.json`
  - SHA-256: `a7c71dd09a66fb2cd3aa9a02b44f4719a7a7668e740f3ecc2e14f49dd7287119`
  - Size: 10,781 bytes; one JSON line
- Existing Perplexity telemetry:
  - `perplexity-A/meta.json`
  - HTTP status `200`; model `sonar-pro`; latency `9.878s`; completion tokens `1361`; prompt tokens `898`; total tokens `2259`; reported total cost `0.02911`; citations `7`
  - No Perplexity JSON fields were modified.

### B — executed Agentic Research System

- `agentic.raw.md`
  - Direct source-backed answer composed only from the existing `agentic-B/parsed/` corpus and the refactored contract
  - SHA-256: `551e01c38ebd2289b484959b163289b0c000158aecf720ad59f307a39bc4e43d`
  - Size: 15,389 bytes; 84 lines
  - Contains no Brain write-back claim and leaves the write-back gate at `not_run`
- `source-ledger.md`
  - Source IDs `[S1]`–`[S12]`, direct URLs, dates, local corpus paths, authority/class, claim mapping, and caveats
  - SHA-256: `a30f7ddff79ee5b92044563775a8ed2ef67128858138e50a0c1cdb9ccbf3468c`
  - Size: 8,150 bytes; 25 lines

## Existing source corpus used by B

- Source bodies: `agentic-B/parsed/`
- Original captures: `agentic-B/sources/`
- Source ledger: `source-ledger.md`
- The raw answer uses source IDs `[S1]`–`[S12]`; URL-health `[S12]` is explicitly retained as **out of window** because its collected date is `2026-04-03`.
- Duplicate representations of the Cognitive Scaffold artifact are treated as one source entry, not independent evidence.

## Missing telemetry / receipts

The following were not present in the recovered Agentic artifacts and were not fabricated:

- Agentic lane latency, token counts, cost, provider/model identifiers, and tool-call counts
- Per-lane query log and scout handoff receipts
- Separate critic/citation-auditor/run-receipt files
- Machine-readable source/claim/citation registries beyond the packaged ledger
- Cross-model run-output evaluation receipt
- Post-write Brain readback (write-back was prohibited)
- A completed prior Q1 Agentic output; the context packet says none existed
- Exact publication day for AggAgent in the parsed artifact (recorded at April 2026 month granularity)
- Canonical ACL Anthology URL for MemSearch-o1 in the collected text (local ACL PDF and its embedded code URL are preserved)

## Verification readback

Completed checks:

- Parsed `perplexity-A/raw-response.json` and confirmed `perplexity.raw.md == choices[0].message.content` exactly.
- Confirmed the original Perplexity JSON still exists and retained its pre-existing SHA-256.
- Read back `perplexity.raw.md`, `agentic.raw.md`, and `source-ledger.md` successfully.
- Confirmed all packaged files are inside the requested `q1/` directory.

## Package file list

- `manifest.md` — this manifest
- `perplexity.raw.md` — verbatim Perplexity answer
- `agentic.raw.md` — completed Agentic raw answer
- `source-ledger.md` — Agentic source/provenance ledger
- Existing preserved inputs: `perplexity-A.prompt.txt`, `perplexity-A/raw-response.json`, `perplexity-A/meta.json`, `brain-context.yaml`, `brain-lookup.raw.txt`, `research-brief.md`, and `agentic-B/`
