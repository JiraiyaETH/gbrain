"""brain_type_resolver — resolve the CANONICAL GBrain page type for a semantic
kind (or legacy/aliased type string) by reading the ACTIVE schema pack at runtime.

Single source of truth = the pack. Writers pass a semantic kind they already
know (e.g. "workout_log", "analysis", "transcript"); this returns the current
canonical type. When the schema changes, outputs re-derive automatically — no
code edits, no drift.

FAIL-SAFE: never raises. If the pack can't be read, returns the caller's
fallback (default "note"), so a cron/writer can never crash on resolution.
"""
from __future__ import annotations
import json, os, subprocess, functools


@functools.lru_cache(maxsize=1)
def _pack() -> dict | None:
    try:
        env = {**os.environ, "GBRAIN_DISABLE_DIRECT_POOL": "1"}
        out = subprocess.run(
            ["gbrain", "schema", "show", "--json"],
            capture_output=True, text=True, timeout=20, env=env,
        )
        if out.returncode != 0:
            return None
        return json.loads(out.stdout)
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def _maps():
    p = _pack()
    if not p:
        return None
    canon: dict[str, str] = {}        # alias OR name -> canonical type name
    prefixes: list[tuple[str, str]] = []  # (path_prefix, canonical type)
    for t in p.get("page_types", []) or []:
        name = t.get("name")
        if not name:
            continue
        canon[name] = name
        for a in (t.get("aliases") or []):
            canon[a] = name
        for pp in (t.get("path_prefixes") or []):
            prefixes.append((pp, name))
    return canon, prefixes


def _variants(k: str):
    yield k
    yield k.replace("-", "_")
    yield k.replace("_", "-")
    yield k.lower()


def resolve_type(kind: str | None, fallback: str = "note") -> str:
    """Canonical pack type for a semantic kind / legacy type string."""
    m = _maps()
    if not m or not kind:
        return fallback
    canon, _ = m
    for v in _variants(kind):
        if v in canon:
            return canon[v]
    return fallback


def infer_type_from_slug(slug: str, fallback: str = "note") -> str:
    """Canonical type implied by a slug's shelf (longest path_prefix wins)."""
    m = _maps()
    if not m or not slug:
        return fallback
    _, prefixes = m
    for pp, name in sorted(prefixes, key=lambda x: -len(x[0])):
        if slug.startswith(pp):
            return name
    return fallback


if __name__ == "__main__":
    pack = _pack()
    print("active pack:", (pack or {}).get("name", "<UNREADABLE>"))
    checks = [
        ("workout_log", "log"), ("food_log", "log"), ("health", "log"),
        ("analysis", "intel"), ("lesson", "concept"), ("decision", "concept"),
        ("capability", "reference"), ("spec", "project"), ("incident", "project"),
        ("transcript", "transcript"), ("report", "report"), ("note", "note"),
        ("book-analysis", "note"),  # non-canonical, non-alias -> fallback
    ]
    print("\nresolve_type(kind) -> canonical (expected):")
    for k, exp in checks:
        got = resolve_type(k)
        print(f"  {k:<14} -> {got:<10} {'OK' if got == exp else f'?? expected {exp}'}")
    print("\ninfer_type_from_slug(slug) -> type:")
    for s in ["workout/jiraiya/logs/2026-04-27", "food/alina/logs/x",
              "reports/daily/x", "concepts/x", "sources/fireflies/x"]:
        print(f"  {s:<34} -> {infer_type_from_slug(s)}")
