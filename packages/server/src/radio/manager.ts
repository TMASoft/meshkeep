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
  type RadioProfile,
  type RadioSummary,
  type SelfInfo,
  type SensorReading,
} from "@meshkeep/shared";
import type { ServerConfig } from "../config.js";
import type { Bus } from "../bus.js";
import { getSetting, setSetting, type Db } from "../db/index.js";
import { Store, type OutboundEntry, type RadioProfileInput } from "../db/store.js";
import { createConnection, describeTarget } from "./transports.js";
import { describeConnectError, nextReconnectDelay, reconnectPolicyFor, validateConnectionSettings } from "./reconnect-policy.js";

const CONNECT_TIMEOUT_MS = 15_000;
// BLE needs discovery + GATT enumeration (and possibly a pairing handshake)
const BLE_CONNECT_TIMEOUT_MS = 45_000;
const CLOCK_DRIFT_TOLERANCE_SECS = 30;
const BATTERY_POLL_MS = 5 * 60_000;
const MAX_CHANNELS = 8;
const CONNECTION_OVERRIDE_KEY = "connection.override";
const ACTIVE_PROFILE_KEY = "connection.activeProfileId";
// The physical radio (radios.id) the server is connected to, or was last
// connected to. Persisted so the last radio's stored data is shown immediately
// on boot, before the first reconnect re-confirms identity.
const ACTIVE_RADIO_KEY = "connection.activeRadioId";

// Outbound retry backoff: hand-off failures (radio rejected the frame) back off
// exponentially between these bounds; a radio that is simply offline is left
// pending without burning an attempt and resumes on reconnect.
const OUTBOUND_MIN_BACKOFF_MS = 3_000;
const OUTBOUND_MAX_BACKOFF_MS = 120_000;
// Idle re-check ceiling so the worker periodically re-evaluates due entries.
const OUTBOUND_TIMER_CAP_MS = 60_000;

const nowSecs = () => Math.floor(Date.now() / 1000);

/** Exponential backoff (ms) after `attempts` failed hand-offs (attempts ≥ 1). */
function outboundBackoffMs(attempts: number): number {
  return Math.min(OUTBOUND_MIN_BACKOFF_MS * 2 ** (attempts - 1), OUTBOUND_MAX_BACKOFF_MS);
}

class LifecycleCancelledError extends Error {}

