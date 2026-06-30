import type { Recipe } from '../types.ts';

/**
 * DeepSeek exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * Useful as the second hop in a refusal-fallback chain and for cheap reasoning
 * workloads. DeepSeek v4 is the current API family; legacy deepseek-chat /
 * deepseek-reasoner remain as aliases until DeepSeek's published 2026-07-24
 * deprecation cutoff.
 */
export const deepseek: Recipe = {
  id: 'deepseek',
  name: 'DeepSeek',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.deepseek.com/v1',
  auth_env: {
    required: ['DEEPSEEK_API_KEY'],
    setup_url: 'https://platform.deepseek.com/api_keys',
  },
  touchpoints: {
    chat: {
      models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000,
      cost_per_1m_input_usd: 0.435, // deepseek-v4-pro cache-miss baseline
      cost_per_1m_output_usd: 0.87,
      price_last_verified: '2026-06-30',
    },
  },
  setup_hint: 'Get an API key at https://platform.deepseek.com/api_keys, then `export DEEPSEEK_API_KEY=...`',
};
