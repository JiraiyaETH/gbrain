/**
 * Relational recall arm (typed-edge retrieval, v0.43).
 *
 * Turns a relational query into a ranked list of edge-derived candidates that
 * hybridSearch injects as a FOURTH RRF arm (alongside keyword + vector), so a
 * relationship answer competes for ranking instead of relying on lexical or
 * vector similarity to surface it.
 *
 * Flow:  parseRelationalQuery → resolve seed entity(ies) (scope-aware,
 * confidence-gated) → engine.relationalFanout (within-source, deterministic)
 * → batch-hydrate to SearchResult rows (reinforcing each page's REAL canonical
 * chunk; page-level key for chunkless entity pages).
 *
 * Determinism: parses the ORIGINAL query (never an LLM-expanded variant);
 * traversal + resolution are deterministic. Fail-open: any error returns an
 * empty arm + an audit row, never breaking the search hot path.
 *
 * Federation (E2=A): resolves the seed in every in-scope source and fans out
 * from each; traversal stays WITHIN each source (no cross-boundary edges in
 * v1). Confidence gate (D3): a seed that only `fallback_slugify`-resolves is
 * dropped, so the arm never traverses from an invented slug. The tier-2
 * resolution-margin gate is a filed TODO.
 *
 * Tested in test/relational-recall.test.ts.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, PageType, RelationalFanoutRow } from '../types.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { parseRelationalQuery, type RelationalQuery, type RelationVocab } from './relational-intent.ts';

export interface RelationalArmOpts {
  sourceId?: string;
  sourceIds?: string[];
  depth?: number;
  limit?: number;
  vocab?: RelationVocab;
  onMeta?: (meta: RelationalArmMeta) => void;
}

export interface RelationalArmMeta {
  fired: boolean;
  kind: RelationalQuery['kind'] | null;
  seeds_resolved: number;
  candidates: number;
  errored: boolean;
  duration_ms: number;
}

interface RelationalFailureEvent {
  ts: string;
  error_summary: string;
  query_kind: string;
}

const failureWriter = createAuditWriter<RelationalFailureEvent>({
  featureName: 'relational-recall-failures',
  errorLabel: 'gbrain',
  errorTrailer: '; search continues',
});

/** Recent relational-arm fail-open events — consumed by doctor + search stats. */
export function readRecentRelationalFailures(days = 7, now: Date = new Date()): RelationalFailureEvent[] {
  return failureWriter.readRecent(days, now);
}

function truncate(msg: string, max = 200): string {
  return msg.length <= max ? msg : msg.slice(0, max - 1) + '…';
}

/** Sources to resolve a seed against. Federated → the set; scalar → [id];
 *  unscoped/__all__ → ['default'] (single-source brains; multi-source
 *  enumeration under __all__ is a v1 limitation). */
function scopeSources(opts: RelationalArmOpts): string[] {
  if (opts.sourceIds && opts.sourceIds.length > 0) return opts.sourceIds;
  if (opts.sourceId && opts.sourceId !== '__all__') return [opts.sourceId];
  return ['default'];
}

/** Resolve a seed phrase to all in-scope (source_id, slug) pairs that
 *  resolve to a REAL page (confidence gate D3 tier-1: drop fallback_slugify). */
