---
name: brain-taxonomist
version: 1.0.0
prompt_version: 1
description: |
  Filing gate for ALL brain writes. Consulted before creating any new
  brain page to determine the correct path. Reads the ACTIVE schema pack
  via `gbrain schema show --json` — no hardcoded directory table. Also
  runs periodic taxonomy drift detection via `gbrain schema review-orphans`.
triggers:
  - "where does this brain page go"
  - "file this in the brain"
  - "brain taxonomist"
  - "taxonomy check"
  - "refile brain page"
  - "create brain page"
  - "which directory does this go"
  - "which directory does this page go"
mutating: false
---

# brain-taxonomist

## Purpose

**Gate function:** Before creating ANY new brain page, consult this skill to determine the correct filing path. This prevents misfiling at write time rather than cleaning up drift after the fact.

**Drift function:** Periodic scan for pages that have outgrown their current location.

## Contract

This skill guarantees:
- Every new page is filed at the path determined by the ACTIVE schema pack — never against a hardcoded directory table baked into this skill.
- The decision is reproducible: invoking brain-taxonomist twice on the same content produces the same recommended path.
- Ambiguous cases surface to the user via `skills/ask-user/` rather than silently picking a default.
- Per-source overrides via `--source <id>` are honored — multi-brain users (Persona B) get a different recommendation per source if their packs diverge.
- When no matching `page_types[]` entry exists in the active pack, the skill signals to EIIRP Phase 3 (SCHEMA CHECK) rather than picking the closest-fitting fallback.

## Critical: this skill reads the ACTIVE schema pack as data

`brain-taxonomist` has NO hardcoded directory table. Every decision is
driven by `gbrain schema show --json`. This means:
- A user who runs `gbrain schema use gbrain-recommended` gets the full
  recommended directory set (deal, meeting, concept, project, source,
  daily, personal, civic, original, place, trip, conversation, writing,
  plus all gbrain-base types).
- A user who authored a custom pack via `gbrain schema init` + edit gets
  filing recommendations based on THEIR taxonomy, not gbrain's defaults.
- Per-source overrides (tier 3 in the 7-tier resolution chain) are honored
  when `--source <id>` is passed to brain-taxonomist.

This is the single-source-of-truth principle (D9 from the v0.39 plan-eng-review).

## When to Consult (MANDATORY)

Run the taxonomist check before writing to the brain in these cases:

1. **New brain page** — any `type` (person, company, concept, book, meeting, etc.)
2. **Bulk import** — before committing a batch of new pages
3. **Uncertain filing** — when the primary subject is ambiguous

You do NOT need to consult for:
- Updating an existing page in place (same path)
- Appending to a Timeline section
- Meeting entity propagation to existing pages

## Decision Protocol

### Step 1: Identify primary subject type

Walk these questions in order:
1. Is the primary subject a NAMED PERSON? → person-typed directory
2. Is the primary subject a NAMED ORGANIZATION? → company-typed directory
3. Is it about a TIME-BOUNDED EVENT (meeting, deal, trip)? → temporal-typed directory
4. Is it a REUSABLE MENTAL MODEL? → concept-typed directory
5. Is it RAW MEDIA (article, video, book, PDF)? → media-typed directory
6. Is it BULK SOURCE DATA? → source-typed directory
7. None of the above → consult EIIRP Phase 3 for schema-pack candidate creation.

### Personal planning packages: hub + satellites, not monolith

See `references/personal-planning-hub-pattern.md` for the session-derived wedding-prep example and edge verification pattern.

When the user wants to track a real personal outcome with multiple moving parts — e.g. wedding prep, relocation, travel/admin prep, estate/family admin — treat it like an outcome/workstream if the active pack has `project`:

- Create a small `projects/{slug}.md` hub only when there is an actual outcome, status, next actions, blockers, dates, and links.
- Put substantial detail in linked `notes/{slug}-*.md` satellites by subject: documents, itinerary, guests, dress code, vendor questions, etc.
- Use `sources/` only for raw-ish imports that feed multiple pages, such as copied vendor policies, quote dumps, booking confirmations, or exported guest/contact data. Do not put analysis/checklists there.
- Keep sensitive originals outside the Brain: passports, IDs, visas, certificates, signatures, payment data, full guest PII. Brain pages may track collection/status and secure-location pointers, not the raw files.
- Do not invent a new shelf such as `trips/` or `personal/wedding/` unless the active schema pack already defines it or the user approves a schema change.
- After creating a hub + satellites, verify directed markdown edges with `gbrain backlinks <slug>` and `gbrain graph <slug> --depth 1`; if expected wiki-link edges are missing, run a scoped/recent extract before reporting the graph shape.

