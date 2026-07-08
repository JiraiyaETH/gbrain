#!/usr/bin/env bash
# E2E smoke: verify a completed design-heist run produced the four contract artifacts.
# Reference run: dither-punk (scrib3.co, 2026-07-08).
set -e
BOOK="${1:-$HOME/Projects/design-library/books/dither-punk}"
LIB="$(dirname "$(dirname "$BOOK")")"
test -f "$BOOK/SITE-BREAKDOWN.md" && echo "ok breakdown"
test -f "$BOOK/DESIGN.md" && echo "ok book"
ls "$BOOK"/lab/*.html >/dev/null && echo "ok lab"
ls "$BOOK"/specimen/*.html >/dev/null && echo "ok specimen"
grep -q "$(basename "$BOOK")" "$LIB/gallery/index.html" && echo "ok gallery"
grep -q "$(basename "$BOOK")" "$LIB/REVIEW-LOG.md" && echo "ok review-log"
echo PASS
