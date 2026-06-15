import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DreamFilingRoutes {
  reflection: string;
  original: string;
  pattern: string;
  cycleSummary: string;
}

export interface DreamFilingConfig {
  allowedSlugPrefixes: string[];
  routes: DreamFilingRoutes;
  reflectionQueryPrefixes: string[];
  patternQueryPrefixes: string[];
}

interface FilingRulesJson {
  dream_synthesize_paths?: {
    globs?: unknown;
    routes?: Partial<Record<keyof DreamFilingRoutes, unknown>>;
    reflection_query_prefixes?: unknown;
    pattern_query_prefixes?: unknown;
  };
}

export const LEGACY_DREAM_FILING: DreamFilingConfig = {
  allowedSlugPrefixes: [
    'wiki/personal/reflections/*',
    'wiki/originals/*',
    'wiki/personal/patterns/*',
    'wiki/personal/dream-cycles/*',
  ],
  routes: {
    reflection: 'wiki/personal/reflections/{date}-{topic}-{hash}',
    original: 'wiki/originals/ideas/{date}-{topic}-{hash}',
    pattern: 'wiki/personal/patterns/{topic}',
    cycleSummary: 'wiki/personal/dream-cycles/{date}',
  },
  reflectionQueryPrefixes: ['wiki/personal/reflections/'],
  patternQueryPrefixes: ['wiki/personal/patterns/'],
};

export const NO_DREAM_FILING: DreamFilingConfig = {
  ...LEGACY_DREAM_FILING,
  allowedSlugPrefixes: [],
};

export function loadDreamFilingConfig(): DreamFilingConfig {
  for (const path of filingRulesCandidates()) {
    if (!existsSync(path)) continue;
    let parsed: FilingRulesJson;
    try {
      const raw = readFileSync(path, 'utf8');
      parsed = JSON.parse(raw) as FilingRulesJson;
    } catch {
      // Try the next candidate when a candidate is unreadable or malformed.
      continue;
    }
    const cfg = fromFilingRules(parsed);
    if (cfg) return cfg;
  }
  return NO_DREAM_FILING;
}

export function filingRulesCandidates(): string[] {
  return [
    join(process.cwd(), 'skills', '_brain-filing-rules.json'),
    join(__dirname, '..', '..', '..', 'skills', '_brain-filing-rules.json'),
  ];
}

function fromFilingRules(parsed: FilingRulesJson): DreamFilingConfig | null {
  const dream = parsed?.dream_synthesize_paths;
  const globs = dream?.globs;
  if (!Array.isArray(globs) || !globs.every(g => typeof g === 'string')) {
    return null;
  }

  const routes: DreamFilingRoutes = {
    reflection: readRoute(dream?.routes?.reflection, LEGACY_DREAM_FILING.routes.reflection),
    original: readRoute(dream?.routes?.original, LEGACY_DREAM_FILING.routes.original),
    pattern: readRoute(dream?.routes?.pattern, LEGACY_DREAM_FILING.routes.pattern),
    cycleSummary: readRoute(dream?.routes?.cycleSummary, LEGACY_DREAM_FILING.routes.cycleSummary),
  };

  const allowedSlugPrefixes = globs as string[];
  assertRoutesCoveredByAllowList(routes, allowedSlugPrefixes);

  return {
    allowedSlugPrefixes,
    routes,
    reflectionQueryPrefixes: readStringArray(
      dream?.reflection_query_prefixes,
      [queryPrefixFromRoute(routes.reflection)],
    ),
    patternQueryPrefixes: readStringArray(
      dream?.pattern_query_prefixes,
      [queryPrefixFromRoute(routes.pattern)],
    ),
  };
}

function readRoute(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
    const out = value.map(v => v.trim()).filter(Boolean);
    if (out.length > 0) return out;
  }
  return fallback;
}

function assertRoutesCoveredByAllowList(routes: DreamFilingRoutes, allowList: string[]): void {
  const examples = [
    renderDreamSlugTemplate(routes.reflection, { date: '2026-01-02', topic: 'example', hash: 'abc123' }),
    renderDreamSlugTemplate(routes.original, { date: '2026-01-02', topic: 'example', hash: 'abc123' }),
    renderDreamSlugTemplate(routes.pattern, { date: '2026-01-02', topic: 'example', hash: 'abc123' }),
    renderDreamSlugTemplate(routes.cycleSummary, { date: '2026-01-02', topic: 'example', hash: 'abc123' }),
  ];
  const uncovered = examples.filter(slug => !matchesAllowList(slug, allowList));
  if (uncovered.length > 0) {
    throw new Error(`dream_synthesize_paths.routes not covered by globs: ${uncovered.join(', ')}`);
  }
}

function matchesAllowList(slug: string, allowList: string[]): boolean {
  for (const pattern of allowList) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (slug.startsWith(prefix) && slug.length > prefix.length) return true;
    } else if (slug === pattern) {
      return true;
    }
  }
  return false;
}

export function renderDreamSlugTemplate(
  template: string,
  vars: { date: string; topic: string; hash?: string },
): string {
  return template
    .replace(/\{date\}/g, vars.date)
    .replace(/\{topic\}/g, vars.topic)
    .replace(/\{topic-slug\}/g, vars.topic)
    .replace(/\{hash\}/g, vars.hash ?? '')
    .replace(/-+/g, '-')
    .replace(/\/-/g, '/')
    .replace(/-$/g, '');
}

export function queryPrefixFromRoute(route: string): string {
  const firstToken = route.search(/\{(?:date|topic|topic-slug|hash)\}/);
  const prefix = firstToken >= 0 ? route.slice(0, firstToken) : route;
  return prefix.replace(/-+$/g, '');
}

export function sqlLikeFromPrefix(prefix: string): string {
  if (!/^[a-z0-9][a-z0-9\-/]*\/$/.test(prefix)) {
    throw new Error(`Invalid dream reflection query prefix: ${prefix}`);
  }
  return `${prefix}%`;
}
