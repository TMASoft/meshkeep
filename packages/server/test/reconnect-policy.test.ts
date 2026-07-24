import { describe, expect, it } from "vitest";
import {
  describeConnectError,
  nextReconnectDelay,
  reconnectPolicyFor,
  validateConnectionSettings,
} from "../src/radio/reconnect-policy.js";

describe("reconnect policy", () => {
  it("backs off BLE far more aggressively than serial/tcp", () => {
    const serial = reconnectPolicyFor("serial");
    const ble = reconnectPolicyFor("ble");
    expect(ble.minDelayMs).toBeGreaterThan(serial.minDelayMs);
    expect(ble.maxDelayMs).toBeGreaterThan(serial.maxDelayMs);
    expect(reconnectPolicyFor("tcp")).toEqual(serial);
  });

  it("doubles within the policy bounds", () => {
    const policy = reconnectPolicyFor("serial");
    let delay = policy.minDelayMs;
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      seen.push(delay);
      delay = nextReconnectDelay(delay, policy);
    }
    expect(seen[1]).toBe(policy.minDelayMs * 2);
    expect(Math.max(...seen)).toBe(policy.maxDelayMs);
  });

  it("clamps a stale zero/low delay up to the minimum", () => {
    const policy = reconnectPolicyFor("ble");
    expect(nextReconnectDelay(0, policy)).toBe(policy.minDelayMs);
  });
});

describe("describeConnectError", () => {
  it("labels D-Bus/bluetoothd problems distinctly from missing radios", () => {
    const dbus = describeConnectError("ble", "ENOENT: no such file or directory, connect /run/dbus/system_bus_socket");
    expect(dbus).toContain("BlueZ/D-Bus unreachable");
    const adapter = describeConnectError("ble", "No available adapters found");
    expect(adapter).toContain("no Bluetooth adapter");
    const gone = describeConnectError("ble", "operation timed out");
    expect(gone).toContain("radio not found");
  });

  it("labels a bus that died mid-call as a D-Bus fault, not a missing radio", () => {
    // dbus-next's wording when the socket dies under an in-flight call; it names
    // no device, so without this the UI blamed the radio for a bluetoothd restart
    const closed = describeConnectError("ble", "Cannot send message, stream is closed");
    expect(closed).toContain("BlueZ/D-Bus unreachable");
    expect(closed).toContain("bluetoothd");
  });

  it("explains a local Bluetooth connection abort and preserves unknown errors", () => {
    const localAbort = describeConnectError("ble", "le-connection-abort-by-local");
    expect(localAbort).toContain("Bluetooth adapter ended the connection");
    expect(localAbort).toContain("MeshKeep will retry");
    expect(localAbort).toContain("move the radio closer");
    expect(describeConnectError("ble", "unexpected GATT failure")).toBe("unexpected GATT failure");
    expect(describeConnectError("serial", "operation timed out")).toBe("operation timed out");
  });
});

describe("validateConnectionSettings", () => {
  const base = {
    connection: "none" as const,
    serialPort: null,
    serialBaud: 115_200,
    tcpHost: null,
    tcpPort: 5000,
    bleAddress: null,
  };

  it("accepts complete, in-range settings (and 'none')", () => {
    expect(validateConnectionSettings(base)).toBeNull();
    expect(validateConnectionSettings({ ...base, connection: "serial", serialPort: "/dev/ttyUSB0" })).toBeNull();
    expect(validateConnectionSettings({ ...base, connection: "tcp", tcpHost: "radio.local" })).toBeNull();
    expect(validateConnectionSettings({ ...base, connection: "ble", bleAddress: "aa:bb:cc:dd:ee:ff" })).toBeNull();
  });

  it("flags missing targets as permanent configuration errors", () => {
    expect(validateConnectionSettings({ ...base, connection: "serial" })).toContain("serial port");
    expect(validateConnectionSettings({ ...base, connection: "tcp" })).toContain("host");
    expect(validateConnectionSettings({ ...base, connection: "ble" })).toContain("device address");
  });

  it("flags out-of-range and malformed values", () => {
    expect(
      validateConnectionSettings({ ...base, connection: "serial", serialPort: "/dev/ttyUSB0", serialBaud: 0 }),
    ).toContain("baud");
    expect(
      validateConnectionSettings({ ...base, connection: "tcp", tcpHost: "radio.local", tcpPort: 70_000 }),
    ).toContain("tcp port");
    expect(
      validateConnectionSettings({ ...base, connection: "ble", bleAddress: "not-a-mac" }),
    ).toContain("BLE address");
  });
});
