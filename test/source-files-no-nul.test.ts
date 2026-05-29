import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOTS = ['src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function hasSourceExtension(path: string): boolean {
  return Array.from(EXTENSIONS).some((ext) => path.endsWith(ext));
}

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkSourceFiles(path));
    } else if (stat.isFile() && hasSourceExtension(path)) {
      files.push(path);
    }
  }
  return files;
}

describe('source files are Postgres-text safe', () => {
  test('tracked runtime source files do not contain literal NUL bytes', () => {
    const offenders: string[] = [];

    for (const root of SOURCE_ROOTS) {
      for (const file of walkSourceFiles(root)) {
        const bytes = readFileSync(file);
        const nulIndex = bytes.indexOf(0);
        if (nulIndex >= 0) {
          offenders.push(`${relative(process.cwd(), file)}@${nulIndex}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
