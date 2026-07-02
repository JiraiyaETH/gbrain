import { describe, test, expect } from 'bun:test';
import { __testing as patternsTesting } from '../src/core/cycle/patterns.ts';
import {
  DEFAULT_DREAM_SYNTHESIZE_ROUTES,
  type DreamSynthesizeRoutes,
} from '../src/core/cycle/synthesize.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const reflections = [
  {
    slug: 'wiki/personal/reflections/2026-04-25-same-loop-abc123',
    title: 'Same loop',
    excerpt: 'A recurring pattern about overloading the week.',
  },
  {
    slug: 'wiki/personal/reflections/2026-04-26-same-loop-def456',
    title: 'Same loop again',
    excerpt: 'Another instance of the same planning loop.',
  },
];

describe('dream patterns route templates', () => {
  test('falls back to legacy wiki paths when routes are absent', () => {
    const reflectionPrefix = patternsTesting.deriveDreamRouteLikePrefix(
      DEFAULT_DREAM_SYNTHESIZE_ROUTES.reflection,
      'wiki/personal/reflections/%',
    );
    const prompt = patternsTesting.buildPatternsPrompt(
      reflections,
      3,
      DEFAULT_DREAM_SYNTHESIZE_ROUTES,
      reflectionPrefix,
    );

    expect(reflectionPrefix).toBe('wiki/personal/reflections/%');
    expect(prompt).toContain('[[wiki/personal/reflections/...]]');
    expect(prompt).toContain('`wiki/personal/patterns/<topic-slug>`');
    expect(prompt).toContain('Anything outside wiki/personal/patterns/...');
  });

  test('custom routes override both the read prefix and prompt write template', async () => {
    const routes: DreamSynthesizeRoutes = {
      reflection: 'personal/reflections/{date}-<topic-slug>-{hash}',
      original: 'ideas/{date}-<idea-slug>-{hash}',
      pattern: 'personal/patterns/<topic-slug>',
    };
    const reflectionPrefix = patternsTesting.deriveDreamRouteLikePrefix(
      routes.reflection,
      'wiki/personal/reflections/%',
    );
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const engine = {
      executeRaw: async <T,>(sql: string, params?: unknown[]): Promise<T[]> => {
        calls.push({ sql, params });
        return [] as T[];
      },
    } as unknown as BrainEngine;

    await patternsTesting.gatherReflections(engine, 30, reflectionPrefix);
    const prompt = patternsTesting.buildPatternsPrompt(reflections, 3, routes, reflectionPrefix);

    expect(reflectionPrefix).toBe('personal/reflections/%');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('slug LIKE $2');
    expect(calls[0].params?.[1]).toBe('personal/reflections/%');
    expect(prompt).toContain('[[personal/reflections/...]]');
    expect(prompt).toContain('`personal/patterns/<topic-slug>`');
    expect(prompt).not.toContain('wiki/personal/reflections/...');
    expect(prompt).not.toContain('wiki/personal/patterns/<topic-slug>');
  });

  test('prefix derivation handles brace and angle placeholder styles', () => {
    expect(patternsTesting.deriveDreamRouteLikePrefix(
      'personal/reflections/{date}-<topic-slug>-{hash}',
      'wiki/personal/reflections/%',
    )).toBe('personal/reflections/%');
    expect(patternsTesting.deriveDreamRouteLikePrefix(
      'personal/reflections/<topic-slug>',
      'wiki/personal/reflections/%',
    )).toBe('personal/reflections/%');
    expect(patternsTesting.deriveDreamRouteLikePrefix(
      'personal/reflections/static-{hash}',
      'wiki/personal/reflections/%',
    )).toBe('personal/reflections/%');
  });
});
