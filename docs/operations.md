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
