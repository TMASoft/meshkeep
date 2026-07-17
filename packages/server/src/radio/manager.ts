import { BufferUtils, CayenneLpp, Constants, type Connection } from "@liamcottle/meshcore.js";
import {
  CONTACT_TYPE_FROM_ADV,
  type AppStatus,
  type Channel,
  type ConnectionSettings,
  type ConnectionState,
  type Contact,
  type Message,
  type NodeStats,
  type SelfInfo,
  type SensorReading,
} from "@meshkeep/shared";
import type { ServerConfig } from "../config.js";
import type { Bus } from "../bus.js";
import { getSetting, setSetting, type Db } from "../db/index.js";
import { Store } from "../db/store.js";
import { createConnection, describeTarget } from "./transports.js";
import { describeConnectError, nextReconnectDelay, reconnectPolicyFor, validateConnectionSettings } from "./reconnect-policy.js";

const CONNECT_TIMEOUT_MS = 15_000;
// BLE needs discovery + GATT enumeration (and possibly a pairing handshake)
const BLE_CONNECT_TIMEOUT_MS = 45_000;
const CLOCK_DRIFT_TOLERANCE_SECS = 30;
const BATTERY_POLL_MS = 5 * 60_000;
const MAX_CHANNELS = 8;
const CONNECTION_OVERRIDE_KEY = "connection.override";

class LifecycleCancelledError extends Error {}

interface PendingDirectDelivery {
  messageId: number;
  expectedAckCrc: number | null;
  earlyAckCode: number | null;
  timeout: NodeJS.Timeout | null;
  finished: Promise<void>;
  finish: () => void;
}

/** Cayenne LPP type codes → display label and unit (subset the firmware ecosystem uses). */
const LPP_TYPE_INFO: Record<number, { label: string; unit: string | null }> = {
  0: { label: "Digital input", unit: null },
  1: { label: "Digital output", unit: null },
  2: { label: "Analog input", unit: null },
  3: { label: "Analog output", unit: null },
  100: { label: "Generic sensor", unit: null },
  101: { label: "Luminosity", unit: "lx" },
  102: { label: "Presence", unit: null },
  103: { label: "Temperature", unit: "°C" },
  104: { label: "Humidity", unit: "%" },
  113: { label: "Accelerometer", unit: "G" },
  115: { label: "Pressure", unit: "hPa" },
  116: { label: "Voltage", unit: "V" },
  117: { label: "Current", unit: "A" },
  118: { label: "Frequency", unit: "Hz" },
  120: { label: "Percentage", unit: "%" },
  121: { label: "Altitude", unit: "m" },
  125: { label: "Concentration", unit: "ppm" },
  128: { label: "Power", unit: "W" },
  130: { label: "Distance", unit: "m" },
  131: { label: "Energy", unit: "kWh" },
  132: { label: "Direction", unit: "°" },
  133: { label: "Unix time", unit: null },
  134: { label: "Gyrometer", unit: "°/s" },
  135: { label: "Colour", unit: null },
  136: { label: "GPS", unit: null },
  142: { label: "Switch", unit: null },
};

/** Latitude/longitude are transported as degrees * 1e6 signed integers. */
const GEO_SCALE = 1e6;
function fromGeoInt(value: number): number | null {
  if (value === 0) return null;
  return value / GEO_SCALE;
}

