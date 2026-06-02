import type { BrainEngine } from './engine.ts';
import { shouldForceExitAfterMain } from './cli-force-exit.ts';

export interface CliDisconnectOutcome {
  outcome: 'disconnected' | 'forced_exit';
}

export interface CliDisconnectOptions {
  /** Human-readable command label for diagnostics, e.g. `gbrain onboard`. */
  label?: string;
  /** Deadline for engine.disconnect(). Defaults to 10s. Set <=0 to disable. */
  deadlineMs?: number;
  /** Defaults to shouldForceExitAfterMain(); tests may override. */
  shouldForceExit?: boolean;
  /** Test seam; production uses process.exit. */
  exit?: (code: number) => void;
  /** Test seam; production writes a warning to stderr. */
  warn?: (line: string) => void;
}

const DEFAULT_DISCONNECT_HARD_DEADLINE_MS = 10_000;

/**
 * Disconnect a CLI-owned engine without letting a stuck DB pool keep the CLI
 * alive forever.
 *
 * PostgreSQL/PGLite disconnect can occasionally leave a promise or runtime
 * handle pending after the command has already written its user-facing output.
 * For one-shot CLI commands, hanging is worse than a forced clean exit: JSON
 * callers see a timeout/SIGTERM instead of the report they already received.
 * Daemon commands opt out through shouldForceExitAfterMain().
 */
export async function disconnectEngineWithHardDeadline(
  engine: Pick<BrainEngine, 'disconnect'>,
  opts: CliDisconnectOptions = {},
): Promise<CliDisconnectOutcome> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DISCONNECT_HARD_DEADLINE_MS;
  const shouldForceExit = opts.shouldForceExit ?? shouldForceExitAfterMain();

  if (!shouldForceExit || deadlineMs <= 0) {
    await engine.disconnect();
    return { outcome: 'disconnected' };
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const label = opts.label ?? 'gbrain CLI';
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const disconnect = Promise.resolve()
    .then(() => engine.disconnect())
    .then((): CliDisconnectOutcome => ({ outcome: 'disconnected' }))
    .catch((err): CliDisconnectOutcome => {
      // If the deadline already won, consume late disconnect errors; the
      // process is exiting in production, and tests should not see an
      // unhandled rejection from the abandoned disconnect promise.
      if (timedOut) return { outcome: 'forced_exit' };
      throw err;
    });

  const deadline = new Promise<CliDisconnectOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ outcome: 'forced_exit' });
    }, deadlineMs);
    timer.unref?.();
  });

  const result = await Promise.race([disconnect, deadline]);
  if (timer) clearTimeout(timer);

  if (result.outcome === 'forced_exit') {
    warn(`[cli] ${label}: engine.disconnect() did not return within ${deadlineMs}ms — force-exiting`);
    exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }

  return result;
}
