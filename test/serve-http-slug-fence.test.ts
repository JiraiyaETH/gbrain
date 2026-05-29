/**
 * Regression guard for the live OAuth HTTP MCP path.
 *
 * `gbrain serve --http` routes through src/commands/serve-http.ts, not the
 * legacy src/mcp/http-transport.ts unit-test surface. This source contract
 * keeps GBRAIN_MCP_ALLOWED_SLUG_PREFIXES wired into the production HTTP
 * dispatchToolCall path even when DATABASE_URL-backed e2e tests are skipped.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('serve-http slug-prefix fence wiring', () => {
  test('live OAuth HTTP MCP path threads GBRAIN_MCP_ALLOWED_SLUG_PREFIXES into dispatchToolCall', () => {
    const src = readFileSync('src/commands/serve-http.ts', 'utf8');

    expect(src).toMatch(/import\s*\{[^}]*\bparseMcpAllowedSlugPrefixes\b[^}]*\}\s*from\s*['"]\.\.\/mcp\/read-only\.ts['"]/);
    expect(src).toMatch(/const\s+allowedSlugPrefixes\s*=\s*parseMcpAllowedSlugPrefixes\(process\.env\)\s*\?\?\s*undefined/);
    expect(src).toMatch(/dispatchToolCall\([\s\S]*?allowedSlugPrefixes,[\s\S]*?\}\)/);
  });
});
