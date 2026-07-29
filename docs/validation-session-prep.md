# Physical validation session preparation

Prepared from the live deployment and GitHub issue #15 on 2026-07-27. This is a
session plan, not completion evidence. Do not put API-token values, UI passwords,
room passwords, channel secrets, or personal contact data in this file.

## Scheduling status

**Not scheduled.** The operator, their availability, and confirmation that the
phone, second radio, room/repeater access, and hll-meshkeep installation are
available cannot be established from this repository or host. Those are blocking
inputs; see [gaps and confirmation](#gaps-and-confirmation) before starting the
24-hour soak.

Recommended shape once confirmed:

1. **Interactive session (about 3 hours):** inventory devices, run all short
   scenarios below, initiate the serial soak, and perform its one unplug/replug.
2. **Soak review (after at least 24 hours):** stop the monitor, review evidence,
   and update [issue #15](https://github.com/TMASoft/meshkeep/issues/15) only for
   scenarios with attached/retained evidence.

## Versioned inventory (observed 2026-07-27)

| Role | Verified identity / model | Firmware or software | Connection and state | Gaps to confirm in session |
| --- | --- | --- | --- | --- |
| MeshKeep host | Linux `7.0.12-arch1-1`, Docker `29.6.0`, Node `v22.23.0` | Container `ghcr.io/tmasoft/meshkeep:0.1.4-beta.20`; `/api/healthz` returned `0.1.4-beta.20` | Healthy container on `localhost:8080` | Operator/host owner and access method |
| Server serial radio (A) | `MCTA-PC2`; RAKwireless RAK4631; USB serial ID `usb-RAKwireless_WisCore_RAK4631_Board_1A4B73E9CAD23CEC-if00`; public key `1c6db3962c0c33e2270fe4d28c9e7cba817646bef1f2b7601c50f686f21ccf34` | `RAK 4631 v1.16.0-07a3ca9`; firmware protocol version `13`; build `06-Jun-2026` | Server-owned serial link, `/dev/ttyACM0` via stable by-id path; active radio ID `2`; `910525` kHz, `62500` Hz, SF7, CR5, 22 dBm | Physical label/serial-number photo if required by the operator's asset policy |
| Paired BLE candidate / second radio (B) | BlueZ device `MeshCore-MCTA-Rak`, address `E5:01:46:20:3C:CB`; stored radio name `MCTA-Rak`, public key `4c330c16309d4ac5736b759e0ef08bab3d402ee0b46e58bc31226474f628bc5a` | Unknown: no active BLE connection was queried | Paired and discoverable to the host; stored as inactive radio ID `1` | Exact board model, firmware/build, PIN, RSSI at test position, and whether it is physically distinct from A |
| Browser client | Brave Browser `149.1.91.168` on the Linux host | Chromium family; suitable for WebSerial/WebBluetooth | Installed locally; no active session was observed | Confirm browser profile, permission reset procedure, and whether a separate laptop/phone Chromium client is available |
| Phone client | Not observed | Unknown | Required for `meshcore://` and channel-join validation | Model, OS version, MeshCore app version, account/login state, and charging cable |
| hll-meshkeep launcher | Not observed | Validation runbook requires plugin `v0.1.1` | Required for API-token/dashboard scenario | Installation URL/host, operator access, and a revocable test token |
| Room/repeater service | Not observed | Unknown | Required for room/repeater scenario | Endpoint, test account, room password, repeater identity, and a non-production test room/channel |

The live deployment diagnostics at preparation time reported a connected serial
link, no reconnect backlog, database integrity `ok`, and schema version `14/14`.
This supports starting a session; it is not evidence for any scenario below.

## Topology plan

Use two physical MeshCore nodes on the same RF configuration:

```text
Browser/Brave on host ── WebSerial ── radio A: MCTA-PC2 / RAK4631
          │                                  │ USB serial (server ownership)
          └──────── MeshKeep beta.20 ────────┘
                       │
                       ├── BlueZ/BLE ── radio B: MeshCore-MCTA-Rak (confirm model/firmware)
                       ├── phone running MeshCore app (confirm model/version)
                       ├── hll-meshkeep test instance (confirm host/access)
                       └── room/repeater test account (confirm endpoint/access)
```

Use radio A as the server serial radio and browser-direct WebSerial target. Use
radio B as the independent RF peer for direct-message, delivery, telemetry, and
BLE scenarios. If radio B cannot be the BLE target, provide a third BLE-capable
radio; do not try to infer server-BLE behavior from browser WebBLE.

For browser-direct tests, use `http://localhost:8080` on the host or a trusted
HTTPS origin. Reset the browser's serial/Bluetooth permissions before the session
so chooser and hand-back behavior is observable. Record RF settings from both
radios before each scenario; they must match.

## Evidence and execution checklist

Existing issue evidence already marks RF-parameter round-trip and server BLE
power-cycle reconnect as passed. All remaining issue #15 items are below. Check
only after the stated evidence is retained with the session record.

### 1. 24-hour serial soak — unchecked

- [ ] Preflight: radio A is server-owned over its by-id USB path; capture
  `/api/healthz`, `/api/v1/status`, and `/api/v1/diagnostics` before starting.
- [ ] Start `./scripts/soak-check.sh http://localhost:8080 meshkeep-meshkeep-1 <session-log-path>/soak.log 300` and record start time in UTC.
- [ ] Once during the soak, physically unplug and replug radio A; retain the
  relevant container logs plus status output showing a fresh connected link.
- [ ] Run for at least 24 hours. Retain the complete `soak.log`; review connection
  gaps with `grep -v 'state=connected'` and memory trend with the script's
  documented final-column review.
- [ ] Pass only if reconnect succeeds and the retained log shows no unexplained
  disconnection or memory-drift concern.

Evidence: `soak.log`, timestamped before/after status JSON, and redacted
container/diagnostic logs.

### 2. API token and hll-meshkeep dashboard — unchecked

- [ ] Operator creates a least-privilege, revocable test token in **Radio → API access**; record only its label, scope, owner, and expiry/revocation plan.
- [ ] Configure hll-meshkeep `v0.1.1` on its confirmed test host; do not paste its
  token into this runbook or issue.
- [ ] Send or receive a test message and produce an unread state.
- [ ] Verify the launcher dashboard section shows both recent messages and unread badge.
- [ ] Revoke the token at the end of the session and prove the integration no
  longer authenticates.

Evidence: redacted launcher screenshots, token metadata (never value), and
request/access logs with authorization material redacted.

### 3. Map overlay — unchecked

- [ ] With the approved network/privacy setting, load **Network** and wait for
  global nodes to render.
- [ ] Set/confirm a valid location for radio A and one positioned contact; verify
  both overlays appear in the expected approximate locations.
- [ ] Record any privacy choice for global-map and tile traffic.

Evidence: timestamped screenshot with non-sensitive location data redacted if needed,
and diagnostics map status.

### 4. Phone `meshcore://` contact export/import — unchecked

- [ ] Export a disposable test contact from MeshKeep on radio A.
- [ ] Import it into the confirmed phone MeshCore app and verify the expected name/key.
- [ ] Export a disposable phone contact and import it into MeshKeep; verify a DM can be selected.
- [ ] Remove the disposable contacts after validation.

Evidence: redacted before/after screenshots from both clients and exported-link
metadata with the key redacted if policy requires it.

### 5. Password login and API-token continuity — unchecked

- [ ] Place a temporary `MESHKEEP_UI_PASSWORD` only in the ignored deployment
  environment file, restart, and verify anonymous UI/API access is gated.
- [ ] Authenticate through the browser login flow.
- [ ] Verify the existing test bearer token still reaches its allowed API endpoint.
- [ ] Remove the temporary password and restart/reload to restore the original
  deployment state; confirm health.

Evidence: redacted screenshots/HTTP status codes, deployment restart timestamps,
and final health status. Never retain the password or bearer token.

### 6. Browser-direct WebSerial — unchecked

**2026-07-28 attempt: blocked.** The host's only confirmed active radio is
server-owned serial radio A. No confirmed second RF peer or human-operated
browser client was available for the required direct-message exchange. The
offline recovery fix in [#68](https://github.com/TMASoft/meshkeep/issues/68)
still requires physical validation on a deployed version. Evidence:
[#15 validation-attempt record](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5105142890).

- [ ] In Brave/Chromium, choose **Radio source → USB (WebSerial)** and select radio A.
- [ ] Send a DM to radio B and receive a reply; verify delivery ticks and sync-back
  server history for the non-private session.
- [ ] Enable **Private session**, exchange a disposable message, and verify it is
  absent from server history.
- [ ] With a non-private browser session, stop the server, receive/send a
  peer message, restart the server, and verify queued sync recovery. Record the
  known behavior or a defect; do not mark pass without the message in server history.
- [ ] Select **Disconnect & hand back to server** and verify a fresh server-owned
  serial connection.

Evidence: browser screenshots, message IDs/timestamps (content redacted),
server-history query/screenshot, and before/after status JSON. Existing issue
#15 comments cover partial WebSerial ownership/private/hand-back evidence, but
not DM delivery and queue recovery.

### 7. Browser-direct WebBLE — unchecked

**2026-07-28 attempt: blocked.** BlueZ has a bonded `MeshCore-MCTA-Rak` BLE
candidate, but it was disconnected and its physical identity, firmware, PIN,
RSSI, and independent RF availability were not confirmed. No phone or
human-operated Chromium client was attached for pairing or DM exchange.
Evidence: [#15 validation-attempt record](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5105142890).

- [ ] Confirm a BLE-capable test radio, its PIN from the device console, and RSSI
  better than about -80 dBm.
- [ ] Use phone or laptop Chromium on localhost/trusted HTTPS; choose
  **Radio source → Bluetooth (WebBLE)** and pair.
- [ ] Exchange a disposable DM with a separate RF peer, then disconnect and verify
  no stale browser permission/session prevents a subsequent connection.

Evidence: pairing/connection screenshots, redacted console/PIN-confirmation note,
RSSI reading, and message timestamps.

### 8. DM round-trip over the server BLE link — unchecked

**2026-07-28 attempt: blocked.** Testing would require a confirmed BLE radio,
a separate RF peer, and an approved temporary switch from the currently healthy
serial deployment. The running service remained on serial and was not disrupted.
Evidence: [#15 validation-attempt record](https://github.com/TMASoft/meshkeep/issues/15#issuecomment-5105142890).

- [ ] Configure the confirmed BLE radio address in the ignored deployment
  environment, retain the existing host BlueZ bond, and start MeshKeep in BLE mode.
- [ ] Verify the server reports `connected` transport `ble`.
- [ ] Send radio-B-to-peer and peer-to-radio-B direct messages; verify received,
  server history, and delivery state.
- [ ] Restore the serial deployment and confirm radio A reconnects.

Evidence: status/diagnostics before and after, redacted `bluetoothctl info`,
container logs, and message timeline.

### 9. Room/repeater and phone-joinable channel — unchecked

- [ ] Login to the confirmed test repeater; verify status readout and run a
  harmless documented CLI command.
- [ ] Login to the confirmed test room and post a clearly labelled disposable message.
- [ ] Create a disposable channel, transfer its secret directly through an approved
  secure channel, join it in the phone app, exchange a message, then delete it.

Evidence: redacted UI captures, endpoint/account labels (not passwords), CLI
request/result, and phone join/message proof. Never put room or channel secrets
in ticket comments or this file.

### 10. Hardware parity items — unchecked

- [ ] Request telemetry from a real peer node and verify a new telemetry sample is
  displayed/stored with sensible timestamp and values.
- [ ] Send a signed post in the real test room and verify the displayed author
  attribution corresponds to the signing node.
- [ ] Create then delete a disposable channel on real firmware; after resync,
  verify it is absent in MeshKeep and the radio/phone view.

Evidence: redacted telemetry output, room post attribution screenshot, and
before/after channel lists from both MeshKeep and the device/phone.

## Gaps and confirmation

The following are hard blockers, not assumptions:

1. **Operator and time:** name, contact channel, a confirmed interactive window,
   and a 24-hour follow-up/review owner are unavailable. No session is scheduled.
2. **Second physical radio:** BlueZ shows `MeshCore-MCTA-Rak`, but its physical
   model, firmware/build, PIN, RF settings, and independent availability are not
   confirmed. A second RF peer is necessary for most DM/delivery scenarios.
3. **Phone:** no phone model/OS/MeshCore-app version or operator access was found.
4. **Browser client:** host Brave is installed, but the user profile/permission
   state and a separate WebBLE-capable client are not confirmed.
5. **Integration/service access:** hll-meshkeep, room/repeater endpoint, test
   account, and approved disposable channel workflow are not available from the host.
6. **Credentials:** create a revocable test token and temporary test credentials
   during the session; do not expose values in source, GitHub, logs, or this document.
7. **Evidence storage:** operator must nominate a restricted session-log location
   for `soak.log`, redacted logs, screenshots, and diagnostic bundles before testing.

Once these seven confirmations are recorded, schedule the interactive session and
assign a named owner for the 24-hour soak review. Until then, issue #15 must remain
open and no unchecked hardware item should be claimed as complete.
