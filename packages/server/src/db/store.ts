import { createHash, randomUUID } from "node:crypto";
import type {
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
  TelemetryPoint,
} from "@meshkeep/shared";
import type { Db } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

/** Store-internal outbound entry: the shared shape plus the radio and `cli` flag the worker needs. */
export interface OutboundEntry extends OutboundQueueEntry {
  radioId: number;
  cli: boolean;
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
  Partial<Pick<RadioProfile, "serialPort" | "serialBaud" | "tcpHost" | "tcpPort" | "bleAddress">>;

/** A profile name is a user-facing unique handle; surfaced as a conflict, not an internal error. */
export class DuplicateProfileNameError extends Error {}

function translateProfileNameConflict(error: unknown, name: string): unknown {
  if (error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return new DuplicateProfileNameError(`a radio profile named "${name}" already exists`);
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
      .prepare("SELECT id FROM radios WHERE public_key IS NULL ORDER BY id LIMIT 1")
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
      .prepare("SELECT id FROM radios WHERE public_key IS NULL ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    if (existing) return existing.id;
    const ts = now();
    return Number(
      this.db
        .prepare("INSERT INTO radios (public_key, name, first_seen, last_seen, updated_at) VALUES (NULL, NULL, ?, ?, ?)")
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
    const row = this.db.prepare("SELECT * FROM radios WHERE id = ?").get(id) as RadioRow | undefined;
    if (!row) return null;
    return { id: row.id, publicKey: row.public_key, name: row.name, lastSeen: row.last_seen, isActive: false };
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
      const exists = this.db.prepare("SELECT 1 FROM radios WHERE id = ?").get(id);
      if (!exists) return false;
      // Delete messages before the radios row so the FTS delete triggers fire and
      // the outbound_queue FK cascades; then the remaining per-radio tables.
      this.db.prepare("DELETE FROM messages WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM outbound_queue WHERE radio_id = ?").run(id);
      this.db.prepare("DELETE FROM telemetry WHERE radio_id = ?").run(id);
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
    const row = this.db.prepare("SELECT raw_json FROM self WHERE radio_id = ?").get(radioId) as
      | { raw_json: string }
      | undefined;
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
      .prepare("UPDATE contacts SET last_seen = ?, updated_at = ? WHERE radio_id = ? AND public_key = ?")
      .run(now(), now(), radioId, publicKey);
    if (result.changes === 0) return null;
    return this.getContacts(radioId).find((contact) => contact.publicKey === publicKey) ?? null;
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
        if (!contacts.some((contact) => contact.publicKey === known.publicKey)) {
          this.removeContact(radioId, known.publicKey);
          removed.push(known.publicKey);
        }
      }
    })();
    return { removed };
  }

  getContacts(radioId: number): Contact[] {
    const rows = this.db
      .prepare("SELECT * FROM contacts WHERE radio_id = ? ORDER BY last_advert DESC")
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

  findUniqueContactByPrefix(radioId: number, pubKeyPrefixHex: string): Contact | null {
    const matches = this.getContacts(radioId).filter((c) => c.publicKey.startsWith(pubKeyPrefixHex));
    return matches.length === 1 ? matches[0]! : null;
  }

  private reconcileContactMessages(radioId: number, publicKey: string): string[] {
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
    this.db.prepare("DELETE FROM contacts WHERE radio_id = ? AND public_key = ?").run(radioId, publicKey);
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
    this.db.prepare("DELETE FROM channels WHERE radio_id = ? AND idx = ?").run(radioId, idx);
  }

  getChannels(radioId: number): Channel[] {
    const rows = this.db
      .prepare("SELECT idx, name, secret_hex FROM channels WHERE radio_id = ? ORDER BY idx")
      .all(radioId) as Array<{
      idx: number;
      name: string;
      secret_hex: string;
    }>;
    return rows.map((r) => ({ idx: r.idx, name: r.name, secret: r.secret_hex }));
  }

  listRadioProfiles(): RadioProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM radio_profiles ORDER BY name")
      .all() as RadioProfileRow[];
    return rows.map(rowToRadioProfile);
  }

