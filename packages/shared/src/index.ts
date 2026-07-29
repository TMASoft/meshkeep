import { z } from "zod";

export type ConnectionTransport = "serial" | "tcp" | "ble" | "none";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "connected"
  | "standby"
  | "error";

export type ContactType = "chat" | "repeater" | "room" | "none";

export interface SelfInfo {
  publicKey: string;
  name: string;
  type: number;
  txPower: number;
  maxTxPower: number;
  lat: number | null;
  lon: number | null;
  radioFreq: number;
  radioBw: number;
  radioSf: number;
  radioCr: number;
  firmwareVer?: number | null;
  firmwareBuildDate?: string | null;
  manufacturerModel?: string | null;
}

export interface Contact {
  publicKey: string;
  name: string;
  type: ContactType;
  flags: number;
  outPathLen: number;
  lat: number | null;
  lon: number | null;
  lastAdvert: number;
  lastSeen: number | null;
}

export interface Channel {
  idx: number;
  name: string;
  secret: string;
}

export type MessageKind = "dm" | "channel";
export type MessageDirection = "in" | "out";
/**
 * Outbound lifecycle plus the incoming default. `retrying` is derived from the
 * outbound queue (a persisted `pending` message whose last hand-off attempt
 * failed and has a backoff scheduled); it is never stored on the message row.
 */
export type MessageStatus = "pending" | "sent" | "delivered" | "failed" | "retrying";

export interface Message {
  id: number;
  /** Stable browser/client ingestion identity, used to reconcile offline rows. */
  ingestionId?: string | null;
  kind: MessageKind;
  /** Full public key when a direct-message sender has been uniquely resolved. */
  contactKey: string | null;
  /** Sender public-key prefix for incoming direct messages, including unresolved senders. */
  contactPrefix?: string | null;
  contactName?: string | null;
  channelIdx: number | null;
  channelName?: string | null;
  direction: MessageDirection;
  text: string;
  senderTimestamp: number;
  pathLen: number | null;
  status: MessageStatus;
  createdAt: number;
  /** Signed-plain room posts: 4-byte pubkey prefix (hex) of the original author. */
  authorPrefix?: string | null;
  /** Author's contact name when the prefix matches a known contact. */
  authorName?: string | null;
}

/** Per-conversation unread count, keyed the same way conversations are addressed. */
export interface ConversationUnread {
  kind: MessageKind;
  /** Set for direct messages from a resolved contact. */
  contactKey: string | null;
  /** Set for direct messages whose sender prefix is still unresolved. */
  contactPrefix: string | null;
  /** Set for channel conversations. */
  channelIdx: number | null;
  unread: number;
}

export interface MessageSearchResult extends Message {
  /** Excerpt around the match; matched terms are wrapped in \x01…\x02. */
  snippet: string;
}

