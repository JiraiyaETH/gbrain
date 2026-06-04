import { describe, expect, test } from 'bun:test';
import { collectInvalidGraphLinks, type ExistingLinkRow } from '../src/commands/link-hygiene.ts';

function row(overrides: Partial<ExistingLinkRow>): ExistingLinkRow {
  return {
    from_slug: 'meetings/example',
    from_source_id: 'default',
    from_page_type: 'meeting',
    to_slug: 'people/alice',
    to_source_id: 'default',
    to_page_type: 'person',
    link_type: 'attended',
    context: '## Attendees - Alice',
    link_source: 'markdown',
    link_kind: null,
    origin_field: null,
    ...overrides,
  };
}

describe('link hygiene scanner', () => {
  test('finds old inferred typed rows that current ontology would downgrade', () => {
    const issues = collectInvalidGraphLinks([
      row({ to_slug: 'projects/consortium/consortium', to_page_type: 'project', context: '## Topics - Consortium' }),
      row({ to_slug: 'people/walter', to_page_type: 'person', context: '## Attendees - Walter' }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      from_slug: 'meetings/example',
      to_slug: 'projects/consortium/consortium',
      current_type: 'attended',
      recommended_type: 'mentions',
      reason_code: 'attended_shape_downgraded',
      action: 'downgrade_to_mentions',
    });
  });

  test('preserves explicit frontmatter/manual rows from automatic cleanup', () => {
    const issues = collectInvalidGraphLinks([
      row({ to_slug: 'projects/consortium/consortium', to_page_type: 'project', link_source: 'manual' }),
      row({ to_slug: 'companies/tailored-studios', to_page_type: 'company', link_source: 'frontmatter', origin_field: 'attendees' }),
    ]);

    expect(issues).toEqual([]);
  });

  test('does not downgrade custom domain link types just because extractor policy does not manage them', () => {
    const issues = collectInvalidGraphLinks([
      row({
        from_slug: 'companies/gammaswap',
        from_page_type: 'company',
        to_slug: 'sources/telegram/2026-06-01-gammaswap-consortium-intake-submission',
        to_page_type: 'source',
        link_type: 'source',
        context: 'Source packet for GammaSwap respondent-supplied Consortium intake.',
      }),
      row({
        from_slug: 'projects/consortium/consortium-vendors',
        from_page_type: 'project',
        to_slug: 'companies/zellic',
        to_page_type: 'company',
        link_type: 'landscape_vendor',
        context: 'Zellic appears in the Consortium audit-vendor landscape row.',
      }),
    ]);

    expect(issues).toEqual([]);
  });

  test('filters issues by reason for narrow safe apply passes', () => {
    const issues = collectInvalidGraphLinks([
      row({ to_slug: 'projects/consortium/consortium', to_page_type: 'project', context: '## Topics - Consortium' }),
      row({
        from_slug: 'people/partner',
        from_page_type: 'person',
        to_slug: 'companies/acme',
        to_page_type: 'company',
        link_type: 'invested_in',
        context: 'Auto-inferred investment sentence from old extraction.',
      }),
    ], { reason: 'attended_shape_downgraded' });

    expect(issues).toHaveLength(1);
    expect(issues[0].reason_code).toBe('attended_shape_downgraded');
  });
});
