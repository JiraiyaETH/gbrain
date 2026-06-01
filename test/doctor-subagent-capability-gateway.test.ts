/**
 * Regression coverage for doctor `subagent_capability` vs the gateway-native
 * subagent loop. Runtime handler already treats `agent.use_gateway_loop=true`
 * as the non-Anthropic escape hatch; doctor must not keep warning on the
 * legacy Anthropic-direct precondition once that native gateway path is on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let originalGbrainHome: string | undefined;
let originalAnthropicKey: string | undefined;

describe('doctor subagent_capability gateway-loop parity', () => {
  beforeAll(async () => {
    originalGbrainHome = process.env.GBRAIN_HOME;
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-doctor-subagent-capability-'));
    process.env.GBRAIN_HOME = tmpHome;
    delete process.env.ANTHROPIC_API_KEY;

    const configDir = path.join(tmpHome, '.gbrain');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ engine: 'pglite', chat_model: 'openai:gpt-5.2' }),
    );

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = originalGbrainHome;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  test('does not warn for non-Anthropic chat_model when gateway loop is enabled', async () => {
    await engine.setConfig('agent.use_gateway_loop', 'true');

    const checks = await buildChecks(engine, []);
    const subagent = checks.find((check) => check.name === 'subagent_capability');

    expect(subagent).toBeDefined();
    expect(subagent!.status).toBe('ok');
    expect(subagent!.message).toContain('Gateway-native loop');
  });
});
