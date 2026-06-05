import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('jobs --follow status polling', () => {
  test('does not use a naked async setInterval callback for queue.getJob polling', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/commands/jobs.ts'), 'utf8');
    expect(source).not.toMatch(/setInterval\(async\s*\(\)\s*=>\s*\{[\s\S]{0,300}?queue\.getJob\(job\.id\)/);
    expect(source).toContain('status poll connection blip');
    expect(source).toContain('backing off to');
    expect(source).toContain('isRetryableConnError(err)');
    expect(source).toContain('pollInFlight');
    expect(source).toContain('schedulePoll');
  });
});
