# Twitter/X archive staging for archive-crawler

Use when Jiraiya drops a Twitter/X archive zip for later mining.

## Safe staging pattern

1. Receive or move the archive into a dedicated operational-data folder, not Desktop:

```bash
mkdir -p /Users/jarvis/data/twitter-archive
chmod 700 /Users/jarvis/data/twitter-archive
mv <archive.zip> /Users/jarvis/data/twitter-archive/
chmod 600 /Users/jarvis/data/twitter-archive/<archive.zip>
shasum -a 256 /Users/jarvis/data/twitter-archive/<archive.zip>
```

2. Add only the dedicated folder to `archive-crawler.scan_paths` in the active `gbrain.yml`:

```yaml
archive-crawler:
  scan_paths:
    - /Users/jarvis/data/twitter-archive
```

Do not allow-list the whole home directory, whole Desktop, or broad Downloads folder.

3. Before crawling, extract to a controlled subdirectory under the same allow-listed root, e.g. `/Users/jarvis/data/twitter-archive/extracted/<archive-stem>/`, then inventory first. Do not ingest the whole zip blindly.

## Twitter archive crawl focus

Prioritize user-authored/high-signal material:

- tweet/post text and long-form note data
- replies and quote-posts that show original thinking or relationship context
- DMs only if explicitly authorized for that pass
- profile/account metadata as context, not as gold

Skip or defer media blobs, thumbnails, JS app assets, analytics boilerplate, and raw binary payloads unless the user asks for media review.

## Verification before reporting ready

Report final archive path, size, permissions, checksum, and the exact allow-listed scan path. Confirm the Desktop/source copy is gone if the user asked to move it.