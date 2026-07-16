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

  it("passes unknown BLE errors and non-BLE transports through", () => {
    expect(describeConnectError("ble", "le-connection-abort-by-local")).toBe("le-connection-abort-by-local");
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
