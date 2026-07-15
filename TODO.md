# MeshKeep TODO

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
- [x] CI (typecheck, vitest, docker build) — .github/workflows/ci.yml; first run
      verifies on the next push
- [x] Publish image to ghcr.io (release.yml, multi-arch, runs on v* tags) + dependabot
      (npm weekly grouped minor/patch, actions, docker)
- [x] Docker image builds and runs clean (verified at 0.1.0-beta)
- [ ] NOTE: /mnt/storage is ntfs3 — npm installs hang on it; run npm in a tmpfs dir
      and copy package-lock.json back (see project memory)
