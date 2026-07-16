import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildHarness } from "./helpers.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("http: status and health", () => {
  const { app } = buildHarness();

  it("healthz responds outside the versioned api", async () => {
    const res = await request(app).get("/api/healthz").expect(200);
    expect(res.body).toEqual({ ok: true, version: "test" });
  });

  it("reports a sane status while disconnected", async () => {
    const res = await request(app).get("/api/v1/status").expect(200);
    expect(res.body.connection.state).toBe("disconnected");
    expect(res.body.connection.transport).toBe("none");
    expect(res.body.self).toBeNull();
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

describe("http: radio-touching routes 503 while disconnected", () => {
  const { app } = buildHarness();

  it("send dm", async () => {
    const res = await request(app)
      .post("/api/v1/messages")
      .send({ kind: "dm", to: KEY_A, text: "hello" })
      .expect(503);
    expect(res.body.error).toContain("radio is disconnected");
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

describe("http: store-backed reads", () => {
  const { app, manager } = buildHarness();
  const store = manager.store;

  const base = 1_784_000_000;
  store.upsertContact({
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
    store.insertMessage({
      kind: "dm",
      contactKey: KEY_A,
      direction: i % 2 ? "out" : "in",
      text: `dm ${i}`,
      senderTimestamp: base + i,
      status: "sent",
    });
  }
  store.insertMessage({
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
    expect(store.counts().unread).toBe(1); // only the channel message remains unread
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
    store.recordTelemetry(4100);
    const res = await request(app).get("/api/v1/telemetry?hours=1").expect(200);
    expect(res.body.points).toHaveLength(1);
    expect(res.body.points[0].batteryMv).toBe(4100);
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
    };
    const first = await request(app).post("/api/v1/ingest/messages").send({ messages: [message] }).expect(200);
    expect(first.body.inserted).toBe(1);
    const again = await request(app).post("/api/v1/ingest/messages").send({ messages: [message] }).expect(200);
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
    await request(app).post("/api/v1/ingest/messages").send({ messages }).expect(400);
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
