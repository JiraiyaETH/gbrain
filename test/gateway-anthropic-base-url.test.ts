/**
 * Regression: a path-less `ANTHROPIC_BASE_URL` must not silently 404 native
 * chat.
 *
 * The `@ai-sdk/anthropic` provider reads `process.env.ANTHROPIC_BASE_URL` when
 * no explicit baseURL is passed and appends `/messages`. A value like
 * `https://api.anthropic.com` (no `/v1` — what some host apps inject) then hits
 * `https://api.anthropic.com/messages` → HTTP 404, surfaced as an opaque
 * `AIConfigError: ... Not Found`. This took down the dream verdict judge
 * (synthesize significance gate → zero pages written) whenever a run executed
 * in a shell carrying the malformed env var.
 *
 * `normalizeAnthropicBaseURL` brings a path-less host to `${origin}/v1` and
 * leaves everything else (already-versioned, custom proxy mount, empty) alone.
 */

import { describe, expect, test } from 'bun:test';
import { normalizeAnthropicBaseURL } from '../src/core/ai/gateway.ts';

describe('normalizeAnthropicBaseURL', () => {
  test('appends /v1 to a path-less host (the outage case)', () => {
    expect(normalizeAnthropicBaseURL('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1');
  });

  test('appends /v1 to a path-less host with a trailing slash', () => {
    expect(normalizeAnthropicBaseURL('https://api.anthropic.com/')).toBe('https://api.anthropic.com/v1');
  });

  test('leaves an already-versioned base URL untouched', () => {
    expect(normalizeAnthropicBaseURL('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1');
  });

  test('strips a trailing slash but keeps an existing /v1 path', () => {
    expect(normalizeAnthropicBaseURL('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com/v1');
  });

  test('respects a custom proxy mount path (does not force /v1)', () => {
    expect(normalizeAnthropicBaseURL('https://proxy.internal/anthropic')).toBe('https://proxy.internal/anthropic');
  });

  test('returns undefined for empty / whitespace input so the SDK default applies', () => {
    expect(normalizeAnthropicBaseURL(undefined)).toBeUndefined();
    expect(normalizeAnthropicBaseURL('')).toBeUndefined();
    expect(normalizeAnthropicBaseURL('   ')).toBeUndefined();
  });

  test('passes an unparseable value through untouched rather than guessing', () => {
    expect(normalizeAnthropicBaseURL('not a url')).toBe('not a url');
  });
});
