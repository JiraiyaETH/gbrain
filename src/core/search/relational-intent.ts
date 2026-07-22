/**
 * Relational-query parser (typed-edge retrieval, v0.43).
 *
 * Detects queries whose answer is a RELATIONSHIP (an edge between entities)
 * rather than a passage — "who invested in widget-co", "who at acme works on
 * payments", "who introduced me to alice", "what connects fund-a and fund-b".
 * The relational recall arm uses the parse to resolve seed entities and walk
 * the typed-edge graph.
 *
 * Pure module. No DB, no LLM, no async. Detection is regex-only and
 * deterministic, parsed from the ORIGINAL query (never the LLM-expanded
 * variant) so the recall arm stays bit-for-bit reproducible.
 *
 * Precision-first (D4): this returns a CANDIDATE. The arm fires only when a
 * resolvable seed entity is also found (seed resolution lives in
 * relational-recall.ts). Patterns require the relation phrase and the entity
 * to be adjacent, so "who invested TIME in learning Rust" does not match the
 * "who invested in <seed>" pattern.
 *
 * Vocabulary (D2): the default bank covers the common archetypes; a schema
 * pack can extend it with `extraVerbs`, `extraLinkTypes`, and
 * `extraPatterns`. Every emitted link_type is validated against the effective
 * known-link-type set so the query side can't drift from what ingest actually
 * produces (see link-extraction.ts:inferLinkType). intro/connects traverse
 * type-agnostically (linkTypes = null) because gbrain has no
 * `introduced`/`knows` edge — any edge touching the seed is the signal.
 *
 * ReDoS: seed captures are length-bounded (`.{1,80}?`) and every pattern is
 * anchored, so there is no catastrophic-backtracking surface.
 *
 * Tested in test/relational-intent.test.ts.
 */

export type RelationalKind = 'who_rel' | 'who_at' | 'connects' | 'intro';
export type RelationDirection = 'in' | 'out' | 'both';

export interface RelationalQuery {
  /** Which archetype matched. */
  kind: RelationalKind;
  /** Raw entity phrases to resolve, in query order. 1 for most, 2 for connects. */
  seeds: string[];
  /** Typed edges to traverse, or null for type-agnostic traversal. */
  linkTypes: string[] | null;
  /** Traversal direction from the seed. */
  direction: RelationDirection;
  /** The matched relation phrase, for telemetry / --explain. */
  relationPhrase: string;
}

/** Schema-pack vocab extension (D2=B). */
export interface RelationVerbSpec {
  /** A regex-source alternation of phrasings, e.g. `acquired|bought`. */
  verb: string;
  /** Edges this verb maps to. Must be a subset of the effective known-link-type set. */
  linkTypes: string[];
  /** Direction from the seed entity named after the verb. */
  direction: RelationDirection;
}

export interface RelationPatternSpec {
  /** Full regex source. Capture groups 1..seedGroups are treated as seeds. */
  pattern: string;
  kind: RelationalKind;
  /** Typed edges to traverse, or null/undefined for type-agnostic traversal. */
  linkTypes?: string[] | null;
  direction: RelationDirection;
  seedGroups: 1 | 2;
  /** Static seed phrases appended after captured seeds. */
  extraSeeds?: string[];
}

export interface RelationVocab {
  extraLinkTypes?: string[];
  extraVerbs?: RelationVerbSpec[];
  extraPatterns?: RelationPatternSpec[];
}

/**
 * Link types ingest can actually produce (link-extraction.ts + frontmatter
 * map + schema packs). The query parser may only emit a SUBSET of these, so a
 * relation phrase can never traverse an edge type that ingest never writes.
 * `validateVocab` enforces this for pack-supplied verbs.
 */
export const KNOWN_LINK_TYPES: ReadonlySet<string> = new Set([
  'founded',
  'invested_in',
  'advises',
  'works_at',
  'attended',
  'yc_partner',
  'led_round',
  'mentions',
  'image_of',
  'discussed_in',
  'source',
  'related_to',
  'wikilink_basename',
]);

// Seeds that are pronouns / generic nouns, not entities. If a pattern's seed
// cleans down to one of these, the parse is rejected (precision-first).
const STOPWORD_SEEDS: ReadonlySet<string> = new Set([
  'it', 'that', 'this', 'them', 'these', 'those', 'here', 'there',
  'everyone', 'anyone', 'someone', 'anybody', 'somebody', 'people',
  'things', 'us', 'me', 'him', 'her', 'you', 'who', 'what', 'which',
]);

interface CompiledPattern {
  re: RegExp;
  kind: RelationalKind;
  linkTypes: string[] | null;
  direction: RelationDirection;
  /** Number of seed capture groups (1, or 2 for connects). */
  seedGroups: 1 | 2;
  /** Static seed phrases appended after captured seeds. */
  extraSeeds?: string[];
}

