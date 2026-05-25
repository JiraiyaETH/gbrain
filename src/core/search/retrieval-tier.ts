/**
 * Retrieval tiers for the literal default Brain.
 *
 * This is intentionally path/shape based, not keyword based. Domain words like
 * client, campaign, KOL, or a company name are valid compiled truth when they
 * live in owner-shaped pages. Evidence and quarantine boundaries come from the
 * slug prefix, matching the Brain repo layout.
 */

export type RetrievalTier = 'T1' | 'T2' | 'T3' | 'T4';

export interface RetrievalTierRule {
  prefix: string;
  tier: RetrievalTier;
}

export const RETRIEVAL_TIER_RULES: RetrievalTierRule[] = [
  // T4: never normal retrieval. Explicit recovery/audit paths only.
  { prefix: '_quarantine/', tier: 'T4' },
  { prefix: 'quarantine/', tier: 'T4' },
  { prefix: 'archive/', tier: 'T4' },

  // T3: provenance/evidence. Preserved, but not first-rank by default.
  { prefix: 'sources/', tier: 'T3' },

  // T2: context and operational/reference material. Useful, but demoted below
  // owner pages for normal answers.
  { prefix: 'meetings/', tier: 'T2' },
  { prefix: 'inbox/', tier: 'T2' },
  { prefix: 'references/', tier: 'T2' },
  { prefix: 'daily/', tier: 'T2' },
  { prefix: 'media/x/', tier: 'T2' },
  { prefix: 'openclaw/chat/', tier: 'T2' },

  // T1: compiled truth / owner-shaped knowledge.
  { prefix: 'originals/', tier: 'T1' },
  { prefix: 'writing/', tier: 'T1' },
  { prefix: 'concepts/', tier: 'T1' },
  { prefix: 'people/', tier: 'T1' },
  { prefix: 'companies/', tier: 'T1' },
  { prefix: 'clients/', tier: 'T1' },
  { prefix: 'deals/', tier: 'T1' },
  { prefix: 'domains/', tier: 'T1' },
  { prefix: 'decisions/', tier: 'T1' },
  { prefix: 'capabilities/', tier: 'T1' },
  { prefix: 'projects/', tier: 'T1' },
  { prefix: 'lessons/', tier: 'T1' },
];

export const DEFAULT_RETRIEVAL_TIER_BOOSTS: Record<string, number> = {
  // T1: owner pages / curated writing get first-rank treatment.
  'originals/': 1.5,
  'writing/': 1.4,
  'concepts/': 1.3,
  'people/': 1.2,
  'companies/': 1.2,
  'clients/': 1.2,
  'deals/': 1.2,
  'domains/': 1.2,
  'decisions/': 1.2,
  'capabilities/': 1.2,
  'projects/': 1.15,
  'lessons/': 1.15,

  // Neutral canonical families.
  'yc/': 1.0,
  'civic/': 1.0,
  'media/articles/': 1.0,
  'media/repos/': 1.0,

  // T2: context/evidence is searchable, but normal answers should prefer
  // compiled truth above it. detail=high still bypasses all boosts.
  'meetings/': 0.85,
  'references/': 0.85,
  'inbox/': 0.75,
  'daily/': 0.8,
  'media/x/': 0.7,
  'openclaw/chat/': 0.5,
};

export const DEFAULT_RETRIEVAL_HARD_EXCLUDES: string[] = [
  // Existing non-answer surfaces.
  'test/',
  'archive/',
  'attachments/',
  '.raw/',

  // Literal default Brain retrieval tiers.
  'sources/',
  '_quarantine/',
  'quarantine/',
];

function normalizeSlug(slug: string): string {
  return slug.trim().replace(/^\/+/, '').toLowerCase();
}

export function getRetrievalTierForSlug(slug: string): RetrievalTier {
  const normalized = normalizeSlug(slug);
  const rule = [...RETRIEVAL_TIER_RULES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find(r => normalized.startsWith(r.prefix));

  // Unknown paths remain normal retrieval candidates. Without page metadata, a
  // slug alone cannot prove a page is raw evidence, so do not over-demote it.
  return rule?.tier ?? 'T1';
}
