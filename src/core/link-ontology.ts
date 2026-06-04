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

export type ExistingGraphLinkAction = 'keep' | 'downgrade_to_mentions';

export interface ExistingGraphLinkInput {
  fromSlug: string;
  fromPageType?: PageType | string;
  toSlug: string;
  toPageType?: PageType | string;
  linkType: string;
  context?: string;
  linkSource?: string | null;
  linkKind?: string | null;
  originField?: string | null;
}

export interface ExistingGraphLinkDecision {
  action: ExistingGraphLinkAction;
  currentType: string;
  recommendedType: string;
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

const EXISTING_GRAPH_POLICY_TYPES = new Set([
  'invested_in',
  'led_round',
  'attended',
  'creator_for',
  'warm_path_to',
  'founded',
  'works_at',
  'advises',
]);

/**
 * Apply the same ontology matrix to graph rows that already exist.
 *
 * Existing rows need a conservative posture: explicit manual/frontmatter edges
 * are preserved, while old inferred typed edges are treated as if the current
 * extractor proposed them today. If the current policy would downgrade the row,
 * the cleanup lane should replace that typed edge with a weak `mentions` edge
 * rather than deleting connectivity outright.
 */
export function classifyExistingGraphLink(input: ExistingGraphLinkInput): ExistingGraphLinkDecision {
  const currentType = input.linkType || 'mentions';
  if (currentType === 'mentions') {
    return {
      action: 'keep',
      currentType,
      recommendedType: 'mentions',
      reasonCode: 'existing_weak_mention',
      evidenceSnippet: evidenceSnippet(input.context),
      authorityTier: 'weak',
      queryExpansionAllowed: false,
    };
  }

  if (!EXISTING_GRAPH_POLICY_TYPES.has(currentType)) {
    return {
      action: 'keep',
      currentType,
      recommendedType: currentType,
      reasonCode: 'existing_unmanaged_typed_edge',
      evidenceSnippet: evidenceSnippet(input.context),
      authorityTier: 'medium',
      queryExpansionAllowed: true,
    };
  }

  const source = input.linkSource ?? 'markdown';
  const policy = classifyLinkCandidate({
    fromSlug: input.fromSlug,
    fromPageType: input.fromPageType,
    toSlug: input.toSlug,
    toPageType: input.toPageType,
    proposedType: currentType,
    context: input.context,
    linkSource: source,
    linkKind: input.linkKind,
    originField: input.originField ?? undefined,
  });

  return {
    action: policy.linkType === currentType ? 'keep' : 'downgrade_to_mentions',
    currentType,
    recommendedType: policy.linkType,
    reasonCode: policy.reasonCode,
    evidenceSnippet: policy.evidenceSnippet,
    authorityTier: policy.authorityTier,
    queryExpansionAllowed: policy.queryExpansionAllowed,
  };
}
