# Operations: backup, recovery, and diagnostics

MeshKeep stores everything in a single SQLite database at
`${MESHKEEP_DATA_DIR}/meshkeep.db` (default data dir `/data` in the container,
`./data` in development). The database runs in WAL mode, so alongside the main
file you will normally see `meshkeep.db-wal` and `meshkeep.db-shm`. This guide
covers backing it up, restoring it, upgrade/rollback behavior, and the health
and diagnostics surfaces.

## Deploying a published image

Releases publish a multi-arch (amd64/arm64) image to
`ghcr.io/tmasoft/meshkeep`. Every tagged release is:

- **cosign-signed** (keyless, bound to the release workflow's GitHub OIDC identity),
- shipped with an **SBOM** and **SLSA build provenance** as OCI attestations, and
- **Trivy-scanned**, with the SBOM and scan results attached to the Actions run.

### Pin an immutable reference

Tags move; digests do not. For reproducible deploys, pin by digest:

```sh
# resolve the digest behind a version tag
docker buildx imagetools inspect ghcr.io/tmasoft/meshkeep:0.1.4-beta.12 \
  --format '{{ .Manifest.Digest }}'
```

Then set `image: ghcr.io/tmasoft/meshkeep@sha256:<digest>` in your compose file.
The `:beta` tag always moves to the newest prerelease — handy for a lab, but never
pin it for anything you want to stay put.

### Verify the signature

```sh
cosign verify \
  --certificate-identity-regexp '^https://github.com/TMASoft/meshkeep/.github/workflows/release.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/tmasoft/meshkeep:0.1.4-beta.12
```

A valid signature prints the verified certificate identity. Treat a verification
failure as a supply-chain red flag — do not deploy.

### Inspect the SBOM and provenance

```sh
docker buildx imagetools inspect ghcr.io/tmasoft/meshkeep:0.1.4-beta.12 \
  --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/tmasoft/meshkeep:0.1.4-beta.12 \
  --format '{{ json .Provenance }}'
```

The release workflow also uploads `sbom.spdx.json` and `trivy-results.sarif` as
artifacts on the corresponding Actions run.

## Secrets and configuration

MeshKeep reads configuration from environment variables (see the README table).
Keep secrets out of tracked files:

- The tracked `docker/compose.*.yml` are **sanitized examples** with placeholders.
  Copy one to `compose.yml` (gitignored) — or layer a `compose.override.yml` (also
  gitignored) — and edit it for your host.
- Put secrets in a `.env` file next to your compose file. Compose auto-loads it and
  substitutes `${VAR}` references; `.env` and `docker/.env` are gitignored. Start
  from `docker/.env.example`.
- `MESHKEEP_UI_PASSWORD` gates the web UI and REST API; empty/unset = open (trusted
  LAN only). REST integrations should use scoped API tokens (Radio → API access),
  which are revocable and can be read-only.
- `MESHKEEP_WEBHOOK_MASTER_KEY` is required before creating, rotating, or delivering
  webhooks. It must be a standard-base64 encoding of exactly 32 random bytes. Generate
  it once in a secret manager (or `openssl rand -base64 32`), store it outside Git and
  the SQLite volume, and inject it through the deployment's secret facility. Losing or
  replacing this key makes existing encrypted webhook signing keys unusable; MeshKeep
  intentionally fails startup rather than silently replacing them.
- `MESHKEEP_WEBHOOK_FAILURE_BURST` (default 5) is how many consecutive terminal
  delivery failures a subscription tolerates before the worker auto-pauses it.
  A pause keeps the queued backlog, so once the receiver is healthy again press
  **Resume** in Radio → Webhook subscriptions and the backlog drains. Lower it if
  you want a broken receiver quarantined sooner; raise it for flaky receivers.
- For stronger handling, mount secrets as files via Docker/Swarm secrets or your
  orchestrator's secret store rather than passing them as environment variables.
- The diagnostics support bundle redacts secrets: the UI password is reported only
  as `uiPasswordSet: true|false`, and secret-shaped log fields are masked.

## Health and readiness probes

Two unauthenticated probes live outside the versioned API:

| Endpoint | Meaning | Use for |
| --- | --- | --- |
| `GET /api/healthz` | **Liveness** — the process is up and serving. Never touches the radio or scans the database. | Container/orchestrator liveness. A disconnected radio does **not** fail this. |
| `GET /api/readyz` | **Readiness** — storage responds and the schema is fully migrated. Returns `503` while migrations are mid-flight or the database is unreachable. | Load-balancer/orchestrator readiness gating. |

Example readiness gate in `docker-compose`:

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://localhost:8080/api/readyz"]
  interval: 30s
  timeout: 5s
  retries: 3
```

## Diagnostics and support bundle

- **Diagnostics page** — the **Health** tab in the UI shows transport, reconnect,
  firmware, radio, database, and map diagnostics plus actionable guidance. It
  contains no message content or secrets.
- `GET /api/v1/diagnostics` — the same data as JSON (any authenticated client).
- `GET /api/v1/diagnostics/bundle` — a downloadable support bundle
  (diagnostics + effective configuration + recent structured logs). **Session-only**:
  an API token cannot fetch it. The UI password is redacted (reported only as
  `uiPasswordSet: true|false`) and secret-shaped log fields are masked. Attach
  this to a bug report.
- `GET /api/v1/diagnostics/logs` — recent redacted structured events for the
  Diagnostics page. This is also **session-only**; bearer tokens are refused.
  The page displays the latest 100 entries and supports manual refresh.

Set `MESHKEEP_LOG_LEVEL` (`debug`/`info`/`warn`/`error`, default `info`) to
control how much is written to stdout. The in-memory ring buffer that feeds the
bundle always retains the most recent ~500 entries regardless of level.

## Backup

WAL mode means a plain `cp` of `meshkeep.db` alone can miss committed data still
in the `-wal` file. Use one of these instead:

1. **Online backup (recommended, no downtime).** Uses SQLite's backup API, which
   is consistent against a live writer:

   ```sh
   sqlite3 "${MESHKEEP_DATA_DIR}/meshkeep.db" ".backup '/backups/meshkeep-$(date +%F).db'"
   ```

2. **`VACUUM INTO` (consistent, also compacts):**

   ```sh
   sqlite3 "${MESHKEEP_DATA_DIR}/meshkeep.db" "VACUUM INTO '/backups/meshkeep-$(date +%F).db'"
   ```

3. **Cold copy (stopped server).** Stop MeshKeep so WAL is checkpointed on clean
   shutdown, then copy `meshkeep.db` (and any residual `-wal`/`-shm`).

Back up to a different filesystem and verify a restore periodically (see below).

## Restore

1. Stop MeshKeep.
2. Replace `meshkeep.db` with the backup and remove any stale sidecars:
   ```sh
   rm -f "${MESHKEEP_DATA_DIR}"/meshkeep.db-wal "${MESHKEEP_DATA_DIR}"/meshkeep.db-shm
   cp /backups/meshkeep-YYYY-MM-DD.db "${MESHKEEP_DATA_DIR}/meshkeep.db"
   ```
3. Verify the copy before starting:
   ```sh
   sqlite3 "${MESHKEEP_DATA_DIR}/meshkeep.db" "PRAGMA integrity_check;"   # expect: ok
   ```
4. Start MeshKeep. Confirm `GET /api/readyz` returns `200` and the Health page
   shows `integrity: ok` and the expected schema version.

## Migrations, upgrades, and rollback

- Migrations are numbered and applied **in a transaction each**, re-checking
  `PRAGMA user_version` inside every transaction before applying a step. This
  makes simultaneous container starts safe: a process skips a step another
  process already committed. An interrupted upgrade leaves `user_version` at
  the last fully-applied step; the next start re-runs from there. `readyz` stays
  `503` until `user_version` equals the build's latest migration.
- **Forward compatibility:** a newer build applies any missing migrations on
  start. No manual step is required.
- **Rollback is not automatic.** Migrations have no down-scripts, so a database
  written by a newer build may contain schema an older build does not expect.
  To roll back to an older MeshKeep version, **restore the pre-upgrade backup**.
  Always take a backup before upgrading across a schema change.
- Check the current vs. latest schema version any time on the Health page or via
  `GET /api/v1/diagnostics` (`database.schemaVersion` / `database.latestSchemaVersion`).
- **Migration 9 (outbound retry queue)** is additive: it creates the `outbound_queue`
  table and touches no existing table or row, so upgrading is safe and rolling back to a
  pre-9 build simply ignores the new table. On downgrade, any messages still queued
  (status `pending`/`retrying`) revert to plain `pending` rows with no automatic retry.

## Outbound message queue

Outbound sends are persisted in `outbound_queue` and delivered by a background worker, so a
send survives a radio that is briefly offline. A message is `pending` until handed to the
radio, then follows the normal `sent → delivered` (ack) path. If the hand-off fails the
worker retries with exponential backoff (`retrying`), giving up after
`MESHKEEP_OUTBOUND_MAX_ATTEMPTS` (default 5) and marking the message `failed`. A radio that
is simply offline keeps the message `pending` and does **not** burn an attempt — it delivers
on reconnect. Operators/users can requeue a failed send (`POST /api/v1/messages/:id/retry`)
or drop it (`POST /api/v1/messages/:id/cancel`); `GET /api/v1/messages/outbound` shows the
current ledger. While the server radio is in **standby** (released to a browser session),
the server rejects sends rather than queuing them — send from the browser session instead.

## Webhooks and external events

MeshKeep webhooks are an outbound, asynchronous projection of selected application events.
They are not an inbound command API and they do not expose the database, radio control,
diagnostics bundle, API tokens, channel secrets, raw radio frames, or browser sessions.

### Before enabling webhooks

1. Require a UI password and serve the instance behind HTTPS. Webhook administration is
   browser-session-only, but an open MeshKeep instance has no meaningful administrative
   boundary.
2. Generate and deploy `MESHKEEP_WEBHOOK_MASTER_KEY` as a durable deployment secret:
   ```sh
   openssl rand -base64 32
   ```
   Keep the same value for every restart and preserve it with the database backup plan.
   Do not put it in a tracked Compose file, browser configuration, API token, or support
   bundle.
3. In **Radio → API access → Webhook subscriptions**, select explicit event types and,
   where needed, explicit stored radios. An empty radio filter means every radio. Wildcard
   event filters are not supported. A subscription needs at least one event type.
4. Use a public HTTPS receiver. MeshKeep accepts an HTTPS hostname on port 443 only;
   destinations with credentials, fragments, an explicit port, or a literal IP address
   are rejected. At delivery time it resolves the hostname and rejects loopback, private,
   link-local, multicast, unspecified, carrier-grade NAT, and provider-metadata address
   ranges. Redirects are not followed. This is intentional SSRF protection, not a proxy
   configuration feature.

At most 20 subscriptions can be active. A destination is limited to 2,048 bytes and a
label to 100 characters. MeshKeep sends only its own fixed request headers; receivers
that require a custom header, a private address, an HTTP endpoint, mutual TLS, or a proxy
are not supported by v1.

### Event contract and sensitive fields

Every request is a JSON `POST` with this stable envelope shape:

```json
{
  "id": "globally-unique-event-id",
  "type": "message.created",
  "eventVersion": 1,
  "occurredAt": "2026-07-29T12:34:56.789Z",
  "source": { "product": "meshkeep", "apiVersion": "v1", "radioId": 7 },
  "data": {}
}
```

`type` plus `eventVersion` selects the schema. V1 emits these explicit types:

| Type | Data summary | Sensitive opt-in effect |
| --- | --- | --- |
| `message.created` | message metadata and delivery status | adds `data.message.text` |
| `message.status_changed` | message ID and status | none |
| `contact.updated` | contact identity/metadata | adds `data.contact.lat` and `lon` |
| `contact.removed` | contact public key | none |
| `telemetry.received` | battery millivolts and timestamp | none |
| `telemetry.alert_triggered` | normalized persisted alert fields | none |
| `radio.link_changed` | link state, transport, label, redacted error code | none |
| `radio.status_changed` | compact radio state and counts | none |

New event types require an explicit subscription update. Existing V1 schemas may gain
optional fields or enum values; consumers must ignore fields they do not recognize. A
removed field, changed JSON type, or changed meaning requires a new `eventVersion` for
that event type. Do not deserialize MeshKeep payloads into a permissive internal model
and assume event ordering represents causality.

Message text and contact coordinates are sensitive. They are omitted by default and
require the `includeSensitive` confirmation in the UI or `confirmSensitive: true` in a
session-authenticated API request. Enabling it affects newly projected events only; a
previously queued, signed payload is immutable. Delivery history, diagnostics, and logs
remain redacted and do not expose bodies or signing secrets.

### Subscription API and example

All paths below are rooted at `/api/v1`. Creating, listing, editing, rotating, pausing,
resuming, testing, and deleting subscriptions requires the browser session cookie. The
only bearer scope for this feature is `events.read`, which can read the catalog and
redacted delivery summaries but cannot manage subscriptions.

```sh
# Establish a browser-equivalent session. Keep the cookie jar private.
curl -c meshkeep.cookies -X POST https://meshkeep.example/api/v1/auth/login \
  -H 'content-type: application/json' \
  --data '{"password":"replace-with-your-ui-password"}'

# Create a minimal, non-sensitive subscription. The signingSecret is shown only here.
curl -b meshkeep.cookies -X POST https://meshkeep.example/api/v1/webhooks \
  -H 'content-type: application/json' \
  --data '{
    "label":"Home automation receiver",
    "destination":"https://receiver.example/webhooks/meshkeep",
    "eventTypes":["telemetry.alert_triggered","radio.link_changed"],
    "radioIds":[7],
    "includeSensitive":false
  }'
