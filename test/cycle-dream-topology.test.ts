/**
 * Regression guard for Jarvis semantic Dream topology.
 *
 * Native Dream writes must target semantic default-source routes, not Garry's
 * legacy wiki/personal layout. The filing rules are the machine-readable source
 * of truth, while synthesize/pattern prompts consume that topology.
 */

import { describe, test, expect } from 'bun:test';
import { loadAllowedSlugPrefixes, loadDreamSlugTopology } from '../src/core/cycle/dream-topology.ts';
import { __testing as synthTesting } from '../src/core/cycle/synthesize.ts';
import { __testing as patternsTesting } from '../src/core/cycle/patterns.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

describe('Dream semantic topology', () => {
  test('filing-rules allow-list uses semantic default routes only', async () => {
    const prefixes = await loadAllowedSlugPrefixes();

    expect(prefixes).toEqual(expect.arrayContaining([
      'reflections/*',
      'ideas/*',
      'patterns/*',
      'people/*',
      'projects/gbrain/dream-cycles/*',
    ]));
    expect(prefixes.some(prefix => prefix.startsWith('wiki/'))).toBe(false);
    expect(prefixes.some(prefix => prefix.includes('/personal/'))).toBe(false);
  });

  test('topology exposes semantic slug roots for prompts and summaries', async () => {
    const topology = await loadDreamSlugTopology();

    expect(topology).toMatchObject({
      reflections: 'reflections',
      originalIdeas: 'ideas',
      patterns: 'patterns',
      people: 'people',
      cycleSummaries: 'projects/gbrain/dream-cycles',
    });
  });

  test('synthesize prompt tells subagents to write semantic reflection and original slugs', async () => {
    const topology = await loadDreamSlugTopology();
    const transcript: DiscoveredTranscript = {
      filePath: '/tmp/2026-05-29-semantic.txt',
      basename: '2026-05-29-semantic',
      contentHash: 'abcdef1234567890',
      inferredDate: '2026-05-29',
      content: 'User: I am noticing a useful pattern. Agent: Good.'
    };

    const prompt = synthTesting.buildSynthesisPrompt(transcript, transcript.content, 0, 1, '', topology);

    expect(prompt).toContain('`reflections/2026-05-29-<topic-slug>-abcdef`');
    expect(prompt).toContain('`ideas/2026-05-29-<idea-slug>-abcdef`');
    expect(prompt).not.toContain('wiki/personal');
    expect(prompt).not.toContain('wiki/originals');
  });

  test('summary and pattern helpers use semantic routes', async () => {
    const topology = await loadDreamSlugTopology();

    expect(synthTesting.buildSummarySlug('2026-05-29', topology)).toBe('projects/gbrain/dream-cycles/2026-05-29');
    expect(patternsTesting.buildReflectionLikePattern(topology)).toBe('reflections/%');

    const prompt = patternsTesting.buildPatternsPrompt([
      { slug: 'reflections/2026-05-29-signal-abcdef', title: 'Signal', excerpt: 'A recurring signal.' },
      { slug: 'reflections/2026-05-28-signal-bcdefa', title: 'Signal 2', excerpt: 'The same signal again.' },
      { slug: 'reflections/2026-05-27-signal-cdefab', title: 'Signal 3', excerpt: 'The third signal.' },
    ], 3, topology);

    expect(prompt).toContain('[[reflections/2026-05-29-signal-abcdef]]');
    expect(prompt).toContain('`patterns/<topic-slug>`');
    expect(prompt).not.toContain('wiki/personal');
  });
});
