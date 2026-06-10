# PR draft — Patch #6: subagent auth honors gbrain config

## Summary
- Make the Anthropic-direct subagent handler resolve API keys the same way the gateway does: `ANTHROPIC_API_KEY` first, then `gbrain config set anthropic_api_key ...`.
- Pass the resolved key into the SDK constructor for the default `sdk.messages` client path.
- Keep the existing clear no-key failure shape when both env and config are absent.

## Why
The attempt-2/attempt-3 dream-cycle receipts showed synthesize children failing under launchd/MCP-style environments where shell env was absent even though `anthropic_api_key` was configured in gbrain. The gateway path already honored config; the legacy Anthropic-direct subagent loop did not.

## Tests
- `bun test test/subagent-handler.test.ts`

## Notes
No wrapper changes in this PR. Production activation should be done by pointing the wrapper at this carried branch after review.
