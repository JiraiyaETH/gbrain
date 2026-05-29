---
name: meeting-ingestion
version: 1.0.0
description: |
  Ingest meeting transcripts into brain pages with attendee enrichment, entity
  propagation, and timeline merge. A meeting is NOT fully ingested until the
  enrich skill has processed every entity.
triggers:
  - "meeting transcript"
  - "process this meeting"
  - "meeting notes"
  - meeting transcript received
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - people/
  - companies/
---

# Meeting Ingestion Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Meeting page created with attendees, summary, key decisions, action items
- EVERY attendee gets a people page (created or updated)
- EVERY company discussed gets entity propagation
- Timeline entries on ALL mentioned entities (timeline merge)
- Meeting is NOT fully ingested until enrich runs for every entity
- Back-links created bidirectionally

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every attendee and company mentioned MUST get a back-link from their page to
the meeting page. An unlinked mention is a broken brain.

## Read-only retrieval path

Use this before ingesting when the user asks for existing meeting notes, Fireflies notes, latest notes, or a meeting summary by title/date.

1. Search both Brain meeting pages and the local meeting-intelligence database before assuming the meeting title is exact.
2. Treat Fireflies titles as noisy; match by date, participants, organizer, keywords, and content when the requested title differs from the stored title.
3. Check `meeting_page_sync_state` for the synced Brain page path, then read that page for the canonical summary/action items.
4. If needed, query `meetings` and `sentences` in `/Users/jarvis/.openclaw-jarvis-v2/data/intelligence/meeting-intelligence.db` for source rows and transcript snippets.
5. Return the Fireflies link, date/time, duration, local Brain page path, summary, topics, and action items. Do not ingest or mutate unless the user explicitly asks to process/update the meeting.

Example local lookup pattern:
```bash
sqlite3 -json /Users/jarvis/.openclaw-jarvis-v2/data/intelligence/meeting-intelligence.db \
  "select id,title,date_recorded,duration_seconds,organizer_email,transcript_url,short_summary,action_items_json from meetings where date(date_recorded)='YYYY-MM-DD' order by date_recorded desc;"

sqlite3 -json /Users/jarvis/.openclaw-jarvis-v2/data/intelligence/meeting-intelligence.db \
  "select * from meeting_page_sync_state where meeting_id='<meeting_id>';"
```

## Phases

### Phase 1: Parse the transcript

Extract from the transcript:
- Attendees (names, roles if available)
- Date, time, duration
- Key topics discussed
- Decisions made
- Action items with owners
- Companies and projects mentioned

### Phase 2: Create meeting page

```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}

## Summary
{3-5 bullet key outcomes}

## Key Decisions
{Decisions with context}

## Action Items
{Tasks with owners and deadlines}

## Discussion Notes
{Structured notes by topic}
```

### Phase 3: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `gbrain search "{name}"` — does a people page exist?
2. If NO → create via enrich skill (this is mandatory, not optional)
3. If YES → update compiled truth with meeting context
4. Add timeline entry on the person's page:
   `gbrain timeline-add <person-slug> <date> "Attended <meeting-title>"`

**Note (v0.10.1):** Once the meeting page is written via `gbrain put`, the
auto-link post-hook automatically creates `attended` links from the meeting
to each attendee whose page is referenced as `[Name](people/slug)`. You don't
need to call `gbrain link` for attendees. You DO still need `gbrain timeline-add`
for dated events (auto-link only handles links, not timeline entries).

### Phase 4: Entity propagation (MANDATORY)

For each company, project, or concept discussed:
1. Check brain for existing page
2. Create/update as needed
3. Add timeline entry referencing the meeting
4. Back-link from entity page to meeting page

### Phase 5: Timeline merge

The same event appears on ALL mentioned entities' timelines. If Alice met Bob at
Acme Corp, the event goes on Alice's page, Bob's page, AND Acme Corp's page.

### Phase 6: Sync

`gbrain sync` to update the index.

## Output Format

Meeting page created. Report: "Meeting ingested: {N} attendees enriched, {N} entities
updated, {N} action items captured."

## Anti-Patterns

- Creating the meeting page without enriching attendees
- Skipping entity propagation ("I'll do that later")
- Not merging timelines across all mentioned entities
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking to all participants
- Assuming the user's remembered meeting title exactly matches the Fireflies stored title; verify by date, participants, organizer, and transcript/content before saying not found
- Mutating or re-ingesting a meeting when the user only asked to retrieve existing notes
