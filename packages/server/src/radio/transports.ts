import { NodeJSSerialConnection, TCPConnection, type Connection } from "@liamcottle/meshcore.js";
import type { ServerConfig } from "../config.js";

export interface TransportTarget {
  transport: "serial" | "tcp" | "ble";
  target: string;
}

export function describeTarget(config: ServerConfig): TransportTarget | null {
  switch (config.connection) {
    case "serial":
      if (!config.serialPort) throw new Error("MESHKEEP_SERIAL_PORT is required for serial connections");
      return { transport: "serial", target: config.serialPort };
    case "tcp":
      if (!config.tcpHost) throw new Error("MESHKEEP_TCP_HOST is required for tcp connections");
      return { transport: "tcp", target: `${config.tcpHost}:${config.tcpPort}` };
    case "ble":
      throw new Error("Server-side BLE is not implemented yet (planned: node-ble over the host D-Bus socket)");
    default:
      return null;
  }
}

export function createConnection(config: ServerConfig): Connection {
  switch (config.connection) {
    case "serial":
      // baud rate is fixed at 115200 by the companion firmware / meshcore.js
      return new NodeJSSerialConnection(config.serialPort!);
    case "tcp":
      return new TCPConnection(config.tcpHost!, config.tcpPort);
    default:
      throw new Error(`Cannot create a connection for transport "${config.connection}"`);
  }
}
