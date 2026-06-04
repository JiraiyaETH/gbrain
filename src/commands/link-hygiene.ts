import type { BrainEngine } from '../core/engine.ts';
import { classifyExistingGraphLink } from '../core/link-ontology.ts';

export interface ExistingLinkRow {
  from_slug: string;
  from_source_id: string;
  from_page_type: string | null;
  to_slug: string;
  to_source_id: string;
  to_page_type: string | null;
  link_type: string;
  context: string | null;
  link_source: string | null;
  link_kind: string | null;
  origin_field: string | null;
}

export interface LinkHygieneIssue {
  from_slug: string;
  from_source_id: string;
  to_slug: string;
  to_source_id: string;
  current_type: string;
  recommended_type: string;
  action: 'downgrade_to_mentions';
  reason_code: string;
  authority_tier: string;
  query_expansion_allowed: boolean;
  link_source: string | null;
  link_kind: string | null;
  context: string;
}

export interface LinkHygieneOptions {
  sourceId?: string;
  grep?: string;
  limit?: number;
  apply?: boolean;
  yes?: boolean;
}

export interface LinkHygieneResult {
  scanned: number;
  issues: LinkHygieneIssue[];
  issue_count: number;
  fixed_count: number;
  dry_run: boolean;
  counts_by_reason: Record<string, number>;
  counts_by_current_type: Record<string, number>;
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function matchesGrep(row: ExistingLinkRow, grep?: string): boolean {
  if (!grep) return true;
  const needle = grep.toLowerCase();
  return [row.from_slug, row.to_slug, row.context ?? '', row.link_type, row.link_source ?? '']
    .some((value) => value.toLowerCase().includes(needle));
}

export function collectInvalidGraphLinks(
  rows: ExistingLinkRow[],
  opts: Pick<LinkHygieneOptions, 'grep' | 'limit'> = {},
): LinkHygieneIssue[] {
  const out: LinkHygieneIssue[] = [];
  for (const row of rows) {
    if (opts.limit !== undefined && out.length >= opts.limit) break;
    if (!matchesGrep(row, opts.grep)) continue;
    if (row.link_type === 'mentions') continue;
    // Preserve explicit user/frontmatter assertions. The cleanup lane only
    // repairs inferred/autopilot-era typed pollution.
    if (row.link_source === 'manual' || row.link_source === 'frontmatter') continue;

    const decision = classifyExistingGraphLink({
      fromSlug: row.from_slug,
      fromPageType: row.from_page_type ?? undefined,
      toSlug: row.to_slug,
      toPageType: row.to_page_type ?? undefined,
      linkType: row.link_type,
      context: row.context ?? undefined,
      linkSource: row.link_source,
      linkKind: row.link_kind,
      originField: row.origin_field,
    });

    if (decision.action !== 'downgrade_to_mentions') continue;
    out.push({
      from_slug: row.from_slug,
      from_source_id: row.from_source_id,
      to_slug: row.to_slug,
      to_source_id: row.to_source_id,
      current_type: decision.currentType,
      recommended_type: decision.recommendedType,
      action: decision.action,
      reason_code: decision.reasonCode,
      authority_tier: decision.authorityTier,
      query_expansion_allowed: decision.queryExpansionAllowed,
      link_source: row.link_source,
      link_kind: row.link_kind,
      context: decision.evidenceSnippet,
    });
  }
  return out;
}

async function fetchTypedLinks(engine: BrainEngine, opts: LinkHygieneOptions): Promise<ExistingLinkRow[]> {
  const where: string[] = [
    "f.deleted_at IS NULL",
    "t.deleted_at IS NULL",
    "l.link_type <> 'mentions'",
  ];
  const params: unknown[] = [];
  if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`f.source_id = $${params.length}`);
  }
  const sql = `
    SELECT f.slug AS from_slug,
           f.source_id AS from_source_id,
           f.type AS from_page_type,
           t.slug AS to_slug,
           t.source_id AS to_source_id,
           t.type AS to_page_type,
           l.link_type,
           l.context,
           l.link_source,
           l.link_kind,
           l.origin_field
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
     WHERE ${where.join(' AND ')}
     ORDER BY f.source_id, f.slug, l.link_type, t.slug
  `;
  return engine.executeRaw<ExistingLinkRow>(sql, params);
}

