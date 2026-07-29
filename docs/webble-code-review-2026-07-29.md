# WebBLE code-level review — 2026-07-29

The dashboard superseded the physical-radio request for this card with:

> no more manual validation, code level review is all that is required

This is therefore a static/software review, not a hardware pass. It does not
change issue #15's unchecked browser-direct WebBLE item.

## Timestamp and reviewed configuration

Reviewed at **2026-07-29T10:35:42Z** against the working tree's installed
application dependency set:

| Component | Evidence |
| --- | --- |
| MeshKeep web package | `0.1.4-beta.20` |
| `@liamcottle/meshcore.js` | `1.13.0` |
| WebBLE dependency implementation | `node_modules/@liamcottle/meshcore.js/src/connection/web_ble_connection.js` |
| Browser-facing source | `packages/web/src/sources/browser-radio.ts` |
| UI and server-handoff path | `packages/web/src/views/DeviceView.vue`, `packages/web/src/stores/app.ts` |
| Scenario authority | `docs/validation.md:157-173`, issue #15 |

No browser permission, Bluetooth pairing, device ownership, RF configuration,
or radio state was changed during this review.

## Scenario trace and outcome

| Required scenario | Static trace | Outcome |
| --- | --- | --- |
| Secure Chromium WebBLE entry point | `browserRadioSupport("webble")` requires both a secure context and `navigator.bluetooth`; `DeviceView.vue` disables the button when either condition fails. | Pass at code level. |
| User picker filtered to MeshCore BLE | The selected `webble` kind dynamically imports `web_ble_connection.js`; its `open()` requests only `Constants.Ble.ServiceUuid`. | Pass at code level. |
| Server ownership handoff before browser connects | `startBrowserRadio()` releases the server connection and requires `standby` before constructing/opening the browser source. Existing store tests cover release ordering and failed-release restoration. | Pass at code level. |
| Failed picker/startup returns radio ownership to server | `BrowserRadioSource.start()` calls `stop()` on failure; the store then clears browser state and calls `/connection/claim`. | Pass for ordinary picker/null and source-start failures. |
| DM/sync behavior after browser connection | WebBLE and WebSerial share `BrowserRadioSource` after transport open. The focused suite covers initial sync, DM ACK ordering, private sessions, offline sync replay, and disconnect cleanup. | Pass for transport-independent logic. |
| Disconnect and subsequent connection | A device-side `disconnected` event calls `stop()` and reports an error; a subsequent UI start builds a fresh source. | Code path exists; see blocker below for rejected GATT setup. |

## Finding — follow-up required

**#89 — WebBLE: surface GATT initialization failures instead of timing out**

`meshcore.js` constructs `WebBleConnection` and starts async `init()` without
awaiting or catching it. Its `open()` method resolves before GATT connection,
service discovery, and notification setup complete. MeshKeep then waits for a
future `connected` event for 20 seconds. If that initialization rejects, the
browser can receive an unhandled rejection and MeshKeep eventually reports only
`Timed out waiting for the radio to answer`.

This is a real failure-path defect for a rejected GATT connection; it prevents
an affirmative code-level conclusion for WebBLE setup/reconnect error handling.
The issue requires prompt error propagation, ownership/lock cleanup coverage,
and deterministic rejected-initialization/reconnect tests. No code was changed
by this review.

## Reproducible evidence

```sh
npm run test --workspace @meshkeep/web -- browser-radio.test.ts
npm run test --workspace @meshkeep/web -- store.test.ts
npm run test --workspace @meshkeep/server -- meshcore-canary.test.ts
npm run typecheck --workspace @meshkeep/web
npm run build --workspace @meshkeep/web
git diff --check
```

Results collected during the review:

- `browser-radio.test.ts`: 14 tests passed.
- `store.test.ts`: 48 tests passed.
- `meshcore-canary.test.ts`: 6 tests passed.
- Web typecheck and Web production build passed; the build emitted its existing
  large-chunk warning for the main bundle.
- `git diff --check` passed.
- Repository-wide `npm run lint -- --quiet` remains blocked by an unrelated,
  pre-existing working-tree error in
  `packages/server/src/webhooks/worker.ts:7`: unused `WebhookSubscription`.

The focused tests do not exercise an actual browser chooser or physical GATT
stack, and no hardware result is claimed here.
