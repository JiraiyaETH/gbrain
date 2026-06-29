# Twitter/X Archive Mining — normalization-first workflow

Use when Jiraiya drops a Twitter/X archive zip and asks to mine it for Brain-worthy material.

## Core lesson

Do **not** crawl or ingest the raw ~1GB archive directly. Twitter archives are mostly media assets, emoji/UI scaffolding, and JS wrappers. Mine them in stages:

1. Move the zip into a dedicated data folder, e.g. `/Users/jarvis/data/twitter-archive/`, and lock it owner-only (`chmod 600` for zip, `700` for dirs).
2. Add only that dedicated folder to `gbrain.yml` under `archive-crawler.scan_paths:`. Do not broaden the allow-list to Desktop/Downloads/home.
3. Inspect the zip manifest first: file count, uncompressed size, top directories, `data/*.js` payloads.
4. Extract/parse structured `data/*.js` payloads into normalized JSONL. Keep media in place and create a media manifest only.
5. Build review packets by lane. Do **not** write Brain pages until Jiraiya approves or asks for a specific ingest pass.

## Twitter archive parsing pattern

Archive files are JS assignments, not raw JSON:

```text
window.YTD.tweets.part0 = [ ... ]
window.YTD.like.part0 = [ ... ]
window.YTD.direct_messages.part0 = [ ... ]
```

Parser pattern:

```python
raw = z.read(name).decode('utf-8', 'replace')
payload = raw.split('=', 1)[1].strip()
if payload.endswith(';'):
    payload = payload[:-1].strip()
obj = json.loads(payload)
```

Important files observed in a standard archive:

- `data/tweets.js` — user's public tweets/replies/threads.
- `data/like.js` — liked tweet text + status URL; often lacks clean author metadata.
- `data/direct-messages.js` and `data/direct-messages-group.js` — private messages; gate hard.
- `data/follower.js`, `data/following.js` — account-id graph, useful as context but thin alone.
- `data/tweet-headers.js` — tweet ids/date/user id.
- `data/deleted-tweets.js` — tiny but high-interest.
- `data/profile.js`, `data/account.js`, `data/screen-name-change.js` — identity metadata. Avoid printing email/phone fields in chat.
- media folders — create a manifest; do not OCR/vision-scan blindly.

## Normalized output shape

Write under:

```text
/Users/jarvis/data/twitter-archive/normalized/
  jsonl/
  reports/
  review-packets/
```

Recommended JSONL datasets:

- `tweets.jsonl`
- `deleted_tweets.jsonl`
- `likes.jsonl`
- `direct_messages.jsonl`
- `direct_messages_group.jsonl`
- `followers.jsonl`
- `following.jsonl`
- `media_manifest.jsonl`
- candidate queues such as:
  - `candidate_original_tweets.jsonl`
  - `candidate_business_tweets.jsonl`
  - `high_signal_public_tweets.jsonl`
  - `candidate_business_dms.jsonl`

Lock outputs owner-only because DMs are present:

```bash
chmod -R go-rwx /Users/jarvis/data/twitter-archive/normalized
```

## Review-packet lanes

Packet the archive into class-level lanes, not one giant list:

1. **Gold review packet** — diversified public candidates across originals/writing, operator lessons, market theses, Tailored positioning, proof-of-work, origin story.
2. **Market theses + education threads** — durable crypto/market/DeFi explainers.
3. **Tailored agency proof + positioning** — campaign proof, public credibility, distribution language.
4. **Founder/operator/personal lessons** — first-person operating principles and life/work lessons.
5. **High-engagement public proof** — giveaway-filtered public posts that resonated.
6. **Early crypto legacy arc** — 2021–2022 DeFi/NFT/node era and cycle scars.
7. **Taste map / likes / attention graph** — aggregate themes and recurring handles; never treat liked tweets as Jiraiya's own writing.
8. **Private DM business/relationship candidates** — Markdown should redact message text; exact text stays local JSONL for gated review.
9. **Media follow-up manifest** — paths/sizes only; inspect media only when a text item points to it.

