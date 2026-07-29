# Scoped webhooks and external event API

Design for GitHub issue #56. This document is the v1 contract; it intentionally
separates the event contract, persistent subscription state, delivery worker,
management API, UI, and operator documentation into independently releasable
cards.

## Goals and boundaries

MeshKeep already has a live, in-process `WsEvent` bus for first-party browsers.
Webhooks are a durable asynchronous projection of selected bus events, not a
replacement for that bus and not a command channel. The initial external API is
read-only. It must not grant broad SQLite, diagnostics-bundle, channel-secret,
or radio-control access.

V1 does not provide replay, guaranteed exactly-once delivery, arbitrary request
headers, client-managed certificates, or inbound webhooks. A receiver must be
prepared for duplicate delivery and fetch current state through the existing
read API when necessary.

## Versioned wire contract

Every webhook request is an HTTP `POST` with `Content-Type: application/json`
and exactly one UTF-8 JSON body. `eventVersion` is an integer owned by the
specific event type; the envelope is version 1.

```json
{
  "id": "01J...",
  "type": "message.created",
  "eventVersion": 1,
  "occurredAt": "2026-07-27T10:20:30.123Z",
  "source": { "product": "meshkeep", "apiVersion": "v1", "radioId": 7 },
  "data": {
    "message": {
      "id": 1842,
      "kind": "dm",
      "direction": "in",
      "contactKey": "…",
      "contactName": "Alice",
      "channelIdx": null,
      "channelName": null,
      "senderTimestamp": 1785166830,
      "status": "sent",
      "createdAt": 1785166830
    }
  }
}
```

`id` is a globally unique, immutable delivery-event identifier (UUIDv7 or ULID;
never a database row id). `occurredAt` is the server time at projection. All
numbers use JSON numbers; timestamps in the envelope use RFC 3339 UTC strings;
source entity timestamps preserve the established epoch-seconds API convention.
`source.radioId` is required for radio-scoped events and omitted only for a
server-global event.

### V1 taxonomy

| Category | Type | Data | Default sensitivity |
| --- | --- | --- | --- |
| message | `message.created` | message metadata; optionally `text` | metadata |
| message | `message.status_changed` | `messageId`, `status`, `previousStatus` when known | metadata |
| contact | `contact.updated` | public key, name, type, flags, route length, last-seen; no coordinates by default | metadata |
| contact | `contact.removed` | public key | metadata |
| telemetry | `telemetry.received` | local battery or parsed reading metadata/value | metadata |
| telemetry | `telemetry.alert_triggered` | persisted alert event | metadata |
| radio | `radio.link_changed` | connection state/transport/label and a redacted error code | metadata |
| radio | `radio.status_changed` | compact connection/count snapshot, not full `AppStatus` | metadata |

No event serializes `Channel.secret`, API tokens, cookies, request authorization,
raw radio frames, database paths, diagnostics/support bundles, or unredacted
connection targets. Location, contact public keys, message text, and raw sensor
readings are potentially sensitive and are never accidentally included by
serializing existing shared entities wholesale.

### Compatibility rules

1. `type` and `eventVersion` select a schema. Consumers must reject unknown
   major envelope versions and ignore unknown optional fields.
2. A V1 event may add optional fields and new enum values only when consumers
   can safely ignore them. Removing/renaming a field, changing its JSON type,
   or changing its meaning creates `eventVersion: 2` for that `type`.
3. A new type is opt-in; existing subscriptions receive it only after its
   `eventTypes` filter is updated. Wildcard subscription is deliberately not
   supported in V1.
4. The exact serialized bytes are signed. The delivery attempts of one event
   use identical bytes and the same `id`.
5. Events are at-least-once and may arrive out of order across types. Receivers
   deduplicate on `(subscriptionId, id)` for at least the configured retry
   horizon plus 24 hours; they must not treat ordering as causal truth.

## Subscription model and filtering

A subscription has: numeric `id`, user label, active/disabled state, HTTPS
`destination`, `eventTypes[]`, optional `radioIds[]`, `includeSensitive` flag,
secret key metadata, delivery policy counters, and created/updated timestamps.

Filtering is allow-list only:

* `eventTypes` is a non-empty explicit list from the taxonomy; no `*`.
* `radioIds` is absent for every radio or an explicit, de-duplicated list of
  existing stored radio IDs. A deleted radio produces no further events.
* V1 has no arbitrary JSONPath, contact, channel, regex, or predicate filters;
  those would make privacy review, query planning, and abuse limits ambiguous.
* The projection must apply filter and redaction before persisting a delivery
  row. A later subscription edit cannot reveal previously queued sensitive data.

`includeSensitive` defaults false and requires a session-authenticated explicit
confirmation on create/update. It only enables the documented fields below:

| Data | Default | Sensitive opt-in |
| --- | --- | --- |
| Message text | omitted | `message.text` |
| Coordinates | omitted | contact `lat`/`lon` |
| Full contact key | included for direct integration identity | remains included |
| Raw telemetry readings | included only as normalized label/value | no raw frame ever |

