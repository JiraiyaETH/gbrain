# Source-basis guidance v1.3

This skill's process claims are grounded by its executable validator, JSON
templates, and the filled example in this package. These are internal design
artifacts, not independent evidence of research effectiveness. A run must cite
the underlying source for every material claim; a template or model output is
never a substitute for that source.

## Source classes and permitted use

| Class | Example | Suitable support | Auditor rule |
|---|---|---|---|
| primary | official specification, regulator filing, original paper, first-party dataset | direct product, policy, method, or reported-result claims | record URL/slug, access date, exact excerpt or field, and freshness |
| independent-secondary | peer-reviewed review, reputable reporting, independent benchmark | synthesis, context, or corroborated comparison | disclose methodology and separate reported fact from interpretation |
| vendor/docs | vendor documentation or release notes | vendor capability, interface, stated limits | do not use alone for “best”, superiority, reliability, or market claims |
| Brain/internal | dated curated Brain page or packet | prior context and novelty baseline | label as internal; re-check externally for current or decision-critical evidence |
| discovery-only | search result, snippet, directory, model summary | locating a candidate source | never cite as evidence; replace with fetched source body |

For each included source, populate `source_id`, title, URL or Brain slug,
`source_class`, authority, publication/update date, accessed date, supported
claim IDs, caveats, and exact quote/field. For each claim, populate
`source_ids[]`, freshness date, verifier lane, and contradiction IDs. A claim is
`verified` only when at least one allowed direct source supports its scope and
the citation auditor records the mapping; decision-critical comparative claims
require independent corroboration or an explicit downgrade.

## Filled mapping and enforcement example

```json
{
  "source": {"source_id":"S1", "source_class":"vendor/docs", "authority":"primary", "url":"https://example.test/docs", "accessed":"2026-07-16", "exact_quote":"The API returns markdown."},
  "claim": {"claim_id":"C1", "text":"The API returns markdown.", "source_ids":["S1"], "status":"verified", "decision_critical":false},
  "audit": {"result":"allowed", "reason":"direct capability claim matches quote"}
}
```

The same source cannot pass a claim that says the vendor is “the best”: the
auditor must reject it as `INSUFFICIENT_SOURCE_CLASS` or downgrade it. A source
ledger row with only a snippet/result URL fails `SNIPPET_CITED_AS_SOURCE`; a
verified claim with no source IDs fails `CLAIM_WITHOUT_SOURCE_ID`.