/** One outbound message awaiting (or having exhausted) delivery hand-off to the radio. */
export interface OutboundQueueEntry {
  messageId: number;
  kind: MessageKind;
  /** Set for direct messages. */
  contactKey: string | null;
  /** Set for channel messages. */
  channelIdx: number | null;
  text: string;
  attempts: number;
  maxAttempts: number;
  /** Epoch seconds the worker may next attempt this entry. */
  nextAttemptAt: number;
  lastError: string | null;
  /** `pending` (awaiting first/next attempt), `retrying` (backing off), `failed` (exhausted). */
  state: "pending" | "retrying" | "failed";
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionStatus {
  state: ConnectionState;
  transport: ConnectionTransport;
  target: string | null;
  lastError: string | null;
  connectedAt: number | null;
}

/**
 * A physical radio MeshKeep has stored data for, identified by its self public
 * key (issue #53). Stored contacts/channels/messages/telemetry are isolated per
 * radio; a switcher lets a client browse any of them. `publicKey` is null only
 * for a placeholder radio migrated from a pre-isolation database that has not
 * yet connected to learn its identity.
 */
export interface RadioSummary {
  id: number;
  publicKey: string | null;
  name: string | null;
  lastSeen: number;
  /** True for the radio the server is currently connected to (or last connected to). */
  isActive: boolean;
}

/**
 * One connection the server is currently maintaining (issue #53, Stage 3):
 * either a named radio profile, or the implicit env/override "default" link
 * (profileId null). Several may run concurrently.
 */
export interface LinkStatus {
  profileId: number | null;
  /** The saved profile's name, or "Default" for the env/override link. */
  label: string;
  radioId: number | null;
  standby: boolean;
  connection: ConnectionStatus;
}

export interface AppStatus {
  /**
   * Compatibility view of a single connection, populated from the default
   * link if running, else the first active link, else idle/disconnected
   * placeholders. Kept for existing single-radio consumers (including
   * external API-token integrations) — prefer `links` for anything
   * concurrency-aware.
   */
  connection: ConnectionStatus;
  self: SelfInfo | null;
  batteryMilliVolts: number | null;
  counts: {
    contacts: number;
    messages: number;
    unread: number;
  };
  /** The connected (or last-connected) radio's id, null before the first sync. */
  activeRadioId: number | null;
  /** Every radio with stored data, for the browse/switcher UI. */
  radios: RadioSummary[];
  /** Every connection the server currently maintains — usually one, possibly several. */
  links: LinkStatus[];
  version: string;
}

/** SQLite durability snapshot surfaced by the diagnostics endpoint. */
export interface DatabaseDiagnostics {
  integrity: string;
  foreignKeyViolations: number;
  journalMode: string;
  synchronous: number;
  busyTimeoutMs: number;
  schemaVersion: number;
  latestSchemaVersion: number;
  pageSizeBytes: number;
  pageCount: number;
  freelistPages: number;
  sizeBytes: number;
  walPages: number;
}

/**
 * Aggregated, secret-free diagnostics for the diagnostics page and support
 * bundle. Contains no message content, credentials, or private keys.
 */
export interface ServerDiagnostics {
  server: { version: string; uptimeSeconds: number; nodeVersion: string; platform: string };
  connection: ConnectionStatus & { reconnectScheduled: boolean; reconnectDelayMs: number };
  firmware: { version: number | null; buildDate: string | null; model: string | null };
  radio: { freqHz: number | null; bandwidthHz: number | null; spreadingFactor: number | null; codingRate: number | null } | null;
  database: DatabaseDiagnostics;
  map: { enabled: boolean; fetchedAt: number | null; lastError: string | null };
  counts: { contacts: number; messages: number; unread: number };
  /** Actionable operator guidance (e.g. firmware/compatibility warnings). */
  guidance: string[];
}

/** A secret-free structured event displayed in the authenticated diagnostics UI. */
export interface DiagnosticLogEntry {
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  event: string;
  fields?: Record<string, unknown>;
}

/** Remote node stats returned by a repeater/room server status request. */
export interface NodeStats {
  battMilliVolts: number;
  currTxQueueLen: number;
  noiseFloor: number;
  lastRssi: number;
  nPacketsRecv: number;
  nPacketsSent: number;
  totalAirTimeSecs: number;
  totalUpTimeSecs: number;
  nSentFlood: number;
  nSentDirect: number;
  nRecvFlood: number;
  nRecvDirect: number;
  errEvents: number;
  lastSnr: number;
  nDirectDups: number;
  nFloodDups: number;
}

export interface TelemetryPoint {
  ts: number;
  batteryMv: number | null;
}

/** One parsed Cayenne LPP reading from a remote telemetry request. */
export interface SensorReading {
  channel: number;
  type: number;
  label: string;
  unit: string | null;
  value: number | Record<string, number>;
}

/** One stored remote telemetry response for a contact. */
export interface ContactTelemetryPoint {
  ts: number;
  readings: SensorReading[];
}

/** A contact opted into background telemetry polling (issue #52). */
export interface TelemetryMonitor {
  contactKey: string;
  createdAt: number;
}

export type AlertComparator = "below" | "above";

/**
 * A configured threshold on either the local radio's battery (contactKey
 * null, metric "battery_mv") or a remote contact's Cayenne sensor channel
 * (metric "<channel>:<type>", matching the sensor sparkline keys already
 * used client-side). lastState debounces delivery to transitions only.
 */
export interface TelemetryAlertRule {
  id: number;
  contactKey: string | null;
  metric: string;
  comparator: AlertComparator;
  threshold: number;
  lastState: "ok" | "breached";
}

/** One fired threshold transition, also the notification payload. */
export interface TelemetryAlertEvent {
  id: number;
  ruleId: number;
  contactKey: string | null;
  contactName: string | null;
  metric: string;
  label: string;
  value: number;
  threshold: number;
  comparator: AlertComparator;
  direction: "breach" | "recover";
  ts: number;
}

// Timeline (per-radio event history). Adverts and link transitions are stored
// in their own table; message/alert/telemetry entries are derived at query
// time from the tables that already hold them, so nothing is duplicated.
export type TimelineEventKind = "advert" | "message" | "alert" | "link" | "telemetry";

/** Snapshot of a contact as it looked when the advert arrived. */
export interface TimelineAdvertPayload {
  contactKey: string;
  name: string;
  type: ContactType;
  flags: number;
  outPathLen: number;
  lat: number | null;
  lon: number | null;
  /** "new" = full NewAdvert frame; "seen" = key-only Advert push. */
  observed: "new" | "seen";
}

export interface TimelineLinkPayload {
  state: "connected" | "disconnected";
  transport: ConnectionTransport;
  label: string;
  error: string | null;
}

export interface TimelineMessagePayload {
  messageId: number;
  messageKind: MessageKind;
  direction: MessageDirection;
  contactKey: string | null;
  contactPrefix: string | null;
  contactName: string | null;
  channelIdx: number | null;
  channelName: string | null;
  senderTimestamp: number;
  preview: string;
}

export interface TimelineTelemetryPayload {
  /** Null for the local radio's own battery samples. */
  contactKey: string | null;
  contactName: string | null;
  batteryMv: number | null;
  readings: SensorReading[];
}

/**
 * One normalized timeline entry. `id` is source-prefixed (adv:/lnk:/msg:/
 * alr:/tlm:) so ids are unique across the tables the feed is merged from.
 */
interface TimelineEventBase {
  id: string;
  radioId: number;
  ts: number;
}

export type TimelineEvent =
  | (TimelineEventBase & { kind: "advert"; advert: TimelineAdvertPayload })
  | (TimelineEventBase & { kind: "link"; link: TimelineLinkPayload })
  | (TimelineEventBase & { kind: "message"; message: TimelineMessagePayload })
  | (TimelineEventBase & { kind: "alert"; alert: TelemetryAlertEvent })
  | (TimelineEventBase & { kind: "telemetry"; telemetry: TimelineTelemetryPayload });

/** Event counts inside one bucket of the overview histogram, keyed by kind. */
export interface TimelineOverviewBucket {
  /** Start of the bucket; it covers [ts, ts + bucketSecs). */
  ts: number;
  counts: Partial<Record<TimelineEventKind, number>>;
}

/**
 * Coarse density summary of a radio's whole stored history, used to draw the
 * navigator strip under the zoomable timeline. `from`/`to` are the real extent
 * of the matching events (both 0 when there are none), so the client can show
 * everything that exists without fetching it.
 */
export interface TimelineOverview {
  from: number;
  to: number;
  bucketSecs: number;
  /** Ascending by `ts`; empty buckets are omitted. */
  buckets: TimelineOverviewBucket[];
  total: number;
}

/** Connection settings the server can be pointed at (env or runtime override). */
export interface ConnectionSettings {
  connection: ConnectionTransport;
  serialPort: string | null;
  serialBaud: number;
  tcpHost: string | null;
  tcpPort: number;
  bleAddress: string | null;
}

/**
 * A saved, named connection target (issue #53). The active profile — when one
 * is selected — takes precedence over env settings and the runtime override.
 */
export interface RadioProfile extends ConnectionSettings {
  id: number;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// Hardware auto-detection (Radio → Connection).
export interface DetectedSerialPort {
  /** Stable /dev/serial/by-id path when available, otherwise the raw path. */
  path: string;
  rawPath: string;
  manufacturer: string | null;
  vendorId: string | null;
  productId: string | null;
  label: string;
  likelyRadio: boolean;
}

export interface BleCandidate {
  address: string;
  name: string | null;
  rssi: number | null;
  paired: boolean;
  /** Advertises the Nordic UART service the companion firmware uses. */
  nus: boolean;
}

export interface MapNode {
  publicKey: string;
  name: string;
  type: ContactType;
  lat: number;
  lon: number;
  lastSeen?: number | null;
  local?: boolean;
}

// WebSocket events pushed by the server to browsers.
// Per-radio events carry the `radioId` they belong to so a browser viewing a
// different radio can ignore them. `status.changed` is global (it already
// reports the active radio and the full radio list in AppStatus).
export type WsEvent =
  | { type: "status.changed"; status: AppStatus }
  | { type: "message.new"; radioId: number; message: Message }
  | { type: "message.status"; radioId: number; id: number; status: MessageStatus }
  | { type: "contact.updated"; radioId: number; contact: Contact }
  | { type: "contact.removed"; radioId: number; publicKey: string }
  | { type: "self.updated"; radioId: number; self: SelfInfo }
  | { type: "telemetry"; radioId: number; batteryMilliVolts: number; ts: number }
  | { type: "telemetry.alert"; radioId: number; event: TelemetryAlertEvent }
  | { type: "timeline.event"; radioId: number; event: TimelineEvent };

/** The explicit, signed v1 payload surface for external event integrations. */
export const EXTERNAL_EVENT_TYPES = [
  "message.created",
  "message.status_changed",
  "contact.updated",
  "contact.removed",
  "telemetry.received",
  "telemetry.alert_triggered",
  "radio.link_changed",
  "radio.status_changed",
] as const;
export type ExternalEventType = (typeof EXTERNAL_EVENT_TYPES)[number];

const externalEnvelopeFields = {
  id: z.string().min(1),
  eventVersion: z.literal(1),
  occurredAt: z.string().datetime(),
  source: z.object({
    product: z.literal("meshkeep"),
    apiVersion: z.literal("v1"),
    radioId: z.number().int().nonnegative(),
  }),
};

/** Stable projection of message metadata; text is only present with sensitive opt-in. */
export const externalMessageSchema = z.object({
  id: z.number().int().nonnegative(),
  kind: z.enum(["dm", "channel"]),
  direction: z.enum(["in", "out"]),
  contactKey: z.string().nullable(),
  contactName: z.string().nullable(),
  channelIdx: z.number().int().nonnegative().nullable(),
  channelName: z.string().nullable(),
  senderTimestamp: z.number().int().nonnegative(),
  status: z.enum(["pending", "sent", "delivered", "failed", "retrying"]),
  createdAt: z.number().int().nonnegative(),
  text: z.string().optional(),
});

/** Stable projection of contact metadata; coordinates are only present with sensitive opt-in. */
export const externalContactSchema = z.object({
  publicKey: z.string(),
  name: z.string(),
  type: z.enum(["chat", "repeater", "room", "none"]),
  flags: z.number().int(),
  outPathLen: z.number().int(),
  lastAdvert: z.number().int().nonnegative(),
  lastSeen: z.number().int().nonnegative().nullable(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
});

/** Persisted alert fields that are safe to expose to an external receiver. */
export const externalAlertSchema = z.object({
  id: z.number().int().nonnegative(),
  ruleId: z.number().int().nonnegative(),
  contactKey: z.string().nullable(),
  contactName: z.string().nullable(),
  metric: z.string(),
  label: z.string(),
  value: z.number(),
  threshold: z.number(),
  comparator: z.enum(["below", "above"]),
  direction: z.enum(["breach", "recover"]),
  ts: z.number().int().nonnegative(),
});

/** `type` and `eventVersion` select one of these stable external shapes. */
export const externalMessageCreatedEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("message.created"),
  data: z.object({ message: externalMessageSchema }),
});
export const externalMessageStatusChangedEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("message.status_changed"),
  data: z.object({
    messageId: z.number().int().nonnegative(),
    status: z.enum(["pending", "sent", "delivered", "failed", "retrying"]),
    previousStatus: z.enum(["pending", "sent", "delivered", "failed", "retrying"]).optional(),
  }),
});
export const externalContactUpdatedEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("contact.updated"),
  data: z.object({ contact: externalContactSchema }),
});
export const externalContactRemovedEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("contact.removed"),
  data: z.object({ publicKey: z.string() }),
});
export const externalTelemetryReceivedEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("telemetry.received"),
  data: z.object({
    telemetry: z.object({ batteryMilliVolts: z.number().int(), ts: z.number().int().nonnegative() }),
  }),
});
export const externalTelemetryAlertTriggeredEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("telemetry.alert_triggered"),
  data: z.object({ alert: externalAlertSchema }),
});
export const externalRadioLinkChangedEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("radio.link_changed"),
  data: z.object({
    radio: z.object({
      state: z.enum(["connected", "disconnected"]),
      transport: z.enum(["serial", "tcp", "ble", "none"]),
      label: z.string(),
      errorCode: z
        .enum(["timeout", "disconnected", "authentication", "connection_failed", "unknown"])
        .nullable(),
    }),
  }),
});
export const externalRadioStatusChangedEventSchema = z.object({
  ...externalEnvelopeFields,
  type: z.literal("radio.status_changed"),
  data: z.object({
    radio: z.object({
      state: z.enum(["disconnected", "connecting", "syncing", "connected", "standby", "error"]),
      transport: z.enum(["serial", "tcp", "ble", "none"]),
      connectedAt: z.number().int().nonnegative().nullable(),
      counts: z.object({
        contacts: z.number().int().nonnegative(),
        messages: z.number().int().nonnegative(),
        unread: z.number().int().nonnegative(),
      }),
    }),
  }),
});
export const externalEventEnvelopeSchema = z.discriminatedUnion("type", [
  externalMessageCreatedEventSchema,
  externalMessageStatusChangedEventSchema,
  externalContactUpdatedEventSchema,
  externalContactRemovedEventSchema,
  externalTelemetryReceivedEventSchema,
  externalTelemetryAlertTriggeredEventSchema,
  externalRadioLinkChangedEventSchema,
  externalRadioStatusChangedEventSchema,
]);
export type ExternalMessage = z.infer<typeof externalMessageSchema>;
export type ExternalContact = z.infer<typeof externalContactSchema>;
export type ExternalAlert = z.infer<typeof externalAlertSchema>;
export type ExternalMessageCreatedEvent = z.infer<typeof externalMessageCreatedEventSchema>;
export type ExternalMessageStatusChangedEvent = z.infer<typeof externalMessageStatusChangedEventSchema>;
export type ExternalContactUpdatedEvent = z.infer<typeof externalContactUpdatedEventSchema>;
export type ExternalContactRemovedEvent = z.infer<typeof externalContactRemovedEventSchema>;
export type ExternalTelemetryReceivedEvent = z.infer<typeof externalTelemetryReceivedEventSchema>;
export type ExternalTelemetryAlertTriggeredEvent = z.infer<typeof externalTelemetryAlertTriggeredEventSchema>;
export type ExternalRadioLinkChangedEvent = z.infer<typeof externalRadioLinkChangedEventSchema>;
export type ExternalRadioStatusChangedEvent = z.infer<typeof externalRadioStatusChangedEventSchema>;
export type ExternalEventEnvelope = z.infer<typeof externalEventEnvelopeSchema>;

