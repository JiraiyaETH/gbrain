import type { PageType } from './types.ts';

export type LinkAuthorityTier = 'explicit' | 'strong' | 'medium' | 'weak';

export interface LinkPolicyInput {
  fromSlug: string;
  fromPageType?: PageType | string;
  toSlug: string;
  toPageType?: PageType | string;
  proposedType: string;
  context?: string;
  linkSource?: string;
  linkKind?: string | null;
  originField?: string;
}

export interface LinkPolicyDecision {
  linkType: string;
  reasonCode: string;
  evidenceSnippet: string;
  authorityTier: LinkAuthorityTier;
  queryExpansionAllowed: boolean;
}

function evidenceSnippet(context?: string): string {
  return (context ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function isExplicitSource(input: LinkPolicyInput): boolean {
  return input.linkSource === 'frontmatter' || input.linkSource === 'manual';
}

function isPersonCompany(input: LinkPolicyInput): boolean {
  return input.fromPageType === 'person' && input.toSlug.startsWith('companies/');
}

function isMeetingPerson(input: LinkPolicyInput): boolean {
  return (input.fromPageType === 'meeting' || input.fromSlug.startsWith('meetings/'))
    && input.toSlug.startsWith('people/');
}

function decision(
  input: LinkPolicyInput,
  linkType: string,
  reasonCode: string,
  authorityTier: LinkAuthorityTier,
  queryExpansionAllowed: boolean,
): LinkPolicyDecision {
  const effectiveQueryExpansionAllowed = queryExpansionAllowed && input.linkSource !== 'mentions';
  return {
    linkType,
    reasonCode,
    evidenceSnippet: evidenceSnippet(input.context),
    authorityTier,
    queryExpansionAllowed: effectiveQueryExpansionAllowed,
  };
}

/**
 * Pure ontology policy gate for extracted graph edges.
 *
 * This is intentionally small: extractors may still find candidate refs by
 * regex/frontmatter/schema-pack, but every candidate routes through this layer
 * before a row is emitted. The policy assigns review metadata and downgrades
 * unsafe inferred edges without adding another autonomous architecture.
 */
export function classifyLinkCandidate(input: LinkPolicyInput): LinkPolicyDecision {
  const proposed = input.proposedType || 'mentions';

  if (isExplicitSource(input)) {
    return decision(
      input,
      proposed,
      input.linkSource === 'manual' ? 'explicit_manual_edge' : 'explicit_frontmatter_edge',
      'explicit',
      proposed !== 'mentions' && proposed !== 'related_to',
    );
  }

  // Inferred investor-style relationships are too high-authority for the
  // default Minion/Autopilot lane. Keep explicit frontmatter/manual investor
  // rows, but downgrade markdown/NER/schema-pack inference to weak mentions.
  if (proposed === 'invested_in' || proposed === 'led_round') {
    return decision(input, 'mentions', 'unsafe_investor_inference_downgraded', 'weak', false);
  }

  if (proposed === 'attended') {
    if (isMeetingPerson(input)) return decision(input, proposed, 'meeting_attendee_context', 'strong', true);
    return decision(input, 'mentions', 'attended_shape_downgraded', 'weak', false);
  }

  if (proposed === 'creator_for') {
    return decision(
      input,
      isPersonCompany(input) ? proposed : 'mentions',
      isPersonCompany(input) ? 'creator_campaign_context' : 'creator_for_shape_downgraded',
      isPersonCompany(input) ? 'medium' : 'weak',
      isPersonCompany(input),
    );
  }

  if (proposed === 'warm_path_to') {
    return decision(
      input,
      isPersonCompany(input) ? proposed : 'mentions',
      isPersonCompany(input) ? 'warm_path_context' : 'warm_path_shape_downgraded',
      isPersonCompany(input) ? 'medium' : 'weak',
      isPersonCompany(input),
    );
  }

  if (proposed === 'founded') return decision(input, proposed, 'founded_context', 'strong', true);
  if (proposed === 'works_at') return decision(input, proposed, 'work_affiliation_context', 'strong', true);
  if (proposed === 'advises') return decision(input, proposed, 'advisor_context', 'strong', true);

  if (input.linkKind === 'typed_ner' && proposed !== 'mentions') {
    return decision(input, proposed, 'schema_pack_typed_ner_context', 'medium', true);
  }

  return decision(input, 'mentions', 'weak_mention', 'weak', false);
}
