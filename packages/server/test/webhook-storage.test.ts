import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openDb } from "../src/db/index.js";
import { createWebhookCrypto } from "../src/webhooks/crypto.js";
import { Store } from "../src/db/store.js";

function openAtVersion(path: string, version: number): Database.Database {
  const db = new Database(path);
  for (let i = 0; i < version; i++) db.exec(MIGRATIONS[i]!);
  db.pragma(`user_version = ${version}`);
  return db;
}

const masterKey = Buffer.alloc(32, 7);
const signingSecret = Buffer.alloc(32, 9);

function subscriptionInput() {
  return {
    label: "Home Assistant",
    destination: "https://hooks.example.test/meshkeep",
    eventTypes: ["message.created"],
    radioIds: [1],
    includeSensitive: false,
  };
}

describe("webhook storage migrations", () => {
  it("upgrades the latest historical schema; rollback requires restoring a pre-upgrade SQLite backup", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "meshkeep-webhook-migration-"),
    );
    const path = join(directory, "meshkeep.db");
    const legacy = openAtVersion(path, MIGRATIONS.length - 1);
    legacy.close();

    const db = openDb(path, masterKey);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_deliveries'",
        )
        .get(),
    ).toEqual({
      name: "webhook_deliveries",
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_webhook_deliveries_due'",
        )
        .get(),
    ).toEqual({
      name: "idx_webhook_deliveries_due",
    });
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }, 15_000);
});