// Bounded seed capture: 1–80 chars, lazy, so the trailing anchor decides the
// boundary without catastrophic backtracking.
const SEED = '(.{1,80}?)';

// ── who_rel verb bank: "who <verb> <seed>" → traverse INTO the seed ──
// Each entry is explicit (linkTypes inline) so there is no second lookup.
const WHO_REL_VERBS: Array<{ verb: string; linkTypes: string[]; direction: RelationDirection }> = [
  { verb: 'invested in|invests in|funded|backed|backs|led the round in|led the seed in|led the series [a-z] in', linkTypes: ['invested_in', 'led_round'], direction: 'in' },
  { verb: 'founded|co-?founded|started', linkTypes: ['founded'], direction: 'in' },
  { verb: 'advises|advised', linkTypes: ['advises'], direction: 'in' },
  { verb: 'works at|worked at|works for', linkTypes: ['works_at'], direction: 'in' },
  { verb: 'attended', linkTypes: ['attended'], direction: 'in' },
];

function buildPatterns(vocab?: RelationVocab): CompiledPattern[] {
  const patterns: CompiledPattern[] = [];

  // connects — two seeds, type-agnostic. Most specific, checked first.
  patterns.push({
    re: new RegExp(
      `\\b(?:what|which)\\s+(?:companies?|people|things|entities|deals?)?\\s*(?:connects?|links?|ties? together|is (?:the )?(?:connection|link|relationship) between)\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s*\\??$`,
      'i',
    ),
    kind: 'connects', linkTypes: null, direction: 'both', seedGroups: 2,
  });
  patterns.push({
    re: new RegExp(
      `\\bhow\\s+(?:are|is|do|does)\\s+${SEED}\\s+(?:and|&)\\s+${SEED}\\s+(?:connected|related|linked|associated)\\b`,
      'i',
    ),
    kind: 'connects', linkTypes: null, direction: 'both', seedGroups: 2,
  });

  for (const p of vocab?.extraPatterns ?? []) {
    patterns.push({
      re: new RegExp(p.pattern, 'i'),
      kind: p.kind,
      linkTypes: p.linkTypes ?? null,
      direction: p.direction,
      seedGroups: p.seedGroups,
      extraSeeds: p.extraSeeds,
    });
  }

  // intro — type-agnostic walk around the named person (no `introduced` edge).
  patterns.push({
    re: new RegExp(
      `\\bwho\\s+(?:introduced|connected|referred)\\s+(?:me|us|him|her|them)\\s+to\\s+${SEED}\\s*\\??$`,
      'i',
    ),
    kind: 'intro', linkTypes: null, direction: 'both', seedGroups: 1,
  });

  // who_at — entity in the middle: "who at acme works on payments".
  patterns.push({
    re: new RegExp(
      `\\bwho\\s+(?:at|from|in)\\s+${SEED}\\s+(?:works? on|works?|leads?|runs?|builds?|owns?|handles?|manages?)\\b`,
      'i',
    ),
    kind: 'who_at', linkTypes: ['works_at'], direction: 'in', seedGroups: 1,
  });

  // who_rel — "who <verb> <seed>".
  for (const v of WHO_REL_VERBS) {
    patterns.push({
      re: new RegExp(`\\bwho\\s+(?:${v.verb})\\s+${SEED}\\s*\\??$`, 'i'),
      kind: 'who_rel', linkTypes: v.linkTypes, direction: v.direction, seedGroups: 1,
    });
  }

  // outgoing variants — "what did <seed> invest in", "where does <seed> work".
  patterns.push({
    re: new RegExp(
      `\\bwhat\\s+(?:companies?|startups?|deals?)?\\s*(?:has|have|did|does)?\\s*${SEED}\\s+(?:invest(?:ed)? in)\\b`,
      'i',
    ),
    kind: 'who_rel', linkTypes: ['invested_in', 'led_round'], direction: 'out', seedGroups: 1,
  });
  patterns.push({
    re: new RegExp(`\\bwhere\\s+(?:does|did|has)\\s+${SEED}\\s+work\\b`, 'i'),
    kind: 'who_rel', linkTypes: ['works_at'], direction: 'out', seedGroups: 1,
  });

  // schema-pack extensions: "who <verb> <seed>" for each extra verb.
  for (const v of vocab?.extraVerbs ?? []) {
    patterns.push({
      re: new RegExp(`\\bwho\\s+(?:${v.verb})\\s+${SEED}\\s*\\??$`, 'i'),
      kind: 'who_rel', linkTypes: v.linkTypes, direction: v.direction, seedGroups: 1,
    });
  }

  return patterns;
}

/** Trim, drop a leading article and surrounding quotes, strip trailing `?`. */
function cleanSeed(raw: string): string {
  return raw
    .trim()
    .replace(/\?+$/, '')
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
}

