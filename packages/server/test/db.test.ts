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
});
