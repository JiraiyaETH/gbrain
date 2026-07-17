import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const skillDir = join(root, 'skills', 'agentic-research-system');
const skillPath = join(skillDir, 'SKILL.md');

function read(rel: string): string {
  return readFileSync(join(skillDir, rel), 'utf-8');
}

describe('agentic-research-system skill', () => {
  test('SKILL.md declares the core research QA contract', () => {
    const content = readFileSync(skillPath, 'utf-8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('name: agentic-research-system');
    expect(content).toContain('## Contract');
    expect(content).toContain('Subagent Structure is bounded proposal work');
    expect(content).toContain('The Cross-Model Eval Gate uses Skillify');
    expect(content).not.toContain('## Phase 4 — Subagent Structure');
    expect(content).not.toContain('## Phase 9 — Cross-Model Eval Gate');
    expect(content).toContain('6. **Evidence-before-belief.**');
    expect(content).toContain('Pre-Synthesis Validator');
    expect(content).toContain('No snippet citations');
    expect(content).toContain('Citation Auditor');
    expect(content).toContain('shared evidence/claim state');
    expect(content).toContain('editable DAG');
    expect(content).toContain('gap-frontier');
    expect(content).toContain('Brain-aware and Brain-blind');
    expect(content).toContain('evidence-before-belief');
  });

  test('all required templates exist and encode source/claim/eval receipts', () => {
    const required = [
      'templates/research-brief.md',
      'templates/source-ledger.md',
      'templates/source-card.json',
      'templates/claim-card.json',
      'templates/citation-registry.json',
      'templates/eval-report.md',
      'templates/eval-case.json',
      'templates/research-memo.md',
      'templates/run-receipt.md',
      'templates/research-dag.json',
      'templates/evidence-state.json',
    ];
    for (const rel of required) {
      expect(existsSync(join(skillDir, rel))).toBe(true);
    }
    expect(read('templates/source-ledger.md')).toContain('Rejected Sources');
    expect(read('templates/claim-card.json')).toContain('evidence_confidence');
    expect(read('templates/research-memo.md')).toContain('Recommendation strength');
    expect(read('templates/run-receipt.md')).toContain('Promotion Decision');
  });

  test('routing eval fixtures use the current expected intent schema', () => {
    const rows = read('routing-eval.jsonl')
      .split('\n')
      .filter(line => line.trim() && !line.trim().startsWith('//'))
      .map(line => JSON.parse(line));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(typeof row.intent).toBe('string');
      expect(typeof row.expected_skill).toBe('string');
    }
  });
});
