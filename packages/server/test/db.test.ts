import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { databaseDiagnostics, MIGRATIONS, openDb } from "../src/db/index.js";
import { Store } from "../src/db/store.js";

/** Build a database at a historical schema version by applying the real migrations. */
function openAtVersion(path: string, version: number): Database.Database {
  const db = new Database(path);
  for (let i = 0; i < version; i++) db.exec(MIGRATIONS[i]!);
  db.pragma(`user_version = ${version}`);
  return db;
}

describe("database migrations", () => {
  it("separates legacy sender prefixes without changing known full keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-db-"));
    const path = join(directory, "meshkeep.db");
    const prefix = "abcdef123456";
    const padded = `${prefix}${"0".repeat(52)}`;
    const knownPadded = `fedcba654321${"0".repeat(52)}`;
    // A real migration-4-era database (full schema through migration 4).
    const legacy = openAtVersion(path, 4);
    legacy
      .prepare("INSERT INTO contacts (public_key, name, updated_at) VALUES (?, 'Known', 1)")
      .run(knownPadded);
    const insertLegacy = legacy.prepare(
      `INSERT INTO messages (id, kind, contact_key, direction, text, sender_timestamp, status, dedupe_hash, created_at)
       VALUES (?, 'dm', ?, 'in', 'x', 1, 'sent', ?, 1)`,
    );
    insertLegacy.run(1, prefix, "d1");
    insertLegacy.run(2, padded, "d2");
    insertLegacy.run(3, knownPadded, "d3");
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
    // A real migration-6-era database (before the shape triggers of migration 7)
    // holding a malformed dm row; openDb then applies migrations 7+.
    const legacy = openAtVersion(path, 6);
    legacy
      .prepare(
        `INSERT INTO messages (kind, contact_key, channel_idx, direction, text, sender_timestamp, status, dedupe_hash, created_at, ingestion_id)
         VALUES ('dm', NULL, NULL, 'in', 'orphan', 1, 'sent', 'legacy-1', 1, 'legacy-ingest-1')`,
      )
      .run();
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

  it("keys pre-isolation data to a radio seeded from the stored self (migration 11)", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-db-"));
    const path = join(directory, "meshkeep.db");
    const selfKey = "aa".repeat(32);
    // A single-radio database from before per-device isolation (migration 10).
    const legacy = openAtVersion(path, 10);
    legacy
      .prepare("INSERT INTO self (id, public_key, name, raw_json, updated_at) VALUES (1, ?, 'My Radio', '{}', 1)")
      .run(selfKey);
    legacy.prepare("INSERT INTO contacts (public_key, name, updated_at) VALUES (?, 'Bob', 1)").run("bb".repeat(32));
    legacy.prepare("INSERT INTO channels (idx, name, secret_hex, updated_at) VALUES (0, 'Public', ?, 1)").run("c".repeat(32));
    legacy
      .prepare(
        `INSERT INTO messages (kind, channel_idx, direction, text, sender_timestamp, status, dedupe_hash, created_at, ingestion_id)
         VALUES ('channel', 0, 'in', 'hi', 1, 'sent', 'd1', 1, 'i1')`,
      )
      .run();
    legacy.prepare("INSERT INTO telemetry (ts, battery_mv) VALUES (1, 4100)").run();
    legacy.close();

    const db = openDb(path);
    // one radio, seeded from the stored self identity
    const radios = db.prepare("SELECT id, public_key, name FROM radios").all() as Array<{
      id: number;
      public_key: string;
      name: string;
    }>;
    expect(radios).toEqual([{ id: 1, public_key: selfKey, name: "My Radio" }]);
    // every pre-existing row is stamped to that radio
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(one("SELECT radio_id AS n FROM self")).toBe(1);
    expect(one("SELECT radio_id AS n FROM contacts")).toBe(1);
    expect(one("SELECT radio_id AS n FROM channels")).toBe(1);
    expect(one("SELECT radio_id AS n FROM messages")).toBe(1);
    expect(one("SELECT radio_id AS n FROM telemetry")).toBe(1);
    // composite keys now admit the same contact/channel identity on another radio
    expect(() =>
      db.prepare("INSERT INTO contacts (radio_id, public_key, name, updated_at) VALUES (2, ?, 'Bob elsewhere', 1)").run(
        "bb".repeat(32),
      ),
    ).not.toThrow();
    expect(databaseDiagnostics(db).foreignKeyViolations).toBe(0);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("insertMessage inbound frame dedup", () => {
  it("dedupes an inbound DM re-delivered with the same conversation, timestamp, and text", () => {
    const store = new Store(openDb(":memory:"));
    const radioId = store.resolveRadio("11".repeat(32), "Radio One");
    const first = store.insertMessage(radioId, {
      kind: "dm",
      contactPrefix: "abcdef12",
      direction: "in",
      text: "Hola",
      senderTimestamp: 1784282914,
    });
    expect(first).not.toBeNull();
    const second = store.insertMessage(radioId, {
      kind: "dm",
      contactPrefix: "abcdef12",
      direction: "in",
      text: "Hola",
      senderTimestamp: 1784282914,
    });
    expect(second).toBeNull();
    expect(store.counts(radioId).messages).toBe(1);
  });

  it("preserves a genuine repeat send with a distinct sender_timestamp", () => {
    const store = new Store(openDb(":memory:"));
    const radioId = store.resolveRadio("11".repeat(32), "Radio One");
    store.insertMessage(radioId, {
      kind: "dm",
      contactPrefix: "abcdef12",
      direction: "in",
      text: "Hola",
      senderTimestamp: 1784282914,
    });
    const second = store.insertMessage(radioId, {
      kind: "dm",
      contactPrefix: "abcdef12",
      direction: "in",
      text: "Hola",
      senderTimestamp: 1784282999,
    });
    expect(second).not.toBeNull();
    expect(store.counts(radioId).messages).toBe(2);
  });

  it("does not conflate identical channel text/timestamp across different channels", () => {
    const store = new Store(openDb(":memory:"));
    const radioId = store.resolveRadio("11".repeat(32), "Radio One");
    store.insertMessage(radioId, {
      kind: "channel",
      channelIdx: 0,
      direction: "in",
      text: "channel hello",
      senderTimestamp: 1784282914,
    });
    const onOtherChannel = store.insertMessage(radioId, {
      kind: "channel",
      channelIdx: 1,
      direction: "in",
      text: "channel hello",
      senderTimestamp: 1784282914,
    });
    expect(onOtherChannel).not.toBeNull();
    expect(store.counts(radioId).messages).toBe(2);

    const redelivered = store.insertMessage(radioId, {
      kind: "channel",
      channelIdx: 0,
      direction: "in",
      text: "channel hello",
      senderTimestamp: 1784282914,
    });
    expect(redelivered).toBeNull();
    expect(store.counts(radioId).messages).toBe(2);
  });

  it("simulates a reconnect re-drain: re-processing the same frame after reconnect does not duplicate it", () => {
    const store = new Store(openDb(":memory:"));
    const radioId = store.resolveRadio("11".repeat(32), "Radio One");
    const frame = {
      kind: "dm" as const,
      contactPrefix: "abcdef12",
      direction: "in" as const,
      text: "Hola",
      senderTimestamp: 1784282914,
    };
    store.insertMessage(radioId, frame);
    // the radio queue re-drains the same unacknowledged frame after reconnect
    store.insertMessage(radioId, frame);
    store.insertMessage(radioId, frame);
    expect(store.counts(radioId).messages).toBe(1);
  });

  it("leaves outbound sends unaffected: identical text/timestamp with no ingestionId are both stored", () => {
    const store = new Store(openDb(":memory:"));
    const radioId = store.resolveRadio("11".repeat(32), "Radio One");
    const contactKey = "ab".repeat(32);
    store.insertMessage(radioId, {
      kind: "dm",
      contactKey,
      direction: "out",
      text: "hi",
      senderTimestamp: 1784282914,
      status: "pending",
    });
    const second = store.insertMessage(radioId, {
      kind: "dm",
      contactKey,
      direction: "out",
      text: "hi",
      senderTimestamp: 1784282914,
      status: "pending",
    });
    expect(second).not.toBeNull();
    expect(store.counts(radioId).messages).toBe(2);
  });
});

describe("openDb durability configuration", () => {
  it("enables WAL, foreign keys, and a busy timeout", () => {
    const db = openDb(":memory:");
    // :memory: reports "memory" journal mode; a file database reports "wal"
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
  });

  it("reports WAL on a real file database", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-db-"));
    const db = openDb(join(directory, "meshkeep.db"));
    expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("databaseDiagnostics", () => {
  it("reports a clean, fully-migrated database", () => {
    const db = openDb(":memory:");
    const diag = databaseDiagnostics(db);
    expect(diag.integrity).toBe("ok");
    expect(diag.foreignKeyViolations).toBe(0);
    expect(diag.busyTimeoutMs).toBe(5000);
    // a freshly opened database is migrated to the latest schema
    expect(diag.schemaVersion).toBe(diag.latestSchemaVersion);
    expect(diag.latestSchemaVersion).toBeGreaterThanOrEqual(8);
    expect(diag.pageSizeBytes).toBeGreaterThan(0);
    expect(diag.pageCount).toBeGreaterThan(0);
    expect(diag.sizeBytes).toBe(diag.pageSizeBytes * diag.pageCount);
    db.close();
  });

  it("surfaces a partially-migrated schema version", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-db-"));
    const db = openDb(join(directory, "meshkeep.db"));
    const latest = databaseDiagnostics(db).latestSchemaVersion;
    db.pragma("user_version = 3"); // simulate an interrupted/older upgrade
    const diag = databaseDiagnostics(db);
    expect(diag.schemaVersion).toBe(3);
    expect(diag.schemaVersion).toBeLessThan(latest);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
