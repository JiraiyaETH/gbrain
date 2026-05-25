import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Read cli.ts source for structural checks
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');

describe('CLI structure', () => {
  test('imports operations from operations.ts', () => {
    expect(cliSource).toContain("from './core/operations.ts'");
  });

  test('builds cliOps map from operations', () => {
    expect(cliSource).toContain('cliOps');
  });

  test('CLI_ONLY set contains expected commands', () => {
    expect(cliSource).toContain("'init'");
    expect(cliSource).toContain("'upgrade'");
    expect(cliSource).toContain("'import'");
    expect(cliSource).toContain("'export'");
    expect(cliSource).toContain("'embed'");
    expect(cliSource).toContain("'files'");
  });

  test('has formatResult function for CLI output', () => {
    expect(cliSource).toContain('function formatResult');
  });
});

describe('CLI version', () => {
  test('VERSION matches package.json', async () => {
    const { VERSION } = await import('../src/version.ts');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
  });

  test('VERSION is a valid semver string', async () => {
    const { VERSION } = await import('../src/version.ts');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('ask alias', () => {
  test('ask alias maps to query in source', () => {
    expect(cliSource).toContain("if (command === 'ask')");
    expect(cliSource).toContain("command = 'query'");
  });

  test('ask does NOT appear in --tools-json output', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--tools-json'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const tools = JSON.parse(stdout);
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain('ask');
  });
});

describe('CLI dispatch integration', () => {
  test('--version outputs version', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--version'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toMatch(/^gbrain \d+\.\d+\.\d+/);
  });

  test('unknown command prints error and exits 1', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'notacommand'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stderr).toContain('Unknown command: notacommand');
    expect(exitCode).toBe(1);
  });

  test('per-command --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'get', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain get');
    expect(exitCode).toBe(0);
  });

  test('upgrade --help prints usage without running upgrade', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(exitCode).toBe(0);
  });

  test('--help prints global help', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('gbrain <command>');
    expect(exitCode).toBe(0);
  });

  test('--tools-json outputs valid JSON with operations', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--tools-json'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const tools = JSON.parse(stdout);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(30);
    expect(tools[0]).toHaveProperty('name');
    expect(tools[0]).toHaveProperty('description');
    expect(tools[0]).toHaveProperty('parameters');
  });

  test('query --no-expand disables expansion instead of calling the expansion provider', async () => {
    const repo = new URL('..', import.meta.url).pathname;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-no-expand-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'pglite',
        database_path: join(home, '.gbrain', 'brain.pglite'),
      }, null, 2));

      const baseEnv = {
        ...process.env,
        GBRAIN_HOME: home,
        GBRAIN_EXPANSION_MODEL: 'anthropic:claude-haiku-4-5-20251001',
        ANTHROPIC_API_KEY: 'test-key-that-must-not-be-used',
        OPENAI_API_KEY: '',
      };

      const put = Bun.spawn(['bun', 'run', 'src/cli.ts', 'put', 'people/alice'], {
        cwd: repo,
        env: baseEnv,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      put.stdin.write('# Alice\n\nAlice works on Q1 review.\n');
      put.stdin.end();
      expect(await put.exited).toBe(0);

      const query = Bun.spawn(['bun', 'run', 'src/cli.ts', 'query', 'Alice Q1 review', '--no-expand'], {
        cwd: repo,
        env: baseEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(query.stderr).text();
      const exitCode = await query.exited;
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('expansion disabled');
      expect(stderr).not.toContain('Anthropic');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
