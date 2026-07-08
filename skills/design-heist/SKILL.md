---
name: design-heist
version: 1.0.0
description: |
  Point at a website (or app/deck), extract its design language and signature
  components, re-create them until they pass a taste gate, and encode the
  result as a reusable brand book in ~/Projects/design-library. Output is a
  transferable playbook (tokens, motion physics, component recipes), never a
  clone. Works for any agent with shell + a browser tool; taste-gating stays
  with the orchestrating agent, file builds go to a delegate builder.
triggers:
  - "steal this design"
  - "extract the design from <url>"
  - "design-heist <url>"
  - "make a design playbook from this site"
  - "capture this site's design language"
  - "replicate this website's style"
tools:
  - exec
  - read
  - write
mutating: true
---

# design-heist — extract → re-create → playbook

## Contract
Given a reference URL and which elements the operator cares about, this skill
guarantees four artifacts in `~/Projects/design-library/books/<slug>/`:
1. `SITE-BREAKDOWN.md` — teardown: how the reference actually works (architecture,
   theme engine, layout, type, section-by-section, motion choreography, strip-mining
   guide of replayable parts).
2. `DESIGN.md` (DRAFT) — the reusable brand book: tokens, type roles, surfaces,
   signature devices, motion parameters, anti-slop rules, agent checklist.
3. `lab/` + `specimen/` — working re-creations of signature components and one
   full page on an INVENTED brand, each passing the taste gate.
4. Gallery entry (`gallery/index.html`) + `REVIEW-LOG.md` append.

**Cardinal rule: nothing enters the playbook until it has been RE-CREATED and
looks good.** Extraction without re-creation produces plausible-but-wrong rules
(proven failure: a first pass banned rounded corners; the source CSS used 1.667vw
radii on every paper surface).

The book must transfer to OTHER applications (websites, apps, decks): capture
parameters and principles, not markup.

## Intake schema
Invocations resolve to this record (ask only for fields the request leaves blank):
```json
{ "url": "https://…",            // required — the reference
  "slug": "kebab-book-name",     // required — books/<slug>/
  "focus": ["whole"|"typography"|"motion"|"3d"|"color"|"components"…],
  "target_mediums": ["web"],     // what the book must transfer to (web/app/deck)
  "constraints": "free fonts only, no paid assets"  // default
}
```
Outputs are exactly the four Contract artifact paths, reported in the summary.

## Taste-gate rubric
Score each re-creation 1–10 against reference frames; gate at ≥8. Deduct for:
composition (prop cropped / bad air) −2, motion physics missing (overshoot, dip,
conveyor, decode) −2 each, dead idle state −1, off-token color/type −2, easing
defaults where the book specifies tokens −1. Operator score overrides agent score.

## Phases

### 0 — Intake
Confirm: reference URL, which elements matter (often "the whole thing"), book slug.
**If the deliverable is a redesign of a REAL brand:** extract that brand's existing
palette/type from its live site FIRST — the book supplies structure and motion, the
brand supplies color. Inventing a palette for a real brand is a proven 0/10
(Tailored round 4, 2026-07-08: cobalt-on-grey vs the brand's actual
champagne-gold-on-charcoal).
Create `books/<slug>/`. Read the library `README.md` + `PICKER.md` conventions.
Brain-first: `gbrain search "<site/company>"` for prior context; cite what you use.

### 1 — Static extraction (cheap, always first)
Fetch the HTML, all stylesheets, and JS chunks (for Next.js also `_buildManifest.js`;
named page/component chunks like `home-*.js` beat vendor chunks). Grep the corpus for:
fonts (`@font-face`), color frequency + CSS vars, easing tokens (`cubic-bezier`,
gsap `ease:"..."`), border-radius rules (BEFORE writing any corner rule),
duration/stagger params, scrollTrigger configs, and stack markers
(gsap|ScrollTrigger|SplitText|Lenis|three|lottie|framer). If Three.js appears, look
for `CanvasTexture` (runtime label textures) and check the network log for `.glb`
(usually absent — procedural geometry is the genre norm).

### 2 — Live observation (the taste layer)
Static analysis cannot capture choreography. In fidelity order:
1. **Operator screen recording** (ask for it whenever motion matters): slow scroll
   with per-section pauses, hovers, distinct pages. Extract frames (ffmpeg fps 4-8
   around fast transitions, 1 elsewhere), build contact sheets (PIL montage), read
   full-res only the frames that matter. If one motion stays ambiguous, request a
   focused 15s clip of just that interaction — one such clip once decoded four
   physics behaviors an entire pass had missed.
