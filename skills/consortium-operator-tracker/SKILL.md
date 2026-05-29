---
name: consortium-operator-tracker
version: 1.0.0
description: Use when Tailored DeFi Consortium outreach/member/vendor updates need to be applied to the Operator Friendly Google Sheet and local OpenClaw tracker state.
triggers:
  - "update the Consortium operator sheet"
  - "mark Consortium form sent"
  - "mark Consortium form filled"
  - "update Consortium Net Status"
  - "refresh Operator Friendly tab"
  - "track Consortium outreach"
  - "update the Operator Friendly tab"
  - "Consortium vendor signed"
  - "Consortium member signed"
  - "Consortium form update"
tools:
  - shell
  - read
  - write
mutating: true
metadata:
  hermes:
    tags: [tailored, consortium, google-sheets, outreach, crm, openclaw]
    related_skills: [google-workspace, brain-ops, data-research, skillify]
---

# Consortium Operator Tracker

## Overview

Use this skill for Tailored DeFi Consortium tracker updates when the user gives outreach, form, member, vendor, or Operator Friendly tab changes. It is the operating wrapper around the live Google Sheet tab plus the OpenClaw local CSV/JSON mirrors.

This skill does not treat relationship evidence as outreach permission. It updates the operator-facing tracking surface only from explicit operator instructions or verified source data.

## Source of Truth

Live sheet:

```text
https://docs.google.com/spreadsheets/d/1X3837i_Mf8UDZ91gWpBpLPr2rIB3tMgkaCxqT7vyxO4/edit
```

Primary human-facing tab:

```text
Operator Friendly
```

Canonical OpenClaw scripts:

```text
/Users/jarvis/.openclaw-jarvis-v2/ops/consortium/sync_operator_friendly_sheet.py
/Users/jarvis/.openclaw-jarvis-v2/ops/consortium/update_operator_friendly_status.py
```

Local mirrors:

```text
/Users/jarvis/.openclaw-jarvis-v2/data/prospect/defi-consortium/consortium_operator_friendly.csv
/Users/jarvis/.openclaw-jarvis-v2/data/prospect/defi-consortium/consortium_operator_friendly.json
/Users/jarvis/.openclaw-jarvis-v2/data/prospect/defi-consortium/consortium_operator_friendly_archive.csv
```

## Contract

When this skill is used, Alex must:

1. Update the **Operator Friendly** tab first; it is the team-facing view.
2. Keep the seven visible columns tight: `Protocol`, `X Handle`, `Consortium Role`, `PoC`, `Connected with`, `Outreach Status`, `Net Status`.
3. Preserve strict enum values:
   - `Consortium Role`: `Member`, `Vendor`
   - `Connected with`: `Ted`, `Nutoro`, `Alina`, `Jiraiya`
   - `Outreach Status`: `Not yet`, `Form sent`, `Form filled`
   - `Net Status`: `N/A`, `Consortium Member`, `Consortium Vendor`
4. Treat `Tailored` relationship evidence as `Jiraiya` in the visible `Connected with` field, while preserving original source evidence in hidden metadata/cell notes.
5. Never mark `Net Status = Consortium Member` or `Consortium Vendor` unless the user or a verified source explicitly says the protocol/vendor signed or agreed to work with Tailored; status-promotion commands must include an `--evidence` note.
6. Default new outreach rows to `Outreach Status = Not yet` and `Net Status = N/A`.
7. After any status update, refresh the local CSV/JSON mirror or verify that the live sheet and local mirror intentionally differ.
8. Append a status audit record for real writes; never print Google OAuth/client/refresh/access tokens. Use the OpenClaw `get-secret.sh` bridge through the scripts.
9. Keep historical backups/provenance intact unless Jiraiya explicitly orders destructive cleanup.

## When to Use

Use for requests like:

- “Ankr form sent”
- “Mark Bailsec as form filled”
- “GVRN signed as a Consortium Vendor”
- “Set Alvara to Consortium Member”
- “Refresh the Operator Friendly tab”
- “Update the Consortium sheet”
- “Move this protocol/vendor status forward”
- “Track this Consortium outreach update”
- “Fix the Operator Friendly row for X”

Do not use for:

- General Google Sheets work unrelated to the Consortium tracker — use `google-workspace`.
- Researching a new protocol/company from scratch — use `data-research`, `query`, or `enrich` first, then come back here once the row/update is known.
- Public outreach or sending forms/messages. This skill tracks status; it does not send outreach.
- Brain writes. This skill updates OpenClaw tracker state and the live Google Sheet, not Brain pages.

## Phases

### 1. Parse the operator update

Extract:

- Protocol/vendor name or canonical ID.
- Whether it is a `Member` or `Vendor` row if ambiguous.
- Desired `Outreach Status`, if present.
- Desired `Net Status`, if present.
- Evidence level: direct user instruction, verified source artifact, or ambiguous.

If the user says a vendor/member “signed,” “agreed,” “confirmed participation,” or “is in,” map it to:

- vendor row → `Net Status = Consortium Vendor`
- member row → `Net Status = Consortium Member`

If the user only says a form was sent or filled, update `Outreach Status` only. Do not infer Net Status.

### 2. Dry-run when there is ambiguity

Use the status updater in dry-run mode when protocol matching, role, or row identity might be ambiguous:

```bash
python3 /Users/jarvis/.openclaw-jarvis-v2/ops/consortium/update_operator_friendly_status.py \
  --protocol "Ankr" \
  --outreach-status "Form sent" \
  --dry-run
```

If the script returns `ambiguous`, rerun with `--canonical-id` or `--role`.

