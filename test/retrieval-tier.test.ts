import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_HARD_EXCLUDES,
  DEFAULT_SOURCE_BOOSTS,
  resolveHardExcludes,
} from '../src/core/search/source-boost.ts';
import { getRetrievalTierForSlug } from '../src/core/search/retrieval-tier.ts';

describe('default Brain retrieval tiers', () => {
  test('owner-shaped compiled-truth paths resolve to T1', () => {
    const t1Slugs = [
      'companies/acme-example',
      'clients/alice-example',
      'people/alice-example',
      'concepts/gbrain',
      'decisions/default-source-promotion',
      'capabilities/meeting-to-brain',
      'projects/default-source-audit',
      'lessons/source-boundaries',
    ];

    for (const slug of t1Slugs) {
      expect(getRetrievalTierForSlug(slug)).toBe('T1');
    }
  });

  test('context, evidence, and quarantine paths resolve to lower tiers', () => {
    expect(getRetrievalTierForSlug('meetings/fireflies/2026-05-25-gbrain')).toBe('T2');
    expect(getRetrievalTierForSlug('inbox/2026-05-25-jiraiya-note')).toBe('T2');
    expect(getRetrievalTierForSlug('references/source-hygiene')).toBe('T2');
    expect(getRetrievalTierForSlug('sources/google-docs/packet')).toBe('T3');
    expect(getRetrievalTierForSlug('_quarantine/broken-import')).toBe('T4');
    expect(getRetrievalTierForSlug('quarantine/broken-import')).toBe('T4');
  });

  test('default boosts and excludes encode the retrieval tiers', () => {
    for (const prefix of ['companies/', 'clients/', 'people/', 'concepts/', 'decisions/', 'capabilities/', 'projects/', 'lessons/']) {
      expect(DEFAULT_SOURCE_BOOSTS[prefix]).toBeGreaterThan(1.0);
    }

    for (const prefix of ['meetings/', 'inbox/', 'references/']) {
      expect(DEFAULT_SOURCE_BOOSTS[prefix]).toBeGreaterThan(0);
      expect(DEFAULT_SOURCE_BOOSTS[prefix]).toBeLessThan(1.0);
    }

    for (const prefix of ['sources/', '_quarantine/', 'quarantine/']) {
      expect(DEFAULT_HARD_EXCLUDES).toContain(prefix);
    }
  });

  test('policy is path/shape based, not domain-keyword based', () => {
    expect(getRetrievalTierForSlug('companies/acme-example')).toBe('T1');
    expect(getRetrievalTierForSlug('clients/alice-example')).toBe('T1');
    expect(getRetrievalTierForSlug('sources/acme-example/repo-snapshot')).toBe('T3');
    expect(getRetrievalTierForSlug('meetings/acme-example/2026-05-25-growth-call')).toBe('T2');
  });

  test('evidence-only sources can be explicitly opted back into search', () => {
    const defaults = resolveHardExcludes(undefined, undefined, undefined);
    expect(defaults).toContain('sources/');

    const optedIn = resolveHardExcludes(undefined, ['sources/'], undefined);
    expect(optedIn).not.toContain('sources/');
    expect(optedIn).toContain('_quarantine/');
  });
});
