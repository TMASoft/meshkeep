# PWA, offline, and background-notification feasibility (#54)

## Decision

Do **not** describe MeshKeep as an offline-first or guaranteed-background-notification
PWA. The supported baseline remains a connected browser client. Browser-direct
radio operation is an interactive, Chromium-family feature; it is not a background
transport. A versioned static-asset cache and a best-effort Web Push subscription
path now exist (#74, #76), but neither is delivery-guaranteed, and physical
hardware/browser validation (#77) is still open.

The distinction matters: service workers are event-driven and may be stopped while
idle. They do not keep a WebSerial/WebBLE connection or a WebSocket alive. Push can
wake a worker for a generic notification event (implemented, see below), but that is
not the same guarantee as a persistent background connection — it depends on the
OS/browser honoring the push, which MeshKeep cannot control or verify without
physical devices.

## Platform and capability matrix

| Capability                                    | Chromium desktop (HTTPS/localhost)                                            | Chromium Android                                                 | Firefox desktop/Android                    | Safari macOS/iOS                                   | MeshKeep support statement                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| WebSerial                                     | Secure-context, user-picker API; MeshKeep's supported browser-direct target   | Do not claim support without a device validation run             | Not a supported target                     | Not a supported target                             | Chromium desktop only, with an interactive user gesture and radio chooser |
| WebBluetooth (BLE)                            | Secure-context, experimental user-picker API; validate adapter/radio firmware | Do not claim support without a device validation run             | Not a supported target                     | Not a supported target                             | Chromium desktop only, experimental; no background connection guarantee   |
| Service worker registration                   | Expected in a secure context                                                  | Expected in a secure context                                     | Expected in a secure context               | Expected in a secure context                       | Best-effort enhancement only; browser/OS can stop it                      |
| Notification display while app is open/hidden | Available after explicit permission; page API is current implementation       | Page constructor can be restricted; worker display is prototyped | Available only if platform/browser permits | Available only if platform/browser permits         | Permission-gated and best-effort; not delivery-guaranteed                 |
| Push when no MeshKeep tab is running          | Server + client subscription/delivery code exists (#76 prototype); unvalidated on physical hardware | Same code path; unvalidated                                       | Same                                       | Same, plus platform install/permission constraints | Best-effort prototype; not delivery-guaranteed; physical validation pending (#77) |
| Persistent background radio/WebSocket         | Unsupported                                                                   | Unsupported                                                      | Unsupported                                | Unsupported                                        | Unsupported: a worker is not a daemon                                     |

The Android, Firefox, and Safari cells intentionally avoid version claims. Their
real behavior depends on browser build, OS policy, installation state, notification
settings, and hardware. They need physical-browser validation before becoming
supported configurations.

Sources:

- [MDN: Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
  — secure context and limited browser support.
- [MDN: Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
  — secure context; experimental API.
- [MDN: PushManager](https://developer.mozilla.org/en-US/docs/Web/API/PushManager)
  — Push is a secure-context worker API.
- [web.dev: service-worker lifecycle](https://web.dev/learn/pwa/service-workers/)
  — workers are started by events and terminated when idle.
- [web.dev: Push notification overview](https://web.dev/articles/push-notifications-overview)
  — permission should follow a user gesture and push needs subscription handling.

## Cache and storage policy

### Current behavior

As of #74, `public/notification-sw.js` also runs a versioned static-asset cache:
same-origin GET requests for build assets are cache-first (content-hashed, so
they never change once fetched), navigations are network-first with a cache
fallback, and `/api/*` requests are never intercepted. The cache name is keyed
by the app version (passed via the registration URL's `?v=` query string, read
back with `self.location.href`); `activate` keeps the current build's cache
plus one rollback build and deletes anything older (`public/sw-cache-logic.js`
has the pure eviction logic, unit-tested in `test/sw-cache-logic.test.ts`). It
still does not cache application/API data — see the policy table below.

The browser-direct source has a small IndexedDB `meshkeep` / `ingest-queue`
queue for failed non-private ingest sync-backs, bounded to 100 records and
1 MiB with FIFO eviction and a 24h TTL, pruned on every read and write
(`pruneQueue` in `src/sources/browser-radio-core.ts`). It is cleared on logout,
browser-radio disconnect (which also covers a private-session switch, since
starting a new session always stops the previous one first), and explicit
local-data reset (`store.resetLocalData()`, exposed as "Reset local data" in
Display settings). The only other browser persistence used by this feature is
local preferences such as notification mode, also cleared on local-data reset.

A private browser-direct session intentionally does not sync back to the server;
production offline work must not make that session durable without a separate,
explicit user decision.

### Required policy before any production PWA cache

| Data class                                                                                               | Persist/cache?                                                      | Limit and eviction                                                                             | Invalidation and logout                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned, public static assets (HTML/CSS/JS/icons)                                                      | Yes, after a separate PWA review                                    | One active build plus one rollback build; delete older named caches on activate                | Build-id cache names; purge obsolete caches on activate; logout does not need assets retained but may clear them on shared devices                |
| Appearance and notification preference                                                                   | Yes, local browser preference                                       | Tiny fixed keys only; no message/contact identity                                              | Clear on explicit local-data reset; notification preference remains subject to browser permission                                                 |
| Browser-direct non-private ingest retry queue                                                            | Only while a live session needs retry                               | Maximum 100 records **and** 1 MiB; FIFO eviction; hard TTL 24 hours                            | Delete after confirmed ingest; expire on each read/write; clear on logout, browser-radio disconnect, private-session switch, and local-data reset |
| Messages, contacts, channels, telemetry, timeline, location, device profiles, keys/tokens, API responses | No persistent CacheStorage/IndexedDB cache in the first PWA release | N/A                                                                                            | Keep server authoritative; never place these in a shared/offline cache                                                                            |
| Push subscription metadata                                                                               | Future server-side only, encrypted/least-privilege storage          | One subscription per authenticated browser/profile; remove stale endpoints on delivery failure | Bind to authenticated session/device; delete on logout, revocation, and account reset                                                             |

Quota is browser-owned and may evict site data at any time. Every cache/queue path
must tolerate loss and resync from the server; no delivery, message status, or radio
state may depend on browser persistence.

## Notification consent and privacy policy

1. The default is **off**. Ask permission only after a deliberate click that explains
   the requested notification scope. Never prompt on first load or retry a browser
   denial automatically.
2. Respect both controls: MeshKeep's `off`/`DMs`/`DMs + channels` preference and the
   browser's current permission. A browser revocation/denial immediately suppresses
   future attempts and directs the user to site settings.
3. The production default notification must be generic (`New MeshKeep message` or
   `MeshKeep telemetry alert`). Sender, channel, message text, location, identifiers,
   measurements, and rule thresholds are sensitive lock-screen content and require a
   separate explicit `Show notification details` opt-in. That opt-in must be off by
   default and reset on logout/local-data reset.
4. A notification click may focus/open MeshKeep but must not bypass login. It may
   navigate only after normal authenticated bootstrap; it must not embed credentials,
   messages, or radio data in notification payloads or URLs.
5. User-visible controls must explain the boundary: notifications in a hidden/open
   tab are best-effort; notification after termination needs future Push support and
   is not promised.

As of #75, this policy is implemented: `messageNotificationContent`/
`alertNotificationContent` in `src/notifications.ts` return generic content
(`New MeshKeep message` / `MeshKeep telemetry alert`) unless the separate
"Show notification details" opt-in (Display settings, off by default, reset on
logout and local-data reset) is on. `notificationPermissionBlocked()` is
re-checked on tab focus/visibility change (not only after this page's own
permission requests) so a mid-session browser revocation surfaces the site-settings
guidance promptly. Click routing was already confined to focusing/navigating
the already-authenticated tab via `/chat`, carrying only an internal
conversation id, never message text or credentials.

## Narrow prototype

`packages/web/public/notification-sw.js` now has two jobs — it still is **not**
a general offline/background-notification worker:

- `fetch`/`install`/`activate` handle only the versioned static-asset cache
  described above (#74). There is still **no** `push`, sync, or periodic-sync
  handler, and API/message/contact/telemetry/location data is never cached.
- `src/main.ts` registers it eagerly and unconditionally at startup (secure
  context permitting) so the cache is populated regardless of the notification
  preference. If a page-owned `Notification` constructor throws,
  `src/notifications.ts` looks up that same registration (it does not
  re-register) and calls `ServiceWorkerRegistration.showNotification()`.
- Its click behavior only focuses an existing MeshKeep window or opens `/chat`; it
  does not carry a conversation/message payload.
- If registration/display fails, receiving a MeshKeep event continues without
  surfacing an error.

This demonstrates a supported notification-display fallback path and a bounded
static-asset cache. It does **not** demonstrate iOS/Android lock-screen delivery,
terminated-app delivery, Push, background radio operation, or physical
browser/radio compatibility.

### Prototype verification

The automated notification test stubs a browser that rejects the page
`Notification` constructor and verifies the existing registration's
`showNotification()` is called. `test/sw-cache-logic.test.ts` unit-tests the
cache-eviction and cacheable-request decision logic directly (no real
ServiceWorkerGlobalScope available under vitest). The production build must
include `notification-sw.js` and `sw-cache-logic.js`; a physical secure-context
browser check remains required for platform delivery and offline behavior.

## Bounded production follow-ups

1. ~~[**PWA cache and logout-data hygiene (#74)**](https://github.com/TMASoft/meshkeep/issues/74)~~ — shipped: versioned
   static-asset cache with quota/eviction tests, browser-direct queue caps/TTL,
   and queue/CacheStorage/preference clearing on logout, disconnect
   (private-session switch included), and an explicit local-data reset. No
   message/API-response cache, per scope.
2. ~~[**Privacy-safe notifications and click routing (#75)**](https://github.com/TMASoft/meshkeep/issues/75)~~ — shipped: generic
   default notification content, a separate "Show notification details" opt-in
   (off by default, reset on logout/local-data reset), permission-revocation
   guidance re-checked on tab focus, and click routing that stays inside the
   already-authenticated tab. See `test/notifications.test.ts` for content-privacy
   and permission-state coverage.
3. [**Push delivery feasibility (#76)**](https://github.com/TMASoft/meshkeep/issues/76) — server + client code shipped (below);
   physical Chrome Android and installed iOS PWA delivery validation is still open, tracked by #77.
4. [**Browser/hardware validation matrix (#77)**](https://github.com/TMASoft/meshkeep/issues/77) — run documented secure-context tests on
   supported Chromium desktop serial/BLE hardware plus representative mobile/browser
   configurations, and update the matrix only with recorded results. The matrix
   template and required columns are in
   [docs/validation-browser-hardware-matrix-77.md](validation-browser-hardware-matrix-77.md);
   every row is currently `BLOCKED — not run` pending physical hardware.

## Push delivery (#76 prototype)

Web Push is opt-in infrastructure, off unless `MESHKEEP_VAPID_PUBLIC_KEY`,
`MESHKEEP_VAPID_PRIVATE_KEY`, and `MESHKEEP_VAPID_SUBJECT` are all set (README
configuration table). With no VAPID keys, every `/api/v1/push/*` route 404s
and the client never offers the toggle.

**Subscription lifecycle.** `POST /api/v1/push/subscribe` and
`DELETE /api/v1/push/subscribe` are session-only (`auth.sessionGuard`), like
webhook and token management — a scoped bearer token has no browser/device
identity to bind to. Each row in `push_subscriptions` (migration 18) is keyed
by `session_token_hash`, the same hash `sessions.token_hash` uses; `Auth.logout()`
deletes any subscription for that hash in the same request that deletes the
session (`packages/server/src/api/auth.ts`), and the client also calls
`unsubscribeFromPush()` before logout's reload so the browser's own
`PushSubscription` is released, not just the server's row. Only the owning
session may delete its subscription (`deletePushSubscriptionForSession`); a
different session's endpoint is left alone (`test/push-api.test.ts`).

**Delivery.** `PushWorker` (`packages/server/src/push/worker.ts`) subscribes to
the same in-process bus the webhook worker and browser WebSocket hub already
use, and reacts to `message.new` (incoming only) and `telemetry.alert`. There
is deliberately **no durable queue** — a failed send is dropped, not retried,
matching the "must not promise reliable, exactly-once, or background-radio
delivery" scope boundary. A minimum send interval per endpoint
(`MESHKEEP_PUSH_FAILURE_BURST`-adjacent but separate: `minSendIntervalMs`,
default 10s) is the "delivery rate limit" the card calls for.

**Payload privacy.** `genericPushPayload` returns exactly two fixed strings —
`New MeshKeep message` or `MeshKeep telemetry alert` (plus a non-identifying
body) — never sender, message text, contact identity, measurements, or
thresholds, regardless of the client's "Show notification details" preference
(#75), because the server has no visibility into that per-browser opt-in
anyway. `notification-sw.js`'s `push` handler only ever displays what the
server sent.

**Dead-endpoint cleanup.** A 404/410 from the push service deletes the
subscription immediately (the service has permanently discarded it, no
retries possible). Any other repeated failure deletes it after
`MESHKEEP_PUSH_FAILURE_BURST` (default 5) consecutive failures — unlike a
paused webhook, a dead push endpoint has no operator to resume it.

**Not done here:** physical Chrome Android and installed iOS PWA delivery
validation (#77), and no attempt to encrypt payloads beyond what Web Push's
own transport encryption already provides (the generic payload has nothing
sensitive to protect further).