```

Store `signingSecret` immediately in the receiver's secret store; it is base64url-encoded
32 random bytes and is not returned by later `GET` responses. The management surface is:

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /event-catalog` | session or `events.read` | available event type names |
| `GET`, `POST /webhooks` | session | list/create subscriptions |
| `GET`, `PATCH`, `DELETE /webhooks/:id` | session | inspect, edit/pause/resume, or revoke a subscription |
| `POST /webhooks/:id/rotate-secret` | session | create and reveal a replacement secret once |
| `POST /webhooks/:id/test` | session | validate the subscription command and return `202` |
| `GET /webhooks/:id/deliveries?state=&before=&limit=` | session or `events.read` | redacted attempt history; `limit` is 1–100 (default 50) |

The current test command returns `202 Accepted` but does not force an outbound HTTP
request. Validate receiver connectivity by creating a scoped subscription and observing a
real matching event in its delivery history.

### Verify webhook signatures against raw bytes

MeshKeep signs the exact UTF-8 JSON bytes it sends. Do not parse and re-serialize JSON
before verification. Requests include these headers (HTTP header names are case-insensitive):

```text
MeshKeep-Event-Id: <envelope id>
MeshKeep-Event-Type: <type>
MeshKeep-Event-Version: 1
MeshKeep-Delivery-Id: <attempt id>
MeshKeep-Timestamp: <unix seconds>
MeshKeep-Key-Id: <key id>
MeshKeep-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
```

