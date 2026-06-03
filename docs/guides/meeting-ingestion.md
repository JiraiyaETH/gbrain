# Meeting Ingestion

## Goal
Meeting transcripts become brain pages that update every mentioned entity -- attendees, companies, deals, and action items all propagated in one pass.

## What the User Gets
Without this: meetings vanish into memory, action items are forgotten, and the agent has no idea what was discussed last time you met someone. With this: every meeting is a permanent record that enriches every person and company page it touches, and the user walks into every follow-up already briefed.

## Implementation

```
on new_meeting_transcript(meeting):
    # Step 1: Pull the COMPLETE transcript -- NOT the AI summary
    #   AI summaries hallucinate framing ("it was agreed that...")
    #   The transcript is ground truth
    transcript = fetch_full_transcript(meeting.id)  # e.g., Circleback API
    # Must have speaker diarization: WHO said WHAT

    # Step 2: Create the meeting page
    slug = f"meetings/{meeting.date}-{short_description}"
    compiled_truth = agent_analysis(transcript):
        # Above the bar: agent's OWN analysis, not a generic recap
        #   - Reframe through the user's priorities
        #   - Flag surprises, contradictions, implications
        #   - Name real decisions (not performative ones)
        #   - Call out what was left unsaid or unresolved
    timeline = format_diarized_transcript(transcript)
        # Below the bar: full transcript, append-only
        #   Format: **Speaker** (HH:MM:SS): Words.

    gbrain put <slug> --content "<compiled_truth>\n---\n<timeline>"

    # Step 3: Propagate to ALL entity pages (MANDATORY -- most agents skip this)
    for person in meeting.attendees + meeting.mentioned_people:
        gbrain add_timeline_entry <person_slug> \
            --entry "Met in '{meeting.title}' on {date}. Key points: ..." \
            --source "Meeting notes '{meeting.title}', {date}"
        # Update their State section if new information surfaced
        # Update company pages for each person's company if relevant

    for company in meeting.mentioned_companies:
        gbrain add_timeline_entry <company_slug> \
            --entry "Discussed in '{meeting.title}': {what_was_said}" \
            --source "Meeting notes '{meeting.title}', {date}"

    # Step 4: Extract action items
    action_items = extract_action_items(transcript)
    # Add to task list with owner attribution

    # Step 5: Back-link everything (bidirectional graph)
    for entity in all_entities_mentioned:
        gbrain add_link <slug> <entity_slug>   # meeting -> entity
        gbrain add_link <entity_slug> <slug>    # entity -> meeting

    # Step 6: Sync so new pages are immediately searchable
    gbrain sync

# Schedule: cron 3x/day (10 AM, 4 PM, 9 PM) to catch new meetings
# Source: Circleback (https://circleback.ai) or any service with
#         speaker diarization + API/webhook access
```

## Tricky Spots

1. **Always pull the COMPLETE transcript, never the AI summary.** AI summaries hallucinate framing -- they editorialize what was "agreed" or "decided" when no such agreement happened. The diarized transcript is ground truth.
2. **Entity propagation is the step most agents skip.** A meeting is NOT fully ingested until every attendee's page, every mentioned person's page, and every company's page has a new timeline entry. The meeting page alone is useless without propagation.
3. **Mentioned people are not just attendees.** If the meeting discussed "Sarah's team at Brex," then Sarah's page AND Brex's page need updates -- even though Sarah wasn't in the room.
4. **The agent's analysis is the value, not a summary.** "They discussed Q2 targets" is worthless. "Pedro pushed back on the burn rate, Diana didn't commit to the timeline, and nobody addressed the pricing gap" is useful.
5. **Back-links must be bidirectional.** The meeting page links to attendee pages AND attendee pages link back to the meeting. The graph is bidirectional. Always.

## Neutral Provider Foundation

`src/core/meeting-intelligence/` is the deterministic foundation for provider-neutral meeting intake. Fireflies, Circleback, and future services are adapters that normalize provider payloads into the same meeting record; they are not the canonical owner.

The foundation models long-lived runtime state separately from Brain pages:

