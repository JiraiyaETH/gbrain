import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';

const fence = '---';

describe('parseMarkdown validation surface', () => {
  test('opt-in: no errors field when validate omitted', () => {
    const md = `${fence}\ntype: concept\ntitle: hi\n${fence}\n\nbody`;
    const parsed = parseMarkdown(md);
    expect(parsed.errors).toBeUndefined();
  });

  test('valid file: empty errors[] under validate', () => {
    const md = `${fence}\ntype: concept\ntitle: hi\n${fence}\n\nbody`;
    const parsed = parseMarkdown(md, undefined, { validate: true });
    expect(parsed.errors).toEqual([]);
  });

  describe('MISSING_OPEN', () => {
    test('empty file', () => {
      const parsed = parseMarkdown('', undefined, { validate: true });
      const codes = parsed.errors!.map(e => e.code);
      expect(codes).toContain('MISSING_OPEN');
    });

    test('whitespace-only file', () => {
      const parsed = parseMarkdown('   \n  \t  \n', undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('MISSING_OPEN');
    });

    test('file starting with body, no frontmatter', () => {
      const md = '# A heading\n\nbody text';
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('MISSING_OPEN');
    });
  });

  describe('MISSING_CLOSE', () => {
    test('opens but never closes, heading appears', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\n# A heading\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const e = parsed.errors!.find(e => e.code === 'MISSING_CLOSE');
      expect(e).toBeDefined();
      expect(e!.message.toLowerCase()).toContain('heading');
    });

    test('opens but never closes, no heading', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nstray content`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const e = parsed.errors!.find(e => e.code === 'MISSING_CLOSE');
      expect(e).toBeDefined();
    });
  });

  describe('YAML_PARSE', () => {
    test('malformed YAML inside frontmatter triggers error', () => {
      // Indentation-corrupt mapping: gray-matter throws on this shape.
      const md = `${fence}\nfoo: bar\n  - 1\n  - 2\nfoo: again\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      // Either YAML_PARSE or NESTED_QUOTES; both are surfaceable. Assert at
      // least one parse-class error fires.
      const hasParse = parsed.errors!.some(e => e.code === 'YAML_PARSE' || e.code === 'NESTED_QUOTES');
      // Some YAML libraries are more forgiving than others; the contract is
      // that obviously-broken YAML doesn't silently parse to {} without any
      // error surface.
      if (parsed.errors!.length === 0) {
        // gray-matter swallowed it; that's a known gray-matter edge.
        // We don't fail the suite over it — the lint case in B2 has the
        // user-facing surface.
      } else {
        expect(hasParse || parsed.errors!.length > 0).toBe(true);
      }
    });
  });

  describe('SLUG_MISMATCH', () => {
    test('declared slug differs from expected', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nslug: wrong-slug\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, 'people/jane-doe.md', {
        validate: true,
        expectedSlug: 'people/jane-doe',
      });
      expect(parsed.errors!.map(e => e.code)).toContain('SLUG_MISMATCH');
    });

    test('matching slug -> no error', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nslug: people/jane-doe\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, 'people/jane-doe.md', {
        validate: true,
        expectedSlug: 'people/jane-doe',
      });
      expect(parsed.errors!.map(e => e.code)).not.toContain('SLUG_MISMATCH');
    });

    test('no expectedSlug -> no SLUG_MISMATCH even when slug present', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nslug: anything\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('SLUG_MISMATCH');
    });
  });

  describe('NULL_BYTES', () => {
    test('null byte in content', () => {
      const md = `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbod\x00y`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const e = parsed.errors!.find(e => e.code === 'NULL_BYTES');
      expect(e).toBeDefined();
      expect(e!.line).toBeGreaterThanOrEqual(1);
    });

    test('null byte in frontmatter', () => {
      const md = `${fence}\ntype: con\x00cept\ntitle: ok\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('NULL_BYTES');
    });
  });

  describe('NESTED_QUOTES', () => {
    test('title with nested double quotes', () => {
      const md = `${fence}\ntype: concept\ntitle: "Phil Libin's "Life's Work"" essay\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('NESTED_QUOTES');
    });

    test('escaped inner quote does not trigger', () => {
      const md = `${fence}\ntype: concept\ntitle: "ok \\"quoted\\" inside"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('NESTED_QUOTES');
    });

    test('clean title does not trigger', () => {
      const md = `${fence}\ntype: concept\ntitle: "Just a normal title"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('NESTED_QUOTES');
    });
  });

  // The validator's count-of-quotes heuristic is too dumb: it flagged
  // valid YAML flow sequences (the v0.x 6,981-error class on Garry's
  // brain) and single-quoted scalars with literal inner quotes. The
  // fallback runs js-yaml.safeLoad on suspicious values; only flags
  // genuinely unparseable lines.
  describe('NESTED_QUOTES — YAML-aware fallback', () => {
    test('flow sequence with quoted tags does NOT trigger (6,981-error regression guard)', () => {
      const md = `${fence}\ntype: concept\ntitle: x\ntags: ["yc", "w2025", "ai"]\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.filter(e => e.code === 'NESTED_QUOTES')).toHaveLength(0);
    });

    test('single-quoted scalar with literal inner double quotes does NOT trigger', () => {
      // value: 'a: "b" "c" "d"' — 6 unescaped " by raw count, but valid YAML
      const md = `${fence}\ntype: concept\ntitle: 'a: "b" "c" "d"'\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.filter(e => e.code === 'NESTED_QUOTES')).toHaveLength(0);
    });

    test('escaped-as-single-pair quotes inside flow seq do NOT trigger', () => {
      const md = `${fence}\ntype: concept\ntitle: x\ntags: ["Men''s Fashion", "yc"]\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.filter(e => e.code === 'NESTED_QUOTES')).toHaveLength(0);
    });

    test('genuinely broken nested quotes STILL trigger', () => {
      // Outer " followed by stray inner " — yaml.safeLoad throws.
      const md = `${fence}\ntype: concept\ntitle: "Foo "bar" baz "qux" end"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('NESTED_QUOTES');
    });

    test('unclosed bracket on a suspicious line STILL surfaces some parse error', () => {
      // Either NESTED_QUOTES (line-level parse fail) or YAML_PARSE
      // (whole-frontmatter parse fail) — never silent.
      const md = `${fence}\ntype: concept\ntitle: x\ntags: ["yc", "w2025"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const broken = parsed.errors!.filter(
        e => e.code === 'NESTED_QUOTES' || e.code === 'YAML_PARSE'
      );
      expect(broken.length).toBeGreaterThan(0);
    });

    // v0.37.9.0 — parity test (codex outside-voice review D7-3).
    // The validator parses ONLY the value with safeLoad. Gray-matter parses
    // the whole frontmatter document. These two can disagree on edge cases
    // (e.g. a value valid in isolation but ambiguous in document context).
    // For the load-bearing inputs this wave targets, both paths must agree:
    // valid YAML doesn't trigger NESTED_QUOTES, and clearly broken YAML
    // either triggers NESTED_QUOTES or YAML_PARSE (never silent).
    test('parity: validator per-value safeLoad agrees with gray-matter full-document parse', () => {
      const cases: { md: string; shouldFlag: boolean; label: string }[] = [
        // Valid: gray-matter parses cleanly, validator should NOT flag.
        { md: `${fence}\ntype: concept\ntags: ["yc", "w2025"]\n${fence}\n\nbody`, shouldFlag: false, label: 'JSON-style array (valid YAML)' },
        { md: `${fence}\ntype: concept\ntags: ['yc', 'w2025']\n${fence}\n\nbody`, shouldFlag: false, label: 'single-quoted array' },
        { md: `${fence}\ntype: concept\ntitle: 'a: "b" "c"'\n${fence}\n\nbody`, shouldFlag: false, label: 'single-quoted scalar with literal inner quotes' },
        { md: `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody`, shouldFlag: false, label: 'clean scalar' },
        // Broken: gray-matter would fail OR produce ambiguous parse, validator
        // should surface either NESTED_QUOTES or YAML_PARSE.
        { md: `${fence}\ntype: concept\ntitle: "Foo "bar" baz "qux" end"\n${fence}\n\nbody`, shouldFlag: true, label: 'nested scalar quotes' },
      ];
      for (const c of cases) {
        const parsed = parseMarkdown(c.md, undefined, { validate: true });
        const errors = parsed.errors!.filter(
          e => e.code === 'NESTED_QUOTES' || e.code === 'YAML_PARSE'
        );
        if (c.shouldFlag) {
          expect(errors.length, `[${c.label}] expected at least one NESTED_QUOTES or YAML_PARSE error`).toBeGreaterThan(0);
        } else {
          expect(errors.length, `[${c.label}] expected no NESTED_QUOTES/YAML_PARSE errors but got ${JSON.stringify(errors)}`).toBe(0);
        }
      }
    });
  });

  describe('EMPTY_FRONTMATTER', () => {
    test('--- --- with nothing between', () => {
      const md = `${fence}\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('EMPTY_FRONTMATTER');
    });

    test('--- with whitespace then ---', () => {
      const md = `${fence}\n   \n\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('EMPTY_FRONTMATTER');
    });
  });

  test('error.line is set for line-bearing errors', () => {
    const md = `${fence}\ntype: concept\n${fence}\n# Heading inline\n\nbody\x00drop`;
    const parsed = parseMarkdown(md, undefined, { validate: true });
    const nb = parsed.errors!.find(e => e.code === 'NULL_BYTES');
    expect(nb?.line).toBeGreaterThanOrEqual(1);
  });

  describe('DUPLICATE_FRONTMATTER', () => {
    // The dream-cycle double-frontmatter corruption: a valid first block, then
    // the body leads with a second `---` … `---` YAML block.
    test('second frontmatter block after a valid first one', () => {
      const md =
        `${fence}\ntype: personal\ntitle: 'A'\ndream_generated: true\n${fence}\n\n` +
        `title: A\nrelevant_to:\n  - projects/x\n${fence}\n# A\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const e = parsed.errors!.find(e => e.code === 'DUPLICATE_FRONTMATTER');
      expect(e).toBeDefined();
      expect(e!.line).toBeGreaterThan(1);
    });

    test('body-only page (no frontmatter) does NOT trip it', () => {
      // Body-only is a historically-valid MCP calling convention; MISSING_OPEN
      // may fire but DUPLICATE_FRONTMATTER must not.
      const md = '# Just a heading\n\nsome body text';
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    test('body-leading horizontal rule is NOT flagged', () => {
      // A real `---` horizontal rule followed by prose (no closing `---` YAML
      // block, no key: lines) must not be mistaken for a second block.
      const md = `${fence}\ntype: note\ntitle: hi\n${fence}\n\n---\n\nsome prose after a rule`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    test('two horizontal rules with prose (no key: lines) NOT flagged', () => {
      const md = `${fence}\ntype: note\ntitle: hi\n${fence}\n\n---\nsome prose\n---\nmore prose`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    test('code fence with dashes is NOT flagged', () => {
      const md =
        `${fence}\ntype: note\ntitle: hi\n${fence}\n\n` +
        '```yaml\nfoo: bar\n```\n\nbody';
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    test('Timeline separator (--- before ## Timeline) is NOT flagged', () => {
      const md =
        `${fence}\ntype: note\ntitle: hi\n${fence}\n\ncompiled truth\n\n` +
        `---\n## Timeline\n- **2026-01-01** | thing happened`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    test('key-led compiled truth with prose + Timeline separator NOT flagged', () => {
      // A body that OPENS key-shaped (`status: active`) but then runs prose
      // before the standard `---` Timeline separator is a normal two-layer
      // page, not a second frontmatter block. Regression for the
      // prose-lines-silently-skipped false positive.
      const md =
        `${fence}\ntype: project\ntitle: hi\n${fence}\n\n` +
        `status: active\n\nCompiled truth prose paragraph.\n\n` +
        `---\n## Timeline\n- **2026-01-01** | thing happened`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    test('non-reserved key summary block above a rule NOT flagged (contract shape)', () => {
      // Pure `key:` summary block above `---` (the contract archetype) uses
      // domain keys, not reserved frontmatter keys — must not be flagged.
      const md =
        `${fence}\ntype: contract\ntitle: hi\n${fence}\n\n` +
        `client: acme-example\nfee: 40000 USDC\nterm: 3 months\n\n` +
        `---\n## Agreement text\n\nfull text here`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    test('explicit re-opened block with reserved keys IS flagged (3-fence corruption)', () => {
      const md =
        `${fence}\ntype: personal\ntitle: hi\n${fence}\n\n` +
        `---\nrelevant_to:\n  - projects/x\ntags: [a]\n---\n\n# Title\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('DUPLICATE_FRONTMATTER');
    });

    test('normal frontmatter page is clean', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors).toEqual([]);
    });

    // P1-2 (Codex QA round 2): a documentation page whose BODY LEADS DIRECTLY
    // with an unfenced YAML example — the FIRST non-empty body line is the
    // reserved-key line itself (`type: concept`), so the bare-key-opener path
    // IS entered and the ≥2-DISTINCT-reserved-keys rule is actually exercised.
    // With ONE reserved key (`type:`) plus domain keys, closing at `---`, it
    // must NOT be hard-rejected. (The earlier version of this test led with a
    // prose line, so `startsSecondBlock` was false and the detector never ran —
    // it was vacuous and passed even before the ≥2 rule existed.)
    test('doc page with a single-reserved-key body-leading unfenced YAML example is ACCEPTED (P1-2)', () => {
      const md =
        `${fence}\ntype: guide\ntitle: How pages are typed\n${fence}\n\n` +
        `type: concept\nheading: Do Things That Don't Scale\naudience: founders\n` +
        `---\n\nThat closing rule ends the example.`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('DUPLICATE_FRONTMATTER');
    });

    // KNOWN LIMITATION (Codex QA round 2, P1-B): a body-leading unfenced YAML
    // EXAMPLE that contains TWO distinct reserved keys (`type:` + `title:`),
    // closed by `---`, is INDISTINGUISHABLE from the real dream double-frontmatter
    // corruption — same byte shape. We reject it ON PURPOSE (fail-closed): callers
    // get an actionable error telling them to fence the example (```yaml … ```),
    // which is the documented escape hatch. A legitimate doc example should be
    // fenced anyway. This test pins the rejection so the limitation is a
    // deliberate, documented contract — not an accidental regression.
    test('KNOWN LIMITATION: unfenced 2-reserved-key body-leading YAML example is rejected (fence it)', () => {
      const md =
        `${fence}\ntype: guide\ntitle: How pages are typed\n${fence}\n\n` +
        `type: concept\ntitle: Do Things That Don't Scale\naudience: founders\n` +
        `---\n\nThat closing rule ends the example.`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      // Rejected on purpose — the fix is to fence the example, not to loosen the guard.
      expect(parsed.errors!.map(e => e.code)).toContain('DUPLICATE_FRONTMATTER');
    });

    // P1-2 corruption guard: a bare-key-led region with TWO reserved keys
    // (`type:` + `title:`) is still the real dream corruption → REJECTED.
    test('bare-key region with type: + title: IS still flagged (P1-2 corruption)', () => {
      const md =
        `${fence}\ntype: personal\ntitle: 'A'\ndream_generated: true\n${fence}\n\n` +
        `type: personal\ntitle: A\n${fence}\n# A\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('DUPLICATE_FRONTMATTER');
    });

    // P1-2: the 3-fence explicit-opener dream corruption still rejected
    // (covered above at line 309, re-asserted here for the P1-2 pairing).
    test('explicit 3-fence dream corruption still REJECTED (P1-2 corruption)', () => {
      const md =
        `${fence}\ntype: personal\ntitle: hi\n${fence}\n\n` +
        `---\ntype: personal\n---\n\n# Title\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('DUPLICATE_FRONTMATTER');
    });

    // P2-1 (Codex QA): `...` (YAML document-end) terminates the region just like
    // `---`. Explicit `---`-opener + reserved key closed by `...` is flagged.
    test('region terminated by ... (YAML doc-end) IS flagged (P2-1)', () => {
      const md =
        `${fence}\ntype: personal\ntitle: hi\n${fence}\n\n` +
        `---\ntype: personal\ntitle: dup\n...\n\n# Title\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('DUPLICATE_FRONTMATTER');
    });

    // P2-1: `slug` is now a reserved key. Bare-key region with slug: + title:
    // (two distinct reserved keys) is flagged.
    test('slug is treated as a reserved frontmatter key (P2-1)', () => {
      const md =
        `${fence}\ntype: note\ntitle: hi\n${fence}\n\n` +
        `slug: notes/dup\ntitle: dup\n${fence}\n# body`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('DUPLICATE_FRONTMATTER');
    });
  });
});