function normalizeDeviceText(value: string): string {
  return value
    .split("\0")
    .filter(Boolean)
    .join(" ")
    .trim();
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
  // 0 = "start from the transport policy's minimum" on the next scheduling
  private reconnectDelay = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private batteryTimer: NodeJS.Timeout | null = null;
  private lifecycleGeneration = 0;
  private lifecycleAbort = new AbortController();
  private stopped = false;
  private draining = false;
  private drainAgain = false;
  // MeshCore responses have no request ID, so only one hand-written command
  // wrapper may listen for its generic response events at a time.
  private uncorrelatedCommandQueue: Promise<void> = Promise.resolve();
  // SendConfirmed identifies a frame only by its CRC. Keep one direct send in
  // flight until its acknowledgement arrives or times out to avoid collisions.
  private directSendQueue: Promise<void> = Promise.resolve();
  private pendingDirectDelivery: PendingDirectDelivery | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly appVersion: string,
    private readonly channelReadTimeoutMs = 5_000,
    private readonly connectionFactory: typeof createConnection = createConnection,
  ) {
    this.store = new Store(db);
  }

  getState(): ConnectionState {
    return this.state;
  }

  isStandby(): boolean {
    return getSetting<boolean>(this.db, "connection.standby") === true;
  }

  /**
   * Connection settings come from env, but a runtime override saved through
   * the UI (settings table) wins — env is fixed for the container's lifetime,
   * so it acts as the default the override falls back to.
   */
  connectionSettings(): {
    env: ConnectionSettings;
    override: Partial<ConnectionSettings> | null;
    effective: ConnectionSettings;
  } {
    const env: ConnectionSettings = {
      connection: this.config.connection ?? "none",
      serialPort: this.config.serialPort,
      serialBaud: this.config.serialBaud,
      tcpHost: this.config.tcpHost,
      tcpPort: this.config.tcpPort,
      bleAddress: this.config.bleAddress,
    };
    const override = getSetting<Partial<ConnectionSettings>>(this.db, CONNECTION_OVERRIDE_KEY) ?? null;
    return { env, override, effective: override ? { ...env, ...override } : env };
  }

  /** Persist (or clear) a connection override and reconnect with the new settings. */
  async setConnectionOverride(override: Partial<ConnectionSettings> | null): Promise<void> {
    setSetting(this.db, CONNECTION_OVERRIDE_KEY, override);
    await this.teardown();
    if (this.stopped) return;
    if (this.isStandby()) {
      this.setState("standby", null);
      return;
    }
    if (this.connectionSettings().effective.connection === "none") {
      this.setState("disconnected", "no radio transport configured");
      return;
    }
    this.reconnectDelay = 0;
    await this.connect();
  }

  status(): AppStatus {
    const { effective } = this.connectionSettings();
    const target = effective.connection !== "none" ? describeTargetSafe(effective) : null;
    return {
      connection: {
        state: this.state,
        transport: effective.connection,
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

  /** Whether a reconnect is scheduled and its current backoff delay, for diagnostics. */
  reconnectState(): { scheduled: boolean; delayMs: number } {
    return { scheduled: this.reconnectTimer !== null, delayMs: this.reconnectDelay };
  }

  async start(): Promise<void> {
    if (this.connectionSettings().effective.connection === "none") {
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
    this.lifecycleGeneration += 1;
    this.lifecycleAbort.abort();
    this.lifecycleAbort = new AbortController();
    if (this.pendingDirectDelivery) this.finishDirectDelivery(this.pendingDirectDelivery, false);
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
    if (this.stopped || this.isStandby() || this.connection) return;
    const generation = this.lifecycleGeneration;
    const signal = this.lifecycleAbort.signal;
    this.setState("connecting", null);
    let connection: Connection | null = null;
    try {
      const effective = this.connectionSettings().effective;
      const configError = validateConnectionSettings(effective);
      if (configError) {
        // permanent: retrying cannot fix configuration — surface it and stay
        // put until the settings change (override, claim, or restart)
        console.error(`[radio] configuration error: ${configError}`);
        this.setState("error", `configuration error: ${configError}`);
        return;
      }
      const connectTimeoutMs = effective.connection === "ble" ? BLE_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
      const activeConnection = this.connectionFactory(effective);
      connection = activeConnection;
      this.connection = activeConnection;
      this.attachListeners(activeConnection, generation);

      await this.awaitCurrent(
        new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`timed out connecting after ${connectTimeoutMs}ms`)),
            connectTimeoutMs,
          );
          activeConnection.once("connected", () => {
            clearTimeout(timeout);
            resolve();
          });
          activeConnection.connect().catch((error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          });
        }),
        activeConnection,
        generation,
        signal,
      );

      this.setState("syncing", null);
      await this.initialSync(activeConnection, generation, signal);
      if (!this.isCurrent(activeConnection, generation)) return;

      this.connectedAt = Math.floor(Date.now() / 1000);
      this.reconnectDelay = 0;
      this.setState("connected", null);

      this.batteryTimer = setInterval(() => {
        void this.pollBattery(activeConnection, generation, signal);
      }, BATTERY_POLL_MS);
    } catch (error) {
      if (error instanceof LifecycleCancelledError || !connection || !this.isCurrent(connection, generation)) return;
      const raw = error instanceof Error ? error.message : String(error ?? "connect failed");
      const message = describeConnectError(this.connectionSettings().effective.connection, raw);
      console.error(`[radio] connect failed: ${message}`);
      await this.teardown();
      this.setState("error", message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.isStandby() || this.reconnectTimer) return;
    const policy = reconnectPolicyFor(this.connectionSettings().effective.connection);
    const delay = Math.max(this.reconnectDelay, policy.minDelayMs);
    this.reconnectDelay = nextReconnectDelay(delay, policy);
    console.log(`[radio] reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private attachListeners(connection: Connection, generation = this.lifecycleGeneration): void {
    connection.on("disconnected", () => {
      if (!this.isCurrent(connection, generation)) return;
      console.log("[radio] disconnected");
      void this.teardown().then(() => {
        if (!this.stopped && !this.isStandby()) {
          this.setState("error", "connection lost");
          this.scheduleReconnect();
        }
      });
    });

    connection.on(Constants.PushCodes.MsgWaiting, () => {
      if (!this.isCurrent(connection, generation)) return;
      void this.drainConnection(connection, generation, this.lifecycleAbort.signal);
    });

    connection.on(Constants.PushCodes.SendConfirmed, (push: { ackCode: number; roundTrip: number }) => {
      if (!this.isCurrent(connection, generation)) return;
      this.handleSendConfirmed(push.ackCode);
    });

    connection.on(Constants.PushCodes.Advert, (push: { publicKey: Uint8Array }) => {
      if (!this.isCurrent(connection, generation)) return;
      // firmware auto-added/updated a contact; re-pull the contact list first
      // so the last-seen touch lands on an existing row instead of being lost
      // for a newly discovered contact
      const key = BufferUtils.bytesToHex(push.publicKey);
      void this.refreshContacts()
        .catch(() => {}) // transient failure — the touch may still hit an already-stored contact
        .then(() => {
          if (!this.isCurrent(connection, generation)) return;
          const contact = this.store.touchContactSeen(key);
          if (contact) this.bus.publish({ type: "contact.updated", contact });
        });
    });

    connection.on(Constants.PushCodes.NewAdvert, (advert: RawContact) => {
      if (!this.isCurrent(connection, generation)) return;
      const contact = rawContactToContact(advert);
      this.store.upsertContact(contact);
      this.bus.publish({ type: "contact.updated", contact });
    });

    connection.on(Constants.PushCodes.PathUpdated, (_push: { publicKey: Uint8Array }) => {
      if (!this.isCurrent(connection, generation)) return;
      void this.refreshContacts().catch(() => {});
    });
  }

  private async initialSync(connection: Connection, generation: number, signal: AbortSignal): Promise<void> {
    // 1. identify ourselves / fetch self info
    const rawSelf = await this.awaitCurrent(connection.getSelfInfo(10_000), connection, generation, signal);
    let device: { firmwareVer: number; firmware_build_date: string; manufacturerModel: string } | null = null;
    try {
      device = await this.awaitCurrent(
        connection.deviceQuery(Constants.SupportedCompanionProtocolVersion),
        connection,
        generation,
        signal,
      );
    } catch (error) {
      if (error instanceof LifecycleCancelledError) throw error;
      // older firmware may not answer; not fatal
    }
    this.ensureCurrent(connection, generation);
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
      manufacturerModel: device?.manufacturerModel ? normalizeDeviceText(device.manufacturerModel) : null,
    };
    this.store.saveSelf(self);
    this.bus.publish({ type: "self.updated", self });

    // 2. fix clock drift (messages are timestamped by the device)
    try {
      const deviceTime = await this.awaitCurrent(connection.getDeviceTime(), connection, generation, signal);
      const drift = Math.abs(deviceTime.epochSecs - Math.floor(Date.now() / 1000));
      if (drift > CLOCK_DRIFT_TOLERANCE_SECS) {
        console.log(`[radio] device clock drifted ${drift}s; syncing`);
        await this.awaitCurrent(connection.syncDeviceTime(), connection, generation, signal);
      }
    } catch (error) {
      if (error instanceof LifecycleCancelledError) throw error;
      console.warn("[radio] could not check device time", error);
    }

    // 3. contacts and channels
    const rawContacts = await this.awaitCurrent(connection.getContacts(), connection, generation, signal);
    this.ensureCurrent(connection, generation);
    this.applyContactScan(rawContacts.map(rawContactToContact));
    await this.refreshChannelsForConnection(connection, generation, signal);

    // 4. drain any messages queued while we were away
    await this.drainConnection(connection, generation, signal);

    // 5. battery snapshot
    await this.pollBattery(connection, generation, signal);
  }

  async refreshContacts(): Promise<Contact[]> {
    const connection = this.requireConnection();
    const generation = this.lifecycleGeneration;
    const signal = this.lifecycleAbort.signal;
    const rawContacts = await this.awaitCurrent(connection.getContacts(), connection, generation, signal);
    const contacts = rawContacts.map(rawContactToContact);
    this.applyContactScan(contacts);
    return contacts;
  }

  /**
   * Apply a confirmed complete contact scan from the radio: the stored list
   * mirrors it exactly (contacts removed elsewhere disappear here too), while
   * message history keeps its own identity columns and is never orphaned.
   */
  private applyContactScan(contacts: Contact[]): void {
    const { removed } = this.store.syncContacts(contacts);
    for (const contact of contacts) this.bus.publish({ type: "contact.updated", contact });
    for (const publicKey of removed) this.bus.publish({ type: "contact.removed", publicKey });
  }

  async refreshChannels(): Promise<Channel[]> {
    const connection = this.requireConnection();
    return this.refreshChannelsForConnection(connection, this.lifecycleGeneration, this.lifecycleAbort.signal);
  }

  private async refreshChannelsForConnection(
    connection: Connection,
    generation: number,
    signal: AbortSignal,
  ): Promise<Channel[]> {
    return this.runUncorrelatedCommand(async () => {
      const channels: Channel[] = [];
      for (let idx = 0; idx < MAX_CHANNELS; idx++) {
        const channel = await this.awaitCurrent(
          getChannelInfo(connection, idx, this.channelReadTimeoutMs),
          connection,
          generation,
          signal,
        );
        if (channel) channels.push(channel);
      }
      this.ensureCurrent(connection, generation);
      this.db.transaction(() => {
        for (const channel of channels) this.store.upsertChannel(channel);
        for (const known of this.store.getChannels()) {
          if (!channels.some((channel) => channel.idx === known.idx)) this.store.deleteChannel(known.idx);
        }
      })();
      return channels;
    });
  }

  /**
   * Pull queued messages off the device one at a time. Guarded so a push
   * arriving mid-drain triggers one more pass instead of a concurrent one.
   */
  async drainMessages(): Promise<void> {
    return this.drainConnection(this.connection, this.lifecycleGeneration, this.lifecycleAbort.signal);
  }

  private async drainConnection(
    connection: Connection | null,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    if (!connection) return;
    this.draining = true;
    try {
      while (true) {
        const next = await this.awaitCurrent(connection.syncNextMessage(), connection, generation, signal);
        if (!next) break;
        this.handleIncoming(next);
      }
    } catch (error) {
      if (error instanceof LifecycleCancelledError) return;
      console.error("[radio] failed draining messages", error);
    } finally {
      this.draining = false;
      const drainAgain = this.drainAgain;
      this.drainAgain = false;
      if (drainAgain && this.isCurrent(connection, generation)) {
        void this.drainConnection(this.connection, this.lifecycleGeneration, this.lifecycleAbort.signal);
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
      const contact = this.store.findUniqueContactByPrefix(prefixHex);
      if (contact) this.store.touchContactSeen(contact.publicKey);
      message = this.store.insertMessage({
        kind: "dm",
        contactKey: contact?.publicKey ?? null,
        contactPrefix: prefixHex,
        direction: "in",
        text: m.text,
        senderTimestamp: m.senderTimestamp,
        pathLen: m.pathLen === 0xff ? null : m.pathLen,
        status: "sent",
        authorPrefix: m.signedAuthorPrefix ?? null,
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

  async sendDirectMessage(contactKey: string, text: string, cli = false): Promise<Message> {
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
      return await this.runDirectSend(stored.id, async (pending) => {
        const txtType = cli ? Constants.TxtTypes.CliData : Constants.TxtTypes.Plain;
        const sent = await connection.sendTextMessage(pubKey, text, txtType);
        pending.expectedAckCrc = sent.expectedAckCrc;
        this.db_setAck(stored.id, sent.expectedAckCrc);

        if (pending.earlyAckCode === sent.expectedAckCrc) {
          this.finishDirectDelivery(pending, true);
          return { ...stored, status: "delivered" };
        }

        this.store.setMessageStatus(stored.id, "sent");
        this.bus.publish({ type: "message.status", id: stored.id, status: "sent" });
        pending.timeout = setTimeout(() => this.finishDirectDelivery(pending, false), sent.estTimeout);
        return { ...stored, status: "sent" };
      });
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
    await this.runUncorrelatedCommand(() => sendSetChannel(connection, idx, name, secret));
    const channel = { idx, name, secret: secretHex };
    this.store.upsertChannel(channel);
    return channel;
  }

  /** Blank a channel slot — firmware clears a slot when written with an empty name and zero key. */
  async deleteChannel(idx: number): Promise<void> {
    const connection = this.requireConnection();
    await this.runUncorrelatedCommand(() => sendSetChannel(connection, idx, "", new Uint8Array(16)));
    this.store.deleteChannel(idx);
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
    this.bus.publish({ type: "contact.removed", publicKey: contactKey });
  }

  /** Export a contact (or our own identity when key is null) as a meshcore:// URI. */
  async exportContactUri(contactKey: string | null): Promise<string> {
    const connection = this.requireConnection();
    const pubKey = contactKey ? BufferUtils.hexToBytes(contactKey) : null;
    const result = await connection.exportContact(pubKey).catch(() => {
      throw new Error("radio could not export the contact");
    });
    return `meshcore://${BufferUtils.bytesToHex(result.advertPacketBytes)}`;
  }

  /** Import a contact from a meshcore:// URI (raw advert packet hex also accepted). */
  async importContactUri(uri: string): Promise<Contact[]> {
    const hex = uri.trim().replace(/^meshcore:\/\//i, "");
    if (!/^([0-9a-f]{2}){4,}$/i.test(hex)) {
      throw new Error("not a valid meshcore:// contact URI");
    }
    const connection = this.requireConnection();
    await connection.importContact(BufferUtils.hexToBytes(hex.toLowerCase())).catch(() => {
      throw new Error("radio rejected the contact import");
    });
    return this.refreshContacts();
  }

  async resetContactPath(contactKey: string): Promise<void> {
    const connection = this.requireConnection();
    await connection.resetPath(BufferUtils.hexToBytes(contactKey));
  }

  /** Authenticate with a room server or repeater. Resolves false on wrong password/timeout. */
  async loginToNode(contactKey: string, password: string): Promise<boolean> {
    const connection = this.requireConnection();
    try {
      await connection.login(BufferUtils.hexToBytes(contactKey), password);
      return true;
    } catch {
      return false;
    }
  }

  /** Request live stats from a repeater or room server (requires prior login on most nodes). */
  async getNodeStatus(contactKey: string): Promise<NodeStats> {
    const connection = this.requireConnection();
    const raw = await connection.getStatus(BufferUtils.hexToBytes(contactKey)).catch(() => {
      throw new Error("status request failed — is the node reachable and are you logged in?");
    });
    return {
      battMilliVolts: raw.batt_milli_volts,
      currTxQueueLen: raw.curr_tx_queue_len,
      noiseFloor: raw.noise_floor,
      lastRssi: raw.last_rssi,
      nPacketsRecv: raw.n_packets_recv,
      nPacketsSent: raw.n_packets_sent,
      totalAirTimeSecs: raw.total_air_time_secs,
      totalUpTimeSecs: raw.total_up_time_secs,
      nSentFlood: raw.n_sent_flood,
      nSentDirect: raw.n_sent_direct,
      nRecvFlood: raw.n_recv_flood,
      nRecvDirect: raw.n_recv_direct,
      errEvents: raw.err_events,
      lastSnr: raw.last_snr,
      nDirectDups: raw.n_direct_dups,
      nFloodDups: raw.n_flood_dups,
    };
  }

  /** Ask a remote node for its Cayenne LPP sensor telemetry. */
  async requestTelemetry(contactKey: string): Promise<SensorReading[]> {
    const connection = this.requireConnection();
    const response = await connection.getTelemetry(BufferUtils.hexToBytes(contactKey)).catch(() => {
      throw new Error("telemetry request failed — is the node reachable?");
    });
    const readings = CayenneLpp.parse(response.lppSensorData).map((item) => ({
      channel: item.channel,
      type: item.type,
      label: LPP_TYPE_INFO[item.type]?.label ?? `Sensor type ${item.type}`,
      unit: LPP_TYPE_INFO[item.type]?.unit ?? null,
      value: item.value,
    }));
    if (readings.length) {
      this.store.recordContactTelemetry(contactKey, readings);
      this.store.trimTelemetry(this.config.telemetryRetentionDays);
    }
    return readings;
  }

  private async pollBattery(
    connection = this.connection,
    generation = this.lifecycleGeneration,
    signal = this.lifecycleAbort.signal,
  ): Promise<void> {
    if (!connection) return;
    try {
      const battery = await this.awaitCurrent(connection.getBatteryVoltage(), connection, generation, signal);
      this.store.recordTelemetry(battery.batteryMilliVolts);
      this.store.trimTelemetry(this.config.telemetryRetentionDays);
      this.bus.publish({
        type: "telemetry",
        batteryMilliVolts: battery.batteryMilliVolts,
        ts: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      if (error instanceof LifecycleCancelledError) return;
      console.warn("[radio] battery poll failed", error);
    }
  }

  private db_setAck(messageId: number, ackCrc: number): void {
    this.db.prepare("UPDATE messages SET ack_crc = ? WHERE id = ?").run(ackCrc, messageId);
  }

  private handleSendConfirmed(ackCode: number): void {
    const pending = this.pendingDirectDelivery;
    if (!pending) return;
    // A push can arrive before sendTextMessage resolves with expectedAckCrc.
    if (pending.expectedAckCrc === null) {
      pending.earlyAckCode = ackCode;
      return;
    }
    if (pending.expectedAckCrc === ackCode) this.finishDirectDelivery(pending, true);
  }

  private runDirectSend<T>(messageId: number, operation: (pending: PendingDirectDelivery) => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const queued = this.directSendQueue.then(async () => {
      const pending = this.createPendingDirectDelivery(messageId);
      this.pendingDirectDelivery = pending;
      try {
        resolveResult(await operation(pending));
        await pending.finished;
      } catch (error) {
        this.finishDirectDelivery(pending, false);
        rejectResult(error);
      }
    });
    this.directSendQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private createPendingDirectDelivery(messageId: number): PendingDirectDelivery {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { messageId, expectedAckCrc: null, earlyAckCode: null, timeout: null, finished, finish };
  }

  private finishDirectDelivery(pending: PendingDirectDelivery, delivered: boolean): void {
    if (this.pendingDirectDelivery !== pending) return;
    this.pendingDirectDelivery = null;
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    if (delivered) {
      this.store.setMessageStatus(pending.messageId, "delivered");
      this.bus.publish({ type: "message.status", id: pending.messageId, status: "delivered" });
    }
    pending.finish();
  }

  private requireConnection(): Connection {
    if (!this.connection || (this.state !== "connected" && this.state !== "syncing")) {
      throw new RadioUnavailableError(`radio is ${this.state}`);
    }
    return this.connection;
  }

  private isCurrent(connection: Connection, generation: number): boolean {
    return (
      this.lifecycleGeneration === generation &&
      this.connection === connection &&
      !this.stopped &&
      !this.isStandby()
    );
  }

  private ensureCurrent(connection: Connection, generation: number): void {
    if (!this.isCurrent(connection, generation)) throw new LifecycleCancelledError();
  }

  private async awaitCurrent<T>(
    operation: Promise<T>,
    connection: Connection,
    generation: number,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw new LifecycleCancelledError();
    const cancelled = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new LifecycleCancelledError()), { once: true });
    });
    const result = await Promise.race([operation, cancelled]);
    this.ensureCurrent(connection, generation);
    return result;
  }

  private runUncorrelatedCommand<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.uncorrelatedCommandQueue.then(operation, operation);
    // Keep the queue usable after a rejected radio command.
    this.uncorrelatedCommandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
function getChannelInfo(connection: Connection, idx: number, timeoutMs: number): Promise<Channel | null> {
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
      reject(new Error(`radio rejected reading channel ${idx}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out reading channel ${idx}`));
    }, timeoutMs);
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

function describeTargetSafe(settings: ConnectionSettings): string | null {
  try {
    return describeTarget(settings)?.target ?? null;
  } catch {
    return null;
  }
}
