# Private relationship evidence curation

Session-derived pattern for turning a private couple photo/message archive into an official evidence pack while preserving privacy.

## Scope

Use for wedding/legal relationship evidence, especially digital-nomad couples without fixed cohabitation paperwork.

## Source handling

- Raw photos/videos/screenshots stay outside Brain under `/Users/jarvis/data/personal/<event>/evidence/` or another private data folder.
- Brain stores only inventory summaries, curation state, date ranges, shortlist status, and secure pointers.
- Prefer original exports from Photos/AirDrop over Telegram/WhatsApp copies because chat apps compress media and strip metadata.

## Evidence posture for nomads

If there is no stable shared address or residence permit, do not force cohabitation proof. Build around:

- dated photos across years/countries;
- travel/location overlap;
- family/friends/social-context photos;
- message/call continuity across time;
- travel booking overlaps when available;
- a concise relationship timeline.

## Message/call screenshot guidance

Ask for continuity, not intimate content:

- 1-2 screenshots from early relationship period;
- 1-2 from middle period;
- 1-2 recent screenshots;
- prefer screenshots showing contact name + dates + calls/messages over time;
- content may be cropped/redacted if dates/contact continuity remain visible;
- WhatsApp call history is useful if it shows the person's name and dated call entries.

Recent-only screenshots are weaker than a spread across time.

## Curation outputs

Recommended folder shape:

```text
00_inbox/
01_relationship-photos/
02_message-screenshots/
03_travel-bookings/
04_curated-for-mas/draft-YYYYMMDD/
05_video-candidates/draft-YYYYMMDD/
metadata/
```

Recommended artifacts:

- `relationship-photos-inventory-YYYYMMDD.csv`
- `relationship-photos-summary-YYYYMMDD.json`
- `contact-sheets-YYYYMMDD/`
- `mas-draft-shortlist-YYYYMMDD.md/json`
- `mas-caption-questions-YYYYMMDD.md`
- `video-candidate-draft-shortlist-YYYYMMDD.json`

## Review sequence

1. Verify archive integrity and checksum.
2. Extract originals and remove `__MACOSX` / AppleDouble noise.
3. Generate inventory with dates, sizes, dimensions, hashes.
4. Generate contact sheets for fast visual triage.
5. Split shortlist into official evidence versus story/video candidates.
6. Ask user for captions only on ambiguous/high-value images.
7. Add message/call/travel proofs only if the photo set leaves continuity gaps or the agency asks.

## Pitfall

Do not over-submit. Legal evidence wants a compact, boring proof pack. The wedding video wants emotional texture. Keep those lanes separate even if they draw from the same source pool.
