import { describe, expect, test } from 'bun:test';

import { __testing } from '../src/core/cycle/patterns.ts';

const { shouldSkipPatternsForMissingProviderKey } = __testing as any;

describe('patterns provider gate', () => {
  test('does not require ANTHROPIC_API_KEY for subscription-backed claude-code pattern models', () => {
    expect(typeof shouldSkipPatternsForMissingProviderKey).toBe('function');
    const skip = shouldSkipPatternsForMissingProviderKey({
      model: 'claude-code:claude-sonnet-4-6',
      env: {},
    });

    expect(skip).toBeNull();
  });

  test('still fails closed for legacy Anthropic pattern models when ANTHROPIC_API_KEY is absent', () => {
    expect(typeof shouldSkipPatternsForMissingProviderKey).toBe('function');
    const skip = shouldSkipPatternsForMissingProviderKey({
      model: 'anthropic:claude-sonnet-4-6',
      env: {},
    });

    expect(skip).toEqual({
      reason: 'no_api_key',
      summary: 'ANTHROPIC_API_KEY unset for anthropic:claude-sonnet-4-6; pattern detection skipped',
    });
  });

  test('allows legacy Anthropic pattern models when ANTHROPIC_API_KEY is present', () => {
    const skip = shouldSkipPatternsForMissingProviderKey({
      model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
    });

    expect(skip).toBeNull();
  });
});
