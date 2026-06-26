---
name: contract-ingestion
version: 1.0.0
description: |
  Ingest / reshape a signed contract (a local PDF, an old-brain
  sources/contracts/ page, or a SignNow document) into the jiraiya-brain
  `contracts/` shelf as a typed `contract` page plus thin entity stubs. The
  contract analogue of meeting-ingestion / idea-ingest. This skill carries ONLY
  the contract-specific logic; it FOLLOWS the shared brain conventions (it never
  re-specifies them) and delegates entity enrichment to the `enrich` skill.
triggers:
  - "ingest this contract"
  - "ingest these contracts"
  - "migrate the contracts"
  - "reshape the contract"
  - "file this signed agreement"
  - "add this KOL agreement to the brain"
  - "add this service retainer to the brain"
tools:
  - read
  - write
  - exec
mutating: true
---

# Contract Ingestion

## READ THESE FIRST — follow them, do not re-derive them

This skill is deliberately thin on conventions because the conventions already
live in other skills. Before writing anything, read and OBEY:

- **`conventions/quality.md`** — the back-link iron law ("an unlinked mention is
  a broken brain"), citation format, the **timeline format `- **YYYY-MM-DD** | …`**,
  and **reverse-chronological order** (newest entry on top).
- **`brain-ops`** — the read → reconcile → write cycle; brain-first lookup.
- **`schema.md`** (in the brain repo, e.g. `~/brain/schema.md`) — the two-layer
  page model, the minimal-frontmatter rule, and the person/company templates
  including the **Contact** section.
- **`_brain-filing-rules` / `RESOLVER.md`** — where a page goes.
- **`enrich`** — entity enrichment. This skill produces only *thin stubs*;
  `enrich` fattens them later. Never enrich during ingest.

If a rule below conflicts with one of those skills, the convention skill wins —
report the conflict instead of guessing.

## Contract (what this skill guarantees)

1. A typed `contract` page at `contracts/{client}/{counterparty}-{docid8}.md`,
   **minimal frontmatter** (`type`/`subtype`/`status` only), two-layer body,
   raw document attached and cited in a `<sub>` provenance footer (durable paths).
2. A thin stub for every party (creator/associate → `people/`, client →
   `companies/`), with the Contact section — never enriched here.
3. Every reciprocal back-link per the iron law; the structured link + timeline
   layers populate (because the timeline format is correct).
4. No invented data: unrecoverable terms are left as a clear gap + `needs_review`;
   SignNow is re-fetched when a real doc-id makes recovery possible.

## Phases

### 1. Identify source + subtype
- Source: local PDF · old-brain `sources/contracts/` page (+ its `.pdf`) · SignNow doc-id.
- Subtype (sets the whole shape): `kol-agreement` · `company` (service retainer)
  · `tap-referral` (Tailored↔associate, no client) · `curation` (read the body
  for the actual signatories — may be a person, e.g. the founder, not Tailored).

### 2. Recover the operative text (body is the source of truth)
- The verbatim contract body (Deliverables / Compensation / Terms) outranks any
  prior structured extraction — fix parse errors *from the body*.
- Empty body → `pdftotext` the PDF.
- Still materially incomplete (key value/deliverables/dates missing) AND a real
  SignNow doc-id exists → re-fetch from the SignNow API. Key:
  `~/.openclaw-jarvis-v2/scripts/get-secret.sh`. (`local-pdf-sha8-*` ids are NOT
  SignNow ids — those rely on the local PDF only.)
- Never invent. Unrecoverable → leave the gap, set `needs_review`.

### 3. Reshape the contract page
Minimal frontmatter:
```
---
type: contract
subtype: kol-agreement | company | tap-referral | curation
status: draft | signed | active | expired | terminated
---
```
Body (compiled truth above `---`, verbatim Agreement text below):
- Title: `# {counterparty} — {client} {type}`.
- **Party framing (critical):** every contract is `[[companies/tailored]] ⇄
  counterparty, *for* a client` — NEVER creator⇄client.
  - `kol-agreement`: `[[companies/tailored]] ⇄ {creator} (creator)` for client
    `[[companies/{client}]]`.
  - `company`: `[[companies/tailored]] ⇄ [[companies/{client}]] (client)` service retainer.
  - `tap-referral`: `[[companies/tailored]] ⇄ {associate} (associate)` — NO client.
  - `curation`: the body's real signatories (e.g. `[[people/jiraiya]] ⇄ client`),
    with platform/venue linked but not as the counterparty.
- Then readable lines: Creator/Client/Counterparty links · Value · Deliverables ·
  Exclusivity · Usage rights · Term. Value/currency/dates live in the BODY, not frontmatter.
- `<sub>` footer: raw PDF path + doc-id + parse corrections; cite durable paths only.

### 4. Status / expiry
`term_end` = stated body end → else client service-window → else **signed + 3-month
default** (flag pure-default `needs_review`). `status = expired` if `term_end < today`.
At-will agreements (TAP) with no term stay `active`.

### 5. Entity stubs (thin — no enrichment)
- Creator/associate → `people/{slug}.md` per `schema.md`'s person template:
  Exec summary (mark `*[Stub from contract ingest]*`), State, **Contact**
  (X/handle + signer email if in the doc, else `[No data yet]`),
  `What they believe: [No data yet]`, Open threads (note enrich), Timeline.
- Client → `companies/{slug}.md` stub: `What: [No data yet]`, `Connection: Client
  of [[companies/tailored]]`, Timeline.
- **Dedup (Read-before-Write):** if the entity page exists, APPEND a timeline entry
  / key-person link — never overwrite. Same creator across contracts → one page, updated.

### 6. Reciprocal back-links (iron law)
- Client → append to `companies/tailored.md` `Clients:` line (deduped). TAP
  associates → a separate `TAP associates:` line (not clients). Add one tailored
  Timeline entry per contract.
- Every party's stub Timeline-links its contract; the client page key-people-links
  every creator.

### 7. Checkpoint
Write files (NOT bulk `put_page` — stay collision-safe with concurrent
sessions/autopilot). Then: `git commit` → `gbrain sync --no-pull` →
`gbrain extract links --source db` → `gbrain extract timeline --source db` →
graph-query readback to prove the edges + dated entries formed.

## Output Format
Per contract: 1 contract page + N party stubs (deduped) + the raw PDF copied
alongside + updated `tailored.md` reciprocals. Report: subtype, status (+ basis),
parse-gaps corrected, files created vs updated (flag dedups), any "needs SignNow
recovery", and a readback confirmation.

## Anti-Patterns (the mistakes this skill exists to prevent)
- ❌ Frontmatter-heavy pages (value/currency/dates in frontmatter) — they go in the body.
- ❌ "Creator × Client" framing — it's Tailored ⇄ counterparty, *for* a client.
- ❌ Old contracts left `status: signed` / "month-to-month" so they read live — infer expiry.
- ❌ Ascending or `- DATE — …` timelines — use `- **DATE** | …`, newest on top (or `extract timeline` returns nothing).
- ❌ Enriching the stub during ingest (beliefs/audience/metrics) — that's `enrich`, later.
- ❌ Re-specifying conventions in the prompt instead of reading the convention skills.
- ❌ Bulk `put_page` — collides with concurrent sessions; write files + sync.
- ❌ Inventing missing terms — recover from PDF/SignNow or flag `needs_review`.

## Gold-standard exemplars (already in the brain)
`contracts/silo/wajahat-mughal-*` (kol) · `contracts/spicenet/spicenet-*` (company)
· `contracts/tap/keno-*` (tap-referral) · `contracts/fjord/jiraiya-*` (curation).
Stub shape: `people/defizard` · `companies/theo-network`.