## Scoring heuristics that worked

For public tweets, reward:

- first-person thinking: `I think`, `I believe`, `I learned`, `my highest conviction`, `one thing`, `the way`;
- long explanatory text and detected threads;
- durable terms: thesis, conviction, cycle, narrative, tokenomics, utility, sustainability;
- Tailored/business terms: agency, client, campaign, marketing, distribution, creator, KOL, brand, positioning, fundraise, curator;
- engagement, after filtering obvious giveaway mechanics.

Deprioritize or filter:

- retweets;
- obvious giveaway mechanics (`giveaway`, `whitelist`, `to enter`, `follow`, `RT`, `tag friends`, `winner`);
- likes as direct source material;
- DMs in user-visible Markdown.

## Archive-crawler status artifact

For each run, create/update a local status report under normalized reports, e.g.:

```text
/Users/jarvis/data/twitter-archive/normalized/reports/archive_crawl_status.md
```

Include:

- source zip path and checksum;
- normalized corpus path;
- safety/permission state;
- dataset counts;
- packet list and status;
- next action.

This acts as the manifest when Brain write-back is not yet approved. If/when writing to Brain, reconcile with existing concepts/projects before creating pages, preserve exact source text, and cite the X URL or archive file path.

## Brain ingest pattern from Packet 001 pilot

When Jiraiya asks to start mining, do **not** jump from packets straight into mass writes. Build a small proposed-ingest report first, then write a selective pilot.

Recommended pilot shape:

1. **Source manifest:** create/update one `sources/<archive-slug>.md` page with raw zip path, normalized path, checksum, counts, packet map, privacy posture, and current ingest status. Keep the raw archive local under `/Users/jarvis/data/...`; do not dump it into Brain.
2. **Historical authored posts:** write only a few strong voice/style samples to the active authored-prose shelf. In Jiraiya's current brain this is `writing/`, not `originals/`. Keep frontmatter lean and put the retrieval warning in the body:

   ```markdown
   **Retrieval note:** Historical artifact. Use for Jiraiya's old CT voice, cadence, examples, and thesis evolution; do not overweight as current conviction.
   ```

   Do **not** use inert custom frontmatter such as `retrieval_role`, `retrieval_weight`, `source_platform`, `source_url`, `tweet_id`, or `source_manifest` for this. Frontmatter is mostly stripped from retrieval; the body note is what search/query can actually see.
3. **Durable knowledge:** distill the real retrieval load into `concepts/` pages. Use the old tweet/thread as cited evidence in the body, not as frontmatter sludge.
4. **Small phrases/lessons:** use `notes/` for compact standalone insights that are useful but not teachable frameworks.
5. **Company/person signals:** patch existing `companies/` / `people/` timelines after brain-first lookup; avoid creating pages for every handle or every mention.
6. **Private DMs:** keep out of Markdown review packets by default; only ingest as relationship/deal intelligence with exact quotes when business-critical.

Lean frontmatter fields that worked for Twitter-derived pages:

```yaml
type: writing | concept | note | company | source
title: Human Readable Title
id: x-tweet-<id>              # only for source/writing pages where stable external dedupe helps
published: 'YYYY-MM-DD'      # only when the source date is semantically useful
aliases: [search phrase, handle/name variant]
tags: [twitter-archive, compact-topic-filter]
```

All provenance that needs to be searchable belongs in the body as citations, e.g. `[Source: X/@JiraiyaReal tweet, topic, YYYY-MM-DD](https://x.com/JiraiyaReal/status/<id>)`.

Post-`gbrain put` pitfall: local write-through can add `ingested_via`, `ingested_at`, and `source_kind` fields. If the user wants lean frontmatter, run a targeted tidy pass after `put`, validate with `gbrain frontmatter validate`, then sync/commit.

This captures Jiraiya's preference from the Twitter archive pilot: old writing should provide enough examples for voice/style, but must not overweight retrieval because much of it is historical artifact.