### 3. Apply status update

Use the updater for operator-owned status fields:

```bash
python3 /Users/jarvis/.openclaw-jarvis-v2/ops/consortium/update_operator_friendly_status.py \
  --protocol "Ankr" \
  --role Vendor \
  --outreach-status "Form sent"
```

Signed/agreed vendor example:

```bash
python3 /Users/jarvis/.openclaw-jarvis-v2/ops/consortium/update_operator_friendly_status.py \
  --canonical-id ankr \
  --net-status "Consortium Vendor" \
  --evidence "Jiraiya confirmed signed/agreed in Telegram YYYY-MM-DD"
```

Promoting `Net Status` to `Consortium Member` or `Consortium Vendor` without `--evidence` is a hard error. The updater writes a JSONL audit record to:

```text
/Users/jarvis/.openclaw-jarvis-v2/data/prospect/defi-consortium/consortium_operator_status_audit.jsonl
```

The updater writes the live sheet, then reruns the sync script by default so local mirrors preserve the status. Use `--no-resync` only for emergency partial writes where you will immediately reconcile manually.

### 4. Refresh from source data

When active protocol/vendor source files change, rerun the sync script:

```bash
python3 /Users/jarvis/.openclaw-jarvis-v2/ops/consortium/sync_operator_friendly_sheet.py
```

The sync preserves existing live `Outreach Status` and `Net Status` by hidden `Canonical ID`, rebuilds source-derived fields, hides metadata columns, reapplies validation, and updates local CSV/JSON mirrors.

### 5. Verify before reporting done

At minimum verify:

```bash
python3 -m py_compile \
  /Users/jarvis/.openclaw-jarvis-v2/ops/consortium/sync_operator_friendly_sheet.py \
  /Users/jarvis/.openclaw-jarvis-v2/ops/consortium/update_operator_friendly_status.py

python3 /Users/jarvis/.openclaw-jarvis-v2/ops/consortium/update_operator_friendly_status.py \
  --protocol "<name>" \
  --outreach-status "<same status>" \
  --dry-run
```

For full-tab verification, run a live read check confirming:

- row count matches local mirror;
- duplicate canonical IDs are zero;
- Tuna Chain rows are zero;
- enum values are all in the allowed sets;
- hidden metadata columns remain hidden;
- dropdown validation exists on Role / Connected with / Outreach / Net Status.

## Deterministic helper

The GBrain skill script is a non-secret command planner and validator:

```bash
bun /Users/jarvis/gbrain/skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs --sync

bun /Users/jarvis/gbrain/skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs \
  --update --protocol Ankr --outreach-status "Form sent" --dry-run

bun /Users/jarvis/gbrain/skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs \
  --update --canonical-id ankr --net-status "Consortium Vendor" \
  --evidence "Jiraiya confirmed signed/agreed in Telegram YYYY-MM-DD"
```

It prints the exact argv OpenClaw command by default. Add `--exec` only when you intend to run the mutating command.

## Status Mapping

Use literal values only.

- “not contacted”, “not yet sent”, “still untouched” → `Outreach Status = Not yet`
- “form sent”, “sent form”, “invite sent” → `Outreach Status = Form sent`
- “form filled”, “submitted form”, “completed form” → `Outreach Status = Form filled`
- “signed as member”, “agreed as member”, “confirmed member” → `Net Status = Consortium Member`
- “signed as vendor”, “agreed as vendor”, “confirmed vendor” → `Net Status = Consortium Vendor`
- candidate, warm, selected, connected, intro available, former client, or relationship evidence only → `Net Status = N/A`

## Output Format

Report compactly:

```text
Updated Operator Friendly.
Row: <Protocol> / <Role>
Outreach Status: <old> → <new>  # if changed
Net Status: <old> → <new>        # if changed
Verification: live row read back, local mirror refreshed, enum check clean.
```

If blocked:

```text
Blocked: <reason>
Needed: <canonical ID / role / signed evidence / source file>
Safe default: no status change applied.
```

## Common Pitfalls

1. **Overstating Net Status.** `selected_service_provider`, `protocol_member_candidate`, and “warm” do not mean signed/agreed. Keep `N/A` until explicit confirmation.
2. **Letting “Tailored” leak into the visible operator column.** Operator-facing values must be human names only.
3. **Updating only the live sheet.** Rerun sync or update local mirrors immediately so future refreshes preserve status.
4. **Using relationship-owner evidence as outreach permission.** `connected_with` says who has relationship evidence, not whether we may contact them.
5. **Breaking hidden metadata.** Columns H:L are sync metadata; hide them again after any sheet rebuild.
6. **Losing operator statuses on purge/source removal.** If a removed row has meaningful status, preserve it in the archive path instead of silently deleting it.
7. **Printing secrets while debugging Google Sheets.** Use the provided scripts; never print OAuth blobs or access tokens.

## Verification Checklist

- [ ] Relevant Brain/OpenClaw/source context inspected if the update depends on more than a direct user instruction.
- [ ] Row identity resolved by exact protocol or canonical ID; ambiguity handled with `--role` or `--canonical-id`.
- [ ] Only allowed enum values used.
- [ ] Net Status promoted only with explicit signed/agreed/member/vendor evidence and a non-empty `--evidence` note.
- [ ] Live `Operator Friendly` tab updated or safely left untouched.
- [ ] Audit JSONL appended for real status writes.
- [ ] Local CSV/JSON mirror refreshed or deliberate divergence documented.
- [ ] No duplicate canonical IDs, no Tuna Chain rows, no invalid operators/statuses.
- [ ] Final reply names the row, old→new status, and verification proof.
