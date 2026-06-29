# Twitter archive → Brain ingestion pattern

Use this when a large personal Twitter/X archive needs to become useful Brain material without polluting retrieval.

## Core shape

Do **not** ingest a Twitter archive as one page per tweet/DM/like. Treat it as:

1. **Immutable raw source** — keep the ZIP and normalized JSONL outside the Brain, under a private data path.
2. **Normalized corpus** — extract structured `data/*.js` payloads into focused JSONL datasets: tweets, likes, DMs, followers/following, media manifest.
3. **Packetized review lanes** — rank and split into distinct mining packets by future use:
   - market theses / explainers
   - company or agency proof / positioning
   - founder/operator lessons
   - high-engagement proof, with giveaway spam summarized rather than preserved one-by-one
   - historical origin arc / old voice
   - likes/taste map as aggregate attention evidence, not endorsement
   - private DMs as gated relationship intelligence, not raw pages
   - media follow-up manifest only; no blind OCR/vision
4. **Source manifests** — create Brain `sources/` pages describing archive checksum, normalized paths, packet map, privacy posture, and ingest policy.
5. **Selective distilled pages** — only high-signal items become `writing/`, `concepts/`, `notes/`, or updates to existing `companies/`/`people/` pages.

## Brain write policy

- Public authored tweet threads that preserve voice/style go to the active authored-writing shelf (`writing/` in Jiraiya’s Brain; `originals/` only if the active resolver has it).
- Durable frameworks go to `concepts/`.
- Small standalone phrases/principles go to `notes/`.
- Business proof and entity facts update existing company/person/project pages with dated timeline entries.
- DMs stay private-gated. Write only aggregate source manifests unless explicit review identifies a relationship/deal fact worth updating.
- Likes are taste/attention graph evidence, not belief or endorsement.
- Media stays as a manifest until a reviewed text item points to specific media.

## Personal voice mining

Personal voice mining is a separate pass from knowledge ingestion. Score for authorship/cadence/style, not just factual value:

- original posts and thread starters over replies/RTs/giveaways
- hook → reasoning → punchline structure
- founder/operator tone
- CT-native phrasing that still fits current use
- teaching/explainer mode
- conviction/risk framing
- relationship warmth in replies
- anti-samples: old giveaway/degen slang that should not steer future drafting

Recommended output before Brain writes:

```text
review-packets/010-personal-voice-corpus.md
review-packets/010-personal-voice-corpus.jsonl
```

Then create compact Brain artifacts:

```text
sources/twitter-archive-personal-voice-map-YYYY-MM-DD
writing/voice-ct-thread-teacher
writing/voice-founder-operator
writing/voice-tailored-positioning
writing/voice-market-conviction
writing/voice-humor-and-community
writing/voice-origin-story
writing/voice-sales-and-dm-outreach
notes/jiraiya-twitter-voice-style-guide
```

Each voice page should include exact examples, cadence notes, phrases worth preserving, anti-patterns to avoid, and citations to tweet URLs or local packet IDs.

## Frontmatter hygiene

Keep frontmatter lean because arbitrary metadata is often not useful retrieval content. Prefer:

```yaml
type: writing | concept | note | company | source
title: Human Readable Title
id: stable-external-id       # only for dedupe/idempotency
published: 'YYYY-MM-DD'     # only where source date matters
aliases: [query phrase, variant]
tags: [small, stable, filterable]
```

Move rich provenance and retrieval guidance into the body: inline citations, `**Retrieval note:** ...`, links, and timeline entries. If `gbrain put` write-through adds operational fields, run a targeted tidy pass, validate frontmatter, sync, then commit only intended files.

## Verification checklist

- JSONL parses for every generated packet.
- Source manifest exists and cites raw/local normalized paths without dumping raw data.
- Privacy posture is explicit: DMs private-gated, media not blindly inspected.
- Frontmatter validates and stays lean.
- `gbrain put`/sync succeeds.
- Representative `gbrain get` confirms pages are retrievable.
- Commit coherent phases separately and avoid absorbing unrelated dirty worktree state.
