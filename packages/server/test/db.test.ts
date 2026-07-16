import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";

describe("database migrations", () => {
  it("separates legacy sender prefixes without changing known full keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-db-"));
    const path = join(directory, "meshkeep.db");
    const prefix = "abcdef123456";
    const padded = `${prefix}${"0".repeat(52)}`;
    const knownPadded = `fedcba654321${"0".repeat(52)}`;
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE contacts (public_key TEXT PRIMARY KEY);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, contact_key TEXT);
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      INSERT INTO contacts (public_key) VALUES ('${knownPadded}');
      INSERT INTO messages (id, kind, contact_key) VALUES
        (1, 'dm', '${prefix}'),
        (2, 'dm', '${padded}'),
        (3, 'dm', '${knownPadded}');
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const migrated = openDb(path);
    const rows = migrated
      .prepare("SELECT id, contact_key, contact_prefix, ingestion_id FROM messages ORDER BY id")
      .all() as Array<{ id: number; contact_key: string | null; contact_prefix: string | null; ingestion_id: string }>;
    migrated.close();
    rmSync(directory, { recursive: true, force: true });

    expect(rows.map(({ ingestion_id: _ingestionId, ...row }) => row)).toEqual([
      { id: 1, contact_key: null, contact_prefix: prefix },
      { id: 2, contact_key: null, contact_prefix: prefix },
      { id: 3, contact_key: knownPadded, contact_prefix: null },
    ]);
    expect(rows.map((row) => row.ingestion_id)).toHaveLength(3);
    expect(new Set(rows.map((row) => row.ingestion_id)).size).toBe(3);
    expect(rows.every((row) => /^[0-9a-f]{32}$/.test(row.ingestion_id))).toBe(true);
  });

  it("enforces exclusive dm/channel shapes on new writes while keeping legacy rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-db-"));
    const path = join(directory, "meshkeep.db");
    // a pre-shape-constraint database containing a malformed dm row: rewind
    // everything migrations 7+ add, then let openDb re-apply them
    const legacy = openDb(path);
    legacy.exec(`
      DROP TRIGGER messages_shape_bi;
      DROP TRIGGER messages_shape_bu;
      DROP TABLE sessions;
      ALTER TABLE api_tokens DROP COLUMN scope;
      ALTER TABLE api_tokens DROP COLUMN expires_at;
    `);
    legacy
      .prepare(
        `INSERT INTO messages (kind, contact_key, channel_idx, direction, text, sender_timestamp, status, dedupe_hash, created_at, ingestion_id)
         VALUES ('dm', NULL, NULL, 'in', 'orphan', 1, 'sent', 'legacy-1', 1, 'legacy-ingest-1')`,
      )
      .run();
    legacy.pragma("user_version = 6");
    legacy.close();

    const db = openDb(path);
    const insert = (kind: string, contactKey: string | null, channelIdx: number | null) =>
      db
        .prepare(
          `INSERT INTO messages (kind, contact_key, channel_idx, direction, text, sender_timestamp, status, dedupe_hash, created_at, ingestion_id)
           VALUES (?, ?, ?, 'in', 'x', 1, 'sent', lower(hex(randomblob(8))), 1, lower(hex(randomblob(8))))`,
        )
        .run(kind, contactKey, channelIdx);

    // the malformed legacy row survives the migration untouched
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(1);
    // new writes are validated
    expect(() => insert("dm", null, null)).toThrow(/dm message needs a contact identity/);
    expect(() => insert("dm", "a".repeat(64), 3)).toThrow(/dm message needs a contact identity and no channel index/);
    expect(() => insert("channel", null, null)).toThrow(/channel message needs a channel index/);
    expect(() => insert("channel", "a".repeat(64), 3)).toThrow(/no contact identity/);
    expect(() => insert("dm", "a".repeat(64), null)).not.toThrow();
    expect(() => insert("channel", null, 3)).not.toThrow();
    // updates cannot break a valid shape either
    expect(() => db.prepare("UPDATE messages SET channel_idx = 5 WHERE kind = 'dm' AND contact_key IS NOT NULL").run()).toThrow(
      /no channel index/,
    );
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
