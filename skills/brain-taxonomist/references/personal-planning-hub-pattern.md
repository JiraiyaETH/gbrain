# Personal Planning Hub Pattern — Wedding Prep Case

Session-derived reference for applying `brain-taxonomist` to personal planning workstreams.

## Pattern

For a personal outcome with many planning surfaces, avoid one large project page. Use:

- `projects/<outcome>.md` as a compact control plane: status, next actions, blockers, key dates, links, and operating rules.
- `notes/<outcome>-<topic>.md` as satellites for detailed planning areas: documents, itinerary, dress code, guest plan, vendor questions.
- `sources/` only for raw-ish imported inputs that feed multiple pages: vendor policy excerpts, copied quotes, exported guest/contact data, booking confirmations.
- Secure external storage for sensitive originals and raw PII.

## Sensitive boundary

Do not store raw sensitive documents in Brain pages:

- passports / IDs
- visas and residence permits
- certificates and signatures
- payment details
- full guest addresses/contact data

A Brain page may track collection status and a pointer such as “stored in secure docs folder,” but not the raw file or private identifiers.

## Edge verification

After writing a hub and satellites with wiki links, verify the graph rather than assuming it:

```bash
gbrain backlinks <target-slug> --source default
gbrain graph <hub-slug> --depth 1 --source default
gbrain graph <satellite-slug> --depth 1 --source default
```

Expected shape for a two-page hub/satellite setup:

```text
projects/my-wedding --mentions-> notes/my-wedding-prep
notes/my-wedding-prep --mentions-> projects/my-wedding
```

If an expected edge is missing immediately after file writes/captures, run a scoped or recent extraction pass and re-check before reporting the graph shape.