Example receiver logic in Python; obtain `raw_body` before any JSON middleware consumes
or alters it:

```python
import hashlib
import hmac
import time

def verify_meshkeep(headers: dict[str, str], raw_body: bytes, secret: bytes) -> None:
    timestamp = int(headers["MeshKeep-Timestamp"])
    if abs(time.time() - timestamp) > 300:
        raise ValueError("stale webhook timestamp")
    signed = str(timestamp).encode("ascii") + b"." + raw_body
    expected = "v1=" + hmac.new(secret, signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(headers["MeshKeep-Signature"], expected):
        raise ValueError("invalid webhook signature")
```

Then parse `raw_body`, validate `type` and `eventVersion`, and deduplicate on the
subscription ID plus `MeshKeep-Event-Id`. Delivery is at least once: retries reuse the
same immutable bytes and event ID, and events can arrive out of order across types. Keep
deduplication state for at least the retry horizon plus one day.

### Delivery policy and monitoring

Success is any `2xx`. Network errors, timeouts, `408`, `429`, and `5xx` responses are
retryable; other `4xx` responses are terminal. Retry timing uses full-jitter exponential
backoff up to six hours and honors a valid, capped `Retry-After`. A delivery is bounded by
10 attempts or 24 hours from its first attempt. A terminal policy failure disables the
subscription and marks queued/leased deliveries as dropped; explicitly resume it only
after correcting the receiver or destination.

