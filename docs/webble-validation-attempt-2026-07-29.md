# WebBLE validation attempt — 2026-07-29

This is a timestamped, read-only preflight record for the **browser-direct
WebBLE** scenario in [the hardware validation runbook](validation.md) and
[issue #15](https://github.com/TMASoft/meshkeep/issues/15). It is not a pass
record. No Bluetooth pairing, browser permission, radio ownership, deployment,
or RF state was changed during this attempt.

## Time and environment

Collected at **2026-07-29T10:15:23Z**:

| Component | Observed version or state |
| --- | --- |
| Host | Linux `7.0.12-arch1-1` |
| Node / npm | `v22.23.0` / `11.16.0` |
| Docker | `29.6.0` |
| Browser available on host | Brave `149.1.91.168` |
| BlueZ client | `bluetoothctl 5.86` |
| MeshKeep deployment | `ghcr.io/tmasoft/meshkeep:0.1.4-beta.20`, up 47 hours and healthy |
| Service health | `GET http://localhost:8080/api/healthz` returned HTTP 200 and `{"ok":true,"version":"0.1.4-beta.20"}` |
| Host BLE controller | Powered and pairable; no active discovery at collection time |
| BLE candidate | A paired, bonded, trusted `MeshCore-MCTA-Rak` device advertising Generic Access, Generic Attribute, and Nordic UART Service; it was **not connected** |

The observed topology was therefore:

```text
MeshKeep container ── USB serial ── server-owned radio A
Host BlueZ ── paired but disconnected BLE candidate B
Brave installed on the host; no confirmed interactive Chromium/phone client
```

## Scenario outcome

**BLOCKED — no WebBLE scenario step was executed.**

The runbook requires all of the following before a valid result can be
recorded:

1. Confirm that candidate B is a physically available, BLE-capable test radio;
   record its board model, firmware/build, per-device PIN confirmation, and an
   RSSI better than about -80 dBm.
2. Provide a human-operated Chromium browser on a phone or laptop at
   `localhost` or a trusted HTTPS origin.
3. In that browser, select **Radio source → Bluetooth (WebBLE)**, complete the
   chooser and pairing flow, and retain redacted UI evidence.
4. Use a separate confirmed RF peer to exchange a disposable direct message.
5. Disconnect, reconnect, and verify that neither stale browser permission nor
   session state prevents a subsequent WebBLE connection.

Only a stored BlueZ bond was observable here. It does not establish candidate
B's physical identity, live RSSI, PIN, independent RF availability, successful
WebBluetooth chooser/pairing, a browser session, direct-message delivery, or
reconnection behavior. Treating it as WebBLE validation would be false.

## Reproducible evidence

The following read-only commands generated this preflight evidence. They can be
rerun during the interactive session before the state-changing steps above:

```sh
date -u --iso-8601=seconds
uname -sr
node --version
npm --version
docker --version
brave --version
bluetoothctl --version
bluetoothctl show
bluetoothctl devices Paired
bluetoothctl info <approved-ble-radio-address>
docker compose ps
curl --connect-timeout 3 --max-time 5 -i http://localhost:8080/api/healthz
```

Packet capture was not produced: `btmon -i hci0` could not bind its monitoring
channel under the current permissions (`Operation not permitted`). Once an
operator approves the interactive session, collect a Bluetooth HCI capture with
sufficient privileges plus redacted browser screenshots and MeshKeep
status/diagnostics before and after connection. Do not record PINs, message
contents, token values, device keys, or location data in the retained evidence.

## Required continuation inputs

- A named operator and approved restricted evidence location.
- A confirmed BLE radio with its PIN available only to the operator, live RSSI,
  firmware/build, and proof it is independent from the server radio.
- A separate RF peer on matching radio settings.
- A phone/laptop Chromium client and consent to operate the browser chooser.
- Permission to capture HCI traffic, or an operator-provided capture procedure.

Until these inputs are available, keep issue #15's WebBLE checkbox unchecked.
