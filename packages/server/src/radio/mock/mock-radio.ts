import { createServer, type Server, type Socket } from "node:net";

/**
 * A fake MeshCore companion radio, reachable over TCP with the same framed
 * protocol real firmware speaks over USB serial (and that ser2net exposes).
 * meshcore.js TCPConnection connects to it unmodified, so the entire
 * production stack can be exercised without hardware.
 *
 * Personality: contacts echo every DM back after a short delay; channel
 * messages get an echo on the same channel.
 */

const CMD = {
  AppStart: 1,
  SendTxtMsg: 2,
  SendChannelTxtMsg: 3,
  GetContacts: 4,
  GetDeviceTime: 5,
  SetDeviceTime: 6,
  SendSelfAdvert: 7,
  SetAdvertName: 8,
  AddUpdateContact: 9,
  SyncNextMessage: 10,
  SetRadioParams: 11,
  SetTxPower: 12,
  ResetPath: 13,
  SetAdvertLatLon: 14,
  RemoveContact: 15,
  ExportContact: 17,
  ImportContact: 18,
  GetBatteryVoltage: 20,
  SendLogin: 26,
  SendStatusReq: 27,
  DeviceQuery: 22,
  SendTelemetryReq: 39,
  GetChannel: 31,
  SetChannel: 32,
  SetOtherParams: 38,
} as const;

const RESP = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  SelfInfo: 5,
  Sent: 6,
  ContactMsgRecv: 7,
  ChannelMsgRecv: 8,
  CurrTime: 9,
  NoMoreMessages: 10,
  ExportContact: 11,
  BatteryVoltage: 12,
  DeviceInfo: 13,
  ChannelInfo: 18,
} as const;

const RESP_V3 = {
  ContactMsgRecv: 0x10,
  ChannelMsgRecv: 0x11,
} as const;

const PUSH = {
  Advert: 0x80,
  SendConfirmed: 0x82,
  MsgWaiting: 0x83,
  LoginSuccess: 0x85,
  StatusResponse: 0x87,
  TelemetryResponse: 0x8b,
} as const;

class FrameWriter {
  private bytes: number[] = [];

  byte(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  int8(value: number): this {
    return this.byte(value < 0 ? value + 256 : value);
  }

  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
    return this;
  }

  i16(value: number): this {
    return this.u16(value < 0 ? value + 0x10000 : value);
  }

