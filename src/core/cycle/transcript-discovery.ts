/**
 * Transcript discovery for the v0.23 dream-cycle synthesize phase.
 *
 * Walks a corpus directory for `.txt` files, applies date-range filters,
 * size filters (min_chars), and word-boundary regex exclude patterns.
 * Returns a list of file paths + content + content_hash so the caller
 * can key the verdict cache and dispatch one subagent per transcript.
 *
 * No DB; pure filesystem + crypto. Tested with hermetic temp directories.
 */

import { closeSync, openSync, readFileSync, readSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { safeLoad as yamlSafeLoad } from 'js-yaml';
import { pruneDir } from '../sync.ts';

export interface TranscriptLogicalIdentity {
  /** Identity schema owned jointly by the exporters and Dream. */
  version: 1;
  sourceNamespace: string;
  profile: string;
  sessionId: string;
  exportDate: string;
  /** One-based exporter part. Unsplit transcripts are part 1 of 1. */
  partIndex: number;
  partTotal: number;
  /** sha256(1\0namespace\0profile\0session_id\0export_date). */
  logicalSessionId: string;
  /** sha256(logical_session_id\0part_index). */
  logicalTranscriptId: string;
}

export interface DiscoveredTranscript {
  /** Absolute path to the transcript file. */
  filePath: string;
  /** sha256(content), full hex; callers slice as needed. */
  contentHash: string;
  /** Raw transcript text. */
  content: string;
  /** Filename basename without extension; used as a topic-slug seed. */
  basename: string;
  /** Inferred date if the basename matches `YYYY-MM-DD...` (or null). */
  inferredDate: string | null;
  /**
   * Stable exporter identity. Null only for legacy/ad-hoc transcript files
   * that predate the identity-bearing frontmatter contract.
   */
  logicalIdentity?: TranscriptLogicalIdentity | null;
}

export interface DiscoverOpts {
  /** Source directory. Required. */
  corpusDir: string;
  /** Optional second source. */
  meetingTranscriptsDir?: string;
  /** Skip transcripts smaller than this many characters. Default 2000. */
  minChars?: number;
  /** Word-boundary regex strings. The discoverer auto-wraps bare words. */
  excludePatterns?: string[];
  /** Restrict to a single date (YYYY-MM-DD basename match). */
  date?: string;
  /** Inclusive range start (YYYY-MM-DD). */
  from?: string;
  /** Inclusive range end (YYYY-MM-DD). */
  to?: string;
  /**
   * Disable the self-consumption guard. Caller must opt in explicitly via
   * `--unsafe-bypass-dream-guard`; never auto-applied for `--input` because
   * that would let any caller silently re-trigger the loop bug.
   */
  bypassGuard?: boolean;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const WORD_BOUNDARY_HEURISTIC = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const AUTOMATION_NAMESPACE_RE = /^(?:gbrain|dream|dream-cycle|cron|autopilot|scheduler)$/i;
const GBRAIN_CWD_RE = /(?:^|\/)(?:\.gbrain|gbrain|worktrees\/gbrain)(?:\/|$)/i;
const AUTOMATED_SESSION_TOMBSTONES = 'automated-session-tombstones.json';
const AUTOMATED_SESSION_TOMBSTONE_SCHEMA = 'gbrain-automated-session-tombstones/v1';
/** `sessions/<profile>/YYYY/MM/file` reaches its owner root in four entries. */
const MAX_PROVENANCE_ANCESTOR_DIRS = 8;

type TranscriptMetadata = Record<string, unknown>;

interface MetadataCheck {
  identity: TranscriptLogicalIdentity | null;
  rejectionReason: string | null;
}

interface ManifestIndexLoad {
  index: Map<string, TranscriptMetadata[]>;
  rejectionReason: string | null;
}

type ManifestIndexCache = Map<string, ManifestIndexLoad>;

/**
 * Parse only a leading YAML frontmatter block. Transcript bodies are
 * intentionally left opaque: prompts can contain additional `---` fences and
 * must never influence provenance classification.
 */
export function parseTranscriptFrontmatter(content: string): TranscriptMetadata {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) return {};
  try {
    const parsed = yamlSafeLoad(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as TranscriptMetadata
      : { __frontmatter_parse_error: true };
  } catch {
    return { __frontmatter_parse_error: true };
  }
}

function metadataString(meta: TranscriptMetadata, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function metadataBoolean(meta: TranscriptMetadata, key: string): boolean | null {
  const value = meta[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(?:true|1|yes)$/i.test(value.trim())) return true;
    if (/^(?:false|0|no)$/i.test(value.trim())) return false;
  }
  return null;
}

function isNonNullMetadataValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  return typeof value !== 'string' || value.trim().length > 0;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parsePart(meta: TranscriptMetadata): { index: number; total: number } | null {
  const explicitIndex = parsePositiveInt(meta.part_index);
  const explicitTotal = parsePositiveInt(meta.part_total);
  if (meta.part_index !== undefined && meta.part_index !== null && explicitIndex === null) return null;
  if (meta.part_total !== undefined && meta.part_total !== null && explicitTotal === null) return null;
  const rawPart = meta.part;
  const legacy = metadataString(meta, 'part');
  let legacyIndex: number | null = null;
  let legacyTotal: number | null = null;
  if (legacy) {
    const match = /^(\d+)\s*\/\s*(\d+)$/.exec(legacy);
    if (match) {
      legacyIndex = parsePositiveInt(match[1]);
      legacyTotal = parsePositiveInt(match[2]);
    } else {
      // Exporter frontmatter uses `part: "i/N"`, while the matching JSONL
      // manifest row uses numeric `part: i` plus explicit part_index/total.
      // Accept that numeric key only as a redundant assertion: both explicit
      // fields must exist and the numeric value must equal part_index.
      const manifestIndex = parsePositiveInt(rawPart);
      if (manifestIndex === null || explicitIndex === null || explicitTotal === null) return null;
      if (manifestIndex !== explicitIndex) return null;
    }
  }

  const index = explicitIndex ?? legacyIndex ?? 1;
  const total = explicitTotal ?? legacyTotal ?? 1;
  if (index > total) return null;
  if (explicitIndex !== null && legacyIndex !== null && explicitIndex !== legacyIndex) return null;
  if (explicitTotal !== null && legacyTotal !== null && explicitTotal !== legacyTotal) return null;
  return { index, total };
}

function sha256Tuple(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

function hasStableIdentitySurface(meta: TranscriptMetadata): boolean {
  if ([
    'logical_identity_version',
    'logical_session_id',
    'logical_transcript_id',
  ].some(key => Object.prototype.hasOwnProperty.call(meta, key))) {
    return true;
  }
  return Boolean(
    metadataString(meta, 'source_namespace', 'source', 'platform')
    && metadataString(meta, 'profile')
    && metadataString(meta, 'session_id')
    && metadataString(meta, 'export_date'),
  );
}

/**
 * Derive the stable transcript identity from normalized exporter metadata.
 * Supplied logical IDs are verification assertions, never authorities: Dream
 * recomputes both hashes and rejects a disagreement.
 */
export function deriveTranscriptLogicalIdentity(meta: TranscriptMetadata): TranscriptLogicalIdentity | null {
  const sourceNamespace = metadataString(meta, 'source_namespace', 'source', 'platform')?.toLowerCase() ?? null;
  const profile = metadataString(meta, 'profile')?.toLowerCase() ?? null;
  const sessionId = metadataString(meta, 'session_id');
  const exportDate = metadataString(meta, 'export_date');
  const part = parsePart(meta);
  if (!sourceNamespace || !profile || !sessionId || !exportDate || !ISO_DATE_RE.test(exportDate) || !part) {
    return null;
  }

  const version = parsePositiveInt(meta.logical_identity_version);
  if (meta.logical_identity_version !== undefined && version !== 1) return null;

  const logicalSessionId = sha256Tuple([1, sourceNamespace, profile, sessionId, exportDate]);
  const logicalTranscriptId = sha256Tuple([logicalSessionId, part.index]);
  const assertedSessionId = metadataString(meta, 'logical_session_id')?.toLowerCase() ?? null;
  const assertedTranscriptId = metadataString(meta, 'logical_transcript_id')?.toLowerCase() ?? null;
  if (assertedSessionId && (!SHA256_RE.test(assertedSessionId) || assertedSessionId !== logicalSessionId)) return null;
  if (assertedTranscriptId && (!SHA256_RE.test(assertedTranscriptId) || assertedTranscriptId !== logicalTranscriptId)) return null;

  return {
    version: 1,
    sourceNamespace,
    profile,
    sessionId,
    exportDate,
    partIndex: part.index,
    partTotal: part.total,
    logicalSessionId,
    logicalTranscriptId,
  };
}

/**
 * Fail-closed provenance gate for exporter-owned transcripts. It rejects
 * explicit automation markers on their own and also recognizes the legacy
 * Claude SDK automation tuple when coupled to a GBrain runtime path. A manual
 * Claude session merely run from a GBrain checkout remains eligible because
 * cwd alone is never an automation signal.
 */
export function automatedTranscriptReason(meta: TranscriptMetadata): string | null {
  if (meta.__frontmatter_parse_error === true) return 'malformed_frontmatter';
  if (metadataBoolean(meta, 'automated') === true) return 'automated=true';
  if (isNonNullMetadataValue(meta.automation_origin)) return 'automation_origin';

  const provenanceKind = metadataString(meta, 'provenance_kind');
  if (provenanceKind && provenanceKind.toLowerCase() !== 'human-session') {
    return `provenance_kind=${provenanceKind}`;
  }
  const exportedFor = metadataString(meta, 'exported_for');
  if (exportedFor && exportedFor !== 'gbrain_dream_synthesize') {
    return `exported_for=${exportedFor}`;
  }

  // Exporter-owned logical identities are eligible only after the exporter
  // has made an explicit, typed settlement assertion. Do not coerce strings:
  // `settled: "true"` is not the same contract as YAML/JSON boolean true.
  // Each provenance record is checked independently, so a settled manifest
  // cannot bless unsettled/conflicting frontmatter (or vice versa).
  const hasExporterIdentity = [
    'exported_for',
    'exporter_owner',
  ].some(key => Object.prototype.hasOwnProperty.call(meta, key))
    || hasStableIdentitySurface(meta);
  if (hasExporterIdentity) {
    if (!Object.prototype.hasOwnProperty.call(meta, 'settled')) {
      return 'exporter_settlement_missing';
    }
    if (meta.settled === false) return 'exporter_settlement_false';
    if (meta.settled !== true) return 'exporter_settlement_not_literal_true';
  }

  for (const key of ['source_namespace', 'source', 'profile'] as const) {
    const value = metadataString(meta, key);
    if (value && AUTOMATION_NAMESPACE_RE.test(value)) return `${key}=${value}`;
  }
  for (const key of ['generated_by', 'producer', 'trigger_kind', 'session_origin'] as const) {
    const value = metadataString(meta, key);
    if (value && /(?:^|[:/_-])(?:gbrain|dream|cron|autopilot|scheduler)(?:$|[:/_-])/i.test(value)) {
      return `${key}=${value}`;
    }
  }

  const entrypoint = metadataString(meta, 'session_entrypoint', 'entrypoint')?.toLowerCase();
  const promptSource = metadataString(meta, 'session_prompt_source', 'prompt_source', 'promptSource')?.toLowerCase();
  const permissionMode = metadataString(meta, 'session_permission_mode', 'permission_mode', 'permissionMode')?.toLowerCase();
  const cwd = metadataString(meta, 'session_cwd', 'cwd');
  if (entrypoint === 'sdk-cli' && promptSource === 'sdk' && permissionMode === 'auto' && cwd && GBRAIN_CWD_RE.test(cwd)) {
    return 'claude-sdk-auto-gbrain';
  }
  return null;
}

function inspectMetadata(meta: TranscriptMetadata): MetadataCheck {
  const rejectionReason = automatedTranscriptReason(meta);
  const hasIdentityAssertion = hasStableIdentitySurface(meta);
  const identity = deriveTranscriptLogicalIdentity(meta);
  if (!rejectionReason && hasIdentityAssertion && !identity) {
    return { identity: null, rejectionReason: 'invalid_logical_identity' };
  }
  return { identity, rejectionReason };
}

function canonicalLookupPath(filePath: string): string {
  const absolute = resolve(filePath);
  try {
    return realpathSync(absolute);
  } catch {
    // A manifest can legitimately describe an output that was since retired.
    // Preserve a stable lexical key when the target no longer exists.
    return absolute;
  }
}

function loadManifestIndex(
  corpusDir: string,
  cache?: ManifestIndexCache,
): ManifestIndexLoad {
  const cacheKey = canonicalLookupPath(corpusDir);
  const cached = cache?.get(cacheKey);
  if (cached) return cached;

  const index = new Map<string, TranscriptMetadata[]>();
  const manifestPath = join(corpusDir, '.manifest.jsonl');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    const result: ManifestIndexLoad = {
      index,
      rejectionReason: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? null
        : 'unreadable_export_manifest',
    };
    cache?.set(cacheKey, result);
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: TranscriptMetadata;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const result = { index, rejectionReason: 'invalid_export_manifest' };
        cache?.set(cacheKey, result);
        return result;
      }
      entry = parsed as TranscriptMetadata;
    } catch {
      const result = { index, rejectionReason: 'invalid_export_manifest' };
      cache?.set(cacheKey, result);
      return result;
    }
    const outputPath = metadataString(entry, 'output_path');
    if (!outputPath) {
      const result = { index, rejectionReason: 'invalid_export_manifest' };
      cache?.set(cacheKey, result);
      return result;
    }
    const absolute = canonicalLookupPath(
      isAbsolute(outputPath) ? outputPath : join(corpusDir, outputPath),
    );
    const entries = index.get(absolute) ?? [];
    entries.push(entry);
    index.set(absolute, entries);
  }
  const result = { index, rejectionReason: null };
  cache?.set(cacheKey, result);
  return result;
}

