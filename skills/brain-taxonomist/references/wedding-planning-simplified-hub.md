# Wedding planning Brain structure — simplified hub pattern

Session: 2026-06-28 wedding planning cleanup.

## Trigger

Use when the user is shaping a personal wedding/life-event project in Brain and explicitly wants clean tracking without “a bazillion links/files.”

## Lesson

Start with the hub-and-satellites pattern, then aggressively merge before writing. The right structure is the smallest set of notes that still separates different update rhythms and evidence types.

For Jiraiya’s wedding plan, the approved shape was:

```text
projects/my-wedding.md
notes/my-wedding-katathani-package-and-form.md
notes/my-wedding-ceremony-timeline-and-roles.md
notes/my-wedding-guests-travel-and-communications.md
notes/my-wedding-budget-vendors-and-sourcing.md
notes/my-wedding-post-wedding-thailand-tour.md
```

## Merge rules

- Do **not** keep a generic `*-prep.md` if the project hub already tracks the core links and outstanding sequence.
- Merge ceremony structure + master timeline + photo/video + day-of role ownership when they all drive the same run-of-show.
- Merge guest logistics + guest communications + RSVP summary; keep raw guest PII outside Brain.
- Merge budget + vendor payments + venue add-ons + external sourcing + rings/performance vendors.
- Keep venue/package/form as one note when a dense vendor form exists; do not split cake/flowers/music/favors unless a subtopic becomes independently complex.
- Reframe “post-wedding plan” according to user intent. In this session it meant Thailand touring/hosting with guests, not cleanup/admin aftercare.

## Source model

For active planning pages built directly from current operator chat/input, avoid `[Source: Jiraiya / Telegram]` after every bullet. Put a compact `## Source / evidence model` on the project hub naming the input classes. Create/link `sources/` pages only for raw durable artifacts: invoices, completed forms, vendor PDFs, signed agreements, booking confirmations, or exported guest/contact data.

## Verification

Before reporting done:

1. Validate frontmatter for every proposed page.
2. Write through the correct GBrain source, not an accidental code/upstream source.
3. Remove stale DB pages and local files for superseded notes.
4. Sync with `gbrain sync --source default --no-pull --no-embed`.
5. Run scoped link extraction.
6. Verify graph/backlinks and remove stale edges from deleted notes.
7. Read back the project hub and confirm it has a decision sequence for future turns.
