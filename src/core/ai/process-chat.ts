/**
 * Process-backed chat provider adapter.
 *
 * Native GBrain provider seam for subscription-authenticated local model CLIs
 * (Claude Code first) without handing those CLIs Brain write authority. The
 * subprocess is asked for provider-neutral ChatResult blocks; gateway.toolLoop
 * remains the owner of tool execution, persistence, route guards, and writes.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AIGatewayConfig, Recipe } from './types.ts';
import type { ChatBlock, ChatOpts, ChatResult } from './gateway.ts';
import { AIConfigError, AITransientError } from './errors.ts';

interface ProcessChatOutput {
  structured_output?: unknown;
  result?: unknown;
  usage?: Record<string, unknown>;
  model?: unknown;
  modelUsage?: Record<string, unknown>;
  stop_reason?: unknown;
  is_error?: unknown;
  subtype?: unknown;
}

interface StructuredProcessChat {
  blocks?: unknown;
  stopReason?: unknown;
  text?: unknown;
}

const DEFAULT_PROCESS_CHAT_TIMEOUT_MS = 300_000;

/**
 * Schema handed to process-backed CLIs that support JSON-schema structured
 * output. It deliberately mirrors ChatBlock, not provider-native tool-call
 * wire shapes, so the rest of the gateway/subagent loop stays unchanged.
 */
export function processChatStructuredOutputSchema(
  toolNames: string[] = [],
  opts: { forceToolCall?: boolean } = {},
): Record<string, unknown> {
  const textBlock = {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { const: 'text' },
      text: { type: 'string' },
    },
    required: ['type', 'text'],
  };

  const toolCallBlock = {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { const: 'tool-call' },
      toolCallId: { type: 'string' },
      toolName: toolNames.length > 0 ? { enum: toolNames } : { type: 'string' },
      input: { type: 'object', additionalProperties: true },
    },
    required: ['type', 'toolCallId', 'toolName', 'input'],
  };

  const forceToolCall = opts.forceToolCall === true && toolNames.length > 0;
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      blocks: {
        type: 'array',
        minItems: 1,
        items: forceToolCall
          ? toolCallBlock
          : toolNames.length > 0
            ? { anyOf: [textBlock, toolCallBlock] }
            : textBlock,
      },
      stopReason: {
        enum: forceToolCall
          ? ['tool_calls']
          : ['end', 'tool_calls', 'length', 'refusal', 'content_filter', 'other'],
      },
    },
    required: ['blocks', 'stopReason'],
  };
}

