import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { buildHarness } from "./helpers.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
// A browser-direct session names its radio by self public key on every ingest batch.
const RADIO_KEY = "e".repeat(64);

describe("http: status and health", () => {
  const { app } = buildHarness();

  it("healthz responds outside the versioned api", async () => {
    const res = await request(app).get("/api/healthz").expect(200);
    expect(res.body).toEqual({ ok: true, version: "test" });
  });

  it("readyz reports readiness once the schema is migrated", async () => {
    const res = await request(app).get("/api/readyz").expect(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.database.schemaVersion).toBe(res.body.database.latestSchemaVersion);
  });

  it("readyz returns 503 when the schema is behind (mid-migration)", async () => {
    const { app: staleApp, db } = buildHarness();
    db.pragma("user_version = 1"); // simulate an interrupted upgrade
    const res = await request(staleApp).get("/api/readyz").expect(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.database.schemaVersion).toBe(1);
  });

  it("reports a sane status while disconnected", async () => {
    const res = await request(app).get("/api/v1/status").expect(200);
    expect(res.body.connection.state).toBe("disconnected");
    expect(res.body.connection.transport).toBe("none");
    expect(res.body.self).toBeNull();
  });
});

describe("http: diagnostics", () => {
  const { app } = buildHarness();

  it("returns aggregated, secret-free diagnostics", async () => {
    const res = await request(app).get("/api/v1/diagnostics").expect(200);
    expect(res.body.server.version).toBe("test");
    expect(typeof res.body.server.uptimeSeconds).toBe("number");
    expect(res.body.database.integrity).toBe("ok");
    expect(res.body.database.schemaVersion).toBe(res.body.database.latestSchemaVersion);
    expect(res.body.connection).toMatchObject({ transport: "none", reconnectScheduled: false });
    expect(Array.isArray(res.body.guidance)).toBe(true);
    // no self yet while disconnected
    expect(res.body.radio).toBeNull();
  });

  it("serves a redacted support bundle as an attachment", async () => {
    const res = await request(app).get("/api/v1/diagnostics/bundle").expect(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("meshkeep-diagnostics-");
    // secrets are redacted: the raw password never appears, only a boolean
    expect(res.body.config).not.toHaveProperty("uiPassword");
    expect(res.body.config.uiPasswordSet).toBe(false);
    expect(res.body.diagnostics.server.version).toBe("test");
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});

describe("http: zod validation (400s)", () => {
  const { app } = buildHarness();

  const cases: Array<[string, () => request.Test]> = [
    ["recent limit 0", () => request(app).get("/api/v1/messages/recent?limit=0")],
    ["recent limit 51", () => request(app).get("/api/v1/messages/recent?limit=51")],
    ["messages bad contact", () => request(app).get("/api/v1/messages?contact=xyz")],
    ["send bad kind", () => request(app).post("/api/v1/messages").send({ kind: "smoke", text: "hi" })],
    ["send short hex", () => request(app).post("/api/v1/messages").send({ kind: "dm", to: "abcd", text: "hi" })],
    [
      "send oversized text",
      () => request(app).post("/api/v1/messages").send({ kind: "dm", to: KEY_A, text: "x".repeat(2001) }),
    ],
    ["read without target", () => request(app).post("/api/v1/messages/read").send({})],
    ["read with two targets", () => request(app).post("/api/v1/messages/read").send({ contact: KEY_A, channel: 1 })],
    ["messages contact and channel", () => request(app).get(`/api/v1/messages?contact=${KEY_A}&channel=1`)],
    ["messages contact and sender", () => request(app).get(`/api/v1/messages?contact=${KEY_A}&sender=abcd`)],
    ["search contact and channel", () => request(app).get(`/api/v1/messages/search?q=x&contact=${KEY_A}&channel=1`)],
    ["export contact and channel", () => request(app).get(`/api/v1/messages/export?contact=${KEY_A}&channel=1`)],
    [
      "ingest dm carrying channelIdx",
      () =>
        request(app)
          .post("/api/v1/ingest/messages")
          .send({
            messages: [
              { kind: "dm", contactKey: KEY_A, channelIdx: 1, direction: "in", text: "x", senderTimestamp: 1, ingestionId: "00000000-0000-4000-8000-00000000aa01" },
            ],
          }),
    ],
    [
      "ingest channel carrying a contact",
      () =>
        request(app)
          .post("/api/v1/ingest/messages")
          .send({
            messages: [
              { kind: "channel", channelIdx: 1, contactKey: KEY_A, direction: "in", text: "x", senderTimestamp: 1, ingestionId: "00000000-0000-4000-8000-00000000aa02" },
            ],
          }),
    ],
    [
      "ingest dm without any sender identity",
      () =>
        request(app)
          .post("/api/v1/ingest/messages")
          .send({
            messages: [
              { kind: "dm", direction: "in", text: "x", senderTimestamp: 1, ingestionId: "00000000-0000-4000-8000-00000000aa03" },
            ],
          }),
    ],
    [
      "ingest channel without channelIdx",
      () =>
        request(app)
          .post("/api/v1/ingest/messages")
          .send({
            messages: [
              { kind: "channel", direction: "in", text: "x", senderTimestamp: 1, ingestionId: "00000000-0000-4000-8000-00000000aa04" },
            ],
          }),
    ],
    ["channel idx out of range", () => request(app).put("/api/v1/channels/8").send({ name: "x", secret: "0".repeat(32) })],
    ["channel bad secret", () => request(app).put("/api/v1/channels/0").send({ name: "x", secret: "zz" })],
    ["device lat without lon", () => request(app).patch("/api/v1/device").send({ lat: 44.2 })],
    ["device sf 13", () => request(app).patch("/api/v1/device").send({ radioSf: 13 })],
    ["contact key not hex", () => request(app).delete("/api/v1/contacts/nothex")],
    [
      "connection bad ble address",
      () =>
        request(app)
          .put("/api/v1/connection/config")
          .send({ override: { connection: "ble", bleAddress: "not-a-mac" } }),
    ],
    ["telemetry hours 0", () => request(app).get("/api/v1/telemetry?hours=0")],
    ["export bad format", () => request(app).get("/api/v1/messages/export?format=xml")],
  ];

  for (const [name, make] of cases) {
    it(name, async () => {
      const res = await make().expect(400);
      expect(res.body.error).toBe("invalid request");
      expect(Array.isArray(res.body.details)).toBe(true);
    });
  }
});

describe("http: internal errors stay generic", () => {
  it("hides unexpected library/system errors but keeps deliberate operational messages", async () => {
    const { app, manager } = buildHarness();
    const spy = vi.spyOn(manager.store, "getRecentMessages");

    spy.mockImplementation(() => {
      throw new TypeError("boom at /srv/meshkeep/secret/path.ts:42");
    });
    const internal = await request(app).get("/api/v1/messages/recent").expect(500);
    expect(internal.body).toEqual({ error: "internal error" });

    spy.mockImplementation(() => {
      throw new Error("radio rejected the message");
    });
    const operational = await request(app).get("/api/v1/messages/recent").expect(500);
    expect(operational.body).toEqual({ error: "radio rejected the message" });
    spy.mockRestore();
  });
});

describe("http: radio-touching routes while disconnected", () => {
  const { app } = buildHarness();

  it("send dm queues instead of failing", async () => {
    // Sends are accepted into the outbound queue even with no radio: they stay
    // pending and the worker delivers them once a radio is available.
    const res = await request(app)
      .post("/api/v1/messages")
      .send({ kind: "dm", to: KEY_A, text: "hello" })
      .expect(201);
    expect(res.body.message.status).toBe("pending");

    const queue = await request(app).get("/api/v1/messages/outbound").expect(200);
    expect(queue.body.queue).toHaveLength(1);
    expect(queue.body.queue[0]).toMatchObject({ messageId: res.body.message.id, kind: "dm", state: "pending" });
  });

  it("contacts refresh", async () => {
    await request(app).post("/api/v1/contacts/refresh").expect(503);
  });

  it("advert", async () => {
    await request(app).post("/api/v1/advert").send({}).expect(503);
  });

  it("channel write", async () => {
    await request(app)
      .put("/api/v1/channels/0")
      .send({ name: "test", secret: "0".repeat(32) })
      .expect(503);
  });
});

describe("http: outbound queue retry/cancel", () => {
  const { app } = buildHarness();

  async function queueOne(text: string): Promise<number> {
    const res = await request(app).post("/api/v1/messages").send({ kind: "dm", to: KEY_A, text }).expect(201);
    return res.body.message.id as number;
  }

  it("lists queued sends", async () => {
    const id = await queueOne("in the queue");
    const res = await request(app).get("/api/v1/messages/outbound").expect(200);
    expect(res.body.queue.some((e: { messageId: number }) => e.messageId === id)).toBe(true);
  });

  it("404s retrying an unknown message and 409s retrying a still-pending one", async () => {
    await request(app).post("/api/v1/messages/999999/retry").expect(404);
    const id = await queueOne("still pending");
    await request(app).post(`/api/v1/messages/${id}/retry`).expect(409);
  });

  it("cancels a queued send and drops it from the queue", async () => {
    const id = await queueOne("cancel me");
    const res = await request(app).post(`/api/v1/messages/${id}/cancel`).expect(200);
    expect(res.body.message.status).toBe("failed");
    const queue = await request(app).get("/api/v1/messages/outbound").expect(200);
    expect(queue.body.queue.some((e: { messageId: number }) => e.messageId === id)).toBe(false);
    // a second cancel now 404s (no longer queued)
    await request(app).post(`/api/v1/messages/${id}/cancel`).expect(404);
  });
});

describe("http: store-backed reads", () => {
  const { app, manager } = buildHarness();
  const store = manager.store;
  const radioId = store.resolveRadio("ee".repeat(32), "R");

  const base = 1_784_000_000;
  store.upsertContact(radioId, {
    publicKey: KEY_A,
    name: "Alice",
    type: "chat",
    flags: 0,
    outPathLen: -1,
    lat: null,
    lon: null,
    lastAdvert: 0,
    lastSeen: null,
  });
  for (let i = 0; i < 25; i++) {
    store.insertMessage(radioId, {
      kind: "dm",
      contactKey: KEY_A,
      direction: i % 2 ? "out" : "in",
      text: `dm ${i}`,
      senderTimestamp: base + i,
      status: "sent",
    });
  }
  store.insertMessage(radioId, {
    kind: "channel",
    channelIdx: 0,
    direction: "in",
    text: "channel hello",
    senderTimestamp: base + 100,
    status: "sent",
  });

  it("recent defaults to 20 newest", async () => {
    const res = await request(app).get("/api/v1/messages/recent").expect(200);
    expect(res.body.messages).toHaveLength(20);
    expect(res.body.messages[0].text).toBe("channel hello");
  });

  it("filters a conversation by contact (case-insensitive) with pagination", async () => {
    const first = await request(app).get(`/api/v1/messages?contact=${KEY_A.toUpperCase()}&limit=10`).expect(200);
    expect(first.body.messages).toHaveLength(10);
    for (const message of first.body.messages) expect(message.contactKey).toBe(KEY_A);

    const oldestId = first.body.messages[0].id;
    const prev = await request(app)
      .get(`/api/v1/messages?contact=${KEY_A}&limit=10&before=${oldestId}`)
      .expect(200);
    expect(prev.body.messages).toHaveLength(10);
    for (const message of prev.body.messages) expect(message.id).toBeLessThan(oldestId);
  });

  it("filters by channel", async () => {
    const res = await request(app).get("/api/v1/messages?channel=0").expect(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].text).toBe("channel hello");
  });

  it("marks a conversation read", async () => {
    await request(app).post("/api/v1/messages/read").send({ contact: KEY_A }).expect(200);
    expect(store.counts(radioId).unread).toBe(1); // only the channel message remains unread
  });

  it("exports csv with attachment headers", async () => {
    const res = await request(app).get("/api/v1/messages/export").expect(200);
    expect(res.get("Content-Type")).toContain("text/csv");
    expect(res.get("Content-Disposition")).toMatch(/attachment; filename="meshkeep-messages-.*\.csv"/);
    expect(res.text.split("\n")[0]).toContain("text");
  });

  it("exports json filtered to one contact", async () => {
    const res = await request(app).get(`/api/v1/messages/export?format=json&contact=${KEY_A}`).expect(200);
    expect(res.get("Content-Disposition")).toContain(".json");
    expect(res.body.messages).toHaveLength(25);
    expect(res.body.exportedAt).toBeGreaterThan(0);
  });

  it("lists contacts from the store", async () => {
    const res = await request(app).get("/api/v1/contacts").expect(200);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].name).toBe("Alice");
  });

  it("serves telemetry points", async () => {
    store.recordTelemetry(radioId, 4100);
    const res = await request(app).get("/api/v1/telemetry?hours=1").expect(200);
    expect(res.body.points).toHaveLength(1);
    expect(res.body.points[0].batteryMv).toBe(4100);
  });
});

