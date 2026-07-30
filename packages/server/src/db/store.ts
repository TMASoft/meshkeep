import { createHash, randomUUID } from "node:crypto";
import type {
  AlertComparator,
  Channel,
  Contact,
  ContactTelemetryPoint,
  ConversationUnread,
  Message,
  MessageDirection,
  MessageKind,
  MessageSearchResult,
  MessageStatus,
  OutboundQueueEntry,
  RadioProfile,
  RadioSummary,
  SelfInfo,
  SensorReading,
  TelemetryAlertEvent,
  TelemetryAlertRule,
  TelemetryMonitor,
  TelemetryPoint,
  TimelineAdvertPayload,
  TimelineEvent,
  TimelineEventKind,
  TimelineLinkPayload,
  TimelineOverview,
  TimelineOverviewBucket,
} from "@meshkeep/shared";
import { WEBHOOK_TEST_EVENT_TYPE } from "@meshkeep/shared";
import type { Db } from "./index.js";
import type { WebhookCrypto } from "../webhooks/crypto.js";

const now = () => Math.floor(Date.now() / 1000);

/**
 * Where each timeline kind physically lives, for the overview aggregate. These
 * fragments are compile-time constants — only radio ids and bucket sizes are
 * ever bound as parameters.
 */
const OVERVIEW_SOURCES: Record<
  TimelineEventKind,
  { table: string; tsCol: string; where: string }
> = {
  advert: {
    table: "timeline_events",
    tsCol: "ts",
    where: "AND kind = 'advert'",
  },
  link: { table: "timeline_events", tsCol: "ts", where: "AND kind = 'link'" },
  message: { table: "messages", tsCol: "created_at", where: "" },
  alert: { table: "telemetry_alert_events", tsCol: "ts", where: "" },
  telemetry: { table: "telemetry", tsCol: "ts", where: "" },
};

/** Store-internal outbound entry: the shared shape plus the radio and `cli` flag the worker needs. */
export interface OutboundEntry extends OutboundQueueEntry {
  radioId: number;
  cli: boolean;
}

