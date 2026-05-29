---
name: data-research
version: 1.0.0
description: |
  Structured data research: search sources, extract structured data,
  archive raw sources, maintain canonical tracker pages, deduplicate.
  Parameterized via YAML recipes for investor updates, donations,
  company updates, or any email-to-structured-data pipeline.
triggers:
  - "research"
  - "track"
  - "extract from email"
  - "investor updates"
  - "donations"
  - "build a tracker"
  - "data dig"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - put_raw_data
  - file_upload
mutating: true
---

# Data Research

Structured research pipeline: search sources, extract structured data,
archive raw, deduplicate, update canonical trackers, backlink entities.

## Contract

One skill for any email-to-structured-data pipeline. The only differences
between tracking investor updates, expenses, and company metrics
are the **search queries**, **extraction schemas**, and **tracker page format**.
All three use the same 7-phase pipeline with parameterized recipes.

## When to Use

- User wants to track structured data from email, web, or API sources
- User says "research", "track", "extract from email", "build a tracker"
- User mentions investor updates, donations, company metrics, filings
- User wants to set up recurring data collection (with cron recipe)

## Phases

### Phase 1: Define Research Recipe

Ask the user what they want to track. Either:
- Pick a built-in recipe: investor-updates, expense-tracker, company-updates
- Define a custom recipe with: source queries, classification rules, extraction schema,
  tracker page path, tracker format

Recipes are YAML files at `~/.gbrain/recipes/{name}.yaml`. Use `gbrain research init`
to scaffold a new one.

### Phase 2: Search Sources

Brain first (maybe we already have this data). Then:
- **Email** via credential gateway: windowed queries (quarterly, monthly if truncated)
- **Web** via search: public filings, press releases, regulatory data
- **APIs**: any structured data source the recipe defines
- **Attachments**: PDF extraction, HTML stripping

### Phase 3: Classify

Deterministic first (regex patterns from recipe), LLM fallback.
Log every LLM fallback for future regex improvement (fail-improve loop).
Skip marketing, newsletters, noise based on recipe's classification rules.

### Phase 4: Extract Structured Data

**EXTRACTION INTEGRITY RULE:**
1. Save raw source immediately (before any extraction)
2. Extract fields using deterministic regex first, LLM fallback
3. When summarizing batch results: **re-read from saved files**
4. Never trust LLM working memory after batch processing

This prevents a known hallucination bug where batch-processed amounts were
13/13 wrong from LLM working memory while saved files were correct.

### Phase 5: Archive Raw Sources

- `put_raw_data` for email bodies, API responses
- `file_upload` for PDF attachments, documents
- Create `.redirect.yaml` pointers for large files in storage
- Every tracker entry must link back to its raw source

### Phase 6: Deduplicate

Before adding to tracker:
- Exact match (same key fields) → skip
- Fuzzy match (same entity + date + similar amount within tolerance) → flag for review
- Different amount for same entity+date → add with note (could be correction)

### Phase 7: Update Canonical Tracker + Backlink

- Parse existing tracker page (markdown table)
- Append new entries in correct section (grouped by year/quarter/entity)
- Compute running totals
- Backlink every mentioned entity (person → people/ page, company → companies/ page)
- Uses enrichment service for entity pages

## Built-In Recipes

Three example recipes ship with GBrain (see `~/.gbrain/recipes/`):

1. **investor-updates** — extract MRR, ARR, growth, burn, runway, headcount from investor update emails
2. **expense-tracker** — extract amounts, recipients, platforms from receipt emails (subscriptions, services, recurring charges)
3. **company-updates** — extract revenue, users, key metrics from portfolio company update emails

## API / Integration Reconnaissance

When a research request asks whether a product has an API/integration surface for automation:

1. Prefer official developer docs first; use search-engine results mainly to discover exact endpoint doc slugs when docs are JS-rendered or route IDs are opaque.
2. Extract the practical integration shape, not a full doc mirror: auth options, read/write endpoints, scopes, limits, webhook support, paid-plan gates, and caveats.
3. Distinguish “can read availability/busy state” from “can create bookings” and from “can mutate the underlying calendar provider.” Recommend pairing with Google/Apple/Microsoft calendar APIs when the product API only exposes scheduling-layer data.
4. If a compact API note is likely reusable, save it under `references/<product>-api-recon.md` and link it here.

Reusable API notes:
- `references/calendly-api-recon.md` — Calendly auth, busy/available slots, scheduled events, booking creation, one-off event types, webhooks, and caveats.

## Social / Practitioner Research

When a research request asks for “what users/practitioners are doing” rather than just official design:

1. Separate evidence classes explicitly: official docs, upstream GitHub, third-party repos, practitioner blogs, X/Twitter, and local context.
2. Use rendered browser/cloud browser for X or other JS-heavy social surfaces when API/CLI access is unavailable, but label login-wall or indexed-snippet limitations.
3. If X search is blocked, use search-engine indexed snippets only as low-confidence leads; verify visible snippets with screenshots/vision when possible before quoting.
4. Distinguish “migration support” from “integration in active use.” Migration commands prove ecosystem overlap, not a mature workflow.
5. For cross-agent ecosystem research, preserve provenance: who said it, source URL, date if visible, exact snippet/claim, and confidence/assessment.

Reference notes: see `references/hermes-openclaw-integration-research.md` for a concrete Hermes/OpenClaw integration research pass and source-confidence ladder.

## Consumer Vendor / Ticket Legitimacy Research

When the user asks whether a travel/event/ticket vendor is “legit” and wants pricing/recommendations:

1. Use browser/cloud browser agents for live vendor pages when available; otherwise fall back to direct browser plus terminal HTTP extraction. Dynamic pricing and package inclusions often require rendered pages.
2. Separate **platform legitimacy** from **specific listing risk**. A major OTA/marketplace can be legitimate while a marketplace product has low booking count, unclear operator identity, contradictory policies, language constraints, or package ambiguity.
3. Compare against the official seller first. Capture official warnings about authorized channels, especially for add-ons like fast-pass/Premier Access where third-party listings may be concierge workarounds rather than official products.
4. Extract exact visible fields: product title, URL, product/listing ID, date-specific price, currency, what is included/excluded, whether admission is included, cancellation/refund terms, confirmation timing, review count/booked count, service language, and operator/platform legal footer if visible.
5. Present recommendations in plain terms: cheapest legitimate entry, best official/value bundle, what to avoid, and the specific booking path. Avoid tables for Telegram; use short labeled bullets.
6. Flag currency conversions as rough unless live FX was fetched. Do not book, enter passport/payment info, or click final purchase without explicit confirmation.

Reference notes: see `references/shanghai-disney-ticket-legitimacy.md` for a concrete ticket/vendor legitimacy comparison format and pitfalls.

## Anti-Patterns

- Trusting LLM working memory for amounts after batch processing (use extraction integrity rule)
- Creating tracker entries without raw source links
- Running without deduplication (leads to double-counted entries)
- Hardcoding source-specific patterns in the pipeline code (use recipes)
- Presenting Google-indexed X/Twitter snippets as verified full practitioner threads
- Treating third-party MVP bridge repos as canonical production standards without adoption evidence

## Output Format

Brain page at the recipe's `tracker_page` path with markdown tables:

```markdown
### 2026

| Date | Company | MRR | ARR | Growth | Status |
|------|---------|-----|-----|--------|--------|
| 2026-04-01 | Example Co | $188K | $2.3M | +14.7% MoM | [Source](link) |
```

Each entry links to its raw source. Running totals at the bottom of each section.

## Conventions

References `skills/conventions/quality.md` for citation and back-linking rules.
