// @ts-nocheck
import { describe, expect, it } from 'bun:test';
// @ts-ignore - skill script is plain ESM JavaScript, tested via Bun at runtime.
import {
  ALLOWED_NET,
  ALLOWED_OPERATORS,
  ALLOWED_OUTREACH,
  buildSyncCommand,
  buildUpdateCommand,
  normalizeOperator,
  plan,
  validateVisibleRow,
} from '../skills/consortium-operator-tracker/scripts/consortium-operator-tracker.mjs';

describe('consortium-operator-tracker deterministic helpers', () => {
  it('normalizes Tailored relationship evidence to Jiraiya while preserving operator-only output', () => {
    expect(normalizeOperator('Tailored/Jiraiya-confirm')).toBe('Jiraiya');
    expect(normalizeOperator('Jiraiya; Nutoro')).toBe('Jiraiya');
    expect(normalizeOperator('Alina → Rektonomist')).toBe('Alina');
    expect(normalizeOperator('Nutoro')).toBe('Nutoro');
    expect(normalizeOperator('')).toBe('');
  });

  it('validates the visible operator-facing enum fields', () => {
    const valid = validateVisibleRow({
      Protocol: 'Ankr',
      'X Handle': '@ankr',
      'Consortium Role': 'Vendor',
      PoC: 'via Rektonomist / @lstmax',
      'Connected with': 'Alina',
      'Outreach Status': 'Form sent',
      'Net Status': 'N/A',
    });
    expect(valid).toEqual({ ok: true, errors: [] });

    const invalid = validateVisibleRow({
      Protocol: 'Ankr',
      'X Handle': '@ankr',
      'Consortium Role': 'Service Provider',
      PoC: '',
      'Connected with': 'Tailored',
      'Outreach Status': 'Sent',
      'Net Status': 'Vendor',
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toContain('Consortium Role invalid');
    expect(invalid.errors.join('\n')).toContain('Connected with invalid');
    expect(invalid.errors.join('\n')).toContain('Outreach Status invalid');
    expect(invalid.errors.join('\n')).toContain('Net Status invalid');
  });

  it('builds safe update commands without executing live Google Sheet writes', () => {
    const command = buildUpdateCommand({
      protocol: 'Ankr',
      role: 'Vendor',
      outreachStatus: 'Form sent',
      netStatus: 'N/A',
      dryRun: true,
    });
    expect(command[0]).toBe('python3');
    expect(command).toContain('--protocol');
    expect(command).toContain('Ankr');
    expect(command).toContain('--outreach-status');
    expect(command).toContain('Form sent');
    expect(command).toContain('--dry-run');
  });

  it('rejects invalid status values before a mutating command can be produced', () => {
    expect(() => buildUpdateCommand({ protocol: 'Ankr', outreachStatus: 'Sent' })).toThrow();
    expect(() => buildUpdateCommand({ protocol: 'Ankr', netStatus: 'Vendor' })).toThrow();
    expect(() => buildUpdateCommand({ protocol: 'Ankr', netStatus: 'Consortium Vendor' })).toThrow('evidence is required');
    expect(() => buildUpdateCommand({ outreachStatus: 'Form sent' })).toThrow();
  });

  it('keeps protocol names with shell metacharacters as a single argv value', () => {
    const protocol = 'Bailsec; touch /tmp/should-not-run';
    const command = buildUpdateCommand({ protocol, outreachStatus: 'Form sent', dryRun: true });
    expect(command[0]).toBe('python3');
    expect(command).toContain('--protocol');
    expect(command[command.indexOf('--protocol') + 1]).toBe(protocol);
    expect(command.join(' ')).not.toContain('/bin/sh');
  });

  it('requires evidence for signed/agreed Net Status promotion and includes it as argv', () => {
    const command = buildUpdateCommand({
      canonicalId: 'ankr',
      netStatus: 'Consortium Vendor',
      evidence: 'Jiraiya confirmed signed/agreed in Telegram 2026-05-28',
    });
    expect(command).toContain('--evidence');
    expect(command[command.indexOf('--evidence') + 1]).toContain('signed/agreed');
  });

  it('exposes the canonical sync plan and allowed dropdown values', () => {
    const config = plan({ action: 'config' });
    expect(config.operatorTab).toBe('Operator Friendly');
    expect(config.allowedOperators).toEqual(ALLOWED_OPERATORS);
    expect(config.allowedOutreach).toEqual(ALLOWED_OUTREACH);
    expect(config.allowedNet).toEqual(ALLOWED_NET);

    const syncPlan = plan({ action: 'sync' });
    expect(syncPlan.command).toEqual(buildSyncCommand());
    expect(syncPlan.localCsv).toContain('consortium_operator_friendly.csv');
  });
});
