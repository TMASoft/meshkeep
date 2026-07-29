# Real-radio profile-switching validation attempt — 2026-07-29

This is an execution record for the physical profile-switching validation item
tracked by [issue #15][issue-15] and profile/multi-radio work in [issue #53][issue-53].
It records a blocked attempt, not a pass. No radio profile, connection override,
or deployment configuration was changed during this attempt.

[issue-15]: https://github.com/TMASoft/meshkeep/issues/15
[issue-53]: https://github.com/TMASoft/meshkeep/issues/53

## Result

**BLOCKED at 2026-07-29T10:15:23Z.** There is one physically confirmed,
server-owned radio, no saved server profile, and no physically identified second
radio that can be safely selected as a target. Creating two profiles for the
same USB radio would exercise CRUD, not a real-radio transition; switching to
the unverified BlueZ pairing would disrupt the healthy deployment without an
operator-approved recovery path. Therefore no activation or deactivation request
was sent.

## Observed topology and configuration

```text
MeshKeep 0.1.4-beta.20 (Docker, healthy) ── USB serial ── radio A
                                                      └── MCTA-PC2 / RAKwireless RAK4631

BlueZ paired candidate (not connected or physically verified):
  MeshCore-MCTA-Rak / E5:01:46:20:3C:CB
```

At the recorded time, `GET /api/v1/status` and `GET /api/v1/diagnostics` showed
one connected serial link. Radio A reported model/firmware `RAK 4631
v1.16.0-07a3ca9`, protocol `13`, build `06-Jun-2026`; its active RF configuration
was `910525` kHz, `62500` Hz bandwidth, SF `7`, CR `5`, and `22` dBm transmit
power. The device was present through a stable USB-by-ID serial mapping (the
host-specific path is intentionally not retained in this tracked record).

`GET /api/v1/radio/profiles` returned an empty profile list with no active
profile. `bluetoothctl devices Paired` listed only the candidate above. Its board
model, firmware/build, PIN, current RSSI, matching RF settings, and independent
physical availability remain unconfirmed.

## Required real-radio validation matrix

The intended two-radio topology is:

```text
MeshKeep ── profile A / USB serial ── radio A
         └─ profile B / approved independent transport ── radio B
```

Run these transitions only after both radios are physically inventoried and the
operator approves temporary connection changes:

1. Baseline: activate profile A; capture `/api/v1/status`,
   `/api/v1/diagnostics`, the selected-profile response, and serial/container
   logs. Confirm A is `connected` and note its model, firmware, and RF settings.
2. A → B: activate B; capture the activation response and timestamps until B is
   `connected`. Confirm link identity and B's model, firmware, and RF settings.
3. B → A: activate A; retain the equivalent evidence and confirm the original
   A link reconnects.
4. While each radio is active, verify radio-scoped history/contacts are selected
   by its radio identity and that writes target the selected radio. Do not infer
   this from a profile pointed at the same physical device.
5. Deactivate one profile and confirm the other link's connection state and
   message operations remain correct. If testing the current concurrent-link
   implementation, preserve status `links[]` evidence for both live profiles.

Record UTC timestamps, exact profile payloads with secrets removed, status and
diagnostics before/after each transition, serial/container logs, and browser
screenshots. Redact message bodies, credentials, private keys, and host-specific
paths.

## Operator steps executed

| UTC time | Step | Evidence / outcome |
| --- | --- | --- |
| 2026-07-29T10:15:09Z | Checked deployment health. | HTTP 200; `{"ok":true,"version":"0.1.4-beta.20"}`. |
| 2026-07-29T10:15:23Z | Read status, diagnostics, and profiles endpoints without mutation. | One serial link connected; database integrity `ok`, schema `14/14`; profiles empty. |
| 2026-07-29T10:15:23Z | Enumerated paired Bluetooth devices without connecting. | One unverified candidate, `MeshCore-MCTA-Rak` at `E5:01:46:20:3C:CB`. |
| 2026-07-29T10:15:23Z | Reviewed container logs. | The prior USB recovery sequence had serial read/connect failures; current service had subsequently restored a connected serial link. No profile action was taken during this attempt. |
| 2026-07-29T10:15:23Z | Evaluated profile transition prerequisites. | Blocked: no saved profile and no second independently confirmed physical radio. |

## Evidence retained

- Live API evidence was read at the timestamps above from `/api/healthz`,
  `/api/v1/status`, `/api/v1/diagnostics`, and `/api/v1/radio/profiles`.
- Host enumeration observed one RAKwireless WisCore RAK4631 USB device and one
  paired BlueZ candidate. No serial-console session was opened, so no serial
  transcript exists for this attempt.
- No browser UI session was run and no screenshot exists; an automated capture
  would not establish physical operator interaction or a two-radio transition.
- The deployment's container logs at this time contained the earlier reconnect
  failures and later successful connection described above. They are not copied
  here because raw logs may include host-specific identifiers.

## Unblock requirements

1. Provide a physically distinct second radio with model, firmware/build, serial
   or BLE identity, PIN where applicable, RSSI for BLE, and matching RF settings.
2. Create and identify approved saved profiles for both radios, with an operator
   present to recover either link if it fails.
3. Nominate a restricted evidence location and an interactive browser client for
   the required screenshots.
4. Schedule a maintenance window if activation would interrupt the current serial
   deployment. Re-run the full matrix; do not convert this blocked result into a
   pass based on API or mock-radio tests.

## Code-level transition review — 2026-07-29T10:35:10Z

**PASS for the implemented concurrent-link semantics; not a replacement for the
blocked physical validation above.** Per operator direction, no additional
manual radio action was performed.

The implementation deliberately does not replace A with B on activation:
`ConnectionManager.activateProfile()` persists and starts the requested profile
link without removing the default or another profile link
([`manager.ts`](../packages/server/src/radio/manager.ts)). This matches the
current multi-radio design: A and B may be active concurrently. Deactivating a
specific profile removes only that link; the all-profile deactivate endpoint
removes saved-profile links and restores the default link. Active profile edits
tear down and recreate only that profile's link. A second live BLE profile is
rejected before connection, preventing BlueZ adapter contention.

The observable state required to validate each logical transition is available:
`GET /api/v1/status` reports each active link with profile id, label, resolved
radio id, connection state, transport, target, error, and connection timestamp.
During initial sync, each link resolves the radio by its self public key and
persists that identity as the link's `last_radio_id`; contacts, channels,
messages, and telemetry are stored per radio id. Mutating operations require an
explicit `radioId` whenever more than one live link exists, rather than silently
selecting a radio.

Automated evidence (all mock-transport/code-level):

- `npm --workspace @meshkeep/server run test -- radio-profiles.test.ts integration.test.ts`:
  55 tests passed. Covers profile lifecycle, concurrent activation/deactivation,
  active-profile edit/reconnect, default-link isolation, ambiguous write
  rejection, and BLE exclusivity.
- `npm --workspace @meshkeep/server run test -- radio-isolation.test.ts`:
  8 tests passed. Covers per-radio storage isolation and `?radioId=` reads.

Residual limitation: these tests prove control-flow and storage isolation only;
they do not establish serial/BLE firmware interoperability, physical link
handoff timing, or operator recovery. The real-radio result remains **BLOCKED**
pending the prerequisites listed above; the code-level review result is **PASS**.
