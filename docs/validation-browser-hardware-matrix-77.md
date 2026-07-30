# Browser/hardware support matrix (issue #77)

Scope per #77: run and record secure-context validation on supported Chromium
desktop WebSerial/WebBLE hardware and representative mobile/browser
configurations; update this matrix only with observed outcomes. This
environment has no physical radio hardware, no phone/tablet, and no
Bluetooth adapter attached, so every row below is currently **BLOCKED — not
run**, per this repo's convention of not claiming a hardware result without
physical evidence (see `docs/validation.md`'s disposition table). The columns
match the issue's acceptance criteria exactly so a physical session can fill
them in directly.

Do not mark any row as supported/passing without dated, physical evidence
(device model, OS/browser version, and the actual behavior observed). An
unattempted row must stay `BLOCKED — not run`, not be inferred from code
review — the point of this card is physical evidence that #74–#76's
implementation is a code-level review substitute.

## Matrix

| Browser + version | OS | Origin security state | Hardware | Permission result | Radio behavior | Notification behavior | Limitations | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chrome/Chromium (desktop) | Linux/Windows/macOS | HTTPS (reverse proxy) | WebSerial-capable LoRa radio (e.g. RAK4631) | — | — | — | — | BLOCKED — not run |
| Chrome/Chromium (desktop) | Linux/Windows/macOS | `localhost` | WebSerial-capable LoRa radio | — | — | — | — | BLOCKED — not run |
| Chrome/Chromium (desktop) | Linux/Windows/macOS | HTTPS (reverse proxy) | WebBLE-capable LoRa radio | — | — | — | — | BLOCKED — not run |
| Chrome (Android) | Android (version TBD) | HTTPS | Same radio, installed PWA | — | — | — | — | BLOCKED — not run |
| Chrome (Android) | Android (version TBD) | HTTPS | Same radio, browser tab (not installed) | — | — | — | — | BLOCKED — not run |
| Firefox (desktop) | Linux/Windows/macOS | HTTPS | N/A — not a supported browser-direct target | — | — | — | — | BLOCKED — not run |
| Safari | macOS | HTTPS | N/A — not a supported browser-direct target | — | — | — | — | BLOCKED — not run |
| Safari | iOS, installed PWA | HTTPS | N/A — not a supported browser-direct target; push validation only | — | — | — | — | BLOCKED — not run |

## What each physical session must exercise and record

For every WebSerial/WebBLE row (Chromium desktop, Chrome Android):

1. **Browser-direct handoff and rollback** — start a browser-direct session
   (Radio → Connect from browser), confirm the server releases to standby,
   confirm the device chooser appears, connect, then stop and confirm the
   server reclaims the radio (`docs/https.md`, `stopBrowserRadio` in
   `packages/web/src/stores/app.ts`). Record whether handoff and rollback
   both completed cleanly.
2. **Private-session behavior** — start a private browser-direct session,
   send/receive a DM, confirm it never reaches the server (no sync-back),
   then end the session and confirm nothing persisted (the queue-clearing
   behavior added in #74's `stopBrowserRadio` hook).
3. **Permission result** — record the exact browser permission-prompt
   behavior for the device chooser (WebSerial/WebBluetooth) and, separately,
   for `Notification.requestPermission()`.
4. **Notification behavior** — with the "Show notification details" opt-in
   both off and on (#75), trigger an incoming DM and a telemetry alert; record
   the exact lock-screen/notification-tray content shown at each OS/browser,
   and whether clicking it focuses/opens MeshKeep without bypassing login.
5. **Push (#76)**, where VAPID keys are configured — subscribe from Display
   settings, background or close the tab, trigger a message/alert from
   another client, and record whether and how quickly the OS surfaces the
   generic push notification. This is explicitly best-effort; record failures
   as data, not as a defect, unless the code itself is at fault.
6. **Limitations** — anything that didn't work, felt unreliable, or needed a
   workaround (adapter reconnects, RSSI issues, permission re-prompts,
   Bluetooth pairing PIN quirks — see the hardware notes at the bottom of
   `docs/validation.md`).

Rows for browsers that are not supported browser-direct targets (Firefox,
Safari) only need the notification/push portions (3–5 above); WebSerial/WebBLE
columns should stay `N/A — not a supported browser-direct target` per
`docs/pwa-feasibility.md`'s capability matrix, not be tested.