function validSeed(s: string): boolean {
  if (s.length === 0 || s.length > 80) return false;
  if (STOPWORD_SEEDS.has(s.toLowerCase())) return false;
  return true;
}

const LINK_TYPE_RE = /^[a-z][a-z0-9_]*$/;
const DIRECTIONS: ReadonlySet<RelationDirection> = new Set(['in', 'out', 'both']);
const KINDS: ReadonlySet<RelationalKind> = new Set(['who_rel', 'who_at', 'connects', 'intro']);

function effectiveKnownLinkTypes(vocab: RelationVocab): ReadonlySet<string> {
  return new Set([...KNOWN_LINK_TYPES, ...(vocab.extraLinkTypes ?? [])]);
}

function validateLinkTypeNames(linkTypes: readonly string[], known: ReadonlySet<string>, context: string): void {
  for (const lt of linkTypes) {
    if (!known.has(lt)) {
      throw new Error(
        `relational vocab: unknown link_type "${lt}" for ${context} — must be one of ${[...known].join(', ')}`,
      );
    }
  }
}

/**
 * Validate that every link_type a vocab emits is one ingest can produce.
 * Throws on an unknown type so a misconfigured schema pack fails loudly at
 * load time rather than silently traversing an edge that never exists.
 */
export function validateVocab(vocab: RelationVocab): void {
  for (const lt of vocab.extraLinkTypes ?? []) {
    if (typeof lt !== 'string' || !LINK_TYPE_RE.test(lt)) {
      throw new Error(`relational vocab: invalid extra link_type "${String(lt)}"`);
    }
  }
  const known = effectiveKnownLinkTypes(vocab);
  for (const v of vocab.extraVerbs ?? []) {
    if (typeof v.verb !== 'string' || v.verb.length === 0) {
      throw new Error('relational vocab: extra verb must include a non-empty verb');
    }
    if (!Array.isArray(v.linkTypes)) {
      throw new Error(`relational vocab: verb /${v.verb}/ linkTypes must be an array`);
    }
    if (!DIRECTIONS.has(v.direction)) {
      throw new Error(`relational vocab: verb /${v.verb}/ has invalid direction "${String(v.direction)}"`);
    }
    // Validate regex source early.
    new RegExp(v.verb);
    validateLinkTypeNames(v.linkTypes, known, `verb /${v.verb}/`);
  }
  for (const p of vocab.extraPatterns ?? []) {
    if (typeof p.pattern !== 'string' || p.pattern.length === 0) {
      throw new Error('relational vocab: extra pattern must include a non-empty pattern');
    }
    if (!KINDS.has(p.kind)) {
      throw new Error(`relational vocab: extra pattern /${p.pattern}/ has invalid kind "${String(p.kind)}"`);
    }
    if (!DIRECTIONS.has(p.direction)) {
      throw new Error(`relational vocab: extra pattern /${p.pattern}/ has invalid direction "${String(p.direction)}"`);
    }
    if (p.seedGroups !== 1 && p.seedGroups !== 2) {
      throw new Error(`relational vocab: extra pattern /${p.pattern}/ seedGroups must be 1 or 2`);
    }
    new RegExp(p.pattern, 'i');
    if (p.linkTypes) {
      validateLinkTypeNames(p.linkTypes, known, `pattern /${p.pattern}/`);
    }
    if (p.extraSeeds && !p.extraSeeds.every(s => typeof s === 'string' && validSeed(s))) {
      throw new Error(`relational vocab: extra pattern /${p.pattern}/ extraSeeds must be valid seed strings`);
    }
  }
}

/**
 * Parse a query into a RelationalQuery, or null if it isn't relational.
 * First matching pattern wins (patterns are ordered specific → general).
 */
export function parseRelationalQuery(query: string, vocab?: RelationVocab): RelationalQuery | null {
  if (!query || query.length > 512) return null; // bound work; real queries are short
  const patterns = buildPatterns(vocab);

  for (const p of patterns) {
    const m = p.re.exec(query);
    if (!m) continue;

    if (p.seedGroups === 2) {
      const a = cleanSeed(m[1] ?? '');
      const b = cleanSeed(m[2] ?? '');
      if (!validSeed(a) || !validSeed(b)) continue;
      return { kind: p.kind, seeds: [a, b, ...(p.extraSeeds ?? [])], linkTypes: p.linkTypes, direction: p.direction, relationPhrase: m[0].trim() };
    }

    const seed = cleanSeed(m[1] ?? '');
    if (!validSeed(seed)) continue;
    return { kind: p.kind, seeds: [seed, ...(p.extraSeeds ?? [])], linkTypes: p.linkTypes, direction: p.direction, relationPhrase: m[0].trim() };
  }

  return null;
}
