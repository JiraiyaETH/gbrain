import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateVocab,
  type RelationDirection,
  type RelationPatternSpec,
  type RelationVerbSpec,
  type RelationVocab,
  type RelationalKind,
} from './relational-intent.ts';

let memo: RelationVocab | undefined;
let loaded = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    throw new Error('expected string array');
  }
  return value;
}

function asDirection(value: unknown): RelationDirection {
  if (value === 'in' || value === 'out' || value === 'both') return value;
  throw new Error('invalid relational direction');
}

function asKind(value: unknown): RelationalKind {
  if (value === 'who_rel' || value === 'who_at' || value === 'connects' || value === 'intro') return value;
  throw new Error('invalid relational kind');
}

function parseVerbSpec(value: unknown): RelationVerbSpec {
  if (!isRecord(value) || typeof value.verb !== 'string') {
    throw new Error('invalid relational verb spec');
  }
  return {
    verb: value.verb,
    linkTypes: asStringArray(value.linkTypes),
    direction: asDirection(value.direction),
  };
}

function parsePatternSpec(value: unknown): RelationPatternSpec {
  if (!isRecord(value) || typeof value.pattern !== 'string') {
    throw new Error('invalid relational pattern spec');
  }
  if (value.seedGroups !== 1 && value.seedGroups !== 2) {
    throw new Error('invalid relational pattern seedGroups');
  }
  return {
    pattern: value.pattern,
    kind: asKind(value.kind),
    linkTypes: value.linkTypes == null ? null : asStringArray(value.linkTypes),
    direction: asDirection(value.direction),
    seedGroups: value.seedGroups,
    ...(value.extraSeeds === undefined ? {} : { extraSeeds: asStringArray(value.extraSeeds) }),
  };
}

function parseRelationVocab(value: unknown): RelationVocab | undefined {
  if (!isRecord(value)) return undefined;
  const vocab: RelationVocab = {};
  if (value.extra_link_types !== undefined) {
    vocab.extraLinkTypes = asStringArray(value.extra_link_types);
  }
  if (value.extra_verbs !== undefined) {
    if (!Array.isArray(value.extra_verbs)) throw new Error('invalid relational extra_verbs');
    vocab.extraVerbs = value.extra_verbs.map(parseVerbSpec);
  }
  if (value.extra_patterns !== undefined) {
    if (!Array.isArray(value.extra_patterns)) throw new Error('invalid relational extra_patterns');
    vocab.extraPatterns = value.extra_patterns.map(parsePatternSpec);
  }
  validateVocab(vocab);
  return vocab;
}

export function loadOperatorRelationVocab(): RelationVocab | undefined {
  if (loaded) return memo;
  loaded = true;

  const candidates = [
    join(process.cwd(), 'skills', '_brain-filing-rules.json'),
    join(__dirname, '..', '..', '..', 'skills', '_brain-filing-rules.json'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { relational_vocab?: unknown };
      if (!Object.prototype.hasOwnProperty.call(parsed, 'relational_vocab')) continue;
      memo = parseRelationVocab(parsed.relational_vocab);
      return memo;
    } catch { /* try next candidate */ }
  }

  memo = undefined;
  return undefined;
}