The queue is durable in SQLite and survives process restarts. It permits at most 10
concurrent outbound requests, one per subscription, 100 new deliveries per subscription
per minute, and 10,000 queued/leased deliveries globally. When an enqueue limit is hit,
MeshKeep records a redacted `dropped` result rather than slowing radio/browser processing.
Completed, failed, and dropped delivery records are retained for 30 days. Payloads and
signing headers are never returned in delivery history.

Monitor stdout and the UI's **Activity** view for the structured events
`webhook.enqueued`, `webhook.delivered`, `webhook.retry_scheduled`, `webhook.failed`,
`webhook.dropped`, and `webhook.subscription_disabled`. Investigate increasing queued age,
retries, failures, or dropped records. Treat a sudden stream of `4xx`/terminal failures as
an integration or credential incident, not a condition to blindly retry.

### Rotation, backup, upgrade, rollback, and incident response

- **Routine rotation:** use **Rotate secret**, store the newly displayed secret, and keep
  the receiver able to validate delivery records that reference the prior key until their
  history is terminal. New events use the new key. Do not log either secret.
- **Immediate compromise or wrong destination:** delete the subscription. Deletion removes
  queued deliveries and all signing keys. If continued delivery is needed, create a new
  subscription with a new destination/secret after the incident is contained. Pausing is
  not revocation: it preserves the configuration and can be resumed.
