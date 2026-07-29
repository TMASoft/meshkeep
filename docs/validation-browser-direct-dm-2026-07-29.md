# Browser-direct DM delivery validation attempt — 2026-07-29

This is a timestamped execution record for the browser-direct delivery scenarios
in [validation.md](validation.md): WebSerial DM/delivery sync, private-session
isolation, offline sync recovery, hand-back to the server, and WebBLE DM delivery.
It is **not a pass record**. No disposable message was sent and no radio ownership,
service state, browser permissions, pairing, or RF configuration was changed.

## Scope and result

| Scenario | Result | Reason |
| --- | --- | --- |
| WebSerial: DM round trip and delivery ticks/sync-back | BLOCKED | No human-operated Chromium session and no confirmed independent RF peer were available. |
| WebSerial: private-session server-history isolation | BLOCKED | Requires the same interactive browser client and disposable DM exchange. |
| WebSerial: stop-server/offline queue/restart recovery | BLOCKED | Requires an interactive browser session plus an approved service interruption; the current serial deployment was healthy and was not disrupted. |
| WebSerial: disconnect and hand back to server | BLOCKED | Requires an interactive browser to claim/release the live server-owned radio. It was deliberately not taken from the healthy service. |
| WebBLE: pair, DM round trip, reconnect without stale session | BLOCKED | The bonded BLE candidate was disconnected; its physical identity, firmware, PIN, RSSI, and independent RF peer status were not confirmed. No physical Chromium client was available. |

No defect is recorded: the prerequisites for each end-to-end scenario were absent.

## Observed topology and versions

Observed at `2026-07-29T10:15:19Z` (UTC):

```text
MeshKeep 0.1.4-beta.20 container ── USB serial ── RAK4631 / MCTA-PC2 (radio A)
       │
       └── BlueZ bonded, disconnected ── MeshCore-MCTA-Rak (potential radio B)
```

| Component | Observed state |
| --- | --- |
| Host | Linux `7.0.12-arch1-1`; current validation user is in the `uucp` group. |
| Deployment | `ghcr.io/tmasoft/meshkeep:0.1.4-beta.20`, Docker Compose service up and healthy for 47 hours; `GET /api/healthz` returned HTTP 200 with version `0.1.4-beta.20`. |
| Radio A | RAKwireless RAK4631 / `MCTA-PC2`; serial target `/dev/serial/by-id/usb-RAKwireless_WisCore_RAK4631_Board_1A4B73E9CAD23CEC-if00`; server reported `connected` over `serial`. Firmware: `RAK 4631 v1.16.0-07a3ca9`, protocol 13, build `06-Jun-2026`. RF: 910525 kHz, 62500 Hz, SF7, CR5, 22 dBm. |
| Potential radio B | BlueZ `MeshCore-MCTA-Rak` at `E5:01:46:20:3C:CB`; paired, bonded, trusted, and **not connected**. It exposes Nordic UART Service. Model, firmware, PIN, RSSI, physical availability, and RF parity remain unconfirmed. |
| Browser availability | `/usr/bin/brave` and Firefox existed. No active Brave/Chromium physical-client session was available; a running Firefox session cannot provide the required WebSerial/WebBluetooth flow. |
| Peer and evidence operator | No confirmed second RF peer, phone/laptop operator, test-message workflow, or approved screenshot/evidence location was available. |

## Timestamped execution steps

1. `2026-07-29T10:15:04Z` — inspected local device availability. The only serial device was `/dev/ttyACM0`, identified by USB as an Adafruit WisCore RAK4631 board. BlueZ reported the `MeshCore-MCTA-Rak` candidate but did not report it connected.
2. `2026-07-29T10:15:19Z` — captured read-only deployment preflight from `http://localhost:8080`: `/api/healthz`, `/api/v1/status`, and `/api/v1/diagnostics`. The service was healthy; its active link was the server-owned serial radio A. Database diagnostics were healthy (`integrity: ok`, schema `14/14`), with no reconnect scheduled.
3. `2026-07-29T10:15:19Z` — queried `bluetoothctl info E5:01:46:20:3C:CB`; the candidate was paired/bonded/trusted but disconnected.
4. `2026-07-29T10:15:37Z` — preserved hashes of the six raw HTTP response/header files in a local temporary evidence bundle. No response bodies are reproduced here because they include operational radio/contact metadata.
5. `2026-07-29T10:15:37Z` — did **not** launch or automate a browser radio chooser, claim radio A, pair radio B, send a DM, stop/restart the service, or alter permissions. Those actions need a physical user, a separate confirmed RF peer, and an approved interruption plan.

## Reproducible preflight evidence

The timestamped HTTP responses were captured from the exact endpoints above. SHA-256:

```text
351707ef86b6517223a6537a6bb0aa6bb38a0b3b94e102fe58f984c03a64be07  meshkeep-health.json
05b6304133d734c6f577ddbc7df1266c3a77f36aeb3144c01852baf5e3737d2a  meshkeep-status.json
af91498585c058793dfb56a644d568116ac7d0065078d38bb68063909eb92551  meshkeep-diag.json
fdfd9450d8f563b79331b09157f5dbe291ad7cd632447163e5f8b1dcf708b460  meshkeep-status.headers
6c51f08f8777a1f5c365c268ced9fdec0255fe40d38e7208b81f8c60c8c78f3d  meshkeep-diag.headers
16f64e20d376ce1377dee16f571bf7302e0048c938cc165de3a5fb256c6177a1  meshkeep-health.headers
```

This is preflight evidence only; it does not prove browser-direct delivery.

## Required continuation inputs

1. A named operator with a visible, human-operated Chromium/Brave client and a redacted screenshot/log storage location.
2. A confirmed independent RF peer with model, firmware/build, matching RF settings, and a disposable DM contact/workflow.
3. For WebBLE: a confirmed BLE radio identity, its console-provided PIN, RSSI better than approximately -80 dBm, and a separate RF peer.
4. Approval and a recovery owner for the intentional server stop/restart during the non-private offline-queue scenario.
5. Permission to claim radio A from the server and then verify the server's fresh serial reconnection after browser hand-back.

Until those inputs exist, the browser-direct DM scenarios in `docs/validation.md` remain unchecked and issue #15 must remain open.
