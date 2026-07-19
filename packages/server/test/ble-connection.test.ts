import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// node-ble needs a live BlueZ/D-Bus; fake the session so the transport's error
// wiring is testable on any machine (issue #20 asks for exactly this).
const session = {
  dbus: new EventEmitter(),
  bluetooth: {} as Record<string, unknown>,
  destroy: vi.fn(),
};

vi.mock("node-ble", () => ({
  createBluetooth: () => ({ bluetooth: session.bluetooth, destroy: session.destroy }),
}));

const { BleNodeConnection } = await import("../src/radio/ble-connection.js");

const ADDRESS = "e5:01:46:20:3c:cb";

/** A GATT stack that reaches "connected". */
function fakeSession() {
  const dbus = new EventEmitter();
  const characteristic = () => ({
    // a rejecting write makes the post-connect deviceQuery fail fast; the base
    // class ignores that error, so connect() resolves without a network wait
    writeValueWithResponse: vi.fn().mockRejectedValue(new Error("no device")),
    startNotifications: vi.fn().mockResolvedValue(undefined),
    stopNotifications: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  });
  const device = Object.assign(new EventEmitter(), {
    isPaired: vi.fn().mockResolvedValue("true"),
    pair: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    gatt: vi.fn().mockResolvedValue({
      getPrimaryService: vi.fn().mockResolvedValue({
        getCharacteristic: vi.fn().mockImplementation(() => characteristic()),
      }),
    }),
  });
  const adapter = {
    isDiscovering: vi.fn().mockResolvedValue(false),
    startDiscovery: vi.fn().mockResolvedValue(undefined),
    stopDiscovery: vi.fn().mockResolvedValue(undefined),
    waitDevice: vi.fn().mockResolvedValue(device),
  };
  session.dbus = dbus;
  session.bluetooth = { dbus, defaultAdapter: vi.fn().mockResolvedValue(adapter) };
  session.destroy = vi.fn();
  return { dbus, adapter, device };
}

describe("BleNodeConnection D-Bus error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("survives a bus error on an established link and reports a disconnect", async () => {
    const { dbus } = fakeSession();
    const connection = new BleNodeConnection(ADDRESS);
    const disconnected = vi.fn();
    connection.on("disconnected", disconnected);

    await connection.connect();

    // the exact failure that killed the process on 2026-07-19
    expect(() => dbus.emit("error", new Error("Cannot send message, stream is closed"))).not.toThrow();
    // meshcore.js's EventEmitter dispatches through setTimeout, so listeners
    // run on the next tick rather than inside emit()
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
  });

  it("reports the D-Bus cause rather than a generic failure when connect fails", async () => {
    const { dbus } = fakeSession();
    session.bluetooth = {
      dbus,
      defaultAdapter: vi.fn().mockImplementation(async () => {
        // a dying bus makes the in-flight call fail with something that names
        // no cause; the bus error is the actionable one
        dbus.emit("error", new Error("Cannot send message, stream is closed"));
        throw new Error("connection closed");
      }),
    };

    const connection = new BleNodeConnection(ADDRESS);
    await expect(connection.connect()).rejects.toThrow(/stream is closed/);
  });

  it("stops listening once closed, so a later bus error is not attributed to it", async () => {
    const { dbus } = fakeSession();
    const connection = new BleNodeConnection(ADDRESS);
    const disconnected = vi.fn();
    connection.on("disconnected", disconnected);

    await connection.connect();
    await connection.close();

    expect(dbus.listenerCount("error")).toBe(0);
    // unguarded again: the bus error throws rather than reaching a closed
    // connection, and no phantom disconnect is reported for it
    expect(() => dbus.emit("error", new Error("late"))).toThrow(/late/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("releases discovery and tears down even when the bus destroy throws", async () => {
    const { adapter } = fakeSession();
    session.destroy = vi.fn(() => {
      throw new Error("Cannot send message, stream is closed");
    });

    const connection = new BleNodeConnection(ADDRESS);
    await connection.connect();
    // close() runs on every failure path — a throwing destroy must not escape
    await expect(connection.close()).resolves.toBeUndefined();
    // discovery was started for the connect and stopped again, never leaked
    expect(adapter.startDiscovery).toHaveBeenCalledOnce();
    expect(adapter.stopDiscovery).toHaveBeenCalledOnce();
  });
});
