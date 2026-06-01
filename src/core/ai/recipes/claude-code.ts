import type { Recipe } from '../types.ts';

/**
 * Claude Code subscription-backed process provider.
 *
 * This is a native gateway backend, not a Dream wrapper: the CLI is confined
 * to producing provider-neutral chat blocks. GBrain's toolLoop still executes
 * tools, persists crash-replay state, enforces slug allow-lists, and performs
 * writes.
 */
export const claudeCode: Recipe = {
  id: 'claude-code',
  name: 'Claude Code (subscription)',
  tier: 'native',
  implementation: 'process-chat',
  process_chat: {
    command: 'claude',
    command_env: 'GBRAIN_CLAUDE_CODE_COMMAND',
    args_env: 'GBRAIN_CLAUDE_CODE_ARGS_JSON',
    args: [
      '-p',
      '--model', '${model}',
      '--permission-mode', 'default',
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--json-schema', '${schema}',
      '--output-format', 'json',
      '--no-session-persistence',
    ],
    env_allowlist: [
      'HOME',
      'PATH',
      'USER',
      'LOGNAME',
      'SHELL',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CI',
    ],
    timeout_ms: 300_000,
  },
  touchpoints: {
    chat: {
      models: [
        'claude-haiku-4-5',
        'claude-sonnet-4-6',
        'claude-opus-4-7',
        'sonnet',
        'opus',
        'haiku',
      ],
      // The process adapter emulates provider-neutral tool-call blocks; GBrain
      // owns actual tool execution and crash-replay persistence.
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 180_000,
      // Subscription quota: zero metered API dollars here. BudgetTracker has
      // a matching provider-prefix allow-list so --max-cost still gates API
      // providers while treating this lane as quota-costed.
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-05-31',
    },
  },
  aliases: {
    haiku: 'claude-haiku-4-5',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
  },
  setup_hint: 'Install and log in to Claude Code (`claude`) with subscription auth. Override command/args with GBRAIN_CLAUDE_CODE_COMMAND and GBRAIN_CLAUDE_CODE_ARGS_JSON for tests or custom installs.',
};
