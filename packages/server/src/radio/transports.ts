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

const CONTACT_MESSAGE_V3 = 0x10;
const CHANNEL_MESSAGE_V3 = 0x11;

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
 * meshcore.js does not yet parse MeshCore v3 queued-message frames. It also
 * treats signed-plain author bytes as text in legacy contact-message frames.
 * Normalize both forms to the event payloads MeshKeep already consumes.
 */
export function patchSignedPlain(connection: Connection): Connection {
  const onFrameReceived = connection.onFrameReceived;
  connection.onFrameReceived = function (frame: Uint8Array | number[]): void {
    const bytes = Uint8Array.from(frame);
    if (bytes[0] === CONTACT_MESSAGE_V3 && bytes.length >= 16) {
      const txtType = bytes[11];
      const textOffset = txtType === Constants.TxtTypes.SignedPlain ? 20 : 16;
      if (bytes.length >= textOffset) {
        this.emit(Constants.ResponseCodes.ContactMsgRecv, {
          pubKeyPrefix: bytes.slice(4, 10),
          pathLen: bytes[10],
          txtType,
          senderTimestamp: readUInt32LE(bytes, 12),
          signedAuthorPrefix: txtType === Constants.TxtTypes.SignedPlain ? BufferUtils.bytesToHex(bytes.slice(16, 20)) : null,
          text: Buffer.from(bytes.slice(textOffset)).toString("utf8"),
        });
        return;
      }
    }
    if (bytes[0] === CHANNEL_MESSAGE_V3 && bytes.length >= 11) {
      this.emit(Constants.ResponseCodes.ChannelMsgRecv, {
        channelIdx: bytes[4],
        pathLen: bytes[5],
        txtType: bytes[6],
        senderTimestamp: readUInt32LE(bytes, 7),
        text: Buffer.from(bytes.slice(11)).toString("utf8"),
      });
      return;
    }
    onFrameReceived.call(this, frame);
  };

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

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}
