/**
 * Read-only repo/code-source intake gate for the codebase-auditor lane.
 *
 * This module deliberately does NOT register sources, clone repos, sync code,
 * or mutate GBrain. It answers whether a repo/source is ready for the
 * source-fenced codebase auditor, and emits argv-shaped next steps for Alex or
 * an approved operator lane to run after reviewing scope/sensitivity.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { basename } from 'path';
import type { BrainEngine } from './engine.ts';
import { assertValidSourceId } from './source-id.ts';
import { defaultCloneDir } from './sources-ops.ts';

type CodeIntakeVerdict =
  | 'ready_for_registration'
  | 'indexed_fresh'
  | 'indexed_stale'
  | 'blocked';

type AuditorGate =
  | 'BLOCKED_REPO_PRECHECK'
  | 'BLOCKED_NEEDS_REPO_INTAKE'
  | 'BLOCKED_INDEX_STALE'
  | 'BLOCKED_SOURCE_POLICY'
  | 'READY_FOR_CODEBASE_AUDITOR';

export interface CodeIntakeStep {
  label: string;
  argv: string[];
  mutates: 'filesystem' | 'gbrain-db' | 'gbrain-index' | 'profile-config' | 'none';
  note: string;
}

export interface CodeIntakeReport {
  schema_version: 1;
  source_id: string;
  verdict: CodeIntakeVerdict;
  auditor_gate: AuditorGate;
  repo: {
    input_path: string;
    root: string | null;
    branch: string | null;
    head: string | null;
    dirty: boolean | null;
    dirty_entries: string[];
    remote_url_redacted: string | null;
  };
  source: {
    exists: boolean;
    id: string;
    local_path: string | null;
    last_commit: string | null;
    last_sync_at: string | null;
    federated: boolean | null;
    archived: boolean | null;
    page_count: number | null;
    managed_clone_path: string;
  };
  stop_gates: string[];
  warnings: string[];
  recommended_steps: CodeIntakeStep[];
}

interface BuildCodeIntakeReportOpts {
  repoPath: string;
  sourceId: string;
  displayName?: string;
  knownSymbol?: string;
}

interface SourceSnapshot {
  id: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | string | null;
  config: unknown;
  archived: boolean | null;
  page_count: number;
}

export async function buildCodeIntakeReport(
  engine: BrainEngine,
  opts: BuildCodeIntakeReportOpts,
): Promise<CodeIntakeReport> {
  assertValidSourceId(opts.sourceId);

  const sourceId = opts.sourceId;
  const repo = inspectGitRepo(opts.repoPath);
  const source = await loadSourceSnapshot(engine, sourceId);
  const managedClonePath = defaultCloneDir(sourceId);
  const stopGates: string[] = [];
  const warnings: string[] = [];

  if (!repo.root) stopGates.push('repo_not_git');
  if (repo.dirty === true) warnings.push('working_tree_dirty_uncommitted_changes_not_indexed_by_default');

  const sourceFederated = source ? isFederated(source.config) : null;
  if (source?.archived === true) stopGates.push('source_is_archived');
  if (sourceFederated === true) stopGates.push('source_is_federated');

  if (!source) {
    stopGates.push('source_not_registered');
  } else if (repo.head && source.last_commit !== repo.head) {
    stopGates.push('index_commit_mismatch');
  }
  if (source && source.page_count === 0) {
    stopGates.push('source_has_no_code_pages');
  }

  const sourceBlock = stopGates.some((gate) => gate === 'source_is_archived' || gate === 'source_is_federated');
  const repoBlock = stopGates.includes('repo_not_git');

  let verdict: CodeIntakeVerdict;
  let auditorGate: AuditorGate;
  if (repoBlock) {
    verdict = 'blocked';
    auditorGate = 'BLOCKED_REPO_PRECHECK';
  } else if (sourceBlock) {
    verdict = 'blocked';
    auditorGate = 'BLOCKED_SOURCE_POLICY';
  } else if (!source) {
    verdict = 'ready_for_registration';
    auditorGate = 'BLOCKED_NEEDS_REPO_INTAKE';
  } else if (stopGates.includes('index_commit_mismatch') || stopGates.includes('source_has_no_code_pages')) {
    verdict = 'indexed_stale';
    auditorGate = 'BLOCKED_INDEX_STALE';
  } else {
    verdict = 'indexed_fresh';
    auditorGate = 'READY_FOR_CODEBASE_AUDITOR';
  }

  return {
    schema_version: 1,
    source_id: sourceId,
    verdict,
    auditor_gate: auditorGate,
    repo,
    source: {
      exists: Boolean(source),
      id: sourceId,
      local_path: source?.local_path ?? null,
      last_commit: source?.last_commit ?? null,
      last_sync_at: source?.last_sync_at ? new Date(source.last_sync_at).toISOString() : null,
      federated: sourceFederated,
      archived: source?.archived ?? null,
      page_count: source?.page_count ?? null,
      managed_clone_path: managedClonePath,
    },
    stop_gates: stopGates,
    warnings,
    recommended_steps: buildRecommendedSteps({
      sourceId,
      repoRoot: repo.root,
      repoHead: repo.head,
      managedClonePath,
      displayName: opts.displayName ?? displayNameForSource(sourceId, repo.root),
      knownSymbol: opts.knownSymbol,
      includeRegistration: !source,
      includeSync: !source || auditorGate === 'BLOCKED_INDEX_STALE',
      blocked: repoBlock || sourceBlock,
    }),
  };
}

function inspectGitRepo(inputPath: string): CodeIntakeReport['repo'] {
  if (!existsSync(inputPath)) {
    return {
      input_path: inputPath,
      root: null,
      branch: null,
      head: null,
      dirty: null,
      dirty_entries: [],
      remote_url_redacted: null,
    };
  }

  const root = git(inputPath, ['rev-parse', '--show-toplevel']);
  if (!root) {
    return {
      input_path: inputPath,
      root: null,
      branch: null,
      head: null,
      dirty: null,
      dirty_entries: [],
      remote_url_redacted: null,
    };
  }

  const head = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(root, ['status', '--porcelain=v1']) ?? '';
  const dirtyEntries = status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 25);
  const remote = git(root, ['remote', 'get-url', 'origin']);

  return {
    input_path: inputPath,
    root,
    branch,
    head,
    dirty: dirtyEntries.length > 0,
    dirty_entries: dirtyEntries,
    remote_url_redacted: remote ? redactRemoteUrl(remote) : null,
  };
}

async function loadSourceSnapshot(engine: BrainEngine, id: string): Promise<SourceSnapshot | null> {
  const rows = await engine.executeRaw<{
    id: string;
    local_path: string | null;
    last_commit: string | null;
    last_sync_at: Date | string | null;
    config: unknown;
    archived: boolean | null;
    page_count: number;
  }>(
    `SELECT s.id,
            s.local_path,
            s.last_commit,
            s.last_sync_at,
            s.config,
            s.archived,
            COUNT(p.id)::int AS page_count
       FROM sources s
       LEFT JOIN pages p ON p.source_id = s.id
      WHERE s.id = $1
      GROUP BY s.id, s.local_path, s.last_commit, s.last_sync_at, s.config, s.archived`,
    [id],
  );
  return rows[0] ?? null;
}

function isFederated(config: unknown): boolean {
  const parsed = typeof config === 'string'
    ? safeJsonObject(config)
    : (typeof config === 'object' && config !== null ? config as Record<string, unknown> : {});
  return parsed.federated === true;
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {};
}

function buildRecommendedSteps(opts: {
  sourceId: string;
  repoRoot: string | null;
  repoHead: string | null;
  managedClonePath: string;
  displayName: string;
  knownSymbol?: string;
  includeRegistration: boolean;
  includeSync: boolean;
  blocked: boolean;
}): CodeIntakeStep[] {
  if (opts.blocked || !opts.repoRoot || !opts.repoHead) return [];

  const steps: CodeIntakeStep[] = [];
  if (opts.includeRegistration) {
    steps.push({
      label: 'create-managed-worktree',
      argv: ['git', '-C', opts.repoRoot, 'worktree', 'add', '--detach', opts.managedClonePath, opts.repoHead],
      mutates: 'filesystem',
      note: 'Creates a clean detached managed code-index source root at the approved commit; does not index yet.',
    });
    steps.push({
      label: 'register-non-federated-code-source',
      argv: [
        'gbrain', 'sources', 'add', opts.sourceId,
        '--path', opts.managedClonePath,
        '--name', opts.displayName,
        '--no-federated',
      ],
      mutates: 'gbrain-db',
      note: 'Registers the repo as an explicit structural code source, not ordinary Brain retrieval.',
    });
  }

  if (opts.includeSync) {
    steps.push({
      label: 'sync-code-no-embed',
      argv: [
        'gbrain', 'sync',
        '--source', opts.sourceId,
        '--strategy', 'code',
        '--no-embed',
        '--no-pull',
        '--yes',
      ],
      mutates: 'gbrain-index',
      note: 'Imports structural code pages/chunks/edges without embeddings or network pull.',
    });
  }

  steps.push({
    label: 'smoke-structural-code-lookup',
    argv: [
      'gbrain', 'code-def', opts.knownSymbol ?? '<KnownSymbol>',
      '--source', opts.sourceId,
      '--json',
    ],
    mutates: 'none',
    note: 'Proves explicit-source structural lookup before handing the source to the auditor.',
  });
  steps.push({
    label: 'authorize-auditor-source-id',
    argv: ['hermes-profile-config', 'allow-code-source', 'codebase-auditor-worker', opts.sourceId],
    mutates: 'profile-config',
    note: 'Conceptual profile-config gate: add this source id to the auditor MCP allowlist only after scope/sensitivity approval.',
  });
  return steps;
}

function displayNameForSource(sourceId: string, repoRoot: string | null): string {
  const repoName = repoRoot ? basename(repoRoot) : sourceId.replace(/-code$/, '');
  return `${repoName} code`;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function redactRemoteUrl(remote: string): string {
  return remote
    .replace(/:\/\/([^/@]+)@/g, '://[REDACTED]@')
    .replace(/(token|password|oauth|apikey|api_key)=([^&]+)/gi, '$1=[REDACTED]');
}
