import {
  BufferUtils,
  Constants,
  NodeJSSerialConnection,
  TCPConnection,
  type Connection,
  type FrameReader,
} from "@liamcottle/meshcore.js";
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
      return patchSignedPlain(new NodeJSSerialConnection(settings.serialPort!));
    case "tcp":
      return patchSignedPlain(new TCPConnection(settings.tcpHost!, settings.tcpPort));
    case "ble":
      return patchSignedPlain(new BleNodeConnection(settings.bleAddress!));
    default:
      throw new Error(`Cannot create a connection for transport "${settings.connection}"`);
  }
}

/**
 * Signed-plain frames (room server posts) carry 4 raw author-pubkey bytes
 * between the timestamp and the text. meshcore.js decodes the whole remainder
 * as UTF-8, which mangles those bytes, so re-parse the frame ourselves and
 * surface the prefix as `signedAuthorPrefix` (8 hex chars).
 */
export function patchSignedPlain(connection: Connection): Connection {
  connection.onContactMsgRecvResponse = function (reader: FrameReader) {
    const pubKeyPrefix = reader.readBytes(6);
    const pathLen = reader.readByte();
    const txtType = reader.readByte();
    const senderTimestamp = reader.readUInt32LE();
    const signedAuthorPrefix =
      txtType === Constants.TxtTypes.SignedPlain ? BufferUtils.bytesToHex(reader.readBytes(4)) : null;
    this.emit(Constants.ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix,
      pathLen,
      txtType,
      senderTimestamp,
      signedAuthorPrefix,
      text: reader.readString(),
    });
  };
  return connection;
}
