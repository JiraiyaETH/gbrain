# Venue/package form distillation for life-event planning

Session: 2026-06-28 wedding planning restructure for Katathani Phuket.

## Pattern

When a life-event project has a vendor package plus a long form or questionnaire, do **not** explode every form section into separate notes. Create one distilled package/form satellite and link it to the project hub plus the genuinely independent workstream notes.

Recommended shape:

```text
projects/<event>.md
notes/<event>-<vendor-or-venue>-package-and-form.md
notes/<event>-master-timeline.md
notes/<event>-guest-logistics.md
notes/<event>-budget-and-payments.md
notes/<event>-photo-video-shot-list.md
...
```

## What belongs in the package/form note

- Package baseline / included services.
- Form facts already filled.
- Open form decisions.
- Upgrade/add-on costs.
- External sourcing candidates where the vendor is optional rather than mandatory.
- Links to downstream workstream notes.

Use tables shaped like:

```markdown
## Form facts already filled

| Field | Current value | Status |
|---|---|---|
| Wedding date | 2026-11-01 | Filled |
| Photographer | Adam Phuket | Selected |

## Open form decisions

| Area | Decision needed | Notes |
|---|---|---|
| Headcount | Adults and children counts | Needed before final venue form |

## Venue add-ons and external sourcing candidates

| Item | Venue price / status | Needed? | External sourcing? | Owner | Deadline |
|---|---:|---|---|---|---|
| Videographer | THB 15,000-30,000 options shown | TODO | Yes, compare local providers | TBD | Before package submission |
```

## What should not become separate notes yet

Do not create standalone notes for cake, flowers, music, chairs, favors, makeup, parasols, buttonholes, or similar vendor-form sections unless the topic becomes independently complex. Keep them as subsections of the package/form note and route only their downstream implications into timeline, budget, guest logistics, or photo/video notes.

## Source boundary

A user-supplied form extraction can be treated as working evidence without creating a `sources/` page when the user asks for distilled planning notes. Use `sources/` only when explicitly ingesting raw vendor material for durable provenance or reuse across multiple pages. Otherwise keep the form dump out of Brain and cite it in the distilled notes as user-provided form extraction.

## Sensitive data boundary

Normalize or omit unnecessary sensitive/private fields. Do not store full phone numbers, private contact lists, payment details, passport/ID scans, signatures, or raw legal originals. If the form contains weird internal labels or jokes, preserve the underlying fact but avoid copying wording that is not useful future context.
