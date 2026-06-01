---
name: book-mirror
version: 0.1.0
description: >-
  Take any book (EPUB/PDF), produce a story-first personalized reading companion.
  Each chapter preserves the anecdote, POVs, character archetypes, and sequence
  before adding a small assimilation layer: extraction, belief challenge,
  reinforcement, discard, tiny lever, or no strong fit. Output is a single brain
  page at media/books/<slug>-personalized.md plus an optional PDF via brain-pdf.
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "story-first book mirror"
  - "apply this book to my life"
  - "how does this book apply to me"
mutating: true
writes_pages: true
writes_to:
  - media/books/
---

# book-mirror — Story-First Personalized Book Mirror

> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for the
> sanctioned `media/<format>/<slug>` exception this skill files under.
>
> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, back-link enforcement, and output quality bars.
>
> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain (brain → search → external) the context-gathering
> phase follows.

## What this does

Given a book (EPUB or PDF), produce a brain page where every chapter is first
reconstructed as a readable story/anecdote, then lightly mirrored back to the
reader's living belief system. The story spine must preserve sequence, POV,
character archetypes, pressure, concrete details, and memorable phrasing before
any personalization appears. The mirror layer then surfaces what the reader can
extract, contest, reinforce, discard, or use as a tiny lever — using their own
words, situations, people, and patterns from the brain only where the fit is
real. Output is a brain page at `media/books/<slug>-personalized.md`.

This is NOT a generic book summary and it is NOT a forced life-mapping engine.
The story comes first because the reader's stickiness comes from following
anecdotes, POVs, and archetypes before assimilating. Personalization is the
second layer: short, selective, and only where there is a natural collision. A
passage may matter because it shifts one tiny local subject; it does not need
to map grandly onto every domain of the reader's life. If the user wants a
flat summary instead, route them to a different skill.

## Trust contract (read this before running)

book-mirror runs as a CLI command (`gbrain book-mirror`), NOT as a pure
markdown skill that the agent dispatches via tools. The CLI is the trusted
runtime; the skill is the orchestration prose around it.

What this means for the agent:

- Subscription lanes (`hermes`, `call-claude`) run no-tool workers. They
  CANNOT call `gbrain`, `get_page`, `search`, or `put_page`. They only see
  chapter text plus the supplied `--context-file`, so all personalization must
  be preloaded into the context pack.
- The legacy `anthropic` lane submits read-only subagent jobs with
  `allowed_tools: ['get_page', 'search']` only. They CANNOT call put_page or
  any mutating op. They produce markdown analysis via their final message.
- The CLI reads each worker's result, assembles the final story-first mirror page,
  and writes it via a single operator-trust `put_page`.
- For Jiraiya/Alex Hermes runs, use the pinned subscription lane
  `--runtime hermes --model gpt-5.5` (runner provider: `openai-codex`). The
  runner must fail closed if provider/model mention GLM/Z.AI, if Hermes fallback
  providers are configured, or if smart model routing is enabled. Do not silently
  substitute GLM/Z.AI for a failed Codex/GPT lane.
- This means untrusted EPUB/PDF content cannot prompt-inject any page write.
  For the no-tool subscription lanes, it also means the book cannot magically
  discover missing reader context: the context pack is the personalization
  boundary.

## The pipeline

```
1. ACQUIRE   → User has the EPUB/PDF locally (manual; book-acquisition is
               not currently shipped — see "Acquiring the book" below).
2. EXTRACT   → Pull chapter text from EPUB/PDF into one .txt per chapter.
3. CONTEXT   → Build a source-disclosed reader model / context pack.
4. ANALYZE   → `gbrain book-mirror` fans out N read-only subagents.
5. ASSEMBLE  → CLI reads each child result and writes one put_page.
6. PDF       → Optional: render via skills/brain-pdf for delivery.
```

## 1. Acquiring the book

book-acquisition (legal-grey-area downloader) was deliberately not shipped
in this skill wave. The user drops the EPUB/PDF manually. Common paths the
user might use:

```bash
# User-supplied path
ls path/to/book.epub
ls path/to/book.pdf

# Or already in the brain repo (recommended for tracking)
ls $BRAIN_DIR/media/books/
```

Resolve `$BRAIN_DIR` from the gbrain config (`gbrain config get sync.repo_path`)
or accept it from the user.

## 2. Text extraction

Goal: one `.txt` file per chapter under a temp directory. The agent has
shell + python access; the CLI is downstream of this and takes the
extracted directory as input.

### EPUB

