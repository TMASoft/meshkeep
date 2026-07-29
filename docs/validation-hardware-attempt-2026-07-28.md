# Hardware validation attempt — 2026-07-28

This is an execution record for the remaining API-token dashboard, map,
phone-contact, and password-login scenarios in [issue #15][issue-15]. It is
not a pass record: no test token, launcher instance, phone client, or
interactive browser evidence was available to complete the required
end-to-end checks. No credentials, contact names, keys, locations, or message
contents are retained here.

[issue-15]: https://github.com/TMASoft/meshkeep/issues/15

## Environment and topology

Recorded at **2026-07-28T14:01:56Z–14:02:24Z** (UTC):

| Component | Observed version/state |
| --- | --- |
| Host | Linux `7.0.12-arch1-1`; Node `v22.23.0`; Docker `29.6.0` |
| Deployment | `ghcr.io/tmasoft/meshkeep:0.1.4-beta.20`; up for 26 hours and healthy; `GET /api/healthz` returned HTTP 200 with `{"ok":true,"version":"0.1.4-beta.20"}` |
| Server radio A | RAKwireless WisCore RAK4631 / MCTA-PC2, serial `/dev/ttyACM0`; MeshKeep reported connected serial transport, firmware protocol 13, build `06-Jun-2026` |
| Potential radio B | BlueZ-paired and trusted `MeshCore-MCTA-Rak` at `E5:01:46:20:3C:CB`; disconnected during this attempt |
| Browser | Brave `149.1.91.168` installed; the available browser automation could not launch Chrome, and Brave headless capture did not complete within 15 seconds. No page screenshot can therefore be presented as evidence. |
| Phone / hll-meshkeep | No connected Android device; no confirmed phone client or hll-meshkeep v0.1.1 test instance available |

The live topology was MeshKeep -> USB serial -> radio A. Radio B was visible
only as an inactive BlueZ pairing; no RF, BLE, phone, or launcher action was
performed.

## Scenario results

### API-token dashboard access — BLOCKED

The scenario requires an operator-created least-privilege, revocable token and
a reachable hll-meshkeep v0.1.1 test instance to show a real message and unread
badge, followed by token revocation. Neither was available. No token was minted
or inspected, and no dashboard request was sent.

**Outcome:** unchecked; no defect observed.

### Map functionality — PARTIAL PRE-FLIGHT ONLY

At 2026-07-28T14:02:24Z, read-only live API checks showed:

- `/api/v1/diagnostics`: map enabled, no `lastError`, cached at
  `1785158091034`.
- `/api/v1/map/config`: global node index enabled and a tile URL configured.
- `/api/v1/map/nodes`: 53,145 raw nodes, all 53,145 with valid non-zero
  coordinates.
- `/api/v1/contacts`: 4 locally stored contacts, 2 with valid non-zero
  coordinates. The radio's own coordinates were `null` in `/api/v1/status`.

The response SHA-256 values, retained without response content, were:

```text
f612598f3c754971c52eb3509401a07723207024bea5b926293841bd8e2648d8  map-config
ff89558441aa63ff7c81af4463f433674a3e27ada0995c3006510fcb578e3bc0  map-nodes
3c239f116639e86171cf0937ddae8a6cda5d9439d803a856b172fdbcb810237d  contacts
```

This establishes live backend readiness only. It does **not** establish the
required browser map rendering, own-node overlay, or a screenshot, so it is not
a substitute for the scenario.

**Outcome:** unchecked; no defect observed.

### Phone `meshcore://` contact import/export — BLOCKED

No physical phone, phone OS/app version, or approved disposable contact workflow
was available. Creating/importing a contact from an emulator or by manually
calling APIs would violate the hardware-validation requirement, so no contact
state was changed.

**Outcome:** unchecked; no defect observed.

### Password login and API-token continuity — BLOCKED

The checked-in local compose configuration leaves `MESHKEEP_UI_PASSWORD`
commented out. Enabling it would require a temporary secret in the ignored
operator deployment environment, an interactive browser login capture, and an
existing scoped test token for continuity verification. Those prerequisites were
not available; the deployment was not restarted and no authentication setting was
changed.

**Outcome:** unchecked; no defect observed.

## Required continuation inputs

1. A named operator and evidence-storage location with permission to capture
   redacted screenshots/logs.
2. A test hll-meshkeep v0.1.1 instance and a least-privilege, revocable test
   token (value must not be recorded here).
3. A phone with its MeshCore app version and access to create and remove
   disposable contacts.
4. A functioning interactive Chromium/Brave session with screenshot capture.
5. Approval to set and later remove a temporary UI password in the ignored
   deployment environment, plus a scoped test bearer token for continuity.

Until these inputs exist, [issue #15][issue-15] must remain open and all four
checklist entries remain unchecked. No software defect was observed in this
attempt, so no new issue was created.