  getRadioProfile(id: number): RadioProfile | null {
    const row = this.db.prepare("SELECT * FROM radio_profiles WHERE id = ?").get(id) as
      | RadioProfileRow
      | undefined;
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
  updateRadioProfile(id: number, patch: Partial<RadioProfileInput>): RadioProfile | null {
    const existing = this.getRadioProfile(id);
    if (!existing) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
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
    return this.db.prepare("DELETE FROM radio_profiles WHERE id = ?").run(id).changes > 0;
  }

  // ---- radio links (issue #53, Stage 3): which connections the server currently maintains ----

  listLinks(): RadioLinkRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM radio_links ORDER BY profile_id IS NOT NULL, profile_id")
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
    this.db.prepare("DELETE FROM radio_links WHERE profile_id = ?").run(profileId);
  }

  /**
   * Enable or disable the implicit env/override "default" link (profile_id IS
   * NULL). The only code path allowed to write that row — SQLite's UNIQUE
   * treats every NULL as distinct, so "at most one default link" is enforced
   * here in application code rather than by the schema. Idempotent: enabling
   * an already-enabled default link leaves its standby/last_radio_id intact.
   */
  setDefaultLinkEnabled(enabled: boolean): void {
    const exists = this.db.prepare("SELECT 1 FROM radio_links WHERE profile_id IS NULL").get();
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
      .prepare("UPDATE radio_links SET standby = ?, updated_at = ? WHERE profile_id IS ?")
      .run(standby ? 1 : 0, now(), profileId);
  }

