import { afterEach, describe, expect, it } from "vitest";
import WebBleConnection from "@liamcottle/meshcore.js/src/connection/web_ble_connection.js";
import { BrowserRadioSource, openWebBleConnection, type BrowserRadioCallbacks } from "../src/sources/browser-radio";

/**
 * `@liamcottle/meshcore.js`'s `WebBleConnection` starts its async `init()`
 * (GATT connect, service/characteristic discovery, notification setup) from
 * the constructor without awaiting or catching it, so `open()` resolves
 * before that work finishes (see issue #89). A rejection there used to
 * become an unhandled promise rejection while MeshKeep just saw the
 * "connected" event never arrive, surfacing only a generic 20s timeout.
 * These tests exercise the real dependency end to end — only
 * `navigator.bluetooth` is faked — to prove the real failure now surfaces
 * promptly, and that the prototype patch used to capture it is torn down
 * cleanly so it can't affect a later connection attempt.
 */

function noopCallbacks(): { callbacks: BrowserRadioCallbacks; states: { state: string; error: string | null }[] } {
  const states: { state: string; error: string | null }[] = [];
  return {
    states,
    callbacks: {
      onState: (state, error) => states.push({ state, error }),
      onLocalMessage: () => {},
      onLocalStatus: () => {},
      onSyncedMessage: () => {},
      onSelf: () => {},
      onBattery: () => {},
    },
  };
}

/** A device whose GATT connect step rejects, mirroring the issue's repro. */
function makeFailingDevice(message: string) {
  return {
    addEventListener: () => {},
    gatt: {
      connect: async () => {
        throw new Error(message);
      },
    },
  };
}

// Node's global `navigator` (Node 21+) is a getter-only accessor property,
// so a plain assignment throws; redefine it instead, and restore whatever
// was there afterwards.
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setFakeBluetooth(requestDevice: () => Promise<unknown>): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { bluetooth: { requestDevice } },
    configurable: true,
    writable: true,
  });
}

describe("WebBLE initialization (issue #89)", () => {
  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("start() rejects promptly with the real GATT error instead of the generic 20s timeout", async () => {
    setFakeBluetooth(async () => makeFailingDevice("GATT connection failed"));
    const { callbacks, states } = noopCallbacks();
    const source = new BrowserRadioSource("webble", false, callbacks);

    const startedAt = Date.now();
    await expect(source.start()).rejects.toThrow("GATT connection failed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // stop()'s cleanup emits "disconnected" before start()'s catch reports
    // the terminal "error" state (same shape as the "No device selected"
    // failure path already covered in browser-radio.test.ts).
    expect(states.at(-1)).toMatchObject({ state: "error", error: "GATT connection failed" });
  });

  it("restores WebBleConnection.prototype.init after a failed attempt, leaving no patch behind", async () => {
    const originalInit = WebBleConnection.prototype.init;
    setFakeBluetooth(async () => makeFailingDevice("GATT connection failed"));
    const connection = await openWebBleConnection();
    expect(connection).not.toBeNull();
    expect(WebBleConnection.prototype.init).toBe(originalInit);
  });
});