2. **Headed browser** (GStack browse `--headed`, shared state
   `BROWSE_STATE_FILE=~/.gstack/browse.json`): computed-style probes, canvas
   enumeration, border-radius sweep, network asset list, section screenshots.
   WebGL sites REQUIRE headed — headless SwiftShader often cannot create GL
   contexts and some sites hard-crash without GPU.
3. Headless browse: non-WebGL screenshots and CSS probes only.

Watch for: pinned scenes + internal steppers, in-place decode swaps, marquees
(two-layer solid+outline), accent-as-theme-variable across pages, surface contrast
rules (sharp vs rounded), persistent single-canvas WebGL ("orchestra"), conveyor /
texture-offset tricks, physics (overshoot, impact dips), hover reveals, handoffs.

### 3 — Documents
Write `SITE-BREAKDOWN.md` (teardown + strip-mining guide + perf/robustness notes)
and `DESIGN.md` marked DRAFT (contract-not-inspiration; free-font substitutes for
paid faces; few color tokens with accent as a variable).

### 4 — Re-creation loop (THE GATE)
For each signature component + one full specimen page:
1. Orchestrator specs precisely — numbers, not vibes (camera fov/position,
   proportions, font px vs band height, speeds, ease + overshoot params). Builder
   quality is downstream of spec precision.
2. Delegate builder (Codex `codex exec`, or a capable subagent) builds
   self-contained HTML under `books/<slug>/lab/`. Grant it browser access and
   REQUIRE self-QA: screenshot its own output, read the screenshots, iterate.
   Launch discipline for `codex exec` from non-TTY: append `< /dev/null`, log to
   a file, confirm the log grows (~25s) before leaving it; kill zombie runs by
   prompt keyword before relaunching.
3. Orchestrator taste-gates independently in a headed browser: idle,
   mid-animation, and settled screenshots compared side-by-side against reference
   frames. Exercise interactive states (click steppers, hover rows) — statics
   pass things that feel dead.
4. Iterate parameters (usually camera/scale/timing). Operator score <8/10 →
   another round; ask what specifically reads wrong.
5. Only after the gate passes: write verified parameters into `DESIGN.md` as a
   playbook section, WITH a generalization note (how the trick transfers to other
   shapes/media — e.g. a conveyor label band works on any prism via consecutive
   UV slices of one repeating texture).
6. Expose taste knobs as one `CONFIG` object at the top of each lab file
   (shape/angle/speeds/physics) so future agents restyle without re-deriving.
7. Every 3D recipe fails soft: no WebGL → bracket-framed mono fallback. Never
   copy a reference that hard-crashes without GPU.

### 5 — Close out
Update `gallery/index.html` (DRAFT badge until operator blesses), append
`REVIEW-LOG.md`. The book stays DRAFT until the operator reacts to live specimens;
their verdicts get encoded back into the book. Close substantial work with EIIRP.

## Output Format
Four artifacts per the Contract, plus a chat summary: what was extracted, what was
re-created, gate verdicts, and what remains un-recreated (never imply completeness
— list the gaps explicitly).

## Provenance & evidence conventions
Every claim in a book must trace to evidence. Cite in-file:
- Source-CSS facts as `(verified from source CSS: <rule>)` — e.g. the rounded-corner
  correction in dither-punk `DESIGN.md` cites `border-radius:1.6666666667vw`.
- Motion physics as `(observed frame-by-frame, <recording/date>)`.
- Re-creation verdicts land in `REVIEW-LOG.md` with date, builder, fixes, and gate result.
Reference run (worked example for this skill): scrib3.co → dither-punk book,
2026-07-08 — see `~/Projects/design-library/books/dither-punk/{SITE-BREAKDOWN.md,
DESIGN.md}` and `REVIEW-LOG.md` entries of that date; e2e smoke
(`e2e/smoke.sh`) asserts that run's artifacts. Tool claims (SwiftShader/WebGL
limits, codex stdin hang) originate from that run's logs — re-verify on new hosts
rather than trusting them as universal.

## Division of labor
Extraction analysis, spec-writing, taste gating: orchestrating agent (taste-critical
— do not delegate the gate). File builds: delegate builder against the written
contract, never "make it look like the site".
