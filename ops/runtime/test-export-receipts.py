#!/usr/bin/env python3
"""Regression tests for exporter-owned active-tree receipt coverage."""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parent


def load_script(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / name)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RECEIPT = load_script("export-receipt.py")
VERIFIER = load_script("verify-export-receipts.py")
CLAUDE_EXPORTER = load_script("export-claude-session-corpus.py")
NIGHT = dt.date(2026, 7, 15)
OWNER = "gbrain:claude-session-export"


def transcript(owner: str | None) -> str:
    owner_line = (
        f"exporter_owner: {json.dumps(owner)}\nlogical_identity_version: 1\n"
        if owner else ""
    )
    return f"---\n{owner_line}settled: true\n---\n# evidence\n"


class ActiveTreeTests(unittest.TestCase):
    def test_preserved_unowned_evidence_does_not_block_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            corpus = Path(raw)
            root = corpus / "claude-code"
            root.mkdir()
            covered = root / "2026-07-15__covered.md"
            covered.write_text(transcript(None), encoding="utf-8")
            orphan = root / "2026-07-01__preserved-evidence.md"
            orphan.write_text(transcript(None), encoding="utf-8")
            expected = {covered.resolve()}

            self.assertEqual(
                RECEIPT.active_tree("claude", corpus, NIGHT, ("claude-code",), expected),
                expected,
            )
            self.assertEqual(
                VERIFIER.active_tree("claude", corpus, NIGHT, expected),
                expected,
            )

    def test_current_exporter_owned_orphan_still_fails_tree_equality(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            corpus = Path(raw)
            root = corpus / "claude-code"
            root.mkdir()
            covered = root / "2026-07-15__covered.md"
            covered.write_text(transcript(None), encoding="utf-8")
            owned_orphan = root / "2026-07-01__owned-orphan.md"
            owned_orphan.write_text(transcript(OWNER), encoding="utf-8")
            expected = {covered.resolve()}
            active = RECEIPT.active_tree(
                "claude", corpus, NIGHT, ("claude-code",), expected
            )
            self.assertEqual(active, {covered.resolve(), owned_orphan.resolve()})

    def test_legacy_owned_evidence_without_identity_v1_is_not_live_tree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            corpus = Path(raw)
            root = corpus / "claude-code"
            root.mkdir()
            legacy = root / "2026-07-01__legacy.md"
            legacy.write_text(
                '---\nexporter_owner: "gbrain:claude-session-export"\nsettled: true\n---\n',
                encoding="utf-8",
            )
            self.assertEqual(
                RECEIPT.active_tree("claude", corpus, NIGHT, ("claude-code",), set()),
                set(),
            )

    def test_missing_manifest_covered_output_remains_visible_to_later_gate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            corpus = Path(raw)
            (corpus / "claude-code").mkdir()
            missing = (corpus / "claude-code" / "2026-07-15__missing.md").resolve()
            self.assertEqual(
                RECEIPT.active_tree(
                    "claude", corpus, NIGHT, ("claude-code",), {missing}
                ),
                {missing},
            )

    def test_remaining_legacy_rows_are_diagnostic_not_export_fatal(self) -> None:
        self.assertEqual(
            CLAUDE_EXPORTER.scheduled_export_status({
                "remaining_legacy_manifest_rows": 99,
                "settled_drift": 0,
                "existing_output_drift": 0,
                "legacy_migration_failed": 0,
                "stale_partial_replacement_failed": 0,
            }),
            "success",
        )
    def test_settled_drift_is_diagnostic_not_export_fatal(self) -> None:
        # A settled logical session whose source bytes changed later (resumed
        # conversation) is the same mining lineage and is excluded from export;
        # it must not withhold the night's success receipt.
        self.assertEqual(
            CLAUDE_EXPORTER.scheduled_export_status({"settled_drift": 5}),
            "success",
        )

    def test_output_drift_and_migration_failures_stay_fatal(self) -> None:
        self.assertEqual(
            CLAUDE_EXPORTER.scheduled_export_status({"existing_output_drift": 1}),
            "failed",
        )
        self.assertEqual(
            CLAUDE_EXPORTER.scheduled_export_status({"legacy_migration_failed": 1}),
            "failed",
        )
        self.assertEqual(
            CLAUDE_EXPORTER.scheduled_export_status(
                {"stale_partial_replacement_failed": 1}
            ),
            "failed",
        )


if __name__ == "__main__":
    unittest.main()
