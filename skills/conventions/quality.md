# Quality Convention

Cross-cutting quality rules for all brain-writing skills.

> **Graph-safety:** Also read `conventions/graph-safe-writing.md` before any
> Brain write that can create links. Back-linking is mandatory, but wikilinks are
> graph evidence, not decoration; strong typed edges must be sparse, intentional,
> and verified after write.
>
> **Retrieval-safety:** Also read `conventions/post-run-retrieval-gate.md` after
> meaningful writes. A page is not useful merely because it exists; it must be
> retrievable without wrongly outranking more canonical pages.

## Citations (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

- **User's statements:** `[Source: User, {context}, YYYY-MM-DD]`
- **Meeting data:** `[Source: Meeting "{title}", YYYY-MM-DD]`
- **Email/message:** `[Source: email from {name} re: {subject}, YYYY-MM-DD]`
- **Web content:** `[Source: {publication}, {URL}, YYYY-MM-DD]`
- **Social media:** `[Source: X/@handle, YYYY-MM-DD](URL)`
- **Synthesis:** `[Source: compiled from {sources}]`

### Source precedence (highest to lowest)

1. User's direct statements (highest authority)
2. Compiled truth (brain's synthesized understanding)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search)

## Back-Linking (MANDATORY)

The Iron Law means every **material entity relationship** must have a traversable
back-link. It does **not** mean every incidental name string becomes a wikilink.

Create a back-link FROM an entity page TO the page mentioning it when the mention
is one of these:
- an attendee, participant, party, counterparty, author, source, client, founder,
  teammate, investor, advisor, or other relationship worth querying later;
- a dated event that belongs on the entity's timeline;
- a source page that materially changes the entity's compiled truth;
- a high-signal network/context edge the user would expect to traverse.

Keep the name as plain prose/citation text when it is only an example, a passing
name in a long source, provenance wallpaper, transcript noise, or a low-signal
co-mention with no durable relationship.

Format for intentional back-links:
`- **YYYY-MM-DD** | Referenced in [page title](path) -- context`

A missing back-link for a material relationship is a broken brain. A dense set
of incidental backlinks is also a broken graph.

## Notability Gate

Before creating a new brain page, check notability:

- **People:** Will you interact again? Relevant to work/interests?
- **Companies:** Relevant to work/investments/interests?
- **Concepts:** Reusable mental model? Worth referencing again?

When in doubt, DON'T create. A 400-follower person who tweeted once is not notable.
