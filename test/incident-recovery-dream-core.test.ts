import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  automatedTranscriptReason,
  deriveTranscriptLogicalIdentity,
  discoverTranscripts,
  readSingleTranscript,
} from '../src/core/cycle/transcript-discovery.ts';
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function exporterMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_namespace: 'claude-code',
    source: 'claude-code',
    profile: 'claude-code',
    session_id: 'session-stable-1',
    export_date: '2026-07-15',
    part_index: 1,
    part_total: 1,
    logical_identity_version: 1,
    exporter_owner: 'gbrain:claude-session-export',
    provenance_kind: 'human-session',
    automated: false,
    automation_origin: null,
    settled: true,
    exported_for: 'gbrain_dream_synthesize',
    ...overrides,
  };
}

function legacyClaudeExportMeta(sessionId: string): Record<string, unknown> {
  return {
    source: 'claude-code',
    profile: 'claude-code',
    session_id: sessionId,
    platform: 'claude-code',
    chat_type: null,
    display_name: null,
    exported_for: 'gbrain_dream_synthesize',
    dream_generated: false,
    export_date: '2026-07-15',
    part: '2/2',
    cwd: '/Users/jarvis/.gbrain',
  };
}

function renderTranscript(meta: Record<string, unknown>, bodyMarker = 'alpha'): string {
  const yaml = Object.entries(meta).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  return `---\n${yaml}\n---\n\n# Session\n\n${`${bodyMarker} durable conversation. `.repeat(180)}`;
}

