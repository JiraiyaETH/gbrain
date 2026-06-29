# Twitter/X archive mining pattern

Use this when Jiraiya drops a large Twitter/X archive zip and asks to mine it into Brain material.

## Core rule
Do not crawl or ingest the 1GB archive raw. Treat it as immutable source evidence, then normalize, packetize, review, and write only distilled high-signal derivatives into the active Brain schema.

## Proven workflow from 2026-06-27

1. **Move raw archive out of Desktop**
   - Store under `/Users/jarvis/data/twitter-archive/` or another allow-listed data root.
   - Set owner-only permissions (`chmod 600` for zip, `700` for directories).
   - Record SHA-256 and byte size.

2. **Allow-list the scan root**
   - Add the dedicated source folder, not a broad home/Desktop path, to `archive-crawler.scan_paths` in the relevant `gbrain.yml`.
   - Keep scan paths narrow: e.g. `/Users/jarvis/data/twitter-archive`.

3. **Inspect the zip structure before extraction**
   - Twitter archive gold is mostly `data/*.js`, not media/assets.
   - High-value files seen in this archive:
     - `data/tweets.js`
     - `data/like.js`
     - `data/direct-messages.js`
     - `data/direct-messages-group.js`
     - `data/follower.js`
     - `data/following.js`
     - `data/tweet-headers.js`
     - `data/deleted-tweets.js`
   - Avoid blind OCR/vision over media. Build a media manifest first.

4. **Normalize Twitter JS wrappers to JSONL**
   - Strip `window.YTD.<name>.part0 =` wrappers.
   - Produce focused tables under `normalized/jsonl/`:
     - `tweets.jsonl`
     - `likes.jsonl`
     - `direct_messages.jsonl`
     - `direct_messages_group.jsonl`
     - `followers.jsonl`
     - `following.jsonl`
     - `media_manifest.jsonl`
   - Validate every output JSONL parses.

5. **Create reports and mining queues**
   - Inventory report: counts, top mentions, top hashtags, top DM conversations, date ranges.
   - Review packets, not blind ingestion:
     - public gold packet
     - market theses / education threads
     - Tailored proof and positioning
     - founder/operator lessons
     - high-engagement public proof
     - early crypto legacy arc
     - likes/taste graph
     - private DM relationship candidates
     - media follow-up manifest
   - Keep private DMs out of public Markdown packets where possible; exact text can remain in local owner-only JSONL for gated review.

6. **Brain ingestion mapping**
   - First create a `sources/<archive-slug>.md` manifest with checksum, paths, counts, packet map, privacy policy, and ingestion policy.
   - Do not create one page per tweet/like/DM/follower/media item.
   - Read the active Brain resolver/schema before page creation. Jiraiya’s Brain currently maps Garry-style “original thinking” without an `originals/` shelf:
     - authored public prose/tweets worth preserving -> `writing/`
     - teachable reusable framework -> `concepts/`
     - buildable possibility -> `ideas/`
     - smaller standalone insight/memo -> `notes/`
   - Person/company signals update `people/` and `companies/` after brain-first lookup and notability checks.
   - DMs are relationship/deal intelligence, not raw import.
   - Likes are taste/attention evidence, not endorsement.

## Verification checklist
- Raw zip exists under the data root, not Desktop.
- Raw zip SHA-256 and size are recorded.
- Normalized folder and outputs are owner-only.
- Every JSONL parses.
- Packet map exists and names each packet’s purpose/visibility.
- Source manifest exists in Brain and cites local paths/checksum.
- No blind Brain ingest has happened.
- Any subsequent Brain writes cite full X URLs for public tweets when available, or local archive packet/conversation IDs for private/archive-only evidence.
