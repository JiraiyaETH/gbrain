# Life-event evidence/media tracker routing

Session-derived routing note from wedding/Denmark documentation prep.

## Decision

When a life event has a private photo/video/evidence pool, do **not** automatically file the working tracker under `sources/` just because raw evidence exists.

Use:

- `projects/<event>.md` — short hub/control plane.
- `notes/<event>-relationship-evidence-and-media.md` or equivalent — working tracker for inventory summaries, curation state, evidence gaps, shortlist status, and pointers to private storage.
- `/Users/jarvis/data/<domain>/<event>/...` — raw private media, scans, archives, contact sheets, OCR, manifests, checksums, and curated output folders.
- `sources/` — only when preserving or distilling a raw-ish source artifact/import that feeds multiple pages, such as a vendor policy dump, external form export, PDF/source text, booking confirmation corpus, or copied source material.

## Why

A relationship-evidence/media page is an operational planning note, not the source artifact itself. It changes as curation progresses: received archive, checksum, extracted folder, inventory, shortlisted files, context questions, and submission readiness. Filing it under `sources/` makes the Brain look like it is storing raw provenance when it is actually tracking workflow state.

## Privacy boundary

For private personal media, store originals outside Brain and write only distilled pointers/status into Brain. Raw media should not be uploaded into Brain unless the user explicitly approves a selected artifact and the privacy boundary is clear.

## Good pattern

```text
projects/my-wedding.md
notes/my-wedding-denmark-legal-application.md
notes/my-wedding-relationship-evidence-and-media.md
/Users/jarvis/data/personal/my-wedding/evidence/
  00_inbox/
  01_relationship-photos/
  04_curated-for-mas/
  05_video-candidates/
  metadata/
```

## Pitfall

If the user asks whether a tracker belongs in `sources/`, separate **raw source pool** from **working tracker**. The raw pool may be a source-like artifact, but the tracker is usually a `note` linked from the project hub.
