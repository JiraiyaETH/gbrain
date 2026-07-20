# Operator runtime lanes

This directory is the version-controlled source for the operator machine's
launchd wrapper lanes. The root `*.sh` and `*.py` files were imported from the
sealed incident-recovery runtime named in `MANIFEST.json`; unchanged files
retain that runtime's bytes. Runtime fixes are made here and deployed only by
the external orchestrator.

`MANIFEST.json` is the original sealed runtime inventory and provenance record.
The committed tree intentionally does **not** contain its compiled `gbrain`
binary, `vendor/`, `skills/`, or `meeting-ingestion/` payload directories.

## Build a sealed runtime

Run:

```sh
ops/runtime/build-runtime.sh /absolute/path/to/new-runtime
```

The destination must not exist. The builder:

1. copies the committed lane scripts while preserving executable intent;
2. compiles the current `src/cli.ts` into `gbrain` (or copies the binary named
   by `GBRAIN_RUNTIME_GBRAIN_BINARY`);
3. copies the current filing, taxonomy, enrichment, and meeting-ingestion
   payloads from the repository;
4. rebuilds the pinned pure-Python `PyYAML==6.0.3` vendor tree and verifies its
   sealed tree hash;
5. writes a deterministic `MANIFEST.json` and `SHA256SUMS`, then makes the
   assembled tree read-only.

Set `SOURCE_DATE_EPOCH` to reproduce the manifest timestamp explicitly. With
it unset, the current commit timestamp is used. The builder never changes
launchd configuration or the active runtime.

## Export receipt self-checks

The exporter wrappers support non-mutating checks:

```sh
ops/runtime/claude-session-export-run.sh --verify
ops/runtime/session-export-run.sh --verify
```

Each prints the exact success-receipt path and a PASS/FAIL line for every gate
reached. The receipt helper also supports `--verify` directly when a specific
summary needs diagnosis. Hermes checks its Claude prerequisite first because
the scheduled lane exits before export when that receipt is absent or invalid.