export async function runProcessChat(input: {
  recipe: Recipe;
  modelId: string;
  cfg: AIGatewayConfig;
  opts: ChatOpts;
}): Promise<ChatResult> {
  const processSpec = input.recipe.process_chat;
  if (!processSpec) {
    throw new AIConfigError(
      `Recipe "${input.recipe.id}" uses process-chat but does not declare process_chat config.`,
      input.recipe.setup_hint,
    );
  }

  const toolNames = (input.opts.tools ?? []).map(t => t.name);
  const schema = processChatStructuredOutputSchema(toolNames);
  const schemaJson = JSON.stringify(schema);
  const prompt = buildProcessPrompt(input.opts, toolNames, schemaJson);
  const command = resolveProcessCommand(input.recipe, input.cfg);
  const args = resolveProcessArgs(input.recipe, input.cfg, input.modelId, schemaJson, prompt);
  const env = buildProcessEnv(input.recipe, input.cfg);
  const timeoutMs = processSpec.timeout_ms ?? DEFAULT_PROCESS_CHAT_TIMEOUT_MS;

  const cwd = await mkdtemp(join(tmpdir(), `gbrain-${input.recipe.id}-`));
  try {
    const output = await runSubprocess({ command, args, cwd, env, timeoutMs, signal: input.opts.abortSignal });
    const result = normalizeProcessOutput(output, input.recipe, input.modelId, input.opts, toolNames);
    const retryToolNames = selectRetryToolNames(result, toolNames, input.opts);
    if (!retryToolNames) {
      return result;
    }

    const retrySchema = processChatStructuredOutputSchema(retryToolNames, { forceToolCall: true });
    const retrySchemaJson = JSON.stringify(retrySchema);
    const retryPrompt = buildProcessPrompt(input.opts, retryToolNames, retrySchemaJson, {
      bridgeCorrection: true,
      previousText: result.text,
    });
    const retryArgs = resolveProcessArgs(input.recipe, input.cfg, input.modelId, retrySchemaJson, retryPrompt);
    const retryOutput = await runSubprocess({ command, args: retryArgs, cwd, env, timeoutMs, signal: input.opts.abortSignal });
    const retryResult = normalizeProcessOutput(retryOutput, input.recipe, input.modelId, input.opts, retryToolNames);
    retryResult.usage = addUsage(result.usage, retryResult.usage);
    if (!retryResult.blocks.some(b => b.type === 'tool-call')) {
      throw new AITransientError('process-chat provider ignored forced external-tool bridge correction.');
    }
    return retryResult;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function buildProcessPrompt(
  opts: ChatOpts,
  toolNames: string[],
  schemaJson: string,
  promptOpts: { bridgeCorrection?: boolean; previousText?: string } = {},
): string {
  const lines: string[] = [];
  lines.push('You are the model backend for GBrain\'s provider-neutral chat gateway.');
  lines.push('Return only structured output matching the JSON schema supplied by the caller.');
  lines.push('Do not execute tools yourself. Do not write files. Do not access the network.');
  if (promptOpts.bridgeCorrection) {
    lines.push('TOOL-BRIDGE CORRECTION: your previous response incorrectly treated listed GBrain bridge tools as unavailable.');
    lines.push('The listed tools ARE available as JSON tool-call blocks. You must now return at least one tool-call block; plain text is invalid for this retry.');
    if (promptOpts.previousText) {
      lines.push('Previous text response, for diagnosis only:');
      lines.push(promptOpts.previousText.slice(0, 2000));
    }
  }
  if (toolNames.length > 0) {
    lines.push('These are not Claude native tools; they are external GBrain tool bridges.');
    lines.push('If a tool is needed: Return a tool-call block; the GBrain orchestrator will execute the tool and feed back the result.');
    lines.push('If the task asks you to call or use a listed tool such as brain_put_page, emit a JSON tool-call block named brain_put_page instead of saying the tool is unavailable.');
    lines.push('Never say a listed tool is unavailable merely because it is not available as a native CLI/MCP tool in this subprocess.');
    lines.push('If the latest message is a tool result, do not call that same tool again; return final text with stopReason "end".');
    lines.push(`Allowed tool names: ${toolNames.join(', ')}`);
  } else {
    lines.push('No tools are available for this turn; return text only.');
  }
  lines.push('Use stopReason "tool_calls" when any tool-call block is present; otherwise use "end" unless safety/length requires another reason.');
  lines.push('JSON schema:');
  lines.push(schemaJson);
  lines.push('');
  if (opts.system) {
    lines.push('<system>');
    lines.push(opts.system);
    lines.push('</system>');
    lines.push('');
  }
  if (opts.tools && opts.tools.length > 0) {
    lines.push('<tools>');
    for (const tool of opts.tools) {
      lines.push(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    }
    lines.push('</tools>');
    lines.push('');
  }
  lines.push('<messages>');
  for (const message of opts.messages) {
    lines.push(JSON.stringify({ role: message.role, content: message.content }));
  }
  lines.push('</messages>');
  if (toolNames.length > 0) {
    lines.push('');
    lines.push('FINAL TOOL-BRIDGE REMINDER: listed tools are available through JSON tool-call blocks, not native Claude Code tools. Do not claim they are unavailable. If the task requires brain_put_page, output a tool-call block for brain_put_page; the GBrain orchestrator, not this subprocess, performs the write. If the latest message is a tool result, finish with final text and stopReason "end"; otherwise return tool-call blocks and stopReason "tool_calls" when the task requires a tool.');
  }
  return lines.join('\n');
}

function selectRetryToolNames(result: ChatResult, toolNames: string[], opts: ChatOpts): string[] | null {
  if (toolNames.length === 0) return null;
  if (result.blocks.some(b => b.type === 'tool-call')) return null;
  const text = result.text.toLowerCase();
  if (!text) return null;

  if (toolNames.includes('brain_put_page') && !hasPriorToolResultForTool(opts.messages, 'brain_put_page')) {
    const claimsWrite = /\b(written|wrote|page written|pages written|slug written|slugs written|stored|created)\b/.test(text)
      && /\b(page|pages|slug|slugs|ideas\/|reflections\/|dream-cycles\/)\b/.test(text);
    if (claimsWrite) return ['brain_put_page'];
  }

  if (hasPriorToolResult(opts.messages)) return null;
  const mentioned = mentionedToolNames(text, toolNames);
  if (mentioned.length === 0) return null;
  if (!/\b(unavailable|not available|not responding|unable to execute|cannot execute|can't execute|tool-bridge failure|verify .*bridge|retry .*tool|retry the write)\b/.test(text)) {
    return null;
  }
  return mentioned;
}

function mentionedToolNames(text: string, toolNames: string[]): string[] {
  return toolNames.filter(name => {
    const lower = name.toLowerCase();
    const unprefixed = lower.startsWith('brain_') ? lower.slice('brain_'.length) : lower;
    return text.includes(lower) || text.includes(unprefixed);
  });
}

function hasPriorToolResult(messages: ChatOpts['messages']): boolean {
  return messages.some(message => {
    if (message.role === 'tool') return true;
    if (Array.isArray(message.content)) {
      return message.content.some(block => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool-result');
    }
    return false;
  });
}

function hasPriorToolResultForTool(messages: ChatOpts['messages'], toolName: string): boolean {
  return messages.some(message => {
    if (!Array.isArray(message.content)) return false;
    return message.content.some(block => {
      if (!block || typeof block !== 'object') return false;
      const b = block as { type?: unknown; toolName?: unknown };
      return b.type === 'tool-result' && b.toolName === toolName;
    });
  });
}

function addUsage(a: ChatResult['usage'], b: ChatResult['usage']): ChatResult['usage'] {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_creation_tokens: a.cache_creation_tokens + b.cache_creation_tokens,
  };
}

function resolveProcessCommand(recipe: Recipe, cfg: AIGatewayConfig): string {
  const spec = recipe.process_chat;
  if (!spec) throw new AIConfigError(`Recipe "${recipe.id}" has no process_chat config.`);
  const envCommand = spec.command_env ? cfg.env[spec.command_env] : undefined;
  const command = (envCommand && envCommand.trim()) || spec.command;
  if (!command || !command.trim()) {
    throw new AIConfigError(`${recipe.name} process-chat command is empty.`, recipe.setup_hint);
  }
  return command;
}

function resolveProcessArgs(
  recipe: Recipe,
  cfg: AIGatewayConfig,
  modelId: string,
  schemaJson: string,
  prompt: string,
): string[] {
  const spec = recipe.process_chat;
  if (!spec) throw new AIConfigError(`Recipe "${recipe.id}" has no process_chat config.`);
  let template = spec.args;
  if (spec.args_env && cfg.env[spec.args_env]) {
    try {
      const parsed = JSON.parse(cfg.env[spec.args_env]!);
      if (!Array.isArray(parsed) || !parsed.every(v => typeof v === 'string')) {
        throw new Error('expected JSON string array');
      }
      template = parsed;
    } catch (err) {
      throw new AIConfigError(
        `${recipe.name} ${spec.args_env} must be a JSON string array: ${err instanceof Error ? err.message : String(err)}`,
        recipe.setup_hint,
      );
    }
  }

  let usedPromptPlaceholder = false;
  const args = template.map(arg => {
    if (arg.includes('${prompt}')) usedPromptPlaceholder = true;
    return arg
      .replaceAll('${model}', modelId)
      .replaceAll('${schema}', schemaJson)
      .replaceAll('${prompt}', prompt);
  });
  if (!usedPromptPlaceholder) args.push(prompt);
  return args;
}

function buildProcessEnv(recipe: Recipe, cfg: AIGatewayConfig): NodeJS.ProcessEnv {
  const spec = recipe.process_chat;
  if (!spec) throw new AIConfigError(`Recipe "${recipe.id}" has no process_chat config.`);
  const env: NodeJS.ProcessEnv = {};
  for (const key of spec.env_allowlist ?? []) {
    const value = cfg.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Keep subprocesses in non-interactive mode where CLIs honor CI. This is not
  // a secret-bearing variable and it prevents surprise prompts in many tools.
  env.CI = env.CI ?? '1';
  return env;
}

async function runSubprocess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProcessChatOutput> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, input.timeoutMs);
  const abort = () => child.kill('SIGTERM');
  input.signal?.addEventListener('abort', abort, { once: true });

  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    if (timedOut) {
      throw new AITransientError(`process-chat provider timed out after ${input.timeoutMs}ms.`);
    }
    if (input.signal?.aborted) {
      throw new AITransientError('process-chat provider aborted.');
    }
    if (exit.code !== 0) {
      throw new AITransientError(
        `process-chat provider exited with code ${exit.code ?? 'null'}${exit.signal ? ` signal ${exit.signal}` : ''}. ` +
        `stderr_bytes=${Buffer.concat(stderr).byteLength}`,
      );
    }

    const text = Buffer.concat(stdout).toString('utf8').trim();
    if (!text) {
      throw new AITransientError('process-chat provider returned empty stdout.');
    }
    try {
      return JSON.parse(text) as ProcessChatOutput;
    } catch (err) {
      throw new AITransientError(
        `process-chat provider returned malformed JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `stdout_bytes=${Buffer.byteLength(text, 'utf8')}`,
      );
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
}

function normalizeProcessOutput(
  raw: ProcessChatOutput,
  recipe: Recipe,
  modelId: string,
  opts: ChatOpts,
  toolNames: string[],
): ChatResult {
  if (raw.is_error === true) {
    throw new AITransientError(`${recipe.name} process-chat returned error subtype=${String(raw.subtype ?? 'unknown')}`);
  }

  const structured = extractStructuredOutput(raw);
  const blocks = normalizeBlocks(structured, opts, toolNames);
  const hasToolCalls = blocks.some(b => b.type === 'tool-call');
  const stopReason = mapProcessStopReason(structured.stopReason, raw.stop_reason, hasToolCalls);
  const usage = raw.usage ?? {};

  return {
    text: blocks.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join(''),
    blocks,
    stopReason,
    usage: {
      input_tokens: numeric(usage.input_tokens ?? usage.inputTokens),
      output_tokens: numeric(usage.output_tokens ?? usage.outputTokens),
      cache_read_tokens: numeric(usage.cache_read_tokens ?? usage.cacheReadInputTokens),
      cache_creation_tokens: numeric(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    },
    model: `${recipe.id}:${modelId}`,
    providerId: recipe.id,
    providerMetadata: {
      process_chat: {
        underlying_model: typeof raw.model === 'string' ? raw.model : undefined,
        model_usage_keys: raw.modelUsage && typeof raw.modelUsage === 'object' ? Object.keys(raw.modelUsage) : undefined,
        stop_reason: raw.stop_reason,
      },
    },
  };
}

function extractStructuredOutput(raw: ProcessChatOutput): StructuredProcessChat {
  if (raw.structured_output && typeof raw.structured_output === 'object') {
    return raw.structured_output as StructuredProcessChat;
  }
  if (raw.result && typeof raw.result === 'object') {
    return raw.result as StructuredProcessChat;
  }
  if (typeof raw.result === 'string' && raw.result.trim()) {
    try {
      const parsed = JSON.parse(raw.result) as StructuredProcessChat;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return { blocks: [{ type: 'text', text: raw.result }], stopReason: 'end' };
    }
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as StructuredProcessChat).blocks)) {
    return raw as StructuredProcessChat;
  }
  throw new AITransientError('process-chat provider response did not include structured_output or result blocks.');
}

function normalizeBlocks(structured: StructuredProcessChat, opts: ChatOpts, toolNames: string[]): ChatBlock[] {
  const rawBlocks = Array.isArray(structured.blocks)
    ? structured.blocks
    : typeof structured.text === 'string'
    ? [{ type: 'text', text: structured.text }]
    : [];
  if (rawBlocks.length === 0) {
    throw new AITransientError('process-chat provider structured output contained no blocks.');
  }

  const allowed = new Set(toolNames);
  const blocks: ChatBlock[] = [];
  for (const block of rawBlocks) {
    if (!block || typeof block !== 'object') {
      throw new AITransientError('process-chat provider returned a non-object block.');
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'text') {
      blocks.push({ type: 'text', text: typeof b.text === 'string' ? b.text : '' });
      continue;
    }
    if (b.type === 'tool-call') {
      const toolName = typeof b.toolName === 'string' ? b.toolName : '';
      if (!allowed.has(toolName)) {
        throw new AITransientError(`process-chat provider requested unknown tool "${toolName || '<missing>'}".`);
      }
      const toolCallId = typeof b.toolCallId === 'string' && b.toolCallId.trim()
        ? b.toolCallId
        : `process-${Date.now()}-${blocks.length}`;
      blocks.push({
        type: 'tool-call',
        toolCallId,
        toolName,
        input: b.input && typeof b.input === 'object' ? b.input : {},
      });
      continue;
    }
    throw new AITransientError(`process-chat provider returned unsupported block type "${String(b.type)}".`);
  }

  // If no tools were offered, a process provider must not smuggle tool calls.
  if ((opts.tools ?? []).length === 0 && blocks.some(b => b.type === 'tool-call')) {
    throw new AITransientError('process-chat provider returned tool calls when no tools were offered.');
  }
  return blocks;
}

function mapProcessStopReason(
  structuredStop: unknown,
  rawStop: unknown,
  hasToolCalls: boolean,
): ChatResult['stopReason'] {
  if (hasToolCalls) return 'tool_calls';
  const s = String(structuredStop ?? rawStop ?? 'end');
  if (s === 'tool_calls' || s === 'tool-calls') return 'tool_calls';
  if (s === 'length' || s === 'max_tokens' || s === 'max-tokens') return 'length';
  if (s === 'refusal') return 'refusal';
  if (s === 'content_filter' || s === 'content-filter') return 'content_filter';
  if (s === 'end' || s === 'stop' || s === 'end_turn' || s === 'end-turn') return 'end';
  return 'other';
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
