/**
 * Browser-only subpath imports of @liamcottle/meshcore.js. The package's main
 * entry re-exports the NodeJS transports too (serialport/net), which must not
 * end up in the web bundle — so the web app imports the individual modules and
 * declares them here (upstream ships no types).
 */

declare module "@liamcottle/meshcore.js/src/connection/connection.js" {
  export default class Connection {
    on(event: string | number, callback: (...args: unknown[]) => void): void;
    off(event: string | number, callback: (...args: unknown[]) => void): void;
    once(event: string | number, callback: (...args: unknown[]) => void): void;

    close(): Promise<void> | void;

    getSelfInfo(timeoutMillis?: number | null): Promise<{
      type: number;
      txPower: number;
      maxTxPower: number;
      publicKey: Uint8Array;
      advLat: number;
      advLon: number;
      manualAddContacts: number;
      radioFreq: number;
      radioBw: number;
      radioSf: number;
      radioCr: number;
      name: string;
    }>;
    deviceQuery(appTargetVer: number): Promise<{
      firmwareVer: number;
      firmware_build_date: string;
      manufacturerModel: string;
    }>;
    getContacts(): Promise<
      Array<{
        publicKey: Uint8Array;
        type: number;
        flags: number;
        outPathLen: number;
        advName: string;
        lastAdvert: number;
        advLat: number;
        advLon: number;
      }>
    >;
    getBatteryVoltage(): Promise<{ batteryMilliVolts: number }>;
    getDeviceTime(): Promise<{ epochSecs: number }>;
    syncDeviceTime(): Promise<void>;
    emit(event: string | number, ...data: unknown[]): void;
    /** Frame parser for ContactMsgRecv; replaceable per-instance (see patchSignedPlain). */
    onContactMsgRecvResponse(reader: FrameReader): void;
    syncNextMessage(): Promise<
      | {
          contactMessage?: {
            pubKeyPrefix: Uint8Array;
            pathLen: number;
            txtType: number;
            senderTimestamp: number;
            /** Author pubkey prefix (8 hex chars) on SignedPlain frames; set by patchSignedPlain. */
            signedAuthorPrefix?: string | null;
            text: string;
          };
          channelMessage?: {
            channelIdx: number;
            pathLen: number;
            txtType: number;
            senderTimestamp: number;
            text: string;
          };
        }
      | null
    >;
    sendTextMessage(
      contactPublicKey: Uint8Array,
      text: string,
      type?: number,
    ): Promise<{ result: number; expectedAckCrc: number; estTimeout: number }>;
    sendChannelTextMessage(channelIdx: number, text: string): Promise<void>;
    /** Fire-and-forget GetChannel command; the radio answers with a ChannelInfo response event. */
    sendCommandGetChannel(channelIdx: number): Promise<void>;
    sendFloodAdvert(): Promise<void>;
    sendZeroHopAdvert(): Promise<void>;
  }

  /** Subset of the library's internal BufferReader passed to on*Response handlers. */
  export interface FrameReader {
    readByte(): number;
    readBytes(count: number): Uint8Array;
    readUInt32LE(): number;
    readString(): string;
  }
}

declare module "@liamcottle/meshcore.js/src/connection/web_serial_connection.js" {
  import Connection from "@liamcottle/meshcore.js/src/connection/connection.js";
  export default class WebSerialConnection extends Connection {
    /** Prompts the user to pick a serial port; null when unsupported/cancelled. */
    static open(): Promise<WebSerialConnection | null>;
  }
}

declare module "@liamcottle/meshcore.js/src/connection/web_ble_connection.js" {
  import Connection from "@liamcottle/meshcore.js/src/connection/connection.js";
  export default class WebBleConnection extends Connection {
    /** Prompts the user to pick a BLE device; null/undefined when unsupported/cancelled. */
    static open(): Promise<WebBleConnection | null | undefined>;
  }
}

declare module "@liamcottle/meshcore.js/src/constants.js" {
  const Constants: {
    SupportedCompanionProtocolVersion: number;
    Ble: { ServiceUuid: string; CharacteristicUuidRx: string; CharacteristicUuidTx: string };
    ResponseCodes: Record<string, number>;
    PushCodes: Record<string, number>;
    TxtTypes: { Plain: number; CliData: number; SignedPlain: number };
    AdvType: { None: number; Chat: number; Repeater: number; Room: number };
  };
  export default Constants;
}

declare module "@liamcottle/meshcore.js/src/buffer_utils.js" {
  const BufferUtils: {
    bytesToHex(bytes: Uint8Array): string;
    hexToBytes(hex: string): Uint8Array;
    areBuffersEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  export default BufferUtils;
}