describe("http: per-conversation unread summary", () => {
  const { app, manager } = buildHarness();
  const store = manager.store;
  const radioId = store.resolveRadio("ee".repeat(32), "R");
  const base = 1_784_000_000;
  const prefix = "abcdef123456";

  const insert = (input: Partial<Parameters<typeof store.insertMessage>[1]>, n = 1) => {
    for (let i = 0; i < n; i++) {
      store.insertMessage(radioId, {
        kind: "dm",
        direction: "in",
        text: `m${i}`,
        senderTimestamp: base + i,
        status: "sent",
        ...input,
      });
    }
  };
  store.upsertContact(radioId, {
    publicKey: KEY_A,
    name: "Alice",
    type: "chat",
    flags: 0,
    outPathLen: -1,
    lat: null,
    lon: null,
    lastAdvert: 0,
    lastSeen: null,
  });
  insert({ contactKey: KEY_A }, 2);
  insert({ contactKey: KEY_A, direction: "out" }); // outgoing never counts
  insert({ contactKey: null, contactPrefix: prefix }); // unresolved sender
  insert({ kind: "channel", channelIdx: 3 }, 3);

  const summary = async () => {
    const res = await request(app).get("/api/v1/messages/unread").expect(200);
    return res.body.conversations as Array<Record<string, unknown>>;
  };

  it("groups unread incoming messages by conversation", async () => {
    expect(await summary()).toEqual([
      { kind: "channel", contactKey: null, contactPrefix: null, channelIdx: 3, unread: 3 },
      { kind: "dm", contactKey: KEY_A, contactPrefix: null, channelIdx: null, unread: 2 },
      { kind: "dm", contactKey: null, contactPrefix: prefix, channelIdx: null, unread: 1 },
    ]);
  });

  it("stays correct after marking a conversation read", async () => {
    await request(app).post("/api/v1/messages/read").send({ contact: KEY_A }).expect(200);
    expect(await summary()).toEqual([
      { kind: "channel", contactKey: null, contactPrefix: null, channelIdx: 3, unread: 3 },
      { kind: "dm", contactKey: null, contactPrefix: prefix, channelIdx: null, unread: 1 },
    ]);
    await request(app).post("/api/v1/messages/read").send({ sender: prefix }).expect(200);
    await request(app).post("/api/v1/messages/read").send({ channel: 3 }).expect(200);
    expect(await summary()).toEqual([]);
  });

  it("counts new incoming messages again after read", async () => {
    insert({ contactKey: KEY_A, senderTimestamp: base + 500 });
    expect(await summary()).toEqual([
      { kind: "dm", contactKey: KEY_A, contactPrefix: null, channelIdx: null, unread: 1 },
    ]);
  });
});

