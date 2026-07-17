# MeshKeep

A self-hosted, Dockerized web client for [MeshCore](https://meshcore.co.uk) LoRa mesh networks.
Chat over your mesh from any browser, keep a persistent message history, and see the global
[map.meshcore.io](https://map.meshcore.io) node map — all served from your own home lab.

Pairs with [hll-meshkeep](https://github.com/TMASoft/hll-meshkeep), a
[home-lab-launcher](https://github.com/TMASoft/home-lab-launcher) plugin that shows
your recent mesh messages and node status on the launcher dashboard.

## Features

- **Responsive interface** — field-ready desktop and mobile layouts with light/dark themes and adjustable density
- **Comms** — direct messages and channels, delivery acks, unread counts, live updates over WebSocket
- **Channels** — create, join (paste a shared key), and edit encrypted group channels in-app
- **Room servers & repeaters** — password login, room posts, repeater status readout, and a
  remote CLI console (message a repeater to send CLI commands, like the official app)
- **Persistent history** — messages, contacts, and telemetry stored in SQLite; survives restarts
- **Contact sharing** — copy/import `meshcore://` contact links; remove contacts and reset routes
- **Network map** — global map.meshcore.io mirror (server-side cached, rate-friendly) with your local mesh overlaid
- **Radio control** — node identity, RF parameters (freq/BW/SF/CR), location, TX power, adverts,
  battery history chart, connection ownership, and in-app connection settings
- **Message export** — download full or per-conversation history as CSV/JSON
- **Access control** — optional password login plus Bearer-token REST API for integrations
  (used by the hll-meshkeep plugin)
- **Radio anywhere** — USB serial on the server, a remote radio via ser2net/TCP, experimental
  server-side BLE, or **browser-direct**: drive a radio attached to the device you're browsing
  from (WebSerial/WebBluetooth, Chromium + HTTPS/localhost — see `docs/https.md`), with
  history synced back to the server or kept private to the session

## Quick start (USB radio on the Docker host)

A node flashed with MeshCore **Companion (USB serial)** firmware — e.g. a RAK4631 — plugged into the server:

```sh
ls -l /dev/serial/by-id/          # find your radio's stable device path
cp docker/compose.usb.yml compose.yml
# edit compose.yml: set the devices entry and group_add GID for this host
docker compose up -d
```

Open http://localhost:8080.

The container runs as a non-root user. Set `group_add` to the numeric group that owns the
serial device on the Docker host:

```sh
stat -c '%g' /dev/serial/by-id/usb-your-radio
```

Both values are host-specific — the checked-in file ships placeholders.

## Interface

- **Comms** contains channels and direct-message contacts. On phones, selecting a conversation
  opens a dedicated thread; use the back control to return to the conversation list. The ⓘ
  control in a thread shows contact details with share-link, route-reset, CSV-export, and
  remove actions; the + control above **Contacts** imports a `meshcore://` link, and the +
  above **Channels** creates or joins a channel (pick a slot, name it, and generate a fresh
  secret or paste one you were given — copy a channel's secret from its ⓘ panel to invite
  others). For room servers and repeaters, ⓘ also holds the password login and a live
  status readout; messages you type to a **repeater** are sent as remote CLI commands.
- **Network** plots this node and positioned contacts over the cached global MeshCore map.
- **Radio** shows companion hardware and link status, edits node settings and RF parameters,
  charts battery history, sends adverts, shares this node as a `meshcore://` link, edits the
  radio connection, releases or claims the radio, manages API tokens, and exports history.
  **Radio source** switches between the server's radio and one attached to this browser
  (WebSerial/WebBLE); browser sessions sync traffic back to the server unless marked private,
  and queue the sync in IndexedDB while the server is unreachable.
- **Display settings** are available from the gear control in the desktop rail or mobile header.
  Theme (`system`, `dark`, or `light`) and density (`comfortable` or `compact`) are saved in
  the current browser.

In Comms, `Enter` sends a message and `Shift+Enter` inserts a line break.

### Remote radio (ser2net / WiFi companion)

Radio plugged into a Pi elsewhere? Run ser2net there (see `docker/ser2net.yaml.example`)
and use `docker/compose.tcp.yml`. WiFi companion firmware works the same way.

### Bluetooth (experimental)

Server-side BLE works on Linux/BlueZ hosts only, over the host's D-Bus socket — see
`docker/compose.ble.yml`. Pair the radio once on the host with `bluetoothctl` first
(companion BLE firmware defaults to PIN `123456`); the container reuses the bond.
Pairing needs a solid signal (RSSI better than about −80 dBm) — connections die before
the PIN prompt on marginal links. USB and TCP remain the recommended server transports;
a BLE radio near your *browsing* device is often better served by browser-direct WebBLE.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `MESHKEEP_CONNECTION` | – | `serial`, `tcp`, `ble` (experimental), or `none` |
| `MESHKEEP_SERIAL_PORT` | – | device path for `serial` |
| `MESHKEEP_TCP_HOST` / `MESHKEEP_TCP_PORT` | – / `5000` | ser2net or WiFi companion address |
| `MESHKEEP_BLE_ADDRESS` | – | radio MAC address for `ble` |
| `MESHKEEP_PORT` | `8080` | HTTP listen port |
| `MESHKEEP_DATA_DIR` | `/data` | SQLite + caches |
| `MESHKEEP_UI_PASSWORD` | unset | require login when set; unset = open (LAN use) |
| `MESHKEEP_TELEMETRY_RETENTION_DAYS` | `30` | trim battery telemetry older than this |
| `MESHKEEP_MAP_REFRESH_MINUTES` | `10` | min interval between upstream map fetches |
| `MESHKEEP_MAP_ENABLED` | `true` | set `false` to disable the global map layer |
| `MESHKEEP_LOG_LEVEL` | `info` | stdout log verbosity: `debug`, `info`, `warn`, `error` |

Connection settings can also be changed at runtime from Radio → Connection; a saved
override wins over the environment until you reset it. The form detects candidate
hardware for you: plugged-in USB radios are listed by name (with a free-text escape
hatch for unusual boards), and a BLE scan lists nearby radios with signal strength
and pairing state.

Docker caveat: inside a container, serial detection only sees devices mapped in with
`devices:`, and naming them needs the host udev database mounted read-only
(`/run/udev:/run/udev:ro`, included in `docker/compose.usb.yml`); without it the form
degrades to manual entry. BLE scanning works through the same D-Bus socket mount that
the BLE connection uses (`docker/compose.ble.yml`); without that mount the scan
reports BLE as unavailable.

## API

REST under `/api/v1` (see `packages/server/src/api/routes.ts`), WebSocket events at `/api/v1/ws`.
Authenticate with `Authorization: Bearer <token>` — mint tokens in Radio → API access.
The two endpoints the hll-meshkeep plugin consumes:

- `GET /api/v1/status` — connection state, node info, battery, counts
- `GET /api/v1/messages/recent?limit=20` — newest messages with resolved names
- `GET /api/v1/messages/unknown-senders` — latest message for each unresolved DM sender prefix; use `sender=<prefix>` on message history, search, export, and read routes to access its conversation
- `POST /api/v1/ingest/messages` — browser-direct sync records require a UUID `ingestionId`; retry the same record with the same ID, and use a new ID for an intentional repeat. The response and `message.new` event include that ID so offline browser rows can be replaced by their server IDs without losing a delivered or failed status.

## Development

```sh
npm install
npm run mock-radio     # terminal 1: fake companion radio on TCP :5100
npm run dev:mock       # terminal 2: server (port 8080) wired to the mock
npm run dev:web        # terminal 3: vite dev server on :5173 (proxies /api)
```

The mock radio echoes DMs and channel messages back; type `dm Mock Alice hello`
or `ch 0 hello` into its terminal to inject unsolicited traffic.

```sh
npm test               # integration suite runs the full stack against the mock radio
npm run typecheck
```

With a real radio: `MESHKEEP_CONNECTION=serial MESHKEEP_SERIAL_PORT=/dev/ttyACM0 npm run dev`.

## Operations

- Liveness `GET /api/healthz`, readiness `GET /api/readyz` (503 until the schema
  is migrated) — both outside the authenticated API for orchestrator probes.
- The **Health** tab (and `GET /api/v1/diagnostics`) shows transport, firmware,
  database, and map diagnostics; download a redacted support bundle from there.
- Backup, restore, upgrade/rollback, integrity checks, and write-contention
  behavior are documented in [`docs/operations.md`](docs/operations.md).

## License

MIT. Built on [@liamcottle/meshcore.js](https://github.com/meshcore-dev/meshcore.js) (MIT).
Not affiliated with MeshCore; map data © map.meshcore.io contributors.
