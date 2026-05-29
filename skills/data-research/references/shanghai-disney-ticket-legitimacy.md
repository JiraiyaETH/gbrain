# Shanghai Disney Ticket / Vendor Legitimacy Pattern

Use this as a compact example for travel-ticket legitimacy research where the user wants exact websites, prices, and a recommendation.

## Research shape

- Start with the user-provided listing and extract exact visible facts from a rendered page.
- In parallel, check the official venue/seller for baseline price, authorized channels, official warnings, and official add-ons.
- Check major third-party vendors separately, but distinguish marketplace platform trust from the specific listing’s risk.
- Use cloud browser agents for rendered/date-specific pages when available; cross-check the final key facts locally.

## Fields to extract from a listing

- Title and URL
- Product/listing ID
- Platform/vendor and legal/operator footer if visible
- Date-specific price and currency
- Whether park/event admission is included
- Add-ons included, especially fast-pass/Premier Access equivalents
- Confirmation timing and how-to-use instructions
- Cancellation/refund terms, including contradictions
- Review count, rating, booked count
- Service language and age/passport/ID requirements
- Hidden-package or click-to-reveal details

## Key legitimacy distinction

A listing can be on a legitimate platform and still be a poor recommendation. For Shanghai Disney, the Trip.com marketplace product was on the real Trip.com site, but the specific product had low booking count, unclear operator identity, contradictory refund language, Mandarin default service, and bundled guide/concierge mechanics.

## Shanghai Disney-specific lessons

- Official Shanghai Disney pages warn that Disney Premier Access is only available via four official channels: official website, official app, official WeChat, and official Fliggy Store.
- Third-party “Fast Pass,” “VIP,” “butler,” or “no queue” products may be concierge/guided packages rather than official Disney Premier Access.
- Always verify whether admission is included; some Premier Access/service listings explicitly exclude admission.
- Real-name ticketing/ID requirements make unofficial resale riskier.

## Telegram-friendly output

Avoid tables. Use:

- Bottom line
- What the linked product actually is
- Official warning / authorized channels
- Best options found
- What to avoid
- Exact recommendation / booking path

Mark rough FX conversions as rough unless live FX was fetched.