- **Back up before upgrading:** use the SQLite online-backup procedure above and back up
  the deployment's webhook master key through its secret manager. Webhook migrations are
  forward-only; rollback means restore the pre-upgrade database backup *and* deploy the
  matching saved master key. Never run an older binary against a forward-migrated database.
- **Lost master key:** do not replace it in place and hope existing webhooks recover.
  Restore the paired database/key backup, or treat the subscriptions as unrecoverable,
  remove them under an authorized recovery process, and recreate them with new secrets.

## Integrity and recovery

- `PRAGMA integrity_check;` (also surfaced in diagnostics) reports `ok` for a
  healthy database; anything else indicates corruption — restore from backup.
- `PRAGMA foreign_key_check;` should return no rows; violations are counted in
  diagnostics as `foreignKeyViolations`.
- To recover a corrupt database when no backup exists, dump and reload:
  ```sh
  sqlite3 corrupt.db ".recover" | sqlite3 recovered.db
  ```
  then restore `recovered.db` using the steps above.

## Write contention

SQLite allows one writer at a time. MeshKeep opens the database with
`busy_timeout = 5000`, so a write waits up to 5 seconds for a competing writer
(for example an external backup or the `sqlite3` CLI holding a lock) before
failing, rather than erroring immediately. WAL mode lets readers proceed without
blocking the writer. Keep external tools' transactions short, and prefer the
online-backup command above, which cooperates with the running server.
