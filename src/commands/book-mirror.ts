/**
 * `gbrain book-mirror` — flagship of the v0.25.1 skills wave.
 *
 * Takes pre-extracted chapter text + context, fans out N read-only workers
 * (one per chapter), waits for all to complete, assembles the story-first
 * personalized mirror, and writes ONE put_page under
 * `media/books/<slug>-personalized.md` using the operator-trust path.
 *
 * Runtime lanes (--runtime):
 *   - `hermes` (default): shells out to `book_mirror_runner.py` which fans
 *     out Hermes CLI workers using the OpenAI Codex / ChatGPT subscription.
 *     Workers get no tools (`-t ""`) so book text cannot prompt-inject.
 *   - `call-claude`: shells out to `book_mirror_runner.py` which fans out
 *     via the call-claude wrapper using the Claude subscription (Opus).
 *   - `anthropic`: legacy lane using the Anthropic SDK minion queue.
 *     Requires ANTHROPIC_API_KEY and a running gbrain worker.
 *
 * Trust contract (D2/α + codex HIGH-1 fix):
 * - Anthropic lane: subagents have allowed_tools: ['get_page', 'search'] only.
 * - Hermes / call-claude lanes: workers have no tools at all.
 * - In all lanes, workers produce markdown text; the CLI assembles and
 *   writes one put_page with operator-level trust.
 *
 * The skill (skills/book-mirror/SKILL.md) handles EPUB/PDF extraction
 * via the agent's shell + python access (BeautifulSoup4, pdftotext) and
 * invokes this CLI with --chapters-dir pointing at the extracted text.
 * Separation of concerns: skill prepares inputs, CLI is the trusted
 * runtime.
 *
 * Cost: subscription lanes (hermes, call-claude) burn subscription quota,
 * not per-token API billing. Anthropic lane: ~$6 for a 20-chapter book at
 * Opus pricing. The CLI prints an estimate and prompts for confirmation
 * unless --no-confirm / --yes is passed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../core/minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData } from '../core/minions/types.ts';
import { operations } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';

const execFileAsync = promisify(execFile);

const COST_PER_CHAPTER_OPUS = 0.30;     // rough; depends on chapter length
const COST_PER_CHAPTER_SONNET = 0.06;
const COST_PER_CHAPTER_SUBSCRIPTION = 0; // burns subscription quota, not per-token
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_WORKERS = 4;              // queue concurrency hint; rate-leases enforce real cap
const BOOK_MIRROR_RUNNER = '/Users/jarvis/.hermes/profiles/alex/scripts/book_mirror_runner.py';
type RuntimeLane = 'hermes' | 'call-claude' | 'anthropic';

interface BookMirrorFlags {
  chaptersDir?: string;
  contextFile?: string;
  slug?: string;
  title?: string;
  author?: string;
  model: string;
  maxTurns: number;
  timeoutMs?: number;
  noConfirm: boolean;
  follow: boolean;
  dryRun: boolean;
  runtime: RuntimeLane;
  concurrency: number;
}

interface ChapterEntry {
  index: number;
  filename: string;
  fullPath: string;
  text: string;
  wordCount: number;
}

// ── arg parsing ────────────────────────────────────────────

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseFlags(args: string[]): BookMirrorFlags {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    process.exit(0);
  }

  const chaptersDir = parseFlag(args, '--chapters-dir');
  const contextFile = parseFlag(args, '--context-file');
  const slug = parseFlag(args, '--slug');
  const title = parseFlag(args, '--title');
  const author = parseFlag(args, '--author');
  const modelStr = parseFlag(args, '--model');
  const maxTurnsStr = parseFlag(args, '--max-turns');
  const timeoutMsStr = parseFlag(args, '--timeout-ms');
  const concurrencyStr = parseFlag(args, '--concurrency');
  const rawRuntime = parseFlag(args, '--runtime') ?? 'hermes';
  const validRuntimes: RuntimeLane[] = ['hermes', 'call-claude', 'anthropic'];
  const runtime = validRuntimes.includes(rawRuntime as RuntimeLane)
    ? (rawRuntime as RuntimeLane)
    : 'hermes';

  const defaultModel = runtime === 'anthropic' ? 'claude-opus-4-7'
    : runtime === 'call-claude' ? 'claude-opus-4-8'
    : 'gpt-5.5';

  return {
    chaptersDir,
    contextFile,
    slug,
    title,
    author,
    model: modelStr ?? defaultModel,
    maxTurns: maxTurnsStr ? parseInt(maxTurnsStr, 10) : DEFAULT_MAX_TURNS,
    timeoutMs: timeoutMsStr ? parseInt(timeoutMsStr, 10) : undefined,
    noConfirm: hasFlag(args, '--no-confirm') || hasFlag(args, '--yes'),
    follow: process.stdout.isTTY === true && !hasFlag(args, '--no-follow'),
    dryRun: hasFlag(args, '--dry-run'),
    runtime,
    concurrency: concurrencyStr ? parseInt(concurrencyStr, 10) : DEFAULT_WORKERS,
  };
}

function printHelp(): void {
  console.log(`gbrain book-mirror — personalized chapter-by-chapter book analysis

USAGE
  gbrain book-mirror --chapters-dir <path> --slug <slug> [flags]

REQUIRED
  --chapters-dir <path>     Directory containing chapter text files (.txt).
                            Files sort alphabetically; chapter order = sort order.
                            The skill (skills/book-mirror/SKILL.md) handles EPUB
                            and PDF extraction; this CLI takes pre-extracted
                            chapter text as its input contract.
  --slug <slug>             Brain page slug (kebab-case, no leading slash).
                            Output lands at media/books/<slug>-personalized.md.

OPTIONAL
  --runtime <lane>          Model runtime lane. Default: hermes.
                            - hermes: Hermes CLI workers via OpenAI Codex / ChatGPT
                              subscription. Workers get no tools.
                            - call-claude: Claude Opus via the call-claude wrapper
                              using the Claude Max subscription.
                            - anthropic: Legacy Anthropic SDK minion queue. Requires
                              ANTHROPIC_API_KEY and a running gbrain worker.
  --context-file <path>     Path to a context pack (USER.md + SOUL.md + memory
                            excerpts + entity searches). Embedded in every
                            child worker's prompt. The skill prepares this.
  --title "<title>"         Book title (used in the assembled page header).
                            Defaults to slug if omitted.
  --author "<author>"       Book author (used in frontmatter + page header).
  --model <id>              Model string for the chosen runtime lane.
                            Default depends on --runtime: gpt-5.5 (hermes),
                            claude-opus-4-8 (call-claude), claude-opus-4-7 (anthropic).
  --concurrency <n>         Parallel workers. Default: ${DEFAULT_WORKERS}.
  --max-turns <n>           Per-chapter worker turn budget. Default ${DEFAULT_MAX_TURNS}.
  --timeout-ms <n>          Per-chapter wall-clock timeout.
  --no-confirm / --yes      Skip the cost-estimate confirmation prompt.
  --no-follow               Submit and exit; don't tail children (anthropic only).
  --dry-run                 Validate inputs + print plan; submit nothing.

TRUST CONTRACT (read this)
  Subscription lanes (hermes, call-claude): workers have zero tools. Book text
  cannot prompt-inject into file writes or external actions.
  Anthropic lane: subagents have allowed_tools restricted to ['get_page', 'search']
  — read-only. In all lanes, THIS CLI assembles all worker outputs and writes
  one put_page under media/books/<slug>-personalized.md with operator trust.

COST
  Subscription lanes burn ChatGPT / Claude Max quota, not per-token API billing.
  Anthropic lane: ~$${COST_PER_CHAPTER_OPUS.toFixed(2)} per chapter at Opus.
  The CLI prints an estimate before launching.

EXAMPLES
  # Default (GPT-5.5 via Hermes CLI):
  gbrain book-mirror \\
    --chapters-dir /tmp/books/the-goal/chapters \\
    --context-file /tmp/books/the-goal/context.md \\
    --slug the-goal \\
    --title "The Goal" \\
    --author "Eliyahu Goldratt"

  # Claude Opus via call-claude:
  gbrain book-mirror --runtime call-claude \\
    --chapters-dir ./chapters --slug test

  # Dry run (no worker submission, just plan):
  gbrain book-mirror --chapters-dir ./chapters --slug test --dry-run
`);
}

// ── chapter loading ────────────────────────────────────────

function loadChapters(dir: string): ChapterEntry[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`--chapters-dir not found: ${dir}`);
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`--chapters-dir is not a directory: ${dir}`);
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .txt files in --chapters-dir: ${dir}`);
  }
  const chapters: ChapterEntry[] = [];
  for (let i = 0; i < files.length; i++) {
    const filename = files[i]!;
    const fullPath = path.join(dir, filename);
    const text = fs.readFileSync(fullPath, 'utf8');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    chapters.push({
      index: i + 1,
      filename,
      fullPath,
      text,
      wordCount,
    });
  }
  return chapters;
}

// ── cost confirm ───────────────────────────────────────────

function estimateCost(chapters: ChapterEntry[], model: string, runtime: RuntimeLane): number {
  if (runtime !== 'anthropic') return COST_PER_CHAPTER_SUBSCRIPTION;
  const perChapter = model.includes('opus') ? COST_PER_CHAPTER_OPUS : COST_PER_CHAPTER_SONNET;
  return chapters.length * perChapter;
}

async function confirmInteractive(estimateUsd: number, chapters: number): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    // Non-TTY: refuse to spend without an explicit --yes / --no-confirm.
    process.stderr.write(
      `gbrain book-mirror: refusing to spend ~$${estimateUsd.toFixed(2)} on ${chapters} chapters from a non-TTY context. ` +
      `Pass --yes to confirm.\n`
    );
    return false;
  }
  process.stderr.write(
    `\nThis will spawn ${chapters} subagent jobs at ~$${(estimateUsd / chapters).toFixed(2)} each = ~$${estimateUsd.toFixed(2)} total.\n` +
    `Continue? [y/N] `
  );
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      const reply = chunk.toString().trim().toLowerCase();
      resolve(reply === 'y' || reply === 'yes');
      process.stdin.pause();
    });
    process.stdin.resume();
  });
}

// ── prompt assembly ────────────────────────────────────────

function buildChapterPrompt(
  chapter: ChapterEntry,
  totalChapters: number,
  bookTitle: string,
  bookAuthor: string | undefined,
  contextPack: string | undefined,
): string {
  const authorLine = bookAuthor ? ` by ${bookAuthor}` : '';
  const contextSection = contextPack
    ? `\n\n## READER CONTEXT\n\n${contextPack}\n\n`
    : '\n\n## READER CONTEXT\n\n(No context pack supplied; personalization will be limited to brain-search-discoverable content.)\n\n';

  return `You are analyzing one chapter of "${bookTitle}"${authorLine} for the user.

Your output is a story-first personalized reading companion. First reconstruct the chapter as a coherent narrative/anecdote so the reader can follow the POVs, stakes, sequence, character archetypes, and concrete scene texture before any personalization appears. Then add a short selective assimilation layer: extraction, belief challenge, reinforcement, discard, tiny lever, watch-in-life, or no strong fit. Do not force every idea into the user's projects or life domains.

This is chapter ${chapter.index} of ${totalChapters}.

## CHAPTER ${chapter.index} TEXT (full, do not summarize this away)

${chapter.text}
${contextSection}

## OUTPUT

Return ONLY a single markdown section in this exact shape:

\`\`\`
## Chapter ${chapter.index}: [Title from the chapter — extract or infer]

### Story Spine
[Tell the chapter in chronological order as a readable narrative. Do not personalize here. Preserve the anecdote, scene progression, character POV, stakes, concrete details, important quotes, and how the situation feels from inside the story. 5-10 short paragraphs depending on density.]

### Operating Cast / Archetypes
- **[Person / role]:** [What they want, how they see the situation, what pressure they are under, what they notice/miss, and how they respond.]
- **[Next person / role]:** [...]

### Mechanisms in the Story
- **[Mechanism name]:** [What the anecdote teaches about how systems/people operate. Explain from the story outward.]
- **[Next mechanism]:** [...]

### Mirror / Assimilation Notes
- **[collision label]:** [Only after the story is clear: the specific extraction, belief pressure, archetype profile, tiny lever, or discard. Use reader context only where it truly sharpens the note. If there is no strong personal collision, preserve the story/mechanism without forcing one.]
- **[next selective note]:** [...]

### Chapter Takeaway
[1-3 sentences: what should stick after reading this chapter. Prefer a memorable question, archetype, or mechanism over advice.]
\`\`\`

## RULES

- Story first. Do not interrupt the narrative with Jiraiya, Tailored, Hermes, money, or any other reader mapping.
- Preserve the anecdote enough that the reader can build profiles and schemas around how the characters think and operate.
- Mirror second. Commentary is a short assimilation layer after the story, not a paragraph-by-paragraph injection engine.
- Use 2-5 Mirror / Assimilation Notes only. If everything feels relevant, you have failed to prioritize.
- Do not use markdown tables for the main chapter output; long tables fragment the story and are hard to read.
- Never generic ("This might apply if you've ever felt..."). Never sycophantic. Never preach.

You have ${DEFAULT_MAX_TURNS} turns and read-only tools (get_page, search). You CANNOT call put_page — your output is the markdown text in your final message. The CLI assembles all chapters and writes the brain page.

When done, your final message should contain ONLY the \`## Chapter ${chapter.index}: ...\` section above. No preamble, no postscript, no commentary.`;
}

function extractReaderContextManifest(contextPack: string | undefined): string {
  if (!contextPack || !contextPack.trim()) {
    return 'No reader-context pack supplied.';
  }
  const lines = contextPack.split('\n');
  const start = lines.findIndex(line => /^#\s*Reader Context Manifest\s*$/i.test(line.trim()));
  if (start < 0) {
    return 'Reader-context pack was supplied, but it did not include a `# Reader Context Manifest` section. Treat personalization provenance as incomplete.';
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#\s+\S/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim() || 'Reader Context Manifest was present but empty.';
}

function buildAssembledPage(opts: {
  slug: string;
  title: string;
  author: string | undefined;
  contextPack: string | undefined;
  chapterAnalyses: Array<{ index: number; result: string; failed: boolean; error?: string }>;
}): string {
  const today = new Date().toISOString().split('T')[0];
  const authorLine = opts.author ? `\nauthor: "${opts.author}"` : '';
  const contextManifest = extractReaderContextManifest(opts.contextPack);

  const frontmatter = `---
title: "${opts.title} — Personalized"
type: book-analysis${authorLine}
date: ${today}
context: "${contextManifest.split('\n').slice(0, 3).join(' ').slice(0, 200).replace(/"/g, '\\"')}"
tags: [book, personalized, story-first, mirror]
---`;

  const intro = `# ${opts.title} — Personalized

## What this is

A chapter-by-chapter personalized reading companion for *${opts.title}*${opts.author ? ` by ${opts.author}` : ''}. Each chapter is first reconstructed as a coherent story/anecdote so the reader can follow the POVs, stakes, character archetypes, and sequence of events before any personalization appears. The mirror layer comes second: a small set of source-disclosed assimilation notes that preserve natural collisions, belief pressure, tiny levers, discards, and honest misses without fragmenting the reading experience.

This page was generated by \`gbrain book-mirror\`. Each chapter analysis came from a separate read-only subagent that had access to the chapter text and a reader-context pack but no write tools — so the brain wasn't modified during the per-chapter analysis. This page is the only artifact written.

## Reader Context Manifest

${contextManifest}

`;

  const failedSection = opts.chapterAnalyses
    .filter(a => a.failed)
    .map(a => `> Chapter ${a.index}: analysis failed (${a.error ?? 'unknown error'}). Re-run \`gbrain book-mirror\` to retry; idempotent on the same inputs.`)
    .join('\n\n');

  const failedHeader = failedSection
    ? `\n\n## Failed chapters (${opts.chapterAnalyses.filter(a => a.failed).length})\n\n${failedSection}\n\n---\n`
    : '';

  const completed = opts.chapterAnalyses
    .filter(a => !a.failed)
    .sort((a, b) => a.index - b.index)
    .map(a => a.result.trim())
    .join('\n\n---\n\n');

  return `${frontmatter}\n\n${intro}${failedHeader}\n${completed}\n`;
}

// ── main entry ─────────────────────────────────────────────

export async function runBookMirrorCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (!flags.chaptersDir) {
    console.error('gbrain book-mirror: --chapters-dir is required. Run with --help.');
    process.exit(2);
  }
  if (!flags.slug) {
    console.error('gbrain book-mirror: --slug is required. Run with --help.');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(flags.slug)) {
    console.error(`gbrain book-mirror: invalid --slug "${flags.slug}". Use kebab-case (a-z, 0-9, hyphens).`);
    process.exit(2);
  }
  if (flags.contextFile && !fs.existsSync(flags.contextFile)) {
    console.error(`gbrain book-mirror: --context-file not found: ${flags.contextFile}`);
    process.exit(2);
  }

  // Load chapter files.
  let chapters: ChapterEntry[];
  try {
    chapters = loadChapters(flags.chaptersDir);
  } catch (e) {
    console.error(`gbrain book-mirror: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const contextPack = flags.contextFile ? fs.readFileSync(flags.contextFile, 'utf8') : undefined;
  const bookTitle = flags.title ?? flags.slug;
  const targetSlug = `media/books/${flags.slug}-personalized`;

  process.stderr.write(
    `\ngbrain book-mirror — plan\n` +
    `  slug:        ${flags.slug}\n` +
    `  output:      ${targetSlug}\n` +
    `  chapters:    ${chapters.length} (from ${flags.chaptersDir})\n` +
    `  context:     ${flags.contextFile ?? '(none)'}\n` +
    `  runtime:     ${flags.runtime}\n` +
    `  model:       ${flags.model}\n` +
    `  max_turns:   ${flags.maxTurns}\n` +
    `  concurrency: ${flags.concurrency}\n`
  );

  const estimateUsd = estimateCost(chapters, flags.model, flags.runtime);
  const costLabel = flags.runtime === 'anthropic'
    ? `~$${estimateUsd.toFixed(2)} (${chapters.length} subagents)`
    : `subscription quota (${chapters.length} workers)`;
  process.stderr.write(`  est. cost:   ${costLabel}\n\n`);

  if (flags.dryRun) {
    process.stderr.write(`gbrain book-mirror: --dry-run — exiting without submission.\n`);
    return;
  }

  if (!flags.noConfirm) {
    const ok = await confirmInteractive(estimateUsd, chapters.length);
    if (!ok) {
      process.stderr.write(`gbrain book-mirror: cancelled by user.\n`);
      process.exit(0);
    }
  }

  // ── Subscription lanes (hermes / call-claude) ──────────────
  // Shell out to the Python runner which handles Hermes CLI workers
  // or call-claude wrapper fanout. It writes the assembled page to a
  // file, and we read it back and write to brain via put_page.
  if (flags.runtime !== 'anthropic') {
    const analyses = await runSubscriptionLane(flags, chapters, bookTitle, contextPack);

    const failed = analyses.filter(a => a.failed).length;
    const completed = analyses.length - failed;
    process.stderr.write(`\nassembled: ${completed} chapters successful, ${failed} failed.\n`);

    if (completed === 0) {
      console.error('gbrain book-mirror: every chapter failed. Not writing the brain page.');
      process.exit(1);
    }

    const assembled = buildAssembledPage({
      slug: flags.slug!,
      title: bookTitle,
      author: flags.author,
      contextPack,
      chapterAnalyses: analyses,
    });

    await writeBrainPage(engine, targetSlug, assembled, chapters.length, completed, failed);
    return;
  }

  // ── Legacy Anthropic lane ──────────────────────────────────
  // Submit fan-out: N children, no aggregator. Each child gets read-only
  // tools so the codex HIGH-1 prompt-injection vector is closed at the
  // tool-allowlist layer rather than at allowedSlugPrefixes scope.
  const queue = new MinionQueue(engine);
  const childIds: number[] = [];
  for (const ch of chapters) {
    const data: SubagentHandlerData = {
      prompt: buildChapterPrompt(ch, chapters.length, bookTitle, flags.author, contextPack),
      model: flags.model,
      max_turns: flags.maxTurns,
      // CODEX HIGH-1 FIX: read-only tool allowlist. Subagents cannot call
      // put_page or any mutating op. Their only output is final_message text.
      allowed_tools: ['get_page', 'search'],
    };
    const submitOpts: Partial<MinionJobInput> = {
      max_stalled: 3,
      // Loose idempotency: same chapter file + slug → same idempotency key,
      // so re-running the CLI on identical input dedups against the queue.
      idempotency_key: `book-mirror:${flags.slug}:ch-${ch.index}`,
    };
    if (flags.timeoutMs) submitOpts.timeout_ms = flags.timeoutMs;
    const job = await queue.add(
      'subagent',
      data as unknown as Record<string, unknown>,
      submitOpts,
      { allowProtectedSubmit: true },
    );
    childIds.push(job.id);
  }

  process.stderr.write(
    `submitted: ${childIds.length} subagent jobs (${childIds[0]}..${childIds[childIds.length - 1]})\n`
  );

  if (!flags.follow) {
    process.stdout.write(JSON.stringify({ child_ids: childIds, slug: targetSlug }) + '\n');
    process.stderr.write(
      `gbrain book-mirror: detached. Run \`gbrain jobs get <id>\` per child, then re-run with same args once all are complete.\n`
    );
    return;
  }

  // Wait for every child. Order doesn't matter for the wait, but it does
  // matter for the assembly — we sort by chapter index in buildAssembledPage.
  process.stderr.write(`waiting for all ${childIds.length} chapters to complete...\n`);
  const analyses: Array<{ index: number; result: string; failed: boolean; error?: string }> = [];
  for (let i = 0; i < childIds.length; i++) {
    const childId = childIds[i]!;
    const chapterIndex = chapters[i]!.index;
    try {
      const job = await waitForCompletion(queue, childId, {
        timeoutMs: flags.timeoutMs ?? 30 * 60 * 1000, // 30 min per child
        pollMs: 1000,
      });
      if (job.status === 'completed' && job.result && typeof job.result === 'object') {
        const result = (job.result as { result?: string }).result ?? '';
        analyses.push({ index: chapterIndex, result, failed: false });
        process.stderr.write(`  chapter ${chapterIndex}: complete (job ${childId})\n`);
      } else {
        analyses.push({
          index: chapterIndex,
          result: '',
          failed: true,
          error: `job ${childId} status=${job.status}`,
        });
        process.stderr.write(`  chapter ${chapterIndex}: FAILED (job ${childId} status=${job.status})\n`);
      }
    } catch (e) {
      const msg = e instanceof TimeoutError
        ? `timeout after ${e.elapsedMs}ms`
        : (e instanceof Error ? e.message : String(e));
      analyses.push({ index: chapterIndex, result: '', failed: true, error: msg });
      process.stderr.write(`  chapter ${chapterIndex}: ERROR — ${msg}\n`);
    }
  }

  const failed = analyses.filter(a => a.failed).length;
  const completed = analyses.length - failed;
  process.stderr.write(
    `\nassembled: ${completed} chapters successful, ${failed} failed.\n`
  );

  if (completed === 0) {
    console.error(`gbrain book-mirror: every chapter failed. Not writing the brain page. Re-run after diagnosing.`);
    process.exit(1);
  }

  // Assemble the final page.
  const assembled = buildAssembledPage({
    slug: flags.slug!,
    title: bookTitle,
    author: flags.author,
    contextPack,
    chapterAnalyses: analyses,
  });

  await writeBrainPage(engine, targetSlug, assembled, chapters.length, completed, failed);
}

// ── shared helpers ──────────────────────────────────────────

async function writeBrainPage(
  engine: BrainEngine,
  targetSlug: string,
  assembled: string,
  chaptersTotal: number,
  chaptersCompleted: number,
  chaptersFailed: number,
): Promise<void> {
  const putPageOp = operations.find(op => op.name === 'put_page');
  if (!putPageOp) {
    throw new Error('internal: put_page operation not registered');
  }

  await putPageOp.handler(
    {
      engine,
      config: loadConfig() || { engine: 'postgres' },
      logger: { info: console.log, warn: console.warn, error: console.error },
      dryRun: false,
      remote: false,             // local CLI caller — operator trust path; viaSubagent intentionally omitted
      cliOpts: getCliOptions(),
      sourceId: process.env.GBRAIN_SOURCE ?? 'default',
    },
    {
      slug: targetSlug,
      content: assembled,
      source: process.env.GBRAIN_SOURCE ?? 'default',
    },
  );

  process.stderr.write(`\nwrote: ${targetSlug} (${chaptersTotal} chapter sections, ${assembled.length} bytes)\n`);
  process.stdout.write(JSON.stringify({
    slug: targetSlug,
    chapters_total: chaptersTotal,
    chapters_completed: chaptersCompleted,
    chapters_failed: chaptersFailed,
  }) + '\n');

  if (chaptersFailed > 0) {
    process.stderr.write(
      `\ngbrain book-mirror: ${chaptersFailed} chapter(s) failed. The page was written with the completed chapters; run again to retry the failed ones.\n`
    );
    process.exit(1);
  }
}

async function runSubscriptionLane(
  flags: BookMirrorFlags,
  chapters: ChapterEntry[],
  bookTitle: string,
  contextPack: string | undefined,
): Promise<Array<{ index: number; result: string; failed: boolean; error?: string }>> {
  // Build the Python runner args
  const runnerArgs: string[] = [
    BOOK_MIRROR_RUNNER,
    '--chapters-dir', flags.chaptersDir!,
    '--slug', flags.slug!,
    '--title', bookTitle,
    '--runtime', flags.runtime,
    '--model', flags.model,
    '--concurrency', String(flags.concurrency),
    '--max-turns', String(flags.maxTurns),
    '--yes',
  ];
  if (flags.author) runnerArgs.push('--author', flags.author);
  if (flags.contextFile) runnerArgs.push('--context-file', flags.contextFile);
  if (flags.timeoutMs) runnerArgs.push('--timeout', String(Math.floor(flags.timeoutMs / 1000)));

  process.stderr.write(`  runner:      ${BOOK_MIRROR_RUNNER}\n`);
  process.stderr.write(`  runner args: ${runnerArgs.slice(1).join(' ')}\n\n`);

  const env = { ...process.env, GBRAIN_SOURCE: process.env.GBRAIN_SOURCE ?? 'default' };

  try {
    const { stdout, stderr } = await execFileAsync('python3', runnerArgs, {
      env,
      maxBuffer: 50 * 1024 * 1024, // 50 MB — large books produce large output
      timeout: (flags.timeoutMs ?? 30 * 60 * 1000) * Math.max(chapters.length, 1),
    });

    if (stderr) {
      // Forward runner stderr lines (progress) to our stderr
      for (const line of stderr.split('\n')) {
        if (line.trim()) process.stderr.write(`  [runner] ${line}\n`);
      }
    }

    // Parse the assembled output path from the runner's stdout
    const assembledMatch = stdout.match(/assembled=(.+)$/m);
    if (!assembledMatch) {
      throw new Error(`runner did not produce an assembled file. stdout:\n${stdout}`);
    }
    const assembledPath = assembledMatch[1]!.trim();

    // Read the assembled file and extract per-chapter sections
    const assembledContent = fs.readFileSync(assembledPath, 'utf8');

    // Split on chapter headers: each section starts with "## Chapter N:"
    const chapterRegex = /^## Chapter \d+:.*$(?:\n(?!^## Chapter).*)*/gm;
    const chapterSections: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = chapterRegex.exec(assembledContent)) !== null) {
      chapterSections.push(match[0].trim());
    }

    const analyses: Array<{ index: number; result: string; failed: boolean; error?: string }> = [];
    for (let i = 0; i < chapters.length; i++) {
      const section = chapterSections[i];
      if (section) {
        analyses.push({ index: i + 1, result: section.trim(), failed: false });
      } else {
        analyses.push({ index: i + 1, result: '', failed: true, error: 'no output from runner' });
      }
    }
    return analyses;
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`gbrain book-mirror: subscription lane failed: ${msg}\n`);
    // If the error is from execFile, stdout/stderr may be attached
    const execErr = e as { stdout?: string; stderr?: string; code?: string };
    if (execErr.stdout) process.stderr.write(`  runner stdout: ${execErr.stdout.slice(0, 2000)}\n`);
    if (execErr.stderr) process.stderr.write(`  runner stderr: ${execErr.stderr.slice(0, 2000)}\n`);
    // Return all chapters as failed
    return chapters.map(ch => ({
      index: ch.index,
      result: '',
      failed: true,
      error: msg,
    }));
  }
}
