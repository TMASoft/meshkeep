import type { ConnectionTransport } from "@meshkeep/shared";

/**
 * Reconnect pacing per transport, kept pure so the policy is unit-testable
 * without BlueZ or hardware (issue #20).
 *
 * BLE attempts are expensive — each one spins up a discovery window and GATT
 * resolution through BlueZ and occupies the adapter — so BLE starts slower
 * and caps far higher than the serial/tcp loop.
 */
export interface ReconnectPolicy {
  minDelayMs: number;
  maxDelayMs: number;
}

const SERIAL_TCP_POLICY: ReconnectPolicy = { minDelayMs: 2_000, maxDelayMs: 60_000 };
const BLE_POLICY: ReconnectPolicy = { minDelayMs: 5_000, maxDelayMs: 300_000 };

export function reconnectPolicyFor(transport: ConnectionTransport): ReconnectPolicy {
  return transport === "ble" ? BLE_POLICY : SERIAL_TCP_POLICY;
}

/** Exponential backoff step within the policy's bounds. */
export function nextReconnectDelay(currentMs: number, policy: ReconnectPolicy): number {
  return Math.min(Math.max(currentMs * 2, policy.minDelayMs), policy.maxDelayMs);
}

/**
 * Turn a raw BLE failure into something actionable: "the radio is gone" and
 * "BlueZ/D-Bus is gone" need different fixes, but node-ble surfaces both as
 * bare Error messages. Non-BLE transports pass through untouched.
 */
export function describeConnectError(transport: ConnectionTransport, message: string): string {
  if (transport !== "ble") return message;
  if (/system_bus_socket|dbus|disconnected before authentication|EACCES.*bus/i.test(message)) {
    return `BlueZ/D-Bus unreachable (${message}) — check the D-Bus socket mount and that bluetoothd is running`;
  }
  if (/no available adapters|adapter not found/i.test(message)) {
    return `no Bluetooth adapter (${message}) — bluetoothd may be down or the adapter unpowered`;
  }
  if (/operation timed out|device not found|timed out connecting/i.test(message)) {
    return `radio not found (${message}) — is it powered, in range, and not claimed by another client?`;
  }
  return message;
}