```bash
SLUG="this-book"                                # kebab-case
WORK="$(mktemp -d)/$SLUG"
mkdir -p "$WORK/chapters"
unzip -o path/to/book.epub -d "$WORK/unpacked"

# Find content files (XHTML/HTML), sorted (chapter order = sort order)
find "$WORK/unpacked" -name "*.xhtml" -o -name "*.html" | sort > "$WORK/files.txt"

# Strip HTML to text per chapter
python3 - <<'PY'
from bs4 import BeautifulSoup
import os, sys
work = os.environ['WORK']
files = open(f'{work}/files.txt').read().splitlines()
for i, path in enumerate(files, 1):
    html = open(path, encoding='utf-8', errors='replace').read()
    text = BeautifulSoup(html, 'html.parser').get_text('\n')
    text = '\n'.join(line.strip() for line in text.splitlines() if line.strip())
    with open(f'{work}/chapters/{i:02d}.txt', 'w') as f:
        f.write(text)
PY
```

If `bs4` is missing: `pip3 install beautifulsoup4 lxml`.

Inspect the chapter files to identify which are real chapters vs front
matter (TOC, copyright, acknowledgments). Often the EPUB ships one file
per chapter; sometimes multiple chapters per file. Use
`head -5 "$WORK/chapters/"*.txt` to spot-check.

### PDF

```bash
pdftotext -layout path/to/book.pdf "$WORK/full.txt"
```

Then split by chapter heading (look for "Chapter N", "CHAPTER N", or
all-caps title lines) using `awk` or `python`. If the PDF is a scan with
no embedded text, fall back to OCR via `skills/brain-pdf` or another
vision tool.

### Quality check

For each chapter file:

- Word count > 1500 (typical chapter range 2k–8k words).
- No HTML tags.
- Paragraphs preserved with `\n\n`.

Save a `chapters/INDEX.md` mapping chapter number → title → file → word
count for reference.

## 3. Context gathering

This is the most critical step. The mirror/assimilation layer is only as good as
the reader model fed to each chapter worker. In subscription lanes, workers have
no tools, so they cannot fetch more Brain context. The context pack is the
personalization boundary.

### Mirror stance

Do not force a book into preselected life lanes. The reader may not have a
specific question for a random book. The job is to let the reader enter the
story first, understand the POVs/archetypes/pressures, then notice what can be
extracted, contested, reinforced, discarded, or used as a tiny lever.

The core output sequence is:

1. **Story Spine** — chronological, readable narrative; no personalization.
2. **Operating Cast / Archetypes** — how the people in the anecdote see,
   misread, protect, threaten, freeze, escalate, comply, resist, or learn.
3. **Mechanisms in the Story** — what the anecdote reveals about systems and
   human behavior.
4. **Mirror / Assimilation Notes** — only 2-5 selective collisions after the
   story is legible.
5. **Chapter Takeaway** — what should stick as a question, archetype, or
   mechanism.

A line can matter because it changes one small subject in the moment; that is
enough. But if personalization interrupts the story before the reader can build
the schema, the mirror has failed.

Use these assimilation labels instead of a single "applies to your life"
bucket:

- `natural fit` — the book clearly touches an active pattern, project,
  relationship, decision, habit, or identity thread.
- `belief challenge` — the author pressures a current worldview or assumption.
- `belief reinforcement` — the chapter strengthens an existing stance.
- `tiny lever` — a small sentence changes one local behavior or diagnostic.
- `discard / not for you` — the idea is unhelpful, naive, outdated, or mismatched.
- `watch this in life` — not actionable now, but worth noticing in people,
  markets, systems, or the reader's future decisions.
- `no strong fit` — preserve the author's idea without pretending it matters.

### Required context manifest

Every context pack must start with a manifest so the final mirror can disclose
exactly what it was personalized against:

```md
# Reader Context Manifest

## Brain pages read
- people/jiraiya — durable operating model, standards, identity/context.
- sources/jiraiya-operating-model-how-i-think-2026-05-15 — raw operating model.
- projects/jiraiya-operator-dojo — current learning/focus system.
- projects/jiraiya-operator-dojo-concept-ledger — concepts already taught.
- projects/jiraiya-operator-dojo-reader-model-v0-1 — evidence-derived reader model / care-rules / taste-rules.
- reflections/2026-06-01-book-mirror-reading-as-belief-system-refinement — book-mirror reader lens.
- [theme-specific pages...]

## What this context is modeling
- How the reader extracts, contests, updates, reinforces, or discards beliefs.
- Current live arenas that may naturally appear, without forcing every one.
- No off-limits areas unless the user says otherwise.

## What this context is NOT doing
- It is not a mandate to map every chapter to every life domain.
- It is not proof that missing pages were irrelevant; it only names what was read.
```

