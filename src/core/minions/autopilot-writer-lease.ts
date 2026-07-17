/** Execution-boundary corpus-writer lease for Autopilot Minion jobs. */

import type { MinionJobContext } from './types.ts';
import {
  resolveAutopilotCorpusWriterLockConfig,
  withAutopilotCorpusWriterLock,
  type AutopilotCorpusWriterLockOptions,
} from '../autopilot-corpus-writer-lock.ts';

export const AUTOPILOT_JOB_PROVENANCE = 'gbrain-autopilot/v1';
export const AUTOPILOT_JOB_PROVENANCE_KEY = 'autopilot_provenance';
const DEFAULT_RETRY_MS = 30_000;

// Old queued full-cycle rows predate the explicit provenance field. Their
// protected handler names are sufficient attribution and keep deployment from
// opening a one-night race window while the old queue drains.
const LEGACY_AUTOPILOT_JOB_NAMES = new Set([
  'autopilot-cycle',
  'autopilot-global-maintenance',
]);

export function withAutopilotJobProvenance(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...data,
    origin: 'autopilot',
    [AUTOPILOT_JOB_PROVENANCE_KEY]: AUTOPILOT_JOB_PROVENANCE,
  };
}

/** Exact marker check; a generic `origin` string is audit metadata, not trust. */
export function isAutopilotAttributedJob(
  name: string,
  data: Record<string, unknown>,
): boolean {
  return LEGACY_AUTOPILOT_JOB_NAMES.has(name)
    || data[AUTOPILOT_JOB_PROVENANCE_KEY] === AUTOPILOT_JOB_PROVENANCE;
}

export function resolveAutopilotWriterRetryMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.GBRAIN_AUTOPILOT_CORPUS_LOCK_RETRY_SECONDS;
  if (raw == null || raw.trim() === '') return DEFAULT_RETRY_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_MS;
  return Math.min(seconds * 1000, 15 * 60_000);
}

export type AutopilotWriterExecutionResult<T> =
  | { status: 'completed'; guarded: boolean; value: T }
  | {
      status: 'deferred';
      reason: 'busy' | 'aborted' | 'invalid_config' | 'helper_error';
      retryAfterMs: number;
      helperExitCode?: number;
      detail?: string;
    };

export interface AutopilotWriterExecutionOptions {
  lock?: AutopilotCorpusWriterLockOptions;
  env?: NodeJS.ProcessEnv;
}

/**
 * Gate the actual handler execution, not queue submission. Tagged jobs fail
 * closed if the sealed helper is absent; untagged manual jobs are untouched.
 */
export async function runAutopilotJobWithWriterLease<T>(
  job: Pick<MinionJobContext, 'name' | 'data' | 'signal'>,
  handler: () => Promise<T>,
  options: AutopilotWriterExecutionOptions = {},
): Promise<AutopilotWriterExecutionResult<T>> {
  if (!isAutopilotAttributedJob(job.name, job.data)) {
    return { status: 'completed', guarded: false, value: await handler() };
  }

  const env = options.env ?? options.lock?.env ?? process.env;
  const configured = options.lock?.config ?? resolveAutopilotCorpusWriterLockConfig(env);
  if (!configured.enabled) {
    return {
      status: 'deferred',
      reason: 'invalid_config',
      retryAfterMs: resolveAutopilotWriterRetryMs(env),
      detail: 'GBRAIN_RUN_LOCK_HELPER is required for Autopilot-attributed jobs',
    };
  }

  const outcome = await withAutopilotCorpusWriterLock(
    async () => handler(),
    {
      ...options.lock,
      config: configured,
      signal: job.signal,
    },
  );
  if (outcome.status === 'completed') {
    return { status: 'completed', guarded: true, value: outcome.value };
  }
  return {
    status: 'deferred',
    reason: outcome.reason,
    retryAfterMs: resolveAutopilotWriterRetryMs(env),
    helperExitCode: outcome.helper_exit_code,
    detail: outcome.detail,
  };
}

