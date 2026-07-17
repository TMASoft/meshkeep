import { randomUUID } from "node:crypto";
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
  SelfInfo,
  SensorReading,
  TelemetryPoint,
} from "@meshkeep/shared";
import type { Db } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

/** Store-internal outbound entry: the shared shape plus the `cli` flag the worker needs. */
export interface OutboundEntry extends OutboundQueueEntry {
  cli: boolean;
}

interface OutboundRow {
  message_id: number;
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

// Author attribution resolves only when the prefix matches exactly one
// contact. A scalar subquery (never a JOIN) guarantees one row per message
// even when multiple contacts share the prefix, and yields NULL on ambiguity.
const AUTHOR_NAME_SELECT = `(
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(a.name) END
    FROM contacts a
    WHERE m.author_prefix IS NOT NULL AND a.public_key LIKE m.author_prefix || '%'
  ) AS author_name`;

const MESSAGE_SELECT = `
  SELECT m.*, c.name AS contact_name, ch.name AS channel_name, q.state AS queue_state, ${AUTHOR_NAME_SELECT}
  FROM messages m
  LEFT JOIN contacts c ON c.public_key = m.contact_key
  LEFT JOIN channels ch ON ch.idx = m.channel_idx
  LEFT JOIN outbound_queue q ON q.message_id = m.id
`;

export class Store {
  constructor(private readonly db: Db) {}

  saveSelf(self: SelfInfo): void {
    this.db
      .prepare(
        `INSERT INTO self (id, public_key, name, raw_json, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key, name = excluded.name,
           raw_json = excluded.raw_json, updated_at = excluded.updated_at`,
      )
      .run(self.publicKey, self.name, JSON.stringify(self), now());
  }

  getSelf(): SelfInfo | null {
    const row = this.db.prepare("SELECT raw_json FROM self WHERE id = 1").get() as
      | { raw_json: string }
      | undefined;
    return row ? (JSON.parse(row.raw_json) as SelfInfo) : null;
  }

  upsertContact(contact: Contact): string[] {
    this.db
      .prepare(
        `INSERT INTO contacts (public_key, name, type, flags, out_path_len, lat, lon, last_advert, last_seen, updated_at)
         VALUES (@publicKey, @name, @type, @flags, @outPathLen, @lat, @lon, @lastAdvert, @lastSeen, @updatedAt)
         ON CONFLICT(public_key) DO UPDATE SET
           name = excluded.name, type = excluded.type, flags = excluded.flags,
           out_path_len = excluded.out_path_len, lat = excluded.lat, lon = excluded.lon,
           last_advert = excluded.last_advert,
           last_seen = COALESCE(excluded.last_seen, contacts.last_seen),
           updated_at = excluded.updated_at`,
      )
      .run({ ...contact, updatedAt: now() });
    return this.reconcileContactMessages(contact.publicKey);
  }

  /**
   * Update last-seen for a stored contact. Returns the updated contact, or
   * null when the contact is not stored yet — callers must sync the contact
   * list first rather than letting the touch land on a missing row and vanish.
   */
  touchContactSeen(publicKey: string): Contact | null {
    const result = this.db
      .prepare("UPDATE contacts SET last_seen = ?, updated_at = ? WHERE public_key = ?")
      .run(now(), now(), publicKey);
    if (result.changes === 0) return null;
    return this.getContacts().find((contact) => contact.publicKey === publicKey) ?? null;
  }

  /**
   * Apply one confirmed complete radio contact scan atomically: upsert every
   * contact the radio reported, then drop stored contacts the radio no longer
   * has. The contacts table mirrors the radio's *current* contact list;
   * message history is the historical record — messages carry their own
   * contact_key/contact_prefix identity and stay queryable after a removal.
   * Never call this with a partial listing (e.g. a browser ingest batch).
   */
  syncContacts(contacts: Contact[]): { removed: string[] } {
    const removed: string[] = [];
    this.db.transaction(() => {
      for (const contact of contacts) this.upsertContact(contact);
      for (const known of this.getContacts()) {
        if (!contacts.some((contact) => contact.publicKey === known.publicKey)) {
          this.removeContact(known.publicKey);
          removed.push(known.publicKey);
        }
      }
    })();
    return { removed };
  }

