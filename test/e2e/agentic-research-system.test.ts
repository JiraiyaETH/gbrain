import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('agentic-research-system e2e fixture', () => {
  test('manual protocol has a complete trigger-to-memo artifact chain', () => {
    const root = process.cwd();
    const skill = readFileSync(join(root, 'skills', 'agentic-research-system', 'SKILL.md'), 'utf-8');
    const brief = readFileSync(join(root, 'skills', 'agentic-research-system', 'templates', 'research-brief.md'), 'utf-8');
    const ledger = readFileSync(join(root, 'skills', 'agentic-research-system', 'templates', 'source-ledger.md'), 'utf-8');
    const memo = readFileSync(join(root, 'skills', 'agentic-research-system', 'templates', 'research-memo.md'), 'utf-8');
    const receipt = readFileSync(join(root, 'skills', 'agentic-research-system', 'templates', 'run-receipt.md'), 'utf-8');

    expect(skill).toContain('protocol-lite brief');
    expect(skill).toContain('source acquisition router');
    expect(skill).toContain('citation audit');
    expect(brief).toContain('Scout Lanes');
    expect(ledger).toContain('Included Sources');
    expect(memo).toContain('Evidence Boundary');
    expect(receipt).toContain('Cross-Model Eval');
  });
});
