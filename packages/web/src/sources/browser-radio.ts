import { type Channel, type ConnectionState, type Contact, type Message, type SelfInfo } from "@meshkeep/shared";
import type MeshConnection from "@liamcottle/meshcore.js/src/connection/connection.js";
import { api } from "../api/client";
import {
  contactFromRaw,
  flushQueueOnce,
  ingestItemFromSync,
  localMessageFromItem,
  newIngestionId,
  selfInfoFromRaw,
  type IngestItem,
  type IngestQueue,
  type QueueEntry,
} from "./browser-radio-core";

/**
 * Drives a companion radio attached to THIS browser (WebSerial or WebBluetooth,
 * Chromium + secure context only) while the server stays the source of truth:
 * everything the radio tells us is synced back through /api/v1/ingest/* and
 * flows to the UI over the normal WebSocket. When the server is unreachable,
 * sync-backs queue in IndexedDB and flush later. A "private session" skips
 * sync-back entirely — traffic then only exists in this tab (negative ids).
 *
 * The pure mapping/queue logic lives in browser-radio-core.ts; the I/O edges
 * (device transport, lock, queue storage, ingest POSTs) are injectable for
 * tests via BrowserRadioDeps.
 */

export type BrowserRadioKind = "webserial" | "webble";

const BATTERY_POLL_MS = 5 * 60_000;
const QUEUE_FLUSH_MS = 30_000;
const MAX_CHANNELS = 8;
const CHANNEL_READ_TIMEOUT_MS = 3_000;

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
  /** Server ingestion response, including rows replayed from the offline queue. */
  onSyncedMessage(message: Message): void;
  onSelf(self: SelfInfo): void;
  onBattery(batteryMilliVolts: number): void;
}

/** I/O edges, replaceable in tests (defaults talk to the real browser APIs). */
export interface BrowserRadioDeps {
  openConnection(kind: BrowserRadioKind): Promise<MeshConnection | null>;
  acquireLock(): Promise<() => void>;
  queue: IngestQueue;
  postIngest(kind: QueueEntry["kind"], payload: unknown): Promise<unknown>;
}

const defaultDeps: BrowserRadioDeps = {
  async openConnection(kind) {
    const connection =
      kind === "webserial"
        ? await (await import("@liamcottle/meshcore.js/src/connection/web_serial_connection.js")).default.open()
        : await (await import("@liamcottle/meshcore.js/src/connection/web_ble_connection.js")).default.open();
    return connection ?? null;
  },
  acquireLock: acquireRadioLock,
  queue: { put: queuePut, takeAll: queueTakeAll },
  postIngest(kind, payload) {
    return api(`/ingest/${kind}`, { method: "POST", body: JSON.stringify(payload) });
  },
};

interface PendingAck {
  ackCrc: number | null;
  earlyAckCode: number | null;
  localId: number | null;
  item: IngestItem;
  timeout: ReturnType<typeof setTimeout> | null;
  finished: Promise<void>;
  finish: () => void;
}

export class BrowserRadioSource {
  private connection: MeshConnection | null = null;
  private constants: typeof import("@liamcottle/meshcore.js/src/constants.js")["default"] | null = null;
  private bufferUtils: typeof import("@liamcottle/meshcore.js/src/buffer_utils.js")["default"] | null = null;
  private releaseLock: (() => void) | null = null;
  private contacts: Contact[] = [];
  private pendingAck: PendingAck | null = null;
  private directSendQueue: Promise<void> = Promise.resolve();
  private draining = false;
  private drainAgain = false;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private nextLocalId = -1;
  private stopped = false;
  private readonly deps: BrowserRadioDeps;

