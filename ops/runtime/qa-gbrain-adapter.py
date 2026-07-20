#!/usr/bin/env python3
"""Read-only file projection used by the sealed meeting QA sandbox.

It implements only the gbrain commands consumed by qa-meeting.sh. No database,
socket, credentials, or production path is available to this process.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import yaml


def cleaned_args(argv: list[str]) -> list[str]:
    result: list[str] = []
    skip = False
    for value in argv:
        if skip:
            skip = False
            continue
        if value == "--source":
            skip = True
            continue
        result.append(value)
    return result


def frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---\n"):
        return {}
    marker = text.find("\n---\n", 4)
    if marker < 0:
        return {}
    try:
        parsed = yaml.safe_load(text[4:marker])
    except yaml.YAMLError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def main() -> int:
    brain = Path(os.environ["BRAIN_DIR"]).resolve()
    args = cleaned_args(sys.argv[1:])
    if len(args) < 2:
        print("unsupported QA adapter invocation", file=sys.stderr)
        return 64
    command, slug = args[0], args[1]
    if slug.startswith("/") or ".." in slug.split("/"):
        print("invalid slug", file=sys.stderr)
        return 64
    page = brain / f"{slug}.md"

    if command == "get":
        if not page.exists():
            print("not found", file=sys.stderr)
            return 4
        sys.stdout.write(page.read_text(encoding="utf-8", errors="replace"))
        return 0

    if command == "graph":
        if not page.exists():
            print("not found", file=sys.stderr)
            return 4
        print(json.dumps([{"slug": slug, "links": []}]))
        return 0

    if command == "backlinks":
        if not page.exists():
            print("not found", file=sys.stderr)
            return 4
        raw = frontmatter(page).get("attendees") or []
        attendees = raw if isinstance(raw, list) else [raw]
        edges = []
        for attendee in attendees:
            if not isinstance(attendee, str) or not attendee.startswith("people/"):
                continue
            edges.append(
                {
                    "from_slug": attendee,
                    "to_slug": slug,
                    "link_type": "attended",
                }
            )
        print(json.dumps(edges))
        return 0

    print(f"unsupported QA adapter command: {command}", file=sys.stderr)
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
