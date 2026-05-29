# Calendly API reconnaissance notes

Use this as a compact reference when a future task asks whether Calendly can augment calendar availability, meeting slots, or bookings.

## Official surfaces checked

- API docs root: `https://developer.calendly.com/api-docs`
- Personal access tokens: `https://developer.calendly.com/how-to-authenticate-with-personal-access-tokens`
- OAuth docs: `https://developer.calendly.com/api-docs/3cefb59b832eb-calendly-o-auth-2-0`

## Auth pattern

- Private/internal integration: Personal Access Token is acceptable. Calendly warns not to share/reuse it; tokens are unretrievable after generation.
- Public/multi-user integration: OAuth 2.0 with client ID/secret; native/mobile apps should use redirect URI + PKCE/SHA256.

## Calendar/slot endpoints

- `GET /scheduled_events`
  - Lists Calendly events.
  - Useful filters: `user`, `organization`, `group`, `invitee_email`, `status`, `min_start_time`, `max_start_time`, `sort`, pagination.
  - Scope: `scheduled_events:read`.

- `GET /user_busy_times`
  - Returns internal Calendly events, reserved slots, and external calendar conflicts for a user.
  - Max requested date range: 7 days.
  - External events only appear for calendars with “Check for conflicts” configured.
  - Scope: `availability:read`.

- `GET /event_type_available_times`
  - Returns available start times for an event type plus `scheduling_url`.
  - Max requested date range: 7 days.
  - Scope: `availability:read`.

## Booking/write endpoints

- `POST /invitees`
  - Scheduling API endpoint to create a booking directly from an app without redirects/iframes/Calendly-hosted UI.
  - Standard notifications, calendar invites, reschedules, and workflows run as if booked through Calendly UI.
  - Requires Calendly paid plan: Standard and above; Free plan receives 403.
  - Scope: `scheduled_events:write`.

- `POST /one_off_event_types`
  - Creates an ad hoc/one-off event type with host, optional co-hosts, duration, timezone, date range, location.
  - Scope: `event_types:write`.

## Webhooks

- `POST /webhook_subscriptions`
  - Events include `invitee.created`, `invitee.canceled`, `invitee_no_show.created`, `invitee_no_show.deleted`, and routing form submissions.
  - Scopes can be `user`, `organization`, or `group`; create separate subscriptions for different scopes.
  - Optional `signing_key` supports webhook signature verification.
  - Scope: `webhooks:write`; event-specific read scopes also apply, e.g. `scheduled_events:read` for invitee events.

## Practical assessment

Calendly is sufficient for slot discovery, Calendly booking creation, and booking-change sync. For full calendar augmentation across all Google/Apple calendar events and rich event edits outside Calendly, pair it with the primary calendar provider API rather than relying only on Calendly busy-time data.