  getContacts(): Contact[] {
    const rows = this.db
      .prepare("SELECT * FROM contacts ORDER BY last_advert DESC")
      .all() as Array<{
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

  findUniqueContactByPrefix(pubKeyPrefixHex: string): Contact | null {
    const matches = this.getContacts().filter((c) => c.publicKey.startsWith(pubKeyPrefixHex));
    return matches.length === 1 ? matches[0]! : null;
  }

  private reconcileContactMessages(publicKey: string): string[] {
    const prefixes = this.db
      .prepare(
        `SELECT DISTINCT contact_prefix FROM messages
         WHERE kind = 'dm' AND contact_key IS NULL AND contact_prefix IS NOT NULL
           AND ? LIKE contact_prefix || '%'
           AND (SELECT COUNT(*) FROM contacts WHERE public_key LIKE messages.contact_prefix || '%') = 1`,
      )
      .all(publicKey) as Array<{ contact_prefix: string }>;
    if (!prefixes.length) return [];
    this.db
      .prepare(
        `UPDATE messages SET contact_key = ?
         WHERE kind = 'dm' AND contact_key IS NULL AND contact_prefix IS NOT NULL
           AND ? LIKE contact_prefix || '%'
           AND (SELECT COUNT(*) FROM contacts WHERE public_key LIKE messages.contact_prefix || '%') = 1`,
      )
      .run(publicKey, publicKey);
    return prefixes.map((row) => row.contact_prefix);
  }

  removeContact(publicKey: string): void {
    this.db.prepare("DELETE FROM contacts WHERE public_key = ?").run(publicKey);
  }

  upsertChannel(channel: Channel): void {
    this.db
      .prepare(
        `INSERT INTO channels (idx, name, secret_hex, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(idx) DO UPDATE SET name = excluded.name, secret_hex = excluded.secret_hex, updated_at = excluded.updated_at`,
      )
      .run(channel.idx, channel.name, channel.secret, now());
  }

  deleteChannel(idx: number): void {
    this.db.prepare("DELETE FROM channels WHERE idx = ?").run(idx);
  }

  getChannels(): Channel[] {
    const rows = this.db.prepare("SELECT idx, name, secret_hex FROM channels ORDER BY idx").all() as Array<{
      idx: number;
      name: string;
      secret_hex: string;
    }>;
    return rows.map((r) => ({ idx: r.idx, name: r.name, secret: r.secret_hex }));
  }

  /** Insert a message once per stable ingestion ID. */
  insertMessage(input: {
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
  }): Message | null {
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
        ? this.findUniqueContactByPrefix(input.contactPrefix)?.publicKey ?? null
        : input.contactKey ?? null;
    const ingestionId = input.ingestionId ?? randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
             (kind, contact_key, contact_prefix, channel_idx, direction, text, sender_timestamp, path_len, ack_crc, status, dedupe_hash, created_at, author_prefix, ingestion_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  /** Late delivery-state update for a retried browser ingestion. */
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
           (message_id, kind, contact_key, channel_idx, text, cli, attempts, max_attempts, next_attempt_at, last_error, state, created_at, updated_at)
         VALUES (@messageId, @kind, @contactKey, @channelIdx, @text, @cli, 0, @maxAttempts, @nextAttemptAt, NULL, 'pending', @ts, @ts)`,
      )
      .run({
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
   * Entries whose backoff has elapsed and are eligible for an attempt
   * (`pending` or `retrying`), oldest-due first. `failed` entries are excluded —
   * they only re-enter the queue via an explicit user retry.
   */
  takeDueOutbound(atTs: number): OutboundEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbound_queue
         WHERE state IN ('pending','retrying') AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, message_id ASC`,
      )
      .all(atTs) as OutboundRow[];
    return rows.map(rowToOutbound);
  }

  /** The full ledger (pending/retrying/failed), newest first, for the queue view. */
  listOutbound(): OutboundEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM outbound_queue ORDER BY created_at DESC, message_id DESC")
      .all() as OutboundRow[];
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

  /** Earliest scheduled attempt among still-eligible entries, or null when none remain. */
  nextOutboundAttemptAt(): number | null {
    const row = this.db
      .prepare("SELECT MIN(next_attempt_at) AS n FROM outbound_queue WHERE state IN ('pending','retrying')")
      .get() as { n: number | null };
    return row.n ?? null;
  }

  getRecentMessages(limit: number): Message[] {
    const rows = this.db
      .prepare(`${MESSAGE_SELECT} ORDER BY m.id DESC LIMIT ?`)
      .all(Math.min(Math.max(limit, 1), 200)) as MessageRow[];
    return rows.map(rowToMessage);
  }

  getConversation(opts: {
    contactKey?: string;
    contactPrefix?: string;
    channelIdx?: number;
    beforeId?: number;
    limit: number;
  }): Message[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: Math.min(Math.max(opts.limit, 1), 200) };
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
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`${MESSAGE_SELECT} ${where} ORDER BY m.id DESC LIMIT @limit`)
      .all(params) as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }

  /**
   * Full-text search over message text (FTS5), best match first. User input
   * is quoted term-by-term so FTS query syntax can't error; the final term
   * matches as a prefix for type-ahead feel. Snippets mark matches with
   * \x01…\x02 so the UI can highlight without HTML in the payload.
   */
  searchMessages(opts: {
    query: string;
    contactKey?: string;
    contactPrefix?: string;
    channelIdx?: number;
    limit: number;
  }): MessageSearchResult[] {
    const terms = opts.query.trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const match = terms.map((term, i) => `"${term.replace(/"/g, '""')}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
    const clauses: string[] = ["messages_fts MATCH @match"];
    const params: Record<string, unknown> = { match, limit: Math.min(Math.max(opts.limit, 1), 100) };
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
         LEFT JOIN contacts c ON c.public_key = m.contact_key
         LEFT JOIN channels ch ON ch.idx = m.channel_idx
         LEFT JOIN outbound_queue q ON q.message_id = m.id
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank LIMIT @limit`,
      )
      .all(params) as (MessageRow & { snippet: string })[];
    return rows.map((row) => ({ ...rowToMessage(row), snippet: row.snippet }));
  }

  /** Every message of a conversation (or everything), oldest first, for export. */
  getMessagesForExport(opts: { contactKey?: string; contactPrefix?: string; channelIdx?: number } = {}): Message[] {
    return [...this.iterateMessagesForExport(opts)];
  }

  /**
   * Stream matching messages oldest-first without materializing the whole
   * history: better-sqlite3's row iterator keeps only one row in memory at a
   * time, so a large persistent database exports with bounded memory. The
   * underlying statement iterator is finalized when the consumer stops early
   * (a broken `for..of` calls the generator's `return`).
   */
  *iterateMessagesForExport(
    opts: { contactKey?: string; contactPrefix?: string; channelIdx?: number } = {},
  ): Generator<Message> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
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
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const stmt = this.db.prepare(`${MESSAGE_SELECT} ${where} ORDER BY m.id ASC`);
    for (const row of stmt.iterate(params) as IterableIterator<MessageRow>) {
      yield rowToMessage(row);
    }
  }

  getUnknownDirectMessages(): Message[] {
    const rows = this.db
      .prepare(
        `${MESSAGE_SELECT}
         WHERE m.kind = 'dm' AND m.contact_key IS NULL AND m.contact_prefix IS NOT NULL
           AND m.id IN (
             SELECT MAX(id) FROM messages
             WHERE kind = 'dm' AND contact_key IS NULL AND contact_prefix IS NOT NULL
             GROUP BY contact_prefix
           )
         ORDER BY m.id DESC`,
      )
      .all() as MessageRow[];
    return rows.map(rowToMessage);
  }