### Step 2: Look up the directory for that type in the active pack

```bash
gbrain schema show --json | jq '.page_types[] | select(.primitive == "entity")'
```

Each `page_types[]` entry has a `path_prefixes:` array. The first prefix
is the canonical path. If multiple types match (e.g. both `person` and
`founder` exist in the pack with `expert_routing: true`), prefer the more
specific one (the one with the more specific path prefix).

### Step 3: For books — determine sub-category

The `gbrain-recommended` pack treats books as `media/books/<category>/<slug>.md`
where category is one of: psychology, philosophy, spirituality, business,
media-and-society, family-and-divorce, heritage, science, fiction,
biography, arts-and-design. If your active pack has a different scheme,
walk it from `gbrain schema show --json` instead of hardcoding here.

### Step 4: Construct the slug

- kebab-case, descriptive
- no author name unless disambiguation is needed
- match the canonical path prefix exactly (no leading slash)

### Step 5: Validate before writing

- [ ] Path follows the active pack's `page_types[].path_prefixes`
- [ ] Slug is kebab-case, descriptive
- [ ] Frontmatter includes `type:` matching one of the pack's `page_types[].name`
- [ ] Cross-links to related pages are included

For user-facing planning structures, also inspect local exemplars in the target
shelves before writing. The active schema tells you the valid shelves/types;
existing pages show the user's live frontmatter conventions. Prefer native
GBrain write paths (`put_page` / `gbrain capture --file ... --slug ... --type
... --source ...`) and verify with `gbrain frontmatter validate` plus search/readback.

**Life-event planning pattern:** for weddings, moves, major trips, and similar
personal initiatives with multiple workstreams, use a project hub plus note
satellites rather than one monolithic file. Keep sensitive originals and full
private data outside Brain; store only distilled status, decisions, checklists,
and pointers. See `references/life-event-planning-hub-satellites.md`.

**Simplification pass before write:** when the user pushes back on file/link sprawl,
merge satellites aggressively before writing. Remove generic prep pages when the
project hub already tracks links and outstanding sequence; merge ceremony/timeline/photo/roles,
guest/logistics/comms/RSVP, and budget/vendors/sourcing when their update rhythm is shared.
See `references/wedding-planning-simplified-hub.md` for the wedding cleanup pattern.

**Vendor/package form pattern:**
`references/life-event-planning-simplification-and-source-model.md`.

**Vendor/package form pattern:** when a life-event has a venue/vendor package
and a long form, create one distilled `notes/<event>-<vendor>-package-and-form`
satellite for package baseline, selected form facts, open decisions, add-on
costs, and external sourcing candidates. Do not explode cake/flowers/music/favor
form sections into separate notes unless they become independently complex. See
`references/venue-package-form-distillation.md`.

**Private evidence/media tracker pattern:** when a life-event has a private
photo/video/evidence pool, keep raw media outside Brain under `/Users/jarvis/data/...`
and file the working inventory/curation tracker as a `notes/` satellite, not
`sources/`, unless the page is actually a raw-ish source artifact/import. See
`references/life-event-evidence-media-tracker-routing.md`.

If the active pack doesn't have a type for what you're trying to file,
DON'T pick the closest-fitting one. Instead, signal to EIIRP that a new
type is needed and let the schema-pack cathedral handle the proposal flow.

## Integration with Other Skills

- `eiirp` — calls this skill as Phase 2 TAXONOMY for every output in its inventory.
- `ingest` — article/media ingestion consults brain-taxonomist for filing.
- `repo-architecture` — delegates the filing decision to this skill.
- `book-mirror` — after generating a mirror, files it via brain-taxonomist.

## Periodic Drift Detection

```bash
# What pages have no type matching the active pack?
gbrain schema review-orphans --json

# What's the overall health?
gbrain doctor --json | jq '.checks[] | select(.name == "schema_pack_consistency")'
```

When `schema_pack_consistency` warns at >10% untyped, run the EIIRP
Phase 3 SCHEMA CHECK flow to surface candidate types via `schema detect`.

## Schema Pack Mismatch Debugging

When the expected schema pack differs from what `gbrain schema active` reports,
investigate read-only before mutating config. The runtime activation layer may
be stale even when the repo docs and pack files are correct.

Checklist:
1. Run `gbrain schema active` and record the reported source tier.
2. Run `gbrain schema list` and verify the expected pack is installed.
3. Run `gbrain schema validate <expected-pack>` and
   `gbrain schema show <expected-pack> --json`.
