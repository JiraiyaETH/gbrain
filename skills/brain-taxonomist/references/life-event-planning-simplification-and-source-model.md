# Life-event planning simplification + source model

Session: 2026-06-28 wedding planning Brain restructure.

## Lesson

For personal life-event planning, the hub-and-satellite pattern still needs a file-count discipline. A first pass may over-split into one note per concern; before writing, compress anything that is operationally read together.

## Simplification heuristic

Use one `projects/<event>.md` hub plus the fewest `notes/<event>-*.md` satellites that will actually be opened independently.

Merge notes when they share the same review cadence or decision owner:

- Ceremony structure + master timeline + photo/video coverage + day-of roles -> one operations note.
- Guest logistics + RSVP summary + accommodation + guest communications -> one guest/travel/comms note.
- Budget + vendors + package add-ons + external sourcing + payments -> one budget/vendors/sourcing note.
- Venue/vendor package and long form -> one distilled package/form note.
- Post-event plans should reflect the user’s actual intent; e.g. a Thailand guest tour is not a generic post-wedding cleanup checklist.

Delete or deprecate the broad initial prep note once the project hub tracks the active structure. Avoid keeping both a hub and a duplicate `*-prep` index unless there is a clear archival reason.

## Source/evidence model for active planning notes

For live planning pages built directly from the user’s current chat/input, do not litter every bullet with `[Source: Jiraiya / Telegram]`. Instead:

1. Put a short `## Source / evidence model` on the project hub naming the active inputs: user/operator planning updates, vendor/public package page, extracted form, etc.
2. Treat the project and linked notes as the current working source of truth.
3. Only create/link `sources/` pages or secure-file pointers for durable raw artifacts: invoices, completed form exports, signed agreements, vendor PDFs, booking confirmations, raw guest exports.
4. Keep the notes distilled: decisions, TODOs, status, costs, owner/deadline, and links.

## Verification pattern

After writing:

- Validate frontmatter on the exact touched files.
- Sync the correct source explicitly.
- Run link extraction / graph verification.
- Read back the project hub and ensure it contains a decision sequence or priority order for future conversations.
- Check the graph from the hub reaches all satellites.
- If an accidental write targets the wrong source, delete/clean both DB entry and write-through files, then verify no duplicate files remain.