  constructor(
    readonly kind: BrowserRadioKind,
    readonly privateSession: boolean,
    private readonly callbacks: BrowserRadioCallbacks,
    deps: Partial<BrowserRadioDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async start(): Promise<void> {
    this.callbacks.onState("connecting", null);
    try {
      this.releaseLock = await this.deps.acquireLock();

      const [{ default: Constants }, { default: BufferUtils }] = await Promise.all([
        import("@liamcottle/meshcore.js/src/constants.js"),
        import("@liamcottle/meshcore.js/src/buffer_utils.js"),
      ]);
      this.constants = Constants;
      this.bufferUtils = BufferUtils;

      const connection = await this.deps.openConnection(this.kind);
      if (!connection) {
        throw new Error("No device selected");
      }
      this.patchSignedPlain(connection);
      this.connection = connection;

      await this.waitForConnected(connection, 20_000);
      this.attachListeners(connection);

      this.callbacks.onState("syncing", null);
      await this.initialSync(connection);

      this.batteryTimer = setInterval(() => void this.pollBattery(), BATTERY_POLL_MS);
      if (!this.privateSession) {
        this.flushTimer = setInterval(() => void this.flushQueue(), QUEUE_FLUSH_MS);
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
    if (this.batteryTimer !== null) clearInterval(this.batteryTimer);
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
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
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the radio to answer")), timeoutMs);
      connection.once("connected", () => {
        clearTimeout(timeout);
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
    const rawSelf = await connection.getSelfInfo(10_000);
    let device: { firmwareVer: number; firmware_build_date: string; manufacturerModel: string } | null = null;
    try {
      device = await connection.deviceQuery(this.constants!.SupportedCompanionProtocolVersion);
    } catch {
      // older firmware; not fatal
    }
    const self = selfInfoFromRaw(rawSelf, device);
    this.callbacks.onSelf(self);
    if (!this.privateSession) {
      await this.postOrQueue("self", { self });
    }

    await this.syncContacts(connection);
    await this.drainMessages();
    await this.pollBattery();
  }

  private async syncContacts(connection: MeshConnection): Promise<void> {
    const raw = await connection.getContacts();
    this.contacts = raw.map(contactFromRaw);
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
        const item = ingestItemFromSync(next, this.contacts);
        if (item) items.push(item);
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
    const item: IngestItem = {
      kind: "dm",
      contactKey,
      direction: "out",
      text,
      senderTimestamp: Math.floor(Date.now() / 1000),
      status: "sent",
      ingestionId: newIngestionId(),
    };
    return this.runDirectSend(item, async (pending) => {
      const sent = await connection.sendTextMessage(
        this.bufferUtils!.hexToBytes(contactKey),
        text,
        cli ? this.constants!.TxtTypes.CliData : this.constants!.TxtTypes.Plain,
      );
      pending.ackCrc = sent.expectedAckCrc;
      const message = await this.recordOutgoing(item);
      pending.localId = message.id;

      if (pending.earlyAckCode === sent.expectedAckCrc) {
        await this.finishPendingAck(pending, true);
        return { ...message, status: "delivered" };
      }

      pending.timeout = setTimeout(() => void this.finishPendingAck(pending, false), sent.estTimeout);
      return message;
    });
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
      ingestionId: newIngestionId(),
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

  /**
   * Read this radio's live channel slots. Browser mode must present the
   * browser radio's state, never the standby server's stored channel list.
   */
  async getChannels(): Promise<Channel[]> {
    const connection = this.requireConnection();
    const channels: Channel[] = [];
    for (let idx = 0; idx < MAX_CHANNELS; idx++) {
      const channel = await this.readChannel(connection, idx, CHANNEL_READ_TIMEOUT_MS);
      if (channel) channels.push(channel);
    }
    return channels;
  }

  /** GetChannel has no promise helper in meshcore.js; wrap the events (mirrors the server). */
  private readChannel(connection: MeshConnection, idx: number, timeoutMs: number): Promise<Channel | null> {
    const Constants = this.constants!;
    const BufferUtils = this.bufferUtils!;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        connection.off(Constants.ResponseCodes.ChannelInfo, onInfo);
        connection.off(Constants.ResponseCodes.Err, onErr);
        clearTimeout(timeout);
      };
      const onInfo = (...args: unknown[]) => {
        const info = args[0] as { channelIdx: number; name: string; secret: Uint8Array };
        if (info.channelIdx !== idx) return;
        cleanup();
        // an empty name marks an unset slot
        resolve(info.name ? { idx: info.channelIdx, name: info.name, secret: BufferUtils.bytesToHex(info.secret) } : null);
      };
      const onErr = () => {
        cleanup();
        reject(new Error(`Radio rejected reading channel ${idx}`));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out reading channel ${idx}`));
      }, timeoutMs);
      connection.on(Constants.ResponseCodes.ChannelInfo, onInfo);
      connection.on(Constants.ResponseCodes.Err, onErr);
      void connection.sendCommandGetChannel(idx);
    });
  }

  private async recordOutgoing(item: IngestItem): Promise<Message> {
    if (!this.privateSession) {
      try {
        const result = (await this.deps.postIngest("messages", { messages: [item] })) as { messages: Message[] };
        this.reportIngestResult("messages", result);
        if (result.messages[0]) return result.messages[0];
      } catch {
        await this.deps.queue.put({ kind: "messages", payload: { messages: [item] } });
      }
    }
    const local = this.toLocalMessage(item);
    this.callbacks.onLocalMessage(local);
    return local;
  }

  private async handleSendConfirmed(ackCode: number): Promise<void> {
    const pending = this.pendingAck;
    if (!pending) return;
    // A push can arrive before sendTextMessage resolves with expectedAckCrc.
    if (pending.ackCrc === null) {
      pending.earlyAckCode = ackCode;
      return;
    }
    if (pending.ackCrc !== ackCode) return;
    await this.finishPendingAck(pending, true);
  }

  private runDirectSend(item: IngestItem, operation: (pending: PendingAck) => Promise<Message>): Promise<Message> {
    let resolveResult!: (message: Message) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<Message>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const queued = this.directSendQueue.then(async () => {
      const pending = this.createPendingAck(item);
      this.pendingAck = pending;
      try {
        resolveResult(await operation(pending));
        await pending.finished;
      } catch (error) {
        await this.finishPendingAck(pending, false);
        rejectResult(error);
      }
    });
    this.directSendQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private createPendingAck(item: IngestItem): PendingAck {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ackCrc: null, earlyAckCode: null, localId: null, item, timeout: null, finished, finish };
  }

  private async finishPendingAck(pending: PendingAck, delivered: boolean): Promise<void> {
    if (this.pendingAck !== pending) return;
    this.pendingAck = null;
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    if (delivered && pending.localId !== null) {
      this.callbacks.onLocalStatus(pending.localId, "delivered");
      if (!this.privateSession) {
        // Re-post the same stable ingestion ID so the server updates only this
        // record, even after an offline retry.
        await this.postOrQueue("messages", { messages: [{ ...pending.item, status: "delivered" as const }] });
      }
    }
    pending.finish();
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
    return localMessageFromItem(item, this.contacts, this.nextLocalId--, Math.floor(Date.now() / 1000));
  }

  private async postOrQueue(kind: QueueEntry["kind"], payload: unknown): Promise<void> {
    try {
      const result = await this.deps.postIngest(kind, payload);
      this.reportIngestResult(kind, result);
    } catch {
      await this.deps.queue.put({ kind, payload });
    }
  }

  /** Replay queued sync-backs (server was unreachable when they happened). */
  private async flushQueue(): Promise<void> {
    await flushQueueOnce(this.deps.queue, async (kind, payload) => {
      const result = await this.deps.postIngest(kind, payload);
      this.reportIngestResult(kind, result);
    });
  }

  private reportIngestResult(kind: QueueEntry["kind"], result: unknown): void {
    if (kind !== "messages" || !result || typeof result !== "object" || !("messages" in result)) return;
    const messages = (result as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return;
    for (const message of messages) this.callbacks.onSyncedMessage(message as Message);
  }

  private requireConnection(): MeshConnection {
    if (!this.connection) throw new Error("Browser radio is not connected");
    return this.connection;
  }
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
