---
name: media-ingest
version: 1.0.0
description: |
  Ingest video, audio, PDF, book, screenshot, and GitHub repo content into the brain.
  Multi-format handling with entity extraction and backlink propagation. Covers
  video-ingest, youtube-ingest, and book-ingest subtypes.
triggers:
  - "watch this video"
  - "process this YouTube link"
  - "ingest this PDF"
  - "save this podcast"
  - "process this book"
  - "PDF book"
  - "summarize this book"
  - "ingest it into my brain"
  - "what's in this screenshot"
  - "check out this repo"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - file_upload
mutating: true
writes_pages: true
writes_to:
  - concepts/
  - people/
  - companies/
  - sources/
---

# Media Ingest Skill

Ingest video, audio, PDF, book, screenshot, and GitHub repo content into the brain.

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Every ingested media item has a brain page with analysis (not just a transcript dump)
- Transcripts (video/audio) saved in raw and human-readable formats
- Entity extraction: every material person/company relationship gets back-linked
- Raw source files preserved via `gbrain files upload-raw` when the raw file is appropriate for Brain provenance
- Sensitive personal media archives are handled as an exception: keep originals outside the Brain in a topic-specific `/Users/jarvis/data/...` folder, generate metadata/OCR/index artifacts there, and write only distilled summaries/timelines/pointers to Brain
- Filing by primary subject, not format

**Private personal media exception:** when the source is a private personal photo/video collection, relationship evidence set, family archive, wedding evidence pool, guest list material, passport/ID-adjacent collection, or anything with sensitive personal context, do **not** default to raw-uploading originals into Brain. Keep raw media outside Brain in a private local data folder or secure vault; write only distilled indexes, timelines, proof summaries, and pointers into Brain. See `references/personal-photo-evidence-source-pools.md`. For relationship/legal evidence curation specifically, including screenshot/call-history guidance and MAS-style shortlist workflow, see `references/private-relationship-evidence-curation.md`.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.
> See `skills/conventions/graph-safe-writing.md` before writing entity links;
> source/media pages often mention many entities, but wikilinks should be an
> intentional edge budget, not a complete named-entity dump.
> See `skills/conventions/post-run-retrieval-gate.md` after write/sync; media
> pages should support retrieval without swamping canonical entities.

Every material person/company relationship with a brain page MUST create a
back-link. Incidental names in long transcripts, books, screenshots, or repos
stay plain prose unless traversal is intended.

## Phases

### Phase 1: Identify format and fetch

| Format | Action |
|--------|--------|
| YouTube/video URL | Fetch transcript (Whisper, transcription service, or captions) |
| Audio file | Transcribe with available STT service |
| PDF | Extract text (OCR if needed) |
| Book PDF | Extract text, identify chapters/sections |
| Screenshot/image | OCR via vision model, extract text and entities |
| GitHub repo | Clone, read README + key files, summarize architecture |

### Phase 2: Preserve raw source

For public/reference media and ordinary ingests, save the original file for provenance: `gbrain files upload-raw <file> --page <slug>`.

For private personal media collections, preserve originals outside Brain instead, then write only a distilled index/timeline into the relevant Brain project or note. Use the personal source-pool layout in `references/personal-photo-evidence-source-pools.md`.

### Phase 3: Create brain page

File by primary subject (not format). Use this template:

```markdown
# {Title}

**Source:** {URL or file path}
**Format:** {video/audio/PDF/book/screenshot/repo}
**Created:** {date}

## Summary
{Key points, not a transcript dump}

## Key Segments / Highlights
{For video/audio: timestamped highlights. For books: chapter summaries.}

## People Mentioned
{List with links to brain pages}

## Companies Mentioned
{List with links to brain pages}
```

For long transcripts, books, screenshots, and repos, keep `People Mentioned` /
`Companies Mentioned` curated. Link high-signal entities that should be
traversable; leave incidental names as prose. Do not place every source slug,
file path, or low-signal named entity into wikilinks.

### Phase 4: Entity extraction and propagation

For every material person and company relationship:
1. Check brain for existing page
2. Create/enrich if needed (delegate to enrich skill)
3. Add back-link from entity page to this media page
4. Add timeline entry on entity page

After write, inspect `auto_links` and run focused graph readbacks for high-value
pages. Strong typed edges from media pages are suspicious unless explicitly
evidenced; otherwise they should be `mentions` / `relates_to`.

A media item is NOT fully ingested until entity propagation is complete.

### Phase 5: Sync

`gbrain sync` to update the index.

### Phase 6: Retrieval gate

Run the smoke or entity gate from `skills/conventions/post-run-retrieval-gate.md`.
Verify the media page surfaces for specific content queries, while canonical
person/company/project pages still win broad identity or "what do we know"
queries.

## Output Format

Brain page created with summary, highlights, and entity cross-links. Report to user:
"Ingested {title}: {N} entities detected, {N} pages updated."

## Sensitive personal media archives

For private photo/video archives (wedding evidence, family photos, IDs-adjacent material, private relationship media), do **not** default to uploading originals into the Brain. Use a private data landing folder such as:

```text
/Users/jarvis/data/personal/<topic>/evidence/
  00_inbox/
  01_photos/
  02_screenshots/
  03_documents/
  metadata/
```

Then generate:
- EXIF/date/location index
- OCR text from screenshots/documents
- curated evidence shortlist
- distilled relationship/timeline summary
- pointers to the external file location

Only the distilled, non-sensitive planning state belongs in Brain. Keep raw photos/videos outside Brain unless Jiraiya explicitly asks to attach a selected artifact and the privacy boundary is clear.

## Anti-Patterns

- Dumping raw transcripts without analysis
- Skipping entity extraction ("I'll do that separately")
- Filing **raw ingest** by format (all videos in `media/videos/`) instead of by subject. Note: format-prefixed paths under `media/<format>/<slug>` ARE sanctioned for **synthesized one-of-one output** like book-mirror's `media/books/<slug>-personalized.md`. The anti-pattern is for raw ingest, not for sui generis synthesis. See `skills/_brain-filing-rules.md` "Sanctioned exception: synthesis output is sui generis."
- Uploading broad private photo/video archives into Brain when a private `/Users/jarvis/data/...` landing folder plus distilled Brain index is safer
- Not preserving raw source files when the raw file is appropriate for Brain provenance
- Creating stub pages without meaningful content
- Bulk-uploading private personal photo/video originals into Brain when a private local data folder plus distilled Brain index is safer and more useful