export interface WebhookSubscription {
  id: number;
  label: string;
  destination: string;
  eventTypes: string[];
  radioIds: number[] | null;
  includeSensitive: boolean;
  state: "active" | "paused" | "disabled";
  activeKeyId: string | null;
  /** Redacted operator-visible reason for the last pause/disable, if any. */
  lastFailureSummary: string | null;
  /** Terminal delivery failures since the last success; drives the pause burst. */
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDelivery {
  id: number;
  subscriptionId: number;
  eventId: string;
  keyId: string;
  state: "queued" | "leased" | "delivered" | "failed" | "dropped";
  attemptCount: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
}

export interface WebhookDeliverySummary extends WebhookDelivery {
  responseStatus: number | null;
  responseClass: string | null;
  errorSummary: string | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDeliveryJob extends WebhookDelivery {
  destination: string;
  subscriptionState: WebhookSubscription["state"];
  type: string;
  eventVersion: number;
  body: Buffer;
  firstAttemptAt: number | null;
}

/** A browser's Web Push endpoint (issue #76 prototype), bound to the session that created it. */
export interface PushSubscription {
  id: number;
  sessionTokenHash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
  consecutiveFailures: number;
}

interface PushSubscriptionRow {
  id: number;
  session_token_hash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  consecutive_failures: number;
}

function rowToPushSubscription(row: PushSubscriptionRow): PushSubscription {
  return {
    id: row.id,
    sessionTokenHash: row.session_token_hash,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at,
    consecutiveFailures: row.consecutive_failures,
  };
}

interface WebhookSubscriptionRow {
  id: number;
  label: string;
  destination: string;
  event_types_json: string;
  radio_ids_json: string | null;
  include_sensitive: number;
  state: WebhookSubscription["state"];
  active_key_id: string | null;
  last_failure_summary: string | null;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
}

interface WebhookDeliveryRow {
  id: number;
  subscription_id: number;
  event_id: string;
  key_id: string;
  state: WebhookDelivery["state"];
  attempt_count: number;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
}

function rowToWebhookSubscription(
  row: WebhookSubscriptionRow,
): WebhookSubscription {
  return {
    id: row.id,
    label: row.label,
    destination: row.destination,
    eventTypes: JSON.parse(row.event_types_json) as string[],
    radioIds:
      row.radio_ids_json === null
        ? null
        : (JSON.parse(row.radio_ids_json) as number[]),
    includeSensitive: row.include_sensitive === 1,
    state: row.state,
    activeKeyId: row.active_key_id,
    lastFailureSummary: row.last_failure_summary,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWebhookDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    keyId: row.key_id,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
  };
}

interface OutboundRow {
  message_id: number;
  radio_id: number;
  kind: MessageKind;
  contact_key: string | null;
  channel_idx: number | null;
  text: string;
  cli: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  state: OutboundQueueEntry["state"];
  created_at: number;
  updated_at: number;
}

function rowToOutbound(row: OutboundRow): OutboundEntry {
  return {
    messageId: row.message_id,
    radioId: row.radio_id,
    kind: row.kind,
    contactKey: row.contact_key,
    channelIdx: row.channel_idx,
    text: row.text,
    cli: row.cli === 1,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Connection fields of a profile; name required on create, defaults fill the rest. */
export type RadioProfileInput = Pick<RadioProfile, "name" | "connection"> &
  Partial<
    Pick<
      RadioProfile,
      "serialPort" | "serialBaud" | "tcpHost" | "tcpPort" | "bleAddress"
    >
  >;

/** A profile name is a user-facing unique handle; surfaced as a conflict, not an internal error. */
export class DuplicateProfileNameError extends Error {}

function translateProfileNameConflict(error: unknown, name: string): unknown {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  ) {
    return new DuplicateProfileNameError(
      `a radio profile named "${name}" already exists`,
    );
  }
  return error;
}

interface RadioProfileRow {
  id: number;
  name: string;
  transport: RadioProfile["connection"];
  serial_port: string | null;
  serial_baud: number;
  tcp_host: string | null;
  tcp_port: number;
  ble_address: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRadioProfile(row: RadioProfileRow): RadioProfile {
  return {
    id: row.id,
    name: row.name,
    connection: row.transport,
    serialPort: row.serial_port,
    serialBaud: row.serial_baud,
    tcpHost: row.tcp_host,
    tcpPort: row.tcp_port,
    bleAddress: row.ble_address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RadioRow {
  id: number;
  public_key: string | null;
  name: string | null;
  first_seen: number;
  last_seen: number;
  updated_at: number;
}

/** A row's existence means the server should currently maintain that connection (issue #53, Stage 3). */
export interface RadioLinkRecord {
  /** null selects the implicit env/override "default" link (no profile). */
  profileId: number | null;
  standby: boolean;
  /** The last radio identity this link resolved to, for display before it reconnects. */
  lastRadioId: number | null;
  activatedAt: number;
  updatedAt: number;
}

interface RadioLinkRow {
  profile_id: number | null;
  standby: number;
  last_radio_id: number | null;
  activated_at: number;
  updated_at: number;
}

function rowToRadioLinkRecord(row: RadioLinkRow): RadioLinkRecord {
  return {
    profileId: row.profile_id,
    standby: row.standby === 1,
    lastRadioId: row.last_radio_id,
    activatedAt: row.activated_at,
    updatedAt: row.updated_at,
  };
}

interface MessageRow {
  id: number;
  ingestion_id: string | null;
  kind: MessageKind;
  contact_key: string | null;
  contact_prefix: string | null;
  channel_idx: number | null;
  direction: MessageDirection;
  text: string;
  sender_timestamp: number;
  path_len: number | null;
  status: MessageStatus;
  created_at: number;
  author_prefix: string | null;
  contact_name?: string | null;
  channel_name?: string | null;
  author_name?: string | null;
  queue_state?: "pending" | "retrying" | "failed" | null;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    ingestionId: row.ingestion_id,
    kind: row.kind,
    contactKey: row.contact_key,
    contactPrefix: row.contact_prefix,
    contactName: row.contact_name ?? null,
    channelIdx: row.channel_idx,
    channelName: row.channel_name ?? null,
    direction: row.direction,
    text: row.text,
    senderTimestamp: row.sender_timestamp,
    pathLen: row.path_len,
    // A queued send whose last hand-off attempt failed reports `retrying`; the
    // stored coarse status stays `pending` until it terminally succeeds/fails.
    status: row.queue_state === "retrying" ? "retrying" : row.status,
    createdAt: row.created_at,
    authorPrefix: row.author_prefix,
    authorName: row.author_name ?? null,
  };
}

// Author attribution resolves only when the prefix matches exactly one contact
// *of the same radio*. A scalar subquery (never a JOIN) guarantees one row per
// message even when multiple contacts share the prefix, and yields NULL on ambiguity.
const AUTHOR_NAME_SELECT = `(
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(a.name) END
    FROM contacts a
    WHERE a.radio_id = m.radio_id AND m.author_prefix IS NOT NULL AND a.public_key LIKE m.author_prefix || '%'
  ) AS author_name`;

// Contact/channel names join within the message's own radio so a same-keyed
// contact on another radio can never bleed a name across the isolation boundary.
const MESSAGE_SELECT = `
  SELECT m.*, c.name AS contact_name, ch.name AS channel_name, q.state AS queue_state, ${AUTHOR_NAME_SELECT}
  FROM messages m
  LEFT JOIN contacts c ON c.public_key = m.contact_key AND c.radio_id = m.radio_id
  LEFT JOIN channels ch ON ch.idx = m.channel_idx AND ch.radio_id = m.radio_id
  LEFT JOIN outbound_queue q ON q.message_id = m.id
`;

export class Store {
  constructor(private readonly db: Db) {}

  // ---- radio identity (issue #53) ----

  /**
   * Resolve the physical radio behind a connect to a stable local id, creating
   * it on first sight. If a placeholder row (public_key IS NULL, seeded from a
   * pre-isolation database that had not connected) exists, it is claimed so the
   * migrated data attaches to the real radio instead of orphaning. Touches
   * last_seen/name on every call.
   */
  resolveRadio(publicKey: string, name: string | null): number {
    const ts = now();
    // Update the stored name only when a real one is supplied — a nameless
    // ingest batch must not blank a name a full sync already recorded.
    const existing = this.db
      .prepare("SELECT id FROM radios WHERE public_key = ?")
      .get(publicKey) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          "UPDATE radios SET name = COALESCE(?, name), last_seen = ?, updated_at = ? WHERE id = ?",
        )
        .run(name, ts, ts, existing.id);
      return existing.id;
    }
    const placeholder = this.db
      .prepare(
        "SELECT id FROM radios WHERE public_key IS NULL ORDER BY id LIMIT 1",
      )
      .get() as { id: number } | undefined;
    if (placeholder) {
      this.db
        .prepare(
          "UPDATE radios SET public_key = ?, name = COALESCE(?, name), last_seen = ?, updated_at = ? WHERE id = ?",
        )
        .run(publicKey, name, ts, ts, placeholder.id);
      return placeholder.id;
    }
    const result = this.db
      .prepare(
        "INSERT INTO radios (public_key, name, first_seen, last_seen, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(publicKey, name, ts, ts, ts);
    return Number(result.lastInsertRowid);
  }

  /**
   * A radio id to attribute work to before any radio has been identified (e.g. a
   * send queued while the server has never connected). Reuses an existing
   * placeholder (public_key IS NULL) so the first real connect claims it via
   * resolveRadio and the queued work reattaches to the real radio.
   */
  ensurePlaceholderRadio(): number {
    const existing = this.db
      .prepare(
        "SELECT id FROM radios WHERE public_key IS NULL ORDER BY id LIMIT 1",
      )
      .get() as { id: number } | undefined;
    if (existing) return existing.id;
    const ts = now();
    return Number(
      this.db
        .prepare(
          "INSERT INTO radios (public_key, name, first_seen, last_seen, updated_at) VALUES (NULL, NULL, ?, ?, ?)",
        )
        .run(ts, ts, ts).lastInsertRowid,
    );
  }

  listRadios(activeRadioId: number | null): RadioSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM radios ORDER BY last_seen DESC, id DESC")
      .all() as RadioRow[];
    return rows.map((row) => ({
      id: row.id,
      publicKey: row.public_key,
      name: row.name,
      lastSeen: row.last_seen,
      isActive: row.id === activeRadioId,
    }));
  }

  getRadio(id: number): RadioSummary | null {
    const row = this.db.prepare("SELECT * FROM radios WHERE id = ?").get(id) as
      RadioRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      publicKey: row.public_key,
      name: row.name,
      lastSeen: row.last_seen,
      isActive: false,
    };
  }

  renameRadio(id: number, name: string): RadioSummary | null {
    const changed = this.db
      .prepare("UPDATE radios SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, now(), id).changes;
    return changed > 0 ? this.getRadio(id) : null;
  }

  /** Forget a radio and every row scoped to it. Returns false when the id is unknown. */
  deleteRadio(id: number): boolean {
    return this.db.transaction(() => {
      const exists = this.db
        .prepare("SELECT 1 FROM radios WHERE id = ?")
        .get(id);
      if (!exists) return false;
      // Delete messages before the radios row so the FTS delete triggers fire and
      // the outbound_queue FK cascades; then the remaining per-radio tables.
      this.db.prepare("DELETE FROM messages WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM outbound_queue WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM telemetry WHERE radio_id = ?").run(id);
      this.db
        .prepare("DELETE FROM telemetry_monitors WHERE radio_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM telemetry_alert_rules WHERE radio_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM telemetry_alert_events WHERE radio_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM timeline_events WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM channels WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM contacts WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM self WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM radios WHERE id = ?").run(id);
      return true;
    })();
  }

  saveSelf(radioId: number, self: SelfInfo): void {
    this.db
      .prepare(
        `INSERT INTO self (radio_id, public_key, name, raw_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(radio_id) DO UPDATE SET public_key = excluded.public_key, name = excluded.name,
           raw_json = excluded.raw_json, updated_at = excluded.updated_at`,
      )
      .run(radioId, self.publicKey, self.name, JSON.stringify(self), now());
  }

  getSelf(radioId: number): SelfInfo | null {
    const row = this.db
      .prepare("SELECT raw_json FROM self WHERE radio_id = ?")
      .get(radioId) as { raw_json: string } | undefined;
    return row ? (JSON.parse(row.raw_json) as SelfInfo) : null;
  }

  upsertContact(radioId: number, contact: Contact): string[] {
    this.db
      .prepare(
        `INSERT INTO contacts (radio_id, public_key, name, type, flags, out_path_len, lat, lon, last_advert, last_seen, updated_at)
         VALUES (@radioId, @publicKey, @name, @type, @flags, @outPathLen, @lat, @lon, @lastAdvert, @lastSeen, @updatedAt)
         ON CONFLICT(radio_id, public_key) DO UPDATE SET
           name = excluded.name, type = excluded.type, flags = excluded.flags,
           out_path_len = excluded.out_path_len, lat = excluded.lat, lon = excluded.lon,
           last_advert = excluded.last_advert,
           last_seen = COALESCE(excluded.last_seen, contacts.last_seen),
           updated_at = excluded.updated_at`,
      )
      .run({ ...contact, radioId, updatedAt: now() });
    return this.reconcileContactMessages(radioId, contact.publicKey);
  }

  /**
   * Update last-seen for a stored contact. Returns the updated contact, or
   * null when the contact is not stored yet — callers must sync the contact
   * list first rather than letting the touch land on a missing row and vanish.
   */
  touchContactSeen(radioId: number, publicKey: string): Contact | null {
    const result = this.db
      .prepare(
        "UPDATE contacts SET last_seen = ?, updated_at = ? WHERE radio_id = ? AND public_key = ?",
      )
      .run(now(), now(), radioId, publicKey);
    if (result.changes === 0) return null;
    return (
      this.getContacts(radioId).find(
        (contact) => contact.publicKey === publicKey,
      ) ?? null
    );
  }

  /**
   * Apply one confirmed complete radio contact scan atomically: upsert every
   * contact the radio reported, then drop stored contacts the radio no longer
   * has. The contacts table mirrors the radio's *current* contact list;
   * message history is the historical record — messages carry their own
   * contact_key/contact_prefix identity and stay queryable after a removal.
   * Never call this with a partial listing (e.g. a browser ingest batch).
   */
  syncContacts(radioId: number, contacts: Contact[]): { removed: string[] } {
    const removed: string[] = [];
    this.db.transaction(() => {
      for (const contact of contacts) this.upsertContact(radioId, contact);
      for (const known of this.getContacts(radioId)) {
        if (
          !contacts.some((contact) => contact.publicKey === known.publicKey)
        ) {
          this.removeContact(radioId, known.publicKey);
          removed.push(known.publicKey);
        }
      }
    })();
    return { removed };
  }

  getContacts(radioId: number): Contact[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM contacts WHERE radio_id = ? ORDER BY last_advert DESC",
      )
      .all(radioId) as Array<{
      public_key: string;
      name: string;
      type: Contact["type"];
      flags: number;
      out_path_len: number;
      lat: number | null;
      lon: number | null;
      last_advert: number;
      last_seen: number | null;
    }>;
    return rows.map((r) => ({
      publicKey: r.public_key,
      name: r.name,
      type: r.type,
      flags: r.flags,
      outPathLen: r.out_path_len,
      lat: r.lat,
      lon: r.lon,
      lastAdvert: r.last_advert,
      lastSeen: r.last_seen,
    }));
  }

  findUniqueContactByPrefix(
    radioId: number,
    pubKeyPrefixHex: string,
  ): Contact | null {
    const matches = this.getContacts(radioId).filter((c) =>
      c.publicKey.startsWith(pubKeyPrefixHex),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  private reconcileContactMessages(
    radioId: number,
    publicKey: string,
  ): string[] {
    const prefixes = this.db
      .prepare(
        `SELECT DISTINCT contact_prefix FROM messages
         WHERE radio_id = @radioId AND kind = 'dm' AND contact_key IS NULL AND contact_prefix IS NOT NULL
           AND @publicKey LIKE contact_prefix || '%'
           AND (SELECT COUNT(*) FROM contacts WHERE radio_id = @radioId AND public_key LIKE messages.contact_prefix || '%') = 1`,
      )
      .all({ radioId, publicKey }) as Array<{ contact_prefix: string }>;
    if (!prefixes.length) return [];
    this.db
      .prepare(
        `UPDATE messages SET contact_key = @publicKey
         WHERE radio_id = @radioId AND kind = 'dm' AND contact_key IS NULL AND contact_prefix IS NOT NULL
           AND @publicKey LIKE contact_prefix || '%'
           AND (SELECT COUNT(*) FROM contacts WHERE radio_id = @radioId AND public_key LIKE messages.contact_prefix || '%') = 1`,
      )
      .run({ radioId, publicKey });
    return prefixes.map((row) => row.contact_prefix);
  }

  removeContact(radioId: number, publicKey: string): void {
    this.db
      .prepare("DELETE FROM contacts WHERE radio_id = ? AND public_key = ?")
      .run(radioId, publicKey);
  }

  upsertChannel(radioId: number, channel: Channel): void {
    this.db
      .prepare(
        `INSERT INTO channels (radio_id, idx, name, secret_hex, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(radio_id, idx) DO UPDATE SET name = excluded.name, secret_hex = excluded.secret_hex, updated_at = excluded.updated_at`,
      )
      .run(radioId, channel.idx, channel.name, channel.secret, now());
  }

  deleteChannel(radioId: number, idx: number): void {
    this.db
      .prepare("DELETE FROM channels WHERE radio_id = ? AND idx = ?")
      .run(radioId, idx);
  }

  getChannels(radioId: number): Channel[] {
    const rows = this.db
      .prepare(
        "SELECT idx, name, secret_hex FROM channels WHERE radio_id = ? ORDER BY idx",
      )
      .all(radioId) as Array<{
      idx: number;
      name: string;
      secret_hex: string;
    }>;
    return rows.map((r) => ({
      idx: r.idx,
      name: r.name,
      secret: r.secret_hex,
    }));
  }

  listRadioProfiles(): RadioProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM radio_profiles ORDER BY name")
      .all() as RadioProfileRow[];
    return rows.map(rowToRadioProfile);
  }

  getRadioProfile(id: number): RadioProfile | null {
    const row = this.db
      .prepare("SELECT * FROM radio_profiles WHERE id = ?")
      .get(id) as RadioProfileRow | undefined;
    return row ? rowToRadioProfile(row) : null;
  }

  createRadioProfile(input: RadioProfileInput): RadioProfile {
    const ts = now();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO radio_profiles (name, transport, serial_port, serial_baud, tcp_host, tcp_port, ble_address, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.name,
          input.connection,
          input.serialPort ?? null,
          input.serialBaud ?? 115_200,
          input.tcpHost ?? null,
          input.tcpPort ?? 5_000,
          input.bleAddress ?? null,
          ts,
          ts,
        );
      return this.getRadioProfile(Number(result.lastInsertRowid))!;
    } catch (error) {
      throw translateProfileNameConflict(error, input.name);
    }
  }

  /** Apply a partial update; returns the updated profile or null when the id is unknown. */
  updateRadioProfile(
    id: number,
    patch: Partial<RadioProfileInput>,
  ): RadioProfile | null {
    const existing = this.getRadioProfile(id);
    if (!existing) return null;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const merged = { ...existing, ...defined };
    try {
      this.db
        .prepare(
          `UPDATE radio_profiles SET name = ?, transport = ?, serial_port = ?, serial_baud = ?, tcp_host = ?, tcp_port = ?, ble_address = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          merged.name,
          merged.connection,
          merged.serialPort,
          merged.serialBaud,
          merged.tcpHost,
          merged.tcpPort,
          merged.bleAddress,
          now(),
          id,
        );
    } catch (error) {
      throw translateProfileNameConflict(error, merged.name);
    }
    return this.getRadioProfile(id);
  }

  deleteRadioProfile(id: number): boolean {
    return (
      this.db.prepare("DELETE FROM radio_profiles WHERE id = ?").run(id)
        .changes > 0
    );
  }

  // ---- radio links (issue #53, Stage 3): which connections the server currently maintains ----

  listLinks(): RadioLinkRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM radio_links ORDER BY profile_id IS NOT NULL, profile_id",
      )
      .all() as RadioLinkRow[];
    return rows.map(rowToRadioLinkRecord);
  }

  /** Add a profile to the active-link set. Idempotent — activating an already-active profile is a no-op. */
  activateLink(profileId: number): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO radio_links (profile_id, standby, last_radio_id, activated_at, updated_at)
         VALUES (?, 0, NULL, ?, ?)
         ON CONFLICT(profile_id) DO NOTHING`,
      )
      .run(profileId, ts, ts);
  }

  /** Idempotent — deactivating a profile that has no link is a no-op. */
  deactivateLink(profileId: number): void {
    this.db
      .prepare("DELETE FROM radio_links WHERE profile_id = ?")
      .run(profileId);
  }

  /**
   * Enable or disable the implicit env/override "default" link (profile_id IS
   * NULL). The only code path allowed to write that row — SQLite's UNIQUE
   * treats every NULL as distinct, so "at most one default link" is enforced
   * here in application code rather than by the schema. Idempotent: enabling
   * an already-enabled default link leaves its standby/last_radio_id intact.
   */
  setDefaultLinkEnabled(enabled: boolean): void {
    const exists = this.db
      .prepare("SELECT 1 FROM radio_links WHERE profile_id IS NULL")
      .get();
    if (enabled && !exists) {
      const ts = now();
      this.db
        .prepare(
          "INSERT INTO radio_links (profile_id, standby, last_radio_id, activated_at, updated_at) VALUES (NULL, 0, NULL, ?, ?)",
        )
        .run(ts, ts);
    } else if (!enabled && exists) {
      this.db.prepare("DELETE FROM radio_links WHERE profile_id IS NULL").run();
    }
  }

  setLinkStandby(profileId: number | null, standby: boolean): void {
    this.db
      .prepare(
        "UPDATE radio_links SET standby = ?, updated_at = ? WHERE profile_id IS ?",
      )
      .run(standby ? 1 : 0, now(), profileId);
  }

  setLinkLastRadio(profileId: number | null, radioId: number): void {
    this.db
      .prepare(
        "UPDATE radio_links SET last_radio_id = ?, updated_at = ? WHERE profile_id IS ?",
      )
      .run(radioId, now(), profileId);
  }

  /**
   * Deterministic identity for a radio-inbound frame: MeshCore exposes no
   * frame/packet ID, so this stands in for one. Scoped narrowly enough to
   * preserve legitimate repeats — the sender's own `senderTimestamp` is the
   * discriminator, so a later, genuinely re-sent identical text still gets a
   * distinct id. This is only used when the caller has no ingestion ID of its
   * own (radio-inbound path); browser ingests always supply one.
   */
  private inboundFrameId(
    radioId: number,
    kind: MessageKind,
    conversationKey: string | number,
    senderTimestamp: number,
    authorPrefix: string | null,
    text: string,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          radioId,
          kind,
          conversationKey,
          senderTimestamp,
          authorPrefix,
          text,
        ]),
      )
      .digest("hex");
  }

