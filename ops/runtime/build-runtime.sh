#!/bin/bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
repo_root="$(CDPATH= cd -- "$script_dir/../.." && pwd -P)"
python_bin="${GBRAIN_RUNTIME_PYTHON:-/usr/bin/python3}"
bun_bin="${GBRAIN_RUNTIME_BUN:-$(command -v bun || true)}"

if [[ "$#" -ne 1 ]]; then
  printf 'usage: %s /absolute/path/to/new-sealed-runtime\n' "$0" >&2
  exit 2
fi
destination="$1"
if [[ "$destination" != /* ]]; then
  printf 'destination must be absolute: %s\n' "$destination" >&2
  exit 2
fi
if [[ -e "$destination" ]]; then
  printf 'destination already exists: %s\n' "$destination" >&2
  exit 2
fi

destination_parent="$(dirname -- "$destination")"
mkdir -p "$destination_parent"
destination_parent="$(CDPATH= cd -- "$destination_parent" && pwd -P)"
destination="$destination_parent/$(basename -- "$destination")"
stage="$(mktemp -d "$destination_parent/.gbrain-runtime-build.XXXXXX")"
yaml_build=""
cleanup() {
  if [[ -n "$yaml_build" && -d "$yaml_build" && "$yaml_build" == "$destination_parent"/.gbrain-pyyaml-build.* ]]; then
    rm -rf -- "$yaml_build"
  fi
  if [[ -d "$stage" && "$stage" == "$destination_parent"/.gbrain-runtime-build.* ]]; then
    rm -rf -- "$stage"
  fi
}
trap cleanup EXIT

# Copy committed operator lanes, excluding repository-only builder/tests/docs.
while IFS= read -r source_file; do
  name="$(basename -- "$source_file")"
  mode=0444
  if [[ -x "$source_file" ]]; then mode=0555; fi
  install -m "$mode" "$source_file" "$stage/$name"
done < <(
  find "$script_dir" -maxdepth 1 -type f \( -name '*.sh' -o -name '*.py' \) \
    ! -name 'build-runtime.sh' ! -name 'test-*' -print | sort
)

if [[ -n "${GBRAIN_RUNTIME_GBRAIN_BINARY:-}" ]]; then
  if [[ ! -f "$GBRAIN_RUNTIME_GBRAIN_BINARY" ]]; then
    printf 'GBRAIN_RUNTIME_GBRAIN_BINARY is not a file: %s\n' "$GBRAIN_RUNTIME_GBRAIN_BINARY" >&2
    exit 2
  fi
  install -m 0555 "$GBRAIN_RUNTIME_GBRAIN_BINARY" "$stage/gbrain"
else
  if [[ -z "$bun_bin" ]]; then
    printf 'bun is required unless GBRAIN_RUNTIME_GBRAIN_BINARY is supplied\n' >&2
    exit 2
  fi
  "$bun_bin" build --compile --outfile "$stage/gbrain" "$repo_root/src/cli.ts"
  chmod 0555 "$stage/gbrain"
fi

payloads=(
  "skills/_brain-filing-rules.json"
  "skills/_brain-filing-rules.md"
  "skills/brain-taxonomist/SKILL.md"
  "skills/conventions/post-run-retrieval-gate.md"
  "skills/conventions/quality.md"
  "skills/enrich/SKILL.md"
  "skills/meeting-ingestion/SKILL.md"
  "skills/meeting-ingestion/references/doctrine.md"
  "skills/meeting-ingestion/scripts/qa-meeting.sh"
)
for relative_path in "${payloads[@]}"; do
  mkdir -p "$stage/$(dirname -- "$relative_path")"
  install -m 0444 "$repo_root/$relative_path" "$stage/$relative_path"
done

# Guard: every PINNED_*_SHA256 in meeting-complete.py must match the repo payload
# it pins, or the sealed runtime fails closed on every meeting-complete run
# (assert_runtime_helpers raises before any work). A skill edit without its pin
# bump must fail HERE, at build time, not at 05:00 in the lane.
verify_pin() {
  local const_name="$1" rel_path="$2"
  local pinned actual
  pinned="$(sed -n "s/^${const_name} = \"\([0-9a-f]\{64\}\)\"$/\1/p" "$repo_root/ops/runtime/meeting-complete.py")"
  actual="$(shasum -a 256 "$repo_root/$rel_path" | awk '{print $1}')"
  if [[ -z "$pinned" ]]; then
    echo "PIN GUARD FAIL: ${const_name} not found in meeting-complete.py" >&2; exit 1
  fi
  if [[ "$pinned" != "$actual" ]]; then
    echo "PIN GUARD FAIL: ${const_name} pins ${pinned} but $rel_path hashes to ${actual}." >&2
    echo "Update the pin in ops/runtime/meeting-complete.py in the same commit as the payload edit." >&2
    exit 1
  fi
}
verify_pin PINNED_RESOLVER_SHA256 "ops/runtime/brain_type_resolver.py"
verify_pin PINNED_SKILL_SHA256 "skills/meeting-ingestion/SKILL.md"
verify_pin PINNED_QA_SHA256 "skills/meeting-ingestion/scripts/qa-meeting.sh"
verify_pin PINNED_QA_ADAPTER_SHA256 "ops/runtime/qa-gbrain-adapter.py"
verify_pin PINNED_DOCTRINE_SHA256 "skills/meeting-ingestion/references/doctrine.md"
verify_pin PINNED_TAXONOMIST_SHA256 "skills/brain-taxonomist/SKILL.md"
verify_pin PINNED_FILING_RULES_SHA256 "skills/_brain-filing-rules.md"
verify_pin PINNED_FILING_RULES_JSON_SHA256 "skills/_brain-filing-rules.json"
verify_pin PINNED_QUALITY_SHA256 "skills/conventions/quality.md"
verify_pin PINNED_RETRIEVAL_GATE_SHA256 "skills/conventions/post-run-retrieval-gate.md"

# Rebuild the pinned PyYAML payload instead of checking vendor/ into git.
yaml_build="$(mktemp -d "$destination_parent/.gbrain-pyyaml-build.XXXXXX")"
"$python_bin" -m pip install \
  --isolated --disable-pip-version-check --no-deps --no-compile --only-binary=:all: \
  --target "$yaml_build" "PyYAML==6.0.3"
mkdir -p "$stage/vendor/yaml"
find "$yaml_build/yaml" -maxdepth 1 -type f -name '*.py' -exec install -m 0444 {} "$stage/vendor/yaml/" \;
rm -rf -- "$yaml_build"
yaml_build=""

GBRAIN_RUNTIME_STAGE="$stage" "$python_bin" - <<'PY'
import hashlib
import os
from pathlib import Path

root = Path(os.environ["GBRAIN_RUNTIME_STAGE"]) / "vendor" / "yaml"
digest = hashlib.sha256()
for path in sorted(root.rglob("*")):
    if "__pycache__" in path.parts or path.suffix == ".pyc":
        continue
    if path.is_symlink():
        raise SystemExit(f"symlink is not permitted in vendor tree: {path}")
    if not path.is_file():
        continue
    relative = path.relative_to(root.parent).as_posix().encode("utf-8")
    payload = path.read_bytes()
    digest.update(len(relative).to_bytes(4, "big"))
    digest.update(relative)
    digest.update(len(payload).to_bytes(8, "big"))
    digest.update(payload)
actual = digest.hexdigest()
expected = "b63ed19b09b0a04efc9cabddfce3d4d6c21fb9b517eb6a884a54a097b2061de4"
if actual != expected:
    raise SystemExit(f"PyYAML tree hash mismatch: expected={expected} actual={actual}")
PY

git_head="$(git -C "$repo_root" rev-parse HEAD)"
source_date_epoch="${SOURCE_DATE_EPOCH:-$(git -C "$repo_root" show -s --format=%ct HEAD)}"
GBRAIN_RUNTIME_STAGE="$stage" \
GBRAIN_RUNTIME_GIT_HEAD="$git_head" \
GBRAIN_RUNTIME_SOURCE_EPOCH="$source_date_epoch" \
"$python_bin" - <<'PY'
import datetime as dt
import hashlib
import json
import os
import stat
from pathlib import Path

root = Path(os.environ["GBRAIN_RUNTIME_STAGE"])
epoch = int(os.environ["GBRAIN_RUNTIME_SOURCE_EPOCH"])
files = []
for path in sorted(value for value in root.rglob("*") if value.is_file()):
    if path.is_symlink():
        raise SystemExit(f"symlink is not permitted in runtime: {path}")
    relative = path.relative_to(root).as_posix()
    if relative == "gbrain":
        source = "BUILD:gbrain"
    elif relative.startswith("vendor/yaml/"):
        source = "PyYAML==6.0.3"
    elif relative.startswith("skills/"):
        source = f"repo:{relative}"
    else:
        source = f"repo:ops/runtime/{relative}"
    files.append({
        "path": relative,
        "bytes": path.stat().st_size,
        "mode": f"{stat.S_IMODE(path.stat().st_mode):04o}",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "source": source,
    })
manifest = {
    "schema": "gbrain-sealed-runtime-manifest/v1",
    "generated_at": dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat(),
    "git_head": os.environ["GBRAIN_RUNTIME_GIT_HEAD"],
    "file_count": len(files),
    "symlink_count": 0,
    "writable_payload_files": [],
    "files": files,
}
(root / "MANIFEST.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
rows = []
for path in sorted(value for value in root.rglob("*") if value.is_file()):
    relative = path.relative_to(root).as_posix()
    if relative != "SHA256SUMS":
        rows.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {relative}")
(root / "SHA256SUMS").write_text("\n".join(rows) + "\n", encoding="utf-8")
PY

find "$stage" -type f -exec chmod a-w {} +
find "$stage" -type d -exec chmod 0555 {} +
mv "$stage" "$destination"
trap - EXIT
printf '%s\n' "$destination"
