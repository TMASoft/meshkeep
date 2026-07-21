import type {
  AppStatus,
  Channel,
  ConnectionSettings,
  ConnectionState,
  Contact,
  LinkStatus,
  Message,
  NodeStats,
  RadioProfile,
  RadioSummary,
  SelfInfo,
  SensorReading,
} from "@meshkeep/shared";
import type { ServerConfig } from "../config.js";
import type { Bus } from "../bus.js";
import { getSetting, setSetting, type Db } from "../db/index.js";
import { Store, type RadioLinkRecord, type RadioProfileInput } from "../db/store.js";
import { createConnection, describeTarget } from "./transports.js";
import { RadioLink } from "./link.js";
import { OutboundNotFoundError, OutboundStateError, RadioUnavailableError } from "./link.js";

export { RadioUnavailableError, OutboundNotFoundError, OutboundStateError } from "./link.js";

const CONNECTION_OVERRIDE_KEY = "connection.override";

const nowSecs = () => Math.floor(Date.now() / 1000);

export class ProfileNotFoundError extends Error {}
/** The operation is not allowed on the currently active radio profile. */
export class ActiveProfileError extends Error {}
/** The referenced physical radio (radios.id) does not exist. */
export class RadioNotFoundError extends Error {}
/** The operation is not allowed on the currently active radio (e.g. forgetting it). */
export class ActiveRadioError extends Error {}
/** A live BLE connection already exists — at most one BLE link may run at a time. */
export class BleExclusivityError extends Error {}
/** More than one radio is connected and the caller did not say which one it means. */
export class AmbiguousLinkError extends Error {}

/**
 * Owns every live radio connection: a keyed set of `RadioLink`s (one per
 * active profile, plus an implicit env/override "default" link) backed by
 * the `radio_links` table. Activating a profile is additive — other active
 * links are untouched — so several radios can run concurrently; BLE is the
 * one exception (at most one live BLE link, since BlueZ exposes a single
 * adapter with no cross-instance discovery coordination). A deployment that
 * never activates a second link behaves exactly as the pre-#53-Stage-3
 * singleton did. Everything the radio tells us is persisted through the
 * shared `Store` and re-broadcast on the shared `Bus`.
 */
