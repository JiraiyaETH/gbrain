import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('PostgresEngine executeRaw abort cancellation', () => {
  test('consumes async cancel() rejections so aborted checks stay fail-open', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/core/postgres-engine.ts'), 'utf8');
    expect(source).toContain('const cancelResult = (pending as unknown as { cancel?: () => void | Promise<void> }).cancel?.();');
    expect(source).toContain('void Promise.resolve(cancelResult).catch(() => {});');
    expect(source).toContain('cannot surface');
  });
});