function sha256Tuple(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

describe('corrective Dream transcript identity + provenance gate', () => {
  test('identity is content-independent, uses exact v1 hash contract, and changed bytes retain one key', () => {
    const dir = tempDir('gbrain-dream-identity-');
    const path = join(dir, '2026-07-15__claude-code__session-stable-1.md');
    writeFileSync(path, renderTranscript(exporterMeta(), 'alpha'));
    const first = discoverTranscripts({ corpusDir: dir, minChars: 100 });
    expect(first).toHaveLength(1);

    writeFileSync(path, renderTranscript(exporterMeta(), 'beta changed bytes'));
    const second = discoverTranscripts({ corpusDir: dir, minChars: 100 });
    expect(second).toHaveLength(1);
    expect(second[0].contentHash).not.toBe(first[0].contentHash);
    expect(second[0].logicalIdentity).toEqual(first[0].logicalIdentity);

    const expectedSession = sha256Tuple([1, 'claude-code', 'claude-code', 'session-stable-1', '2026-07-15']);
    const expectedTranscript = sha256Tuple([expectedSession, 1]);
    expect(first[0].logicalIdentity?.logicalSessionId).toBe(expectedSession);
    expect(first[0].logicalIdentity?.logicalTranscriptId).toBe(expectedTranscript);
  });

  test('actual exporter numeric manifest parts agree with i/N frontmatter for Claude and Hermes', () => {
    const dir = tempDir('gbrain-dream-exporter-split-parts-');
    const fixtures = [
      {
        source: 'claude-code', profile: 'claude-code', owner: 'gbrain:claude-session-export',
        sessionId: 'claude-split-session', file: '2026-07-15__claude-code__claude-split-session__part2.md',
      },
      {
        source: 'hermes', profile: 'alex', owner: 'gbrain:hermes-session-export',
        sessionId: 'hermes-split-session', file: '2026-07-15__alex__hermes-split-session__part2.md',
      },
    ];
    const manifests: Array<Record<string, unknown>> = [];
    const paths: string[] = [];
    for (const fixture of fixtures) {
      const logicalSessionId = sha256Tuple([
        1, fixture.source, fixture.profile, fixture.sessionId, '2026-07-15',
      ]);
      const logicalTranscriptId = sha256Tuple([logicalSessionId, 2]);
      const path = join(dir, fixture.profile, '2026', '07', fixture.file);
      mkdirSync(join(dir, fixture.profile, '2026', '07'), { recursive: true });
      const metadata = exporterMeta({
        source: fixture.source,
        source_namespace: fixture.source,
        profile: fixture.profile,
        session_id: fixture.sessionId,
        exporter_owner: fixture.owner,
        part: '2/2',
        part_index: 2,
        part_total: 2,
        logical_session_id: logicalSessionId,
        logical_transcript_id: logicalTranscriptId,
      });
      writeFileSync(path, renderTranscript(metadata, `${fixture.profile}-before`));
      paths.push(path);
      manifests.push({ ...metadata, part: 2, output_path: path });
    }
    writeFileSync(join(dir, '.manifest.jsonl'), manifests.map(row => JSON.stringify(row)).join('\n') + '\n');

    const first = discoverTranscripts({ corpusDir: dir, minChars: 100 });
    expect(first).toHaveLength(2);
    for (const [index, path] of paths.entries()) {
      const metadata: Record<string, unknown> = { ...manifests[index], part: '2/2' };
      delete metadata.output_path;
      writeFileSync(path, renderTranscript(metadata, `${fixtures[index].profile}-changed-bytes`));
    }
    const changed = discoverTranscripts({ corpusDir: dir, minChars: 100 });
    expect(changed).toHaveLength(2);
    expect(new Set(changed.map(item => item.logicalIdentity!.logicalTranscriptId)).size).toBe(2);

    manifests[0].part = 1;
    writeFileSync(join(dir, '.manifest.jsonl'), manifests.map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 }).map(item => item.filePath))
      .toEqual([paths[1]]);
  });

  test('parts share a logical session but remain distinct; source namespaces remain distinct', () => {
    const part1 = deriveTranscriptLogicalIdentity(exporterMeta({ part_index: 1, part_total: 2, part: '1/2' }));
    const part2 = deriveTranscriptLogicalIdentity(exporterMeta({ part_index: 2, part_total: 2, part: '2/2' }));
    const hermes = deriveTranscriptLogicalIdentity(exporterMeta({
      source_namespace: 'hermes',
      source: 'hermes',
      profile: 'claude-code',
    }));
    expect(part1?.logicalSessionId).toBe(part2?.logicalSessionId);
    expect(part1?.logicalTranscriptId).not.toBe(part2?.logicalTranscriptId);
    expect(part1?.logicalSessionId).not.toBe(hermes?.logicalSessionId);
    expect(part1?.logicalTranscriptId).not.toBe(hermes?.logicalTranscriptId);
  });

  test('asserted logical ID mismatch fails closed', () => {
    expect(deriveTranscriptLogicalIdentity(exporterMeta({ logical_transcript_id: '0'.repeat(64) }))).toBeNull();
  });

  test('explicit automation and legacy SDK-auto provenance are rejected; cwd alone remains manual', () => {
    expect(automatedTranscriptReason(exporterMeta({ automated: true }))).toBe('automated=true');
    expect(automatedTranscriptReason(exporterMeta({ provenance_kind: 'cron-output' })))
      .toBe('provenance_kind=cron-output');
    expect(automatedTranscriptReason(exporterMeta({ automation_origin: 'gbrain:dream-daily' })))
      .toBe('automation_origin');
    expect(automatedTranscriptReason(exporterMeta({
      session_entrypoint: 'sdk-cli',
      session_prompt_source: 'sdk',
      session_permission_mode: 'auto',
      session_cwd: '/Users/jarvis/.gbrain',
    }))).toBe('claude-sdk-auto-gbrain');
    expect(automatedTranscriptReason(exporterMeta({ session_cwd: '/Users/jarvis/gbrain' }))).toBeNull();
  });

  test('exporter settlement is fail-closed and accepts only literal boolean true', () => {
    const missing = exporterMeta();
    delete missing.settled;
    expect(automatedTranscriptReason(missing)).toBe('exporter_settlement_missing');
    expect(automatedTranscriptReason(exporterMeta({ settled: false })))
      .toBe('exporter_settlement_false');
    expect(automatedTranscriptReason(exporterMeta({ settled: 'true' })))
      .toBe('exporter_settlement_not_literal_true');
    expect(automatedTranscriptReason(exporterMeta({ settled: true }))).toBeNull();

    const dir = tempDir('gbrain-dream-settlement-gate-');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing', missing],
      ['false', exporterMeta({ session_id: 'session-false', settled: false })],
      ['string-true', exporterMeta({ session_id: 'session-string-true', settled: 'true' })],
      ['literal-true', exporterMeta({ session_id: 'session-literal-true', settled: true })],
    ];
    for (const [name, meta] of cases) {
      writeFileSync(join(dir, `2026-07-15-${name}.md`), renderTranscript(meta, name));
    }
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 }).map(item => item.basename))
      .toEqual(['2026-07-15-literal-true']);
  });

  test('frontmatter and manifest must each independently assert literal settlement', () => {
    const dir = tempDir('gbrain-dream-settlement-conflict-');
    const path = join(dir, '2026-07-15-session.md');
    const manifestPath = join(dir, '.manifest.jsonl');

    writeFileSync(path, renderTranscript(exporterMeta({ settled: true })));
    writeFileSync(manifestPath, `${JSON.stringify({
      ...exporterMeta({ settled: false }),
      output_path: path,
    })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);

    writeFileSync(path, renderTranscript(exporterMeta({ settled: false })));
    writeFileSync(manifestPath, `${JSON.stringify({
      ...exporterMeta({ settled: true }),
      output_path: path,
    })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);

    writeFileSync(path, renderTranscript(exporterMeta({ settled: true })));
    writeFileSync(manifestPath, `${JSON.stringify({
      ...exporterMeta({ settled: 'true' }),
      output_path: path,
    })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);

    const frontmatterMissingSettlement = exporterMeta();
    delete frontmatterMissingSettlement.settled;
    writeFileSync(path, renderTranscript(frontmatterMissingSettlement));
    writeFileSync(manifestPath, `${JSON.stringify({
      ...exporterMeta({ settled: true }),
      output_path: path,
    })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);

    const manifestMissingSettlement = exporterMeta();
    delete manifestMissingSettlement.settled;
    writeFileSync(path, renderTranscript(exporterMeta({ settled: true })));
    writeFileSync(manifestPath, `${JSON.stringify({
      ...manifestMissingSettlement,
      output_path: path,
    })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);
  });

  test('unsafe dream marker bypass does not bypass the independent automation provenance gate', () => {
    const dir = tempDir('gbrain-dream-auto-gate-');
    const path = join(dir, '2026-07-15-automated.md');
    writeFileSync(path, renderTranscript(exporterMeta({ automated: true })));
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100, bypassGuard: true })).toEqual([]);
  });

  test('manifest automation metadata and identity conflicts independently reject a benign-looking file', () => {
    const dir = tempDir('gbrain-dream-manifest-gate-');
    const path = join(dir, '2026-07-15-session.md');
    writeFileSync(path, renderTranscript(exporterMeta()));
    writeFileSync(join(dir, '.manifest.jsonl'), `${JSON.stringify({ output_path: path, automated: true })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);

    writeFileSync(join(dir, '.manifest.jsonl'), [
      JSON.stringify({ output_path: path, automated: true }),
      JSON.stringify({ ...exporterMeta(), output_path: path }),
      '',
    ].join('\n'));
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);

    writeFileSync(join(dir, '.manifest.jsonl'), `${JSON.stringify({
      ...exporterMeta({ source_namespace: 'hermes', source: 'hermes' }),
      output_path: path,
    })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);
  });

  test('manual --input uses the adjacent manifest provenance gate', () => {
    const dir = tempDir('gbrain-dream-manual-manifest-gate-');
    const path = join(dir, '2026-07-15-session.md');
    writeFileSync(path, renderTranscript(exporterMeta()));
    writeFileSync(join(dir, '.manifest.jsonl'), `${JSON.stringify({
      output_path: path,
      automated: true,
      automation_origin: 'gbrain:dream-daily',
    })}\n`);
    expect(readSingleTranscript(path, { minChars: 100 })).toBeNull();
  });

  test('configured corpus root is an exact boundary beyond the bounded ancestor walk', () => {
    const sessionsDir = tempDir('gbrain-dream-manual-config-root-');
    const sessionId = 'deep-automated-session';
    let exportDir = sessionsDir;
    for (let i = 0; i < 10; i++) exportDir = join(exportDir, `level-${i}`);
    mkdirSync(exportDir, { recursive: true });
    const path = join(exportDir, `2026-07-15__claude-code__${sessionId}.md`);
    writeFileSync(path, renderTranscript({ ...legacyClaudeExportMeta(sessionId), settled: true }));
    writeFileSync(join(sessionsDir, '.manifest.jsonl'), `${JSON.stringify({
      output_path: path,
      automated: true,
    })}\n`);

    expect(readSingleTranscript(path, { minChars: 100 })).not.toBeNull();
    expect(readSingleTranscript(path, {
      minChars: 100,
      provenanceRoot: sessionsDir,
    })).toBeNull();
  });

  test('manual --input finds the production ancestor manifest for a nested legacy Claude export', () => {
    const sessionsDir = tempDir('gbrain-dream-manual-ancestor-manifest-');
    const sessionId = 'legacy-automated-session';
    const exportDir = join(sessionsDir, 'claude-code', '2026', '07');
    mkdirSync(exportDir, { recursive: true });
    const path = join(exportDir, `2026-07-15__claude-code__${sessionId}__part2.md`);
    const legacyMeta = { ...legacyClaudeExportMeta(sessionId), settled: true };
    expect(automatedTranscriptReason(legacyMeta)).toBeNull();
    writeFileSync(path, renderTranscript(legacyMeta));

    const rawDir = join(sessionsDir, '.claude', 'projects', '-Users-jarvis--gbrain');
    mkdirSync(rawDir, { recursive: true });
    const sourcePath = join(rawDir, `${sessionId}.jsonl`);
    writeFileSync(sourcePath, `${JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-cli',
      promptSource: 'sdk',
      permissionMode: 'auto',
      cwd: '/Users/jarvis/.gbrain',
    })}\n`);
    writeFileSync(join(sessionsDir, '.manifest.jsonl'), `${JSON.stringify({
      output_path: path,
      source_path: sourcePath,
      session_id: sessionId,
    })}\n`);

    expect(readSingleTranscript(path, { minChars: 100 })).toBeNull();
  });

  test('manual --input rejects a quarantined legacy export by ancestor tombstone and fails closed on malformed registry', () => {
    const quarantineDir = tempDir('gbrain-dream-manual-tombstone-');
    const sessionId = 'known-automated-session';
    const exportDir = join(quarantineDir, 'claude-code', '2026', '07');
    mkdirSync(exportDir, { recursive: true });
    const path = join(exportDir, `2026-07-15__claude-code__${sessionId}__part2.md.quarantined`);
    const legacyMeta = { ...legacyClaudeExportMeta(sessionId), settled: true };
    expect(automatedTranscriptReason(legacyMeta)).toBeNull();
    writeFileSync(path, renderTranscript(legacyMeta));

    const registryPath = join(quarantineDir, 'automated-session-tombstones.json');
    writeFileSync(registryPath, `${JSON.stringify({
      schema: 'gbrain-automated-session-tombstones/v1',
      profile: 'claude-code',
      session_ids: ['different-session'],
    }, null, 2)}\n`);
    expect(readSingleTranscript(path, { minChars: 100 })).not.toBeNull();

    writeFileSync(registryPath, `${JSON.stringify({
      schema: 'gbrain-automated-session-tombstones/v1',
      profile: 'claude-code',
      session_ids: [sessionId],
    }, null, 2)}\n`);
    expect(readSingleTranscript(path, { minChars: 100 })).toBeNull();
    expect(readSingleTranscript(path, { minChars: 100, bypassGuard: true })).toBeNull();

    writeFileSync(registryPath, '{"schema":"gbrain-automated-session-tombstones/v1","session_ids":');
    expect(readSingleTranscript(path, { minChars: 100 })).toBeNull();
  });

  test('scheduled discovery rejects a nested stale file with no manifest when its session is tombstoned', () => {
    const intakeDir = tempDir('gbrain-dream-scheduled-tombstone-');
    const sessionsDir = join(intakeDir, 'sessions');
    const sessionId = 'stale-tombstoned-session';
    const exportDir = join(sessionsDir, 'claude-code', '2026', '07');
    mkdirSync(exportDir, { recursive: true });
    const path = join(exportDir, '2026-07-15-stale.md');
    writeFileSync(path, renderTranscript({
      provenance_kind: 'human-session',
      session_id: sessionId,
    }));

    expect(discoverTranscripts({ corpusDir: sessionsDir, minChars: 100 })).toHaveLength(1);
    const registryDir = join(intakeDir, 'quarantine', 'automated-claude');
    mkdirSync(registryDir, { recursive: true });
    const registryPath = join(registryDir, 'automated-session-tombstones.json');
    writeFileSync(registryPath, `${JSON.stringify({
      schema: 'gbrain-automated-session-tombstones/v1',
      session_ids: [sessionId],
    }, null, 2)}\n`);
    expect(discoverTranscripts({ corpusDir: sessionsDir, minChars: 100 })).toEqual([]);
    expect(readSingleTranscript(path, {
      minChars: 100,
      provenanceRoot: sessionsDir,
    })).toBeNull();

    writeFileSync(registryPath, '{"schema":"gbrain-automated-session-tombstones/v1","session_ids":');
    expect(discoverTranscripts({ corpusDir: sessionsDir, minChars: 100 })).toEqual([]);
    expect(readSingleTranscript(path, {
      minChars: 100,
      provenanceRoot: sessionsDir,
    })).toBeNull();

    rmSync(registryPath);
    mkdirSync(registryPath);
    expect(discoverTranscripts({ corpusDir: sessionsDir, minChars: 100 })).toEqual([]);
    expect(readSingleTranscript(path, {
      minChars: 100,
      provenanceRoot: sessionsDir,
    })).toBeNull();
  });

  test('scheduled discovery fails closed with a diagnostic on a malformed owning manifest row', () => {
    const sessionsDir = tempDir('gbrain-dream-scheduled-malformed-manifest-');
    const exportDir = join(sessionsDir, 'claude-code', '2026', '07');
    mkdirSync(exportDir, { recursive: true });
    const path = join(exportDir, '2026-07-15-benign.md');
    writeFileSync(path, renderTranscript({ provenance_kind: 'human-session' }));

    const rawDir = join(sessionsDir, '.claude', 'projects', '-Users-jarvis--gbrain');
    mkdirSync(rawDir, { recursive: true });
    const sourcePath = join(rawDir, 'hidden-automation.jsonl');
    writeFileSync(sourcePath, `${JSON.stringify({
      entrypoint: 'sdk-cli',
      promptSource: 'sdk',
      permissionMode: 'auto',
      cwd: '/Users/jarvis/.gbrain',
    })}\n`);
    writeFileSync(
      join(sessionsDir, '.manifest.jsonl'),
      `{"output_path":${JSON.stringify(path)},"source_path":${JSON.stringify(sourcePath)},"session_id":"hidden-automation"`,
    );

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stderr = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(discoverTranscripts({ corpusDir: sessionsDir, minChars: 100 })).toEqual([]);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    expect(stderr).toContain('provenance guard (invalid_export_manifest)');
  });

  test('legacy manifest source_path recovers omitted Claude SDK automation metadata', () => {
    const dir = tempDir('gbrain-dream-source-provenance-');
    const path = join(dir, '2026-07-15-session.md');
    writeFileSync(path, renderTranscript(exporterMeta()));
    const rawDir = join(dir, '.claude', 'projects', '-Users-jarvis--gbrain');
    mkdirSync(rawDir, { recursive: true });
    const sourcePath = join(rawDir, 'session-stable-1.jsonl');
    writeFileSync(sourcePath, `${JSON.stringify({ type: 'attachment', cwd: '/Users/jarvis/.gbrain' })}\n${JSON.stringify({
      entrypoint: 'sdk-cli',
      promptSource: 'sdk',
      permissionMode: 'auto',
      cwd: '/Users/jarvis/.gbrain',
    })}\n`);
    writeFileSync(join(dir, '.manifest.jsonl'), `${JSON.stringify({
      output_path: path,
      source_path: sourcePath,
      session_id: 'session-stable-1',
    })}\n`);
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 })).toEqual([]);
  });
});