async function removeTypedLinkExact(engine: BrainEngine, issue: LinkHygieneIssue): Promise<void> {
  if (issue.link_source !== null) {
    await engine.removeLink(
      issue.from_slug,
      issue.to_slug,
      issue.current_type,
      issue.link_source,
      { fromSourceId: issue.from_source_id, toSourceId: issue.to_source_id },
    );
    return;
  }

  await engine.executeRaw(
    `DELETE FROM links l
      USING pages f, pages t
      WHERE l.from_page_id = f.id
        AND l.to_page_id = t.id
        AND f.slug = $1
        AND f.source_id = $2
        AND t.slug = $3
        AND t.source_id = $4
        AND l.link_type = $5
        AND l.link_source IS NULL`,
    [issue.from_slug, issue.from_source_id, issue.to_slug, issue.to_source_id, issue.current_type],
  );
}

export async function runLinkHygiene(engine: BrainEngine, opts: LinkHygieneOptions = {}): Promise<LinkHygieneResult> {
  if (opts.apply && !opts.yes) {
    throw new Error('Refusing to mutate graph without --yes. Re-run with --apply --yes after reviewing dry-run output.');
  }

  const rows = await fetchTypedLinks(engine, opts);
  const issues = collectInvalidGraphLinks(rows, opts);
  let fixed = 0;

  if (opts.apply) {
    for (const issue of issues) {
      await engine.addLink( // gbrain-allow-direct-insert: link-hygiene downgrades invalid inferred typed rows to weak mentions before exact typed-row removal
        issue.from_slug,
        issue.to_slug,
        issue.context,
        'mentions',
        issue.link_source ?? 'markdown',
        undefined,
        undefined,
        { fromSourceId: issue.from_source_id, toSourceId: issue.to_source_id },
      );
      await removeTypedLinkExact(engine, issue);
      fixed++;
    }
  }

  const countsByReason: Record<string, number> = {};
  const countsByCurrentType: Record<string, number> = {};
  for (const issue of issues) {
    inc(countsByReason, issue.reason_code);
    inc(countsByCurrentType, issue.current_type);
  }

  return {
    scanned: rows.length,
    issues,
    issue_count: issues.length,
    fixed_count: fixed,
    dry_run: !opts.apply,
    counts_by_reason: countsByReason,
    counts_by_current_type: countsByCurrentType,
  };
}

function parseArgs(args: string[]): { opts: LinkHygieneOptions; json: boolean } {
  const opts: LinkHygieneOptions = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--source-id' || arg === '--source') opts.sourceId = args[++i];
    else if (arg === '--grep') opts.grep = args[++i];
    else if (arg === '--limit') {
      const n = Number.parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(n) || n < 1) throw new Error('--limit must be a positive integer');
      opts.limit = n;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown link-hygiene flag: ${arg}`);
    }
  }
  return { opts, json };
}

function printHelp(): void {
  console.log(`Usage: gbrain link-hygiene [--source-id ID] [--grep TEXT] [--limit N] [--json]
       gbrain link-hygiene --apply --yes [--source-id ID] [--grep TEXT] [--limit N] [--json]

Scan existing graph rows against the current link ontology policy. Dry-run by
default. --apply downgrades invalid inferred typed rows to weak mentions, while
preserving explicit manual/frontmatter edges.`);
}

export async function runLinkHygieneCli(engine: BrainEngine, args: string[]): Promise<void> {
  const { opts, json } = parseArgs(args);
  const result = await runLinkHygiene(engine, opts);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const label = result.dry_run ? 'link-hygiene dry-run' : 'link-hygiene apply';
  console.log(`${label}: scanned ${result.scanned} typed links, found ${result.issue_count} invalid inferred typed rows, fixed ${result.fixed_count}.`);
  if (result.issue_count > 0) {
    console.log('By reason:');
    for (const [reason, count] of Object.entries(result.counts_by_reason)) {
      console.log(`  ${reason}: ${count}`);
    }
    console.log('Examples:');
    for (const issue of result.issues.slice(0, 10)) {
      console.log(`  ${issue.from_slug} -> ${issue.to_slug}: ${issue.current_type} -> ${issue.recommended_type} (${issue.reason_code})`);
    }
  }
}