// #61: an unread DM whose contact_key has no matching row in `contacts` — the
// radio's own self key (never a real contact) or a contact removed after
// messages arrived — used to count in the total badge with nowhere in the
// sidebar to open or clear it.
describe("http: orphaned and self-key DM unread (#61)", () => {
  const { app, manager } = buildHarness();
  const store = manager.store;
  const selfKey = "aa".repeat(32);
  const radioId = store.resolveRadio(selfKey, "Self Radio");
  const removedKey = "bb".repeat(32);
  const base = 1_784_100_000;

  const insert = (contactKey: string) =>
    store.insertMessage(radioId, {
      kind: "dm",
      contactKey,
      contactPrefix: contactKey.slice(0, 12),
      direction: "in",
      text: "hi",
      senderTimestamp: base,
      status: "sent",
    });

  // A contact present when its message arrived, then removed by a later sync.
  store.upsertContact(radioId, {
    publicKey: removedKey,
    name: "Gone",
    type: "chat",
    flags: 0,
    outPathLen: -1,
    lat: null,
    lon: null,
    lastAdvert: 0,
    lastSeen: null,
  });
  insert(removedKey);
  store.removeContact(radioId, removedKey);

  // The radio's own public key, resolved as if it had briefly appeared as a
  // contact (the root cause traced in #61).
  insert(selfKey);

  const summary = async () => {
    const res = await request(app).get("/api/v1/messages/unread").expect(200);
    return res.body.conversations as Array<Record<string, unknown>>;
  };
  const unknownSenders = async () => {
    const res = await request(app).get("/api/v1/messages/unknown-senders").expect(200);
    return res.body.messages as Array<Record<string, unknown>>;
  };

  it("excludes the self-key DM from the unread total entirely", async () => {
    expect(await summary()).toEqual([{ kind: "dm", contactKey: removedKey, contactPrefix: null, channelIdx: null, unread: 1 }]);
  });

  it("never lists the self-key DM as an openable sender", async () => {
    expect((await unknownSenders()).some((m) => m.contactKey === selfKey)).toBe(false);
  });

  it("surfaces the removed contact's DM so it can be opened and marked read", async () => {
    const messages = await unknownSenders();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ contactKey: removedKey });
    await request(app).post("/api/v1/messages/read").send({ contact: removedKey }).expect(200);
    expect(await summary()).toEqual([]);
  });
});

