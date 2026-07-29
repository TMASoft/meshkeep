# Validation session runbook (hardware day)

## Serial soak and recovery status — 2026-07-28/29

- [blocked — stopped by dashboard direction] **24-hour serial soak:** started
  at `2026-07-28T14:02:12Z` with a 300-second sampler and stopped at
  `2026-07-29T10:41:00Z` after the dashboard directed “no more soaks, finish
  this up.” The observed interval was 74,328 seconds (20h 38m 48s), not the
  required 24 hours. The evidence directory is
  [`data/validation/serial-soak-20260728T140136Z`](../data/validation/serial-soak-20260728T140136Z/):
  `soak.log` has 247 samples (246 `connected`, one recovery `error`) and memory
  readings from 170.2 to 182.0 MiB (181.4 MiB latest); it does not demonstrate
  no memory drift for a full 24-hour interval. See the [final
  disposition](../data/validation/serial-soak-20260728T140136Z/final-summary-20260729.md).
  The server-owned radio is `MCTA-PC2`, RAKwireless RAK4631, firmware `RAK 4631
  v1.16.0-07a3ca9`, protocol 13, build `06-Jun-2026`.
- [blocked] **Unplug/replug recovery:** the dashboard confirmed a physical
  unplug/replug, though its interruption method and duration were not recorded.
  Serial disconnected at `2026-07-29T10:07:26.858Z` and reconnected without a
  container restart at `2026-07-29T10:15:16.445Z` (469.587 seconds). The service
  retried with 2s through 60s backoff; status and diagnostics then reported a
  connected serial link with no scheduled retry, and a live contact refresh
  succeeded. The retained [recovery result](../data/validation/serial-soak-20260728T140136Z/recovery-success-summary-20260729.md)
  and [final disposition](../data/validation/serial-soak-20260728T140136Z/final-summary-20260729.md)
  record timestamped, non-sensitive evidence. The behavior passed, but this
  checklist line remains blocked because the interruption method and duration
  were not recorded.
- [blocked — validation ended early] **Completion gate:** this run cannot pass:
  it ended before 24 hours and lacks the physical interruption method/duration,
  even though recovery returned to `connected` and post-recovery function
  succeeded. No software defect was identified from this serial recovery
  observation; no implementation was performed as part of this validation run.

