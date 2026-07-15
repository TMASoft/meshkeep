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
