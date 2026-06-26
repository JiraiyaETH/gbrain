#!/usr/bin/env node
// normalize-timeline.mjs — deterministic repair/lint for brain-page `## Timeline`
// sections. Enforces the canonical gbrain format:
//
//     - **YYYY-MM-DD** | summary → [[link]]
//
// reverse-chronological (newest entry on top). Idempotent: re-running a
// canonical file is a no-op. Only the block under a `## Timeline` heading is
// touched; a block containing any non-bullet / dateless line is skipped whole
// (too risky to mangle). This is the deterministic half of the
// contract-ingestion skill — `gbrain extract timeline` only parses the bold
// date + pipe form, so a stray `- DATE — …` writes nothing to the structured
// timeline layer.
//
// Usage:  node normalize-timeline.mjs [--dry-run] <file-or-dir> [...]

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const targets = argv.filter((a) => a !== '--dry-run');
if (!targets.length) {
  console.error('usage: node normalize-timeline.mjs [--dry-run] <file-or-dir> ...');
  process.exit(2);
}

const DATE_RE = /\d{4}-\d{2}-\d{2}/;

function collect(target) {
  const st = statSync(target);
  if (st.isDirectory()) return readdirSync(target).flatMap((n) => collect(join(target, n)));
  return extname(target) === '.md' ? [target] : [];
}

function process_(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const tl = lines.findIndex((l) => /^##\s+Timeline\s*$/.test(l));
  if (tl === -1) return { path, status: 'no-timeline' };

  let end = lines.length;
  for (let i = tl + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(tl + 1, end);
  const bullets = block.filter((l) => l.trim().startsWith('- '));
  const stray = block.filter((l) => l.trim() && !l.trim().startsWith('- '));
  if (stray.length) return { path, status: 'skipped-nonbullet' };
  if (!bullets.length) return { path, status: 'empty' };

  const entries = [];
  for (const b of bullets) {
    const t = b.trim();
    const dm = t.match(DATE_RE);
    if (!dm) return { path, status: 'skipped-nodate' };
    const date = dm[0];
    let after = t.slice(2).trim();              // drop "- "
    after = after.replace(/^\*\*/, '');          // drop opening bold (if canonical already)
    after = after.slice(after.indexOf(date) + date.length); // drop the date
    after = after.replace(/^\*\*/, '').trim();   // drop closing bold
    after = after.replace(/^[—|–-]\s*/, '').trim(); // drop separator: em/en-dash, pipe, hyphen
    entries.push({ date, text: `- **${date}** | ${after}` });
  }
  entries.forEach((e, i) => (e.i = i));
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i);
  const newBlock = sorted.map((e) => e.text);
  const oldBlock = bullets.map((b) => b.trimEnd());
  if (JSON.stringify(newBlock) === JSON.stringify(oldBlock)) return { path, status: 'canonical' };

  let out = [...lines.slice(0, tl + 1), ...newBlock, ...lines.slice(end)].join('\n');
  if (!out.endsWith('\n')) out += '\n';
  if (!dryRun) writeFileSync(path, out);
  return { path, status: 'normalized', count: entries.length };
}

const files = targets.flatMap(collect);
const tally = {};
for (const f of files) {
  const r = process_(f);
  tally[r.status] = (tally[r.status] || 0) + 1;
  if (r.status === 'normalized') console.log(`${dryRun ? 'WOULD FIX' : 'FIXED'}  ${r.path}  (${r.count} entries)`);
  else if (r.status.startsWith('skipped')) console.log(`SKIP      ${r.path}  (${r.status})`);
}
console.log('\nsummary:', JSON.stringify(tally), dryRun ? '(dry-run, no writes)' : '');
