import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSubagentCapability } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

describe('doctor subagent_capability', () => {
  test('config-file anthropic_api_key satisfies legacy Anthropic subagent key check', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-subagent-'));
    const configDir = join(home, '.gbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      engine: 'pglite',
      chat_model: 'openai:gpt-4o-mini',
      anthropic_api_key: 'sk-config-plane',
    }));

    const engine: any = {
      getConfig: async (key: string) => {
        if (key === 'agent.use_gateway_loop') return 'false';
        return null;
      },
    };

    await withEnv(
      {
        GBRAIN_HOME: home,
        ANTHROPIC_API_KEY: undefined,
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: undefined,
      },
      async () => {
        const check = await checkSubagentCapability(engine);

        expect(check.name).toBe('subagent_capability');
        expect(check.status).toBe('ok');
        expect(check.message).toContain('full tool-loop capability');
      },
    );
  });
});
