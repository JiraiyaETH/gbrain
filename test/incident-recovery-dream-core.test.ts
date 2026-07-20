import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  automatedTranscriptReason,
  deriveTranscriptLogicalIdentity,
  discoverTranscripts,
  readSingleTranscript,
} from '../src/core/cycle/transcript-discovery.ts';
import {
  allSynthesizeChildrenCompleted,
  classifySynthesizeChildOutcome,
  closeDreamBacklog,
  countSynthesizeChildOutcomes,
  runPhaseSynthesize,
  synthesizeCompletionKey,
  synthesizeIdempotencyKey,
  synthesizeLogicalCompletionKey,
  synthesizeLogicalIdempotencyKey,
  synthesizeOperatorDiscardKey,
} from '../src/core/cycle/synthesize.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { shouldDreamExitNonZero } from '../src/commands/dream.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const tempDirs: string[] = [];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
});

afterAll(async () => {
  await engine.disconnect();
});

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
  test('scheduled night selection is strict on Bangkok settlement while manual ranges retain history', () => {
    const dir = tempDir('gbrain-dream-exact-night-');
    const olderPath = join(dir, '2026-07-13__claude-code__settled-n-minus-2.md');
    const targetPath = join(dir, '2026-07-13__claude-code__settled-night-n.md');
    writeFileSync(olderPath, renderTranscript(exporterMeta({
      session_id: 'settled-n-minus-2',
      export_date: '2026-07-13',
      settled_at: '2026-07-13T23:30:00+07:00',
    }), 'older settlement'));
    writeFileSync(targetPath, renderTranscript(exporterMeta({
      session_id: 'settled-night-n',
      export_date: '2026-07-13',
      settled_at: '2026-07-15T00:30:00+07:00',
    }), 'target settlement'));

    const scheduled = discoverTranscripts({
      corpusDir: dir,
      minChars: 100,
      nightId: '2026-07-15',
    });
    expect(scheduled.map(item => item.filePath)).toEqual([targetPath]);
    expect(scheduled[0].settledDate).toBe('2026-07-15');

    const manual = discoverTranscripts({ corpusDir: dir, minChars: 100, to: '2026-07-15' });
    expect(manual.map(item => item.filePath)).toEqual([olderPath, targetPath]);
  });

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
    expect(synthesizeLogicalIdempotencyKey(first[0].logicalIdentity!))
      .toBe(`dream:synth:logical:v1:${expectedTranscript}`);
  });

  test('actual exporter numeric manifest parts agree with i/N frontmatter for Claude and Agent fork', () => {
    const dir = tempDir('gbrain-dream-exporter-split-parts-');
    const fixtures = [
      {
        source: 'claude-code', profile: 'claude-code', owner: 'gbrain:claude-session-export',
        sessionId: 'claude-split-session', file: '2026-07-15__claude-code__claude-split-session__part2.md',
      },
      {
        source: 'agent-fork', profile: 'alice-example', owner: 'gbrain:agent-fork-session-export',
        sessionId: 'agent-fork-split-session', file: '2026-07-15__alice-example__agent-fork-split-session__part2.md',
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
    const firstKeys = new Map(first.map(item => [
      item.filePath,
      synthesizeLogicalIdempotencyKey(item.logicalIdentity!),
    ]));

    for (const [index, path] of paths.entries()) {
      const metadata: Record<string, unknown> = { ...manifests[index], part: '2/2' };
      delete metadata.output_path;
      writeFileSync(path, renderTranscript(metadata, `${fixtures[index].profile}-changed-bytes`));
    }
    const changed = discoverTranscripts({ corpusDir: dir, minChars: 100 });
    expect(changed).toHaveLength(2);
    expect(new Map(changed.map(item => [
      item.filePath,
      synthesizeLogicalIdempotencyKey(item.logicalIdentity!),
    ]))).toEqual(firstKeys);
    expect(new Set(changed.map(item => item.logicalIdentity!.logicalTranscriptId)).size).toBe(2);

    manifests[0].part = 1;
    writeFileSync(join(dir, '.manifest.jsonl'), manifests.map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(discoverTranscripts({ corpusDir: dir, minChars: 100 }).map(item => item.filePath))
      .toEqual([paths[1]]);
  });

  test('parts share a logical session but remain distinct; source namespaces remain distinct', () => {
    const part1 = deriveTranscriptLogicalIdentity(exporterMeta({ part_index: 1, part_total: 2, part: '1/2' }));
    const part2 = deriveTranscriptLogicalIdentity(exporterMeta({ part_index: 2, part_total: 2, part: '2/2' }));
    const agentFork = deriveTranscriptLogicalIdentity(exporterMeta({
      source_namespace: 'agent-fork',
      source: 'agent-fork',
      profile: 'claude-code',
    }));
    expect(part1?.logicalSessionId).toBe(part2?.logicalSessionId);
    expect(part1?.logicalTranscriptId).not.toBe(part2?.logicalTranscriptId);
    expect(part1?.logicalSessionId).not.toBe(agentFork?.logicalSessionId);
    expect(part1?.logicalTranscriptId).not.toBe(agentFork?.logicalTranscriptId);
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
      ...exporterMeta({ source_namespace: 'agent-fork', source: 'agent-fork' }),
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

describe('corrective Dream scheduled spend cap + backlog closeout', () => {
  test('zero config defaults to 10 paid children; the 11th keeps no completion or cooldown', async () => {
    const corpusDir = tempDir('gbrain-dream-paid-cap-corpus-');
    const brainDir = tempDir('gbrain-dream-paid-cap-brain-');
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
    await engine.setConfig('dream.synthesize.max_paid_children_per_run', '0');

    for (let index = 1; index <= 11; index++) {
      const id = `paid-cap-${String(index).padStart(2, '0')}`;
      const path = join(corpusDir, `2026-07-13__claude-code__${id}.md`);
      writeFileSync(path, renderTranscript(exporterMeta({
        session_id: id,
        export_date: '2026-07-13',
        settled_at: '2026-07-15T01:00:00+07:00',
      }), id));
    }
    const transcripts = discoverTranscripts({
      corpusDir,
      minChars: 100,
      nightId: '2026-07-15',
    });
    expect(transcripts).toHaveLength(11);
    for (const transcript of transcripts) {
      await engine.putDreamVerdict(transcript.filePath, transcript.contentHash, {
        worth_processing: true,
        reasons: ['fixture worth processing'],
      });
    }

    const result = await runPhaseSynthesize(engine, {
      brainDir,
      dryRun: false,
      sourceId: 'default',
      nightId: '2026-07-15',
      waitForChildForTestOnly: async (queue, jobId) => {
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status='completed', result=$2::text::jsonb, finished_at=now()
            WHERE id=$1`,
          [jobId, JSON.stringify({ result: 'fixture complete', stop_reason: 'end_turn' })],
        );
        return (await queue.getJob(jobId))!;
      },
    });

    expect(result.status).toBe('warn');
    expect(result.details.capped).toBe(true);
    expect(result.details.paid_children_cap).toBe(10);
    expect(result.details.paid_children_dispatched).toBe(10);
    expect(result.details.paid_children_overflow).toBe(1);
    expect(result.details.children_submitted).toBe(10);
    expect(result.details.cooldown_written).toBe(false);
    expect(await engine.getConfig(synthesizeCompletionKey())).toBeNull();

    const tenthKey = synthesizeLogicalIdempotencyKey(transcripts[9].logicalIdentity!);
    const eleventhKey = synthesizeLogicalIdempotencyKey(transcripts[10].logicalIdentity!);
    const rows = await engine.executeRaw<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM minion_jobs WHERE idempotency_key = $1 OR idempotency_key = $2`,
      [tenthKey, eleventhKey],
    );
    expect(rows.map(row => row.idempotency_key)).toContain(tenthKey);
    expect(rows.map(row => row.idempotency_key)).not.toContain(eleventhKey);
    expect(await engine.getConfig(synthesizeLogicalCompletionKey(transcripts[9].logicalIdentity!)))
      .not.toBeNull();
    expect(await engine.getConfig(synthesizeLogicalCompletionKey(transcripts[10].logicalIdentity!)))
      .toBeNull();
  }, 30_000);

  test('close-backlog dry-run is inert; apply tombstones incomplete and partial fixtures only', async () => {
    const corpusDir = tempDir('gbrain-dream-close-backlog-');
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
    const fixtures = [
      ['old-incomplete', '2026-07-13T01:00:00+07:00'],
      ['old-partial', '2026-07-14T01:00:00+07:00'],
      ['old-complete', '2026-07-14T02:00:00+07:00'],
      ['new-incomplete', '2026-07-16T01:00:00+07:00'],
    ] as const;
    for (const [id, settledAt] of fixtures) {
      writeFileSync(join(corpusDir, `2026-07-13__claude-code__${id}.md`), renderTranscript(exporterMeta({
        session_id: id,
        export_date: '2026-07-13',
        settled_at: settledAt,
      }), id));
    }
    const transcripts = discoverTranscripts({ corpusDir, minChars: 100 });
    const bySession = new Map(transcripts.map(item => [item.logicalIdentity!.sessionId, item]));
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, idempotency_key)
       VALUES ('subagent', 'default', 'failed', $1)`,
      [synthesizeLogicalIdempotencyKey(bySession.get('old-partial')!.logicalIdentity!)],
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, idempotency_key, result, finished_at)
       VALUES ('subagent', 'default', 'completed', $1, $2::text::jsonb, now())`,
      [
        synthesizeLogicalIdempotencyKey(bySession.get('old-complete')!.logicalIdentity!),
        JSON.stringify({ result: 'complete', stop_reason: 'end_turn' }),
      ],
    );
    const evidenceBefore = new Map(transcripts.map(item => [item.filePath, readFileSync(item.filePath, 'utf8')]));

    const preview = await closeDreamBacklog(engine, {
      before: '2026-07-16',
      dryRun: true,
      now: '2026-07-20T00:00:00Z',
    });
    expect(preview.candidates).toBe(2);
    expect(preview.markers_written).toBe(0);
    expect(preview.completed_lineage).toBe(1);
    expect(preview.not_before_cutoff).toBe(1);
    expect(preview.items.map(item => item.logical_transcript_id)).toEqual([
      bySession.get('old-incomplete')!.logicalIdentity!.logicalTranscriptId,
      bySession.get('old-partial')!.logicalIdentity!.logicalTranscriptId,
    ]);
    expect(preview.items.find(item => item.file_path.includes('old-partial'))?.partial_lineage_rows).toBe(1);
    for (const item of preview.items) expect(await engine.getConfig(item.marker_key)).toBeNull();

    const applied = await closeDreamBacklog(engine, {
      before: '2026-07-16',
      dryRun: false,
      now: '2026-07-20T00:00:00Z',
    });
    expect(applied.candidates).toBe(2);
    expect(applied.markers_written).toBe(2);
    for (const item of applied.items) {
      const marker = JSON.parse((await engine.getConfig(item.marker_key))!);
      expect(marker.status).toBe('operator_discarded');
      expect(marker.reason).toBe('operator_discarded_before_cutoff');
    }
    expect(await engine.getConfig(synthesizeOperatorDiscardKey(bySession.get('old-complete')!))).toBeNull();
    expect(await engine.getConfig(synthesizeOperatorDiscardKey(bySession.get('new-incomplete')!))).toBeNull();
    for (const [path, content] of evidenceBefore) expect(readFileSync(path, 'utf8')).toBe(content);

    await engine.putDreamVerdict(
      bySession.get('new-incomplete')!.filePath,
      bySession.get('new-incomplete')!.contentHash,
      { worth_processing: false, reasons: ['fixture not worth processing'] },
    );
    const miningPreview = await runPhaseSynthesize(engine, {
      brainDir: tempDir('gbrain-dream-close-backlog-brain-'),
      dryRun: true,
      sourceId: 'default',
      date: '2026-07-13',
    });
    expect((miningPreview.details.skips as Array<{ reason: string }>).filter(
      item => item.reason === 'operator_discarded',
    )).toHaveLength(2);

    const rerun = await closeDreamBacklog(engine, { before: '2026-07-16', dryRun: false });
    expect(rerun.candidates).toBe(0);
    expect(rerun.already_discarded).toBe(2);
  }, 30_000);
});

describe('corrective Dream terminal outcome + scheduled exit policy', () => {
  test('classifies every required terminal outcome and timeout-shaped failures exactly', () => {
    const completed = classifySynthesizeChildOutcome({ id: 1, status: 'completed', error_text: null });
    const failed = classifySynthesizeChildOutcome({ id: 2, status: 'failed', error_text: 'model error' });
    const dead = classifySynthesizeChildOutcome({ id: 3, status: 'dead', error_text: 'attempts exhausted' });
    const timedOut = classifySynthesizeChildOutcome({ id: 4, status: 'dead', error_text: 'wall-clock timeout exceeded' });
    const cancelled = classifySynthesizeChildOutcome({ id: 5, status: 'cancelled', error_text: null });
    const unknown = classifySynthesizeChildOutcome({ id: 6, status: 'active', error_text: null });
    const outcomes = [completed, failed, dead, timedOut, cancelled, unknown];
    expect(outcomes.map(outcome => outcome.status))
      .toEqual(['completed', 'failed', 'dead', 'timed_out', 'cancelled', 'unknown']);
    expect(countSynthesizeChildOutcomes(outcomes)).toEqual({
      completed: 1,
      failed: 1,
      dead: 1,
      timed_out: 1,
      cancelled: 1,
      unknown: 1,
      total: 6,
    });
    expect(allSynthesizeChildrenCompleted([completed])).toBe(true);
    for (const nonSuccess of [failed, dead, timedOut, cancelled, unknown]) {
      expect(allSynthesizeChildrenCompleted([completed, nonSuccess])).toBe(false);
    }
    expect(allSynthesizeChildrenCompleted([])).toBe(false);
  });

  test('manual partial stays zero while scheduled strict partial and all failed runs are nonzero', () => {
    expect(shouldDreamExitNonZero('partial', undefined)).toBe(false);
    expect(shouldDreamExitNonZero('partial', '0')).toBe(false);
    expect(shouldDreamExitNonZero('partial', '1')).toBe(true);
    expect(shouldDreamExitNonZero('partial', 'true')).toBe(true);
    expect(shouldDreamExitNonZero('failed', undefined)).toBe(true);
    expect(shouldDreamExitNonZero('ok', '1')).toBe(false);
  });
});

describe('corrective Dream stable/legacy completion migration', () => {
  test('changed bytes under stable or legacy-only completion skip before verdict; unchanged legacy also skips', async () => {
    const corpusDir = tempDir('gbrain-dream-completion-corpus-');
    const brainDir = tempDir('gbrain-dream-completion-brain-');
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);

      const stablePath = join(corpusDir, '2026-07-15__claude-code__session-stable-1.md');
      writeFileSync(stablePath, renderTranscript(exporterMeta(), 'original'));
      const discovered = discoverTranscripts({ corpusDir, minChars: 100 });
      const stableIdentity = discovered[0].logicalIdentity!;
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, idempotency_key, result, finished_at)
         VALUES ('subagent', 'default', 'completed', $1, $2::text::jsonb, now())`,
        [
          synthesizeLogicalIdempotencyKey(stableIdentity),
          JSON.stringify({ result: 'completed without page writes', stop_reason: 'end_turn' }),
        ],
      );
      writeFileSync(stablePath, renderTranscript(exporterMeta(), 'changed after completion'));

      const first = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
        sourceId: 'default',
      });
      expect(first.status).toBe('ok');
      expect(first.details.children_submitted).toBe(0);
      expect(first.details.children_resumed).toBe(1);
      expect(await engine.getConfig(synthesizeLogicalCompletionKey(stableIdentity))).not.toBeNull();
      await engine.unsetConfig(synthesizeCompletionKey());

      const migratedPath = join(corpusDir, '2026-07-14__claude-code__session-legacy-migration.md');
      const migratedMeta = exporterMeta({
        session_id: 'session-legacy-migration',
        export_date: '2026-07-14',
      });
      writeFileSync(migratedPath, renderTranscript(migratedMeta, 'legacy bytes before exporter frontmatter drift'));
      const migratedBefore = discoverTranscripts({ corpusDir, minChars: 100 })
        .find(item => item.filePath === migratedPath)!;
      const migratedIdentity = migratedBefore.logicalIdentity!;
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, idempotency_key, finished_at)
         VALUES ('subagent', 'default', 'completed', $1, now())`,
        [synthesizeIdempotencyKey(migratedPath, migratedBefore.contentHash.slice(0, 16))],
      );
      writeFileSync(migratedPath, renderTranscript(migratedMeta, 'changed bytes after legacy-only completion'));

      const migrated = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
        sourceId: 'default',
      });
      expect((migrated.details.skips as Array<{ reason: string }>).map(item => item.reason))
        .toContain('already_synthesized_legacy_job');
      expect(await engine.getConfig(synthesizeLogicalCompletionKey(migratedIdentity))).toBeNull();

      const sourcePrefixedPath = join(corpusDir, '2026-07-13__claude-code__session-source-prefixed.md');
      const sourcePrefixedMeta = exporterMeta({
        session_id: 'session-source-prefixed',
        export_date: '2026-07-13',
      });
      writeFileSync(sourcePrefixedPath, renderTranscript(sourcePrefixedMeta, 'incident-era source-prefixed bytes'));
      const sourcePrefixedBefore = discoverTranscripts({ corpusDir, minChars: 100 })
        .find(item => item.filePath === sourcePrefixedPath)!;
      const sourcePrefixedIdentity = sourcePrefixedBefore.logicalIdentity!;
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, idempotency_key, finished_at)
         VALUES ('subagent', 'default', 'completed', $1, now())`,
        [`dream:synth:default:${sourcePrefixedPath}:${sourcePrefixedBefore.contentHash.slice(0, 16)}`],
      );
      writeFileSync(sourcePrefixedPath, renderTranscript(sourcePrefixedMeta, 'changed bytes after source-prefixed legacy completion'));

      const sourcePrefixed = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
        sourceId: 'robotics',
      });
      expect((sourcePrefixed.details.skips as Array<{ reason: string }>).map(item => item.reason))
        .toContain('already_synthesized_legacy_job');
      expect(await engine.getConfig(synthesizeLogicalCompletionKey(sourcePrefixedIdentity))).toBeNull();

      const legacyPath = join(corpusDir, '2026-07-14-legacy.txt');
      const legacyContent = 'legacy durable conversation. '.repeat(180);
      writeFileSync(legacyPath, legacyContent);
      const legacyHash = createHash('sha256').update(legacyContent, 'utf8').digest('hex');
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, idempotency_key, finished_at)
         VALUES ('subagent', 'default', 'completed', $1, now())`,
        [synthesizeIdempotencyKey(legacyPath, legacyHash.slice(0, 16))],
      );
      const second = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
        sourceId: 'default',
      });
      const reasons = (second.details.skips as Array<{ reason: string }>).map(item => item.reason);
      expect(reasons).toContain('already_synthesized_marker');
      expect(reasons).toContain('already_synthesized_legacy_job');
      const verdictCount = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM dream_verdicts');
      expect(Number(verdictCount[0].count)).toBe(0);
  }, 30_000);
});

