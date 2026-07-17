/**
 * shell-subagent handler.
 *
 * Runs a local Claude Code CLI process (`claude -p`) under Minions
 * supervision, then parses explicit page blocks from stdout and writes them
 * through the same put_page operation path used by native subagents. This
 * keeps the LLM process tool-free while preserving server-side slug
 * allow-list enforcement.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import { loadConfig } from '../../config.ts';
import { operations, type OperationContext } from '../../operations.ts';
import { serializeMarkdown } from '../../markdown.ts';
import { splitProviderModelId } from '../../model-id.ts';
import type { MinionJobContext, SubagentHandlerData } from '../types.ts';

const DEFAULT_CLAUDE_BIN = 'claude';
const STDOUT_MAX_CHARS = 64 * 1024;
const STDERR_MAX_CHARS = 16 * 1024;
const KILL_GRACE_MS = 5000;

const OUTPUT_CONTRACT = `

GBRAIN PAGE OUTPUT CONTRACT
You do not have brain tools in this mode. If you want to write pages, emit each
page as exactly one fenced block in this format:

\`\`\`gbrain-page
slug: <slug exactly as given by the task templates above>
type: <page type fitting the content, e.g. personal or idea>
---
# Page title

Page body with wikilinks.
\`\`\`

Rules:
- Do not emit page writes outside \`\`\`gbrain-page\`\`\` fences.
- The slug must match the allowed paths described in the prompt.
- The handler will reject any slug outside the server-side allow-list.
- If there are no pages worth writing, emit no page blocks.
`;

interface ShellSubagentDeps {
  engine: BrainEngine;
  config?: GBrainConfig;
}

interface ParsedPageBlock {
  slug: string;
  type: string;
  body: string;
}

export interface ShellSubagentResult {
  result: string;
  turns_count: 1;
  stop_reason: 'end_turn';
  tokens: { in: 0; out: 0; cache_read: 0; cache_create: 0 };
  written_slugs: string[];
  rejected_slugs: Array<{ slug: string; reason: string }>;
  rejected_blocks: Array<{ reason: string }>;
  stdout_tail: string;
  stderr_tail: string;
  exit_code: number;
}

export function makeShellSubagentHandler(deps: ShellSubagentDeps) {
  const engine = deps.engine;
  const config = deps.config ?? loadConfig() ?? ({ engine: 'postgres' } as GBrainConfig);
  const putPageOp = operations.find(op => op.name === 'put_page');
  if (!putPageOp) throw new Error('put_page operation is not registered');

  return async function shellSubagentHandler(ctx: MinionJobContext): Promise<ShellSubagentResult> {
    const data = (ctx.data ?? {}) as unknown as SubagentHandlerData;
    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new Error('shell-subagent job data.prompt is required (string)');
    }

    const claudeBin = (await engine.getConfig('dream.synthesize.claude_bin').catch(() => null))?.trim()
      || DEFAULT_CLAUDE_BIN;
    // The job payload already carries the resolved model (the dream cycle sets
    // it for queue-validation). Pin the spawned `claude -p` to it instead of
    // letting the process inherit the interactive CLI's configured model.
    const cliModel = resolveCliModel(data.model);
    const prompt = `${data.prompt}${OUTPUT_CONTRACT}`;
    const { stdout, stderr, exitCode } = await runClaudePrint(claudeBin, prompt, ctx, cliModel);
    if (exitCode !== 0) {
      throw new Error(`shell-subagent claude process exited ${exitCode}: ${tail(stderr, STDERR_MAX_CHARS)}`);
    }

    const parsed = parsePageBlocks(stdout);
    const written = new Set<string>();
    const rejectedSlugs: Array<{ slug: string; reason: string }> = [];
    const opCtx = buildPutPageContext({
      engine,
      config,
      jobId: ctx.id,
      allowedSlugPrefixes: data.allowed_slug_prefixes,
      brainId: data.brain_id,
      sourceId: typeof data.source_id === 'string' && data.source_id.length > 0 ? data.source_id : undefined,
      dreamOutputCycleDate: typeof data.dream_output_cycle_date === 'string'
        ? data.dream_output_cycle_date
        : undefined,
    });

    for (const block of parsed.blocks) {
      const content = renderBlockContent(block);
      try {
        await putPageOp.handler(opCtx, { slug: block.slug, content });
        written.add(block.slug);
      } catch (err) {
        rejectedSlugs.push({
          slug: block.slug,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      result: stdout,
      turns_count: 1,
      stop_reason: 'end_turn',
      tokens: { in: 0, out: 0, cache_read: 0, cache_create: 0 },
      written_slugs: [...written].sort(),
      rejected_slugs: rejectedSlugs,
      rejected_blocks: parsed.rejectedBlocks,
      stdout_tail: tail(stdout, STDOUT_MAX_CHARS),
      stderr_tail: tail(stderr, STDERR_MAX_CHARS),
      exit_code: exitCode,
    };
  };
}

function buildPutPageContext(opts: {
  engine: BrainEngine;
  config: GBrainConfig;
  jobId: number;
  allowedSlugPrefixes?: string[];
  brainId?: string;
  sourceId?: string;
  dreamOutputCycleDate?: string;
}): OperationContext {
  return {
    engine: opts.engine,
    config: opts.config,
    logger: {
      info: (msg: string) => process.stderr.write(`[shell-subagent:${opts.jobId}] ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`[shell-subagent:${opts.jobId}] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[shell-subagent:${opts.jobId}] ERROR: ${msg}\n`),
    },
    dryRun: false,
    remote: true,
    sourceId: opts.sourceId ?? 'default',
    jobId: opts.jobId,
    subagentId: opts.jobId,
    viaSubagent: true,
    brainId: opts.brainId,
    allowedSlugPrefixes: opts.allowedSlugPrefixes ? [...opts.allowedSlugPrefixes] : undefined,
    dreamOutputCycleDate: opts.dreamOutputCycleDate,
  };
}

/**
 * Normalize a job-payload model id into the value the local `claude` CLI's
 * `--model` flag accepts.
 *
 * The dream cycle stores a provider-qualified id (e.g.
 * `anthropic:claude-opus-4-8`) because the Minions queue validator
 * (classifyCapabilities → resolveRecipe) requires the `provider:` prefix. The
 * `claude` CLI wants a bare alias or full model name (e.g. `opus` or
 * `claude-opus-4-8`), so strip the provider here. Returns null when no usable
 * model is present, which preserves the pre-existing behavior (no `--model`
 * flag → `claude -p` uses its own configured default).
 */
