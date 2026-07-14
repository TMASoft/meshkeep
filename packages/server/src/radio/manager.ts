import { BufferUtils, Constants, type Connection } from "@liamcottle/meshcore.js";
import {
  CONTACT_TYPE_FROM_ADV,
  type AppStatus,
  type Channel,
  type ConnectionState,
  type Contact,
  type Message,
  type SelfInfo,
} from "@meshkeep/shared";
import type { ServerConfig } from "../config.js";
import type { Bus } from "../bus.js";
import { getSetting, setSetting, type Db } from "../db/index.js";
import { Store } from "../db/store.js";
import { createConnection, describeTarget } from "./transports.js";

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CLOCK_DRIFT_TOLERANCE_SECS = 30;
const BATTERY_POLL_MS = 5 * 60_000;
const MAX_CHANNELS = 8;

/** Latitude/longitude are transported as degrees * 1e6 signed integers. */
const GEO_SCALE = 1e6;
function fromGeoInt(value: number): number | null {
  if (value === 0) return null;
  return value / GEO_SCALE;
}

/**
 * Owns the single connection to the companion radio. Everything the radio
 * tells us is persisted through Store and re-broadcast on the Bus.
 */
export class ConnectionManager {
  readonly store: Store;
  private connection: Connection | null = null;
  private state: ConnectionState = "disconnected";
  private lastError: string | null = null;
  private connectedAt: number | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private batteryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private draining = false;
  private drainAgain = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly appVersion: string,
  ) {
    this.store = new Store(db);
  }

  getState(): ConnectionState {
    return this.state;
  }

  isStandby(): boolean {
    return getSetting<boolean>(this.db, "connection.standby") === true;
  }

  status(): AppStatus {
    const target = this.config.connection && this.config.connection !== "none" ? describeTargetSafe(this.config) : null;
    return {
      connection: {
        state: this.state,
        transport: this.config.connection ?? "none",
        target,
        lastError: this.lastError,
        connectedAt: this.connectedAt,
      },
      self: this.store.getSelf(),
      batteryMilliVolts: this.store.latestBatteryMv(),
      counts: this.store.counts(),
      version: this.appVersion,
    };
  }

  async start(): Promise<void> {
    if (!this.config.connection || this.config.connection === "none") {
      this.setState("disconnected", "no radio transport configured");
      return;
    }
    if (this.isStandby()) {
      this.setState("standby", null);
      return;
    }
    await this.connect();
  }

  /** Release the radio (e.g. so a browser can claim it). Survives restarts. */
  async release(): Promise<void> {
    setSetting(this.db, "connection.standby", true);
    await this.teardown();
    this.setState("standby", null);
  }

  /** Re-claim the radio after a release. */
  async claim(): Promise<void> {
    setSetting(this.db, "connection.standby", false);
    if (this.state === "standby" || this.state === "disconnected" || this.state === "error") {
      await this.connect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
    this.setState("disconnected", null);
  }

  private async teardown(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.batteryTimer) {
      clearInterval(this.batteryTimer);
      this.batteryTimer = null;
    }
    if (this.connection) {
      const connection = this.connection;
      this.connection = null;
      try {
        await connection.close();
      } catch {
        // already closed
      }
    }
    this.connectedAt = null;
  }

  private setState(state: ConnectionState, error: string | null): void {
    this.state = state;
    this.lastError = error;
    this.bus.publish({ type: "status.changed", status: this.status() });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connection) return;
    this.setState("connecting", null);
    try {
      const connection = createConnection(this.config);
      this.connection = connection;
      this.attachListeners(connection);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`timed out connecting after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS,
        );
        connection.once("connected", () => {
          clearTimeout(timeout);
          resolve();
        });
        connection.connect().catch((error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.setState("syncing", null);
      await this.initialSync(connection);

      this.connectedAt = Math.floor(Date.now() / 1000);
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.setState("connected", null);

      this.batteryTimer = setInterval(() => {
        void this.pollBattery();
      }, BATTERY_POLL_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "connect failed");
      console.error(`[radio] connect failed: ${message}`);
      await this.teardown();
      this.setState("error", message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.isStandby() || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    console.log(`[radio] reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private attachListeners(connection: Connection): void {
    connection.on("disconnected", () => {
      if (this.connection !== connection) return;
      console.log("[radio] disconnected");
      void this.teardown().then(() => {
        if (!this.stopped && !this.isStandby()) {
          this.setState("error", "connection lost");
          this.scheduleReconnect();
        }
      });
    });

    connection.on(Constants.PushCodes.MsgWaiting, () => {
      void this.drainMessages();
    });

    connection.on(Constants.PushCodes.SendConfirmed, (push: { ackCode: number; roundTrip: number }) => {
      const message = this.store.markDeliveredByAck(push.ackCode);
      if (message) {
        this.bus.publish({ type: "message.status", id: message.id, status: "delivered" });
      }
    });

    connection.on(Constants.PushCodes.Advert, (push: { publicKey: Uint8Array }) => {
      // firmware auto-added/updated a contact; re-pull the contact list
      void this.refreshContacts().catch(() => {});
      const key = BufferUtils.bytesToHex(push.publicKey);
      this.store.touchContactSeen(key);
    });

    connection.on(Constants.PushCodes.NewAdvert, (advert: RawContact) => {
      const contact = rawContactToContact(advert);
      this.store.upsertContact(contact);
      this.bus.publish({ type: "contact.updated", contact });
    });

    connection.on(Constants.PushCodes.PathUpdated, (push: { publicKey: Uint8Array }) => {
      void this.refreshContacts().catch(() => {});
    });
  }

  private async initialSync(connection: Connection): Promise<void> {
    // 1. identify ourselves / fetch self info
    const rawSelf = await connection.getSelfInfo(10_000);
    let device: { firmwareVer: number; firmware_build_date: string; manufacturerModel: string } | null = null;
    try {
      device = await connection.deviceQuery(Constants.SupportedCompanionProtocolVersion);
    } catch {
      // older firmware may not answer; not fatal
    }
    const self: SelfInfo = {
      publicKey: BufferUtils.bytesToHex(rawSelf.publicKey),
      name: rawSelf.name,
      type: rawSelf.type,
      txPower: rawSelf.txPower,
      maxTxPower: rawSelf.maxTxPower,
      lat: fromGeoInt(rawSelf.advLat),
      lon: fromGeoInt(rawSelf.advLon),
      radioFreq: rawSelf.radioFreq,
      radioBw: rawSelf.radioBw,
      radioSf: rawSelf.radioSf,
      radioCr: rawSelf.radioCr,
      firmwareVer: device?.firmwareVer ?? null,
      firmwareBuildDate: device?.firmware_build_date ?? null,
      manufacturerModel: device?.manufacturerModel ?? null,
    };
    this.store.saveSelf(self);
    this.bus.publish({ type: "self.updated", self });

    // 2. fix clock drift (messages are timestamped by the device)
    try {
      const deviceTime = await connection.getDeviceTime();
      const drift = Math.abs(deviceTime.epochSecs - Math.floor(Date.now() / 1000));
      if (drift > CLOCK_DRIFT_TOLERANCE_SECS) {
        console.log(`[radio] device clock drifted ${drift}s; syncing`);
        await connection.syncDeviceTime();
      }
    } catch (error) {
      console.warn("[radio] could not check device time", error);
    }

    // 3. contacts and channels
    await this.refreshContacts();
    await this.refreshChannels();

    // 4. drain any messages queued while we were away
    await this.drainMessages();

    // 5. battery snapshot
    await this.pollBattery();
  }

  async refreshContacts(): Promise<Contact[]> {
    const connection = this.requireConnection();
    const rawContacts = await connection.getContacts();
    const contacts = rawContacts.map(rawContactToContact);
    for (const contact of contacts) {
      this.store.upsertContact(contact);
      this.bus.publish({ type: "contact.updated", contact });
    }
    return contacts;
  }

  async refreshChannels(): Promise<Channel[]> {
    const connection = this.requireConnection();
    const channels: Channel[] = [];
    for (let idx = 0; idx < MAX_CHANNELS; idx++) {
      const channel = await getChannelInfo(connection, idx);
      if (channel) {
        channels.push(channel);
        this.store.upsertChannel(channel);
      }
    }
    return channels;
  }

  /**
   * Pull queued messages off the device one at a time. Guarded so a push
   * arriving mid-drain triggers one more pass instead of a concurrent one.
   */
  async drainMessages(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    const connection = this.connection;
    if (!connection) return;
    this.draining = true;
    try {
      while (true) {
        const next = await connection.syncNextMessage();
        if (!next) break;
        this.handleIncoming(next);
      }
    } catch (error) {
      console.error("[radio] failed draining messages", error);
    } finally {
      this.draining = false;
      if (this.drainAgain) {
        this.drainAgain = false;
        void this.drainMessages();
      }
    }
  }

  private handleIncoming(
    next: NonNullable<Awaited<ReturnType<Connection["syncNextMessage"]>>>,
  ): void {
    let message: Message | null = null;
    if (next.contactMessage) {
      const m = next.contactMessage;
      const prefixHex = BufferUtils.bytesToHex(m.pubKeyPrefix);
      const contact = this.store.findContactByPrefix(prefixHex);
      if (contact) this.store.touchContactSeen(contact.publicKey);
      message = this.store.insertMessage({
        kind: "dm",
        contactKey: contact?.publicKey ?? prefixHex,
        direction: "in",
        text: m.text,
        senderTimestamp: m.senderTimestamp,
        pathLen: m.pathLen === 0xff ? null : m.pathLen,
        status: "sent",
      });
    } else if (next.channelMessage) {
      const m = next.channelMessage;
      message = this.store.insertMessage({
        kind: "channel",
        channelIdx: m.channelIdx,
        direction: "in",
        text: m.text,
        senderTimestamp: m.senderTimestamp,
        pathLen: m.pathLen === 0xff ? null : m.pathLen,
        status: "sent",
      });
    }
    if (message) {
      this.bus.publish({ type: "message.new", message });
    }
  }

  async sendDirectMessage(contactKey: string, text: string): Promise<Message> {
    const connection = this.requireConnection();
    const pubKey = BufferUtils.hexToBytes(contactKey);
    const senderTimestamp = Math.floor(Date.now() / 1000);
    const stored = this.store.insertMessage({
      kind: "dm",
      contactKey,
      direction: "out",
      text,
      senderTimestamp,
      status: "pending",
    });
    if (!stored) throw new Error("duplicate message");
    try {
      const sent = await connection.sendTextMessage(pubKey, text, Constants.TxtTypes.Plain);
      this.db_setAck(stored.id, sent.expectedAckCrc);
      this.store.setMessageStatus(stored.id, "sent");
      this.bus.publish({ type: "message.status", id: stored.id, status: "sent" });
      return { ...stored, status: "sent" };
    } catch (error) {
      this.store.setMessageStatus(stored.id, "failed");
      this.bus.publish({ type: "message.status", id: stored.id, status: "failed" });
      throw error instanceof Error ? error : new Error("radio rejected the message");
    }
  }

  async sendChannelMessage(channelIdx: number, text: string): Promise<Message> {
    const connection = this.requireConnection();
    const senderTimestamp = Math.floor(Date.now() / 1000);
    const stored = this.store.insertMessage({
      kind: "channel",
      channelIdx,
      direction: "out",
      text,
      senderTimestamp,
      status: "pending",
    });
    if (!stored) throw new Error("duplicate message");
    try {
      await connection.sendChannelTextMessage(channelIdx, text);
      this.store.setMessageStatus(stored.id, "sent");
      this.bus.publish({ type: "message.status", id: stored.id, status: "sent" });
      return { ...stored, status: "sent" };
    } catch (error) {
      this.store.setMessageStatus(stored.id, "failed");
      this.bus.publish({ type: "message.status", id: stored.id, status: "failed" });
      throw error instanceof Error ? error : new Error("radio rejected the message");
    }
  }

  async sendAdvert(flood: boolean): Promise<void> {
    const connection = this.requireConnection();
    if (flood) {
      await connection.sendFloodAdvert();
    } else {
      await connection.sendZeroHopAdvert();
    }
  }

  async setChannel(idx: number, name: string, secretHex: string): Promise<Channel> {
    const connection = this.requireConnection();
    const secret = BufferUtils.hexToBytes(secretHex);
    if (secret.length !== 16) throw new Error("channel secret must be 16 bytes of hex");
    await sendSetChannel(connection, idx, name, secret);
    const channel = { idx, name, secret: secretHex };
    this.store.upsertChannel(channel);
    return channel;
  }

  async setDeviceSettings(patch: {
    name?: string;
    lat?: number;
    lon?: number;
    txPower?: number;
    radioFreq?: number;
    radioBw?: number;
    radioSf?: number;
    radioCr?: number;
  }): Promise<SelfInfo> {
    const connection = this.requireConnection();
    const self = this.store.getSelf();
    if (!self) throw new Error("self info not synced yet");
    if (patch.name !== undefined) {
      await connection.setAdvertName(patch.name);
    }
    if (patch.lat !== undefined && patch.lon !== undefined) {
      await connection.setAdvertLatLong(Math.round(patch.lat * GEO_SCALE), Math.round(patch.lon * GEO_SCALE));
    }
    if (patch.txPower !== undefined) {
      await connection.setTxPower(patch.txPower);
    }
    if (
      patch.radioFreq !== undefined ||
      patch.radioBw !== undefined ||
      patch.radioSf !== undefined ||
      patch.radioCr !== undefined
    ) {
      await connection.setRadioParams(
        patch.radioFreq ?? self.radioFreq,
        patch.radioBw ?? self.radioBw,
        patch.radioSf ?? self.radioSf,
        patch.radioCr ?? self.radioCr,
      );
    }
    const updated: SelfInfo = {
      ...self,
      name: patch.name ?? self.name,
      lat: patch.lat ?? self.lat,
      lon: patch.lon ?? self.lon,
      txPower: patch.txPower ?? self.txPower,
      radioFreq: patch.radioFreq ?? self.radioFreq,
      radioBw: patch.radioBw ?? self.radioBw,
      radioSf: patch.radioSf ?? self.radioSf,
      radioCr: patch.radioCr ?? self.radioCr,
    };
    this.store.saveSelf(updated);
    this.bus.publish({ type: "self.updated", self: updated });
    return updated;
  }

  async removeContact(contactKey: string): Promise<void> {
    const connection = this.requireConnection();
    await connection.removeContact(BufferUtils.hexToBytes(contactKey));
    this.store.removeContact(contactKey);
  }

  async resetContactPath(contactKey: string): Promise<void> {
    const connection = this.requireConnection();
    await connection.resetPath(BufferUtils.hexToBytes(contactKey));
  }

  private async pollBattery(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    try {
      const battery = await connection.getBatteryVoltage();
      this.store.recordTelemetry(battery.batteryMilliVolts);
      this.bus.publish({
        type: "telemetry",
        batteryMilliVolts: battery.batteryMilliVolts,
        ts: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      console.warn("[radio] battery poll failed", error);
    }
  }

  private db_setAck(messageId: number, ackCrc: number): void {
    this.db.prepare("UPDATE messages SET ack_crc = ? WHERE id = ?").run(ackCrc, messageId);
  }

  private requireConnection(): Connection {
    if (!this.connection || (this.state !== "connected" && this.state !== "syncing")) {
      throw new RadioUnavailableError(`radio is ${this.state}`);
    }
    return this.connection;
  }
}

export class RadioUnavailableError extends Error {}

interface RawContact {
  publicKey: Uint8Array;
  type: number;
  flags: number;
  outPathLen: number;
  advName: string;
  lastAdvert: number;
  advLat: number;
  advLon: number;
}

function rawContactToContact(raw: RawContact): Contact {
  return {
    publicKey: BufferUtils.bytesToHex(raw.publicKey),
    name: raw.advName,
    type: CONTACT_TYPE_FROM_ADV[raw.type] ?? "none",
    flags: raw.flags,
    outPathLen: raw.outPathLen,
    lat: fromGeoInt(raw.advLat),
    lon: fromGeoInt(raw.advLon),
    lastAdvert: raw.lastAdvert,
    lastSeen: null,
  };
}

/** GetChannel has no promise helper in meshcore.js; wrap the events ourselves. */
function getChannelInfo(connection: Connection, idx: number): Promise<Channel | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      connection.off(Constants.ResponseCodes.ChannelInfo, onInfo);
      connection.off(Constants.ResponseCodes.Err, onErr);
      clearTimeout(timeout);
    };
    const onInfo = (info: { channelIdx: number; name: string; secret: Uint8Array }) => {
      if (info.channelIdx !== idx) return;
      cleanup();
      if (!info.name) {
        resolve(null); // unset channel slot
        return;
      }
      resolve({ idx: info.channelIdx, name: info.name, secret: BufferUtils.bytesToHex(info.secret) });
    };
    const onErr = () => {
      cleanup();
      resolve(null);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out reading channel ${idx}`));
    }, 5_000);
    connection.on(Constants.ResponseCodes.ChannelInfo, onInfo);
    connection.on(Constants.ResponseCodes.Err, onErr);
    void connection.sendCommandGetChannel(idx);
  });
}

function sendSetChannel(connection: Connection, idx: number, name: string, secret: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      connection.off(Constants.ResponseCodes.Ok, onOk);
      connection.off(Constants.ResponseCodes.Err, onErr);
      clearTimeout(timeout);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("radio rejected channel update"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out setting channel"));
    }, 5_000);
    connection.on(Constants.ResponseCodes.Ok, onOk);
    connection.on(Constants.ResponseCodes.Err, onErr);
    void connection.sendCommandSetChannel(idx, name, secret);
  });
}

function describeTargetSafe(config: ServerConfig): string | null {
  try {
    return describeTarget(config)?.target ?? null;
  } catch {
    return null;
  }
}