describe("webhook store", () => {
  it("stores an AEAD-encrypted signing secret without plaintext in database rows", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const crypto = createWebhookCrypto(masterKey);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      crypto,
    );

    const row = db
      .prepare(
        "SELECT key_id, secret_ciphertext, secret_nonce, secret_auth_tag FROM webhook_keys WHERE subscription_id = ?",
      )
      .get(subscription.id) as {
      key_id: string;
      secret_ciphertext: Buffer;
      secret_nonce: Buffer;
      secret_auth_tag: Buffer;
    };
    expect(row.key_id).toBe("key-1");
    expect(row.secret_ciphertext.equals(signingSecret)).toBe(false);
    expect(
      Buffer.concat([
        row.secret_ciphertext,
        row.secret_nonce,
        row.secret_auth_tag,
      ]).includes(signingSecret),
    ).toBe(false);
    expect(
      store
        .getWebhookSigningKey(subscription.id, "key-1", crypto)
        ?.equals(signingSecret),
    ).toBe(true);
    db.close();
  });

  it("enforces subscription/key/event foreign keys and prunes only terminal deliveries in bounded batches", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const crypto = createWebhookCrypto(masterKey);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      crypto,
    );
    store.recordWebhookEvent({
      eventId: "evt-1",
      type: "message.created",
      eventVersion: 1,
      sourceRadioId: 1,
      occurredAt: 1,
      body: Buffer.from('{"id":"evt-1"}'),
    });
    const delivery = store.enqueueWebhookDelivery({
      subscriptionId: subscription.id,
      eventId: "evt-1",
      keyId: "key-1",
      nextAttemptAt: 1,
    });
    expect(() =>
      db
        .prepare(
          "INSERT INTO webhook_deliveries (subscription_id, event_id, key_id, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (999, 'evt-1', 'key-1', 'queued', 0, 1, 1, 1)",
        )
        .run(),
    ).toThrow();
    store.finishWebhookDelivery(delivery.id, {
      state: "delivered",
      completedAt: 10,
      responseStatus: 204,
      responseClass: "2xx",
    });
    expect(store.pruneWebhookRetention(11, 1)).toEqual({
      deliveries: 1,
      events: 1,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM webhook_events").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("keeps persisted event body snapshots immutable while retaining a bounded forward-only cleanup path", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    store.recordWebhookEvent({
      eventId: "evt-immutable",
      type: "message.created",
      eventVersion: 1,
      sourceRadioId: 1,
      occurredAt: 1,
      body: Buffer.from('{"id":"evt-immutable"}'),
    });
    expect(() =>
      db
        .prepare(
          "UPDATE webhook_events SET body = 'changed' WHERE event_id = 'evt-immutable'",
        )
        .run(),
    ).toThrow(/immutable/);
    expect(store.pruneWebhookRetention(1, 1)).toEqual({
      deliveries: 0,
      events: 1,
    });
    db.close();
  });

  it("atomically leases each due delivery at most once across claimers", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const crypto = createWebhookCrypto(masterKey);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      crypto,
    );
    for (const eventId of ["evt-1", "evt-2"]) {
      store.recordWebhookEvent({
        eventId,
        type: "message.created",
        eventVersion: 1,
        sourceRadioId: 1,
        occurredAt: 1,
        body: Buffer.from(eventId),
      });
      store.enqueueWebhookDelivery({
        subscriptionId: subscription.id,
        eventId,
        keyId: "key-1",
        nextAttemptAt: 1,
      });
    }
    expect(store.claimDueWebhookDeliveries("worker-a", 2, 60, 10)).toHaveLength(
      1,
    );
    expect(store.claimDueWebhookDeliveries("worker-b", 2, 60, 10)).toEqual([]);
    expect(
      store.claimDueWebhookDeliveries("worker-b", 63, 60, 10),
    ).toHaveLength(1);
    db.close();
  });

  it("survives a restart and only permits a new worker to reclaim an expired lease", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-webhook-restart-"));
    const path = join(directory, "meshkeep.db");
    const initialDb = openDb(path, masterKey);
    const initialStore = new Store(initialDb);
    const subscription = initialStore.createWebhookSubscription(subscriptionInput());
    initialStore.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      createWebhookCrypto(masterKey),
    );
    initialStore.recordWebhookEvent({
      eventId: "evt-restart",
      type: "message.created",
      eventVersion: 1,
      sourceRadioId: 1,
      occurredAt: 1,
      body: Buffer.from("evt-restart"),
    });
    initialStore.enqueueWebhookDelivery({
      subscriptionId: subscription.id,
      eventId: "evt-restart",
      keyId: "key-1",
      nextAttemptAt: 1,
    });
    expect(
      initialStore.claimDueWebhookDeliveries("before-restart", 2, 30, 10),
    ).toHaveLength(1);
    initialDb.close();

    const restartedDb = openDb(path, masterKey);
    const restartedStore = new Store(restartedDb);
    expect(
      restartedStore.claimDueWebhookDeliveries("after-restart", 3, 30, 10),
    ).toEqual([]);
    expect(
      restartedStore.claimDueWebhookDeliveries("after-restart", 33, 30, 10),
    ).toEqual([
      expect.objectContaining({
        state: "leased",
        attemptCount: 2,
        leaseOwner: "after-restart",
      }),
    ]);
    restartedDb.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not enqueue a stale worker projection after its subscription is paused", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      createWebhookCrypto(masterKey),
    );
    const active = store.getWebhookSubscription(subscription.id)!;
    store.updateWebhookSubscription(subscription.id, { ...active, state: "paused" });

    expect(
      store.queueWebhookEvent({
        subscriptionId: subscription.id,
        keyId: "key-1",
        eventId: "evt-paused",
        type: "message.created",
        eventVersion: 1,
        sourceRadioId: 1,
        occurredAt: 1,
        body: Buffer.from('{"id":"evt-paused"}'),
        now: 1,
      }),
    ).toBe("subscription_not_active");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM webhook_events").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("enforces global lease capacity and prevents a stale owner from completing a newer lease", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const crypto = createWebhookCrypto(masterKey);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      crypto,
    );
    store.recordWebhookEvent({
      eventId: "evt-stale",
      type: "message.created",
      eventVersion: 1,
      sourceRadioId: 1,
      occurredAt: 1,
      body: Buffer.from("evt-stale"),
    });
    const delivery = store.enqueueWebhookDelivery({
      subscriptionId: subscription.id,
      eventId: "evt-stale",
      keyId: "key-1",
      nextAttemptAt: 1,
    });

    expect(store.claimDueWebhookDeliveries("worker-a", 2, 1, 1)).toHaveLength(
      1,
    );
    expect(store.claimDueWebhookDeliveries("worker-b", 2, 60, 1)).toEqual([]);
    expect(store.claimDueWebhookDeliveries("worker-b", 3, 60, 1)).toHaveLength(
      1,
    );
    store.finishWebhookDelivery(delivery.id, {
      state: "delivered",
      completedAt: 3,
      responseStatus: 204,
      responseClass: "2xx",
      leaseOwner: "worker-a",
    });
    expect(store.getWebhookDelivery(delivery.id)).toMatchObject({
      state: "leased",
      leaseOwner: "worker-b",
    });
    db.close();
  });

  it("bounds per-subscription queue growth with terminal dropped records", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const crypto = createWebhookCrypto(masterKey);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      crypto,
    );
    for (let index = 0; index < 101; index++) {
      const result = store.queueWebhookEvent({
        subscriptionId: subscription.id,
        keyId: "key-1",
        eventId: `evt-${index}`,
        type: "message.created",
        eventVersion: 1,
        sourceRadioId: 1,
        occurredAt: 10,
        body: Buffer.from(`evt-${index}`),
        now: 10,
      });
      expect(result).toBe(index < 100 ? "queued" : "subscription_rate_limit");
    }
    expect(
      store
        .listWebhookDeliveries({ subscriptionId: subscription.id, limit: 200 })
        .filter((delivery) => delivery.state === "dropped"),
    ).toHaveLength(1);
    db.close();
  });

  it("drops a new delivery when the global queue is saturated without expanding the active queue", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      createWebhookCrypto(masterKey),
    );
    const insertEvent = db.prepare(
      "INSERT INTO webhook_events (event_id, type, event_version, source_radio_id, occurred_at, body, created_at) VALUES (?, 'message.created', 1, 1, 1, 'queued', 1)",
    );
    const insertDelivery = db.prepare(
      "INSERT INTO webhook_deliveries (subscription_id, event_id, key_id, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'key-1', 'queued', 0, 1, 1, 1)",
    );
    db.transaction(() => {
      for (let index = 0; index < 10_000; index++) {
        const eventId = `global-${index}`;
        insertEvent.run(eventId);
        insertDelivery.run(subscription.id, eventId);
      }
    })();

    expect(
      store.queueWebhookEvent({
        subscriptionId: subscription.id,
        keyId: "key-1",
        eventId: "global-dropped",
        type: "message.created",
        eventVersion: 1,
        sourceRadioId: 1,
        occurredAt: 2,
        body: Buffer.from("not-delivered"),
        now: 2,
      }),
    ).toBe("global_queue_limit");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE state IN ('queued', 'leased')",
        )
        .get(),
    ).toEqual({ count: 10_000 });
    expect(
      store.listWebhookDeliveries({ subscriptionId: subscription.id, limit: 1 }),
    ).toEqual([
      expect.objectContaining({
        state: "dropped",
        errorSummary: "global_queue_limit",
      }),
    ]);
    db.close();
  });

  it("terminally disables a subscription and drops its queued and leased deliveries", () => {
    const db = openDb(":memory:", masterKey);
    const store = new Store(db);
    const crypto = createWebhookCrypto(masterKey);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      crypto,
    );
    for (const eventId of ["evt-leased", "evt-queued"]) {
      store.recordWebhookEvent({
        eventId,
        type: "message.created",
        eventVersion: 1,
        sourceRadioId: 1,
        occurredAt: 1,
        body: Buffer.from(eventId),
      });
      store.enqueueWebhookDelivery({
        subscriptionId: subscription.id,
        eventId,
        keyId: "key-1",
        nextAttemptAt: 1,
      });
    }
    expect(store.claimDueWebhookDeliveries("worker-a", 2, 60, 1)).toHaveLength(
      1,
    );

    store.disableWebhookSubscription(subscription.id, "terminal delivery failure");

    expect(store.getWebhookSubscription(subscription.id)?.state).toBe("disabled");
    expect(
      store
        .listWebhookDeliveries({ subscriptionId: subscription.id, limit: 10 })
        .map((delivery) => delivery.state),
    ).toEqual(["dropped", "dropped"]);
    expect(store.claimDueWebhookDeliveries("worker-b", 3, 60, 10)).toEqual([]);
    db.close();
  });

  it("fails closed at startup when stored webhook keys cannot be decrypted", () => {
    const directory = mkdtempSync(join(tmpdir(), "meshkeep-webhook-key-"));
    const path = join(directory, "meshkeep.db");
    const db = openDb(path, masterKey);
    const store = new Store(db);
    const subscription = store.createWebhookSubscription(subscriptionInput());
    store.createWebhookSigningKey(
      subscription.id,
      "key-1",
      signingSecret,
      createWebhookCrypto(masterKey),
    );
    db.close();

    expect(() => openDb(path, Buffer.alloc(32, 8))).toThrow(
      /cannot decrypt existing webhook signing keys/,
    );
    expect(() => openDb(path)).toThrow(
      /MESHKEEP_WEBHOOK_MASTER_KEY is required/,
    );
    rmSync(directory, { recursive: true, force: true });
  });
});
