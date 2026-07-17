/**
 * Cross-process corpus-writer exclusion for the long-lived Autopilot daemon.
 *
 * The recovery runtime seals a small `run-lock.py` helper next to its wrappers.
 * Autopilot cannot hold that lock for its whole lifetime: doing so would starve
 * scheduled exporters, Dream, meeting ingestion, and manual maintenance.  It
 * instead takes one lease around each mutating tick and releases it in a
 * `finally` block.
 *
 * The primitive remains opt-in for generic callers, but recovery runtime
 * writer paths pass `required: true`: an absent, invalid, or broken helper then
 * fails closed and defers work instead of silently running without exclusion.
 */

import { dirname, isAbsolute, join } from 'path';
import { randomUUID } from 'crypto';

export const RUN_LOCK_BUSY_EXIT = 75;
const DEFAULT_WAIT_SECONDS = 15;
const DEFAULT_POLL_SECONDS = 1;
const OWNER = 'gbrain-autopilot-tick';

export interface AutopilotCorpusWriterLockConfig {
  enabled: boolean;
  helperPath?: string;
  pythonBin?: string;
  lockDir?: string;
  waitSeconds?: number;
  pollSeconds?: number;
  invalidReason?: string;
}

export interface RunLockInvocation {
  action: 'acquire' | 'release';
  argv: string[];
  signal?: AbortSignal;
}

export type RunLockHelper = (invocation: RunLockInvocation) => Promise<number>;

export type AutopilotCorpusWriterLockResult<T> =
  | { status: 'completed'; lock: 'disabled' | 'acquired'; value: T }
  | {
      status: 'deferred';
      reason: 'busy' | 'aborted' | 'invalid_config' | 'helper_error';
      helper_exit_code?: number;
      detail?: string;
    };

/**
 * Fatal coordination failure after this process acquired the shared lock.
 *
 * A normal helper error before acquisition can be deferred. A release failure
 * cannot: owner.json names the long-lived daemon PID, so no contender may
 * stale-steal the lock while that process remains alive. Process owners must
 * stop and let their supervisor restart them. When dispatch already completed,
 * `completedValue` lets the Minion worker stamp success before exiting rather
 * than replaying a mutation that already happened.
 */
export class AutopilotCorpusWriterLockReleaseError<T = unknown> extends Error {
  readonly dispatchCompleted: boolean;
  readonly completedValue: T | undefined;
  readonly helperExitCode: number | undefined;
  readonly hasPrimaryDispatchError: boolean;
  readonly primaryDispatchError: unknown;

  constructor(
    message: string,
    options: {
      dispatchCompleted: boolean;
      completedValue?: T;
      helperExitCode?: number;
      cause?: unknown;
      hasPrimaryDispatchError?: boolean;
      primaryDispatchError?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AutopilotCorpusWriterLockReleaseError';
    this.dispatchCompleted = options.dispatchCompleted;
    this.completedValue = options.completedValue;
    this.helperExitCode = options.helperExitCode;
    this.hasPrimaryDispatchError = options.hasPrimaryDispatchError === true;
    this.primaryDispatchError = options.primaryDispatchError;
  }
}

// Dispatch failures retain their exact error identity. Mark those objects out
// of band so the worker/daemon can still recognize the secondary fatal release
// failure without replacing the primary handler evidence.
const dispatchErrorsWithReleaseFailure = new WeakSet<object>();

export function isAutopilotCorpusWriterLockReleaseFailure(error: unknown): boolean {
  if (error instanceof AutopilotCorpusWriterLockReleaseError) return true;
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    return dispatchErrorsWithReleaseFailure.has(error as object);
  }
  return false;
}