  markConversationRead(opts: { contactKey?: string; contactPrefix?: string; channelIdx?: number }): void {
    if (opts.contactKey !== undefined) {
      this.db
        .prepare("UPDATE messages SET read = 1 WHERE kind = 'dm' AND contact_key = ? AND direction = 'in'")
        .run(opts.contactKey);
    } else if (opts.contactPrefix !== undefined) {
      this.db
        .prepare("UPDATE messages SET read = 1 WHERE kind = 'dm' AND contact_key IS NULL AND contact_prefix = ? AND direction = 'in'")
        .run(opts.contactPrefix);
    } else if (opts.channelIdx !== undefined) {
      this.db
        .prepare("UPDATE messages SET read = 1 WHERE kind = 'channel' AND channel_idx = ? AND direction = 'in'")
        .run(opts.channelIdx);
    }
  }

  /**
   * Unread incoming messages grouped per conversation, using the same
   * addressing as getConversation: resolved DMs by contact key, unresolved
   * DMs by sender prefix, channel messages by channel index.
   */
  getUnreadSummary(): ConversationUnread[] {
    const rows = this.db
      .prepare(
        `SELECT kind,
                CASE WHEN kind = 'dm' THEN contact_key END AS contact_key,
                CASE WHEN kind = 'dm' AND contact_key IS NULL THEN contact_prefix END AS contact_prefix,
                CASE WHEN kind = 'channel' THEN channel_idx END AS channel_idx,
                COUNT(*) AS unread
         FROM messages
         WHERE direction = 'in' AND read = 0
         GROUP BY 1, 2, 3, 4
         ORDER BY unread DESC`,
      )
      .all() as Array<{
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

  counts(): { contacts: number; messages: number; unread: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      contacts: one("SELECT COUNT(*) AS n FROM contacts"),
      messages: one("SELECT COUNT(*) AS n FROM messages"),
      unread: one("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND read = 0"),
    };
  }

  recordTelemetry(batteryMv: number | null, raw?: unknown): void {
    this.db
      .prepare("INSERT INTO telemetry (ts, battery_mv, raw_json) VALUES (?, ?, ?)")
      .run(now(), batteryMv, raw === undefined ? null : JSON.stringify(raw));
  }

  getTelemetry(sinceTs: number): TelemetryPoint[] {
    const rows = this.db
      .prepare("SELECT ts, battery_mv FROM telemetry WHERE contact_key IS NULL AND ts >= ? ORDER BY ts ASC")
      .all(sinceTs) as Array<{ ts: number; battery_mv: number | null }>;
    return rows.map((r) => ({ ts: r.ts, batteryMv: r.battery_mv }));
  }

  /** Persist one successful remote telemetry response for a contact. */
  recordContactTelemetry(contactKey: string, readings: SensorReading[]): void {
    this.db
      .prepare("INSERT INTO telemetry (ts, battery_mv, raw_json, contact_key) VALUES (?, NULL, ?, ?)")
      .run(now(), JSON.stringify(readings), contactKey);
  }

  getContactTelemetry(contactKey: string, sinceTs: number): ContactTelemetryPoint[] {
    const rows = this.db
      .prepare("SELECT ts, raw_json FROM telemetry WHERE contact_key = ? AND ts >= ? ORDER BY ts ASC")
      .all(contactKey, sinceTs) as Array<{ ts: number; raw_json: string | null }>;
    return rows.map((row) => ({ ts: row.ts, readings: row.raw_json ? (JSON.parse(row.raw_json) as SensorReading[]) : [] }));
  }

  /** Delete telemetry rows older than the retention window. Returns rows removed. */
  trimTelemetry(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = now() - Math.floor(retentionDays * 86_400);
    return this.db.prepare("DELETE FROM telemetry WHERE ts < ?").run(cutoff).changes;
  }

  latestBatteryMv(): number | null {
    const row = this.db
      .prepare("SELECT battery_mv FROM telemetry WHERE contact_key IS NULL AND battery_mv IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { battery_mv: number } | undefined;
    return row?.battery_mv ?? null;
  }
}
