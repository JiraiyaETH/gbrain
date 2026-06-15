/**
 * Unit tests for the patterns phase (v0.21).
 *
 * The phase invokes a subagent and queues real Minions work, so this
 * file leans on structural assertions over the source + prompt-builder
 * tests. Full LLM behavior is exercised by E2E tests in test/e2e/.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { buildPatternsPrompt } from '../src/core/cycle/patterns.ts';
import type { DreamFilingConfig } from '../src/core/cycle/dream-filing.ts';

const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf-8',
);

describe('patterns phase wiring', () => {
  test('imports queue + waitForCompletion + types', () => {
    expect(patternsSrc).toContain('import { MinionQueue }');
    expect(patternsSrc).toContain('waitForCompletion');
    expect(patternsSrc).toContain('SubagentHandlerData');
  });

  test('threads allowed_slug_prefixes from shared dream filing config', () => {
    expect(patternsSrc).toContain('allowed_slug_prefixes');
    expect(patternsSrc).toContain('loadDreamFilingConfig');
    expect(patternsSrc).not.toContain('async function loadAllowedSlugPrefixes');
  });

  test('reads min_evidence + lookback_days config', () => {
    expect(patternsSrc).toContain('dream.patterns.min_evidence');
    expect(patternsSrc).toContain('dream.patterns.lookback_days');
  });

  test('uses subagent_tool_executions for slug provenance (Codex #2 fix)', () => {
    expect(patternsSrc).toContain('subagent_tool_executions');
    expect(patternsSrc).toContain("tool_name = 'brain_put_page'");
  });

  test('skips when ANTHROPIC_API_KEY missing', () => {
    expect(patternsSrc).toContain('ANTHROPIC_API_KEY');
    expect(patternsSrc).toContain('no_api_key');
  });

  test('skips when reflections below min_evidence', () => {
    expect(patternsSrc).toContain('insufficient_evidence');
  });

  test('reverse-writes pages to disk via serializeMarkdown', () => {
    expect(patternsSrc).toContain('serializeMarkdown');
    expect(patternsSrc).toContain('writeFileSync');
  });

  test('runs after extract — queries fresh graph', () => {
    // Documented invariant: pattern phase MUST run after extract.
    // The cycle.ts dispatcher enforces order; this just confirms the
    // patterns module doesn't try to compute its own auto-link layer
    // (which would be a subtle regression).
    expect(patternsSrc).not.toContain('runAutoLink');
    expect(patternsSrc).not.toContain('extractPageLinks(');
  });

  test('does NOT use raw_data table (Codex #3 fix)', () => {
    expect(patternsSrc).not.toContain('putRawData');
    expect(patternsSrc).not.toContain('getRawData');
  });
});

describe('patterns scope filter', () => {
  test('filters reflections by configured parameterized prefixes, not hardcoded wiki path', () => {
    expect(patternsSrc).toContain('reflectionQueryPrefixes');
    expect(patternsSrc).toContain('sqlLikeFromPrefix');
    expect(patternsSrc).toContain('slug LIKE $');
    expect(patternsSrc).toContain('AND NOT');
    expect(patternsSrc).not.toContain("slug LIKE 'wiki/personal/reflections/%'");
  });

  test('orders by updated_at DESC for recency-bias', () => {
    expect(patternsSrc).toContain('ORDER BY updated_at DESC');
  });

  test('caps gather to 100 reflections (cost control)', () => {
    expect(patternsSrc).toContain('LIMIT 100');
  });
});

describe('buildPatternsPrompt — filing routes', () => {
  const jarvisFiling: DreamFilingConfig = {
    allowedSlugPrefixes: ['reflections/*', 'ideas/*', 'people/*', 'dream-cycles/*'],
    routes: {
      reflection: 'reflections/{date}-{topic}',
      original: 'ideas/{date}-{topic}',
      pattern: 'reflections/patterns/{topic}',
      cycleSummary: 'dream-cycles/{date}',
    },
    reflectionQueryPrefixes: ['reflections/'],
    patternQueryPrefixes: ['reflections/patterns/'],
  };

  const reflections = [
    { slug: 'reflections/2026-06-15-one', title: 'One', excerpt: 'a' },
    { slug: 'reflections/2026-06-15-two', title: 'Two', excerpt: 'b' },
    { slug: 'reflections/2026-06-15-three', title: 'Three', excerpt: 'c' },
  ];

  test('uses Jarvis-native reflection citations and pattern route', () => {
    const prompt = buildPatternsPrompt(reflections, 3, jarvisFiling);

    expect(prompt).toContain('[[reflections/...]]');
    expect(prompt).toContain('Pattern slug format: `reflections/patterns/<topic-slug>`');
    expect(prompt).toContain('Anything outside reflections/patterns/.');
    expect(prompt).not.toContain('wiki/personal/patterns/');
    expect(prompt).not.toContain('wiki/personal/reflections/');
  });

  test('legacy filing config preserves upstream wiki prompt surface', () => {
    const prompt = buildPatternsPrompt(reflections, 3, {
      allowedSlugPrefixes: ['wiki/personal/reflections/*', 'wiki/originals/*', 'wiki/personal/patterns/*'],
      routes: {
        reflection: 'wiki/personal/reflections/{date}-{topic}-{hash}',
        original: 'wiki/originals/ideas/{date}-{topic}-{hash}',
        pattern: 'wiki/personal/patterns/{topic}',
        cycleSummary: 'wiki/personal/dream-cycles/{date}',
      },
      reflectionQueryPrefixes: ['wiki/personal/reflections/'],
      patternQueryPrefixes: ['wiki/personal/patterns/'],
    });

    expect(prompt).toContain('[[wiki/personal/reflections/...]]');
    expect(prompt).toContain('Pattern slug format: `wiki/personal/patterns/<topic-slug>`');
  });
});
