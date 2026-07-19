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

export interface AppStatus {
  connection: ConnectionStatus;
  self: SelfInfo | null;
  batteryMilliVolts: number | null;
  counts: {
    contacts: number;
    messages: number;
    unread: number;
  };
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
export type WsEvent =
  | { type: "status.changed"; status: AppStatus }
  | { type: "message.new"; message: Message }
  | { type: "message.status"; id: number; status: MessageStatus }
  | { type: "contact.updated"; contact: Contact }
  | { type: "contact.removed"; publicKey: string }
  | { type: "self.updated"; self: SelfInfo }
  | { type: "telemetry"; batteryMilliVolts: number; ts: number };

export const CONTACT_TYPE_FROM_ADV: Record<number, ContactType> = {
  0: "none",
  1: "chat",
  2: "repeater",
  3: "room",
};
export * from "./channels.js";
