# PR draft — Patch #5: synthesize prompt examples come from allow-list

## Summary
- Derive reflection/original slug example prefixes from the threaded `allowed_slug_prefixes` list sent to synthesize children.
- Strip glob suffixes before rendering examples.
- Preserve stock `wiki/personal/reflections` and `wiki/originals/ideas` examples only when the allow-list is empty.

## Why
The attempt-2/attempt-3 receipts showed the dream orchestrator correctly threading an allow-list, but the child prompt still nudged the model toward stock wiki paths. That creates avoidable conflict for carried/local installs with different filing prefixes.

## Tests
- `bun test test/cycle-synthesize.test.ts`

## Notes
This changes prompt examples only; server-side `brain_put_page` enforcement still comes from the same allow-list.