function resolveCliModel(rawModel: unknown): string | null {
  if (typeof rawModel !== 'string' || rawModel.trim().length === 0) return null;
  const { model } = splitProviderModelId(rawModel);
  const bare = model.trim();
  return bare.length > 0 ? bare : null;
}

/**
 * Build the argv for the `claude -p` spawn. Appends `--model <id>` only when a
 * model is pinned; identical to the historical `['-p']` when absent.
 */
function buildClaudeArgs(cliModel: string | null): string[] {
  return cliModel ? ['-p', '--model', cliModel] : ['-p'];
}

async function runClaudePrint(
  claudeBin: string,
  prompt: string,
  ctx: MinionJobContext,
  cliModel: string | null,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let proc: ChildProcess;
  try {
    proc = spawn(claudeBin, buildClaudeArgs(cliModel), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  let stdout = '';
  let stderr = '';
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const kill = () => {
    if (killTimer !== null) return;
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }, KILL_GRACE_MS);
  };
  ctx.signal.addEventListener('abort', kill);
  ctx.shutdownSignal.addEventListener('abort', kill);
  if (ctx.signal.aborted || ctx.shutdownSignal.aborted) kill();

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      if (code !== null) resolve(code);
      else if (signal === 'SIGTERM') resolve(143);
      else if (signal === 'SIGKILL') resolve(137);
      else resolve(-1);
    });
    proc.stdin?.end(prompt);
  }).finally(() => {
    if (killTimer !== null) clearTimeout(killTimer);
    ctx.signal.removeEventListener('abort', kill);
    ctx.shutdownSignal.removeEventListener('abort', kill);
  });

  return { stdout, stderr, exitCode };
}

function parsePageBlocks(text: string): { blocks: ParsedPageBlock[]; rejectedBlocks: Array<{ reason: string }> } {
  const blocks: ParsedPageBlock[] = [];
  const rejectedBlocks: Array<{ reason: string }> = [];
  const fenceRe = /```gbrain-page\s*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fenceRe)) {
    const raw = match[1] ?? '';
    const parsed = parseOnePageBlock(raw);
    if ('reason' in parsed) rejectedBlocks.push({ reason: parsed.reason });
    else blocks.push(parsed);
  }
  return { blocks, rejectedBlocks };
}

function parseOnePageBlock(raw: string): ParsedPageBlock | { reason: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let slug: string | null = null;
  let type: string | null = null;
  let bodyStart = 0;

  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i]!.trim();
    if (line === '---') {
      bodyStart = i + 1;
      break;
    }
    const combined = /^slug:\s*([^\s]+)\s+type:\s*([a-z][a-z0-9_-]*)$/i.exec(line);
    if (combined) {
      slug = combined[1]!;
      type = combined[2]!;
      bodyStart = i + 1;
      continue;
    }
    const slugMatch = /^slug:\s*([^\s]+)$/i.exec(line);
    if (slugMatch) {
      slug = slugMatch[1]!;
      bodyStart = i + 1;
      continue;
    }
    const typeMatch = /^type:\s*([a-z][a-z0-9_-]*)$/i.exec(line);
    if (typeMatch) {
      type = typeMatch[1]!;
      bodyStart = i + 1;
    }
  }

  if (!slug) return { reason: 'missing slug header' };
  if (!type) return { reason: `missing type header for ${slug}` };
  const body = lines.slice(bodyStart).join('\n').trim();
  if (!body) return { reason: `empty body for ${slug}` };
  return { slug, type, body };
}

function renderBlockContent(block: ParsedPageBlock): string {
  if (block.body.trimStart().startsWith('---')) return block.body;
  const title = extractTitle(block.body) ?? block.slug.split('/').at(-1) ?? block.slug;
  return serializeMarkdown(
    {},
    block.body,
    '',
    { type: block.type, title, tags: [] },
  );
}

function extractTitle(body: string): string | null {
  const line = body.split('\n').find(l => /^#\s+/.test(l.trim()));
  return line ? line.replace(/^#\s+/, '').trim() : null;
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

export const __testing = {
  parsePageBlocks,
  renderBlockContent,
  OUTPUT_CONTRACT,
  resolveCliModel,
  buildClaudeArgs,
};
