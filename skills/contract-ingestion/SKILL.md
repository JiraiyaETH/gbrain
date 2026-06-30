---
name: contract-ingestion
version: 1.0.2
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
writes_pages: true
writes_to:
  - contracts/
  - people/
  - companies/
---

# Contract Ingestion

## READ THESE FIRST — follow them, do not re-derive them

This skill is deliberately thin on conventions because the conventions already
live in other skills. Before writing anything, read and OBEY:

- **`conventions/quality.md`** — the back-link iron law ("an unlinked mention is
  a broken brain"), citation format, the **timeline format `- **YYYY-MM-DD** | …`**,
  and **reverse-chronological order** (newest entry on top).
- **`conventions/graph-safe-writing.md`** — wikilinks and slug paths are graph
  evidence, not decoration. Contract pages should link true parties,
  counterparties, clients, sources, and timeline targets, not every incidental
  name or provenance slug.
- **`conventions/post-run-retrieval-gate.md`** — after sync/extract, verify the
  contract supports relationship queries without outranking canonical person,
  company, or project pages for broad identity queries.
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
   raw document copied to a durable contract path and cited in a `<sub>`
   provenance footer.
2. A thin stub for every party (creator/associate → `people/`, client →
   `companies/` or `people/` for person-brand clients), with the Contact section
   — never enriched here.
3. Every reciprocal back-link per the iron law; the structured link + timeline
   layers populate (because the timeline format is correct).
4. Idempotent read-before-write behavior: same source/docid updates or reconciles
   existing pages; it does not duplicate contracts, entities, or timeline rows.
5. No invented data: unrecoverable terms are left as clear gaps with
   machine-readable `needs_review`; SignNow is re-fetched when a real doc-id
   makes recovery possible.

## Phases

### 1. Identify source + subtype
- Source: local PDF · old-brain `sources/contracts/` page (+ its `.pdf`) · SignNow doc-id.
- Subtype (sets the whole shape): `kol-agreement` · `company` (service retainer)
  · `tap-referral` (Tailored↔associate, no client) · `curation` (read the body
  for the actual signatories — may be a person, e.g. the founder, not Tailored).
- Compute or recover `docid8`. Prefer the real SignNow document id prefix when
  available; otherwise use the first 8 chars of the source PDF content hash.

### 2. Recover the operative text (body is the source of truth)
- Verify the source exists and is non-empty before extraction. If the file is
  missing, tiny, or `pdftotext` produces empty output, stop with `needs_review`
  rather than inventing content.
- The verbatim contract body (Deliverables / Compensation / Terms) outranks any
  prior structured extraction — fix parse errors *from the body*.
- Empty body → `pdftotext -layout` the PDF (retainers especially often have empty prior extracts).
- Still materially incomplete (key value/deliverables/dates missing) AND a real
  SignNow doc-id exists → re-fetch from the SignNow API using the profile's
  approved secret helper. (`local-pdf-sha8-*` ids are NOT SignNow ids — those rely
  on the local PDF only.)
- Never invent. Unrecoverable → leave the gap, set `status: needs_review` when
  the whole page is blocked, or add an inline `<!-- needs_review: <field> -->`
  marker next to a specific missing term.

### 3. Reshape the contract page
Minimal frontmatter:
```
---
type: contract
subtype: kol-agreement | company | tap-referral | curation
status: draft | signed | active | expired | terminated | needs_review
---
```
Body (compiled truth above `---`, verbatim Agreement text below):
- Title: `# {counterparty} — {client} {type}`.
- **Party framing (critical):** every contract is `[[companies/tailored]] ⇄
  counterparty, *for* a client` — NEVER creator⇄client.
  - `kol-agreement`: `[[companies/tailored]] ⇄ {creator} (creator)` for client `[[companies/{client}]]`.
  - `company`: `[[companies/tailored]] ⇄ {client} (client)` service retainer (client may be a
    company OR a person-brand — frame to the real counterparty; note the legal entities if named).
  - `tap-referral`: `[[companies/tailored]] ⇄ {associate} (associate)` — NO client.
  - `curation`: the body's real signatories (e.g. `[[people/jiraiya]] ⇄ client`),
    with platform/venue linked but not as the counterparty.
- Then readable lines: Creator/Client/Counterparty links · Value · Deliverables ·
  Exclusivity · Usage rights · Term. Value/currency/dates live in the BODY, not frontmatter.
- Copy the raw PDF to a durable sibling path before citing it, e.g.
  `contracts/{client}/{counterparty}-{docid8}.pdf`; never cite temp downloads.
- `<sub>` footer: raw PDF path + doc-id + parse corrections, e.g.
  `<sub>Raw PDF: [[contracts/solv/hercules-b902d24e.pdf]] · Source doc-id: b902d24e · Corrections: fixed OCR spacing in compensation terms</sub>`.

### 4. Status / expiry
`term_end` = stated body end → else client service-window → else **signed + 3-month
default** (flag pure-default `<!-- needs_review: term_end_defaulted -->`).
`status = expired` if `term_end < today`. At-will agreements (TAP) with no term stay `active`.

### 5. Entity stubs (thin — no enrichment)
- Creator/associate → `people/{slug}.md` per `schema.md`'s person template:
  Exec summary (mark `*[Stub from contract ingest]*`), State, **Contact**
  (X/handle + signer email if in the doc, else `[No data yet]`),
  `What they believe: [No data yet]`, Open threads (note enrich), Timeline.
- Client → `companies/{slug}.md` stub (or `people/{slug}.md` for a person-brand client):
  `What: [No data yet]`, `Connection: Client of [[companies/tailored]]`, Timeline.
- **Dedup (Read-before-Write):** if the contract or entity page exists, read it
  first, merge the new facts/timeline rows, and never overwrite the compiled truth
  blindly. Same creator across contracts → one page, updated.
- **Watch slug variants** (e.g. backup `smartape` == canonical `people/smart-ape`;
  `hercules` == `hercules-defi`) — verify identity, reuse the canonical page, never fork a duplicate.

### 6. Reciprocal back-links (iron law)
- Client → append to `companies/tailored.md` `Clients:` line (deduped). TAP
  associates → a separate `TAP associates:` line (not clients). Add one tailored
  Timeline entry per contract.
- Every party's stub Timeline-links its contract; the client page key-people-links
  every creator.
- If a contract mentions an entity that gains a page later, wire the `[[link]]` in
  the compiled-truth summary line (leave the verbatim Agreement text untouched).

### 7. Checkpoint
Write files (NOT bulk `put_page` — stay collision-safe with concurrent
sessions/autopilot). Then: `git commit` → `gbrain sync --no-pull` →
`gbrain extract links --source db` → `gbrain extract timeline --source db` →
`gbrain embed --stale` → graph-query readback to prove the edges + dated entries formed.
Normalize hub timelines with `scripts/normalize-timeline.mjs` before committing when hub pages were touched.

Graph readback must confirm the contract edge model stayed sane: Tailored ⇄
counterparty, client as client/for-context, TAP associate as associate, curation
platform as venue/context. If the extractor creates creator⇄client, company
`attended`, or other suspicious strong typed edges, repair or downgrade before
reporting done.

Then run the retrieval smoke/entity gate: the contract should appear for
contract-specific or campaign-specific queries, but canonical party/client pages
should still rank first for "who is X" and "what do we know about Y" queries.

## Output Format
Per contract: 1 contract page + N party stubs (deduped) + the raw PDF copied
alongside + updated `tailored.md` reciprocals. Report exactly:
- source and subtype
- contract page path + raw PDF path
- status and expiry basis
- entities created vs updated
- parse gaps corrected or `needs_review` markers left
- warnings / SignNow recovery needed
- sync, graph, timeline, and retrieval readback result

## Anti-Patterns (the mistakes this skill exists to prevent)
- ❌ Frontmatter-heavy pages (value/currency/dates in frontmatter) — they go in the body.
- ❌ "Creator × Client" framing — it's Tailored ⇄ counterparty, *for* a client.
- ❌ Old contracts left `status: signed` / "month-to-month" so they read live — infer expiry.
- ❌ Ascending or `- DATE — …` timelines — use `- **DATE** | …`, newest on top (or `extract timeline` returns nothing).
- ❌ Enriching the stub during ingest (beliefs/audience/metrics) — that's `enrich`, later.
- ❌ Re-specifying conventions in the prompt instead of reading the convention skills.
- ❌ Bulk `put_page` — collides with concurrent sessions; write files + sync.
- ❌ Forking a duplicate page on a slug variant (smartape vs smart-ape) — dedup to canonical.
- ❌ Citing a temporary PDF/download path in provenance — copy to durable contract storage first.
- ❌ Inventing missing terms — recover from PDF/SignNow or flag `needs_review`.

## Gold-standard exemplars (already in the brain)
`contracts/solv/hercules-b902d24e` (kol) · `contracts/dabba/dabba-b841c405` (company retainer)
· `contracts/tap/keno-f2f45077` (tap-referral) · `contracts/fjord/jiraiya-20251008` (curation).
Stub shape: `people/hercules-defi` (creator) · `companies/dabba` (client) · `people/tory-green` (person-brand client).