Remaining items are tracked in [issue #15](https://github.com/TMASoft/meshkeep/issues/15);
this is the ordered procedure for working through them, arranged to minimize
replug/reflash churn — the serial soak starts first and runs in the background
for the whole session:

The latest attempt record is
[2026-07-28 hardware validation](validation-hardware-attempt-2026-07-28.md).
It retains live preflight evidence and scenario-specific blockers; it does not
mark any unchecked hardware scenario complete.

## Checklist disposition — 2026-07-29

`PASS (code)` means the dashboard waived further manual validation and the
implementation plus its focused automated coverage were reviewed. It is not a
claim of RF, browser, phone, BLE, or firmware interoperability. `BLOCKED`
means neither the required physical evidence nor an equivalent focused
code-level result exists. Historical physical results retain the deployment
version at which they were observed.

| Step | Status | Evidence and exact scope |
| --- | --- | --- |
| Serial soak and recovery | **BLOCKED — validation ended early** | The reconnect implementation and focused tests passed, and recovery was observed, but the sampler stopped at 20h 38m 48s by dashboard direction and the operator-recorded interruption method/duration is absent. See the [final disposition](../data/validation/serial-soak-20260728T140136Z/final-summary-20260729.md), [recovery record](../data/validation/serial-soak-20260728T140136Z/recovery-success-summary-20260729.md), and [code-level review](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5116548455). |
| API-token dashboard and launcher | **BLOCKED** | No test token, hll-meshkeep instance, or interactive dashboard evidence was available; no focused code-level disposition was recorded. See the [hardware attempt](validation-hardware-attempt-2026-07-28.md#api-token-dashboard-access--blocked). |
| Map overlays | **BLOCKED** | Backend preflight found configured map data, but browser rendering and the own-node overlay were not exercised; no focused code-level disposition was recorded. See the [hardware attempt](validation-hardware-attempt-2026-07-28.md#map-functionality--partial-pre-flight-only). |
| RF parameter round-trip | **PASS (physical, historical)** | Observed on deployed `0.1.4-beta.11` on 2026-07-24: the exact radio configuration survived API write, restart, and fresh sync. Evidence is retained in [issue #15](https://github.com/TMASoft/meshkeep/issues/15). No new `0.1.4-beta.20` run was performed. |
| Phone `meshcore://` import/export | **BLOCKED** | No phone/app or approved disposable-contact workflow was available. See the [hardware attempt](validation-hardware-attempt-2026-07-28.md#phone-meshcore-contact-importexport--blocked). |
| Temporary password-login gate and API-token continuity | **BLOCKED** | No approved temporary `MESHKEEP_UI_PASSWORD` deployment change or interactive dashboard/plugin client was available. The read-only prerequisite inventory and explicit non-execution record are retained in [issue #15](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5105149772). |
| Browser-direct WebSerial DM, isolation, recovery, and hand-back | **PASS (code)** | Reviewed ownership handoff, private isolation, durable replay/reconciliation, and DM delivery; the full automated suite passed. Manual browser/RF validation was waived. See the [browser-radio regression suite](../packages/web/test/browser-radio.test.ts), [store regression suite](../packages/web/test/store.test.ts), [attempt record](validation-browser-direct-dm-2026-07-29.md), and [checklist consolidation](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5116622963). |
| Browser-direct WebBLE | **BLOCKED (code failure path)** | Common transport logic passed review, but rejected GATT initialization can surface only as an unhandled rejection and later timeout. The code-level setup/reconnect criterion is blocked pending [#89](https://github.com/TMASoft/meshkeep/issues/89); no physical chooser/pairing/DM result is claimed. See the [WebBLE code-level review](webble-code-review-2026-07-29.md) and [checklist consolidation](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5116622963). |
| Server-BLE DM round trip and serial restoration | **PASS (code)** | BLE configuration, connection/sync, bidirectional DM acknowledgement, retry, and restoration paths passed focused review: 124 BLE/reconnect/integration tests plus 11 profile tests. Physical BLE validation was waived. See the [detailed review evidence](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5116591870) and [checklist consolidation](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5116622963). |
| Room/repeater and phone-joinable channel | **PASS (code)** | Login/status/CLI, room posting, signed attribution, and channel create/delete passed the [server integration](../packages/server/test/integration.test.ts) and [web-store](../packages/web/test/store.test.ts) reviews. Physical room/repeater/phone validation was waived. See the [physical-attempt record](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5116355436) and [session prerequisites](validation-session-prep.md#9-roomrepeater-and-phone-joinable-channel--unchecked). |
| Hardware parity: telemetry, signed post, and channel deletion | **BLOCKED** | Channel deletion and signed attribution were covered by the room code review, but no focused telemetry review or real-node evidence was recorded. Do not claim the full parity step passed. See [the required evidence](validation-session-prep.md#10-hardware-parity-items--unchecked). |
| Multi-radio profile switching (issue #53) | **PASS (code); BLOCKED (physical)** | Concurrent-link lifecycle and per-radio isolation passed 63 focused tests; the two-radio topology was not available. See the [profile-switching record](validation-profile-switching-attempt-2026-07-29.md#code-level-transition-review--2026-07-29t103510z). |

1. **[BLOCKED — stopped by dashboard direction]** `docker compose up -d`
   (compose.yml pulls `ghcr.io/tmasoft/meshkeep:beta`); `curl localhost:8080/api/healthz`
   should report the current beta. The required 24-hour soak was stopped at 20h
   38m 48s, so this acceptance item remains incomplete; see the [final
   disposition](../data/validation/serial-soak-20260728T140136Z/final-summary-20260729.md).
2. **[BLOCKED]** Mint an API token (Radio → API access) → configure the launcher's meshkeep plugin
   (v0.1.1, install from GitHub) → dashboard shows messages + unread badge.
3. **[BLOCKED]** Map page: global nodes load, own node + positioned contacts overlaid.
4. **[PASS (physical, historical)]** RF params round-trip on real firmware (remember: firmware reports kHz).
5. **[BLOCKED]** `meshcore://` contact import from the phone app; export to it.
6. **[BLOCKED]** Login flow: uncomment MESHKEEP_UI_PASSWORD in compose.yml, `docker compose up -d`,
   verify the login gate + that the API token still works for the plugin. Revert after.
7. **[PASS (code)]** Browser-direct WebSerial per docs/https.md "Validation-session quick start".
8. **[BLOCKED (WebBLE code failure path)]** BLE trio: server BLE reconnect after radio power-cycle; DM
   round-trip over the BLE server link; browser-direct WebBLE from a phone/laptop. The browser-direct
   WebBLE setup/reconnect failure path is tracked in [#89](https://github.com/TMASoft/meshkeep/issues/89).
9. **[PASS (code)]** Real room/repeater: repeater login + status + CLI from the composer; join/post to a
   real room server; create a channel the phone app can join from the copied secret.
10. **[BLOCKED]** Hardware check of the parity items: telemetry request from a real node, signed post
    attribution in a real room, channel delete on real firmware.

Review the soak afterwards: `grep -v 'state=connected' soak.log` (gaps) and the mem column
(drift).

Hardware notes from earlier sessions: BLE pairing needs a solid signal (RSSI better
than about −80 dBm), and a radio's PIN can be per-device (e.g. 506819) rather than the
firmware-default 123456 — check the device screen/serial console if pairing is rejected.