/**
 * Read a bounded prefix of the Claude JSONL source named by the exporter
 * manifest and recover only provenance fields. This is deliberately narrow:
 * it never returns prompt/body content, and only runs for GBrain-looking
 * source paths where the legacy exporter omitted the automation tuple.
 */
function loadClaudeSourceProvenance(manifest: TranscriptMetadata): TranscriptMetadata {
  const sourcePath = metadataString(manifest, 'source_path');
  const sessionId = metadataString(manifest, 'session_id');
  if (!sourcePath || !sessionId || !isAbsolute(sourcePath)) return {};
  if (!sourcePath.includes('/.claude/projects/') || !sourcePath.endsWith(`/${sessionId}.jsonl`)) return {};
  if (!/[-/]\.?gbrain(?:[-/]|$)/i.test(sourcePath)) return {};

  // Claude's first user record can carry a large deferred-tools snapshot;
  // 2 MiB covers the first complete metadata-bearing record in production
  // fixtures while remaining a hard I/O/memory bound.
  const maxBytes = 2 * 1024 * 1024;
  const buffer = Buffer.allocUnsafe(maxBytes);
  let fd: number | null = null;
  let bytesRead = 0;
  try {
    fd = openSync(sourcePath, 'r');
    bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
  } catch {
    return {};
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }

  const prefix = buffer.subarray(0, bytesRead).toString('utf8');
  const lines = prefix.split(/\r?\n/);
  if (bytesRead === maxBytes) lines.pop(); // possibly truncated JSON line
  const values = {
    entrypoint: new Set<string>(),
    promptSource: new Set<string>(),
    permissionMode: new Set<string>(),
    cwd: new Set<string>(),
  };
  for (const line of lines.slice(0, 20)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as TranscriptMetadata;
      const entrypoint = metadataString(row, 'entrypoint');
      const promptSource = metadataString(row, 'promptSource', 'prompt_source');
      const permissionMode = metadataString(row, 'permissionMode', 'permission_mode');
      const cwd = metadataString(row, 'cwd');
      if (entrypoint) values.entrypoint.add(entrypoint);
      if (promptSource) values.promptSource.add(promptSource);
      if (permissionMode) values.permissionMode.add(permissionMode);
      if (cwd) values.cwd.add(cwd);
    } catch {
      // Ignore queue-operation lines or truncated/non-JSON noise.
    }
  }
  // Never let an earlier attachment/assistant row carrying only `cwd` mask
  // the full SDK-auto tuple on a later user row. This source reader is a
  // rejection-only backstop for GBrain-looking raw paths, so preserve the
  // strongest automation evidence found anywhere in the bounded prefix.
  const gbrainCwd = [...values.cwd].find(cwd => GBRAIN_CWD_RE.test(cwd));
  if (
    values.entrypoint.has('sdk-cli')
    && values.promptSource.has('sdk')
    && values.permissionMode.has('auto')
    && gbrainCwd
  ) {
    return {
      session_entrypoint: 'sdk-cli',
      session_prompt_source: 'sdk',
      session_permission_mode: 'auto',
      session_cwd: gbrainCwd,
    };
  }
  const first = (set: Set<string>): string | undefined => set.values().next().value;
  const entrypoint = first(values.entrypoint);
  const promptSource = first(values.promptSource);
  const permissionMode = first(values.permissionMode);
  const cwd = first(values.cwd);
  return {
    ...(entrypoint ? { session_entrypoint: entrypoint } : {}),
    ...(promptSource ? { session_prompt_source: promptSource } : {}),
    ...(permissionMode ? { session_permission_mode: permissionMode } : {}),
    ...(cwd ? { session_cwd: cwd } : {}),
  };
}

