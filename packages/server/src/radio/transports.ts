import { NodeJSSerialConnection, TCPConnection, type Connection } from "@liamcottle/meshcore.js";
import type { ConnectionSettings } from "@meshkeep/shared";
import { BleNodeConnection } from "./ble-connection.js";

export interface TransportTarget {
  transport: "serial" | "tcp" | "ble";
  target: string;
}

export function describeTarget(settings: ConnectionSettings): TransportTarget | null {
  switch (settings.connection) {
    case "serial":
      if (!settings.serialPort) throw new Error("a serial device path is required for serial connections");
      return { transport: "serial", target: settings.serialPort };
    case "tcp":
      if (!settings.tcpHost) throw new Error("a TCP host is required for tcp connections");
      return { transport: "tcp", target: `${settings.tcpHost}:${settings.tcpPort}` };
    case "ble":
      if (!settings.bleAddress) throw new Error("a BLE MAC address is required for ble connections");
      return { transport: "ble", target: settings.bleAddress };
    default:
      return null;
  }
}

export function createConnection(settings: ConnectionSettings): Connection {
  switch (settings.connection) {
    case "serial":
      // baud rate is fixed at 115200 by the companion firmware / meshcore.js
      return new NodeJSSerialConnection(settings.serialPort!);
    case "tcp":
      return new TCPConnection(settings.tcpHost!, settings.tcpPort);
    case "ble":
      return new BleNodeConnection(settings.bleAddress!);
    default:
      throw new Error(`Cannot create a connection for transport "${settings.connection}"`);
  }
}