### Baseline Jiraiya reader pack

For Jiraiya, include these pages before any theme-specific retrieval:

1. `people/jiraiya`
2. `sources/jiraiya-operating-model-how-i-think-2026-05-15`
3. `projects/jiraiya-operator-dojo`
4. `projects/jiraiya-operator-dojo-concept-ledger`
5. `projects/jiraiya-operator-dojo-reader-model-v0-1`
6. `reflections/2026-06-01-book-mirror-reading-as-belief-system-refinement`
7. `reflections/2026-05-30-ai-multithreading-focus-regression-f8b661`
8. `reflections/2026-05-30-five-domain-curriculum-and-the-ai-headcount-question-83d2b5`

Then add theme-specific pages only where the book naturally points. Business
books may pull Tailored/client/project pages. Health or discipline books may
pull health/workout/routine pages. Relationship books may pull relationship or
people pages. Do not load a domain just because it exists.

### Optional preflight interview

Do not require the user to invent specific questions. Ask only if the context
pack is thin or the book's domain makes scope ambiguous. Good questions:

1. Are we in open-extraction mode, or do you already have a live tension you
   want the book to pressure?
2. Any current belief you want stress-tested, or should the mirror infer the
   pressure points from the book?
3. Should the output be mostly margin notes, practical experiments, strategic
   synthesis, or brutal operator critique?
4. Are there people/projects that should be named if a natural fit appears?

### Assemble a context pack

Write everything to a single file the CLI can read:

```bash
CONTEXT="$WORK/context.md"
{
  echo "# Reader Context Manifest"
  echo "## Brain pages read"
  echo "- people/jiraiya — ..."
  echo "- projects/jiraiya-operator-dojo-reader-model-v0-1 — ..."
  echo "- reflections/2026-06-01-book-mirror-reading-as-belief-system-refinement — ..."
  echo
  echo "# Reader Lens"
  echo "Reading style: extraction, contest, belief update, reinforcement, discard, tiny levers."
  echo "Mapping rule: natural fit only; never force every passage into Tailored/Jarvis/money/health/etc."
  echo
  echo "# Source excerpts and distilled claims"
  # Paste verified snippets / distilled claims from each Brain page here.
  # Include direct quotes where they materially shape the mirror.
} > "$CONTEXT"
```

Make this dense and source-disclosed. It is read by every chapter worker.

## 4. Analysis: invoke `gbrain book-mirror`

```bash
gbrain book-mirror \
  --chapters-dir "$WORK/chapters" \
  --context-file "$CONTEXT" \
  --slug "$SLUG" \
  --title "Book Title Goes Here" \
  --author "Author Name" \
  --runtime hermes \
  --model gpt-5.5
```

The CLI:

- Validates inputs and loads chapter files.
- Prints a cost estimate (~$0.30/chapter at Opus) and prompts to confirm.
- Submits N child subagent jobs with read-only `allowed_tools`.
- Waits for every child to complete.
- Reads each child's `job.result` (the markdown analysis text).
- Assembles all chapters into one page with frontmatter + intro + per-chapter
  sections + closing.
- Writes ONE `put_page` to `media/books/<slug>-personalized.md`.
- Reports a JSON envelope on stdout:
  `{"slug": "...", "chapters_total": N, "chapters_completed": N, "chapters_failed": 0}`.

If any chapter failed, the CLI exits 1 and the user can re-run — idempotency
keys (`book-mirror:<slug>:ch-<N>`) deduplicate completed chapters at the
queue level, so retry is cheap.

### Model lane defaults

For Jiraiya/Alex, default to the subscription-backed Hermes lane:
`--runtime hermes --model gpt-5.5` (runner provider: `openai-codex`). This is
the lane that carries the no-GLM/Z.AI fallback guard.

Use `--runtime call-claude --model claude-opus-4-8` for a deliberate Claude
Opus pass. The legacy `anthropic` lane exists for older minion-queue runs but is
not the preferred path for this workflow.

### Cost gate

The CLI refuses to spend in a non-TTY context without `--yes`. CI / scripted
invocations must pass `--yes` explicitly. TTY users get a `[y/N]` prompt
before submission.

## 5. PDF (optional)

After the brain page is written, render to PDF using `skills/brain-pdf`:

```bash
gbrain put_page  # already done by the CLI; nothing to add here
# Then invoke brain-pdf:
# (see skills/brain-pdf/SKILL.md for the make-pdf invocation)
```

## 6. Fact-check and cross-link

