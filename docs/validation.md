# Validation session runbook (hardware day)

Remaining items are tracked in [issue #15](https://github.com/TMASoft/meshkeep/issues/15);
this is the ordered procedure for working through them, arranged to minimize
replug/reflash churn — the serial soak starts first and runs in the background
for the whole session:

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

Hardware notes from earlier sessions: BLE pairing needs a solid signal (RSSI better
than about −80 dBm), and a radio's PIN can be per-device (e.g. 506819) rather than the
firmware-default 123456 — check the device screen/serial console if pairing is rejected.
