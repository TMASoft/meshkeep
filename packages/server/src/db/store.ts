import { createHash } from "node:crypto";
import type {
  Channel,
  Contact,
  Message,
  MessageDirection,
  MessageKind,
  MessageStatus,
  SelfInfo,
  TelemetryPoint,
} from "@meshkeep/shared";
import type { Db } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

export function dedupeHash(
  kind: MessageKind,
  counterparty: string,
  senderTimestamp: number,
  direction: MessageDirection,
  text: string,
  authorPrefix?: string | null,
): string {
  // authorPrefix only participates when present so historical hashes stay valid
  return createHash("sha256")
    .update(`${kind}|${counterparty}|${senderTimestamp}|${direction}|${text}${authorPrefix ? `|${authorPrefix}` : ""}`)
    .digest("hex");
}

interface MessageRow {
  id: number;
  kind: MessageKind;
  contact_key: string | null;
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
    kind: row.kind,
    contactKey: row.contact_key,
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

  upsertContact(contact: Contact): void {
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

  findContactByPrefix(pubKeyPrefixHex: string): Contact | null {
    const contact = this.getContacts().find((c) => c.publicKey.startsWith(pubKeyPrefixHex));
    return contact ?? null;
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

  /**
   * Insert a message unless its dedupe hash already exists.
   * Returns the stored message, or null when it was a duplicate.
   */
  insertMessage(input: {
    kind: MessageKind;
    contactKey?: string | null;
    channelIdx?: number | null;
    direction: MessageDirection;
    text: string;
    senderTimestamp: number;
    pathLen?: number | null;
    ackCrc?: number | null;
    status?: MessageStatus;
    authorPrefix?: string | null;
  }): Message | null {
    const counterparty = input.kind === "dm" ? input.contactKey ?? "" : String(input.channelIdx ?? "");
    const hash = dedupeHash(input.kind, counterparty, input.senderTimestamp, input.direction, input.text, input.authorPrefix);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (kind, contact_key, channel_idx, direction, text, sender_timestamp, path_len, ack_crc, status, dedupe_hash, created_at, author_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.contactKey ?? null,
        input.channelIdx ?? null,
        input.direction,
        input.text,
        input.senderTimestamp,
        input.pathLen ?? null,
        input.ackCrc ?? null,
        input.status ?? (input.direction === "in" ? "sent" : "pending"),
        hash,
        now(),
        input.authorPrefix ?? null,
      );
    if (result.changes === 0) return null;
    return this.getMessage(Number(result.lastInsertRowid));
  }

  getMessage(id: number): Message | null {
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  /**
   * Late status update for a message that already exists (matched by content
   * hash) — how browser-direct sessions report delivery acks after sync-back.
   * Only moves status forward from pending/sent.
   */
  updateMessageStatusByContent(input: {
    kind: MessageKind;
    contactKey?: string | null;
    channelIdx?: number | null;
    direction: MessageDirection;
    text: string;
    senderTimestamp: number;
    status: MessageStatus;
    authorPrefix?: string | null;
  }): Message | null {
    const counterparty = input.kind === "dm" ? input.contactKey ?? "" : String(input.channelIdx ?? "");
    const hash = dedupeHash(input.kind, counterparty, input.senderTimestamp, input.direction, input.text, input.authorPrefix);
    const row = this.db
      .prepare("SELECT id FROM messages WHERE dedupe_hash = ? AND status IN ('pending','sent')")
      .get(hash) as { id: number } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE messages SET status = ? WHERE id = ?").run(input.status, row.id);
    return this.getMessage(row.id);
  }

  markDeliveredByAck(ackCrc: number): Message | null {
    const row = this.db
      .prepare("SELECT id FROM messages WHERE ack_crc = ? AND status IN ('pending','sent') ORDER BY id DESC LIMIT 1")
      .get(ackCrc) as { id: number } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ?").run(row.id);
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
    channelIdx?: number;
    beforeId?: number;
    limit: number;
  }): Message[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: Math.min(Math.max(opts.limit, 1), 200) };
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
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

  /** Every message of a conversation (or everything), oldest first, for export. */
  getMessagesForExport(opts: { contactKey?: string; channelIdx?: number } = {}): Message[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.contactKey !== undefined) {
      clauses.push("m.kind = 'dm' AND m.contact_key = @contactKey");
      params.contactKey = opts.contactKey;
    } else if (opts.channelIdx !== undefined) {
      clauses.push("m.kind = 'channel' AND m.channel_idx = @channelIdx");
      params.channelIdx = opts.channelIdx;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`${MESSAGE_SELECT} ${where} ORDER BY m.id ASC`).all(params) as MessageRow[];
    return rows.map(rowToMessage);
  }

  markConversationRead(opts: { contactKey?: string; channelIdx?: number }): void {
    if (opts.contactKey !== undefined) {
      this.db
        .prepare("UPDATE messages SET read = 1 WHERE kind = 'dm' AND contact_key = ? AND direction = 'in'")
        .run(opts.contactKey);
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
      .prepare("SELECT ts, battery_mv FROM telemetry WHERE ts >= ? ORDER BY ts ASC")
      .all(sinceTs) as Array<{ ts: number; battery_mv: number | null }>;
    return rows.map((r) => ({ ts: r.ts, batteryMv: r.battery_mv }));
  }

  /** Delete telemetry rows older than the retention window. Returns rows removed. */
  trimTelemetry(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = now() - Math.floor(retentionDays * 86_400);
    return this.db.prepare("DELETE FROM telemetry WHERE ts < ?").run(cutoff).changes;
  }

  latestBatteryMv(): number | null {
    const row = this.db
      .prepare("SELECT battery_mv FROM telemetry WHERE battery_mv IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { battery_mv: number } | undefined;
    return row?.battery_mv ?? null;
  }
}
