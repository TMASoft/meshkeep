import {
  CONTACT_TYPE_FROM_ADV,
  type ConnectionState,
  type Contact,
  type Message,
  type SelfInfo,
} from "@meshkeep/shared";
import type MeshConnection from "@liamcottle/meshcore.js/src/connection/connection.js";
import { api } from "../api/client";

/**
 * Drives a companion radio attached to THIS browser (WebSerial or WebBluetooth,
 * Chromium + secure context only) while the server stays the source of truth:
 * everything the radio tells us is synced back through /api/v1/ingest/* and
 * flows to the UI over the normal WebSocket. When the server is unreachable,
 * sync-backs queue in IndexedDB and flush later. A "private session" skips
 * sync-back entirely — traffic then only exists in this tab (negative ids).
 */

export type BrowserRadioKind = "webserial" | "webble";

const GEO_SCALE = 1e6;
const BATTERY_POLL_MS = 5 * 60_000;
const QUEUE_FLUSH_MS = 30_000;

export function browserRadioSupport(kind: BrowserRadioKind): string | null {
  if (!window.isSecureContext) {
    return "Needs HTTPS or localhost (secure context)";
  }
  if (kind === "webserial" && !("serial" in navigator)) {
    return "Web Serial is only available in Chromium-based browsers";
  }
  if (kind === "webble" && !("bluetooth" in navigator)) {
    return "Web Bluetooth is only available in Chromium-based browsers";
  }
  return null;
}

export interface BrowserRadioCallbacks {
  onState(state: ConnectionState, error: string | null): void;
  /** Private-session traffic that never reaches the server (synthetic negative ids). */
  onLocalMessage(message: Message): void;
  onLocalStatus(id: number, status: Message["status"]): void;
  onSelf(self: SelfInfo): void;
  onBattery(batteryMilliVolts: number): void;
}

interface PendingAck {
  ackCrc: number;
  localId: number;
  item: IngestItem;
}

interface IngestItem {
  kind: "dm" | "channel";
  contactKey?: string;
  channelIdx?: number;
  direction: "in" | "out";
  text: string;
  senderTimestamp: number;
  pathLen?: number | null;
  status?: Message["status"];
  authorPrefix?: string | null;
}

export class BrowserRadioSource {
  private connection: MeshConnection | null = null;
  private constants: typeof import("@liamcottle/meshcore.js/src/constants.js")["default"] | null = null;
  private bufferUtils: typeof import("@liamcottle/meshcore.js/src/buffer_utils.js")["default"] | null = null;
  private releaseLock: (() => void) | null = null;
  private contacts: Contact[] = [];
  private pendingAcks: PendingAck[] = [];
  private draining = false;
  private drainAgain = false;
  private batteryTimer: number | null = null;
  private flushTimer: number | null = null;
  private nextLocalId = -1;
  private stopped = false;

  constructor(
    readonly kind: BrowserRadioKind,
    readonly privateSession: boolean,
    private readonly callbacks: BrowserRadioCallbacks,
  ) {}