- Runtime/source ledger: `$HOME/data/meeting-intelligence/meeting-intelligence.db` in a live deployment.
- Run receipts and operator audits: `$HOME/ops/meeting-intelligence/` in a live deployment.
- Durable knowledge: GBrain default source pages under `meetings/`, plus later evidence-gated propagation to `people/` and `companies/`.

The first implementation slice is temp-only: synthetic provider payloads render deterministic full-transcript meeting pages and audit JSON under a caller-approved dry-run root. It does not call provider APIs, does not enable a scheduler, and does not mutate a live GBrain corpus.

## Live-Wiring Candidate Flow

The live-wiring candidate keeps Fireflies as an adapter around the provider-neutral core:

1. Adapter fetch boundary: `createFirefliesProviderAdapter({ mode: 'fixture' })` is the default test/dry-run path. `mode: 'live'` refuses until explicit rollout approval, a valid credential shape, and an injected approved fetch implementation are present. Refusal messages do not print credential values.
2. Normalization: Fireflies payloads become `NormalizedProviderMeeting` records with a full diarized transcript checksum and source checksum.
3. Ledger reconciliation: `buildMeetingRuntimeRun()` compares provider id + transcript checksum against existing ledgers to classify insert, noop, update, or duplicate without inferring state from files.
4. Default-source page plan: every full-transcript page write candidate includes `gbrain put <slug> --source default` and rejects ambient or non-default source routing.
5. Enrichment and review: generated provider summaries/action items enqueue evidence-gated enrichment and produce review receipts. No generated hint becomes a durable assignment, fact, commitment, commercial term, pricing term, or legal claim without transcript or human-note evidence.
6. Audit receipt: dry-runs and live plans carry `live_provider_calls=0` and `live_gbrain_writes=0` unless the operator approves the final live rollout and supplies the side-effect implementations.

Dry-run operator surface:

```bash
gbrain meeting-intelligence dry-run \
  --fixture test/fixtures/meeting-intelligence/fireflies-completed.synthetic.json \
  --out .hermes/proofs/neutral-meeting-intelligence/live-wiring-dry-run \
  --allow-root .hermes/proofs/neutral-meeting-intelligence/live-wiring-dry-run \
  --include-duplicates \
  --json
```

This writes deterministic page, audit, ledger, review, receipt, and summary artifacts under the approved proof root only.

Neutral runtime paths for an approved rollout:

- Runtime/source ledger: `/Users/jarvis/data/meeting-intelligence/meeting-intelligence.db`.
- Run receipts and operator audits: `/Users/jarvis/ops/meeting-intelligence/`.
- Durable knowledge: GBrain source `default`, meeting pages under `meetings/`.

Fallback repair sweep model:

- Stale `received` ledgers become `fetch_full_transcript` candidates.
- Stale `transcript_ready` or `page_rendered` ledgers become `render_or_write_page` candidates.
- Stale `enrichment_pending` ledgers become `reconcile_enrichment` candidates.
- `review_queued` ledgers wait for human review.
- No scheduler or poller is enabled by default; live scheduling remains a separate approval gate.

Safety rules:

- Normal write intent is explicit default-source semantics; use `--source default` when a CLI caller could inherit ambient source state, and never use legacy/non-default meeting-page source flags.
- Generated provider summaries and action items are review hints only. They cannot become assignments, commitments, ownership changes, pricing/legal/commercial facts, or durable entity truth without transcript or human-note evidence.
- Rendered pages must include the full diarized transcript, not just a compact provider packet.
- Signed URLs, token-looking strings, connection strings, wallet/payment-looking strings, and payment-card-looking values must be redacted before pages or audits are written.

## How to Verify

1. After ingesting a meeting, run `gbrain get meetings/{date}-{slug}`. Confirm the page has the agent's analysis above the bar and the full diarized transcript below it.
2. For each attendee, run `gbrain get <attendee_slug>`. Check that their timeline has a new entry referencing the meeting with specific insights (not just "attended meeting").
3. Pick a company mentioned in the meeting. Run `gbrain get <company_slug>`. Confirm a timeline entry exists referencing what was discussed about the company.
4. Run `gbrain get_links meetings/{date}-{slug}`. Verify back-links exist to all attendee and entity pages.
5. Run `gbrain search "{meeting_topic}"`. Confirm the meeting page appears in search results (verifies sync ran).

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
