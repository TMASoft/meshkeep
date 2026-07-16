import { randomUUID } from "node:crypto";
import type {
  Channel,
  Contact,
  ContactTelemetryPoint,
  Message,
  MessageDirection,
  MessageKind,
  MessageSearchResult,
  MessageStatus,
  SelfInfo,
  SensorReading,
  TelemetryPoint,
} from "@meshkeep/shared";
import type { Db } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

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
    status: row.status,
    createdAt: row.created_at,
    authorPrefix: row.author_prefix,
    authorName: row.author_name ?? null,
  };
}

const MESSAGE_SELECT = `
  SELECT m.*, c.name AS contact_name, ch.name AS channel_name, a.name AS author_name
  FROM messages m
  LEFT JOIN contacts c ON c.public_key = m.contact_key
  LEFT JOIN channels ch ON ch.idx = m.channel_idx
  LEFT JOIN contacts a ON m.author_prefix IS NOT NULL AND a.public_key LIKE m.author_prefix || '%'
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

  touchContactSeen(publicKey: string): void {
    this.db
      .prepare("UPDATE contacts SET last_seen = ?, updated_at = ? WHERE public_key = ?")
      .run(now(), now(), publicKey);
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
        `SELECT m.*, c.name AS contact_name, ch.name AS channel_name, a.name AS author_name,
                snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snippet
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         LEFT JOIN contacts c ON c.public_key = m.contact_key
         LEFT JOIN channels ch ON ch.idx = m.channel_idx
         LEFT JOIN contacts a ON m.author_prefix IS NOT NULL AND a.public_key LIKE m.author_prefix || '%'
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank LIMIT @limit`,
      )
      .all(params) as (MessageRow & { snippet: string })[];
    return rows.map((row) => ({ ...rowToMessage(row), snippet: row.snippet }));
  }

  /** Every message of a conversation (or everything), oldest first, for export. */
  getMessagesForExport(opts: { contactKey?: string; contactPrefix?: string; channelIdx?: number } = {}): Message[] {
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
    const rows = this.db.prepare(`${MESSAGE_SELECT} ${where} ORDER BY m.id ASC`).all(params) as MessageRow[];
    return rows.map(rowToMessage);
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