  /** Insert a message once per stable ingestion ID, scoped to a radio. */
  insertMessage(
    radioId: number,
    input: {
      kind: MessageKind;
      contactKey?: string | null;
      contactPrefix?: string | null;
      channelIdx?: number | null;
      direction: MessageDirection;
      text: string;
      senderTimestamp: number;
      pathLen?: number | null;
      ackCrc?: number | null;
      status?: MessageStatus;
      authorPrefix?: string | null;
      ingestionId?: string;
    },
  ): Message | null {
    if (input.kind === "dm") {
      if (input.channelIdx != null)
        throw new Error("dm messages cannot carry a channel index");
      if (!input.contactKey && !input.contactPrefix) {
        throw new Error("dm messages need a contact key or sender prefix");
      }
    } else {
      if (input.channelIdx == null)
        throw new Error("channel messages need a channel index");
      if (input.contactKey || input.contactPrefix) {
        throw new Error("channel messages cannot carry a contact identity");
      }
    }
    const contactKey =
      input.kind === "dm" && !input.contactKey && input.contactPrefix
        ? (this.findUniqueContactByPrefix(radioId, input.contactPrefix)
            ?.publicKey ?? null)
        : (input.contactKey ?? null);
    const ingestionId =
      input.ingestionId ??
      (input.direction === "in"
        ? this.inboundFrameId(
            radioId,
            input.kind,
            input.kind === "dm"
              ? (input.contactPrefix ?? contactKey ?? "")
              : input.channelIdx!,
            input.senderTimestamp,
            input.authorPrefix ?? null,
            input.text,
          )
        : randomUUID());
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
             (radio_id, kind, contact_key, contact_prefix, channel_idx, direction, text, sender_timestamp, path_len, ack_crc, status, dedupe_hash, created_at, author_prefix, ingestion_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        radioId,
        input.kind,
        contactKey,
        input.contactPrefix ?? null,
        input.channelIdx ?? null,
        input.direction,
        input.text,
        input.senderTimestamp,
        input.pathLen ?? null,
        input.ackCrc ?? null,
        input.status ?? (input.direction === "in" ? "sent" : "pending"),
        randomUUID(), // Legacy non-null unique column; no longer an identity.
        now(),
        input.authorPrefix ?? null,
        ingestionId,
      );
    if (result.changes === 0) return null;
    return this.getMessage(Number(result.lastInsertRowid));
  }

  getMessage(id: number): Message | null {
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as
      MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  /** Late delivery-state update for a retried browser ingestion (ingestion id is globally unique). */
  updateMessageStatusByIngestionId(input: {
    ingestionId: string;
    status: MessageStatus;
  }): Message | null {
    const row = this.db
      .prepare(
        "SELECT id FROM messages WHERE ingestion_id = ? AND status IN ('pending','sent')",
      )
      .get(input.ingestionId) as { id: number } | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE messages SET status = ? WHERE id = ?")
      .run(input.status, row.id);
    return this.getMessage(row.id);
  }

  setMessageStatus(id: number, status: MessageStatus): void {
    this.db
      .prepare("UPDATE messages SET status = ? WHERE id = ?")
      .run(status, id);
  }

  // ---- outbound retry queue ----

  /** Record an outbound message awaiting hand-off to the radio. */
  enqueueOutbound(input: {
    radioId: number;
    messageId: number;
    kind: MessageKind;
    contactKey?: string | null;
    channelIdx?: number | null;
    text: string;
    cli?: boolean;
    maxAttempts: number;
    nextAttemptAt: number;
  }): OutboundEntry {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO outbound_queue
           (message_id, radio_id, kind, contact_key, channel_idx, text, cli, attempts, max_attempts, next_attempt_at, last_error, state, created_at, updated_at)
         VALUES (@messageId, @radioId, @kind, @contactKey, @channelIdx, @text, @cli, 0, @maxAttempts, @nextAttemptAt, NULL, 'pending', @ts, @ts)`,
      )
      .run({
        radioId: input.radioId,
        messageId: input.messageId,
        kind: input.kind,
        contactKey: input.contactKey ?? null,
        channelIdx: input.channelIdx ?? null,
        text: input.text,
        cli: input.cli ? 1 : 0,
        maxAttempts: input.maxAttempts,
        nextAttemptAt: input.nextAttemptAt,
        ts,
      });
    return this.getOutbound(input.messageId)!;
  }

  getOutbound(messageId: number): OutboundEntry | null {
    const row = this.db
      .prepare("SELECT * FROM outbound_queue WHERE message_id = ?")
      .get(messageId) as OutboundRow | undefined;
    return row ? rowToOutbound(row) : null;
  }

  /**
   * Entries for one radio whose backoff has elapsed and are eligible for an
   * attempt (`pending` or `retrying`), oldest-due first. `failed` entries are
   * excluded — they only re-enter the queue via an explicit user retry.
   */
  takeDueOutbound(radioId: number, atTs: number): OutboundEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbound_queue
         WHERE radio_id = ? AND state IN ('pending','retrying') AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, message_id ASC`,
      )
      .all(radioId, atTs) as OutboundRow[];
    return rows.map(rowToOutbound);
  }

