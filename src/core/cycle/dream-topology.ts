import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DreamSlugTopology {
  reflections: string;
  originalIdeas: string;
  patterns: string;
  people: string;
  cycleSummaries: string;
}

interface DreamFilingRules {
  dream_synthesize_paths?: {
    globs?: unknown;
    routes?: {
      reflections?: unknown;
      original_ideas?: unknown;
      patterns?: unknown;
      people?: unknown;
      cycle_summaries?: unknown;
    };
  };
}

/**
 * Semantic default-source topology for Jarvis/GBrain after literal `default`
 * promotion. This keeps Dream writes in normal Brain shelves instead of
 * Garry's legacy `wiki/personal/...` migration layout.
 */
export const SEMANTIC_DREAM_TOPOLOGY: DreamSlugTopology = Object.freeze({
  reflections: 'reflections',
  originalIdeas: 'ideas',
  patterns: 'patterns',
  people: 'people',
  cycleSummaries: 'projects/gbrain/dream-cycles',
});

const SLUG_PREFIX_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

export async function loadAllowedSlugPrefixes(): Promise<string[]> {
  const rules = loadFirstFilingRules();
  const globs = rules?.dream_synthesize_paths?.globs;
  if (Array.isArray(globs) && globs.every(g => typeof g === 'string')) {
    return globs as string[];
  }
  return [];
}

export async function loadDreamSlugTopology(): Promise<DreamSlugTopology> {
  const rules = loadFirstFilingRules();
  const routeMap = rules?.dream_synthesize_paths?.routes;
  if (!routeMap) {
    return SEMANTIC_DREAM_TOPOLOGY;
  }

  return {
    reflections: normalizeRoute(routeMap.reflections, SEMANTIC_DREAM_TOPOLOGY.reflections, 'reflections'),
    originalIdeas: normalizeRoute(routeMap.original_ideas, SEMANTIC_DREAM_TOPOLOGY.originalIdeas, 'original_ideas'),
    patterns: normalizeRoute(routeMap.patterns, SEMANTIC_DREAM_TOPOLOGY.patterns, 'patterns'),
    people: normalizeRoute(routeMap.people, SEMANTIC_DREAM_TOPOLOGY.people, 'people'),
    cycleSummaries: normalizeRoute(routeMap.cycle_summaries, SEMANTIC_DREAM_TOPOLOGY.cycleSummaries, 'cycle_summaries'),
  };
}

export function buildDreamCycleSummarySlug(date: string, topology: DreamSlugTopology): string {
  return `${topology.cycleSummaries}/${date}`;
}

function normalizeRoute(value: unknown, fallback: string, field: string): string {
  const raw = typeof value === 'string' && value.trim().length > 0 ? value : fallback;
  const normalized = raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/\*$/, '')
    .replace(/\/+$/, '');

  if (!SLUG_PREFIX_RE.test(normalized)) {
    throw new Error(`Invalid dream_synthesize_paths.routes.${field}: ${raw}`);
  }
  return normalized;
}

function loadFirstFilingRules(): DreamFilingRules | null {
  for (const path of filingRuleCandidates()) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as DreamFilingRules;
    } catch {
      // Keep historical behavior: try the next candidate and fail closed if no
      // valid machine-readable filing rules can be loaded.
    }
  }
  return null;
}

function filingRuleCandidates(): string[] {
  const runtimeRules = join(__dirname, '..', '..', '..', 'skills', '_brain-filing-rules.json');
  const cwdRules = join(process.cwd(), 'skills', '_brain-filing-rules.json');
  return runtimeRules === cwdRules ? [runtimeRules] : [runtimeRules, cwdRules];
}