describe('corrective MinionQueue settled-once retries', () => {
  test('concurrent completed submissions preserve completion while concurrent failed retries rearm once', async () => {
      const queue = new MinionQueue(engine);
      const completed = await queue.add('sync', { generation: 1 }, { idempotency_key: 'settled-once-completed' });
      const claimed = await queue.claim('settled-token', 30_000, 'default', ['sync']);
      await queue.completeJob(claimed!.id, 'settled-token', { ok: true });

      const completedHits = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        queue.add(
          'sync',
          { generation: index + 2 },
          { idempotency_key: 'settled-once-completed' },
          undefined,
          { rearmCompleted: false },
        )));
      expect(new Set(completedHits.map(job => job.id))).toEqual(new Set([completed.id]));
      expect(completedHits.every(job => job.status === 'completed')).toBe(true);
      expect((await queue.getJob(completed.id))?.status).toBe('completed');

      const retry = await queue.add('sync', { generation: 1 }, { idempotency_key: 'settled-once-retry' });
      await engine.executeRaw(
        `UPDATE minion_jobs SET status = 'failed', finished_at = now(), error_text = 'fixture failure' WHERE id = $1`,
        [retry.id],
      );
      const retried = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        queue.add(
          'sync',
          { generation: index + 2 },
          { idempotency_key: 'settled-once-retry' },
          undefined,
          { rearmCompleted: false },
        )));
      expect(new Set(retried.map(job => job.id))).toEqual(new Set([retry.id]));
      expect(retried.every(job => job.status === 'waiting')).toBe(true);
      const rows = await engine.executeRaw<{ count: string }>(
        `SELECT count(*)::text AS count FROM minion_jobs WHERE idempotency_key = 'settled-once-retry'`,
      );
      expect(Number(rows[0].count)).toBe(1);
  }, 30_000);
});