export interface AutopilotCorpusWriterLockOptions {
  config?: AutopilotCorpusWriterLockConfig;
  env?: NodeJS.ProcessEnv;
  runHelper?: RunLockHelper;
  signal?: AbortSignal;
  ownerPid?: number;
  tokenNonce?: string;
  onDiagnostic?: (message: string) => void;
  /** Fail closed when the helper is absent (required for runtime writers). */
  required?: boolean;
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number | null {
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number | null {
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Resolve only non-secret runtime coordinates from the environment. */
export function resolveAutopilotCorpusWriterLockConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutopilotCorpusWriterLockConfig {
  const helperPath = env.GBRAIN_RUN_LOCK_HELPER?.trim();
  if (!helperPath) return { enabled: false };

  const home = env.HOME?.trim();
  const pythonBin = env.GBRAIN_PYTHON_BIN?.trim() || '/usr/bin/python3';
  const lockDir = env.GBRAIN_CORPUS_WRITER_LOCK_DIR?.trim()
    || (home ? join(home, '.gbrain', 'locks', 'corpus-writer.lock') : '');
  const waitSeconds = parseNonNegativeNumber(
    env.GBRAIN_AUTOPILOT_CORPUS_LOCK_WAIT_SECONDS,
    DEFAULT_WAIT_SECONDS,
  );
  const pollSeconds = parsePositiveNumber(
    env.GBRAIN_AUTOPILOT_CORPUS_LOCK_POLL_SECONDS,
    DEFAULT_POLL_SECONDS,
  );

  const invalidReason = !isAbsolute(helperPath)
    ? 'GBRAIN_RUN_LOCK_HELPER must be an absolute path'
    : !isAbsolute(pythonBin)
      ? 'GBRAIN_PYTHON_BIN must be an absolute path'
      : !lockDir || !isAbsolute(lockDir)
        ? 'GBRAIN_CORPUS_WRITER_LOCK_DIR must be an absolute path (or HOME must be set)'
        : waitSeconds == null
          ? 'GBRAIN_AUTOPILOT_CORPUS_LOCK_WAIT_SECONDS must be a non-negative number'
          : pollSeconds == null
            ? 'GBRAIN_AUTOPILOT_CORPUS_LOCK_POLL_SECONDS must be a positive number'
            : undefined;

  return {
    enabled: true,
    helperPath,
    pythonBin,
    lockDir,
    waitSeconds: waitSeconds ?? undefined,
    pollSeconds: pollSeconds ?? undefined,
    invalidReason,
  };
}

async function defaultRunLockHelper(invocation: RunLockInvocation): Promise<number> {
  const proc = Bun.spawn({
    cmd: invocation.argv,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const abort = () => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Process already exited.
    }
  };
  invocation.signal?.addEventListener('abort', abort, { once: true });
  // Close the check/listener race: AbortSignal does not replay an abort event
  // to a listener attached after cancellation.
  if (invocation.signal?.aborted) abort();
  try {
    return await proc.exited;
  } finally {
    invocation.signal?.removeEventListener('abort', abort);
  }
}

function helperArgv(
  config: Required<Pick<AutopilotCorpusWriterLockConfig,
    'helperPath' | 'pythonBin' | 'lockDir' | 'waitSeconds' | 'pollSeconds'>>,
  action: 'acquire' | 'release',
  tokenFile: string,
  ownerPid: number,
): string[] {
  const argv = [
    config.pythonBin,
    config.helperPath,
    action,
    '--lock-dir', config.lockDir,
    '--token-file', tokenFile,
    '--owner', OWNER,
    '--owner-pid', String(ownerPid),
  ];
  if (action === 'acquire') {
    argv.push(
      '--wait-seconds', String(config.waitSeconds),
      '--poll-seconds', String(config.pollSeconds),
    );
  }
  return argv;
}

/**
 * Run one Autopilot mutation/dispatch tick while holding the shared writer
 * lease.  A busy or broken helper never invokes `dispatch`; callback failures
 * are rethrown only after exact-owner release has been attempted.
 */
export async function withAutopilotCorpusWriterLock<T>(
  dispatch: (signal?: AbortSignal) => Promise<T>,
  options: AutopilotCorpusWriterLockOptions = {},
): Promise<AutopilotCorpusWriterLockResult<T>> {
  const config = options.config ?? resolveAutopilotCorpusWriterLockConfig(options.env);
  if (!config.enabled) {
    if (options.required) {
      return {
        status: 'deferred',
        reason: 'invalid_config',
        detail: 'GBRAIN_RUN_LOCK_HELPER is required for this corpus writer',
      };
    }
    return { status: 'completed', lock: 'disabled', value: await dispatch(options.signal) };
  }
  if (config.invalidReason) {
    return { status: 'deferred', reason: 'invalid_config', detail: config.invalidReason };
  }
  if (
    !config.helperPath || !config.pythonBin || !config.lockDir
    || config.waitSeconds == null || config.pollSeconds == null
  ) {
    return {
      status: 'deferred',
      reason: 'invalid_config',
      detail: 'enabled corpus-writer lock config is incomplete',
    };
  }
  if (options.signal?.aborted) {
    return { status: 'deferred', reason: 'aborted' };
  }

  const resolved = {
    helperPath: config.helperPath,
    pythonBin: config.pythonBin,
    lockDir: config.lockDir,
    waitSeconds: config.waitSeconds,
    pollSeconds: config.pollSeconds,
  };
  const ownerPid = options.ownerPid ?? process.pid;
  const nonce = (options.tokenNonce ?? randomUUID()).replace(/[^A-Za-z0-9._-]/g, '_');
  const tokenFile = join(dirname(config.lockDir), `.autopilot-corpus-writer.${ownerPid}.${nonce}.token`);
  const runHelper = options.runHelper ?? defaultRunLockHelper;

  let acquireExit: number;
  try {
    acquireExit = await runHelper({
      action: 'acquire',
      argv: helperArgv(resolved, 'acquire', tokenFile, ownerPid),
      signal: options.signal,
    });
  } catch (error) {
    return {
      status: 'deferred',
      reason: options.signal?.aborted ? 'aborted' : 'helper_error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (acquireExit !== 0) {
    // If cancellation raced a successful acquire, the exact-owner token may
    // already exist.  A best-effort release is safe: without our token the
    // helper is a no-op and can never remove another process's lock.
    if (options.signal?.aborted) {
      let releaseExit: number;
      try {
        releaseExit = await runHelper({
          action: 'release',
          argv: helperArgv(resolved, 'release', tokenFile, ownerPid),
        });
      } catch (error) {
        throw new AutopilotCorpusWriterLockReleaseError(
          `Autopilot corpus-writer lock release after cancelled acquire failed: ${error instanceof Error ? error.message : String(error)}`,
          { dispatchCompleted: false, cause: error },
        );
      }
      if (releaseExit !== 0) {
        throw new AutopilotCorpusWriterLockReleaseError(
          `Autopilot corpus-writer lock release after cancelled acquire failed with exit ${releaseExit}`,
          { dispatchCompleted: false, helperExitCode: releaseExit },
        );
      }
      return { status: 'deferred', reason: 'aborted', helper_exit_code: acquireExit };
    }
    return {
      status: 'deferred',
      reason: acquireExit === RUN_LOCK_BUSY_EXIT ? 'busy' : 'helper_error',
      helper_exit_code: acquireExit,
    };
  }

  // Cancellation can race the helper's successful exit. Never enter a
  // handler with an already-aborted signal; release the exact-owner token
  // first so the next writer does not wait for stale-owner recovery.
  if (options.signal?.aborted) {
    let releaseExit: number;
    try {
      releaseExit = await runHelper({
        action: 'release',
        argv: helperArgv(resolved, 'release', tokenFile, ownerPid),
      });
    } catch (error) {
      throw new AutopilotCorpusWriterLockReleaseError(
        `Autopilot corpus-writer lock release after cancelled acquire failed: ${error instanceof Error ? error.message : String(error)}`,
        { dispatchCompleted: false, cause: error },
      );
    }
    if (releaseExit !== 0) {
      throw new AutopilotCorpusWriterLockReleaseError(
        `Autopilot corpus-writer lock release after cancelled acquire failed with exit ${releaseExit}`,
        { dispatchCompleted: false, helperExitCode: releaseExit },
      );
    }
    return { status: 'deferred', reason: 'aborted' };
  }

  let dispatchFailed = false;
  let dispatchError: unknown;
  let value!: T;
  let releaseFailed = false;
  let releaseError: unknown;
  let releaseExit = 0;
  try {
    value = await dispatch(options.signal);
  } catch (error) {
    dispatchFailed = true;
    dispatchError = error;
  } finally {
    try {
      releaseExit = await runHelper({
        action: 'release',
        argv: helperArgv(resolved, 'release', tokenFile, ownerPid),
      });
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
  }

  // Preserve the primary dispatch failure.  If release also failed, surface
  // that secondary state without replacing the original error identity.
  if (dispatchFailed) {
    if (releaseFailed || releaseExit !== 0) {
      const detail = releaseFailed
        ? (releaseError instanceof Error ? releaseError.message : String(releaseError))
        : `helper exit ${releaseExit}`;
      const message = `Autopilot corpus-writer lock release also failed after dispatch failure: ${detail}`;
      if (options.onDiagnostic) options.onDiagnostic(message);
      else process.stderr.write(`[autopilot] ${message}\n`);
      if ((typeof dispatchError === 'object' && dispatchError !== null) || typeof dispatchError === 'function') {
        dispatchErrorsWithReleaseFailure.add(dispatchError as object);
      } else {
        // A primitive throw has no identity-bearing object that WeakSet can
        // mark. Preserve it as `cause` and surface an explicit fatal wrapper.
        throw new AutopilotCorpusWriterLockReleaseError(
          `${message}; primary dispatch error: ${String(dispatchError)}`,
          {
            dispatchCompleted: false,
            helperExitCode: releaseFailed ? undefined : releaseExit,
            cause: dispatchError,
            hasPrimaryDispatchError: true,
            primaryDispatchError: dispatchError,
          },
        );
      }
    }
    throw dispatchError;
  }
  if (releaseFailed) {
    throw new AutopilotCorpusWriterLockReleaseError(
      `Autopilot corpus-writer lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      { dispatchCompleted: true, completedValue: value, cause: releaseError },
    );
  }
  if (releaseExit !== 0) {
    throw new AutopilotCorpusWriterLockReleaseError(
      `Autopilot corpus-writer lock release failed with exit ${releaseExit}`,
      { dispatchCompleted: true, completedValue: value, helperExitCode: releaseExit },
    );
  }

  return { status: 'completed', lock: 'acquired', value };
}