  setLinkLastRadio(profileId: number | null, radioId: number): void {
    this.db
      .prepare("UPDATE radio_links SET last_radio_id = ?, updated_at = ? WHERE profile_id IS ?")
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
      .update(JSON.stringify([radioId, kind, conversationKey, senderTimestamp, authorPrefix, text]))
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
      if (input.channelIdx != null) throw new Error("dm messages cannot carry a channel index");
      if (!input.contactKey && !input.contactPrefix) {
        throw new Error("dm messages need a contact key or sender prefix");
      }
    } else {
      if (input.channelIdx == null) throw new Error("channel messages need a channel index");
      if (input.contactKey || input.contactPrefix) {
        throw new Error("channel messages cannot carry a contact identity");
      }
    }
    const contactKey =
      input.kind === "dm" && !input.contactKey && input.contactPrefix
        ? this.findUniqueContactByPrefix(radioId, input.contactPrefix)?.publicKey ?? null
        : input.contactKey ?? null;
    const ingestionId =
      input.ingestionId ??
      (input.direction === "in"
        ? this.inboundFrameId(
            radioId,
            input.kind,
            input.kind === "dm" ? (input.contactPrefix ?? contactKey ?? "") : input.channelIdx!,
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
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  /** Late delivery-state update for a retried browser ingestion (ingestion id is globally unique). */
  updateMessageStatusByIngestionId(input: {
    ingestionId: string;
    status: MessageStatus;
  }): Message | null {
    const row = this.db
      .prepare("SELECT id FROM messages WHERE ingestion_id = ? AND status IN ('pending','sent')")
      .get(input.ingestionId) as { id: number } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE messages SET status = ? WHERE id = ?").run(input.status, row.id);
    return this.getMessage(row.id);
  }

  setMessageStatus(id: number, status: MessageStatus): void {
    this.db.prepare("UPDATE messages SET status = ? WHERE id = ?").run(status, id);
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
      .prepare("SELECT * FROM outbound_queue WHERE radio_id = ? ORDER BY created_at DESC, message_id DESC")
      .all(radioId) as OutboundRow[];
    return rows.map(rowToOutbound);
  }

  /** Persist the outcome of an attempt (new state + backoff + error). */
  markOutboundAttempt(
    messageId: number,
    patch: { state: OutboundEntry["state"]; attempts: number; nextAttemptAt: number; lastError: string | null },
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
    this.db.prepare("DELETE FROM outbound_queue WHERE message_id = ?").run(messageId);
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
      .prepare(`${MESSAGE_SELECT} WHERE m.radio_id = ? ORDER BY m.id DESC LIMIT ?`)
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
    const params: Record<string, unknown> = { radioId, limit: Math.min(Math.max(opts.limit, 1), 200) };
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
    } else if (opts.contactPrefix !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key IS NULL AND m.contact_prefix = @contactPrefix");
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
      .prepare(`${MESSAGE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY m.id DESC LIMIT @limit`)
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
    const match = terms.map((term, i) => `"${term.replace(/"/g, '""')}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
    const clauses: string[] = ["messages_fts MATCH @match", "m.radio_id = @radioId"];
    const params: Record<string, unknown> = { match, radioId, limit: Math.min(Math.max(opts.limit, 1), 100) };
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
    } else if (opts.contactPrefix !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key IS NULL AND m.contact_prefix = @contactPrefix");
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
    opts: { contactKey?: string; contactPrefix?: string; channelIdx?: number } = {},
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
    opts: { contactKey?: string; contactPrefix?: string; channelIdx?: number } = {},
  ): Generator<Message> {
    const clauses: string[] = ["m.radio_id = @radioId"];
    const params: Record<string, unknown> = { radioId };
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
    } else if (opts.contactPrefix !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key IS NULL AND m.contact_prefix = @contactPrefix");
      params.contactPrefix = opts.contactPrefix;
    } else if (opts.channelIdx !== undefined) {
      clauses.push("m.kind = 'channel' AND m.channel_idx = @channelIdx");
      params.channelIdx = opts.channelIdx;
    }
    const stmt = this.db.prepare(`${MESSAGE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY m.id ASC`);
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

  counts(radioId: number): { contacts: number; messages: number; unread: number } {
    const one = (sql: string) => (this.db.prepare(sql).get(radioId) as { n: number }).n;
    return {
      contacts: one("SELECT COUNT(*) AS n FROM contacts WHERE radio_id = ?"),
      messages: one("SELECT COUNT(*) AS n FROM messages WHERE radio_id = ?"),
      unread: one("SELECT COUNT(*) AS n FROM messages WHERE radio_id = ? AND direction = 'in' AND read = 0"),
    };
  }

  recordTelemetry(radioId: number, batteryMv: number | null, raw?: unknown): void {
    this.db
      .prepare("INSERT INTO telemetry (radio_id, ts, battery_mv, raw_json) VALUES (?, ?, ?, ?)")
      .run(radioId, now(), batteryMv, raw === undefined ? null : JSON.stringify(raw));
  }

  getTelemetry(radioId: number, sinceTs: number): TelemetryPoint[] {
    const rows = this.db
      .prepare(
        "SELECT ts, battery_mv FROM telemetry WHERE radio_id = ? AND contact_key IS NULL AND ts >= ? ORDER BY ts ASC",
      )
      .all(radioId, sinceTs) as Array<{ ts: number; battery_mv: number | null }>;
    return rows.map((r) => ({ ts: r.ts, batteryMv: r.battery_mv }));
  }

  /** Persist one successful remote telemetry response for a contact. */
  recordContactTelemetry(radioId: number, contactKey: string, readings: SensorReading[]): void {
    this.db
      .prepare("INSERT INTO telemetry (radio_id, ts, battery_mv, raw_json, contact_key) VALUES (?, ?, NULL, ?, ?)")
      .run(radioId, now(), JSON.stringify(readings), contactKey);
  }

  getContactTelemetry(radioId: number, contactKey: string, sinceTs: number): ContactTelemetryPoint[] {
    const rows = this.db
      .prepare(
        "SELECT ts, raw_json FROM telemetry WHERE radio_id = ? AND contact_key = ? AND ts >= ? ORDER BY ts ASC",
      )
      .all(radioId, contactKey, sinceTs) as Array<{ ts: number; raw_json: string | null }>;
    return rows.map((row) => ({ ts: row.ts, readings: row.raw_json ? (JSON.parse(row.raw_json) as SensorReading[]) : [] }));
  }

  /** Delete telemetry rows older than the retention window (all radios). Returns rows removed. */
  trimTelemetry(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = now() - Math.floor(retentionDays * 86_400);
    return this.db.prepare("DELETE FROM telemetry WHERE ts < ?").run(cutoff).changes;
  }

  latestBatteryMv(radioId: number): number | null {
    const row = this.db
      .prepare(
        "SELECT battery_mv FROM telemetry WHERE radio_id = ? AND contact_key IS NULL AND battery_mv IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(radioId) as { battery_mv: number } | undefined;
    return row?.battery_mv ?? null;
  }
}