function inspectTranscriptMetadata(
  frontmatter: TranscriptMetadata,
  manifest: TranscriptMetadata | TranscriptMetadata[] | undefined,
): MetadataCheck {
  const fileCheck = inspectMetadata(frontmatter);
  if (fileCheck.rejectionReason) return fileCheck;
  if (!manifest) return fileCheck;

  const manifests = Array.isArray(manifest) ? manifest : [manifest];
  let identity = fileCheck.identity;
  for (const entry of manifests) {
    const manifestWithSource = { ...entry, ...loadClaudeSourceProvenance(entry) };
    const manifestCheck = inspectMetadata(manifestWithSource);
    if (manifestCheck.rejectionReason) return manifestCheck;
    if (identity && manifestCheck.identity &&
        identity.logicalTranscriptId !== manifestCheck.identity.logicalTranscriptId) {
      return {
        identity: null,
        rejectionReason: fileCheck.identity
          ? 'frontmatter_manifest_identity_conflict'
          : 'manifest_identity_conflict',
      };
    }
    identity ??= manifestCheck.identity;
  }
  return { identity, rejectionReason: null };
}

function pathIsWithin(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Candidate provenance owners for an ad-hoc input. The walk is deliberately
 * bounded: it covers the production `<profile>/YYYY/MM` nesting without
 * searching arbitrary user ancestors. A configured corpus root is an exact
 * trusted boundary when the input is beneath it, even for a deeper layout.
 */
function manualProvenanceDirs(filePath: string, configuredRoot?: string | null): string[] {
  const absolute = canonicalLookupPath(filePath);
  const normalizedRoot = configuredRoot ? canonicalLookupPath(configuredRoot) : null;
  const boundary = normalizedRoot && pathIsWithin(absolute, normalizedRoot)
    ? normalizedRoot
    : null;
  const dirs: string[] = [];
  const seen = new Set<string>();
  let current = dirname(absolute);
  for (let i = 0; i < MAX_PROVENANCE_ANCESTOR_DIRS; i++) {
    if (!seen.has(current)) {
      dirs.push(current);
      seen.add(current);
    }
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (boundary && !seen.has(boundary)) dirs.push(boundary);
  return dirs;
}

function tombstoneRegistryReason(
  dirs: string[],
  sessionIds: Set<string>,
): string | null {
  for (const dir of dirs) {
    const registryPath = join(dir, AUTOMATED_SESSION_TOMBSTONES);
    let raw: string;
    try {
      raw = readFileSync(registryPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return 'unreadable_automated_session_tombstone_registry';
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 'invalid_automated_session_tombstone_registry';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'invalid_automated_session_tombstone_registry';
    }
    const registry = parsed as TranscriptMetadata;
    if (
      registry.schema !== AUTOMATED_SESSION_TOMBSTONE_SCHEMA
      || !Array.isArray(registry.session_ids)
      || registry.session_ids.some(
        value => typeof value !== 'string' || value.trim().length === 0,
      )
    ) {
      return 'invalid_automated_session_tombstone_registry';
    }
    const tombstones = new Set(
      (registry.session_ids as string[]).map(sessionId => sessionId.trim()),
    );
    if ([...sessionIds].some(sessionId => tombstones.has(sessionId))) {
      return 'automated_session_tombstone';
    }
  }
  return null;
}

/**
 * Tombstone registry owners for a configured transcript corpus.
 *
 * Corrected exporters may mirror the active registry at the corpus root.
 * During incident recovery the sealed evidence registry also lives in the
 * production sibling layout:
 *   <intake>/sessions
 *   <intake>/quarantine/automated-claude/automated-session-tombstones.json
 * Keep that explicit compatibility path until every exporter has converged on
 * the root mirror. Missing registries are normal; malformed/unreadable ones
 * remain fail-closed in tombstoneRegistryReason().
 */
function tombstoneRegistryDirs(
  provenanceDirs: string[],
  configuredRoot?: string | null,
): string[] {
  const dirs = [...provenanceDirs];
  if (configuredRoot) {
    const root = canonicalLookupPath(configuredRoot);
    dirs.push(join(dirname(root), 'quarantine', 'automated-claude'));
  }
  return [...new Set(dirs.map(dir => canonicalLookupPath(dir)))];
}

function inspectOwnedTranscriptMetadata(
  filePath: string,
  frontmatter: TranscriptMetadata,
  configuredRoot?: string | null,
  manifestCache?: ManifestIndexCache,
): MetadataCheck {
  const fileCheck = inspectMetadata(frontmatter);
  if (fileCheck.rejectionReason) return fileCheck;

  const absolute = canonicalLookupPath(filePath);
  const dirs = manualProvenanceDirs(absolute, configuredRoot);
  const manifestLoads = dirs.map(dir => loadManifestIndex(dir, manifestCache));
  const manifestFailure = manifestLoads.find(load => load.rejectionReason !== null);
  if (manifestFailure?.rejectionReason) {
    return { identity: null, rejectionReason: manifestFailure.rejectionReason };
  }
  const manifests = manifestLoads.flatMap(load => load.index.get(absolute) ?? []);
  const sessionIds = new Set<string>();
  const frontmatterSessionId = metadataString(frontmatter, 'session_id');
  if (frontmatterSessionId) sessionIds.add(frontmatterSessionId);
  for (const manifest of manifests) {
    const manifestSessionId = metadataString(manifest, 'session_id');
    if (manifestSessionId) sessionIds.add(manifestSessionId);
  }
  const tombstoneReason = tombstoneRegistryReason(
    tombstoneRegistryDirs(dirs, configuredRoot),
    sessionIds,
  );
  if (tombstoneReason) return { identity: null, rejectionReason: tombstoneReason };

  return inspectTranscriptMetadata(frontmatter, manifests);
}

/**
 * Self-consumption guard: identity-marker check against `dream_generated: true`
 * stamped by the synthesize phase's render paths.
 *
 * v0.23.1 used a body slug-prefix string match. Codex review of the v0.23.2
 * plan caught two flaws: (1) `serializeMarkdown` does NOT embed the page slug
 * into body content, so the prefix heuristic could miss real dream output, and
 * (2) real conversation transcripts that legitimately cite a brain page would
 * be silently dropped. v0.23.2 swaps content inference for explicit identity
 * stamped at render time.
 *
 * Regex anchored at frontmatter open (`---\n`), tolerates optional BOM and CRLF,
 * scans the first 2000 chars for `dream_generated: true` (any whitespace, case-
 * insensitive value, word boundary on `true`).
 */
const DREAM_MARKER_REGEX_SRC =
  '^\\uFEFF?-{3}\\r?\\n[\\s\\S]{0,2000}?dream_generated\\s*:\\s*true\\b';
export const DREAM_OUTPUT_MARKER_RE = new RegExp(DREAM_MARKER_REGEX_SRC, 'i');

/**
 * v0.37.0 (D9 / D4): brainstorm + LSD frontmatter markers. `mode: lsd`
 * pages are noise-by-design and must NEVER be re-ingested by the synthesize
 * phase (they're inverted-judge experiments, not user-validated knowledge).
 * `mode: brainstorm` pages stamp the saved-page provenance; they're not
 * auto-skipped at this layer because the corpus walker doesn't currently
 * read wiki/ideas/ — full loop closure (synthesize mines `mode: brainstorm`
 * pages for patterns) is filed as a v0.37.1 follow-up.
 */
const LSD_MODE_MARKER_REGEX_SRC =
  '^\\uFEFF?-{3}\\r?\\n[\\s\\S]{0,2000}?mode\\s*:\\s*(?:"|\\\'|)lsd(?:"|\\\'|)\\s*(?:\\r?\\n|$)';
export const LSD_OUTPUT_MARKER_RE = new RegExp(LSD_MODE_MARKER_REGEX_SRC, 'i');

const BRAINSTORM_MODE_MARKER_REGEX_SRC =
  '^\\uFEFF?-{3}\\r?\\n[\\s\\S]{0,2000}?mode\\s*:\\s*(?:"|\\\'|)brainstorm(?:"|\\\'|)\\s*(?:\\r?\\n|$)';
export const BRAINSTORM_OUTPUT_MARKER_RE = new RegExp(BRAINSTORM_MODE_MARKER_REGEX_SRC, 'i');

/** True iff this content carries the LSD frontmatter marker (D4 noise-by-design skip). */
export function isLsdOutput(content: string): boolean {
  return LSD_OUTPUT_MARKER_RE.test(content);
}

/** True iff this content carries the brainstorm frontmatter marker (saved by `gbrain brainstorm --save`). */
export function isBrainstormOutput(content: string): boolean {
  return BRAINSTORM_OUTPUT_MARKER_RE.test(content);
}

/**
 * Self-consumption guard: identity-marker check against the synthesize phase's
 * dream output, EXTENDED in v0.37.0 to also skip `mode: lsd` pages per D4.
 * The synthesize corpus walker now sees three categories:
 *   - dream output (its own writes): always skipped
 *   - LSD output: skipped (noise-by-design)
 *   - everything else (transcripts, manual notes, brainstorm output): processed
 *
 * `bypass` is the explicit `--unsafe-bypass-dream-guard` escape hatch; it bypasses
 * the dream-output check but NOT the LSD skip — there's no operator scenario
 * where re-ingesting LSD output is desired (LSD is ephemeral by definition).
 */
export function isDreamOutput(content: string, bypass = false): boolean {
  // LSD output ALWAYS skipped — bypass flag is for self-consumption only,
  // not for re-ingesting LSD experiments into the pattern extractor.
  if (isLsdOutput(content)) return true;
  if (bypass) return false;
  return DREAM_OUTPUT_MARKER_RE.test(content);
}

/**
 * Auto-wrap bare-word patterns in `\b<word>\b`. Power users can pass full
 * regex (e.g. `^therapy:`) which we honor verbatim. Heuristic: any input
 * that's purely alphanumeric+hyphen+underscore is treated as a bare word.
 */
export function compileExcludePatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    if (!p) continue;
    try {
      const src = WORD_BOUNDARY_HEURISTIC.test(p) ? `\\b${p}\\b` : p;
      out.push(new RegExp(src, 'i'));
    } catch (e) {
      // Bad regex from user config — skip with stderr warning, don't crash.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] invalid exclude_pattern '${p}': ${msg}\n`);
    }
  }
  return out;
}

function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isInDateRange(date: string | null, opts: DiscoverOpts): boolean {
  if (!opts.date && !opts.from && !opts.to) return true;
  if (!date) return false; // file has no inferable date but a filter is active
  if (opts.date && date !== opts.date) return false;
  if (opts.from && date < opts.from) return false;
  if (opts.to && date > opts.to) return false;
  return true;
}

function matchesAnyExclude(text: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
}

function listTextFiles(dir: string): string[] {
  // Recursive walk with descent-time pruning (closes codex C12/C13 spec gap).
  // Accepts BOTH .txt and .md per transcript-discovery's domain rules — does
  // NOT use isSyncable({strategy:'markdown'}) because that predicate rejects
  // .txt and applies markdown-only README/ops exclusions transcripts don't share.
  //
  // pruneDir at descent time skips node_modules / .git / .obsidian / .raw /
  // .cache / ops / etc. before recursion — saves the IO cost of walking
  // vendor subtrees.
  const out: string[] = [];
  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          // v0.37.7.0 #1169: pass parentDir so submodule pointers are
          // skipped at descent time.
          if (!pruneDir(name, d)) continue;
          walk(full);
        } else if (st.isFile() && (name.endsWith('.txt') || name.endsWith('.md'))) {
          out.push(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
  }
  walk(dir);
  return out.sort();
}

/**
 * Discover transcripts from the configured corpus dirs, applying filters.
 *
 * Skips files that:
 *  - aren't `.txt`
 *  - have date-prefixed basenames outside the requested window
 *  - have content shorter than `minChars`
 *  - carry the `dream_generated: true` self-consumption marker (unless `bypassGuard`)
 *  - match any compiled exclude pattern (case-insensitive word-boundary by default)
 *
 * Returns sorted by filePath so re-runs are deterministic.
 */
export function discoverTranscripts(opts: DiscoverOpts): DiscoveredTranscript[] {
  const minChars = opts.minChars ?? 2000;
  const bypass = opts.bypassGuard === true;
  const excludeRes = compileExcludePatterns(opts.excludePatterns);
  const dirs = [opts.corpusDir, opts.meetingTranscriptsDir].filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );

  const results: DiscoveredTranscript[] = [];
  const manifestCache: ManifestIndexCache = new Map();
  for (const dir of dirs) {
    for (const filePath of listTextFiles(dir)) {
      const ext = filePath.endsWith('.md') ? '.md' : '.txt';
      const baseName = basename(filePath, ext);
      const dateMatch = DATE_RE.exec(baseName);
      const inferredDate = dateMatch ? dateMatch[1] : null;
      if (!isInDateRange(inferredDate, opts)) continue;

      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      if (content.length < minChars) continue;
      if (isDreamOutput(content, bypass)) {
        process.stderr.write(`[dream] skipped ${baseName}: dream_generated marker (self-consumption guard)\n`);
        continue;
      }
      const metadataCheck = inspectOwnedTranscriptMetadata(
        filePath,
        parseTranscriptFrontmatter(content),
        dir,
        manifestCache,
      );
      if (metadataCheck.rejectionReason) {
        process.stderr.write(`[dream] skipped ${baseName}: provenance guard (${metadataCheck.rejectionReason})\n`);
        continue;
      }
      if (matchesAnyExclude(content, excludeRes)) continue;

      results.push({
        filePath,
        contentHash: hashContent(content),
        content,
        basename: baseName,
        inferredDate,
        logicalIdentity: metadataCheck.identity,
      });
    }
  }

  return results.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * Read a single ad-hoc transcript file (`gbrain dream --input <file>`).
 * Bypasses the corpus-dir scan and date filters but still applies
 * minChars + exclude_patterns when provided. The self-consumption guard
 * also still fires unless `bypassGuard` is set explicitly.
 */
export function readSingleTranscript(
  filePath: string,
  opts: {
    minChars?: number;
    excludePatterns?: string[];
    bypassGuard?: boolean;
    /** Configured session corpus root; used as an exact provenance boundary. */
    provenanceRoot?: string | null;
  } = {},
): DiscoveredTranscript | null {
  const minChars = opts.minChars ?? 2000;
  const bypass = opts.bypassGuard === true;
  const excludeRes = compileExcludePatterns(opts.excludePatterns);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not read transcript at ${filePath}: ${msg}`);
  }
  if (content.length < minChars) return null;
  if (isDreamOutput(content, bypass)) {
    const ext = filePath.endsWith('.md') ? '.md' : '.txt';
    const baseName = basename(filePath, ext);
    process.stderr.write(`[dream] readSingleTranscript skipped ${baseName}: dream_generated marker (self-consumption guard)\n`);
    return null;
  }
  // Manual --input keeps the same second provenance gate as scheduled
  // directory discovery. Resolve exporter manifests and automation tombstones
  // through the bounded owner-ancestor chain so production's
  // `<profile>/YYYY/MM` nesting cannot hide provenance from this ad-hoc path.
  const metadataCheck = inspectOwnedTranscriptMetadata(
    filePath,
    parseTranscriptFrontmatter(content),
    opts.provenanceRoot,
  );
  if (metadataCheck.rejectionReason) {
    const ext = filePath.endsWith('.md') ? '.md' : '.txt';
    const baseName = basename(filePath, ext);
    process.stderr.write(`[dream] readSingleTranscript skipped ${baseName}: provenance guard (${metadataCheck.rejectionReason})\n`);
    return null;
  }
  if (matchesAnyExclude(content, excludeRes)) return null;
  const ext = filePath.endsWith('.md') ? '.md' : '.txt';
  const baseName = basename(filePath, ext);
  const dateMatch = DATE_RE.exec(baseName);
  return {
    filePath,
    contentHash: hashContent(content),
    content,
    basename: baseName,
    inferredDate: dateMatch ? dateMatch[1] : null,
    logicalIdentity: metadataCheck.identity,
  };
}
