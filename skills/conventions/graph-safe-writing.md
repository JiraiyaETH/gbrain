# Graph-Safe Writing Convention

Cross-cutting rules for every skill that writes Brain pages. Treat this as part of the Brain write contract, alongside `conventions/quality.md`.

## Core principle

A wikilink, markdown entity link, slug path, or relationship-shaped frontmatter field is not decoration. It is graph evidence. Write it only when the resulting edge would be useful and true.

The Brain should compound through clean edges, not accumulate dense accidental links that future agents have to babysit.

## Edge budget

Before writing or rewriting a page, decide the intended edge budget:

1. **Strong typed edges** — only when the relationship is explicit and durable enough to query later.
   - Examples: `works_at`, `founded`, `attended`, `signed`, `represents`, `invested_in`, `advises`, `sourced_from`, `derived_from`.
   - Require clear local evidence. If the sentence would sound false as `A --verb--> B`, do not create the typed edge.
2. **Weak edges** — use `mentions` / `relates_to` when the relationship is contextual, uncertain, or only co-mentioned.
3. **Provenance only** — source slugs, transcript IDs, contract IDs, raw paths, and citation lists should usually be plain citation text, not body wikilinks, unless traversal to that exact page is intended.
4. **No edge** — names mentioned only as examples, noise, or low-signal context should stay plain prose.

## Page-writing rules

- Keep wikilinks sparse and intentional. Use them in sections that are meant to encode relationships: `## Timeline`, `## Network`, `## Contracts`, `## Sources`, explicit party/counterparty lines.
- Do not use wikilinks as visual emphasis or “because a page exists”.
- Do not write raw slug paths like `people/x`, `companies/x`, `contracts/x`, `meetings/x`, or `sources/x` in body prose unless you intend extractor-readable graph evidence. Prefer display names in prose and cite sources in `[Source: ...]` text.
- For source/provenance lists, prefer compact citation text. Use a true wikilink only for the primary source page or a small number of source pages worth traversing.
- If a relationship is important but the prose would be ambiguous, create the explicit edge with `gbrain link <from> <to> --link-type <type> --context ... --source <source-id>` and keep the page text readable.
- When changing a page with many existing links, preserve useful traversal links but remove/de-link citation wallpaper that only exists as provenance.

## Meeting-specific rule

Meeting bodies are special because the auto-link hook types body person links from meeting pages as `attended`.

- Wikilink actual attendees in the `**Attendees:**` line.
- People merely mentioned go in a `**Mentioned:**` line as display names unless they need entity propagation.
- Do not wikilink companies, contracts, sources, or concepts inside the meeting body. Put those links on the relevant entity page timeline instead.
- After the meeting page is written, verify the DB `attended` edges match the attendee line exactly.

See `meeting-ingestion` for the full meeting QA gate.

## Post-write verification gate

Every Brain write that can create links must inspect the write receipt or DB graph before claiming done:

1. Inspect `auto_links` from `put_page` when available: `{ created, removed, unresolved, errors }`.
2. Resolve or log `auto_links.unresolved`; unresolved names are enrichment candidates, not noise.
3. Run a focused graph readback for important pages:
   ```bash
   gbrain graph-query <slug> --depth 1 --direction both --source default
   ```
4. Treat suspicious edge shapes as failures to fix before reporting completion.

## Suspicious edge shapes

Flag and review these automatically when they appear:

- `meeting --attended--> company|contract|source|concept`
- `company --attended--> *`
- `company --advises--> meeting|person` unless the page explicitly represents an advisory firm advising that target
- `person --invested_in--> companies/tailored` unless explicitly sourced as an investment
- `person --works_at--> companies/tailored` when the page says KOL, TAP associate, vendor, referral partner, or client rather than staff
- blank link types or link types not present in the active schema pack
- dense new typed edges created from a single source page without explicit evidence

When uncertain, downgrade to `mentions` and record the reason in the edge audit or write receipt.

## Skill author checklist

Any ingestion/enrichment skill that writes Brain pages should include or reference this convention and enforce:

- [ ] intended edge budget decided before writing
- [ ] wikilinks used only for intended graph edges
- [ ] provenance-only slugs kept as citation text unless traversal is intended
- [ ] `auto_links` inspected after `put_page`
- [ ] important pages graph-queried after write
- [ ] suspicious edge shapes repaired or logged before “done”