4. Check configured `schema_pack` and any `GBRAIN_SCHEMA_PACK` environment
   override.
5. Compare repo docs such as `brain/schema.md`, but treat runtime config as the
   activation layer to align.
6. Test the expected pack without mutation:
   `GBRAIN_SCHEMA_PACK=<expected-pack> gbrain schema active`.
7. Test type resolution under normal env and under
   `GBRAIN_SCHEMA_PACK=<expected-pack>` for representative kinds/slugs.

If the expected pack is installed and valid, and the env override works, but
normal resolution reports a different configured pack, report that finding and
ask before running `gbrain schema use` or changing config.

Before applying a fix, dry-run activation with an isolated HOME so the user's
real config is untouched:

```bash
TMP=$(mktemp -d /tmp/gbrain-schema-dryrun.XXXXXX)
mkdir -p "$TMP/.gbrain/schema-packs"
cp "$HOME/.gbrain/config.json" "$TMP/.gbrain/config.json"
cp -R "$HOME/.gbrain/schema-packs/<expected-pack>" "$TMP/.gbrain/schema-packs/"
HOME="$TMP" gbrain schema use <expected-pack>
HOME="$TMP" gbrain schema active
```

Smoke both layers:
- Pack layer: `gbrain schema validate <expected-pack>`,
  `GBRAIN_SCHEMA_PACK=<expected-pack> gbrain schema active`, `schema show`, and
  `schema lint`.
- Resolver layer: compare representative type and slug resolution under normal
  env versus `GBRAIN_SCHEMA_PACK=<expected-pack>`.
- Writer layer: run helpers that generate frontmatter in dry-run or pure-render
  mode; pack activation can be correct while writer-specific semantic kinds
  still fall back to `note`.

Pitfall: `gbrain schema use <pack>` only fixes the active pack. It does not make
undeclared semantic aliases resolve. If writers call `resolve_type("custom_kind")`
but the pack only aliases another spelling, path inference may be correct while
generated frontmatter is still wrong.

## Output Format

Advisory: a single recommendation block plus a one-line reasoning trail.

```markdown
**File at:** `<directory>/<slug>.md`
**Reasoning:**
- Primary subject: <person|company|concept|...>
- Matched page_type: <name> (primitive: <entity|temporal|concept|media|annotation>)
- Active pack: <pack-name> v<version>
- Source: <source_id>
```

When ambiguous, surface 2 candidates via `skills/ask-user/` rather than
silently choosing.

When the active pack has NO matching type, signal to EIIRP Phase 3
(SCHEMA CHECK) and emit:

```markdown
**No match in active pack `<name>`.**
**Suggested next step:** `gbrain schema detect --source <source_id>` then
`gbrain schema review-candidates`.
```

## Anti-Patterns

- **Hardcoded directory table in this skill.** Every decision goes through
  `gbrain schema show --json`. v0.39+ broke the old hardcoded table on
  purpose so users on `gbrain-recommended` or custom packs get the right
  routing automatically.
- **Picking the closest-fitting type when no type matches.** Closest-fit
  silently degrades user filing. Surface to EIIRP Phase 3 instead.
- **Ignoring `--source <id>` on multi-brain setups.** Per-source overrides
  are tier-3 in the 7-tier resolution chain; missing the flag silently
  uses the brain-wide active pack.
- **Auto-applying a `gbrain schema review-candidates --apply` decision.**
  Even high-confidence suggestions need user approval — this skill is a
  GATE, not an automator.

## Hard Rules

- **Never hardcode a directory table in this skill.** Every decision goes
  through `gbrain schema show --json`. The active pack is canonical.
- **Per-source flag is first-class.** Pass `--source <id>` to every CLI
  call when working with a non-default source.
- **Confidence-floor honor.** EIIRP's Phase 3 produces suggestions with
  confidence < 0.6 that brain-taxonomist must surface to the user rather
  than auto-apply. Don't silently promote a low-confidence schema delta.

## Changelog

### v1.0.0 — gbrain v0.39.0.0
- Initial port from upstream OpenClaw. Genericized — no references to
  private fork names per CLAUDE.md privacy rules.
- Hardcoded directory table REMOVED. Every decision now reads the active
  schema pack via `gbrain schema show --json`. Single source of truth.
- Book taxonomy moved from skill-text to the `gbrain-recommended` pack's
  media/books/ branch (see `src/core/schema-pack/base/gbrain-recommended.yaml`).
- `--source <id>` propagation documented for multi-brain users (Persona B).
