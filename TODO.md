# MeshKeep TODO

## Validation session runbook (hardware day)

Ordered to minimize replug/reflash churn — serial soak starts first and runs in
the background for the whole session:

1. `docker compose up -d` (compose.yml pulls `ghcr.io/tmasoft/meshkeep:beta`);
   `curl localhost:8080/api/healthz` should report the current beta. Start the soak log:
   `./scripts/soak-check.sh &` — leave it running 24h (unplug/replug the radio once
   mid-soak to cover the reconnect item).
2. Mint an API token (Radio → API access) → configure the launcher's meshkeep plugin
   (v0.1.1, install from GitHub) → dashboard shows messages + unread badge.
3. Map page: global nodes load, own node + positioned contacts overlaid.
4. RF params round-trip on real firmware (remember: firmware reports kHz).
5. meshcore:// contact import from the phone app; export to it.
6. Login flow: uncomment MESHKEEP_UI_PASSWORD in compose.yml, `docker compose up -d`,
   verify the login gate + that the API token still works for the plugin. Revert after.
7. Browser-direct WebSerial per docs/https.md "Validation-session quick start".
8. BLE trio: server BLE reconnect after radio power-cycle; DM round-trip over the BLE
   server link; browser-direct WebBLE from a phone/laptop.
9. Real room/repeater: repeater login + status + CLI from the composer; join/post to a
   real room server; create a channel the phone app can join from the copied secret.
10. Hardware check of the parity items: telemetry request from a real node, signed post
    attribution in a real room, channel delete on real firmware.

Review the soak afterwards: `grep -v 'state=connected' soak.log` (gaps) and the mem column
(drift).

All build phases are code-complete. Done and mock-verified: full client
(chat/channels/adverts/map/tokens), UI overhaul, login page, RF params, battery chart,
connection settings override, meshcore:// share/import, contact management, message export,
telemetry retention, server BLE transport (validated on real hardware), browser-direct mode
(WebSerial/WebBLE with /ingest sync-back, IndexedDB offline queue, Web Locks tab guard,
private sessions, auto release/hand-back — see docs/https.md), channel create/join/edit UI,
room server login + posts, and repeater admin (login, status readout, remote CLI console).

## Hardware validation

- [x] RAK4631 USB: self info, adverts, DM round-trip + ✓✓, channels, restart persistence
- [ ] Mint an API token → hll-meshkeep section shows the messages
- [ ] Map page: global nodes load, own node + positioned contacts overlaid
- [ ] Leave running 24h: reconnect-after-unplug works, no drift/memory issues
- [ ] RF params round-trip on real firmware; contact export/import against the phone app's
      meshcore:// links; login flow with MESHKEEP_UI_PASSWORD in the container
- [x] Connection override + reset on real hardware (2026-07-15: container switched
      serial→BLE→serial at runtime); battery telemetry accumulating (198 points/15 h);
      real-firmware contact export (meshcore:// URI) works
- [ ] Browser-direct: open via localhost or HTTPS (docs/https.md) in Chromium, Radio →
      Radio source → USB (WebSerial) with the RAK4631 on the browsing machine; verify
      DM send/receive, delivery ticks via sync-back, private session, offline queue
      (stop server mid-session), hand-back reclaims the server radio
- [ ] Browser-direct WebBLE with the BLE-firmware RAK4631 (phone/laptop Chromium)
- [x] Server BLE against real hardware (2026-07-15, run directly on the host): full sync
      over BLE — self info (MCTA-Rak, RAK 4631 v1.16.0), battery, channel read. Pairing
      required a reflash first; the radio's PIN was per-device (506819), not 123456.
      Note: firmware reports radioFreq in kHz — unit fix applied to UI + mock.
- [x] Server BLE from INSIDE the container (2026-07-15: D-Bus mount + runtime override
      connected to the bonded radio and synced; same mount works for compose.ble.yml)
- [ ] Server BLE reconnect: power-cycle the radio mid-session, verify it reattaches
- [ ] DM round-trip over the BLE server link once the reflashed radio has peers again
- [ ] Room/repeater against real nodes: login to a real repeater (Request status via ⓘ,
      CLI commands from the composer), join/post to a real room server, and create a
      channel that the phone app can join with the copied secret

## Possible later parity items

- [x] Remote telemetry requests (2026-07-15: GET /contacts/:key/telemetry + "Request
      telemetry" in the details drawer; Cayenne LPP parsed server-side, mock-verified)
- [x] Signed-plain room posts with author attribution (2026-07-15: frame parser patched —
      meshcore.js mangles the 4 raw author bytes — author_prefix column + name resolution,
      shown on room posts; server + browser-direct paths, mock-verified)
- [x] Channel delete/clear (2026-07-15: DELETE /channels/:idx blanks the slot, danger
      button in channel details, refresh prunes externally blanked slots; mock-verified)
- [ ] Hardware check for the three above: telemetry from a real node, signed post in a
      real room, delete a channel on real firmware

## Infra / release

- [x] GitHub repo (github.com/TMASoft/meshkeep) — v0.1.0-Beta released 2026-07-15
- [x] CI (typecheck, lint, vitest, docker build) — .github/workflows/ci.yml; green on
      master since 2026-07-15 (trigger originally pointed at a nonexistent `main` branch,
      and CI now builds @meshkeep/shared before typechecking)
- [x] Publish image to ghcr.io (release.yml, multi-arch, runs on v* tags) + dependabot
      (npm weekly grouped minor/patch, actions, docker) — first published image:
      v0.1.1-beta (2026-07-15, also tagged `beta`); v0.1.0-Beta predates release.yml
      on master and has no image
- [x] Docker image builds and runs clean (verified at 0.1.0-beta)
- [x] HTTP/auth/ws test suites (supertest) + web tests (Pinia store, api client) +
      ESLint/Prettier (2026-07-15)
- [ ] NOTE: /mnt/storage is ntfs3 — npm installs hang on it; run npm in a tmpfs dir
      and copy package-lock.json back (see project memory)
