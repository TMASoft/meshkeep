import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildHarness } from "./helpers.js";

function seed(store: ReturnType<typeof buildHarness>["manager"]["store"]) {
  // Reads default to the most-recently-seen radio, so a single seeded radio is
  // what the no-`?radioId` API search queries.
  const radioId = store.resolveRadio("f".repeat(64), "Radio");
  store.insertMessage(radioId, {
    kind: "dm",
    contactKey: "a".repeat(64),
    direction: "in",
    text: "meet at the water tower tomorrow",
    senderTimestamp: 1_000,
  });
  store.insertMessage(radioId, {
    kind: "dm",
    contactKey: "b".repeat(64),
    direction: "out",
    text: "tower checkpoint reached",
    senderTimestamp: 1_001,
  });
  store.insertMessage(radioId, {
    kind: "channel",
    channelIdx: 2,
    direction: "in",
    text: "anyone near the water treatment plant?",
    senderTimestamp: 1_002,
  });
  return radioId;
}

describe("message search", () => {
  it("finds messages by text with a highlighted snippet", async () => {
    const { app, manager } = buildHarness();
    seed(manager.store);
    const res = await request(app).get("/api/v1/messages/search?q=water");
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].snippet).toContain("\x01water\x02");
  });

  it("supports prefix matching on the final term", async () => {
    const { app, manager } = buildHarness();
    seed(manager.store);
    const res = await request(app).get("/api/v1/messages/search?q=tow");
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { text: string }) => r.text).sort()).toEqual([
      "meet at the water tower tomorrow",
      "tower checkpoint reached",
    ]);
  });

  it("filters by contact and channel", async () => {
    const { app, manager } = buildHarness();
    seed(manager.store);
    const byContact = await request(app).get(`/api/v1/messages/search?q=tower&contact=${"b".repeat(64)}`);
    expect(byContact.body.results).toHaveLength(1);
    expect(byContact.body.results[0].direction).toBe("out");
    const byChannel = await request(app).get("/api/v1/messages/search?q=water&channel=2");
    expect(byChannel.body.results).toHaveLength(1);
    expect(byChannel.body.results[0].channelIdx).toBe(2);
  });

  it("never errors on FTS syntax in user input", async () => {
    const { app, manager } = buildHarness();
    seed(manager.store);
    for (const q of ['water AND "', "NEAR(", "a*b(c)", '"unclosed']) {
      const res = await request(app).get(`/api/v1/messages/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
    }
  });

  it("stays in sync when a message row is updated or deleted", async () => {
    const { app, manager } = buildHarness();
    seed(manager.store);
    const db = manager.store["db"] as import("../src/db/index.js").Db;
    db.prepare("UPDATE messages SET text = 'renamed rendezvous' WHERE text LIKE 'meet%'").run();
    db.prepare("DELETE FROM messages WHERE text = 'tower checkpoint reached'").run();
    const gone = await request(app).get("/api/v1/messages/search?q=checkpoint");
    expect(gone.body.results).toHaveLength(0);
    const renamed = await request(app).get("/api/v1/messages/search?q=rendezvous");
    expect(renamed.body.results).toHaveLength(1);
  });
});
