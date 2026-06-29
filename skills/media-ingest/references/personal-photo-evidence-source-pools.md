# Personal photo evidence source pools

Use this pattern when the user wants help with private photo/video collections that may serve both an administrative evidence purpose and a later creative artifact, e.g. relationship evidence for a marriage application plus a future wedding video.

## Rule

Do **not** treat private personal photo collections like ordinary public media ingest. Raw originals should normally stay outside the Brain in a private local data folder or secure vault. The Brain should store only distilled, non-sensitive planning state: indexes, timelines, proof summaries, selection notes, and pointers to the private storage location.

## Recommended layout

```text
~/data/personal/<project>/evidence/
  00_inbox/                 # temporary drop zone
  01_relationship-photos/   # exported originals from Photos / phone
  02_message-screenshots/   # dated chat/call screenshots
  03_travel-bookings/       # flights, hotels, itineraries, location overlap
  04_curated-for-agency/    # final small admin/legal evidence pack
  05_video-candidates/      # emotionally strong media for future creative cut
  metadata/                 # generated EXIF/OCR/index outputs
```

Adapt folder names to the project, but preserve the separation between raw intake, curated administrative evidence, creative candidates, and generated metadata.

## Acquisition guidance

- Prefer original exports from Photos/iCloud/phone over Telegram/WhatsApp copies because chat apps often compress media and strip metadata.
- On macOS Photos, ask the user to make an album and export **Unmodified Originals** when metadata matters.
- AirDrop or cable/import from phone is usually better than forwarding through chat.
- Screenshots and booking PDFs are fine for administrative evidence; put them in their own lane.

## Processing loop

1. Collect raw media outside Brain.
2. Extract EXIF/date/location where available.
3. OCR screenshots and booking confirmations.
4. Build a lightweight CSV/JSON index in `metadata/`.
5. Curate a small evidence pack for the external recipient.
6. Write only the distilled timeline, gap tracker, and storage pointer into Brain.
7. For creative output later, reuse `05_video-candidates/` as the source pool; do not make the evidence pack carry the emotional/storytelling burden.

## Pitfalls

- Do not bulk-upload private originals into Brain just because `gbrain files upload-raw` exists.
- Do not use compressed chat-forwarded copies when date/location fidelity matters.
- Do not mix administrative proof selection with creative/storytelling selection; their objectives differ.
- Do not store passports, IDs, payment details, full guest PII, or sensitive legal originals in Brain.
