import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEGACY_DREAM_FILING,
  loadDreamFilingConfig,
  queryPrefixFromRoute,
  renderDreamSlugTemplate,
  sqlLikeFromPrefix,
} from '../src/core/cycle/dream-filing.ts';

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-filing-'));
  mkdirSync(join(tmpDir, 'skills'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRules(dream_synthesize_paths: Record<string, unknown>): void {
  writeFileSync(
    join(tmpDir, 'skills', '_brain-filing-rules.json'),
    JSON.stringify({ dream_synthesize_paths }, null, 2),
    'utf8',
  );
}

describe('dream filing route config', () => {
  test('loads Jarvis-native route templates without requiring hash', () => {
    writeRules({
      globs: ['reflections/*', 'ideas/*', 'people/*', 'dream-cycles/*'],
      routes: {
        reflection: 'reflections/{date}-{topic}',
        original: 'ideas/{date}-{topic}',
        pattern: 'reflections/patterns/{topic}',
        cycleSummary: 'dream-cycles/{date}',
      },
      reflection_query_prefixes: ['reflections/'],
      pattern_query_prefixes: ['reflections/patterns/'],
    });

    const cfg = loadDreamFilingConfig();
    expect(cfg.allowedSlugPrefixes).toEqual(['reflections/*', 'ideas/*', 'people/*', 'dream-cycles/*']);
    expect(renderDreamSlugTemplate(cfg.routes.reflection, {
      date: '2026-06-15',
      topic: 'richmond-dream-repair',
      hash: 'abc123',
    })).toBe('reflections/2026-06-15-richmond-dream-repair');
    expect(renderDreamSlugTemplate(cfg.routes.original, {
      date: '2026-06-15',
      topic: 'filing-rules-as-routes',
      hash: 'abc123',
    })).toBe('ideas/2026-06-15-filing-rules-as-routes');
    expect(renderDreamSlugTemplate(cfg.routes.pattern, {
      date: '2026-06-15',
      topic: 'rescuer-pattern',
      hash: 'abc123',
    })).toBe('reflections/patterns/rescuer-pattern');
  });

  test('keeps legacy wiki route fallback for upstream globs-only rules', () => {
    writeRules({
      globs: [
        'wiki/personal/reflections/*',
        'wiki/originals/*',
        'wiki/personal/patterns/*',
        'wiki/personal/dream-cycles/*',
      ],
    });

    const cfg = loadDreamFilingConfig();
    expect(cfg.routes).toEqual(LEGACY_DREAM_FILING.routes);
    expect(cfg.reflectionQueryPrefixes).toEqual(['wiki/personal/reflections/']);
    expect(renderDreamSlugTemplate(cfg.routes.reflection, {
      date: '2026-06-15',
      topic: 'legacy-test',
      hash: 'abc123',
    })).toBe('wiki/personal/reflections/2026-06-15-legacy-test-abc123');
  });

  test('fails closed when configured routes are outside configured globs', () => {
    writeRules({
      globs: ['reflections/*'],
      routes: {
        reflection: 'wiki/personal/reflections/{date}-{topic}',
        original: 'ideas/{date}-{topic}',
        pattern: 'reflections/patterns/{topic}',
        cycleSummary: 'dream-cycles/{date}',
      },
    });

    expect(() => loadDreamFilingConfig()).toThrow(/routes not covered by globs/);
  });

  test('derives safe SQL LIKE prefixes from routes', () => {
    expect(queryPrefixFromRoute('reflections/{date}-{topic}')).toBe('reflections/');
    expect(queryPrefixFromRoute('reflections/patterns/{topic}')).toBe('reflections/patterns/');
    expect(sqlLikeFromPrefix('reflections/')).toBe('reflections/%');
    expect(() => sqlLikeFromPrefix('../reflections/')).toThrow(/Invalid dream reflection query prefix/);
  });
});
