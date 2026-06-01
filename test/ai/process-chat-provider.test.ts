import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import {
  chat,
  configureGateway,
  resetGateway,
  toolLoop,
  withBudgetTracker,
  type ChatToolDef,
  type ToolHandler,
} from '../../src/core/ai/gateway.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

let tmp: string;

beforeEach(() => {
  resetGateway();
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-process-chat-test-'));
});

afterEach(() => {
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

function writeFakeProvider(source: string): string {
  const path = join(tmp, 'fake-provider.js');
  writeFileSync(path, source);
  return path;
}

function configureFakeProcessProvider(scriptPath: string, extraEnv: Record<string, string> = {}): void {
  configureGateway({
    chat_model: 'claude-code:claude-haiku-4-5',
    env: {
      GBRAIN_CLAUDE_CODE_COMMAND: process.execPath,
      GBRAIN_CLAUDE_CODE_ARGS_JSON: JSON.stringify([scriptPath, '${prompt}']),
      OPENAI_API_KEY: 'must-not-reach-child',
      ANTHROPIC_API_KEY: 'must-not-reach-child',
      ...extraEnv,
    },
  });
}

describe('claude-code process-chat recipe', () => {
  test('is registered as a subscription-backed chat provider', () => {
    const recipe = getRecipe('claude-code');
    expect(recipe).toBeDefined();
    expect(recipe!.implementation).toBe('process-chat');
    expect(recipe!.touchpoints.chat?.supports_subagent_loop).toBe(true);
    expect(recipe!.touchpoints.chat?.supports_tools).toBe(true);
    expect(recipe!.touchpoints.chat?.cost_per_1m_input_usd).toBe(0);
    expect(recipe!.touchpoints.chat?.cost_per_1m_output_usd).toBe(0);
  });

  test('chat() routes through the process backend and does not leak broad provider env', async () => {
    const script = writeFakeProvider(`
      const prompt = process.argv.at(-1) || '';
      const leaked = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
      console.log(JSON.stringify({
        structured_output: {
          blocks: [{ type: 'text', text: leaked ? 'LEAKED' : (prompt.includes('hello') ? 'OK' : 'MISSING_PROMPT') }],
          stopReason: 'end'
        },
        usage: { input_tokens: 7, output_tokens: 2 }
      }));
    `);
    configureFakeProcessProvider(script);

    const result = await chat({
      messages: [{ role: 'user', content: 'hello from test' }],
      maxTokens: 32,
    });

    expect(result.providerId).toBe('claude-code');
    expect(result.model).toBe('claude-code:claude-haiku-4-5');
    expect(result.text).toBe('OK');
    expect(result.usage.input_tokens).toBe(7);
    expect(result.usage.output_tokens).toBe(2);
  });

  test('process prompt explains that tool-call blocks are the external GBrain tool bridge', async () => {
    const script = writeFakeProvider(`
      const prompt = process.argv.at(-1) || '';
      const hasBridge = prompt.includes('These are not Claude native tools; they are external GBrain tool bridges.')
        && prompt.includes('Return a tool-call block; the GBrain orchestrator will execute the tool and feed back the result.')
        && prompt.includes('If the task asks you to call or use a listed tool such as brain_put_page, emit a JSON tool-call block named brain_put_page instead of saying the tool is unavailable.')
        && prompt.includes('If the latest message is a tool result, do not call that same tool again; return final text with stopReason "end".');
      console.log(JSON.stringify({
        structured_output: { blocks: [{ type: 'text', text: hasBridge ? 'BRIDGE_OK' : 'MISSING_BRIDGE' }], stopReason: 'end' },
        usage: { input_tokens: 7, output_tokens: 2 }
      }));
    `);
    configureFakeProcessProvider(script);

    const result = await chat({
      messages: [{ role: 'user', content: 'write the page with the tool' }],
      tools: [{
        name: 'brain_put_page',
        description: 'Write a page',
        inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      }],
      maxTokens: 32,
    });

    expect(result.text).toBe('BRIDGE_OK');
  });

  test('claude-code process recipe does not run in plan mode because JSON bridge tool calls are not real side effects', () => {
    const recipe = getRecipe('claude-code')!;
    expect(recipe.process_chat?.args).not.toContain('plan');
    expect(recipe.process_chat?.args).toContain('--tools');
    expect(recipe.process_chat?.args).toContain('');
  });

  test('gateway.toolLoop stays native: process backend proposes tool calls, GBrain executes tools', async () => {
    const script = writeFakeProvider(`
      const prompt = process.argv.at(-1) || '';
      const sawToolResult = prompt.includes('"role":"tool"');
      const structured_output = sawToolResult
        ? { blocks: [{ type: 'text', text: 'done' }], stopReason: 'end' }
        : { blocks: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'echo', input: { value: 'hi' } }], stopReason: 'tool_calls' };
      console.log(JSON.stringify({ structured_output, usage: { input_tokens: 11, output_tokens: 3 } }));
    `);
    configureFakeProcessProvider(script);

    const tools: ChatToolDef[] = [{
      name: 'echo',
      description: 'Echo a value',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    }];
    const calls: unknown[] = [];
    const handlers = new Map<string, ToolHandler>([
      ['echo', {
        idempotent: true,
        async execute(input) {
          calls.push(input);
          return { echoed: (input as { value: string }).value };
        },
      }],
    ]);

    const result = await toolLoop({
      model: 'claude-code:claude-haiku-4-5',
      initialMessages: [{ role: 'user', content: 'call echo then finish' }],
      tools,
      toolHandlers: handlers,
      maxTurns: 4,
      maxTokens: 64,
    });

    expect(calls).toEqual([{ value: 'hi' }]);
    expect(result.finalText).toBe('done');
    expect(result.stopReason).toBe('end');
    expect(result.totalUsage.input_tokens).toBe(22);
    expect(result.totalUsage.output_tokens).toBe(6);
  });

  test('gateway.toolLoop retries when process backend claims external bridge tools are unavailable', async () => {
    const script = writeFakeProvider(`
      const fs = require('node:fs');
      const path = require('node:path');
      const prompt = process.argv.at(-1) || '';
      if (prompt.includes('"role":"tool"')) {
        console.log(JSON.stringify({
          structured_output: { blocks: [{ type: 'text', text: 'done-after-retry' }], stopReason: 'end' },
          usage: { input_tokens: 11, output_tokens: 3 }
        }));
        process.exit(0);
      }
      const statePath = path.join(process.cwd(), 'attempts.txt');
      const attempts = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
      fs.writeFileSync(statePath, String(attempts + 1));
      if (attempts === 0) {
        console.log(JSON.stringify({
          structured_output: {
            blocks: [{ type: 'text', text: 'brain_put_page is unavailable in this execution context; retry the write after verifying the bridge.' }],
            stopReason: 'end'
          },
          usage: { input_tokens: 5, output_tokens: 1 }
        }));
        process.exit(0);
      }
      const forced = prompt.includes('TOOL-BRIDGE CORRECTION')
        && prompt.includes('The listed tools ARE available as JSON tool-call blocks')
        && prompt.includes('"enum":["tool_calls"]');
      console.log(JSON.stringify({
        structured_output: forced
          ? { blocks: [{ type: 'tool-call', toolCallId: 'retry_1', toolName: 'brain_put_page', input: { slug: 'ideas/retry-proof', content: 'retry proof' } }], stopReason: 'tool_calls' }
          : { blocks: [{ type: 'text', text: 'missing forced retry prompt' }], stopReason: 'end' },
        usage: { input_tokens: 7, output_tokens: 2 }
      }));
    `);
    configureFakeProcessProvider(script);

    const tools: ChatToolDef[] = [{
      name: 'brain_put_page',
      description: 'Write a page',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' }, content: { type: 'string' } },
        required: ['slug', 'content'],
      },
    }];
    const calls: unknown[] = [];
    const handlers = new Map<string, ToolHandler>([
      ['brain_put_page', {
        idempotent: true,
        async execute(input) {
          calls.push(input);
          return { ok: true };
        },
      }],
    ]);

    const result = await toolLoop({
      model: 'claude-code:claude-haiku-4-5',
      initialMessages: [{ role: 'user', content: 'write with brain_put_page' }],
      tools,
      toolHandlers: handlers,
      maxTurns: 4,
      maxTokens: 64,
    });

    expect(calls).toEqual([{ slug: 'ideas/retry-proof', content: 'retry proof' }]);
    expect(result.finalText).toBe('done-after-retry');
    expect(result.totalUsage.input_tokens).toBe(23);
    expect(result.totalUsage.output_tokens).toBe(6);
  });

  test('gateway.toolLoop forces brain_put_page when process backend claims a write after read-only tools only', async () => {
    const script = writeFakeProvider(`
      const fs = require('node:fs');
      const path = require('node:path');
      const prompt = process.argv.at(-1) || '';
      const hasPutPageResult = prompt.includes('"toolName":"brain_put_page"') && prompt.includes('"type":"tool-result"');
      if (hasPutPageResult) {
        console.log(JSON.stringify({
          structured_output: { blocks: [{ type: 'text', text: 'done-after-put-page' }], stopReason: 'end' },
          usage: { input_tokens: 13, output_tokens: 3 }
        }));
        process.exit(0);
      }
      const statePath = path.join(__dirname, 'attempts.txt');
      const attempts = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
      fs.writeFileSync(statePath, String(attempts + 1));
      if (attempts === 0) {
        console.log(JSON.stringify({
          structured_output: { blocks: [{ type: 'tool-call', toolCallId: 'search_1', toolName: 'brain_search', input: { query: 'skill rules' } }], stopReason: 'tool_calls' },
          usage: { input_tokens: 5, output_tokens: 1 }
        }));
        process.exit(0);
      }
      if (attempts === 1) {
        console.log(JSON.stringify({
          structured_output: { blocks: [{ type: 'text', text: 'Written pages: ideas/skill-rule-proof and reflections/router-proof.' }], stopReason: 'end' },
          usage: { input_tokens: 7, output_tokens: 2 }
        }));
        process.exit(0);
      }
      const forced = prompt.includes('TOOL-BRIDGE CORRECTION')
        && prompt.includes('"enum":["brain_put_page"]')
        && prompt.includes('"enum":["tool_calls"]');
      console.log(JSON.stringify({
        structured_output: forced
          ? { blocks: [{ type: 'tool-call', toolCallId: 'put_1', toolName: 'brain_put_page', input: { slug: 'ideas/skill-rule-proof', content: 'proof' } }], stopReason: 'tool_calls' }
          : { blocks: [{ type: 'text', text: 'missing forced put_page retry' }], stopReason: 'end' },
        usage: { input_tokens: 11, output_tokens: 4 }
      }));
    `);
    configureFakeProcessProvider(script);

    const tools: ChatToolDef[] = [
      {
        name: 'brain_search',
        description: 'Search pages',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      {
        name: 'brain_put_page',
        description: 'Write a page',
        inputSchema: {
          type: 'object',
          properties: { slug: { type: 'string' }, content: { type: 'string' } },
          required: ['slug', 'content'],
        },
      },
    ];
    const calls: Array<{ tool: string; input: unknown }> = [];
    const handlers = new Map<string, ToolHandler>([
      ['brain_search', {
        idempotent: true,
        async execute(input) {
          calls.push({ tool: 'brain_search', input });
          return { results: [{ slug: 'skills/skillify' }] };
        },
      }],
      ['brain_put_page', {
        idempotent: true,
        async execute(input) {
          calls.push({ tool: 'brain_put_page', input });
          return { ok: true };
        },
      }],
    ]);

    const result = await toolLoop({
      model: 'claude-code:claude-haiku-4-5',
      initialMessages: [{ role: 'user', content: 'search then write with brain_put_page' }],
      tools,
      toolHandlers: handlers,
      maxTurns: 5,
      maxTokens: 64,
    });

    expect(calls).toEqual([
      { tool: 'brain_search', input: { query: 'skill rules' } },
      { tool: 'brain_put_page', input: { slug: 'ideas/skill-rule-proof', content: 'proof' } },
    ]);
    expect(result.finalText).toBe('done-after-put-page');
    expect(result.totalUsage.input_tokens).toBe(36);
    expect(result.totalUsage.output_tokens).toBe(10);
  });

  test('BudgetTracker records subscription chat as zero API dollars under max-cost gates', async () => {
    const auditPath = join(tmp, 'budget.jsonl');
    const script = writeFakeProvider(`
      console.log(JSON.stringify({
        structured_output: { blocks: [{ type: 'text', text: 'budget-ok' }], stopReason: 'end' },
        usage: { input_tokens: 1000, output_tokens: 500 }
      }));
    `);
    configureFakeProcessProvider(script);
    const tracker = new BudgetTracker({ label: 'process-chat-test', maxCostUsd: 0, auditPath });

    const result = await withBudgetTracker(tracker, () => chat({
      messages: [{ role: 'user', content: 'budget' }],
      maxTokens: 16,
    }));

    expect(result.text).toBe('budget-ok');
    expect(tracker.snapshot().cumulativeCostUsd).toBe(0);
    expect(tracker.snapshot().callsRecorded).toBe(1);
    const audit = readFileSync(auditPath, 'utf8');
    expect(audit).toContain('"event":"reserve"');
    expect(audit).toContain('"event":"record"');
    expect(audit).toContain('"actual_cost_usd":0');
  });
});
