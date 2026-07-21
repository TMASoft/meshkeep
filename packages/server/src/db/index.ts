import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseDiagnostics } from "@meshkeep/shared";

/**
 * Ordered schema migrations; index N upgrades a database from user_version N to
 * N+1. Exported so tests can reconstruct any historical schema version faithfully
 * (apply MIGRATIONS[0..k) and set user_version = k) instead of hand-rolling a
 * partial fixture that later migrations then choke on.
 */
export const MIGRATIONS: string[] = [
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
  // 9: persisted outbound retry queue. One row per outbound message that has
  // not yet been handed off to the radio (or has exhausted its attempts). The
  // message row keeps the coarse status (pending/sent/delivered/failed); the
  // queue holds the retry ledger and derives the `retrying` display state.
  // Removed on successful hand-off; a `failed` row lingers for user retry/cancel.
  `
  CREATE TABLE outbound_queue (
    message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('dm','channel')),
    contact_key     TEXT,
    channel_idx     INTEGER,
    text            TEXT NOT NULL,
    cli             INTEGER NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','retrying','failed')),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_outbound_queue_due ON outbound_queue (state, next_attempt_at);
  `,
  // 10: named radio connection profiles (issue #53). The selected profile id
  // lives in settings ('connection.activeProfileId'); with no selection the
  // effective connection stays env + runtime override, so existing single-radio
  // setups upgrade without any behavior change.
  `
  CREATE TABLE radio_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL CHECK (transport IN ('serial','tcp','ble','none')),
    serial_port TEXT,
    serial_baud INTEGER NOT NULL DEFAULT 115200,
    tcp_host TEXT,
    tcp_port INTEGER NOT NULL DEFAULT 5000,
    ble_address TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 11: per-device data isolation (issue #53, Stage 2). Stored data is keyed to
  // the physical radio, identified by its self public key (learned on connect).
  // A `radios` identity row is seeded from the existing self so every pre-isolation
  // row attaches to radio_id 1 with no visible change; new radios are created on
  // first connect. contacts/channels/self are rebuilt to re-key by radio; messages,
  // telemetry and the outbound queue take a radio_id column (SQLite forbids a
  // REFERENCES clause on ADD COLUMN with FKs on, so — like the existing
  // messages↔contacts join — the radios link is enforced in application code).
  `
  CREATE TABLE radios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT UNIQUE,
    name TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO radios (id, public_key, name, first_seen, last_seen, updated_at)
    SELECT 1, public_key, name, updated_at, updated_at, updated_at FROM self WHERE id = 1;

  -- self: one row per radio (drop the id=1 singleton).
  CREATE TABLE self_new (
    radio_id INTEGER PRIMARY KEY,
    public_key TEXT NOT NULL,
    name TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO self_new (radio_id, public_key, name, raw_json, updated_at)
    SELECT 1, public_key, name, raw_json, updated_at FROM self;
  DROP TABLE self;
  ALTER TABLE self_new RENAME TO self;

  -- contacts: composite (radio_id, public_key) identity.
  CREATE TABLE contacts_new (
    radio_id INTEGER NOT NULL DEFAULT 1,
    public_key TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat',
    flags INTEGER NOT NULL DEFAULT 0,
    out_path_len INTEGER NOT NULL DEFAULT -1,
    lat REAL,
    lon REAL,
    last_advert INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER,
    raw_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (radio_id, public_key)
  );
  INSERT INTO contacts_new
    SELECT 1, public_key, name, type, flags, out_path_len, lat, lon, last_advert, last_seen, raw_json, updated_at FROM contacts;
  DROP TABLE contacts;
  ALTER TABLE contacts_new RENAME TO contacts;

  -- channels: composite (radio_id, idx) identity.
  CREATE TABLE channels_new (
    radio_id INTEGER NOT NULL DEFAULT 1,
    idx INTEGER NOT NULL,
    name TEXT NOT NULL,
    secret_hex TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (radio_id, idx)
  );
  INSERT INTO channels_new SELECT 1, idx, name, secret_hex, updated_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;

  -- messages: add radio_id and re-lead the conversation indexes with it.
  ALTER TABLE messages ADD COLUMN radio_id INTEGER NOT NULL DEFAULT 1;
  DROP INDEX idx_messages_contact;
  DROP INDEX idx_messages_channel;
  DROP INDEX idx_messages_contact_prefix;
  CREATE INDEX idx_messages_contact ON messages (radio_id, contact_key, id);
  CREATE INDEX idx_messages_channel ON messages (radio_id, channel_idx, id);
  CREATE INDEX idx_messages_contact_prefix ON messages (radio_id, contact_prefix, id);

  -- telemetry: add radio_id and re-lead its lookup index.
  ALTER TABLE telemetry ADD COLUMN radio_id INTEGER NOT NULL DEFAULT 1;
  DROP INDEX idx_telemetry_contact;
  CREATE INDEX idx_telemetry_contact ON telemetry (radio_id, contact_key, ts);

  -- outbound queue: add radio_id so a queued send only drains when its radio is active.
  ALTER TABLE outbound_queue ADD COLUMN radio_id INTEGER NOT NULL DEFAULT 1;
  DROP INDEX idx_outbound_queue_due;
  CREATE INDEX idx_outbound_queue_due ON outbound_queue (radio_id, state, next_attempt_at);
  `,
  // 12: concurrent radio links (issue #53, Stage 3). Which connections the
  // server should currently maintain is now row existence in radio_links
  // (profile_id NULL = the implicit env/override "default" link) instead of
  // the single connection.activeProfileId/activeRadioId/connection.standby
  // settings keys — folded into this table and dropped below. SQLite treats
  // every NULL as distinct for UNIQUE, so this does not by itself stop two
  // profile_id IS NULL rows; Store.setDefaultLinkEnabled is the only code
  // path allowed to write that row and enforces it there.
  `
  CREATE TABLE radio_links (
    profile_id    INTEGER UNIQUE REFERENCES radio_profiles(id) ON DELETE CASCADE,
    standby       INTEGER NOT NULL DEFAULT 0,
    last_radio_id INTEGER,
    activated_at  INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  -- no profile was exclusively active: seed the implicit default link so an
  -- upgrading single-radio deployment keeps its one connection unchanged.
  INSERT INTO radio_links (profile_id, standby, last_radio_id, activated_at, updated_at)
  SELECT NULL,
    COALESCE((SELECT CASE WHEN value_json = 'true' THEN 1 ELSE 0 END FROM settings WHERE key = 'connection.standby'), 0),
    (SELECT CASE WHEN value_json IS NULL OR value_json = 'null' THEN NULL ELSE CAST(value_json AS INTEGER) END
       FROM settings WHERE key = 'connection.activeRadioId'),
    strftime('%s','now'), strftime('%s','now')
  WHERE NOT EXISTS (
    SELECT 1 FROM settings WHERE key = 'connection.activeProfileId' AND value_json IS NOT NULL AND value_json != 'null'
  );

  -- a profile was exclusively active: carry it forward as that profile's link.
  INSERT INTO radio_links (profile_id, standby, last_radio_id, activated_at, updated_at)
  SELECT CAST(s.value_json AS INTEGER),
    COALESCE((SELECT CASE WHEN value_json = 'true' THEN 1 ELSE 0 END FROM settings WHERE key = 'connection.standby'), 0),
    (SELECT CASE WHEN value_json IS NULL OR value_json = 'null' THEN NULL ELSE CAST(value_json AS INTEGER) END
       FROM settings WHERE key = 'connection.activeRadioId'),
    strftime('%s','now'), strftime('%s','now')
  FROM settings s
  WHERE s.key = 'connection.activeProfileId' AND s.value_json IS NOT NULL AND s.value_json != 'null'
    AND EXISTS (SELECT 1 FROM radio_profiles WHERE id = CAST(s.value_json AS INTEGER));

  DELETE FROM settings WHERE key IN ('connection.activeProfileId', 'connection.activeRadioId', 'connection.standby');
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
  // Wait up to 5s for a competing writer instead of failing fast with
  // SQLITE_BUSY. Writes are short and serialized within the process; contention
  // only arises from an external reader (a backup, the sqlite3 CLI) briefly
  // holding the database. WAL keeps readers from blocking the writer.
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/**
 * Read-only durability snapshot for diagnostics. `integrity_check` scans the
 * whole database, so this is an operator action, not a hot path.
 */
export function databaseDiagnostics(db: Db): DatabaseDiagnostics {
  const integrityRows = db.pragma("integrity_check") as { integrity_check: string }[];
  const fkRows = db.pragma("foreign_key_check") as unknown[];
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const walRow = db.pragma("wal_checkpoint(PASSIVE)") as { log: number; checkpointed: number }[];
  return {
    integrity: integrityRows.map((row) => row.integrity_check).join("; "),
    foreignKeyViolations: fkRows.length,
    journalMode: db.pragma("journal_mode", { simple: true }) as string,
    synchronous: db.pragma("synchronous", { simple: true }) as number,
    busyTimeoutMs: db.pragma("busy_timeout", { simple: true }) as number,
    schemaVersion: db.pragma("user_version", { simple: true }) as number,
    latestSchemaVersion: MIGRATIONS.length,
    pageSizeBytes: pageSize,
    pageCount,
    freelistPages: db.pragma("freelist_count", { simple: true }) as number,
    sizeBytes: pageSize * pageCount,
    walPages: walRow[0]?.log ?? 0,
  };
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

/**
 * Cheap liveness-of-storage check for the readiness probe: a trivial query must
 * succeed and the schema must be fully migrated. Unlike `databaseDiagnostics`
 * this does no full-table scan, so it is safe to poll frequently.
 */
export function databaseReady(db: Db): { ready: boolean; schemaVersion: number; latestSchemaVersion: number } {
  try {
    db.prepare("SELECT 1").get();
    const schemaVersion = db.pragma("user_version", { simple: true }) as number;
    return { ready: schemaVersion === MIGRATIONS.length, schemaVersion, latestSchemaVersion: MIGRATIONS.length };
  } catch {
    return { ready: false, schemaVersion: -1, latestSchemaVersion: MIGRATIONS.length };
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
