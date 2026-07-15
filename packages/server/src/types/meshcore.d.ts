declare module "@liamcottle/meshcore.js" {
  export class Connection {
    on(event: string | number, callback: (...args: any[]) => void): void;
    off(event: string | number, callback: (...args: any[]) => void): void;
    once(event: string | number, callback: (...args: any[]) => void): void;
    emit(event: string | number, ...data: any[]): void;

    close(): Promise<void> | void;
    connect(...args: any[]): Promise<void>;

    // subclass plumbing (implemented/called by custom transports)
    onFrameReceived(frameData: Uint8Array | number[]): void;
    onConnected(): Promise<void>;
    onDisconnected(): void;
    sendToRadioFrame(data: Uint8Array | number[]): Promise<void>;

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
        outPath: Uint8Array;
        advName: string;
        lastAdvert: number;
        advLat: number;
        advLon: number;
        lastMod: number;
      }>
    >;
    getBatteryVoltage(): Promise<{ batteryMilliVolts: number }>;
    getDeviceTime(): Promise<{ epochSecs: number }>;
    setDeviceTime(epochSecs: number): Promise<unknown>;
    syncDeviceTime(): Promise<void>;
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
          channelData?: unknown;
        }
      | null
    >;
    sendTextMessage(
      contactPublicKey: Uint8Array,
      text: string,
      type?: number,
    ): Promise<{ result: number; expectedAckCrc: number; estTimeout: number }>;
    sendChannelTextMessage(channelIdx: number, text: string): Promise<void>;
    sendFloodAdvert(): Promise<void>;
    sendZeroHopAdvert(): Promise<void>;
    setAdvertName(name: string): Promise<void>;
    setAdvertLatLong(latitude: number, longitude: number): Promise<void>;
    setTxPower(txPower: number): Promise<void>;
    setRadioParams(radioFreq: number, radioBw: number, radioSf: number, radioCr: number): Promise<void>;
    removeContact(pubKey: Uint8Array): Promise<void>;
    resetPath(pubKey: Uint8Array): Promise<void>;
    login(contactPublicKey: Uint8Array, password: string, extraTimeoutMillis?: number): Promise<unknown>;
    getStatus(
      contactPublicKey: Uint8Array,
      extraTimeoutMillis?: number,
    ): Promise<{
      batt_milli_volts: number;
      curr_tx_queue_len: number;
      noise_floor: number;
      last_rssi: number;
      n_packets_recv: number;
      n_packets_sent: number;
      total_air_time_secs: number;
      total_up_time_secs: number;
      n_sent_flood: number;
      n_sent_direct: number;
      n_recv_flood: number;
      n_recv_direct: number;
      err_events: number;
      last_snr: number;
      n_direct_dups: number;
      n_flood_dups: number;
    }>;
    getTelemetry(
      contactPublicKey: Uint8Array,
      extraTimeoutMillis?: number,
    ): Promise<{ reserved: number; pubKeyPrefix: Uint8Array; lppSensorData: Uint8Array }>;
    importContact(advertPacketBytes: Uint8Array): Promise<unknown>;
    exportContact(pubKey?: Uint8Array | null): Promise<{ advertPacketBytes: Uint8Array }>;
    shareContact(pubKey: Uint8Array): Promise<unknown>;
    sendCommandGetChannel(channelIdx: number): Promise<void>;
    sendCommandSetChannel(channelIdx: number, name: string, secret: Uint8Array): Promise<void>;
    sendCommandAppStart(): Promise<void>;
    /** Frame parser for ContactMsgRecv; replaceable per-instance (see patchSignedPlain). */
    onContactMsgRecvResponse(reader: FrameReader): void;
  }

  /** Subset of the library's internal BufferReader passed to on*Response handlers. */
  export interface FrameReader {
    readByte(): number;
    readBytes(count: number): Uint8Array;
    readUInt32LE(): number;
    readString(): string;
  }

  export class NodeJSSerialConnection extends Connection {
    constructor(path: string);
    connect(): Promise<void>;
  }

  export class TCPConnection extends Connection {
    constructor(host: string, port: number);
    connect(): Promise<void>;
  }

  export class WebSerialConnection extends Connection {}
  export class WebBleConnection extends Connection {}

  export const Constants: {
    SupportedCompanionProtocolVersion: number;
    SerialFrameTypes: { Incoming: number; Outgoing: number };
    Ble: { ServiceUuid: string; CharacteristicUuidRx: string; CharacteristicUuidTx: string };
    CommandCodes: Record<string, number>;
    ResponseCodes: Record<string, number>;
    PushCodes: Record<string, number>;
    ErrorCodes: Record<string, number>;
    AdvType: { None: number; Chat: number; Repeater: number; Room: number };
    SelfAdvertTypes: { ZeroHop: number; Flood: number };
    TxtTypes: { Plain: number; CliData: number; SignedPlain: number };
    StatsTypes: { Core: number; Radio: number; Packets: number };
  };

  export class CayenneLpp {
    static parse(bytes: Uint8Array): Array<{ channel: number; type: number; value: number | Record<string, number> }>;
  }

  export const BufferUtils: {
    areBuffersEqual(a: Uint8Array, b: Uint8Array): boolean;
    bytesToHex(bytes: Uint8Array): string;
    hexToBytes(hex: string): Uint8Array;
  };
}
