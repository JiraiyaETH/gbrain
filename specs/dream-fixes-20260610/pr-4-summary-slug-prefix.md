# PR draft — Patch #4: dream summary slug follows allow-list

## Summary
- Derive the dream-cycle summary prefix from the configured dream synthesize allow-list when a `dream-cycle` glob is present.
- Add `dream.synthesize.summary_slug_prefix` as the fallback config key for custom installs without a dream-cycle allow-list entry.
- Preserve the stock `dream-cycle-summaries/YYYY-MM-DD` default for back-compat.

## Why
The attempt-2/attempt-3 receipts showed child outputs could be safely relocated via allow-list, but the orchestrator summary stayed hardcoded to `dream-cycle-summaries/${date}`. This closes that remaining local-carry path mismatch without breaking stock installs.

## Tests
- `bun test test/cycle-synthesize.test.ts`

## Notes
The orchestrator still validates the final summary slug against the existing slug regex before writing.