describe("http: ingest", () => {
  const { app } = buildHarness();

  it("accepts browser-direct messages and dedupes them", async () => {
    const message = {
      kind: "dm",
      contactKey: KEY_B,
      direction: "in",
      text: "from the browser",
      senderTimestamp: 1_784_000_500,
      status: "sent",
      ingestionId: "00000000-0000-4000-8000-000000000004",
    };
    const first = await request(app).post("/api/v1/ingest/messages").send({ radioKey: RADIO_KEY, messages: [message] }).expect(200);
    expect(first.body.inserted).toBe(1);
    const again = await request(app).post("/api/v1/ingest/messages").send({ radioKey: RADIO_KEY, messages: [message] }).expect(200);
    expect(again.body.inserted).toBe(0);
  });

  it("upserts self info", async () => {
    await request(app)
      .post("/api/v1/ingest/self")
      .send({
        self: {
          publicKey: KEY_B,
          name: "Browser Node",
          type: 1,
          txPower: 22,
          maxTxPower: 22,
          lat: null,
          lon: null,
          radioFreq: 910525,
          radioBw: 250000,
          radioSf: 10,
          radioCr: 5,
        },
      })
      .expect(200);
    const status = await request(app).get("/api/v1/status").expect(200);
    expect(status.body.self.name).toBe("Browser Node");
  });

  it("caps a batch at 500 items", async () => {
    const messages = Array.from({ length: 501 }, (_, i) => ({
      kind: "dm",
      contactKey: KEY_B,
      direction: "in",
      text: `m${i}`,
      senderTimestamp: i + 1,
      status: "sent",
    }));
      await request(app).post("/api/v1/ingest/messages").send({ radioKey: RADIO_KEY, messages }).expect(400);
  });

  it("keeps ambiguous sender prefixes unresolved", async () => {
    const { app, manager } = buildHarness();
    const prefix = "abcdef123456";
    const radioId = manager.store.resolveRadio(RADIO_KEY, null);
    for (const suffix of ["a", "b"]) {
      manager.store.upsertContact(radioId, {
        publicKey: `${prefix}${suffix.repeat(52)}`,
        name: suffix,
        type: "chat",
        flags: 0,
        outPathLen: -1,
        lat: null,
        lon: null,
        lastAdvert: 0,
        lastSeen: null,
      });
    }
    const inserted = await request(app)
      .post("/api/v1/ingest/messages")
       .send({
         radioKey: RADIO_KEY,
         messages: [
           {
             kind: "dm",
             contactPrefix: prefix,
             direction: "in",
             text: "ambiguous",
             senderTimestamp: 1,
             ingestionId: "00000000-0000-4000-8000-000000000005",
           },
         ],
       })
      .expect(200);
    expect(inserted.body.messages[0]).toMatchObject({ contactKey: null, contactPrefix: prefix });
    const unknown = await request(app).get("/api/v1/messages/unknown-senders").expect(200);
    expect(unknown.body.messages).toHaveLength(1);
  });

  it("reconciles an unknown sender when a unique matching contact is stored", async () => {
    const { app, manager } = buildHarness();
    const prefix = "abcdef123456";
    const fullKey = `${prefix}${"a".repeat(52)}`;
    await request(app)
      .post("/api/v1/ingest/messages")
       .send({
         radioKey: RADIO_KEY,
         messages: [
           {
             kind: "dm",
             contactPrefix: prefix,
             direction: "in",
             text: "identify me",
             senderTimestamp: 1,
             ingestionId: "00000000-0000-4000-8000-000000000006",
           },
         ],
       })
      .expect(200);
    manager.store.upsertContact(manager.store.resolveRadio(RADIO_KEY, null), {
      publicKey: fullKey,
      name: "Alice",
      type: "chat",
      flags: 0,
      outPathLen: -1,
      lat: null,
      lon: null,
      lastAdvert: 0,
      lastSeen: null,
    });
    const history = await request(app).get(`/api/v1/messages?contact=${fullKey}`).expect(200);
    expect(history.body.messages).toHaveLength(1);
    expect(history.body.messages[0]).toMatchObject({ contactKey: fullKey, contactPrefix: prefix });
    const unknown = await request(app).get("/api/v1/messages/unknown-senders").expect(200);
    expect(unknown.body.messages).toHaveLength(0);
  });
});

describe("http: map and connection config", () => {
  it("404s when the global map is disabled", async () => {
    const { app } = buildHarness({ mapEnabled: false });
    const res = await request(app).get("/api/v1/map/nodes").expect(404);
    expect(res.body.error).toBe("global map disabled");
  });

  it("round-trips a connection override", async () => {
    const { app, manager } = buildHarness();
    // stop the manager so the override PUT persists settings without dialing anything
    await manager.stop();
    const initial = await request(app).get("/api/v1/connection/config").expect(200);
    expect(initial.body.override).toBeNull();

    const set = await request(app)
      .put("/api/v1/connection/config")
      .send({ override: { connection: "tcp", tcpHost: "10.0.0.5", tcpPort: 5000 } })
      .expect(200);
    expect(set.body.override.tcpHost).toBe("10.0.0.5");
    expect(set.body.effective.connection).toBe("tcp");

    const cleared = await request(app).put("/api/v1/connection/config").send({ override: null }).expect(200);
    expect(cleared.body.override).toBeNull();
    expect(cleared.body.effective.connection).toBe("none");
  });
});