Sensitive data is not shown in delivery lists or logs. The UI must display the
consequence of enabling it and allow disabling it immediately; disabling affects
future enqueueing, not already signed/in-flight bytes.

## External read API and authorization

Existing bearer tokens retain `read` and `write` semantics for existing routes.
Token storage evolves from the current closed `read|write` enum to an explicit
scope set while preserving those two values on upgrade. Webhook administration
is session-only, as API-token administration is today. The external API adds
one read-only bearer scope:

* `events.read` — list event catalog and read delivery status for subscriptions
  owned by the server; no payload bodies or secrets.
* `webhooks.manage` — a capability represented by a browser session, not a
  bearer-token scope in V1. It can create, update, pause, resume, rotate, test,
  and revoke subscriptions.
* Existing `read` remains enough for the documented pre-existing read routes;
  V1 does not silently expand it to diagnostics bundles, token administration,
  secrets, or webhook management.

The session guards all subscription-mutating and configuration-reading routes.
`events.read` bearer tokens (and sessions) may read only the catalog and
redacted delivery summaries; they cannot list subscriptions, learn destinations,
or operate subscriptions. The initial API surface is:

* `GET /event-catalog` (`events.read` or session)
* `GET|POST /webhooks`
* `GET|PATCH|DELETE /webhooks/:id`
* `POST /webhooks/:id/rotate-secret`
* `POST /webhooks/:id/test`
* `GET /webhooks/:id/deliveries?state=&before=&limit=` (`events.read` or session;
  response excludes configuration, body bytes, and signing headers)

Creation/rotation returns a plaintext signing secret exactly once. It is never
returned by GET, diagnostics, logs, or support bundles. Delete is revocation:
it atomically disables the subscription, deletes queued deliveries, and deletes
all retained signing keys. Pause stops new enqueueing and scheduled delivery;
resume starts with future events only. Expiry is not needed in V1 because
subscriptions are server-managed and revocable.

## Signing and rotation

Each subscription receives a random 32-byte secret, presented as base64url once.
The server stores only an AEAD-encrypted secret plus `key_id`; encryption uses a
server master key from a non-tracked deployment secret (`MESHKEEP_WEBHOOK_MASTER_KEY`,
base64 32 bytes). Startup fails closed if encrypted webhook rows exist but the
key is absent or cannot decrypt them; it must not replace them with a new key.
A new install may generate no secret until the first subscription is created.

Headers:

```text
MeshKeep-Event-Id: <envelope id>
MeshKeep-Event-Type: <type>
MeshKeep-Event-Version: <integer>
MeshKeep-Delivery-Id: <delivery row id>
MeshKeep-Timestamp: <unix seconds>
MeshKeep-Key-Id: <key id>
MeshKeep-Signature: v1=<hex(HMAC-SHA256(secret, timestamp + "." + rawBody))>
```

Receivers verify the raw body with a constant-time HMAC comparison and reject a
timestamp outside five minutes. Rotation creates a new active key and retains
the old key only for 24 hours to finish already queued deliveries; new events
use the new key. The 24-hour window is enforced at signing time, not merely
recorded: past `retire_at` the old secret signs nothing. Retired keys are
hard-deleted once they are 30 days past retirement and no delivery row still
references them, so repeated rotation cannot grow the key table without bound.
Revocation/deletion removes every key immediately. Key IDs and ciphertexts are
safe metadata; plaintext secrets are not.

`POST /webhooks/:id/test` enqueues a real `webhook.test` envelope through the
normal durable queue, signed with the subscription's active key, so the operator
verifies connectivity and the shared secret end to end and sees the outcome in
the delivery history. It carries no mesh data. `webhook.test` is deliberately
absent from the subscribable event catalog — it is never matched by filters and
arrives only when an operator asks for it. Tests are limited to one per
subscription per minute and are refused for a paused or disabled subscription.

## Destination and SSRF controls

Creation and every redirect hop must pass the same validator:

* HTTPS only; no HTTP, Unix socket, file, gopher, credentials in URL, fragment,
  non-default port 443, or user-controlled headers.
* Destination hostname is canonicalized, IDNA-normalized, and resolved just
  before connect. Reject all IPv4/IPv6 loopback, link-local, multicast,
  unspecified, carrier-grade NAT, private RFC1918/ULA, IPv4-mapped private,
  and provider metadata ranges. Reject DNS answers containing any forbidden
  address; pin the validated resolved address for that connection to prevent
  DNS rebinding.
* No redirects in V1. Limit body to the signed envelope, response headers to
  32 KiB, response body discarded after 64 KiB, connect timeout 5 s, total
  request timeout 15 s. Use a dedicated outbound HTTP client with no proxy
  inherited from environment unless an explicit future proxy feature adds
  equivalent controls.
* Limit 20 active subscriptions, destination URL <= 2048 bytes, labels <= 100
  bytes, and one test delivery per subscription per minute.

## Durable queue, retry, idempotency, and retention

A transaction creates an immutable event snapshot and one delivery row per
matching active subscription. The queue is durable in SQLite; process restart
continues due jobs. A worker claims rows atomically so only one process attempt
is active per row.

