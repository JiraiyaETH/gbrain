# Twitter/X archive normalization pattern

Use this when Jiraiya drops a Twitter/X archive zip for mining. The durable lesson: do **not** crawl or ingest the 1GB archive raw. Normalize the structured `data/*.js` payloads first, then mine ranked queues.

## Archive shape observed

Twitter archive zip usually contains:

- `data/*.js` — structured payloads with JS assignment wrappers like `window.YTD.tweets.part0 = [...]`
- `assets/` — UI assets plus media blobs
- `Your archive.html` — local browser UI shell

High-value structured files:

- `data/tweets.js` — own tweets/replies/threads
- `data/like.js` — liked tweet text/status URLs; author handles may not be cleanly recoverable, so use text/mention graph
- `data/direct-messages.js` and `data/direct-messages-group.js` — private relationship material; gated review only
- `data/follower.js`, `data/following.js` — social graph
- `data/tweet-headers.js`, `data/deleted-tweets.js`, `data/profile.js`, `data/account.js`

## Safe pipeline

1. Move the archive under an explicit allow-listed data path, e.g. `/Users/jarvis/data/twitter-archive/`, and set owner-only permissions.
2. Add only that folder to `gbrain.yml` under `archive-crawler.scan_paths:`. Do not broaden to a home/Desktop/Downloads tree.
3. Extract/parse only `data/*.js` into normalized JSONL under `normalized/jsonl/`; keep media as a manifest only.
4. Create reports under `normalized/reports/` and set the normalized tree owner-only (`700` dirs, `600` files), because DMs are present.
5. Mine in ranked queues before any Brain write:
   - `candidate_original_tweets.jsonl` — own theses, old voice, concepts, frameworks
   - `candidate_business_tweets.jsonl` — Tailored/marketing/distribution positioning
   - `high_signal_public_tweets.jsonl` — public proof-of-work and engagement, with giveaway mechanics filtered out
   - `candidate_business_dms.jsonl` — private deal/relationship material; never ingest blind
6. Present a review packet before writing Brain pages. Ingest only selected gold.

## JS wrapper parser

The common parser pattern is:

```python
raw = zipfile.ZipFile(zip_path).read("data/tweets.js").decode("utf-8", "replace")
payload = raw.split("=", 1)[1].strip()
if payload.endswith(";"):
    payload = payload[:-1].strip()
records = json.loads(payload)
```

## Queue scoring notes

- Public tweet mining should down-rank obvious growth mechanics: `giveaway`, `whitelist`, `follow`, `RT`, `tag friends`, etc.
- `like.js` often preserves text and tweet URL but not reliable author metadata; build a liked-text mention graph instead of assuming `expandedUrl` gives a clean author.
- DM mining should avoid Markdown samples with private text. Keep private text in local JSONL and summarize only after gated review.
- Media should not be OCR/vision-scanned first. Use `media_manifest.jsonl`; pull individual files only when a selected tweet/DM points to them.

## Validation checklist

- JSONL parse passes for every generated queue.
- Counts match source arrays.
- `inventory.md` records source zip path, byte size, SHA-256, counts, and outputs.
- Private outputs are owner-only.
- No Brain writes occur until the operator chooses items or approves a mining batch.