  async start(): Promise<void> {
    this.callbacks.onState("connecting", null);
    try {
      this.releaseLock = await acquireRadioLock();

      const [{ default: Constants }, { default: BufferUtils }] = await Promise.all([
        import("@liamcottle/meshcore.js/src/constants.js"),
        import("@liamcottle/meshcore.js/src/buffer_utils.js"),
      ]);
      this.constants = Constants;
      this.bufferUtils = BufferUtils;

      const connection =
        this.kind === "webserial"
          ? await (await import("@liamcottle/meshcore.js/src/connection/web_serial_connection.js")).default.open()
          : await (await import("@liamcottle/meshcore.js/src/connection/web_ble_connection.js")).default.open();
      if (!connection) {
        throw new Error("No device selected");
      }
      this.patchSignedPlain(connection);
      this.connection = connection;

      await this.waitForConnected(connection, 20_000);
      this.attachListeners(connection);

      this.callbacks.onState("syncing", null);
      await this.initialSync(connection);

      this.batteryTimer = window.setInterval(() => void this.pollBattery(), BATTERY_POLL_MS);
      if (!this.privateSession) {
        this.flushTimer = window.setInterval(() => void this.flushQueue(), QUEUE_FLUSH_MS);
        void this.flushQueue();
      }
      this.callbacks.onState("connected", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Browser radio connection failed";
      await this.stop();
      this.callbacks.onState("error", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.batteryTimer !== null) window.clearInterval(this.batteryTimer);
    if (this.flushTimer !== null) window.clearInterval(this.flushTimer);
    this.batteryTimer = null;
    this.flushTimer = null;
    if (this.connection) {
      const connection = this.connection;
      this.connection = null;
      try {
        await connection.close();
      } catch {
        // already closed
      }
    }
    this.releaseLock?.();
    this.releaseLock = null;
    this.callbacks.onState("disconnected", null);
  }

  /**
   * Signed-plain frames (room server posts) carry 4 raw author-pubkey bytes
   * between the timestamp and the text; the library decodes the whole
   * remainder as UTF-8 and mangles them. Re-parse the frame ourselves and
   * surface the prefix as `signedAuthorPrefix` (mirrors the server transport).
   */
  private patchSignedPlain(connection: MeshConnection): void {
    const Constants = this.constants!;
    const BufferUtils = this.bufferUtils!;
    connection.onContactMsgRecvResponse = function (reader) {
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
  }

  private waitForConnected(connection: MeshConnection, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("Timed out waiting for the radio to answer")),
        timeoutMs,
      );
      connection.once("connected", () => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
  }

  private attachListeners(connection: MeshConnection): void {
    const Push = this.constants!.PushCodes;

    connection.on("disconnected", () => {
      if (this.stopped) return;
      void this.stop().then(() => {
        this.callbacks.onState("error", "Radio disconnected");
      });
    });

    connection.on(Push.MsgWaiting, () => {
      void this.drainMessages();
    });

    connection.on(Push.SendConfirmed, (...args: unknown[]) => {
      const push = args[0] as { ackCode: number };
      void this.handleSendConfirmed(push.ackCode);
    });

    const refreshContacts = () => void this.syncContacts(connection).catch(() => {});
    connection.on(Push.Advert, refreshContacts);
    connection.on(Push.NewAdvert, refreshContacts);
    connection.on(Push.PathUpdated, refreshContacts);
  }

  private async initialSync(connection: MeshConnection): Promise<void> {
    const BufferUtils = this.bufferUtils!;
    const rawSelf = await connection.getSelfInfo(10_000);
    let device: { firmwareVer: number; firmware_build_date: string; manufacturerModel: string } | null = null;
    try {
      device = await connection.deviceQuery(this.constants!.SupportedCompanionProtocolVersion);
    } catch {
      // older firmware; not fatal
    }
    const self: SelfInfo = {
      publicKey: BufferUtils.bytesToHex(rawSelf.publicKey),
      name: rawSelf.name,
      type: rawSelf.type,
      txPower: rawSelf.txPower,
      maxTxPower: rawSelf.maxTxPower,
      lat: rawSelf.advLat === 0 ? null : rawSelf.advLat / GEO_SCALE,
      lon: rawSelf.advLon === 0 ? null : rawSelf.advLon / GEO_SCALE,
      radioFreq: rawSelf.radioFreq,
      radioBw: rawSelf.radioBw,
      radioSf: rawSelf.radioSf,
      radioCr: rawSelf.radioCr,
      firmwareVer: device?.firmwareVer ?? null,
      firmwareBuildDate: device?.firmware_build_date ?? null,
      manufacturerModel: device ? normalizeDeviceText(device.manufacturerModel) : null,
    };
    this.callbacks.onSelf(self);
    if (!this.privateSession) {
      await this.postOrQueue("self", { self });
    }

    await this.syncContacts(connection);
    await this.drainMessages();
    await this.pollBattery();
  }

  private async syncContacts(connection: MeshConnection): Promise<void> {
    const BufferUtils = this.bufferUtils!;
    const raw = await connection.getContacts();
    this.contacts = raw.map((r) => ({
      publicKey: BufferUtils.bytesToHex(r.publicKey),
      name: r.advName,
      type: CONTACT_TYPE_FROM_ADV[r.type] ?? "none",
      flags: r.flags,
      outPathLen: r.outPathLen,
      lat: r.advLat === 0 ? null : r.advLat / GEO_SCALE,
      lon: r.advLon === 0 ? null : r.advLon / GEO_SCALE,
      lastAdvert: r.lastAdvert,
      lastSeen: null,
    }));
    if (!this.privateSession) {
      await this.postOrQueue("contacts", { contacts: this.contacts });
    }
  }

  private async drainMessages(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    const connection = this.connection;
    if (!connection) return;
    this.draining = true;
    try {
      const items: IngestItem[] = [];
      while (true) {
        const next = await connection.syncNextMessage();
        if (!next) break;
        if (next.contactMessage) {
          const m = next.contactMessage;
          const prefixHex = this.bufferUtils!.bytesToHex(m.pubKeyPrefix);
          const contact = this.contacts.find((c) => c.publicKey.startsWith(prefixHex));
          items.push({
            kind: "dm",
            contactKey: contact?.publicKey ?? prefixHex.padEnd(64, "0"),
            direction: "in",
            text: m.text,
            senderTimestamp: m.senderTimestamp,
            pathLen: m.pathLen === 0xff ? null : m.pathLen,
            status: "sent",
            authorPrefix: m.signedAuthorPrefix ?? null,
          });
        } else if (next.channelMessage) {
          const m = next.channelMessage;
          items.push({
            kind: "channel",
            channelIdx: m.channelIdx,
            direction: "in",
            text: m.text,
            senderTimestamp: m.senderTimestamp,
            pathLen: m.pathLen === 0xff ? null : m.pathLen,
            status: "sent",
          });
        }
      }
      if (items.length) {
        if (this.privateSession) {
          for (const item of items) this.callbacks.onLocalMessage(this.toLocalMessage(item));
        } else {
          // synced mode: the server broadcasts message.new over the WebSocket
          await this.postOrQueue("messages", { messages: items });
        }
      }
    } finally {
      this.draining = false;
      if (this.drainAgain) {
        this.drainAgain = false;
        void this.drainMessages();
      }
    }
  }

  async sendDirectMessage(contactKey: string, text: string, cli = false): Promise<Message> {
    const connection = this.requireConnection();
    const sent = await connection.sendTextMessage(
      this.bufferUtils!.hexToBytes(contactKey),
      text,
      cli ? this.constants!.TxtTypes.CliData : this.constants!.TxtTypes.Plain,
    );
    const item: IngestItem = {
      kind: "dm",
      contactKey,
      direction: "out",
      text,
      senderTimestamp: Math.floor(Date.now() / 1000),
      status: "sent",
    };
    const message = await this.recordOutgoing(item);
    this.pendingAcks.push({ ackCrc: sent.expectedAckCrc, localId: message.id, item });
    return message;
  }

  async sendChannelMessage(channelIdx: number, text: string): Promise<Message> {
    const connection = this.requireConnection();
    await connection.sendChannelTextMessage(channelIdx, text);
    return this.recordOutgoing({
      kind: "channel",
      channelIdx,
      direction: "out",
      text,
      senderTimestamp: Math.floor(Date.now() / 1000),
      status: "sent",
    });
  }

  async sendAdvert(flood: boolean): Promise<void> {
    const connection = this.requireConnection();
    if (flood) {
      await connection.sendFloodAdvert();
    } else {
      await connection.sendZeroHopAdvert();
    }
  }

  private async recordOutgoing(item: IngestItem): Promise<Message> {
    if (!this.privateSession) {
      try {
        const result = await api<{ messages: Message[] }>("/ingest/messages", {
          method: "POST",
          body: JSON.stringify({ messages: [item] }),
        });
        if (result.messages[0]) return result.messages[0];
      } catch {
        await queuePut({ kind: "messages", payload: { messages: [item] } });
      }
    }
    const local = this.toLocalMessage(item);
    this.callbacks.onLocalMessage(local);
    return local;
  }

  private async handleSendConfirmed(ackCode: number): Promise<void> {
    const index = this.pendingAcks.findIndex((p) => p.ackCrc === ackCode);
    if (index < 0) return;
    const [pending] = this.pendingAcks.splice(index, 1);
    if (this.privateSession) {
      this.callbacks.onLocalStatus(pending.localId, "delivered");
      return;
    }
    // re-post with the final status; the server upgrades the duplicate and
    // pushes message.status over the WebSocket
    await this.postOrQueue("messages", { messages: [{ ...pending.item, status: "delivered" as const }] });
  }

  private async pollBattery(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    try {
      const battery = await connection.getBatteryVoltage();
      this.callbacks.onBattery(battery.batteryMilliVolts);
    } catch {
      // transient; next poll will retry
    }
  }

  private toLocalMessage(item: IngestItem): Message {
    const contact = item.contactKey ? this.contacts.find((c) => c.publicKey === item.contactKey) : null;
    return {
      id: this.nextLocalId--,
      kind: item.kind,
      contactKey: item.contactKey ?? null,
      contactName: contact?.name ?? null,
      channelIdx: item.channelIdx ?? null,
      channelName: null,
      direction: item.direction,
      text: item.text,
      senderTimestamp: item.senderTimestamp,
      pathLen: item.pathLen ?? null,
      status: item.status ?? "sent",
      createdAt: Math.floor(Date.now() / 1000),
      authorPrefix: item.authorPrefix ?? null,
      authorName: item.authorPrefix
        ? this.contacts.find((c) => c.publicKey.startsWith(item.authorPrefix!))?.name ?? null
        : null,
    };
  }

  private async postOrQueue(kind: "messages" | "contacts" | "self", payload: unknown): Promise<void> {
    try {
      await api(`/ingest/${kind}`, { method: "POST", body: JSON.stringify(payload) });
    } catch {
      await queuePut({ kind, payload });
    }
  }

  /** Replay queued sync-backs (server was unreachable when they happened). */
  private async flushQueue(): Promise<void> {
    const entries = await queueTakeAll();
    for (const entry of entries) {
      try {
        await api(`/ingest/${entry.kind}`, { method: "POST", body: JSON.stringify(entry.payload) });
      } catch {
        await queuePut(entry); // still down; try again next flush
        return;
      }
    }
  }

  private requireConnection(): MeshConnection {
    if (!this.connection) throw new Error("Browser radio is not connected");
    return this.connection;
  }
}

function normalizeDeviceText(value: string): string {
  return value.split("\0").filter(Boolean).join(" ").trim();
}

/** One radio per browser profile: taken via the Web Locks API, held until stop(). */
function acquireRadioLock(): Promise<() => void> {
  if (!("locks" in navigator)) {
    return Promise.resolve(() => {});
  }
  return new Promise((resolve, reject) => {
    navigator.locks
      .request("meshkeep-browser-radio", { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error("Another tab is already driving a radio from this browser"));
          return;
        }
        return new Promise<void>((release) => {
          resolve(() => release());
        });
      })
      .catch(reject);
  });
}

// ---- tiny IndexedDB queue for offline sync-backs ----

interface QueueEntry {
  kind: "messages" | "contacts" | "self";
  payload: unknown;
}

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("meshkeep", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("ingest-queue", { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

async function queuePut(entry: QueueEntry): Promise<void> {
  try {
    const db = await openQueueDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("ingest-queue", "readwrite");
      tx.objectStore("ingest-queue").add(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("queue write failed"));
    });
    db.close();
  } catch {
    // storage unavailable (private browsing etc.) — sync-back is lost but the
    // radio session keeps working
  }
}

async function queueTakeAll(): Promise<QueueEntry[]> {
  try {
    const db = await openQueueDb();
    const entries = await new Promise<QueueEntry[]>((resolve, reject) => {
      const tx = db.transaction("ingest-queue", "readwrite");
      const store = tx.objectStore("ingest-queue");
      const read = store.getAll();
      read.onsuccess = () => {
        store.clear();
        resolve(read.result as QueueEntry[]);
      };
      read.onerror = () => reject(read.error ?? new Error("queue read failed"));
    });
    db.close();
    return entries;
  } catch {
    return [];
  }
}
