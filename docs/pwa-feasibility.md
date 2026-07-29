# PWA, offline, and background-notification feasibility (#54)

## Decision

Do **not** describe MeshKeep as an offline-first or background-notification-capable
PWA yet. The supported baseline remains a connected browser client. Browser-direct
radio operation is an interactive, Chromium-family feature; it is not a background
transport. This repository contains only a narrow service-worker notification-display
fallback prototype, with no fetch handler, app cache, Push subscription, or background
WebSocket.

The distinction matters: service workers are event-driven and may be stopped while
idle. They do not keep a WebSerial/WebBLE connection or a WebSocket alive. A future
Push service could wake a worker for an event, but it requires a server-side push
subscription and delivery path that do not exist in MeshKeep today.

## Platform and capability matrix

| Capability                                    | Chromium desktop (HTTPS/localhost)                                            | Chromium Android                                                 | Firefox desktop/Android                    | Safari macOS/iOS                                   | MeshKeep support statement                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| WebSerial                                     | Secure-context, user-picker API; MeshKeep's supported browser-direct target   | Do not claim support without a device validation run             | Not a supported target                     | Not a supported target                             | Chromium desktop only, with an interactive user gesture and radio chooser |
| WebBluetooth (BLE)                            | Secure-context, experimental user-picker API; validate adapter/radio firmware | Do not claim support without a device validation run             | Not a supported target                     | Not a supported target                             | Chromium desktop only, experimental; no background connection guarantee   |
| Service worker registration                   | Expected in a secure context                                                  | Expected in a secure context                                     | Expected in a secure context               | Expected in a secure context                       | Best-effort enhancement only; browser/OS can stop it                      |
| Notification display while app is open/hidden | Available after explicit permission; page API is current implementation       | Page constructor can be restricted; worker display is prototyped | Available only if platform/browser permits | Available only if platform/browser permits         | Permission-gated and best-effort; not delivery-guaranteed                 |
| Push when no MeshKeep tab is running          | Requires future subscription, application server, and push provider           | Same                                                             | Same                                       | Same, plus platform install/permission constraints | Not implemented; never promise it                                         |
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

MeshKeep has no service-worker fetch/cache handler and therefore does not cache the
application shell or API responses for offline use. The browser-direct source has a
small IndexedDB `meshkeep` / `ingest-queue` queue for failed non-private ingest
sync-backs. It currently has no byte/count/age limit and must not be presented as an
offline archive. The only other browser persistence used by this feature is local
preferences such as notification mode.

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

The existing page notification implementation exposes sender/body text when the user
selects DMs or all. That is retained for this feasibility prototype only and is a
blocking privacy gap for a production background-notification release.

## Narrow prototype

`packages/web/public/notification-sw.js` is deliberately not a PWA worker:

- It has **no** `fetch`, `push`, cache, sync, or periodic-sync handler.
- If a page-owned `Notification` constructor throws, `src/notifications.ts` registers
  `/notification-sw.js` and calls `ServiceWorkerRegistration.showNotification()`.
- Its click behavior only focuses an existing MeshKeep window or opens `/chat`; it
  does not carry a conversation/message payload.
- It is not registered until this fallback is needed. If registration/display fails,
  receiving a MeshKeep event continues without surfacing an error.

This demonstrates a supported notification-display fallback path. It does **not**
demonstrate iOS/Android lock-screen delivery, terminated-app delivery, Push,
background radio operation, cache safety, or physical browser/radio compatibility.

### Prototype verification

The automated test stubs a browser that rejects the page `Notification` constructor
and verifies registration of `/notification-sw.js` followed by
`showNotification()`. The production build must include the static worker at
`notification-sw.js`; a physical secure-context browser check remains required for
platform delivery behavior.

## Bounded production follow-ups

1. [**PWA cache and logout-data hygiene (#74)**](https://github.com/TMASoft/meshkeep/issues/74) — design a versioned static-asset cache only;
   implement cache quota/eviction, browser-direct queue caps/TTL, and clear the queue,
   CacheStorage, and relevant preferences on logout/disconnect. Add quota and
   invalidation tests. No message/API-response cache in scope.
2. [**Privacy-safe notifications and click routing (#75)**](https://github.com/TMASoft/meshkeep/issues/75) — replace detailed default
   notification text with generic content, add a separate details opt-in and revocation
   handling, and carry a non-sensitive click token through authenticated bootstrap.
   Include accessibility and lock-screen privacy tests.
3. [**Push delivery feasibility (#76)**](https://github.com/TMASoft/meshkeep/issues/76) — separately prototype VAPID/subscription lifecycle,
   authenticated server storage, endpoint revocation, rate limits, payload encryption
   or generic payloads, and physical Chrome Android + installed iOS PWA validation.
   This card must explicitly define delivery failure semantics; it must not promise
   exactly-once or guaranteed delivery.
4. [**Browser/hardware validation matrix (#77)**](https://github.com/TMASoft/meshkeep/issues/77) — run documented secure-context tests on
   supported Chromium desktop serial/BLE hardware plus representative mobile/browser
   configurations, and update the matrix only with recorded results.
