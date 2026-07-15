type TrendRow = { report_json: Record<string, unknown> };

type Finding = {
  a?: { slug?: unknown };
  b?: { slug?: unknown };
};

type PerQuery = {
  contradictions?: unknown;
  [key: string]: unknown;
};

/** Collect every page slug carried by contradiction findings. */
export function contradictionTrendSlugs(rows: TrendRow[]): string[] {
  const slugs = new Set<string>();
  for (const row of rows) {
    const perQuery = row.report_json.per_query;
    if (!Array.isArray(perQuery)) continue;
    for (const query of perQuery as PerQuery[]) {
      if (!Array.isArray(query.contradictions)) continue;
      for (const finding of query.contradictions as Finding[]) {
        if (typeof finding.a?.slug === 'string') slugs.add(finding.a.slug);
        if (typeof finding.b?.slug === 'string') slugs.add(finding.b.slug);
      }
    }
  }
  return [...slugs];
}

/**
 * Remove every finding whose two endpoints are not both visible in the
 * requested source. A cross-source finding is omitted rather than partially
 * redacted so prompts cannot infer neighboring-source slugs.
 */
export function scopeContradictionsTrend<T extends TrendRow>(
  rows: T[],
  allowedSlugs: ReadonlySet<string>,
): T[] {
  const scoped: T[] = [];
  for (const row of rows) {
    const rawPerQuery = row.report_json.per_query;
    if (!Array.isArray(rawPerQuery)) continue;
    const per_query = (rawPerQuery as PerQuery[])
      .map((query) => ({
        ...query,
        contradictions: Array.isArray(query.contradictions)
          ? (query.contradictions as Finding[]).filter((finding) =>
              typeof finding.a?.slug === 'string'
              && typeof finding.b?.slug === 'string'
              && allowedSlugs.has(finding.a.slug)
              && allowedSlugs.has(finding.b.slug))
          : [],
      }))
      .filter((query) => query.contradictions.length > 0);
    if (per_query.length === 0) continue;
    scoped.push({
      ...row,
      report_json: { ...row.report_json, per_query },
    });
  }
  return scoped;
}
