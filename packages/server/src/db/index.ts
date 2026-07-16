import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE self (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    name TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE contacts (
    public_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat',
    flags INTEGER NOT NULL DEFAULT 0,
    out_path_len INTEGER NOT NULL DEFAULT -1,
    lat REAL,
    lon REAL,
    last_advert INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER,
    raw_json TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE channels (
    idx INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hex TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('dm','channel')),
    contact_key TEXT,
    channel_idx INTEGER,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    text TEXT NOT NULL,
    sender_timestamp INTEGER NOT NULL,
    path_len INTEGER,
    ack_crc INTEGER,
    status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','delivered','failed')),
    read INTEGER NOT NULL DEFAULT 0,
    dedupe_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_contact ON messages (contact_key, id);
  CREATE INDEX idx_messages_channel ON messages (channel_idx, id);

  CREATE TABLE telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    battery_mv INTEGER,
    raw_json TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,
  // 2: author attribution for signed-plain room posts (4-byte pubkey prefix, hex)
  `
  ALTER TABLE messages ADD COLUMN author_prefix TEXT;
  `,
  // 3: full-text search over message text (external-content FTS5 table kept
  // in sync by triggers; messages are append-mostly but delete/update stay
  // covered so the index can never drift)
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
  CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  INSERT INTO messages_fts(rowid, text) SELECT id, text FROM messages;
  `,
  // 4: remote telemetry history — contact_key NULL keeps meaning "our own
  // node" (battery polls); remote responses store parsed readings per contact
  `
  ALTER TABLE telemetry ADD COLUMN contact_key TEXT;
  CREATE INDEX idx_telemetry_contact ON telemetry (contact_key, ts);
  `,
  // 5: direct-message sender prefixes are not full contact identities. Older
  // server rows stored short prefixes directly; browser rows padded 6-byte
  // prefixes to a fake 64-character key.
  `
  ALTER TABLE messages ADD COLUMN contact_prefix TEXT;
   UPDATE messages
   SET contact_prefix = CASE
         WHEN length(contact_key) < 64 THEN contact_key
         WHEN length(contact_key) = 64 AND trim(substr(contact_key, 13), '0') = ''
           AND NOT EXISTS (SELECT 1 FROM contacts WHERE public_key = messages.contact_key)
           THEN substr(contact_key, 1, 12)
       END,
       contact_key = NULL
   WHERE kind = 'dm'
     AND contact_key IS NOT NULL
     AND (length(contact_key) < 64 OR (
       length(contact_key) = 64 AND trim(substr(contact_key, 13), '0') = ''
       AND NOT EXISTS (SELECT 1 FROM contacts WHERE public_key = messages.contact_key)
     ));
   CREATE INDEX idx_messages_contact_prefix ON messages (contact_prefix, id);
   `,
  // 6: content and a whole-second sender timestamp are not a message identity.
  // Keep dedupe_hash for existing databases, but use a stable ingestion ID for
  // new browser sync-backs and generated IDs for server-owned records.
  `
   ALTER TABLE messages ADD COLUMN ingestion_id TEXT;
   UPDATE messages SET ingestion_id = lower(hex(randomblob(16))) WHERE ingestion_id IS NULL;
   CREATE UNIQUE INDEX idx_messages_ingestion_id ON messages (ingestion_id);
  `,
  // 7: enforce exclusive conversation shapes. A dm row must carry a contact
  // identity and no channel index; a channel row must carry a channel index
  // and no contact identity. Triggers (not a table rebuild) so pre-existing
  // rows are preserved as-is while every new write is validated.
  `
  CREATE TRIGGER messages_shape_bi BEFORE INSERT ON messages BEGIN
    SELECT CASE
      WHEN NEW.kind = 'dm' AND (NEW.channel_idx IS NOT NULL
        OR ((NEW.contact_key IS NULL OR NEW.contact_key = '') AND (NEW.contact_prefix IS NULL OR NEW.contact_prefix = '')))
        THEN RAISE(ABORT, 'dm message needs a contact identity and no channel index')
      WHEN NEW.kind = 'channel' AND (NEW.channel_idx IS NULL
        OR NEW.contact_key IS NOT NULL OR NEW.contact_prefix IS NOT NULL)
        THEN RAISE(ABORT, 'channel message needs a channel index and no contact identity')
    END;
  END;
  CREATE TRIGGER messages_shape_bu BEFORE UPDATE OF kind, contact_key, contact_prefix, channel_idx ON messages BEGIN
    SELECT CASE
      WHEN NEW.kind = 'dm' AND (NEW.channel_idx IS NOT NULL
        OR ((NEW.contact_key IS NULL OR NEW.contact_key = '') AND (NEW.contact_prefix IS NULL OR NEW.contact_prefix = '')))
        THEN RAISE(ABORT, 'dm message needs a contact identity and no channel index')
      WHEN NEW.kind = 'channel' AND (NEW.channel_idx IS NULL
        OR NEW.contact_key IS NOT NULL OR NEW.contact_prefix IS NOT NULL)
        THEN RAISE(ABORT, 'channel message needs a channel index and no contact identity')
    END;
  END;
  `,
  // 8: random revocable UI sessions (replacing the deterministic shared
  // cookie — existing logins must re-authenticate once) and least-privilege
  // API tokens: scoped (existing integrations become read-only) with
  // optional expiry.
  `
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read','write'));
  ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;
  `,
];

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const apply = db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    });
    apply();
  }
}

export function getSetting<T>(db: Db, key: string): T | null {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
    | { value_json: string }
    | undefined;
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(key, JSON.stringify(value));
}