  u32(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  i32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value);
    this.bytes.push(...buffer);
    return this;
  }

  raw(data: Uint8Array | number[]): this {
    this.bytes.push(...data);
    return this;
  }

  str(value: string): this {
    return this.raw(new TextEncoder().encode(value));
  }

  cstr(value: string, length: number): this {
    const out = new Uint8Array(length);
    const encoded = new TextEncoder().encode(value);
    out.set(encoded.subarray(0, length - 1));
    return this.raw(out);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

interface MockContact {
  publicKey: Uint8Array; // 32 bytes
  type: number;
  flags: number;
  outPathLen: number;
  name: string;
  lastAdvert: number;
  advLat: number; // degrees * 1e6
  advLon: number;
  echoes: boolean;
  /** repeater/room admin password; login required before CLI/status/room posts */
  password?: string;
}

interface MockChannel {
  name: string;
  secret: Uint8Array; // 16 bytes
}

type QueuedMessage =
  | {
      kind: "dm";
      from: MockContact;
      text: string;
      senderTimestamp: number;
      pathLen: number;
      txtType?: number;
      authorPrefix?: Uint8Array; // 4 bytes, present on signed-plain room posts
    }
  | { kind: "channel"; channelIdx: number; text: string; senderTimestamp: number; pathLen: number };

function keyFromSeed(seed: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (seed * 37 + i * 11) & 0xff;
  return key;
}

const nowSecs = () => Math.floor(Date.now() / 1000);

export interface MockRadioOptions {
  port?: number;
  host?: string;
  echoDelayMs?: number;
  log?: (line: string) => void;
  messageProtocolVersion?: 1 | 3;
}

export class MockRadio {
  readonly host: string;
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private readBuffers = new Map<Socket, Buffer>();
  private echoDelayMs: number;
  private log: (line: string) => void;
  private requestedPort: number;
  private timers = new Set<NodeJS.Timeout>();
  private readonly messageProtocolVersion: 1 | 3;

  name = "MockKeep RAK4631";
  publicKey = keyFromSeed(1);
  txPower = 22;
  advLat = 44_260_000; // Montpelier-ish, degrees * 1e6
  advLon = -72_580_000;
  radioFreq = 910_525; // kHz — real companion firmware reports frequency in kHz
  radioBw = 250_000;
  radioSf = 10;
  radioCr = 5;
  batteryMv = 4111;

  contacts: MockContact[] = [
    {
      publicKey: keyFromSeed(2),
      type: 1,
      flags: 0,
      outPathLen: -1,
      name: "Mock Alice",
      lastAdvert: nowSecs() - 300,
      advLat: 44_265_000,
      advLon: -72_575_000,
      echoes: true,
    },
    {
      publicKey: keyFromSeed(3),
      type: 1,
      flags: 0,
      outPathLen: 2,
      name: "Mock Bob",
      lastAdvert: nowSecs() - 3600,
      advLat: 0,
      advLon: 0,
      echoes: true,
    },
    {
      publicKey: keyFromSeed(4),
      type: 2,
      flags: 0,
      outPathLen: 1,
      name: "Mock Repeater",
      lastAdvert: nowSecs() - 60,
      advLat: 44_300_000,
      advLon: -72_600_000,
      echoes: false,
      password: "letmein",
    },
    {
      publicKey: keyFromSeed(5),
      type: 3,
      flags: 0,
      outPathLen: 1,
      name: "Mock Room",
      lastAdvert: nowSecs() - 120,
      advLat: 0,
      advLon: 0,
      echoes: false,
      password: "letmein",
    },
  ];

  /** contacts (by pubkey hex) the app has successfully logged in to */
  private loggedIn = new Set<string>();

  channels = new Map<number, MockChannel>([[0, { name: "Public", secret: keyFromSeed(9).subarray(0, 16) }]]);

  private queue: QueuedMessage[] = [];

  constructor(options: MockRadioOptions = {}) {
    this.requestedPort = options.port ?? 5100;
    this.host = options.host ?? "127.0.0.1";
    this.echoDelayMs = options.echoDelayMs ?? 1500;
    this.log = options.log ?? (() => {});
    this.messageProtocolVersion = options.messageProtocolVersion ?? 1;
  }

  get port(): number {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.port : this.requestedPort;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => this.onSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.requestedPort, this.host, () => resolve());
    });
    this.log(`mock radio listening on ${this.host}:${this.port}`);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  /** Queue an incoming message and notify connected clients, as real firmware would. */
  injectDirectMessage(fromName: string, text: string, senderTimestamp = nowSecs()): void {
    const from = this.contacts.find((c) => c.name === fromName);
    if (!from) throw new Error(`no mock contact named ${fromName}`);
    this.queue.push({ kind: "dm", from, text, senderTimestamp, pathLen: 0xff });
    this.pushToAll(new FrameWriter().byte(PUSH.MsgWaiting));
  }

  injectChannelMessage(channelIdx: number, text: string, senderTimestamp = nowSecs()): void {
    this.queue.push({ kind: "channel", channelIdx, text, senderTimestamp, pathLen: 1 });
    this.pushToAll(new FrameWriter().byte(PUSH.MsgWaiting));
  }

  private onSocket(socket: Socket): void {
    this.sockets.add(socket);
    this.readBuffers.set(socket, Buffer.alloc(0));
    this.log("client connected");
    socket.on("data", (data) => this.onData(socket, data));
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.readBuffers.delete(socket);
      this.log("client disconnected");
    });
    socket.on("error", () => socket.destroy());
  }

  private onData(socket: Socket, data: Buffer): void {
    let buffer = Buffer.concat([this.readBuffers.get(socket) ?? Buffer.alloc(0), data]);
    // frame: 0x3c '<' (app→radio), u16le length, payload
    while (buffer.length >= 3) {
      if (buffer[0] !== 0x3c) {
        buffer = buffer.subarray(1);
        continue;
      }
      const length = buffer.readUInt16LE(1);
      if (buffer.length < 3 + length) break;
      const payload = buffer.subarray(3, 3 + length);
      buffer = buffer.subarray(3 + length);
      try {
        this.handleCommand(socket, payload);
      } catch (error) {
        this.log(`error handling command ${payload[0]}: ${String(error)}`);
        this.send(socket, new FrameWriter().byte(RESP.Err).byte(6));
      }
    }
    this.readBuffers.set(socket, buffer);
  }

  private send(socket: Socket, frame: FrameWriter): void {
    const payload = frame.toBuffer();
    const header = Buffer.alloc(3);
    header[0] = 0x3e; // '>' radio→app
    header.writeUInt16LE(payload.length, 1);
    socket.write(Buffer.concat([header, payload]));
  }

  private pushToAll(frame: FrameWriter): void {
    for (const socket of this.sockets) this.send(socket, frame);
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private handleCommand(socket: Socket, payload: Buffer): void {
    const cmd = payload[0];
    const body = payload.subarray(1);
    switch (cmd) {
      case CMD.AppStart:
        this.send(socket, this.selfInfoFrame());
        break;
      case CMD.DeviceQuery:
        this.send(
          socket,
          new FrameWriter()
            .byte(RESP.DeviceInfo)
            .int8(3) // firmwareVer
            .raw(new Uint8Array(6))
            .cstr("1 Jul 2026", 12)
            .str("MockKeep,RAK4631\0\0firmware"),
        );
        break;
      case CMD.GetContacts: {
        this.send(socket, new FrameWriter().byte(RESP.ContactsStart).u32(this.contacts.length));
        for (const contact of this.contacts) {
          this.send(socket, this.contactFrame(contact));
        }
        this.send(socket, new FrameWriter().byte(RESP.EndOfContacts).u32(nowSecs()));
        break;
      }
      case CMD.GetDeviceTime:
        this.send(socket, new FrameWriter().byte(RESP.CurrTime).u32(nowSecs()));
        break;
      case CMD.SetDeviceTime:
      case CMD.SendSelfAdvert:
      case CMD.ResetPath:
      case CMD.AddUpdateContact:
      case CMD.SetOtherParams:
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      case CMD.SetAdvertName:
        this.name = body.toString("utf8");
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      case CMD.SetAdvertLatLon:
        this.advLat = body.readInt32LE(0);
        this.advLon = body.readInt32LE(4);
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      case CMD.SetTxPower:
        this.txPower = body[0];
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      case CMD.SetRadioParams:
        this.radioFreq = body.readUInt32LE(0);
        this.radioBw = body.readUInt32LE(4);
        this.radioSf = body[8];
        this.radioCr = body[9];
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      case CMD.RemoveContact: {
        const key = body.subarray(0, 32);
        this.contacts = this.contacts.filter((c) => !Buffer.from(c.publicKey).equals(key));
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      }
      case CMD.ExportContact: {
        // empty body exports our own identity; 32-byte body exports that contact
        let packet: FrameWriter;
        if (body.length >= 32) {
          const key = body.subarray(0, 32);
          const contact = this.contacts.find((c) => Buffer.from(c.publicKey).equals(key));
          if (!contact) {
            this.send(socket, new FrameWriter().byte(RESP.Err).byte(2));
            break;
          }
          packet = this.advertPacket(contact.publicKey, contact.type, contact.advLat, contact.advLon, contact.name);
        } else {
          packet = this.advertPacket(this.publicKey, 1, this.advLat, this.advLon, this.name);
        }
        this.send(socket, new FrameWriter().byte(RESP.ExportContact).raw(packet.toBuffer()));
        break;
      }
      case CMD.ImportContact: {
        // parse the mock advert-packet layout produced by ExportContact above
        if (body.length < 41) {
          this.send(socket, new FrameWriter().byte(RESP.Err).byte(3));
          break;
        }
        const imported: MockContact = {
          publicKey: Uint8Array.from(body.subarray(0, 32)),
          type: body[32],
          flags: 0,
          outPathLen: -1,
          name: body.subarray(41).toString("utf8"),
          lastAdvert: nowSecs(),
          advLat: body.readInt32LE(33),
          advLon: body.readInt32LE(37),
          echoes: false,
        };
        this.contacts = this.contacts.filter((c) => !Buffer.from(c.publicKey).equals(body.subarray(0, 32)));
        this.contacts.push(imported);
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      }
      case CMD.GetBatteryVoltage:
        this.send(socket, new FrameWriter().byte(RESP.BatteryVoltage).u16(this.batteryMv));
        break;
      case CMD.SyncNextMessage: {
        const next = this.queue.shift();
        if (!next) {
          this.send(socket, new FrameWriter().byte(RESP.NoMoreMessages));
        } else if (next.kind === "dm") {
          const frame = new FrameWriter()
            .byte(this.messageProtocolVersion === 3 ? RESP_V3.ContactMsgRecv : RESP.ContactMsgRecv);
          if (this.messageProtocolVersion === 3) frame.int8(-12).byte(0).byte(0);
          frame
            .raw(next.from.publicKey.subarray(0, 6))
            .byte(next.pathLen)
            .byte(next.txtType ?? 0)
            .u32(next.senderTimestamp);
          if (next.authorPrefix) frame.raw(next.authorPrefix); // signed-plain: 4 raw author bytes before the text
          this.send(socket, frame.str(next.text));
        } else {
          const frame = new FrameWriter().byte(this.messageProtocolVersion === 3 ? RESP_V3.ChannelMsgRecv : RESP.ChannelMsgRecv);
          if (this.messageProtocolVersion === 3) frame.int8(-12).byte(0).byte(0);
          this.send(socket, frame.byte(next.channelIdx).byte(next.pathLen).byte(0).u32(next.senderTimestamp).str(next.text));
        }
        break;
      }
      case CMD.SendTxtMsg: {
        // [txtType, attempt, u32 senderTimestamp, 6b pubKeyPrefix, text]
        const txtType = body[0];
        const senderTimestamp = body.readUInt32LE(2);
        const prefix = body.subarray(6, 12);
        const text = body.subarray(12).toString("utf8");
        const ackCrc = (senderTimestamp ^ (prefix[0] << 8) ^ text.length) >>> 0;
        this.send(socket, new FrameWriter().byte(RESP.Sent).int8(0).u32(ackCrc).u32(3000));
        const contact = this.contacts.find((c) => Buffer.from(c.publicKey.subarray(0, 6)).equals(prefix));
        this.later(this.echoDelayMs, () => {
          this.pushToAll(new FrameWriter().byte(PUSH.SendConfirmed).u32(ackCrc).u32(this.echoDelayMs));
          const reply = contact ? this.replyFor(contact, txtType, text) : null;
          if (contact && reply !== null) {
            this.later(this.echoDelayMs, () => {
              this.queue.push({
                kind: "dm",
                from: contact,
                senderTimestamp: nowSecs(),
                pathLen: 0xff,
                ...reply,
              });
              this.pushToAll(new FrameWriter().byte(PUSH.MsgWaiting));
            });
          }
        });
        break;
      }
      case CMD.SendLogin: {
        // [32B pubkey][password]
        const key = body.subarray(0, 32);
        const password = body.subarray(32).toString("utf8");
        const contact = this.contacts.find((c) => Buffer.from(c.publicKey).equals(key));
        this.send(socket, new FrameWriter().byte(RESP.Sent).int8(0).u32(0).u32(600));
        if (contact?.password !== undefined && contact.password === password) {
          this.loggedIn.add(Buffer.from(contact.publicKey).toString("hex"));
          this.later(120, () => {
            this.pushToAll(
              new FrameWriter().byte(PUSH.LoginSuccess).byte(0).raw(contact.publicKey.subarray(0, 6)),
            );
          });
        }
        // wrong password: real servers stay silent and the app times out
        break;
      }
      case CMD.SendStatusReq: {
        const key = body.subarray(0, 32);
        const contact = this.contacts.find((c) => Buffer.from(c.publicKey).equals(key));
        this.send(socket, new FrameWriter().byte(RESP.Sent).int8(0).u32(0).u32(600));
        if (contact && this.loggedIn.has(Buffer.from(contact.publicKey).toString("hex"))) {
          this.later(120, () => {
            this.pushToAll(
              new FrameWriter()
                .byte(PUSH.StatusResponse)
                .byte(0)
                .raw(contact.publicKey.subarray(0, 6))
                .u16(4020) // batt mV
                .u16(0) // tx queue
                .i16(-105) // noise floor
                .i16(-78) // last rssi
                .u32(1234) // packets recv
                .u32(2345) // packets sent
                .u32(678) // air time secs
                .u32(86_400) // uptime secs
                .u32(100) // sent flood
                .u32(200) // sent direct
                .u32(300) // recv flood
                .u32(400) // recv direct
                .u16(2) // err events
                .i16(26) // last snr
                .u16(5) // direct dups
                .u16(7), // flood dups
            );
          });
        }
        break;
      }
      case CMD.SendTelemetryReq: {
        // [3 reserved bytes, 32-byte public key]
        const key = body.subarray(3, 35);
        const contact = this.contacts.find((c) => Buffer.from(c.publicKey).equals(key));
        this.send(socket, new FrameWriter().byte(RESP.Sent).int8(0).u32(0).u32(600));
        if (contact) {
          this.later(120, () => {
            this.pushToAll(
              new FrameWriter()
                .byte(PUSH.TelemetryResponse)
                .byte(0)
                .raw(contact.publicKey.subarray(0, 6))
                // Cayenne LPP (big-endian): ch1 voltage 4.03 V, ch2 temp 22.5 °C, ch3 humidity 61 %
                .raw(new Uint8Array([1, 116, 0x01, 0x93, 2, 103, 0x00, 0xe1, 3, 104, 122])),
            );
          });
        }
        break;
      }
      case CMD.SendChannelTxtMsg: {
        // [txtType, channelIdx, u32 senderTimestamp, text]
        const channelIdx = body[1];
        const text = body.subarray(6).toString("utf8");
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        this.later(this.echoDelayMs, () => {
          this.queue.push({
            kind: "channel",
            channelIdx,
            text: `echo: ${text}`,
            senderTimestamp: nowSecs(),
            pathLen: 2,
          });
          this.pushToAll(new FrameWriter().byte(PUSH.MsgWaiting));
        });
        break;
      }
      case CMD.GetChannel: {
        const idx = body[0];
        const channel = this.channels.get(idx);
        this.send(
          socket,
          new FrameWriter()
            .byte(RESP.ChannelInfo)
            .byte(idx)
            .cstr(channel?.name ?? "", 32)
            .raw(channel?.secret ?? new Uint8Array(16)),
        );
        break;
      }
      case CMD.SetChannel: {
        const idx = body[0];
        const name = readCString(body.subarray(1, 33));
        const secret = body.subarray(33, 49);
        if (name) {
          this.channels.set(idx, { name, secret: Uint8Array.from(secret) });
        } else {
          this.channels.delete(idx); // empty name blanks the slot
        }
        this.send(socket, new FrameWriter().byte(RESP.Ok));
        break;
      }
      default:
        this.log(`unsupported command ${cmd}`);
        this.send(socket, new FrameWriter().byte(RESP.Err).byte(1));
    }
  }

  private selfInfoFrame(): FrameWriter {
    return new FrameWriter()
      .byte(RESP.SelfInfo)
      .byte(1) // adv type chat
      .byte(this.txPower)
      .byte(22) // maxTxPower
      .raw(this.publicKey)
      .i32(this.advLat)
      .i32(this.advLon)
      .raw(new Uint8Array(3))
      .byte(0) // manualAddContacts
      .u32(this.radioFreq)
      .u32(this.radioBw)
      .byte(this.radioSf)
      .byte(this.radioCr)
      .str(this.name);
  }

  /** What a contact sends back for an incoming message, or null for silence. */
  private replyFor(
    contact: MockContact,
    txtType: number,
    text: string,
  ): { text: string; txtType?: number; authorPrefix?: Uint8Array } | null {
    const isLoggedIn = this.loggedIn.has(Buffer.from(contact.publicKey).toString("hex"));
    if (txtType === 1) {
      // CLI data — repeaters/rooms answer only when authenticated
      if (contact.password === undefined) return null;
      if (!isLoggedIn) return { text: "error: not logged in" };
      if (text === "ver") return { text: "MockCore v1.16 (mock repeater)" };
      if (text === "clock") return { text: new Date().toUTCString() };
      return { text: `ok: ${text}` };
    }
    if (contact.type === 3) {
      // room server re-broadcasts member posts as signed-plain, attributed to the author
      if (!isLoggedIn) return null;
      const author = this.contacts.find((c) => c.name === "Mock Alice") ?? contact;
      return {
        text: `room echo: ${text}`,
        txtType: 2, // TxtTypes.SignedPlain
        authorPrefix: author.publicKey.subarray(0, 4),
      };
    }
    return contact.echoes ? { text: `echo: ${text}` } : null;
  }

  /** Mock advert-packet bytes: [32B pubkey][type][i32 lat][i32 lon][name]. */
  private advertPacket(publicKey: Uint8Array, type: number, advLat: number, advLon: number, name: string): FrameWriter {
    return new FrameWriter().raw(publicKey).byte(type).i32(advLat).i32(advLon).str(name);
  }

  private contactFrame(contact: MockContact): FrameWriter {
    return new FrameWriter()
      .byte(RESP.Contact)
      .raw(contact.publicKey)
      .byte(contact.type)
      .byte(contact.flags)
      .int8(contact.outPathLen)
      .raw(new Uint8Array(64))
      .cstr(contact.name, 32)
      .u32(contact.lastAdvert)
      .i32(contact.advLat)
      .i32(contact.advLon)
      .u32(nowSecs());
  }
}

function readCString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}