After the page lands, run a fact-check pass on factual claims about the
reader (parents, siblings, marriage history, jobs, heritage). Common error
patterns to look for:

- Conflating the reader's parents' relationship with patterns in extended
  family.
- Inventing therapy backstory ("after his parents' divorce…") when the
  reader's parents are still together.
- Wrong number/age of children, wrong spouse / kid / sibling names.

If you can't verify a claim, remove it. Better to lose texture than to
introduce a falsehood.

Cross-link entities mentioned in the analysis:

- For every person the mirror layer references with a brain page, add a
  back-link from `people/<slug>` to the new `media/books/<slug>-personalized`
  page (per `conventions/quality.md` Iron Law).

## Quality bar (the bar)

The **story layer** should:

- Preserve the author's actual anecdotes, scenes, frameworks, examples, and
  character pressure without reader-context interruption.
- Make the chapter followable as a story: who wants what, what they believe,
  what they miss, what happens next, and why it matters.
- Quote memorable phrases verbatim when they anchor the scene or mechanism.
- Be detailed enough that the reader can build archetype/person profiles and
  mental schemas before assimilating.

The **archetype/mechanism layer** should:

- Name how each important actor thinks and responds under pressure.
- Explain the mechanism from the story outward, not from abstract business
  jargon inward.
- Preserve book texture and historical/era context when useful.

The **mirror layer** should:

- Arrive after the story is legible, not inside every paragraph.
- Use only 2-5 selective assimilation notes per chapter.
- Use the reader's *actual quoted words* from the context pack when the note
  depends on a personal claim.
- Reference *specific* dates, situations, people by name only when the fit is
  real and useful.
- Label the collision honestly: natural fit, belief challenge, belief
  reinforcement, tiny lever, discard / not for you, watch this in life, or no
  strong fit.
- Be plain about direct hits ("This is exactly the [name a real situation]").
- Be honest about misses ("No strong fit here; preserve the author's point
  without personalizing it"). Don't force connections.
- Avoid routing every passage into Tailored, Jarvis, money, health, or any
  fixed domain just because that domain matters to the reader.

The **whole document** should feel like one coherent voice, calibrated to
the reader's actual life rather than a generic profile, and honest about
where the book's framing breaks down for this specific reader.

## Anti-patterns (do not do these)

- ❌ **Skimming chapters.** Standing instruction: preserve detail.
- ❌ **Generic mirror notes.** "This might apply if you've ever felt…" →
  kill on sight.
- ❌ **Factual errors about the reader's life.** Always fact-check after
  assembly.
- ❌ **Giving the subagent put_page access.** Trust contract is read-only;
  the CLI does the writing.
- ❌ **Forcing connections.** If a section doesn't apply, say so plainly.
- ❌ **Forcing fixed domains.** Do not route every idea through Tailored,
  Jarvis/Hermes, money, health, relationships, or any other lane just because
  that lane matters to the reader.
- ❌ **No source manifest.** If the output does not reveal which Brain pages
  shaped the reader model, the mirror is not trustworthy.
- ❌ **Sycophancy or moralizing in the mirror layer.** No "you should…",
  no "consider…", no "perhaps it's time to…".
- ❌ **Truncating the story layer.** The book's actual content needs to
  survive.

## Output checklist

- [ ] Book file exists locally (path known).
- [ ] Chapter texts under `$WORK/chapters/*.txt` with sane word counts.
- [ ] Context pack at `$WORK/context.md` is dense and starts with a Reader Context Manifest.
- [ ] Context manifest lists exact Brain pages read; for Jiraiya, it includes `projects/jiraiya-operator-dojo-reader-model-v0-1` and `reflections/2026-06-01-book-mirror-reading-as-belief-system-refinement`.
- [ ] `gbrain book-mirror --chapters-dir … --context-file … --slug … --title …` returned exit 0.
- [ ] `media/books/<slug>-personalized.md` exists in the brain.
- [ ] Fact-check pass complete (no errors against USER.md or other source-of-truth pages).
- [ ] Cross-links added from referenced people/companies.
- [ ] Optional: PDF rendered via brain-pdf and delivered.

## Related skills

- `skills/brain-pdf/SKILL.md` — render the personalized page to PDF.
- `skills/strategic-reading/SKILL.md` — read a book through a specific
  problem-lens instead of personalizing to the whole reader.
- `skills/article-enrichment/SKILL.md` — same shape applied to articles
  rather than books.


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).

## Anti-Patterns

The full anti-pattern list is in the body sections above; this header exists for the conformance test if the body uses a different casing.