async function resolveSeedScoped(
  engine: BrainEngine,
  sources: string[],
  phrase: string,
): Promise<Array<{ source_id: string; slug: string }>> {
  const out: Array<{ source_id: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const sid of sources) {
    const r = await resolveEntitySlugWithSource(engine, sid, phrase);
    let slug = r && r.source !== 'fallback_slugify' ? r.slug : null;
    // Short project/product names such as "TAP" are deliberately excluded
    // from the general bare-person prefix resolver.  For a relational seed,
    // an unambiguous display-title head ("TAP — Tailored Associate Program")
    // is still strong evidence.  This fallback is read-only, source-scoped,
    // and refuses ambiguity; it never accepts slugify's invented page.
    if (!slug) slug = await resolveUnambiguousDisplayHead(engine, sid, phrase);
    if (!slug) continue;
    const key = `${sid}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source_id: sid, slug });
  }
  return out;
}

async function resolveUnambiguousDisplayHead(
  engine: BrainEngine,
  sourceId: string,
  phrase: string,
): Promise<string | null> {
  const clean = phrase.trim();
  if (!clean || clean.length > 80) return null;
  // LIKE parameters are still patterns: parameterization prevents SQL
  // injection, not `%`/`_` wildcard expansion.  Escape all pattern
  // metacharacters so a user seed can match only its literal title head.
  const literalLike = clean.replace(/[\\%_]/g, '\\$&');
  const rows = await engine.executeRaw<{ slug: string }>(
    `WITH candidates AS (
       SELECT slug,
              CASE
                WHEN lower(title) = lower($2) THEN 0
                WHEN lower(title) LIKE (lower($3) || ' —%') ESCAPE '\\'
                  OR lower(title) LIKE (lower($3) || ' –%') ESCAPE '\\' THEN 1
                WHEN lower(title) LIKE (lower($3) || ' - %') ESCAPE '\\' THEN 2
                WHEN lower(title) LIKE (lower($3) || ':%') ESCAPE '\\' THEN 3
                ELSE 4
              END AS match_rank
         FROM pages
        WHERE source_id = $1
          AND deleted_at IS NULL
          AND (
            lower(title) = lower($2)
            OR lower(title) LIKE (lower($3) || ' —%') ESCAPE '\\'
            OR lower(title) LIKE (lower($3) || ' –%') ESCAPE '\\'
            OR lower(title) LIKE (lower($3) || ' - %') ESCAPE '\\'
            OR lower(title) LIKE (lower($3) || ':%') ESCAPE '\\'
          )
     ), best AS (
       SELECT MIN(match_rank) AS match_rank FROM candidates
     )
     SELECT c.slug
       FROM candidates c
       JOIN best b ON b.match_rank = c.match_rank
      ORDER BY c.slug ASC
      LIMIT 2`,
    [sourceId, clean, literalLike],
  );
  return rows.length === 1 ? rows[0].slug : null;
}

/** Batch-hydrate fanout rows into SearchResult rows in fanout (ranked) order. */
async function hydrate(
  engine: BrainEngine,
  rows: RelationalFanoutRow[],
  seedSlug: string,
): Promise<SearchResult[]> {
  if (rows.length === 0) return [];
  const slugs = Array.from(new Set(rows.map(r => r.slug)));
  const pageRows = await engine.executeRaw<{
    page_id: number; slug: string; source_id: string; title: string; type: string; synopsis: string | null;
  }>(
    `SELECT p.id AS page_id, p.slug, p.source_id, p.title, p.type,
            LEFT(p.compiled_truth, 240) AS synopsis
     FROM pages p
     WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL`,
    [slugs],
  );
  const byKey = new Map<string, typeof pageRows[number]>();
  for (const pr of pageRows) byKey.set(`${pr.source_id}:${pr.slug}`, pr);

  const out: SearchResult[] = [];
  for (const r of rows) {
    const pr = byKey.get(`${r.source_id}:${r.slug}`);
    if (!pr) continue;
    out.push({
      slug: r.slug,
      page_id: pr.page_id,
      title: pr.title,
      type: pr.type as PageType,
      chunk_text: pr.synopsis ?? r.slug,
      chunk_source: 'compiled_truth',
      // E1: reinforce the page's REAL canonical chunk; F3: chunkless entity
      // pages key page-level (chunk_id 0 → rrfKey `source:slug:0`, stable and
      // collision-safe; SERIAL chunk ids start at 1 so 0 never aliases a real chunk).
      chunk_id: r.canonical_chunk_id ?? 0,
      chunk_index: 0,
      score: 0, // rank-based: RRF derives score from list position
      stale: false,
      source_id: r.source_id,
      relational_via_link_types: r.via_link_types,
      relational_seed: seedSlug,
      relational_hop: r.hop,
      relational_path: r.path,
    });
  }
  return out;
}

/**
 * Endpoint fanouts for a two-seed "connects" intersection must see each seed's
 * FULL neighbor set, NOT the caller's result `limit`: a midpoint only qualifies
 * if it's reachable from BOTH seeds, so truncating either side to `limit` before
 * intersecting silently drops valid midpoints when a seed has more neighbors
 * than `limit` (e.g. a company with 60+ `creator_for` creators). We fan each
 * endpoint to the engine's hard ceiling (relationalFanout clamps `limit` to 200)
 * and apply the caller's `limit` to the final intersected list instead.
 */
const INTERSECTION_ENDPOINT_FANOUT_LIMIT = 200;

/**
 * Build the relational recall arm. Returns an empty list (pure no-op) when the
 * query isn't relational or no seed resolves. Never throws.
 */
export async function buildRelationalArm(
  engine: BrainEngine,
  query: string,
  opts: RelationalArmOpts = {},
): Promise<SearchResult[]> {
  const startedAt = Date.now();
  const meta: RelationalArmMeta = {
    fired: false, kind: null, seeds_resolved: 0, candidates: 0, errored: false, duration_ms: 0,
  };
  const finish = (list: SearchResult[]) => {
    meta.candidates = list.length;
    meta.duration_ms = Date.now() - startedAt;
    opts.onMeta?.(meta);
    return list;
  };

  const parsed = parseRelationalQuery(query, opts.vocab);
  if (!parsed) return finish([]);
  meta.kind = parsed.kind;

  try {
    const sources = scopeSources(opts);
    const fanoutOpts = {
      linkTypes: parsed.linkTypes,
      direction: parsed.direction,
      depth: opts.depth,
      limit: opts.limit,
    };

    if (parsed.kind === 'connects' && parsed.seeds.length === 2) {
      // Resolve both endpoints; both must resolve or the arm no-ops.
      const resA = await resolveSeedScoped(engine, sources, parsed.seeds[0]);
      const resB = await resolveSeedScoped(engine, sources, parsed.seeds[1]);
      if (resA.length === 0 || resB.length === 0) return finish([]);
      meta.seeds_resolved = resA.length + resB.length;

      const perSource = (rs: typeof resA) => ({
        sourceId: rs.length === 1 ? rs[0].source_id : undefined,
        sourceIds: rs.length > 1 ? Array.from(new Set(rs.map(x => x.source_id))) : undefined,
        slugs: Array.from(new Set(rs.map(x => x.slug))),
      });
      const a = perSource(resA);
      const b = perSource(resB);
      // Fan each endpoint out WIDE — its full neighbor set (engine-capped at
      // 200), not the caller's result `limit` — so the intersection below is
      // computed over complete lists. See INTERSECTION_ENDPOINT_FANOUT_LIMIT.
      const wideFanoutOpts = { ...fanoutOpts, limit: INTERSECTION_ENDPOINT_FANOUT_LIMIT };
      const fanA = await engine.relationalFanout(a.slugs, { ...wideFanoutOpts, sourceId: a.sourceId, sourceIds: a.sourceIds });
      const fanB = await engine.relationalFanout(b.slugs, { ...wideFanoutOpts, sourceId: b.sourceId, sourceIds: b.sourceIds });
      // Shared midpoints: nodes reachable from BOTH endpoints (exclude the
      // endpoints themselves). Ordered by combined hop.
      const bByKey = new Map(fanB.map(r => [`${r.source_id}:${r.slug}`, r] as const));
      const endpointSlugs = new Set([...a.slugs, ...b.slugs]);
      const shared = fanA
        .filter(r => bByKey.has(`${r.source_id}:${r.slug}`) && !endpointSlugs.has(r.slug))
        .map(r => ({ row: r, combined: r.hop + bByKey.get(`${r.source_id}:${r.slug}`)!.hop }))
        .sort((x, y) => x.combined - y.combined || x.row.slug.localeCompare(y.row.slug))
        .map(x => x.row);
      // Apply the caller's result `limit` to the FINAL intersected list (the
      // per-endpoint fanouts above were intentionally widened past it).
      const limited = typeof opts.limit === 'number' ? shared.slice(0, opts.limit) : shared;
      const list = await hydrate(engine, limited, parsed.seeds.join(' ↔ '));
      meta.fired = list.length > 0;
      return finish(list);
    }

    // who_rel / who_at / intro: single logical seed (may resolve in N sources).
    const resolved = await resolveSeedScoped(engine, sources, parsed.seeds[0]);
    if (resolved.length === 0) return finish([]);
    meta.seeds_resolved = resolved.length;
    const slugs = Array.from(new Set(resolved.map(r => r.slug)));
    const srcIds = Array.from(new Set(resolved.map(r => r.source_id)));
    const rows = await engine.relationalFanout(slugs, {
      ...fanoutOpts,
      sourceId: srcIds.length === 1 ? srcIds[0] : undefined,
      sourceIds: srcIds.length > 1 ? srcIds : undefined,
    });
    const list = await hydrate(engine, rows, resolved[0].slug);
    meta.fired = list.length > 0;
    return finish(list);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failureWriter.log({ error_summary: truncate(msg), query_kind: parsed.kind });
    meta.errored = true;
    return finish([]);
  }
}