  /** The full ledger (pending/retrying/failed) for one radio, newest first, for the queue view. */
  listOutbound(radioId: number): OutboundEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM outbound_queue WHERE radio_id = ? ORDER BY created_at DESC, message_id DESC",
      )
      .all(radioId) as OutboundRow[];
    return rows.map(rowToOutbound);
  }

  /** Persist the outcome of an attempt (new state + backoff + error). */
  markOutboundAttempt(
    messageId: number,
    patch: {
      state: OutboundEntry["state"];
      attempts: number;
      nextAttemptAt: number;
      lastError: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE outbound_queue
         SET state = @state, attempts = @attempts, next_attempt_at = @nextAttemptAt,
             last_error = @lastError, updated_at = @ts
         WHERE message_id = @messageId`,
      )
      .run({ messageId, ...patch, ts: now() });
  }

  /** Re-arm a failed entry for another round of attempts (user-initiated retry). */
  resetOutboundForRetry(messageId: number, nextAttemptAt: number): void {
    this.db
      .prepare(
        `UPDATE outbound_queue
         SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
         WHERE message_id = ?`,
      )
      .run(nextAttemptAt, now(), messageId);
  }

  removeOutbound(messageId: number): void {
    this.db
      .prepare("DELETE FROM outbound_queue WHERE message_id = ?")
      .run(messageId);
  }

  /** Earliest scheduled attempt among one radio's still-eligible entries, or null when none remain. */
  nextOutboundAttemptAt(radioId: number): number | null {
    const row = this.db
      .prepare(
        "SELECT MIN(next_attempt_at) AS n FROM outbound_queue WHERE radio_id = ? AND state IN ('pending','retrying')",
      )
      .get(radioId) as { n: number | null };
    return row.n ?? null;
  }

  getRecentMessages(radioId: number, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `${MESSAGE_SELECT} WHERE m.radio_id = ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(radioId, Math.min(Math.max(limit, 1), 200)) as MessageRow[];
    return rows.map(rowToMessage);
  }

  getConversation(
    radioId: number,
    opts: {
      contactKey?: string;
      contactPrefix?: string;
      channelIdx?: number;
      beforeId?: number;
      limit: number;
    },
  ): Message[] {
    const clauses: string[] = ["m.radio_id = @radioId"];
    const params: Record<string, unknown> = {
      radioId,
      limit: Math.min(Math.max(opts.limit, 1), 200),
    };
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
    } else if (opts.contactPrefix !== undefined) {
      clauses.push(
        "m.kind = 'dm' AND m.contact_key IS NULL AND m.contact_prefix = @contactPrefix",
      );
      params.contactPrefix = opts.contactPrefix;
    } else if (opts.channelIdx !== undefined) {
      clauses.push("m.kind = 'channel' AND m.channel_idx = @channelIdx");
      params.channelIdx = opts.channelIdx;
    }
    if (opts.beforeId !== undefined) {
      clauses.push("m.id < @beforeId");
      params.beforeId = opts.beforeId;
    }
    const rows = this.db
      .prepare(
        `${MESSAGE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY m.id DESC LIMIT @limit`,
      )
      .all(params) as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }

  /**
   * Full-text search over one radio's message text (FTS5), best match first.
   * User input is quoted term-by-term so FTS query syntax can't error; the final
   * term matches as a prefix for type-ahead feel. Snippets mark matches with
   * \x01…\x02 so the UI can highlight without HTML in the payload.
   */
  searchMessages(
    radioId: number,
    opts: {
      query: string;
      contactKey?: string;
      contactPrefix?: string;
      channelIdx?: number;
      limit: number;
    },
  ): MessageSearchResult[] {
    const terms = opts.query.trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const match = terms
      .map(
        (term, i) =>
          `"${term.replace(/"/g, '""')}"${i === terms.length - 1 ? "*" : ""}`,
      )
      .join(" ");
    const clauses: string[] = [
      "messages_fts MATCH @match",
      "m.radio_id = @radioId",
    ];
    const params: Record<string, unknown> = {
      match,
      radioId,
      limit: Math.min(Math.max(opts.limit, 1), 100),
    };
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
    } else if (opts.contactPrefix !== undefined) {
      clauses.push(
        "m.kind = 'dm' AND m.contact_key IS NULL AND m.contact_prefix = @contactPrefix",
      );
      params.contactPrefix = opts.contactPrefix;
    } else if (opts.channelIdx !== undefined) {
      clauses.push("m.kind = 'channel' AND m.channel_idx = @channelIdx");
      params.channelIdx = opts.channelIdx;
    }
    const rows = this.db
      .prepare(
        `SELECT m.*, c.name AS contact_name, ch.name AS channel_name, q.state AS queue_state, ${AUTHOR_NAME_SELECT},
                snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snippet
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         LEFT JOIN contacts c ON c.public_key = m.contact_key AND c.radio_id = m.radio_id
         LEFT JOIN channels ch ON ch.idx = m.channel_idx AND ch.radio_id = m.radio_id
         LEFT JOIN outbound_queue q ON q.message_id = m.id
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank LIMIT @limit`,
      )
      .all(params) as (MessageRow & { snippet: string })[];
    return rows.map((row) => ({ ...rowToMessage(row), snippet: row.snippet }));
  }

  /** Every message of a conversation (or the whole radio), oldest first, for export. */
  getMessagesForExport(
    radioId: number,
    opts: {
      contactKey?: string;
      contactPrefix?: string;
      channelIdx?: number;
    } = {},
  ): Message[] {
    return [...this.iterateMessagesForExport(radioId, opts)];
  }

  /**
   * Stream matching messages oldest-first without materializing the whole
   * history: better-sqlite3's row iterator keeps only one row in memory at a
   * time, so a large persistent database exports with bounded memory. The
   * underlying statement iterator is finalized when the consumer stops early
   * (a broken `for..of` calls the generator's `return`).
   */
  *iterateMessagesForExport(
    radioId: number,
    opts: {
      contactKey?: string;
      contactPrefix?: string;
      channelIdx?: number;
    } = {},
  ): Generator<Message> {
    const clauses: string[] = ["m.radio_id = @radioId"];
    const params: Record<string, unknown> = { radioId };
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
    } else if (opts.contactPrefix !== undefined) {
      clauses.push(
        "m.kind = 'dm' AND m.contact_key IS NULL AND m.contact_prefix = @contactPrefix",
      );
      params.contactPrefix = opts.contactPrefix;
    } else if (opts.channelIdx !== undefined) {
      clauses.push("m.kind = 'channel' AND m.channel_idx = @channelIdx");
      params.channelIdx = opts.channelIdx;
    }
    const stmt = this.db.prepare(
      `${MESSAGE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY m.id ASC`,
    );
    for (const row of stmt.iterate(params) as IterableIterator<MessageRow>) {
      yield rowToMessage(row);
    }
  }

  /**
   * DMs with no sidebar entry to render them: either the sender was never
   * resolved to a full contact key, or it was resolved but that contact is no
   * longer in the radio's current contact list (removed after messages
   * arrived — see #61). A DM addressed to the radio's own self key is excluded
   * rather than surfaced here; it is a loopback/self-echo, not a conversation.
   * Grouped by the highest-fidelity identity available (contact_key when
   * resolved, else contact_prefix) so each unlisted sender appears once, most
   * recent message first.
   */
  getUnknownDirectMessages(radioId: number): Message[] {
    const unlisted = (prefix: string) => `
      ${prefix}kind = 'dm' AND ${prefix}contact_prefix IS NOT NULL
      AND (
        ${prefix}contact_key IS NULL
        OR (
          ${prefix}contact_key NOT IN (SELECT public_key FROM contacts WHERE radio_id = @radioId)
          AND ${prefix}contact_key != COALESCE((SELECT public_key FROM radios WHERE id = @radioId), '')
        )
      )
    `;
    const rows = this.db
      .prepare(
        `${MESSAGE_SELECT}
         WHERE m.radio_id = @radioId AND ${unlisted("m.")}
           AND m.id IN (
             SELECT MAX(id) FROM messages
             WHERE radio_id = @radioId AND ${unlisted("")}
             GROUP BY COALESCE(contact_key, contact_prefix)
           )
         ORDER BY m.id DESC`,
      )
      .all({ radioId }) as MessageRow[];
    return rows.map(rowToMessage);
  }

  markConversationRead(
    radioId: number,
    opts: { contactKey?: string; contactPrefix?: string; channelIdx?: number },
  ): void {
    if (opts.contactKey !== undefined) {
      this.db
        .prepare(
          "UPDATE messages SET read = 1 WHERE radio_id = ? AND kind = 'dm' AND contact_key = ? AND direction = 'in'",
        )
        .run(radioId, opts.contactKey);
    } else if (opts.contactPrefix !== undefined) {
      this.db
        .prepare(
          "UPDATE messages SET read = 1 WHERE radio_id = ? AND kind = 'dm' AND contact_key IS NULL AND contact_prefix = ? AND direction = 'in'",
        )
        .run(radioId, opts.contactPrefix);
    } else if (opts.channelIdx !== undefined) {
      this.db
        .prepare(
          "UPDATE messages SET read = 1 WHERE radio_id = ? AND kind = 'channel' AND channel_idx = ? AND direction = 'in'",
        )
        .run(radioId, opts.channelIdx);
    }
  }

  /**
   * Unread incoming messages grouped per conversation for one radio, using the
   * same addressing as getConversation: resolved DMs by contact key, unresolved
   * DMs by sender prefix, channel messages by channel index. A DM addressed to
   * the radio's own self key is excluded: it is a loopback/self-echo, not an
   * incoming conversation, and would otherwise produce an unclearable badge
   * (see #61 — the sidebar has nowhere to render "a conversation with yourself").
   * A resolved DM whose contact was since removed still counts here; it is
   * surfaced (and can be marked read) via getUnknownDirectMessages.
   */
  getUnreadSummary(radioId: number): ConversationUnread[] {
    const rows = this.db
      .prepare(
        `SELECT kind,
                CASE WHEN kind = 'dm' THEN contact_key END AS contact_key,
                CASE WHEN kind = 'dm' AND contact_key IS NULL THEN contact_prefix END AS contact_prefix,
                CASE WHEN kind = 'channel' THEN channel_idx END AS channel_idx,
                COUNT(*) AS unread
         FROM messages
         WHERE radio_id = @radioId AND direction = 'in' AND read = 0
           AND (
             kind != 'dm'
             OR contact_key IS NULL
             OR contact_key != COALESCE((SELECT public_key FROM radios WHERE id = @radioId), '')
           )
         GROUP BY 1, 2, 3, 4
         ORDER BY unread DESC`,
      )
      .all({ radioId }) as Array<{
      kind: MessageKind;
      contact_key: string | null;
      contact_prefix: string | null;
      channel_idx: number | null;
      unread: number;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      contactKey: row.contact_key,
      contactPrefix: row.contact_prefix,
      channelIdx: row.channel_idx,
      unread: row.unread,
    }));
  }

  counts(radioId: number): {
    contacts: number;
    messages: number;
    unread: number;
  } {
    const one = (sql: string) =>
      (this.db.prepare(sql).get(radioId) as { n: number }).n;
    return {
      contacts: one("SELECT COUNT(*) AS n FROM contacts WHERE radio_id = ?"),
      messages: one("SELECT COUNT(*) AS n FROM messages WHERE radio_id = ?"),
      unread: one(
        "SELECT COUNT(*) AS n FROM messages WHERE radio_id = ? AND direction = 'in' AND read = 0",
      ),
    };
  }

  recordTelemetry(
    radioId: number,
    batteryMv: number | null,
    raw?: unknown,
  ): void {
    this.db
      .prepare(
        "INSERT INTO telemetry (radio_id, ts, battery_mv, raw_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        radioId,
        now(),
        batteryMv,
        raw === undefined ? null : JSON.stringify(raw),
      );
  }

  getTelemetry(radioId: number, sinceTs: number): TelemetryPoint[] {
    const rows = this.db
      .prepare(
        "SELECT ts, battery_mv FROM telemetry WHERE radio_id = ? AND contact_key IS NULL AND ts >= ? ORDER BY ts ASC",
      )
      .all(radioId, sinceTs) as Array<{
      ts: number;
      battery_mv: number | null;
    }>;
    return rows.map((r) => ({ ts: r.ts, batteryMv: r.battery_mv }));
  }

  /** Persist one successful remote telemetry response for a contact. */
  recordContactTelemetry(
    radioId: number,
    contactKey: string,
    readings: SensorReading[],
  ): void {
    this.db
      .prepare(
        "INSERT INTO telemetry (radio_id, ts, battery_mv, raw_json, contact_key) VALUES (?, ?, NULL, ?, ?)",
      )
      .run(radioId, now(), JSON.stringify(readings), contactKey);
  }

  getContactTelemetry(
    radioId: number,
    contactKey: string,
    sinceTs: number,
  ): ContactTelemetryPoint[] {
    const rows = this.db
      .prepare(
        "SELECT ts, raw_json FROM telemetry WHERE radio_id = ? AND contact_key = ? AND ts >= ? ORDER BY ts ASC",
      )
      .all(radioId, contactKey, sinceTs) as Array<{
      ts: number;
      raw_json: string | null;
    }>;
    return rows.map((row) => ({
      ts: row.ts,
      readings: row.raw_json
        ? (JSON.parse(row.raw_json) as SensorReading[])
        : [],
    }));
  }

  /** Delete telemetry rows older than the retention window (all radios). Returns rows removed. */
  trimTelemetry(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = now() - Math.floor(retentionDays * 86_400);
    return this.db.prepare("DELETE FROM telemetry WHERE ts < ?").run(cutoff)
      .changes;
  }

  latestBatteryMv(radioId: number): number | null {
    const row = this.db
      .prepare(
        "SELECT battery_mv FROM telemetry WHERE radio_id = ? AND contact_key IS NULL AND battery_mv IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(radioId) as { battery_mv: number } | undefined;
    return row?.battery_mv ?? null;
  }

  /**
   * Flatten stored telemetry (own-node battery plus every numeric contact
   * sensor reading) into one row per metric sample, for export. Non-numeric
   * readings (e.g. GPS) are skipped — same choice the web sensor sparklines
   * already make.
   */
  exportTelemetry(
    radioId: number,
    sinceTs: number,
    contactKey?: string,
  ): TelemetryExportRow[] {
    const rows = (
      contactKey
        ? this.db
            .prepare(
              `SELECT t.ts, t.battery_mv, t.raw_json, t.contact_key, c.name AS contact_name
               FROM telemetry t
               LEFT JOIN contacts c ON c.radio_id = t.radio_id AND c.public_key = t.contact_key
               WHERE t.radio_id = ? AND t.ts >= ? AND t.contact_key = ?
               ORDER BY t.ts ASC`,
            )
            .all(radioId, sinceTs, contactKey)
        : this.db
            .prepare(
              `SELECT t.ts, t.battery_mv, t.raw_json, t.contact_key, c.name AS contact_name
               FROM telemetry t
               LEFT JOIN contacts c ON c.radio_id = t.radio_id AND c.public_key = t.contact_key
               WHERE t.radio_id = ? AND t.ts >= ?
               ORDER BY t.ts ASC`,
            )
            .all(radioId, sinceTs)
    ) as Array<{
      ts: number;
      battery_mv: number | null;
      raw_json: string | null;
      contact_key: string | null;
      contact_name: string | null;
    }>;
    const out: TelemetryExportRow[] = [];
    for (const row of rows) {
      if (row.contact_key === null) {
        if (row.battery_mv === null) continue;
        out.push({
          ts: row.ts,
          contactKey: null,
          contactName: null,
          metric: "battery_mv",
          label: "Battery",
          value: row.battery_mv,
          unit: "mV",
        });
        continue;
      }
      if (!row.raw_json) continue;
      const readings = JSON.parse(row.raw_json) as SensorReading[];
      for (const reading of readings) {
        if (typeof reading.value !== "number") continue;
        out.push({
          ts: row.ts,
          contactKey: row.contact_key,
          contactName: row.contact_name,
          metric: `${reading.channel}:${reading.type}`,
          label: reading.label,
          value: reading.value,
          unit: reading.unit,
        });
      }
    }
    return out;
  }

  // ---- telemetry monitors (issue #52) ----

  /** Opt a contact into the background telemetry-polling round-robin. */
  addMonitor(radioId: number, contactKey: string): void {
    this.db
      .prepare(
        "INSERT INTO telemetry_monitors (radio_id, contact_key, created_at) VALUES (?, ?, ?) ON CONFLICT(radio_id, contact_key) DO NOTHING",
      )
      .run(radioId, contactKey, now());
  }

  removeMonitor(radioId: number, contactKey: string): void {
    this.db
      .prepare(
        "DELETE FROM telemetry_monitors WHERE radio_id = ? AND contact_key = ?",
      )
      .run(radioId, contactKey);
  }

  listMonitors(radioId: number): TelemetryMonitor[] {
    const rows = this.db
      .prepare(
        "SELECT contact_key, created_at FROM telemetry_monitors WHERE radio_id = ? ORDER BY created_at ASC",
      )
      .all(radioId) as Array<{ contact_key: string; created_at: number }>;
    return rows.map((r) => ({
      contactKey: r.contact_key,
      createdAt: r.created_at,
    }));
  }

  /**
   * The most-overdue monitored contact (never-polled first, then oldest
   * sample first), or null if nothing is monitored. Callers poll at most this
   * one contact per scheduler tick — the capacity bound for contact telemetry.
   */
  nextDueMonitor(radioId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT m.contact_key AS contact_key
         FROM telemetry_monitors m
         LEFT JOIN (
           SELECT contact_key, MAX(ts) AS last_ts FROM telemetry WHERE radio_id = ? AND contact_key IS NOT NULL GROUP BY contact_key
         ) t ON t.contact_key = m.contact_key
         WHERE m.radio_id = ?
         ORDER BY t.last_ts ASC
         LIMIT 1`,
      )
      .get(radioId, radioId) as { contact_key: string } | undefined;
    return row?.contact_key ?? null;
  }

  // ---- telemetry alert rules & events (issue #52) ----

  listAlertRules(radioId: number): TelemetryAlertRule[] {
    const rows = this.db
      .prepare(
        "SELECT id, contact_key, metric, comparator, threshold, last_state FROM telemetry_alert_rules WHERE radio_id = ? ORDER BY id ASC",
      )
      .all(radioId) as AlertRuleRow[];
    return rows.map(rowToAlertRule);
  }

  addAlertRule(
    radioId: number,
    rule: {
      contactKey: string | null;
      metric: string;
      comparator: AlertComparator;
      threshold: number;
    },
  ): TelemetryAlertRule {
    const info = this.db
      .prepare(
        "INSERT INTO telemetry_alert_rules (radio_id, contact_key, metric, comparator, threshold, last_state, created_at) VALUES (?, ?, ?, ?, ?, 'ok', ?)",
      )
      .run(
        radioId,
        rule.contactKey,
        rule.metric,
        rule.comparator,
        rule.threshold,
        now(),
      );
    return {
      id: Number(info.lastInsertRowid),
      contactKey: rule.contactKey,
      metric: rule.metric,
      comparator: rule.comparator,
      threshold: rule.threshold,
      lastState: "ok",
    };
  }

  removeAlertRule(radioId: number, ruleId: number): void {
    this.db
      .prepare(
        "DELETE FROM telemetry_alert_rules WHERE radio_id = ? AND id = ?",
      )
      .run(radioId, ruleId);
  }

  listAlertEvents(radioId: number, sinceTs: number): TelemetryAlertEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.rule_id, e.contact_key, e.metric, e.label, e.value, e.threshold, e.comparator, e.direction, e.ts,
                c.name AS contact_name
         FROM telemetry_alert_events e
         LEFT JOIN contacts c ON c.radio_id = e.radio_id AND c.public_key = e.contact_key
         WHERE e.radio_id = ? AND e.ts >= ?
         ORDER BY e.ts DESC`,
      )
      .all(radioId, sinceTs) as AlertEventRow[];
    return rows.map(rowToAlertEvent);
  }

  /**
   * Compare freshly-recorded samples against configured rules and fire any
   * ok<->breached transitions. Called right after a sample is persisted (the
   * own-node battery poll or a contact telemetry response), so this is the
   * single choke point for alert delivery — every recorded sample passes
   * through it exactly once.
   */
  evaluateAlerts(
    radioId: number,
    contactKey: string | null,
    samples: Array<{ metric: string; label: string; value: number }>,
  ): TelemetryAlertEvent[] {
    if (!samples.length) return [];
    const fired: TelemetryAlertEvent[] = [];
    const contactRow = contactKey
      ? (this.db
          .prepare(
            "SELECT name FROM contacts WHERE radio_id = ? AND public_key = ?",
          )
          .get(radioId, contactKey) as { name: string } | undefined)
      : undefined;
    const contactName = contactRow?.name ?? null;
    for (const sample of samples) {
      const rules = this.db
        .prepare(
          "SELECT id, contact_key, metric, comparator, threshold, last_state FROM telemetry_alert_rules WHERE radio_id = ? AND contact_key IS ? AND metric = ?",
        )
        .all(radioId, contactKey, sample.metric) as AlertRuleRow[];
      for (const rule of rules) {
        const breached =
          rule.comparator === "below"
            ? sample.value < rule.threshold
            : sample.value > rule.threshold;
        const newState: "ok" | "breached" = breached ? "breached" : "ok";
        if (newState === rule.last_state) continue;
        this.db
          .prepare(
            "UPDATE telemetry_alert_rules SET last_state = ? WHERE id = ?",
          )
          .run(newState, rule.id);
        const ts = now();
        const direction: "breach" | "recover" = breached ? "breach" : "recover";
        const info = this.db
          .prepare(
            "INSERT INTO telemetry_alert_events (rule_id, radio_id, contact_key, metric, label, value, threshold, comparator, direction, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            rule.id,
            radioId,
            contactKey,
            sample.metric,
            sample.label,
            sample.value,
            rule.threshold,
            rule.comparator,
            direction,
            ts,
          );
        fired.push({
          id: Number(info.lastInsertRowid),
          ruleId: rule.id,
          contactKey,
          contactName,
          metric: sample.metric,
          label: sample.label,
          value: sample.value,
          threshold: rule.threshold,
          comparator: rule.comparator,
          direction,
          ts,
        });
      }
    }
    return fired;
  }

  // ---- timeline ----

  /**
   * Persist one received advert as a snapshot of the contact at advert time
   * (an advert row keeps the name the node advertised then, not whatever the
   * contact is renamed to later).
   */
  recordAdvert(
    radioId: number,
    contact: Contact,
    observed: "new" | "seen",
  ): TimelineEvent {
    const payload: TimelineAdvertPayload = {
      contactKey: contact.publicKey,
      name: contact.name,
      type: contact.type,
      flags: contact.flags,
      outPathLen: contact.outPathLen,
      lat: contact.lat,
      lon: contact.lon,
      observed,
    };
    const ts = now();
    const info = this.db
      .prepare(
        "INSERT INTO timeline_events (radio_id, kind, ts, contact_key, payload_json) VALUES (?, 'advert', ?, ?, ?)",
      )
      .run(radioId, ts, contact.publicKey, JSON.stringify(payload));
    return {
      id: `adv:${info.lastInsertRowid}`,
      radioId,
      ts,
      kind: "advert",
      advert: payload,
    };
  }

  recordLinkEvent(radioId: number, link: TimelineLinkPayload): TimelineEvent {
    const ts = now();
    const info = this.db
      .prepare(
        "INSERT INTO timeline_events (radio_id, kind, ts, contact_key, payload_json) VALUES (?, 'link', ?, NULL, ?)",
      )
      .run(radioId, ts, JSON.stringify(link));
    return {
      id: `lnk:${info.lastInsertRowid}`,
      radioId,
      ts,
      kind: "link",
      link,
    };
  }

  /**
   * One merged, ascending event feed across the requested radios and kinds.
   * Adverts and link transitions come from timeline_events; message, alert,
   * and telemetry entries are derived from the tables that already store them.
   * Each source is fetched with `limit + 1` so `truncated` is reliable even
   * when a single source overflows the cap on its own.
   */
  getTimeline(
    radioIds: number[],
    fromTs: number,
    toTs: number,
    kinds: TimelineEventKind[],
    limit: number,
  ): { events: TimelineEvent[]; truncated: boolean } {
    const merged: TimelineEvent[] = [];
    const fetch = limit + 1;
    for (const radioId of radioIds) {
      const stored = (["advert", "link"] as const).filter((kind) =>
        kinds.includes(kind),
      );
      if (stored.length > 0) {
        const rows = this.db
          .prepare(
            `SELECT id, kind, ts, payload_json FROM timeline_events
             WHERE radio_id = ? AND kind IN (${stored.map(() => "?").join(", ")}) AND ts >= ? AND ts <= ?
             ORDER BY ts ASC LIMIT ?`,
          )
          .all(radioId, ...stored, fromTs, toTs, fetch) as Array<{
          id: number;
          kind: "advert" | "link";
          ts: number;
          payload_json: string;
        }>;
        for (const row of rows) {
          merged.push(
            row.kind === "advert"
              ? {
                  id: `adv:${row.id}`,
                  radioId,
                  ts: row.ts,
                  kind: "advert",
                  advert: JSON.parse(row.payload_json) as TimelineAdvertPayload,
                }
              : {
                  id: `lnk:${row.id}`,
                  radioId,
                  ts: row.ts,
                  kind: "link",
                  link: JSON.parse(row.payload_json) as TimelineLinkPayload,
                },
          );
        }
      }
      if (kinds.includes("message")) {
        const rows = this.db
          .prepare(
            `SELECT m.id, m.kind, m.direction, m.contact_key, m.contact_prefix, m.channel_idx,
                    m.sender_timestamp, m.created_at, substr(m.text, 1, 140) AS preview,
                    c.name AS contact_name, ch.name AS channel_name
             FROM messages m
             LEFT JOIN contacts c ON c.public_key = m.contact_key AND c.radio_id = m.radio_id
             LEFT JOIN channels ch ON ch.idx = m.channel_idx AND ch.radio_id = m.radio_id
             WHERE m.radio_id = ? AND m.created_at >= ? AND m.created_at <= ?
             ORDER BY m.created_at ASC LIMIT ?`,
          )
          .all(radioId, fromTs, toTs, fetch) as Array<{
          id: number;
          kind: MessageKind;
          direction: MessageDirection;
          contact_key: string | null;
          contact_prefix: string | null;
          channel_idx: number | null;
          sender_timestamp: number;
          created_at: number;
          preview: string;
          contact_name: string | null;
          channel_name: string | null;
        }>;
        for (const row of rows) {
          merged.push({
            id: `msg:${row.id}`,
            radioId,
            ts: row.created_at,
            kind: "message",
            message: {
              messageId: row.id,
              messageKind: row.kind,
              direction: row.direction,
              contactKey: row.contact_key,
              contactPrefix: row.contact_prefix,
              contactName: row.contact_name,
              channelIdx: row.channel_idx,
              channelName: row.channel_name,
              senderTimestamp: row.sender_timestamp,
              preview: row.preview,
            },
          });
        }
      }
      if (kinds.includes("alert")) {
        const rows = this.db
          .prepare(
            `SELECT e.id, e.rule_id, e.contact_key, e.metric, e.label, e.value, e.threshold, e.comparator, e.direction, e.ts,
                    c.name AS contact_name
             FROM telemetry_alert_events e
             LEFT JOIN contacts c ON c.radio_id = e.radio_id AND c.public_key = e.contact_key
             WHERE e.radio_id = ? AND e.ts >= ? AND e.ts <= ?
             ORDER BY e.ts ASC LIMIT ?`,
          )
          .all(radioId, fromTs, toTs, fetch) as AlertEventRow[];
        for (const row of rows) {
          merged.push({
            id: `alr:${row.id}`,
            radioId,
            ts: row.ts,
            kind: "alert",
            alert: rowToAlertEvent(row),
          });
        }
      }
      if (kinds.includes("telemetry")) {
        const rows = this.db
          .prepare(
            `SELECT t.id, t.ts, t.battery_mv, t.raw_json, t.contact_key, c.name AS contact_name
             FROM telemetry t
             LEFT JOIN contacts c ON c.radio_id = t.radio_id AND c.public_key = t.contact_key
             WHERE t.radio_id = ? AND t.ts >= ? AND t.ts <= ?
             ORDER BY t.ts ASC LIMIT ?`,
          )
          .all(radioId, fromTs, toTs, fetch) as Array<{
          id: number;
          ts: number;
          battery_mv: number | null;
          raw_json: string | null;
          contact_key: string | null;
          contact_name: string | null;
        }>;
        for (const row of rows) {
          merged.push({
            id: `tlm:${row.id}`,
            radioId,
            ts: row.ts,
            kind: "telemetry",
            telemetry: {
              contactKey: row.contact_key,
              contactName: row.contact_name,
              batteryMv: row.battery_mv,
              readings:
                row.contact_key && row.raw_json
                  ? (JSON.parse(row.raw_json) as SensorReading[])
                  : [],
            },
          });
        }
      }
    }
    merged.sort(
      (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const truncated = merged.length > limit;
    return { events: truncated ? merged.slice(0, limit) : merged, truncated };
  }

  /**
   * Bucketed event counts across the *whole* stored history of `radioIds`, for
   * the navigator strip under the timeline. Only counts cross the wire, so the
   * client can show every event that exists without fetching them all.
   * `from`/`to` are the real extent of the matching rows.
   */
  getTimelineOverview(
    radioIds: number[],
    kinds: TimelineEventKind[],
    bucketCount: number,
  ): TimelineOverview {
    const empty: TimelineOverview = {
      from: 0,
      to: 0,
      bucketSecs: 0,
      buckets: [],
      total: 0,
    };
    if (radioIds.length === 0 || kinds.length === 0) return empty;
    const idList = radioIds.map(() => "?").join(", ");

    let from = Infinity;
    let to = -Infinity;
    for (const kind of kinds) {
      const source = OVERVIEW_SOURCES[kind];
      const row = this.db
        .prepare(
          `SELECT MIN(${source.tsCol}) AS lo, MAX(${source.tsCol}) AS hi FROM ${source.table}
           WHERE radio_id IN (${idList}) ${source.where}`,
        )
        .get(...radioIds) as { lo: number | null; hi: number | null };
      if (row.lo !== null) from = Math.min(from, row.lo);
      if (row.hi !== null) to = Math.max(to, row.hi);
    }
    if (!Number.isFinite(from)) return empty;

    // A history spanning a single instant still needs a positive width to bucket over.
    const bucketSecs = Math.max(
      1,
      Math.ceil(Math.max(to - from, 1) / Math.max(bucketCount, 1)),
    );
    const byTs = new Map<number, TimelineOverviewBucket>();
    let total = 0;
    for (const kind of kinds) {
      const source = OVERVIEW_SOURCES[kind];
      // CAST, not integer division: bound numbers can arrive as REAL, which
      // would make `/` floating and scatter counts across fractional buckets.
      const rows = this.db
        .prepare(
          `SELECT CAST((${source.tsCol} - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS n FROM ${source.table}
           WHERE radio_id IN (${idList}) ${source.where}
           GROUP BY bucket`,
        )
        .all(from, bucketSecs, ...radioIds) as Array<{
        bucket: number;
        n: number;
      }>;
      for (const row of rows) {
        const ts = from + row.bucket * bucketSecs;
        let bucket = byTs.get(ts);
        if (bucket === undefined) {
          bucket = { ts, counts: {} };
          byTs.set(ts, bucket);
        }
        bucket.counts[kind] = (bucket.counts[kind] ?? 0) + row.n;
        total += row.n;
      }
    }
    return {
      from,
      to,
      bucketSecs,
      buckets: [...byTs.values()].sort((a, b) => a.ts - b.ts),
      total,
    };
  }

  // ---- durable webhook storage (issue #56; no transport or API policy here) ----

  createWebhookSubscription(input: {
    label: string;
    destination: string;
    eventTypes: string[];
    radioIds: number[] | null;
    includeSensitive: boolean;
  }): WebhookSubscription {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO webhook_subscriptions
         (label, destination, event_types_json, radio_ids_json, include_sensitive, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.label,
        input.destination,
        JSON.stringify(input.eventTypes),
        input.radioIds === null ? null : JSON.stringify(input.radioIds),
        input.includeSensitive ? 1 : 0,
        ts,
        ts,
      );
    return this.getWebhookSubscription(Number(info.lastInsertRowid))!;
  }

  getWebhookSubscription(subscriptionId: number): WebhookSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
      .get(subscriptionId) as WebhookSubscriptionRow | undefined;
    return row ? rowToWebhookSubscription(row) : null;
  }

  listWebhookSubscriptions(): WebhookSubscription[] {
    return (
      this.db
        .prepare("SELECT * FROM webhook_subscriptions ORDER BY id ASC")
        .all() as WebhookSubscriptionRow[]
    ).map(rowToWebhookSubscription);
  }

  updateWebhookSubscription(
    subscriptionId: number,
    input: Pick<
      WebhookSubscription,
      | "label"
      | "destination"
      | "eventTypes"
      | "radioIds"
      | "includeSensitive"
      | "state"
    >,
  ): WebhookSubscription | null {
    // Resuming is the operator saying "the receiver is fixed": clear the burst
    // streak and its reason so one more stale failure cannot re-pause instantly.
    const changed = this.db
      .prepare(
        `UPDATE webhook_subscriptions SET label = ?, destination = ?, event_types_json = ?, radio_ids_json = ?,
         include_sensitive = ?, state = ?, updated_at = ?,
         consecutive_failures = CASE WHEN ? = 'active' AND state != 'active' THEN 0 ELSE consecutive_failures END,
         last_failure_summary = CASE WHEN ? = 'active' AND state != 'active' THEN NULL ELSE last_failure_summary END
         WHERE id = ?`,
      )
      .run(
        input.label,
        input.destination,
        JSON.stringify(input.eventTypes),
        input.radioIds === null ? null : JSON.stringify(input.radioIds),
        input.includeSensitive ? 1 : 0,
        input.state,
        now(),
        input.state,
        input.state,
        subscriptionId,
      ).changes;
    return changed > 0 ? this.getWebhookSubscription(subscriptionId) : null;
  }

  deleteWebhookSubscription(subscriptionId: number): boolean {
    return (
      this.db
        .prepare("DELETE FROM webhook_subscriptions WHERE id = ?")
        .run(subscriptionId).changes > 0
    );
  }

  listActiveWebhookSubscriptions(): WebhookSubscription[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM webhook_subscriptions WHERE state = 'active' AND active_key_id IS NOT NULL ORDER BY id",
        )
        .all() as WebhookSubscriptionRow[]
    ).map(rowToWebhookSubscription);
  }

  /**
   * A terminal policy failure is a hard stop: no queued or leased row may be
   * retried after the subscription is disabled. Marking them terminal also
   * keeps retention bounded rather than leaving an undrainable queue behind.
   */
  disableWebhookSubscription(subscriptionId: number, reason: string): number {
    const ts = now();
    const summary = reason.slice(0, 256);
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE webhook_subscriptions SET state = 'disabled', last_failure_summary = ?, updated_at = ? WHERE id = ?",
        )
        .run(summary, ts, subscriptionId);
      return this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET state = 'dropped', completed_at = ?, response_status = NULL,
               response_class = NULL, error_summary = ?, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE subscription_id = ? AND state IN ('queued', 'leased')`,
        )
        .run(ts, summary, ts, subscriptionId).changes;
    })();
  }

  /**
   * Count one terminal delivery failure against the subscription and pause it
   * once the burst threshold is reached. Unlike {@link disableWebhookSubscription}
   * this keeps the queued backlog intact: `claimDueWebhookDeliveries` and
   * `queueWebhookEvent` both ignore non-active subscriptions, so a pause stops
   * scheduled delivery and new enqueueing while leaving the queue to drain on
   * resume. Reserved for recoverable receiver faults (a 4xx burst, or repeated
   * deliveries exhausting their retries); SSRF and signing failures still disable.
   */
  recordWebhookTerminalFailure(
    subscriptionId: number,
    reason: string,
    threshold: number,
  ): { consecutiveFailures: number; paused: boolean } {
    const ts = now();
    const summary = reason.slice(0, 256);
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `UPDATE webhook_subscriptions
           SET consecutive_failures = consecutive_failures + 1, last_failure_summary = ?, updated_at = ?
           WHERE id = ? AND state = 'active'
           RETURNING consecutive_failures`,
        )
        .get(summary, ts, subscriptionId) as
        | { consecutive_failures: number }
        | undefined;
      if (!row) return { consecutiveFailures: 0, paused: false };
      const paused = row.consecutive_failures >= Math.max(1, threshold);
      if (paused) {
        this.db
          .prepare(
            "UPDATE webhook_subscriptions SET state = 'paused', updated_at = ? WHERE id = ?",
          )
          .run(ts, subscriptionId);
      }
      return { consecutiveFailures: row.consecutive_failures, paused };
    })();
  }

  /** A delivered event proves the receiver is healthy, so the burst restarts. */
  clearWebhookFailureStreak(subscriptionId: number): void {
    this.db
      .prepare(
        "UPDATE webhook_subscriptions SET consecutive_failures = 0, updated_at = ? WHERE id = ? AND consecutive_failures > 0",
      )
      .run(now(), subscriptionId);
  }

  createWebhookSigningKey(
    subscriptionId: number,
    keyId: string,
    secret: Buffer,
    crypto: WebhookCrypto,
  ): void {
    const encrypted = crypto.encrypt(secret);
    const ts = now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO webhook_keys
           (subscription_id, key_id, secret_ciphertext, secret_nonce, secret_auth_tag, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          subscriptionId,
          keyId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          ts,
        );
      this.db
        .prepare(
          "UPDATE webhook_subscriptions SET active_key_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(keyId, ts, subscriptionId);
    })();
  }

  rotateWebhookSigningKey(
    subscriptionId: number,
    keyId: string,
    secret: Buffer,
    crypto: WebhookCrypto,
  ): boolean {
    const encrypted = crypto.encrypt(secret);
    const ts = now();
    return this.db.transaction(() => {
      const subscription = this.getWebhookSubscription(subscriptionId);
      if (!subscription) return false;
      if (subscription.activeKeyId !== null) {
        this.db
          .prepare(
            "UPDATE webhook_keys SET retire_at = ? WHERE subscription_id = ? AND key_id = ? AND deleted_at IS NULL",
          )
          .run(ts + 86_400, subscriptionId, subscription.activeKeyId);
      }
      this.db
        .prepare(
          `INSERT INTO webhook_keys
           (subscription_id, key_id, secret_ciphertext, secret_nonce, secret_auth_tag, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          subscriptionId,
          keyId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          ts,
        );
      this.db
        .prepare(
          "UPDATE webhook_subscriptions SET active_key_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(keyId, ts, subscriptionId);
      return true;
    })();
  }

  /**
   * Rotation retains the previous key for 24 hours to finish already-queued
   * deliveries, so `retire_at` is enforced here rather than only recorded: past
   * that window the old secret stops signing, which is what the UI promises.
   * Deliveries cannot outlive the window either — {@link expireStaleWebhookDeliveries}
   * terminates queued rows at 24 hours, so a retired key never strands one.
   */
  getWebhookSigningKey(
    subscriptionId: number,
    keyId: string,
    crypto: WebhookCrypto,
    atTs: number = now(),
  ): Buffer | null {
    const row = this.db
      .prepare(
        `SELECT secret_ciphertext, secret_nonce, secret_auth_tag FROM webhook_keys
         WHERE subscription_id = ? AND key_id = ? AND deleted_at IS NULL
           AND (retire_at IS NULL OR retire_at > ?)`,
      )
      .get(subscriptionId, keyId, atTs) as
      | {
          secret_ciphertext: Buffer;
          secret_nonce: Buffer;
          secret_auth_tag: Buffer;
        }
      | undefined;
    return row
      ? crypto.decrypt({
          ciphertext: row.secret_ciphertext,
          nonce: row.secret_nonce,
          authTag: row.secret_auth_tag,
        })
      : null;
  }

  recordWebhookEvent(input: {
    eventId: string;
    type: string;
    eventVersion: number;
    sourceRadioId: number | null;
    occurredAt: number;
    body: Buffer;
  }): void {
    this.db
      .prepare(
        "INSERT INTO webhook_events (event_id, type, event_version, source_radio_id, occurred_at, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.eventId,
        input.type,
        input.eventVersion,
        input.sourceRadioId,
        input.occurredAt,
        input.body,
        now(),
      );
  }

  enqueueWebhookDelivery(input: {
    subscriptionId: number;
    eventId: string;
    keyId: string;
    nextAttemptAt: number;
  }): WebhookDelivery {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO webhook_deliveries
         (subscription_id, event_id, key_id, state, attempt_count, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        input.subscriptionId,
        input.eventId,
        input.keyId,
        input.nextAttemptAt,
        ts,
        ts,
      );
    return this.getWebhookDelivery(Number(info.lastInsertRowid))!;
  }

  /** Atomically persist a filtered snapshot and bounded delivery state. */
  queueWebhookEvent(input: {
    subscriptionId: number;
    keyId: string;
    eventId: string;
    type: string;
    eventVersion: number;
    sourceRadioId: number | null;
    occurredAt: number;
    body: Buffer;
    now: number;
  }):
    | "queued"
    | "subscription_not_active"
    | "subscription_rate_limit"
    | "global_queue_limit" {
    return this.db.transaction(() => {
      const subscription = this.db
        .prepare(
          "SELECT active_key_id FROM webhook_subscriptions WHERE id = ? AND state = 'active'",
        )
        .get(input.subscriptionId) as { active_key_id: string | null } | undefined;
      // The caller may have read this subscription just before a pause, disable,
      // or key rotation. Re-check inside this transaction so no stale projection
      // creates a new immutable snapshot after that state transition.
      if (!subscription || subscription.active_key_id !== input.keyId)
        return "subscription_not_active";
      const globalQueued = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE state IN ('queued', 'leased')",
          )
          .get() as { count: number }
      ).count;
      const recentForSubscription = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE subscription_id = ? AND created_at >= ?",
          )
          .get(input.subscriptionId, input.now - 60) as { count: number }
      ).count;
      const dropped =
        globalQueued >= 10_000
          ? "global_queue_limit"
          : recentForSubscription >= 100
            ? "subscription_rate_limit"
            : null;
      this.db
        .prepare(
          "INSERT INTO webhook_events (event_id, type, event_version, source_radio_id, occurred_at, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.eventId,
          input.type,
          input.eventVersion,
          input.sourceRadioId,
          input.occurredAt,
          input.body,
          input.now,
        );
      if (dropped) {
        this.db
          .prepare(
            "INSERT INTO webhook_deliveries (subscription_id, event_id, key_id, state, attempt_count, next_attempt_at, error_summary, completed_at, created_at, updated_at) VALUES (?, ?, ?, 'dropped', 0, ?, ?, ?, ?, ?)",
          )
          .run(
            input.subscriptionId,
            input.eventId,
            input.keyId,
            input.now,
            dropped,
            input.now,
            input.now,
            input.now,
          );
        return dropped;
      }
      this.db
        .prepare(
          "INSERT INTO webhook_deliveries (subscription_id, event_id, key_id, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)",
        )
        .run(
          input.subscriptionId,
          input.eventId,
          input.keyId,
          input.now,
          input.now,
          input.now,
        );
      return "queued";
    })();
  }

  getWebhookDelivery(deliveryId: number): WebhookDelivery | null {
    const row = this.db
      .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(deliveryId) as WebhookDeliveryRow | undefined;
    return row ? rowToWebhookDelivery(row) : null;
  }

  listWebhookDeliveries(input: {
    subscriptionId: number;
    state?: WebhookDelivery["state"];
    beforeId?: number;
    limit: number;
  }): WebhookDeliverySummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, subscription_id, event_id, key_id, state, attempt_count, next_attempt_at, lease_owner, lease_expires_at,
                response_status, response_class, error_summary, completed_at, created_at, updated_at
         FROM webhook_deliveries
         WHERE subscription_id = @subscriptionId AND (@state IS NULL OR state = @state)
           AND (@beforeId IS NULL OR id < @beforeId)
         ORDER BY id DESC LIMIT @limit`,
      )
      .all({
        ...input,
        state: input.state ?? null,
        beforeId: input.beforeId ?? null,
      }) as Array<
      WebhookDeliveryRow & {
        response_status: number | null;
        response_class: string | null;
        error_summary: string | null;
        completed_at: number | null;
        created_at: number;
        updated_at: number;
      }
    >;
    return rows.map((row) => ({
      ...rowToWebhookDelivery(row),
      responseStatus: row.response_status,
      responseClass: row.response_class,
      errorSummary: row.error_summary,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getWebhookDeliveryJob(deliveryId: number): WebhookDeliveryJob | null {
    const row = this.db
      .prepare(
        `SELECT d.*, s.destination, s.state AS subscription_state, e.type, e.event_version, e.body
         FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.id = d.subscription_id
         JOIN webhook_events e ON e.event_id = d.event_id
         WHERE d.id = ?`,
      )
      .get(deliveryId) as
      | (WebhookDeliveryRow & {
          destination: string;
          subscription_state: WebhookSubscription["state"];
          type: string;
          event_version: number;
          body: Buffer;
          first_attempt_at: number | null;
        })
      | undefined;
    if (!row) return null;
    return {
      ...rowToWebhookDelivery(row),
      destination: row.destination,
      subscriptionState: row.subscription_state,
      type: row.type,
      eventVersion: row.event_version,
      body: row.body,
      firstAttemptAt: row.first_attempt_at,
    };
  }

  /** A single short write transaction prevents two workers from owning one row. */
  claimDueWebhookDeliveries(
    owner: string,
    atTs: number,
    leaseSeconds: number,
    limit: number,
  ): WebhookDelivery[] {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE webhook_deliveries SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'leased' AND lease_expires_at <= ?",
        )
        .run(atTs, atTs);
      const activeLeases = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE state = 'leased' AND lease_expires_at > ?",
          )
          .get(atTs) as { count: number }
      ).count;
      const capacity = Math.max(0, limit - activeLeases);
      if (capacity === 0) return [];
      const rows = this.db
        .prepare(
          `WITH due AS (
             SELECT webhook_deliveries.id AS delivery_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY webhook_deliveries.subscription_id
                      ORDER BY webhook_deliveries.next_attempt_at ASC, webhook_deliveries.id ASC
                    ) AS rank
             FROM webhook_deliveries
             JOIN webhook_subscriptions ON webhook_subscriptions.id = webhook_deliveries.subscription_id
             WHERE webhook_deliveries.state = 'queued' AND webhook_deliveries.next_attempt_at <= ?
               AND webhook_subscriptions.state = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM webhook_deliveries AS leased
                 WHERE leased.subscription_id = webhook_deliveries.subscription_id
                   AND leased.state = 'leased' AND leased.lease_expires_at > ?
               )
           )
           UPDATE webhook_deliveries
           SET state = 'leased', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
               first_attempt_at = COALESCE(first_attempt_at, ?), updated_at = ?
           WHERE webhook_deliveries.id IN (
             SELECT delivery_id FROM due WHERE rank = 1 LIMIT ?
           )
           RETURNING *`,
        )
        .all(
          atTs,
          atTs,
          owner,
          atTs + leaseSeconds,
          atTs,
          atTs,
          capacity,
        ) as WebhookDeliveryRow[];
      return rows.map(rowToWebhookDelivery);
    })();
  }

  finishWebhookDelivery(
    deliveryId: number,
    outcome: {
      state: "delivered" | "failed" | "dropped";
      completedAt: number;
      responseStatus: number | null;
      responseClass: string | null;
      errorSummary?: string | null;
      leaseOwner?: string | null;
    },
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE webhook_deliveries
         SET state = @state, completed_at = @completedAt, response_status = @responseStatus, response_class = @responseClass,
             error_summary = @errorSummary, lease_owner = NULL, lease_expires_at = NULL, updated_at = @completedAt
         WHERE id = @deliveryId AND (@leaseOwner IS NULL OR (state = 'leased' AND lease_owner = @leaseOwner))`,
        )
        .run({
          ...outcome,
          errorSummary: outcome.errorSummary ?? null,
          leaseOwner: outcome.leaseOwner ?? null,
          deliveryId,
        }).changes > 0
    );
  }

  retryWebhookDelivery(
    deliveryId: number,
    nextAttemptAt: number,
    responseStatus: number | null,
    responseClass: string | null,
    errorSummary: string,
    leaseOwner: string | null = null,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE webhook_deliveries
         SET state = 'queued', next_attempt_at = ?, response_status = ?, response_class = ?, error_summary = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND (? IS NULL OR lease_owner = ?)`,
        )
        .run(
          nextAttemptAt,
          responseStatus,
          responseClass,
          errorSummary.slice(0, 256),
          now(),
          deliveryId,
          leaseOwner,
          leaseOwner,
        ).changes > 0
    );
  }

  /**
   * Terminate queued deliveries older than the documented 24-hour delivery
   * window. A paused subscription keeps its backlog (see
   * {@link recordWebhookTerminalFailure}), so without this sweep an unattended
   * pause would hold rows in the queue forever and consume the global queue
   * budget. Bounded like the retention prune to keep the write transaction short.
   */
  expireStaleWebhookDeliveries(cutoffTs: number, limit: number): number {
    const ts = now();
    return this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET state = 'failed', completed_at = ?, error_summary = 'expired',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id IN (
           SELECT id FROM webhook_deliveries
           WHERE state = 'queued' AND created_at < ?
           ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(ts, ts, cutoffTs, Math.max(1, limit)).changes;
  }

  /**
   * Hard-delete signing keys retired before `cutoffTs` so repeated rotation
   * cannot grow `webhook_keys` without bound. Keys still referenced by a
   * delivery row are kept: the foreign key would reject the delete, and the
   * retained history should stay readable until retention prunes it.
   */
  pruneRetiredWebhookKeys(cutoffTs: number, limit: number): number {
    return this.db
      .prepare(
        `DELETE FROM webhook_keys WHERE id IN (
           SELECT id FROM webhook_keys
           WHERE retire_at IS NOT NULL AND retire_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM webhook_deliveries
               WHERE webhook_deliveries.subscription_id = webhook_keys.subscription_id
                 AND webhook_deliveries.key_id = webhook_keys.key_id
             )
           ORDER BY retire_at ASC LIMIT ?
         )`,
      )
      .run(cutoffTs, Math.max(1, limit)).changes;
  }

  /** Newest test delivery for a subscription, for the one-per-minute test limit. */
  lastWebhookTestAt(subscriptionId: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(d.created_at) AS ts FROM webhook_deliveries d
         JOIN webhook_events e ON e.event_id = d.event_id
         WHERE d.subscription_id = ? AND e.type = ?`,
      )
      .get(subscriptionId, WEBHOOK_TEST_EVENT_TYPE) as { ts: number | null };
    return row.ts;
  }

  /** Retention is bounded so startup/daily pruning cannot monopolize SQLite's writer lock. */
  pruneWebhookRetention(
    cutoffTs: number,
    limit: number,
  ): { deliveries: number; events: number } {
    return this.db.transaction(() => {
      const deliveries = this.db
        .prepare(
          `DELETE FROM webhook_deliveries WHERE id IN (
             SELECT id FROM webhook_deliveries
             WHERE state IN ('delivered', 'failed', 'dropped') AND completed_at < ?
             ORDER BY completed_at ASC LIMIT ?
           )`,
        )
        .run(cutoffTs, Math.max(1, limit)).changes;
      const events = this.db
        .prepare(
          `DELETE FROM webhook_events WHERE event_id IN (
             SELECT event_id FROM webhook_events
             WHERE NOT EXISTS (SELECT 1 FROM webhook_deliveries WHERE event_id = webhook_events.event_id)
             ORDER BY created_at ASC LIMIT ?
           )`,
        )
        .run(Math.max(1, limit)).changes;
      return { deliveries, events };
    })();
  }

  /** Delete timeline rows older than the retention window (all radios). Returns rows removed. */
  trimTimeline(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = now() - Math.floor(retentionDays * 86_400);
    return this.db
      .prepare("DELETE FROM timeline_events WHERE ts < ?")
      .run(cutoff).changes;
  }

  // ---- Web Push subscription storage (issue #76 prototype; best-effort, no durable delivery queue) ----

  /** Re-subscribing (e.g. a rotated browser endpoint) replaces the prior row for that endpoint and clears its failure streak. */
  upsertPushSubscription(input: {
    sessionTokenHash: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): PushSubscription {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (session_token_hash, endpoint, p256dh, auth, created_at, consecutive_failures)
         VALUES (@sessionTokenHash, @endpoint, @p256dh, @auth, @now, 0)
         ON CONFLICT(endpoint) DO UPDATE SET
           session_token_hash = excluded.session_token_hash,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           consecutive_failures = 0`,
      )
      .run({ ...input, now: now() });
    return this.getPushSubscription(input.endpoint)!;
  }

  getPushSubscription(endpoint: string): PushSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .get(endpoint) as PushSubscriptionRow | undefined;
    return row ? rowToPushSubscription(row) : null;
  }

  listPushSubscriptions(): PushSubscription[] {
    return (
      this.db.prepare("SELECT * FROM push_subscriptions ORDER BY id ASC").all() as PushSubscriptionRow[]
    ).map(rowToPushSubscription);
  }

  /** Explicit unsubscribe: only the session that created the subscription may remove it. */
  deletePushSubscriptionForSession(endpoint: string, sessionTokenHash: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND session_token_hash = ?")
        .run(endpoint, sessionTokenHash).changes > 0
    );
  }

  /** Logout hygiene (api/auth.ts): a subscription must not survive its session. */
  deletePushSubscriptionsForSession(sessionTokenHash: string): number {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE session_token_hash = ?").run(sessionTokenHash)
      .changes;
  }

  /** Worker-side dead-endpoint cleanup (no session context available there). */
  deletePushSubscription(endpoint: string): boolean {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes > 0;
  }

  clearPushFailureStreak(endpoint: string): void {
    this.db.prepare("UPDATE push_subscriptions SET consecutive_failures = 0 WHERE endpoint = ?").run(endpoint);
  }

  /**
   * Count one delivery failure and remove the endpoint once `threshold`
   * consecutive failures accumulate. Unlike a webhook, a dead push endpoint
   * has no operator to resume it, so removal (not a pause) is the terminal state.
   */
  recordPushFailure(endpoint: string, threshold: number): { consecutiveFailures: number; removed: boolean } {
    const row = this.db
      .prepare(
        "UPDATE push_subscriptions SET consecutive_failures = consecutive_failures + 1 WHERE endpoint = ? RETURNING consecutive_failures",
      )
      .get(endpoint) as { consecutive_failures: number } | undefined;
    if (!row) return { consecutiveFailures: 0, removed: false };
    if (row.consecutive_failures >= threshold) {
      this.deletePushSubscription(endpoint);
      return { consecutiveFailures: row.consecutive_failures, removed: true };
    }
    return { consecutiveFailures: row.consecutive_failures, removed: false };
  }
}

/** One flattened telemetry sample, ready for CSV/JSON export. */
export interface TelemetryExportRow {
  ts: number;
  contactKey: string | null;
  contactName: string | null;
  metric: string;
  label: string;
  value: number;
  unit: string | null;
}

interface AlertRuleRow {
  id: number;
  contact_key: string | null;
  metric: string;
  comparator: AlertComparator;
  threshold: number;
  last_state: "ok" | "breached";
}

function rowToAlertRule(row: AlertRuleRow): TelemetryAlertRule {
  return {
    id: row.id,
    contactKey: row.contact_key,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold,
    lastState: row.last_state,
  };
}

interface AlertEventRow {
  id: number;
  rule_id: number;
  contact_key: string | null;
  metric: string;
  label: string;
  value: number;
  threshold: number;
  comparator: AlertComparator;
  direction: "breach" | "recover";
  ts: number;
  contact_name: string | null;
}

function rowToAlertEvent(row: AlertEventRow): TelemetryAlertEvent {
  return {
    id: row.id,
    ruleId: row.rule_id,
    contactKey: row.contact_key,
    contactName: row.contact_name,
    metric: row.metric,
    label: row.label,
    value: row.value,
    threshold: row.threshold,
    comparator: row.comparator,
    direction: row.direction,
    ts: row.ts,
  };
}