interface PendingDirectDelivery {
  messageId: number;
  radioId: number;
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
  // The physical radio (radios.id) whose data the manager reads/writes. Resolved
  // from the self public key on connect; seeded from the last-active setting so
  // stored data is visible before the first reconnect.
  private activeRadioId: number | null = null;
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
  // Outbound retry worker: one drain loop at a time; a kick during a run
  // requeues one more pass, and a timer fires when a backed-off entry is due.
  private outboundRunning = false;
  private outboundKickAgain = false;
  private outboundTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly appVersion: string,
    private readonly channelReadTimeoutMs = 5_000,
    private readonly connectionFactory: typeof createConnection = createConnection,
  ) {
    this.store = new Store(db);
    // Seed the active radio so stored data is visible before the first reconnect.
    // Prefer the persisted last-active id (validated — it may have been forgotten),
    // else the most-recently-seen radio (covers a pre-isolation upgrade where the
    // setting was never written but radio 1 holds all migrated data).
    const persisted = getSetting<number>(this.db, ACTIVE_RADIO_KEY);
    const radios = this.store.listRadios(null);
    this.activeRadioId =
      (persisted != null && radios.some((radio) => radio.id === persisted) ? persisted : null) ??
      radios[0]?.id ??
      null;
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** The radio the server is connected to (or last connected to), or null before any sync. */
  getActiveRadioId(): number | null {
    return this.activeRadioId;
  }

  /**
   * The radio a no-argument read defaults to: the active (connected) radio if
   * known, otherwise the most-recently-seen stored radio. Distinct from
   * `getActiveRadioId` — status must report connection state honestly, but a
   * read with no `?radioId=` should still surface a sensible radio's data (an
   * upgraded single-radio DB, or a browser-direct-only session's synced radio).
   */
  defaultRadioId(): number | null {
    return this.activeRadioId ?? this.store.listRadios(null)[0]?.id ?? null;
  }

  /** Whether a physical radio (radios.id) has stored data. */
  hasRadio(id: number): boolean {
    return this.store.getRadio(id) !== null;
  }

  /** The active radio id, or throw — for write/radio-op paths that require a synced identity. */
  private requireActiveRadio(): number {
    if (this.activeRadioId === null) {
      throw new RadioUnavailableError("radio identity not resolved yet");
    }
    return this.activeRadioId;
  }

  /** Every radio with stored data, newest-seen first, marking the active one. */
  listRadios(): RadioSummary[] {
    return this.store.listRadios(this.activeRadioId);
  }

  /** Rename a stored radio. */
  renameRadio(id: number, name: string): RadioSummary {
    const updated = this.store.renameRadio(id, name);
    if (!updated) throw new RadioNotFoundError(`radio ${id} not found`);
    this.bus.publish({ type: "status.changed", status: this.status() });
    return updated;
  }

  /** Forget a stored radio and all its data. The active radio cannot be forgotten. */
  forgetRadio(id: number): void {
    if (id === this.activeRadioId) {
      throw new ActiveRadioError("cannot forget the active radio — switch or disconnect first");
    }
    if (!this.store.deleteRadio(id)) throw new RadioNotFoundError(`radio ${id} not found`);
    this.bus.publish({ type: "status.changed", status: this.status() });
  }

  isStandby(): boolean {
    return getSetting<boolean>(this.db, "connection.standby") === true;
  }

  /**
   * Connection settings come from env, but a runtime override saved through
   * the UI (settings table) wins — env is fixed for the container's lifetime,
   * so it acts as the default the override falls back to. An activated radio
   * profile takes precedence over both: the profile is a complete, named
   * target, never merged with env or the override.
   */
  connectionSettings(): {
    env: ConnectionSettings;
    override: Partial<ConnectionSettings> | null;
    activeProfile: RadioProfile | null;
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
    const activeProfile = this.activeProfile();
    const effective: ConnectionSettings = activeProfile
      ? {
          connection: activeProfile.connection,
          serialPort: activeProfile.serialPort,
          serialBaud: activeProfile.serialBaud,
          tcpHost: activeProfile.tcpHost,
          tcpPort: activeProfile.tcpPort,
          bleAddress: activeProfile.bleAddress,
        }
      : override
        ? { ...env, ...override }
        : env;
    return { env, override, activeProfile, effective };
  }

  /** The selected radio profile, or null when none is selected (or it was deleted). */
  activeProfile(): RadioProfile | null {
    const id = getSetting<number>(this.db, ACTIVE_PROFILE_KEY);
    return id === null ? null : this.store.getRadioProfile(id);
  }

  /** Persist (or clear) a connection override and reconnect with the new settings. */
  async setConnectionOverride(override: Partial<ConnectionSettings> | null): Promise<void> {
    setSetting(this.db, CONNECTION_OVERRIDE_KEY, override);
    // an explicit override is a direct instruction — it replaces any profile selection
    setSetting(this.db, ACTIVE_PROFILE_KEY, null);
    await this.applyConnectionChange();
  }

  /** Select a radio profile (or null for env/override settings) and reconnect. */
  async activateProfile(id: number | null): Promise<void> {
    if (id !== null && !this.store.getRadioProfile(id)) {
      throw new ProfileNotFoundError(`radio profile ${id} not found`);
    }
    setSetting(this.db, ACTIVE_PROFILE_KEY, id);
    await this.applyConnectionChange();
  }

  /** Update a profile; editing the active profile reconnects with the new settings. */
  async updateProfile(id: number, patch: Partial<RadioProfileInput>): Promise<RadioProfile> {
    const updated = this.store.updateRadioProfile(id, patch);
    if (!updated) throw new ProfileNotFoundError(`radio profile ${id} not found`);
    if (getSetting<number>(this.db, ACTIVE_PROFILE_KEY) === id) {
      await this.applyConnectionChange();
    }
    return updated;
  }

  /** Delete a profile. The active profile cannot be deleted — deactivate it first. */
  deleteProfile(id: number): void {
    if (getSetting<number>(this.db, ACTIVE_PROFILE_KEY) === id) {
      throw new ActiveProfileError("cannot delete the active radio profile — deactivate it first");
    }
    if (!this.store.deleteRadioProfile(id)) {
      throw new ProfileNotFoundError(`radio profile ${id} not found`);
    }
  }

  /** Tear down and reconnect (or settle in the right idle state) after a settings change. */
  private async applyConnectionChange(): Promise<void> {
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
    // Displayed self/battery/counts follow the default radio (active, else most
    // recently seen) so a browser-direct-synced or last-connected radio still
    // shows when the server itself is not connected; activeRadioId stays honest.
    const displayRadioId = this.defaultRadioId();
    return {
      connection: {
        state: this.state,
        transport: effective.connection,
        target,
        lastError: this.lastError,
        connectedAt: this.connectedAt,
      },
      self: displayRadioId === null ? null : this.store.getSelf(displayRadioId),
      batteryMilliVolts: displayRadioId === null ? null : this.store.latestBatteryMv(displayRadioId),
      counts: displayRadioId === null ? { contacts: 0, messages: 0, unread: 0 } : this.store.counts(displayRadioId),
      activeRadioId: this.activeRadioId,
      radios: this.store.listRadios(this.activeRadioId),
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
    if (this.outboundTimer) {
      clearTimeout(this.outboundTimer);
      this.outboundTimer = null;
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

      // Drain anything that queued while we were away (offline sends, backoffs).
      void this.processOutboundQueue();

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
      if (!this.isCurrent(connection, generation) || this.activeRadioId === null) return;
      // firmware auto-added/updated a contact; re-pull the contact list first
      // so the last-seen touch lands on an existing row instead of being lost
      // for a newly discovered contact
      const key = BufferUtils.bytesToHex(push.publicKey);
      void this.refreshContacts()
        .catch(() => {}) // transient failure — the touch may still hit an already-stored contact
        .then(() => {
          if (!this.isCurrent(connection, generation) || this.activeRadioId === null) return;
          const contact = this.store.touchContactSeen(this.activeRadioId, key);
          if (contact) this.bus.publish({ type: "contact.updated", radioId: this.activeRadioId, contact });
        });
    });

    connection.on(Constants.PushCodes.NewAdvert, (advert: RawContact) => {
      if (!this.isCurrent(connection, generation) || this.activeRadioId === null) return;
      const contact = rawContactToContact(advert);
      this.store.upsertContact(this.activeRadioId, contact);
      this.bus.publish({ type: "contact.updated", radioId: this.activeRadioId, contact });
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
    // Resolve (or create) the physical radio identity before persisting anything
    // else: every subsequent write in this sync is scoped to it. Persist the id
    // so a restart shows this radio's data before it reconnects.
    const radioId = this.store.resolveRadio(self.publicKey, self.name);
    this.activeRadioId = radioId;
    setSetting(this.db, ACTIVE_RADIO_KEY, radioId);
    this.store.saveSelf(radioId, self);
    this.bus.publish({ type: "self.updated", radioId, self });

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
    const radioId = this.requireActiveRadio();
    const { removed } = this.store.syncContacts(radioId, contacts);
    for (const contact of contacts) this.bus.publish({ type: "contact.updated", radioId, contact });
    for (const publicKey of removed) this.bus.publish({ type: "contact.removed", radioId, publicKey });
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
      const radioId = this.requireActiveRadio();
      this.db.transaction(() => {
        for (const channel of channels) this.store.upsertChannel(radioId, channel);
        for (const known of this.store.getChannels(radioId)) {
          if (!channels.some((channel) => channel.idx === known.idx)) this.store.deleteChannel(radioId, known.idx);
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
    const radioId = this.requireActiveRadio();
    let message: Message | null = null;
    if (next.contactMessage) {
      const m = next.contactMessage;
      const prefixHex = BufferUtils.bytesToHex(m.pubKeyPrefix);
      const contact = this.store.findUniqueContactByPrefix(radioId, prefixHex);
      if (contact) this.store.touchContactSeen(radioId, contact.publicKey);
      message = this.store.insertMessage(radioId, {
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
      message = this.store.insertMessage(radioId, {
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
      this.bus.publish({ type: "message.new", radioId, message });
    }
  }

  /**
   * Accept a direct message into the outbound queue and return it immediately as
   * `pending`. The worker hands it to the radio (and drives ack → delivered) in
   * the background; a failed hand-off retries with backoff and surfaces
   * `retrying`/`failed` over the bus. Never blocks on radio availability.
   */
  async sendDirectMessage(contactKey: string, text: string, cli = false): Promise<Message> {
    return this.enqueueOutboundMessage({ kind: "dm", contactKey, text, cli });
  }

  async sendChannelMessage(channelIdx: number, text: string): Promise<Message> {
    return this.enqueueOutboundMessage({ kind: "channel", channelIdx, text });
  }

  private enqueueOutboundMessage(
    input:
      | { kind: "dm"; contactKey: string; text: string; cli: boolean }
      | { kind: "channel"; channelIdx: number; text: string },
  ): Message {
    // Standby means the radio was handed to a browser: reject rather than queue
    // a send that would fire much later on reclaim. A merely offline radio
    // (disconnected/connecting/error) still queues and delivers on reconnect.
    if (this.isStandby()) {
      throw new RadioUnavailableError("radio is in standby (released to a browser session)");
    }
    // A send may be queued before any radio has connected. Attribute it to the
    // default (active, else most-recent) radio, or a placeholder the first
    // connect will claim — so the queued send reattaches to the real radio.
    const radioId = this.defaultRadioId() ?? this.store.ensurePlaceholderRadio();
    const senderTimestamp = nowSecs();
    const stored =
      input.kind === "dm"
        ? this.store.insertMessage(radioId, {
            kind: "dm",
            contactKey: input.contactKey,
            direction: "out",
            text: input.text,
            senderTimestamp,
            status: "pending",
          })
        : this.store.insertMessage(radioId, {
            kind: "channel",
            channelIdx: input.channelIdx,
            direction: "out",
            text: input.text,
            senderTimestamp,
            status: "pending",
          });
    if (!stored) throw new Error("duplicate message");
    this.store.enqueueOutbound({
      radioId,
      messageId: stored.id,
      kind: input.kind,
      contactKey: input.kind === "dm" ? input.contactKey : null,
      channelIdx: input.kind === "channel" ? input.channelIdx : null,
      text: input.text,
      cli: input.kind === "dm" ? input.cli : false,
      maxAttempts: this.config.outboundMaxAttempts,
      nextAttemptAt: senderTimestamp,
    });
    void this.processOutboundQueue();
    return stored;
  }

  /** Re-arm a `failed` outbound message for another round of delivery attempts. */
  retryOutbound(messageId: number): Message {
    const entry = this.store.getOutbound(messageId);
    if (!entry) throw new OutboundNotFoundError("message is not in the outbound queue");
    if (entry.state !== "failed") throw new OutboundStateError("only failed messages can be retried");
    this.store.resetOutboundForRetry(messageId, nowSecs());
    this.store.setMessageStatus(messageId, "pending");
    const message = this.store.getMessage(messageId);
    if (message) {
      this.bus.publish({ type: "message.status", radioId: entry.radioId, id: messageId, status: message.status });
    }
    void this.processOutboundQueue();
    if (!message) throw new Error("message not found");
    return message;
  }

  /** Give up on an outbound message: drop it from the queue and mark it failed. */
  cancelOutbound(messageId: number): Message {
    const entry = this.store.getOutbound(messageId);
    if (!entry) throw new OutboundNotFoundError("message is not in the outbound queue");
    this.store.removeOutbound(messageId);
    this.store.setMessageStatus(messageId, "failed");
    this.bus.publish({ type: "message.status", radioId: entry.radioId, id: messageId, status: "failed" });
    const message = this.store.getMessage(messageId);
    if (!message) throw new Error("message not found");
    return message;
  }

  /**
   * Drain due outbound entries one at a time while the radio is available.
   * Success removes the entry (DMs then follow the normal ack/timeout path);
   * a hand-off failure backs the entry off, and a radio that drops mid-send
   * leaves the entry pending without burning an attempt.
   */
  private async processOutboundQueue(): Promise<void> {
    if (this.outboundRunning) {
      this.outboundKickAgain = true;
      return;
    }
    this.outboundRunning = true;
    try {
      while (!this.stopped && !this.isStandby() && (this.state === "connected" || this.state === "syncing")) {
        const connection = this.connection;
        if (!connection || this.activeRadioId === null) break;
        const due = this.store.takeDueOutbound(this.activeRadioId, nowSecs());
        if (!due.length) break;
        const entry = due[0]!;
        try {
          if (entry.kind === "dm") {
            await this.deliverDirect(entry, connection);
          } else {
            await this.deliverChannel(entry, connection);
          }
        } catch (error) {
          if (error instanceof LifecycleCancelledError) break;
          // Radio dropped mid-send: retry later without counting it as a failure.
          if (this.state !== "connected" && this.state !== "syncing") break;
          this.recordOutboundFailure(entry, error);
        }
      }
    } finally {
      this.outboundRunning = false;
      if (this.outboundKickAgain) {
        this.outboundKickAgain = false;
        void this.processOutboundQueue();
      } else {
        this.scheduleOutboundTimer();
      }
    }
  }

  private async deliverDirect(entry: OutboundEntry, connection: Connection): Promise<void> {
    if (!entry.contactKey) throw new Error("queued direct message is missing a contact key");
    const pubKey = BufferUtils.hexToBytes(entry.contactKey);
    await this.runDirectSend(entry.messageId, entry.radioId, async (pending) => {
      const txtType = entry.cli ? Constants.TxtTypes.CliData : Constants.TxtTypes.Plain;
      const sent = await connection.sendTextMessage(pubKey, entry.text, txtType);
      // Handed to the radio: the retry queue's job is done; ack/timeout now
      // drives delivered vs. unconfirmed exactly as before.
      pending.expectedAckCrc = sent.expectedAckCrc;
      this.db_setAck(entry.messageId, sent.expectedAckCrc);
      this.store.removeOutbound(entry.messageId);
      if (pending.earlyAckCode === sent.expectedAckCrc) {
        this.finishDirectDelivery(pending, true);
        return;
      }
      this.store.setMessageStatus(entry.messageId, "sent");
      this.bus.publish({ type: "message.status", radioId: pending.radioId, id: entry.messageId, status: "sent" });
      pending.timeout = setTimeout(() => this.finishDirectDelivery(pending, false), sent.estTimeout);
    });
  }

  private async deliverChannel(entry: OutboundEntry, connection: Connection): Promise<void> {
    if (entry.channelIdx === null) throw new Error("queued channel message is missing a channel index");
    await connection.sendChannelTextMessage(entry.channelIdx, entry.text);
    this.store.removeOutbound(entry.messageId);
    this.store.setMessageStatus(entry.messageId, "sent");
    this.bus.publish({ type: "message.status", radioId: entry.radioId, id: entry.messageId, status: "sent" });
  }

  private recordOutboundFailure(entry: OutboundEntry, error: unknown): void {
    const radioId = entry.radioId;
    const attempts = entry.attempts + 1;
    const lastError = error instanceof Error ? error.message : String(error ?? "send failed");
    if (attempts >= entry.maxAttempts) {
      this.store.markOutboundAttempt(entry.messageId, { state: "failed", attempts, nextAttemptAt: nowSecs(), lastError });
      this.store.setMessageStatus(entry.messageId, "failed");
      this.bus.publish({ type: "message.status", radioId, id: entry.messageId, status: "failed" });
    } else {
      const nextAttemptAt = nowSecs() + Math.ceil(outboundBackoffMs(attempts) / 1000);
      // The message row stays `pending`; the queue's `retrying` state overlays it.
      this.store.markOutboundAttempt(entry.messageId, { state: "retrying", attempts, nextAttemptAt, lastError });
      this.bus.publish({ type: "message.status", radioId, id: entry.messageId, status: "retrying" });
    }
  }

  private scheduleOutboundTimer(): void {
    if (this.outboundTimer) {
      clearTimeout(this.outboundTimer);
      this.outboundTimer = null;
    }
    if (this.stopped || this.isStandby()) return;
    // Only worth a timer while the radio can actually take a send. When offline
    // the queue just waits; connect() kicks the worker on reconnect. (Scheduling
    // regardless would busy-loop on a due entry that can never be attempted.)
    if (this.state !== "connected" && this.state !== "syncing") return;
    if (this.activeRadioId === null) return;
    const next = this.store.nextOutboundAttemptAt(this.activeRadioId);
    if (next === null) return;
    const delayMs = Math.min(Math.max(next * 1000 - Date.now(), 0), OUTBOUND_TIMER_CAP_MS);
    this.outboundTimer = setTimeout(() => {
      this.outboundTimer = null;
      void this.processOutboundQueue();
    }, delayMs);
    this.outboundTimer.unref?.();
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
    this.store.upsertChannel(this.requireActiveRadio(), channel);
    return channel;
  }

  /** Blank a channel slot — firmware clears a slot when written with an empty name and zero key. */
  async deleteChannel(idx: number): Promise<void> {
    const connection = this.requireConnection();
    await this.runUncorrelatedCommand(() => sendSetChannel(connection, idx, "", new Uint8Array(16)));
    this.store.deleteChannel(this.requireActiveRadio(), idx);
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
    const radioId = this.requireActiveRadio();
    const self = this.store.getSelf(radioId);
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
    this.store.saveSelf(radioId, updated);
    this.bus.publish({ type: "self.updated", radioId, self: updated });
    return updated;
  }

  async removeContact(contactKey: string): Promise<void> {
    const connection = this.requireConnection();
    const radioId = this.requireActiveRadio();
    await connection.removeContact(BufferUtils.hexToBytes(contactKey));
    this.store.removeContact(radioId, contactKey);
    this.bus.publish({ type: "contact.removed", radioId, publicKey: contactKey });
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
      this.store.recordContactTelemetry(this.requireActiveRadio(), contactKey, readings);
      this.store.trimTelemetry(this.config.telemetryRetentionDays);
    }
    return readings;
  }

  private async pollBattery(
    connection = this.connection,
    generation = this.lifecycleGeneration,
    signal = this.lifecycleAbort.signal,
  ): Promise<void> {
    if (!connection || this.activeRadioId === null) return;
    const radioId = this.activeRadioId;
    try {
      const battery = await this.awaitCurrent(connection.getBatteryVoltage(), connection, generation, signal);
      this.store.recordTelemetry(radioId, battery.batteryMilliVolts);
      this.store.trimTelemetry(this.config.telemetryRetentionDays);
      this.bus.publish({
        type: "telemetry",
        radioId,
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

  private runDirectSend<T>(
    messageId: number,
    radioId: number,
    operation: (pending: PendingDirectDelivery) => Promise<T>,
  ): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const queued = this.directSendQueue.then(async () => {
      const pending = this.createPendingDirectDelivery(messageId, radioId);
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

  private createPendingDirectDelivery(messageId: number, radioId: number): PendingDirectDelivery {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { messageId, radioId, expectedAckCrc: null, earlyAckCode: null, timeout: null, finished, finish };
  }

  private finishDirectDelivery(pending: PendingDirectDelivery, delivered: boolean): void {
    if (this.pendingDirectDelivery !== pending) return;
    this.pendingDirectDelivery = null;
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    if (delivered) {
      this.store.setMessageStatus(pending.messageId, "delivered");
      this.bus.publish({ type: "message.status", radioId: pending.radioId, id: pending.messageId, status: "delivered" });
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
/** The referenced radio profile does not exist. */
export class ProfileNotFoundError extends Error {}
/** The operation is not allowed on the currently active radio profile. */
export class ActiveProfileError extends Error {}
/** The referenced physical radio (radios.id) does not exist. */
export class RadioNotFoundError extends Error {}
/** The operation is not allowed on the currently active radio (e.g. forgetting it). */
export class ActiveRadioError extends Error {}
/** The referenced message has no outbound-queue entry (never queued or already delivered). */
export class OutboundNotFoundError extends Error {}
/** The outbound entry is not in a state that permits the requested action (e.g. retrying a non-failed send). */
export class OutboundStateError extends Error {}

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
