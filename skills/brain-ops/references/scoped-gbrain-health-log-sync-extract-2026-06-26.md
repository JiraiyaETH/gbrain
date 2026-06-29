# Scoped GBrain health-log sync/extract test — 2026-06-26

## When this matters

Use this reference when testing a small set of file-backed Brain pages, especially health logs under `food/` and `workout/`, without allowing a broad sync/extract to touch unrelated repo changes.

## Lessons from the workout/food shelf test

### 1. Scope writes by source explicitly

`gbrain put` can write to the wrong source if the caller's source context is not explicit. In the observed test, unscoped `gbrain put workout/2026-06-25-alina ...` wrote the page under `gbrain-code` even though the file being tested belonged to `/Users/jarvis/brain`.

Safe pattern:

```bash
GBRAIN_SOURCE=default gbrain put workout/YYYY-MM-DD-person --content "$(cat /Users/jarvis/brain/workout/YYYY-MM-DD-person.md)"
GBRAIN_SOURCE=default gbrain get workout/YYYY-MM-DD-person
```

For large content, use a script that passes `--content` as an argv value rather than shell-expanding big markdown inline.

Verify both sides when source drift is suspected:

```bash
GBRAIN_SOURCE=default gbrain get workout/YYYY-MM-DD-person
GBRAIN_SOURCE=gbrain-code gbrain get workout/YYYY-MM-DD-person
```

If an accidental wrong-source page was created:

```bash
GBRAIN_SOURCE=gbrain-code gbrain delete workout/YYYY-MM-DD-person
GBRAIN_SOURCE=gbrain-code gbrain get workout/YYYY-MM-DD-person  # should be page_not_found / soft-deleted
rm -f /Users/jarvis/gbrain/workout/YYYY-MM-DD-person.md          # remove write-through residue if present
```

### 2. Prefer exact `put` for scoped tests over broad sync

Before running `gbrain sync`, dry-run it:

```bash
gbrain sync --source default --no-pull --no-embed --no-extract --dry-run --json
```

If dry-run shows unrelated files, do not run broad sync for a tiny test. Use exact `GBRAIN_SOURCE=default gbrain put <slug> --content ...` for the pages under test, then verify with `gbrain get`.

### 3. Timeline extraction has a strict markdown shape

The extractor did **not** create timeline entries from lines like:

```markdown
- 2026-06-25 10:39 +07 — Alina reported assisted chin-up...
```

It did create entries from:

```markdown
- **2026-06-25** | 10:39 +07 — Alina reported assisted chin-up...
```

GBrain stores the timeline `date` at date-level (`2026-06-25T00:00:00.000Z`); the minute survives inside the source/summary text (`10:39 +07 — ...`). If exact minute matters for later synthesis, keep it after the pipe.

### 4. Extract links/timeline narrowly after exact puts

Scoped extraction command used:

```bash
GBRAIN_SOURCE=default gbrain extract all \
  --source db \
  --source-id default \
  --type log \
  --since YYYY-MM-DD \
  --json
```

This processed only the two relevant log pages in the test after exact puts.

### 5. Same-day sibling edges may need explicit links

`put`/extract created `mentions` links to the goal page, but did not automatically create the intended sibling edge between food and workout logs from the wikilinks. For the test, the working graph was created manually:

```bash
GBRAIN_SOURCE=default gbrain link workout/YYYY-MM-DD-person food/YYYY-MM-DD-person \
  --link-type same_day_log --link-source scoped-test
GBRAIN_SOURCE=default gbrain link food/YYYY-MM-DD-person workout/YYYY-MM-DD-person \
  --link-type same_day_log --link-source scoped-test
```

Verify:

```bash
GBRAIN_SOURCE=default gbrain graph workout/YYYY-MM-DD-person --depth 1
GBRAIN_SOURCE=default gbrain backlinks food/YYYY-MM-DD-person
GBRAIN_SOURCE=default gbrain timeline workout/YYYY-MM-DD-person
```

## Resulting expected graph shape

```text
workout/YYYY-MM-DD-person ↔ food/YYYY-MM-DD-person
          both → personal/<person>-goals
```

This gives graph traversal the useful relationship without polluting broad person pages.
