import { describe, expect, test } from 'bun:test';

import { diversifySignedRelationshipResults } from '../../src/core/search/hybrid.ts';
import type { PageType, SearchResult } from '../../src/core/types.ts';

function row(slug: string, type: PageType): SearchResult {
  return {
    slug, page_id: 1, title: slug, type, chunk_text: slug,
    chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0,
    score: 1, rerank_score: 0.5, stale: false, source_id: 'default',
  };
}

describe('signed relationship result diversity', () => {
  test('prevents a contract monoculture while preserving every deferred row', () => {
    const input = [
      ...Array.from({ length: 8 }, (_, i) => row(`contracts/c${i}`, 'contract')),
      row('companies/context', 'company'),
      row('companies/duplicate-context', 'company'),
      row('people/a', 'person'),
      row('people/b', 'person'),
      row('people/c', 'person'),
      row('projects/program', 'project'),
    ];
    const output = diversifySignedRelationshipResults(input, 10);
    expect(output).toHaveLength(input.length);
    expect(new Set(output).size).toBe(input.length);
    expect(output.slice(0, 10).filter(value => value.type === 'contract').length).toBeLessThanOrEqual(5);
    expect(output.slice(0, 10).filter(value => value.type === 'company').length).toBeLessThanOrEqual(1);
    expect(output.slice(0, 10).map(value => value.slug)).toContain('projects/program');
  });

  test('is a no-op for one-row windows', () => {
    const input = [row('contracts/only', 'contract')];
    expect(diversifySignedRelationshipResults(input, 1)).toBe(input);
  });

  test('does not promote an unscored tail over a complete scored window', () => {
    const scored = Array.from({ length: 10 }, (_, index) => ({
      ...row(`contracts/tap/scored-${index}`, 'contract'),
      rerank_score: 1 - index / 100,
    }));
    const unscoredTail = row('conversations/unscored-tail', 'conversation');
    unscoredTail.rerank_score = undefined;
    const result = diversifySignedRelationshipResults([...scored, unscoredTail], 10);
    expect(result.slice(0, 10).every(item => Number.isFinite(item.rerank_score))).toBe(true);
    expect(result[10]?.slug).toBe('conversations/unscored-tail');
  });

  test('does not promote later scores over an unscored prefix', () => {
    const unscoredHead = row('conversations/unscored-head', 'conversation');
    unscoredHead.rerank_score = undefined;
    const scoredTail = Array.from({ length: 10 }, (_, index) => ({
      ...row(`contracts/tap/later-${index}`, 'contract'),
      rerank_score: 1 - index / 100,
    }));
    const result = diversifySignedRelationshipResults([unscoredHead, ...scoredTail], 10);
    expect(result[0]?.slug).toBe('conversations/unscored-head');
  });

  test('one fixed horizon paginates without duplicates or omissions', () => {
    const input = [
      row('contracts/one', 'contract'),
      row('contracts/two', 'contract'),
      row('companies/context', 'company'),
      row('people/signer', 'person'),
    ];
    const fixedOrder = diversifySignedRelationshipResults(input, 2);
    const page1 = fixedOrder.slice(0, 2);
    const page2 = fixedOrder.slice(2, 4);
    expect(new Set([...page1, ...page2].map(item => item.slug)).size).toBe(4);
    expect([...page1, ...page2]).toEqual(fixedOrder);
  });
});
