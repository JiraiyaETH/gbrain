#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_TEMPLATES = [
  'research-brief.md',
  'source-ledger.md',
  'source-card.json',
  'claim-card.json',
  'citation-registry.json',
  'eval-report.md',
  'eval-case.json',
  'research-memo.md',
  'run-receipt.md',
  'research-dag.json',
  'evidence-state.json',
];

export function validateSkillTree(skillDir = new URL('..', import.meta.url).pathname) {
  const missing = [];
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) missing.push('SKILL.md');
  const skill = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
  for (const template of REQUIRED_TEMPLATES) {
    const rel = join('templates', template);
    if (!existsSync(join(skillDir, rel))) missing.push(rel);
  }
  const requiredPhrases = [
    'Brain-first lookup',
    'Subagent Structure',
    'Citation Audit',
    'Cross-Model Eval Gate',
    'Promotion Decision',
  ];
  for (const phrase of requiredPhrases) {
    if (!skill.includes(phrase)) missing.push(`SKILL.md phrase: ${phrase}`);
  }
  return { ok: missing.length === 0, missing };
}

if (import.meta.main) {
  const target = process.argv[2] || new URL('..', import.meta.url).pathname;
  const result = validateSkillTree(target);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
