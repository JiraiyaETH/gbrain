# Filled Mini Example

This file shows the expected level of detail without requiring a full live research run.

## Brief

Question: Should we use Firecrawl as the default extractor in a source-backed research pipeline?

Decision: choose default extraction route for V1 manual protocol.

Scope: extraction capability and citation support only. Out of scope: paid plan selection.

## Source Card

```json
{
  "source_id": "S1",
  "title": "Firecrawl Search API docs",
  "url_or_slug": "https://docs.firecrawl.dev/features/search",
  "source_class": "docs",
  "authority": "primary",
  "published_or_updated": "unknown",
  "accessed": "2026-07-01",
  "why_included": "Official docs for search plus scrape behavior",
  "key_quotes": ["Search endpoint can return markdown, links, HTML, screenshots, and structured outputs"],
  "claims_extracted": ["Firecrawl can search and scrape clean source bodies suitable for citation support"],
  "bias_or_incentive_notes": "Vendor docs; reliable for product capability, not independent performance superiority",
  "freshness_notes": "Check docs at run time",
  "can_support_final_claims": true,
  "requires_corrobation_for": ["best extractor", "performance superiority", "cost advantage"]
}
```

## Claim Card

```json
{
  "claim_id": "C1",
  "claim": "Firecrawl can be used as an extraction route when a known URL or search result needs readable source-body text.",
  "claim_type": "fact",
  "source_ids": ["S1"],
  "evidence_confidence": "high",
  "downgrade_reasons": [],
  "contradicting_source_ids": [],
  "what_would_change_this": "Official docs removing markdown/scrape support or repeated extractor failures in live runs",
  "allowed_in_final_memo": true,
  "notes": "Does not support stronger claims like 'best' or 'most reliable' without independent evidence."
}
```

## Mini Citation Registry

```json
{
  "registry_version": "1.0",
  "approved_sources": ["S1"],
  "claims": [
    {
      "claim_id": "C1",
      "claim": "Firecrawl can be used as an extraction route when a known URL or search result needs readable source-body text.",
      "approved_source_ids": ["S1"],
      "citation_status": "approved",
      "reason": "Official docs support the product capability."
    }
  ],
  "rejected_claims": [
    {
      "claim": "Firecrawl is the best extractor for all research tasks.",
      "reason": "Vendor docs alone cannot support comparative superiority."
    }
  ]
}
```

## Mini Decision Memo

Verdict: Use Firecrawl as one extraction route, not the whole acquisition layer.

Evidence confidence: high for basic extraction capability; low for comparative superiority.

Recommendation strength: directional. It is useful and reversible as a V1 default for known URLs, but not enough evidence to make it the only route.

Evidence boundary: official docs support capability; independent reliability/cost benchmarking was not checked in this mini example.