Success is any `2xx`. `408`, `429`, and `5xx`, network failures, and timeouts
are retryable. Other `4xx` are terminal except a configurable future exception
list; a receiver's `Retry-After` is honored only when valid and capped. Use
full-jitter exponential backoff: `min(6h, 30s * 2^(attempt-1))`, maximum 10
attempts or 24 hours since first attempt, whichever comes first. Never retry a
terminally disabled/revoked subscription.

Global controls: maximum 10 concurrent requests, maximum one concurrent request
per subscription, 100 newly queued deliveries per subscription per minute, and
10,000 queued rows globally. When limits are exceeded, do not block radio or
browser processing: mark/enqueue a bounded `dropped` terminal record with a
redacted reason and increment counters. Do not generate a webhook about webhook
failure; that feedback loop is retry amplification.

Persisted delivery rows retain: subscription/event IDs, immutable body bytes,
attempt count, next attempt, final state, response class/status, bounded
redacted error, timestamps, and key ID. Retain completed/failed/dropped rows for
30 days; prune in bounded batches on startup and daily. Retain queued payloads
until terminal outcome; delete payloads immediately on subscription deletion.
The delivery list never returns body bytes or signing headers.

## Failure observability and operations

The server emits structured, secret-redacted logs: `webhook.enqueued`,
`webhook.delivered`, `webhook.retry_scheduled`, `webhook.failed`,
`webhook.dropped`, `webhook.expired`, `webhook.subscription_paused`,
`webhook.subscription_disabled`. Diagnostics expose counts by
state, oldest queued age, last success/failure timestamp per subscription, and
the active master-key configuration state (never its value). The admin UI shows
this state and lets a session user pause, resume, rotate, test, and inspect
redacted attempt history.

A permanent destination validation failure or a configurable burst of terminal
failures automatically pauses a subscription and records an operator-visible
reason. The two are handled differently, because only one of them is
recoverable:

* **Destination validation and signing failures** (`destination_rejected`,
  `signing_key_unavailable`) are subscription-level faults that no later event
  can survive. They **disable** the subscription immediately and drop its
  queued backlog, since replaying it would only re-fail against a bad target.
* **Receiver-side terminal failures** — a non-retryable `4xx`, or a delivery
  that exhausted its retry budget — are counted as a consecutive-failure streak
  per subscription. Reaching `MESHKEEP_WEBHOOK_FAILURE_BURST` (default 5)
  **pauses** the subscription. A pause stops new enqueueing and scheduled
  delivery but **retains** the queued backlog, so resuming from the admin UI
  drains it. A successful delivery resets the streak, as does resuming.

Queued deliveries that go unattended past the 24-hour delivery window are swept
to a terminal `expired` state in bounded batches, so an unattended pause cannot
hold rows in the queue indefinitely or consume the global queue budget.

Authentication failures are never logged with response bodies. Metrics
and logs omit destination query strings unless an operator deliberately views
the subscription configuration in the session-only UI.

## Storage and migration plan

Add ordered migrations following `packages/server/src/db/index.ts` conventions:

* `webhook_subscriptions`: configuration, normalized destination, filters JSON,
  state, sensitive opt-in, active key id, timestamps, redacted failure summary.
* `webhook_keys`: subscription FK, key ID, encrypted secret/cipher metadata,
  created/retire/delete timestamps. No plaintext/hash-only secret, because the
  service must sign future outbound bodies.
* `webhook_events`: immutable event ID/type/version/source/timestamp/body bytes
  and creation timestamp. One snapshot can serve several subscriptions.
* `webhook_deliveries`: subscription/event FKs, key ID, state, lease/attempt
  ledger, next attempt, bounded result metadata, and retention timestamps.

Add due/state, subscription/history, and retention indexes. SQLite WAL and the
existing five-second busy timeout remain sufficient only if each worker claim,
state update, and prune batch is short. Migration tests must upgrade the latest
pre-webhook schema and verify rollback guidance: restore a pre-upgrade SQLite
backup to roll back; old binaries must not run against a forward-migrated DB.

## Implementation decomposition

The cards created from this design own the following non-overlapping behavior:

1. **Contract/projection:** shared schema/types and safe conversion from the
   existing `WsEvent` bus to the v1 external envelope; no database, HTTP, or UI.
2. **Persistence/crypto:** migrations, Store repository, master-key encryption,
   retention primitives, and migration/crypto tests; no routes or network I/O.
3. **Management/auth API:** session-only `/event-catalog` and `/webhooks` CRUD,
   validation, scope enforcement, secret one-time response, and API tests; no
   worker scheduling or UI.
4. **Delivery worker:** queue enqueue/claim, signing, SSRF-safe transport,
   retry limits, result recording, and integration tests; no management UI.
5. **Admin UI/observability:** subscription form, sensitive-data confirmation,
   health/delivery views, and client tests; no server policy changes beyond
   consuming the management API.
6. **Docs/operator runbook:** configuration, receiver verification example,
   backup/restore, threat model, retention, and upgrade/rollback guidance.

Each card should run the relevant Docker-based checks because this checkout is
on `ntfs3`; do not use host npm installs/builds/typechecks.