export interface ExternalEventProjectionOptions {
  /** Generated by the durable event owner; never derive this from a row id. */
  id: string;
  occurredAt?: string;
  includeSensitive?: boolean;
  /** Explicit allow-list only. Empty lists match nothing; wildcards are unsupported. */
  eventTypes?: readonly ExternalEventType[];
  /** Omit to match every radio; an empty list matches no radio. */
  radioIds?: readonly number[];
}

/**
 * Projects browser-oriented bus events into the deliberately small external
 * contract. This is the only boundary where sensitive fields may be added;
 * never persist or serialize a WsEvent or shared entity directly for delivery.
 */
export function projectWsEvent(
  event: WsEvent,
  options: ExternalEventProjectionOptions,
): ExternalEventEnvelope | null {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const allowed = (type: ExternalEventType, radioId: number): boolean =>
    (options.eventTypes === undefined || options.eventTypes.includes(type)) &&
    (options.radioIds === undefined || options.radioIds.includes(radioId));
  const envelope = (
    type: ExternalEventType,
    radioId: number,
    data: unknown,
  ): ExternalEventEnvelope | null => {
    if (!allowed(type, radioId)) return null;
    return externalEventEnvelopeSchema.parse({
      id: options.id,
      type,
      eventVersion: 1,
      occurredAt,
      source: { product: "meshkeep", apiVersion: "v1", radioId },
      data,
    });
  };

  switch (event.type) {
    case "message.new": {
      const {
        id,
        kind,
        direction,
        contactKey,
        contactName,
        channelIdx,
        channelName,
        senderTimestamp,
        status,
        createdAt,
      } = event.message;
      const message = {
        id,
        kind,
        direction,
        contactKey,
        contactName: contactName ?? null,
        channelIdx,
        channelName: channelName ?? null,
        senderTimestamp,
        status,
        createdAt,
      };
      return envelope("message.created", event.radioId, {
        message: options.includeSensitive ? { ...message, text: event.message.text } : message,
      });
    }
    case "message.status":
      return envelope("message.status_changed", event.radioId, { messageId: event.id, status: event.status });
    case "contact.updated": {
      const { publicKey, name, type, flags, outPathLen, lastAdvert, lastSeen } = event.contact;
      const contact = { publicKey, name, type, flags, outPathLen, lastAdvert, lastSeen };
      return envelope("contact.updated", event.radioId, {
        contact: options.includeSensitive
          ? { ...contact, lat: event.contact.lat, lon: event.contact.lon }
          : contact,
      });
    }
    case "contact.removed":
      return envelope("contact.removed", event.radioId, { publicKey: event.publicKey });
    case "telemetry":
      return envelope("telemetry.received", event.radioId, {
        telemetry: { batteryMilliVolts: event.batteryMilliVolts, ts: event.ts },
      });
    case "telemetry.alert": {
      const {
        id,
        ruleId,
        contactKey,
        contactName,
        metric,
        label,
        value,
        threshold,
        comparator,
        direction,
        ts,
      } = event.event;
      return envelope("telemetry.alert_triggered", event.radioId, {
        alert: {
          id,
          ruleId,
          contactKey,
          contactName,
          metric,
          label,
          value,
          threshold,
          comparator,
          direction,
          ts,
        },
      });
    }
    case "timeline.event":
      if (event.event.kind !== "link") return null;
      return envelope("radio.link_changed", event.radioId, {
        radio: {
          state: event.event.link.state,
          transport: event.event.link.transport,
          label: event.event.link.label,
          errorCode: connectionErrorCode(event.event.link.error),
        },
      });
    case "status.changed":
      if (event.status.activeRadioId === null) return null;
      return envelope("radio.status_changed", event.status.activeRadioId, {
        radio: {
          state: event.status.connection.state,
          transport: event.status.connection.transport,
          connectedAt: event.status.connection.connectedAt,
          counts: event.status.counts,
        },
      });
    case "self.updated":
      return null;
  }
}

function connectionErrorCode(
  error: string | null,
): "timeout" | "disconnected" | "authentication" | "connection_failed" | "unknown" | null {
  if (error === null) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("disconnect") || normalized.includes("closed")) return "disconnected";
  if (normalized.includes("auth") || normalized.includes("credential")) return "authentication";
  if (normalized.includes("connect") || normalized.includes("refused")) return "connection_failed";
  return "unknown";
}

export const CONTACT_TYPE_FROM_ADV: Record<number, ContactType> = {
  0: "none",
  1: "chat",
  2: "repeater",
  3: "room",
};
export * from "./channels.js";
