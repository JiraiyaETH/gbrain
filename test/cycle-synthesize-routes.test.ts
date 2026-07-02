import { describe, test, expect } from 'bun:test';
import { __testing } from '../src/core/cycle/synthesize.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const transcript = {
  filePath: '/tmp/2026-04-25-session.txt',
  basename: '2026-04-25-session.txt',
  content: 'meaningful transcript',
  contentHash: 'abc123def456',
  inferredDate: '2026-04-25',
} as DiscoveredTranscript;

describe('dream synthesize route templates', () => {
  test('falls back to legacy wiki slug templates when routes are absent', () => {
    const prompt = __testing.buildSynthesisPrompt(
      transcript,
      transcript.content,
      0,
      1,
    );

    expect(prompt).toContain('wiki/personal/reflections/2026-04-25-<topic-slug>-abc123');
    expect(prompt).toContain('wiki/originals/ideas/2026-04-25-<idea-slug>-abc123');
  });

  test('uses filing-rule route overrides for reflection and original slugs', () => {
    const prompt = __testing.buildSynthesisPrompt(
      transcript,
      transcript.content,
      0,
      1,
      '',
      {
        reflection: 'personal/reflections/{date}-<topic-slug>-{hash}',
        original: 'ideas/{date}-<idea-slug>-{hash}',
        pattern: 'personal/patterns/<topic-slug>',
      },
    );

    expect(prompt).toContain('personal/reflections/2026-04-25-<topic-slug>-abc123');
    expect(prompt).toContain('ideas/2026-04-25-<idea-slug>-abc123');
    expect(prompt).not.toContain('wiki/personal/reflections/2026-04-25-<topic-slug>-abc123');
    expect(prompt).not.toContain('wiki/originals/ideas/2026-04-25-<idea-slug>-abc123');
  });
});
