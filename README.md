# 🏰 MeshKeep

A self-hosted, Dockerized web client for [MeshCore](https://meshcore.co.uk) LoRa mesh networks.
Chat over your mesh from any browser, keep a persistent message history, and see the global
[map.meshcore.io](https://map.meshcore.io) node map — all served from your own home lab.

Pairs with [hll-meshkeep](https://github.com/anthropic-arroyo/hll-meshkeep), a
[home-lab-launcher](https://github.com/anthropic-arroyo/home-lab-launcher) plugin that shows
your recent mesh messages and node status on the launcher dashboard.

## Features

- **Chat** — direct messages and channels, delivery acks, unread counts, live updates over WebSocket
- **Persistent history** — messages, contacts, and telemetry stored in SQLite; survives restarts
- **Map** — global map.meshcore.io mirror (server-side cached, rate-friendly) with your local mesh overlaid
- **Device control** — node name, location, TX power, adverts, channel config
- **API tokens** — Bearer-token REST API for integrations (used by the hll-meshkeep plugin)
- **Radio anywhere** — USB serial on the server, a remote radio via ser2net/TCP, or (planned)
  browser-direct WebSerial/WebBluetooth

## Quick start (USB radio on the Docker host)

A node flashed with MeshCore **Companion (USB serial)** firmware — e.g. a RAK4631 — plugged into the server:

```sh
ls -l /dev/serial/by-id/          # find your radio's stable device path
cp docker/compose.usb.yml compose.yml
# edit compose.yml: set the devices: entry to your radio's by-id path
docker compose up -d
```

Open http://localhost:8080.

### Remote radio (ser2net / WiFi companion)

Radio plugged into a Pi elsewhere? Run ser2net there (see `docker/ser2net.yaml.example`)
and use `docker/compose.tcp.yml`. WiFi companion firmware works the same way.

### Bluetooth

Server-side BLE is planned (Linux/BlueZ hosts only — see `docker/compose.ble.yml` for the caveats).
For now, use USB or TCP for the server connection; BLE radios are best used with the
browser-direct mode (coming) or the official mobile app.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `MESHKEEP_CONNECTION` | – | `serial`, `tcp`, `ble`, or `none` |
| `MESHKEEP_SERIAL_PORT` | – | device path for `serial` |
| `MESHKEEP_TCP_HOST` / `MESHKEEP_TCP_PORT` | – / `5000` | ser2net or WiFi companion address |
| `MESHKEEP_PORT` | `8080` | HTTP listen port |
| `MESHKEEP_DATA_DIR` | `/data` | SQLite + caches |
| `MESHKEEP_UI_PASSWORD` | unset | require login when set; unset = open (LAN use) |
| `MESHKEEP_MAP_REFRESH_MINUTES` | `10` | min interval between upstream map fetches |
| `MESHKEEP_MAP_ENABLED` | `true` | set `false` to disable the global map layer |

## API

REST under `/api/v1` (see `packages/server/src/api/routes.ts`), WebSocket events at `/api/v1/ws`.
Authenticate with `Authorization: Bearer <token>` — mint tokens on the Device page.
The two endpoints the hll-meshkeep plugin consumes:

- `GET /api/v1/status` — connection state, node info, battery, counts
- `GET /api/v1/messages/recent?limit=20` — newest messages with resolved names

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

## License

MIT. Built on [@liamcottle/meshcore.js](https://github.com/meshcore-dev/meshcore.js) (MIT).
Not affiliated with MeshCore; map data © map.meshcore.io contributors.
