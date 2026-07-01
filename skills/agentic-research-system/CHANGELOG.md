# Agentic Research System Changelog

## 1.0.0 — 2026-07-01

- Created shared GBrain skill from the agentic research system memo.
- Added protocol-lite brief, scout contracts, source/claim/citation templates, run receipt, eval report, resolver entry, manifest entry, unit tests, and e2e fixture.
- Cross-modal eval cycle 1 failed on sourcing/specificity/usefulness. Applied hard gates, source basis, material-claim definitions, reviewer reconciliation, and example artifacts before rerun.
- Claude Opus review found blockers around mutating frontmatter, eval target laundering, trigger ambiguity, and implied tool capability. Fixed by setting `mutating: true`, separating skillification vs run-output evals, tightening triggers, and declaring Browser/Social/Data-Code tool needs.
