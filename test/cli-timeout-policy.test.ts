import { describe, test, expect } from 'bun:test';
import {
  readOnlyCommandDefaultTimeoutMs,
  resolveReadOnlyCommandTimeoutMs,
} from '../src/core/cli-timeout-policy.ts';

describe('CLI read-only timeout policy', () => {
  test('applies defaults only to commands supported by the read-only dispatcher', () => {
    expect(readOnlyCommandDefaultTimeoutMs('search', ['foo'])).toBe(30_000);
    expect(readOnlyCommandDefaultTimeoutMs('sources', [])).toBe(10_000);
    expect(readOnlyCommandDefaultTimeoutMs('sources', ['list'])).toBe(10_000);
  });

  test('does not make user --timeout route non-read-only commands through read-only dispatch', () => {
    expect(resolveReadOnlyCommandTimeoutMs('jobs', ['stats', '--json'], 60_000)).toBeNull();
    expect(resolveReadOnlyCommandTimeoutMs('doctor', ['--locks'], 60_000)).toBeNull();
    expect(resolveReadOnlyCommandTimeoutMs('timeline-add', ['projects/x', '2026-06-06', 'note'], 60_000)).toBeNull();
  });

  test('user --timeout overrides read-only defaults when the wrapper applies', () => {
    expect(resolveReadOnlyCommandTimeoutMs('search', ['foo'], 5_000)).toBe(5_000);
    expect(resolveReadOnlyCommandTimeoutMs('sources', ['list'], 7_000)).toBe(7_000);
  });
});
