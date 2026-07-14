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
  GetBatteryVoltage: 20,
  DeviceQuery: 22,
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
  BatteryVoltage: 12,
  DeviceInfo: 13,
  ChannelInfo: 18,
} as const;

const PUSH = {
  Advert: 0x80,
  SendConfirmed: 0x82,
  MsgWaiting: 0x83,
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
}

interface MockChannel {
  name: string;
  secret: Uint8Array; // 16 bytes
}

type QueuedMessage =
  | { kind: "dm"; from: MockContact; text: string; senderTimestamp: number; pathLen: number }
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

  name = "MockKeep RAK4631";
  publicKey = keyFromSeed(1);
  txPower = 22;
  advLat = 44_260_000; // Montpelier-ish, degrees * 1e6
  advLon = -72_580_000;
  radioFreq = 910_525_000;
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
    },
  ];

  channels = new Map<number, MockChannel>([[0, { name: "Public", secret: keyFromSeed(9).subarray(0, 16) }]]);

  private queue: QueuedMessage[] = [];

  constructor(options: MockRadioOptions = {}) {
    this.requestedPort = options.port ?? 5100;
    this.host = options.host ?? "127.0.0.1";
    this.echoDelayMs = options.echoDelayMs ?? 1500;
    this.log = options.log ?? (() => {});
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
  injectDirectMessage(fromName: string, text: string): void {
    const from = this.contacts.find((c) => c.name === fromName);
    if (!from) throw new Error(`no mock contact named ${fromName}`);
    this.queue.push({ kind: "dm", from, text, senderTimestamp: nowSecs(), pathLen: 0xff });
    this.pushToAll(new FrameWriter().byte(PUSH.MsgWaiting));
  }

  injectChannelMessage(channelIdx: number, text: string): void {
    this.queue.push({ kind: "channel", channelIdx, text, senderTimestamp: nowSecs(), pathLen: 1 });
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
            .str("MockKeep,RAK4631"),
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
      case CMD.GetBatteryVoltage:
        this.send(socket, new FrameWriter().byte(RESP.BatteryVoltage).u16(this.batteryMv));
        break;
      case CMD.SyncNextMessage: {
        const next = this.queue.shift();
        if (!next) {
          this.send(socket, new FrameWriter().byte(RESP.NoMoreMessages));
        } else if (next.kind === "dm") {
          this.send(
            socket,
            new FrameWriter()
              .byte(RESP.ContactMsgRecv)
              .raw(next.from.publicKey.subarray(0, 6))
              .byte(next.pathLen)
              .byte(0) // txtType plain
              .u32(next.senderTimestamp)
              .str(next.text),
          );
        } else {
          this.send(
            socket,
            new FrameWriter()
              .byte(RESP.ChannelMsgRecv)
              .int8(next.channelIdx)
              .byte(next.pathLen)
              .byte(0)
              .u32(next.senderTimestamp)
              .str(next.text),
          );
        }
        break;
      }
      case CMD.SendTxtMsg: {
        // [txtType, attempt, u32 senderTimestamp, 6b pubKeyPrefix, text]
        const senderTimestamp = body.readUInt32LE(2);
        const prefix = body.subarray(6, 12);
        const text = body.subarray(12).toString("utf8");
        const ackCrc = (senderTimestamp ^ (prefix[0] << 8) ^ text.length) >>> 0;
        this.send(socket, new FrameWriter().byte(RESP.Sent).int8(0).u32(ackCrc).u32(3000));
        const contact = this.contacts.find((c) => Buffer.from(c.publicKey.subarray(0, 6)).equals(prefix));
        this.later(this.echoDelayMs, () => {
          this.pushToAll(new FrameWriter().byte(PUSH.SendConfirmed).u32(ackCrc).u32(this.echoDelayMs));
          if (contact?.echoes) {
            this.later(this.echoDelayMs, () => {
              this.queue.push({
                kind: "dm",
                from: contact,
                text: `echo: ${text}`,
                senderTimestamp: nowSecs(),
                pathLen: 0xff,
              });
              this.pushToAll(new FrameWriter().byte(PUSH.MsgWaiting));
            });
          }
        });
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
        this.channels.set(idx, { name, secret: Uint8Array.from(secret) });
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
