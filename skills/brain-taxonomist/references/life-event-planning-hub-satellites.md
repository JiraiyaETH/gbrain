# Life-event planning in Brain — hub + satellites

Session: 2026-06-28 wedding planning setup.

## Pattern

For a substantial personal life event with multiple workstreams (legal/admin prep, itinerary, dress code, guests, vendors), use a **project hub + note satellites** rather than one monolithic project file.

Recommended shape when the active schema supports `project` and `note`:

```text
projects/<event-slug>.md              # hub/control plane
notes/<event-slug>-prep.md            # first planning checklist
notes/<event-slug>-itinerary.md       # travel/logistics once substantial
notes/<event-slug>-guest-plan.md      # guest planning summary, no raw PII
notes/<event-slug>-dress-code.md      # attire/vibe if substantial
sources/<event-slug>-vendor-*.md      # only raw-ish imports/quotes feeding multiple pages
external secure storage               # sensitive originals and full private data
```

## Brain boundary

Brain should hold distilled state: decisions, checklist status, questions, pointers to secure files, summaries of vendor requirements, and booking confirmations.

Keep outside Brain: passport/ID scans, visas/residence permit scans, certificates, divorce/death documents, signatures, payment details, full guest addresses/contact data, and other sensitive originals.

## Workflow lesson

Before creating the pages:

1. Confirm the active source and schema: `gbrain sources list --json`; `gbrain schema show --json`.
2. Check local exemplars for frontmatter in the target directories (`projects/`, `notes/`) instead of inventing fields.
3. Draft files in profile scratch if useful, validate frontmatter, then write through `gbrain capture --file ... --slug ... --type ... --source default` or the native put_page surface.
4. Validate written pages with `gbrain frontmatter validate`.
5. Run `gbrain sync --repo <brain> --source default --no-pull --no-embed` so search sees the pages. Do not omit `--source default` when the CLI has multi-source routing quirks.
6. Verify with search/readback before reporting done.

## Filing rationale

Use `projects/` for the live control plane when the item has outcomes, tasks, dates, vendors, and moving parts. Use `notes/` for subject-specific planning details. Use `personal/` only for reflections/patterns or personal annotation pages, not the main operational tracker. Use `sources/` only for raw data imports or vendor/source material that feeds multiple distilled pages.