export class ConnectionManager {
  readonly store: Store;
  /** Keyed by profile id, or null for the implicit env/override "default" link. */
  private readonly links = new Map<number | null, RadioLink>();
  private stopped = false;

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
    return this.primaryLink()?.getState() ?? "disconnected";
  }

  /** The radio the server is connected to (or last connected to), or null before any sync. */
  getActiveRadioId(): number | null {
    return this.primaryLink()?.getRadioId() ?? null;
  }

  /**
   * The radio a no-argument read defaults to: the active (connected) radio if
   * known, otherwise the most-recently-seen stored radio. Distinct from
   * `getActiveRadioId` — status must report connection state honestly, but a
   * read with no `?radioId=` should still surface a sensible radio's data (an
   * upgraded single-radio DB, or a browser-direct-only session's synced radio).
   */
  defaultRadioId(): number | null {
    return this.getActiveRadioId() ?? this.store.listRadios(null)[0]?.id ?? null;
  }

  /** Whether a physical radio (radios.id) has stored data. */
  hasRadio(id: number): boolean {
    return this.store.getRadio(id) !== null;
  }

  /** Every radio with stored data, newest-seen first, marking the active one. */
  listRadios(): RadioSummary[] {
    return this.store.listRadios(this.getActiveRadioId());
  }

  /** Rename a stored radio. */
  renameRadio(id: number, name: string): RadioSummary {
    const updated = this.store.renameRadio(id, name);
    if (!updated) throw new RadioNotFoundError(`radio ${id} not found`);
    this.publishStatus();
    return updated;
  }

  /** Forget a stored radio and all its data. A radio any link is currently using cannot be forgotten. */
  forgetRadio(id: number): void {
    if ([...this.links.values()].some((link) => link.getRadioId() === id)) {
      throw new ActiveRadioError("cannot forget the active radio — switch or disconnect first");
    }
    if (!this.store.deleteRadio(id)) throw new RadioNotFoundError(`radio ${id} not found`);
    this.publishStatus();
  }

  isStandby(): boolean {
    return this.primaryLink()?.isStandby() ?? false;
  }

  /**
   * Connection settings come from env, but a runtime override saved through
   * the UI (settings table) wins — env is fixed for the container's lifetime,
   * so it acts as the default the override falls back to. An activated radio
   * profile takes precedence over both: the profile is a complete, named
   * target, never merged with env or the override. This describes the
   * *default* link only — a named profile's settings are its own row,
   * unaffected by env/override (see `profileSettings`).
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

  /**
   * A profile currently active, for compatibility views that expect a single
   * answer (`connectionSettings().effective`, the `/radio/profiles` list's
   * `activeProfileId`). Several may be active at once — this picks one
   * deterministically (lowest id) but callers that care about all of them
   * should read `status().links` instead.
   */
  activeProfile(): RadioProfile | null {
    const active = this.store.listLinks().find((link) => link.profileId !== null);
    return active ? this.store.getRadioProfile(active.profileId!) : null;
  }

  /** Persist a connection override and reconnect the default link if it's running. Other active links are untouched. */
  async setConnectionOverride(override: Partial<ConnectionSettings> | null): Promise<void> {
    setSetting(this.db, CONNECTION_OVERRIDE_KEY, override);
    if (this.links.has(null)) await this.restartLink(null);
  }

  /** Enable or disable the implicit env/override "default" link. Other active links are untouched. */
  async setDefaultLinkEnabled(enabled: boolean): Promise<void> {
    this.store.setDefaultLinkEnabled(enabled);
    if (enabled) await this.ensureLinkRunning(null);
    else await this.removeLink(null);
  }

  /**
   * Add a profile to the set of active links. Additive: other active links
   * (other profiles, or the default) are untouched. BLE is the one exception
   * — activating a second BLE profile while one is already live is rejected
   * immediately rather than left to fail after a slow connect attempt.
   */
  async activateProfile(id: number): Promise<void> {
    const profile = this.store.getRadioProfile(id);
    if (!profile) throw new ProfileNotFoundError(`radio profile ${id} not found`);
    if (profile.connection === "ble") {
      const conflict = this.checkBleExclusivity(id);
      if (conflict) throw new BleExclusivityError(conflict);
    }
    this.store.activateLink(id);
    await this.ensureLinkRunning(id);
  }

  /**
   * Deactivate one profile's link, or — with `null` — every active profile's
   * link, restoring the default (env/override) link. `null` matches the
   * pre-Stage-3b "deactivate" action from when only one thing could be
   * selected at a time.
   */
  async deactivateProfile(id: number | null): Promise<void> {
    if (id === null) {
      for (const key of this.store.listLinks().map((link) => link.profileId)) {
        if (key === null) continue;
        await this.removeLink(key);
        this.store.deactivateLink(key);
      }
      this.store.setDefaultLinkEnabled(true);
      await this.ensureLinkRunning(null);
      return;
    }
    await this.removeLink(id);
    this.store.deactivateLink(id);
  }

  /** Update a profile; editing an active profile reconnects just that link with the new settings. */
  async updateProfile(id: number, patch: Partial<RadioProfileInput>): Promise<RadioProfile> {
    const updated = this.store.updateRadioProfile(id, patch);
    if (!updated) throw new ProfileNotFoundError(`radio profile ${id} not found`);
    if (this.links.has(id)) await this.restartLink(id);
    return updated;
  }

  /** Delete a profile. An active profile cannot be deleted — deactivate it first. */
  deleteProfile(id: number): void {
    if (this.links.has(id)) {
      throw new ActiveProfileError("cannot delete the active radio profile — deactivate it first");
    }
    if (!this.store.deleteRadioProfile(id)) {
      throw new ProfileNotFoundError(`radio profile ${id} not found`);
    }
  }

  status(): AppStatus {
    const { effective } = this.connectionSettings();
    const target = effective.connection !== "none" ? describeTargetSafe(effective) : null;
    const primary = this.primaryLink();
    // Displayed self/battery/counts follow the default radio (active, else most
    // recently seen) so a browser-direct-synced or last-connected radio still
    // shows when the server itself is not connected; getActiveRadioId stays honest.
    const displayRadioId = this.defaultRadioId();
    const links: LinkStatus[] = this.store.listLinks().map((record) => {
      const link = this.links.get(record.profileId);
      const profile = record.profileId === null ? null : this.store.getRadioProfile(record.profileId);
      return {
        profileId: record.profileId,
        label: record.profileId === null ? "Default" : (profile?.name ?? `profile:${record.profileId}`),
        radioId: link?.getRadioId() ?? record.lastRadioId,
        standby: link?.isStandby() ?? record.standby,
        connection: {
          state: link?.getState() ?? "disconnected",
          transport: record.profileId === null ? effective.connection : this.profileSettings(record.profileId).connection,
          target: link ? describeTargetSafe(record.profileId === null ? effective : this.profileSettings(record.profileId)) : null,
          lastError: link?.getLastError() ?? null,
          connectedAt: link?.getConnectedAt() ?? null,
        },
      };
    });
    return {
      connection: {
        state: primary?.getState() ?? "disconnected",
        transport: effective.connection,
        target,
        lastError: primary?.getLastError() ?? null,
        connectedAt: primary?.getConnectedAt() ?? null,
      },
      self: displayRadioId === null ? null : this.store.getSelf(displayRadioId),
      batteryMilliVolts: displayRadioId === null ? null : this.store.latestBatteryMv(displayRadioId),
      counts: displayRadioId === null ? { contacts: 0, messages: 0, unread: 0 } : this.store.counts(displayRadioId),
      activeRadioId: this.getActiveRadioId(),
      radios: this.store.listRadios(this.getActiveRadioId()),
      links,
      version: this.appVersion,
    };
  }

  /** Whether a reconnect is scheduled and its current backoff delay, for diagnostics. */
  reconnectState(): { scheduled: boolean; delayMs: number } {
    return this.primaryLink()?.reconnectState() ?? { scheduled: false, delayMs: 0 };
  }

  async start(): Promise<void> {
    for (const record of this.store.listLinks()) {
      await this.ensureLinkRunning(record.profileId);
    }
  }

  /** Release the default (or, if that's not running, the sole) radio so a browser can claim it. Survives restarts. */
  async release(): Promise<void> {
    await this.primaryOrSoleLink()?.release();
  }

  /** Re-claim the radio after a release. */
  async claim(): Promise<void> {
    await this.primaryOrSoleLink()?.claim();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.links.values()].map((link) => link.stop()));
  }

  refreshContacts(radioId?: number): Promise<Contact[]> {
    return this.resolveLink(radioId).refreshContacts();
  }

  refreshChannels(radioId?: number): Promise<Channel[]> {
    return this.resolveLink(radioId).refreshChannels();
  }

  drainMessages(radioId?: number): Promise<void> {
    return this.resolveLink(radioId).drainMessages();
  }

  /**
   * Accept a direct message into the outbound queue and return it immediately
   * as `pending`. Works even with no radio ever connected — a queued send
   * attributes to the given (or default) radio, or a placeholder the first
   * connect will claim — and is delivered once a link for it exists. Never
   * blocks on radio availability.
   */
  async sendDirectMessage(contactKey: string, text: string, cli = false, radioId?: number): Promise<Message> {
    return this.enqueueOutboundMessage({ kind: "dm", contactKey, text, cli }, radioId);
  }

  async sendChannelMessage(channelIdx: number, text: string, radioId?: number): Promise<Message> {
    return this.enqueueOutboundMessage({ kind: "channel", channelIdx, text }, radioId);
  }

  private enqueueOutboundMessage(
    input:
      | { kind: "dm"; contactKey: string; text: string; cli: boolean }
      | { kind: "channel"; channelIdx: number; text: string },
    requestedRadioId?: number,
  ): Message {
    const radioId = requestedRadioId ?? this.defaultRadioId() ?? this.store.ensurePlaceholderRadio();
    // A radioId named explicitly resolves to that radio's own link (it may
    // have none yet, if it has never connected). With none given, the send
    // attributes to the default radio — check the *primary* link's standby,
    // not a not-yet-resolved link's, so a not-yet-connected default link's
    // standby still gates a plain send the way the old singleton's global
    // standby flag did.
    const link = requestedRadioId !== undefined ? this.linkForRadio(radioId) : this.primaryLink();
    // Standby means this radio was handed to a browser: reject rather than
    // queue a send that would fire much later on reclaim. A merely offline
    // radio (no link, or a link that's disconnected/connecting/error) still
    // queues and delivers once connected.
    if (link?.isStandby()) {
      throw new RadioUnavailableError("radio is in standby (released to a browser session)");
    }
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
    link?.kickOutbound();
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
    this.linkForRadio(entry.radioId)?.kickOutbound();
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

  sendAdvert(flood: boolean, radioId?: number): Promise<void> {
    return this.resolveLink(radioId).sendAdvert(flood);
  }

  async setChannel(idx: number, name: string, secretHex: string, radioId?: number): Promise<Channel> {
    return this.resolveLink(radioId).setChannel(idx, name, secretHex);
  }

  deleteChannel(idx: number, radioId?: number): Promise<void> {
    return this.resolveLink(radioId).deleteChannel(idx);
  }

  setDeviceSettings(
    patch: {
      name?: string;
      lat?: number;
      lon?: number;
      txPower?: number;
      radioFreq?: number;
      radioBw?: number;
      radioSf?: number;
      radioCr?: number;
    },
    radioId?: number,
  ): Promise<SelfInfo> {
    return this.resolveLink(radioId).setDeviceSettings(patch);
  }

  removeContact(contactKey: string, radioId?: number): Promise<void> {
    return this.resolveLink(radioId).removeContact(contactKey);
  }

  /** Export a contact (or our own identity when key is null) as a meshcore:// URI. */
  exportContactUri(contactKey: string | null, radioId?: number): Promise<string> {
    return this.resolveLink(radioId).exportContactUri(contactKey);
  }

  /** Import a contact from a meshcore:// URI (raw advert packet hex also accepted). */
  importContactUri(uri: string, radioId?: number): Promise<Contact[]> {
    return this.resolveLink(radioId).importContactUri(uri);
  }

  resetContactPath(contactKey: string, radioId?: number): Promise<void> {
    return this.resolveLink(radioId).resetContactPath(contactKey);
  }

  /** Authenticate with a room server or repeater. Resolves false on wrong password/timeout. */
  loginToNode(contactKey: string, password: string, radioId?: number): Promise<boolean> {
    return this.resolveLink(radioId).loginToNode(contactKey, password);
  }

  /** Request live stats from a repeater or room server (requires prior login on most nodes). */
  getNodeStatus(contactKey: string, radioId?: number): Promise<NodeStats> {
    return this.resolveLink(radioId).getNodeStatus(contactKey);
  }

  /** Ask a remote node for its Cayenne LPP sensor telemetry. */
  requestTelemetry(contactKey: string, radioId?: number): Promise<SensorReading[]> {
    return this.resolveLink(radioId).requestTelemetry(contactKey);
  }

  /**
   * Compat singular view: the default link if running, else the first active
   * link, else undefined. Used for status/state reporting, where some answer
   * is always expected even when several links are active.
   */
  private primaryLink(): RadioLink | undefined {
    return this.links.get(null) ?? this.links.values().next().value;
  }

  /** Like `primaryLink`, but only when unambiguous — undefined rather than guessing among several non-default links. */
  private primaryOrSoleLink(): RadioLink | undefined {
    if (this.links.has(null)) return this.links.get(null);
    return this.links.size === 1 ? this.links.values().next().value : undefined;
  }

  private linkForRadio(radioId: number): RadioLink | undefined {
    for (const link of this.links.values()) {
      if (link.getRadioId() === radioId) return link;
    }
    return undefined;
  }

  /**
   * Resolve which link a write op targets: the named radio's link, or — with
   * none given — the sole running link. With no live radio at all, or with
   * several and no radioId to disambiguate, this rejects explicitly rather
   * than guessing which radio the caller meant.
   */
  private resolveLink(radioId?: number): RadioLink {
    if (radioId !== undefined) {
      const link = this.linkForRadio(radioId);
      if (!link) throw new RadioUnavailableError(`radio ${radioId} has no active connection`);
      return link;
    }
    if (this.links.size === 1) return this.links.values().next().value!;
    if (this.links.size === 0) throw new RadioUnavailableError("no radio connection configured");
    throw new AmbiguousLinkError("multiple radios are connected — specify radioId");
  }

  /** Create and start a link for `key` if the store still lists it active and it isn't already running. */
  private async ensureLinkRunning(key: number | null): Promise<void> {
    if (this.stopped || this.links.has(key)) return;
    const record = this.store.listLinks().find((link) => link.profileId === key);
    if (!record) return; // no longer persisted as active — nothing to start
    const link = this.createLink(record);
    this.links.set(key, link);
    await link.start();
  }

  /** Tear down and recreate `key`'s link so it picks up settings that changed underneath it. */
  private async restartLink(key: number | null): Promise<void> {
    await this.removeLink(key);
    await this.ensureLinkRunning(key);
  }

  private async removeLink(key: number | null): Promise<void> {
    const existing = this.links.get(key);
    if (!existing) return;
    await existing.stop();
    this.links.delete(key);
  }

  private createLink(record: RadioLinkRecord): RadioLink {
    const key = record.profileId;
    return new RadioLink({
      key,
      label: key === null ? "default" : `profile:${key}`,
      db: this.db,
      store: this.store,
      bus: this.bus,
      config: this.config,
      channelReadTimeoutMs: this.channelReadTimeoutMs,
      connectionFactory: this.connectionFactory,
      getEffectiveSettings: () =>
        key === null ? this.connectionSettings().effective : this.profileSettings(key),
      beforeConnect: () => this.checkBleExclusivity(key),
      onStateChange: () => this.publishStatus(),
      initialStandby: record.standby,
      initialRadioId: record.lastRadioId,
    });
  }

  /** A profile-keyed link's settings never merge with env/override — the profile is a complete target. */
  private profileSettings(profileId: number): ConnectionSettings {
    const profile = this.store.getRadioProfile(profileId);
    if (!profile) {
      // the profile was deleted out from under a running link (shouldn't
      // happen — deleteProfile guards the active profile — but fail closed)
      return { connection: "none", serialPort: null, serialBaud: 115_200, tcpHost: null, tcpPort: 5_000, bleAddress: null };
    }
    return {
      connection: profile.connection,
      serialPort: profile.serialPort,
      serialBaud: profile.serialBaud,
      tcpHost: profile.tcpHost,
      tcpPort: profile.tcpPort,
      bleAddress: profile.bleAddress,
    };
  }

  /**
   * At most one BLE link may run at a time (BlueZ exposes one adapter with no
   * cross-instance discovery coordination). Used both as a fast pre-check
   * before activating a BLE profile and as every link's `beforeConnect` (so
   * an edit-to-BLE or a reconnect race is caught the same way).
   */
  private checkBleExclusivity(requesting: number | null): string | null {
    for (const [key, link] of this.links) {
      if (key === requesting) continue;
      if (link.transport() === "ble" && ["connecting", "syncing", "connected"].includes(link.getState())) {
        return "another BLE radio connection is already active";
      }
    }
    return null;
  }

  private publishStatus(): void {
    this.bus.publish({ type: "status.changed", status: this.status() });
  }
}

function describeTargetSafe(settings: ConnectionSettings): string | null {
  try {
    return describeTarget(settings)?.target ?? null;
  } catch {
    return null;
  }
}
