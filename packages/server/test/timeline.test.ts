import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Contact } from "@meshkeep/shared";
import { buildHarness } from "./helpers.js";

const CONTACT_A = "a".repeat(64);
const CONTACT_B = "b".repeat(64);

function contact(publicKey: string, name: string, overrides: Partial<Contact> = {}): Contact {
  return {
    publicKey,
    name,
    type: "chat",
    flags: 0,
    outPathLen: -1,
    lat: null,
    lon: null,
    lastAdvert: 100,
    lastSeen: null,
    ...overrides,
  };
}

describe("timeline store", () => {
  it("round-trips adverts and link events with source-prefixed ids in ascending order", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");

    const advert = store.recordAdvert(radioId, contact(CONTACT_A, "Basecamp", { lat: 45.5, lon: -122.6 }), "new");
    expect(advert.id).toMatch(/^adv:\d+$/);
    expect(advert.kind).toBe("advert");

    const link = store.recordLinkEvent(radioId, { state: "connected", transport: "tcp", label: "default", error: null });
    expect(link.id).toMatch(/^lnk:\d+$/);

    const { events, truncated } = store.getTimeline([radioId], 0, Math.floor(Date.now() / 1000) + 10, ["advert", "link"], 100);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind).sort()).toEqual(["advert", "link"]);
    const stored = events.find((e) => e.kind === "advert");
    if (stored?.kind !== "advert") throw new Error("advert event missing");
    // the advert row is a snapshot of the contact as advertised
    expect(stored.advert).toMatchObject({ contactKey: CONTACT_A, name: "Basecamp", lat: 45.5, lon: -122.6, observed: "new" });
  });

  it("merges derived message, alert, and telemetry events with stored ones and filters by kind", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.upsertContact(radioId, contact(CONTACT_A, "Basecamp"));

    store.recordAdvert(radioId, contact(CONTACT_A, "Basecamp"), "seen");
    store.insertMessage(radioId, {
      kind: "dm",
      contactKey: CONTACT_A,
      direction: "in",
      text: "hello from basecamp with a longer text body",
      senderTimestamp: 1000,
    });
    store.addAlertRule(radioId, { contactKey: null, metric: "battery_mv", comparator: "below", threshold: 3500 });
    store.evaluateAlerts(radioId, null, [{ metric: "battery_mv", label: "Battery", value: 3000 }]);
    store.recordTelemetry(radioId, 4100);

    const to = Math.floor(Date.now() / 1000) + 10;
    // default-style kinds: everything except telemetry
    const feed = store.getTimeline([radioId], 0, to, ["advert", "message", "alert", "link"], 100);
    expect(feed.events.map((e) => e.kind).sort()).toEqual(["advert", "alert", "message"]);
    const message = feed.events.find((e) => e.kind === "message");
    if (message?.kind !== "message") throw new Error("message event missing");
    expect(message.message).toMatchObject({ messageKind: "dm", direction: "in", contactKey: CONTACT_A, contactName: "Basecamp" });
    expect(message.message.preview).toContain("hello from basecamp");

    // telemetry appears only when its kind is requested
    const withTelemetry = store.getTimeline([radioId], 0, to, ["telemetry"], 100);
    expect(withTelemetry.events).toHaveLength(1);
    const sample = withTelemetry.events[0];
    if (sample.kind !== "telemetry") throw new Error("telemetry event missing");
    expect(sample.telemetry).toMatchObject({ contactKey: null, batteryMv: 4100 });

    // ascending ts ordering across sources
    const all = store.getTimeline([radioId], 0, to, ["advert", "message", "alert", "link", "telemetry"], 100);
    const stamps = all.events.map((e) => e.ts);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("isolates radios and merges multiple when asked", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioA = store.resolveRadio("f".repeat(64), "Alpha");
    const radioB = store.resolveRadio("e".repeat(64), "Bravo");
    store.recordAdvert(radioA, contact(CONTACT_A, "A-node"), "new");
    store.recordAdvert(radioB, contact(CONTACT_B, "B-node"), "new");

    const to = Math.floor(Date.now() / 1000) + 10;
    const onlyA = store.getTimeline([radioA], 0, to, ["advert"], 100);
    expect(onlyA.events).toHaveLength(1);
    expect(onlyA.events[0].radioId).toBe(radioA);

    const both = store.getTimeline([radioA, radioB], 0, to, ["advert"], 100);
    expect(both.events).toHaveLength(2);
    expect(new Set(both.events.map((e) => e.radioId))).toEqual(new Set([radioA, radioB]));
  });

  it("caps the merged feed and reports truncation", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    for (let i = 0; i < 7; i++) {
      store.recordLinkEvent(radioId, { state: "connected", transport: "tcp", label: `l${i}`, error: null });
    }
    const { events, truncated } = store.getTimeline([radioId], 0, Math.floor(Date.now() / 1000) + 10, ["link"], 5);
    expect(events).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it("trims only rows older than the retention window", () => {
    const { manager, db } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.recordLinkEvent(radioId, { state: "connected", transport: "tcp", label: "fresh", error: null });
    const old = Math.floor(Date.now() / 1000) - 100 * 86_400;
    db.prepare("INSERT INTO timeline_events (radio_id, kind, ts, payload_json) VALUES (?, 'link', ?, '{}')").run(radioId, old);

    expect(store.trimTimeline(90)).toBe(1);
    const { events } = store.getTimeline([radioId], 0, Math.floor(Date.now() / 1000) + 10, ["link"], 100);
    expect(events).toHaveLength(1);
    expect(events[0].kind === "link" && events[0].link.label).toBe("fresh");
  });

  it("deleteRadio purges timeline and telemetry-monitoring rows", () => {
    const { manager, db } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.recordAdvert(radioId, contact(CONTACT_A, "Basecamp"), "new");
    store.addMonitor(radioId, CONTACT_A);
    store.addAlertRule(radioId, { contactKey: null, metric: "battery_mv", comparator: "below", threshold: 3500 });
    store.evaluateAlerts(radioId, null, [{ metric: "battery_mv", label: "Battery", value: 3000 }]);

    expect(store.deleteRadio(radioId)).toBe(true);
    for (const table of ["timeline_events", "telemetry_monitors", "telemetry_alert_rules", "telemetry_alert_events"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE radio_id = ?`).get(radioId) as { n: number };
      expect(row.n, table).toBe(0);
    }
  });
});

describe("timeline overview", () => {
  const BASE = 1_700_000_000;

  it("buckets the whole stored extent and reports it", () => {
    const { manager, db } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    const insert = db.prepare("INSERT INTO timeline_events (radio_id, kind, ts, payload_json) VALUES (?, 'link', ?, '{}')");
    for (const offset of [0, 3600, 7200]) insert.run(radioId, BASE + offset);

    const overview = store.getTimelineOverview([radioId], ["link"], 3);
    expect(overview.from).toBe(BASE);
    expect(overview.to).toBe(BASE + 7200);
    expect(overview.bucketSecs).toBe(2400);
    expect(overview.total).toBe(3);
    expect(overview.buckets).toEqual([
      { ts: BASE, counts: { link: 1 } },
      { ts: BASE + 2400, counts: { link: 1 } },
      { ts: BASE + 7200, counts: { link: 1 } },
    ]);
  });

  it("counts each kind separately, merges radios, and honours the kind filter", () => {
    const { manager, db } = buildHarness();
    const store = manager.store;
    const radioA = store.resolveRadio("f".repeat(64), "Alpha");
    const radioB = store.resolveRadio("e".repeat(64), "Bravo");
    db.prepare("INSERT INTO timeline_events (radio_id, kind, ts, payload_json) VALUES (?, 'advert', ?, '{}')").run(radioA, BASE);
    db.prepare("INSERT INTO timeline_events (radio_id, kind, ts, payload_json) VALUES (?, 'link', ?, '{}')").run(radioA, BASE);
    db.prepare("INSERT INTO timeline_events (radio_id, kind, ts, payload_json) VALUES (?, 'advert', ?, '{}')").run(radioB, BASE);

    const both = store.getTimelineOverview([radioA, radioB], ["advert", "link"], 10);
    expect(both.total).toBe(3);
    expect(both.buckets).toEqual([{ ts: BASE, counts: { advert: 2, link: 1 } }]);

    // filtering by kind drops the other source entirely
    const advertsOnly = store.getTimelineOverview([radioA, radioB], ["advert"], 10);
    expect(advertsOnly.total).toBe(2);
    expect(advertsOnly.buckets).toEqual([{ ts: BASE, counts: { advert: 2 } }]);

    // and radios stay isolated
    expect(store.getTimelineOverview([radioB], ["advert", "link"], 10).total).toBe(1);
  });

  it("picks up derived message, alert, and telemetry rows", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.upsertContact(radioId, contact(CONTACT_A, "Basecamp"));
    store.insertMessage(radioId, { kind: "dm", contactKey: CONTACT_A, direction: "in", text: "hi", senderTimestamp: 1000 });
    store.addAlertRule(radioId, { contactKey: null, metric: "battery_mv", comparator: "below", threshold: 3500 });
    store.evaluateAlerts(radioId, null, [{ metric: "battery_mv", label: "Battery", value: 3000 }]);
    store.recordTelemetry(radioId, 4100);

    const overview = store.getTimelineOverview([radioId], ["message", "alert", "telemetry"], 240);
    expect(overview.total).toBe(3);
    const counts = overview.buckets.reduce<Record<string, number>>((acc, bucket) => {
      for (const [kind, n] of Object.entries(bucket.counts)) acc[kind] = (acc[kind] ?? 0) + n;
      return acc;
    }, {});
    expect(counts).toEqual({ message: 1, alert: 1, telemetry: 1 });
  });

  it("returns an empty summary when there is nothing stored", () => {
    const { manager } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");
    expect(manager.store.getTimelineOverview([radioId], ["advert", "link"], 240)).toEqual({
      from: 0,
      to: 0,
      bucketSecs: 0,
      buckets: [],
      total: 0,
    });
    // no radios or no kinds is the same empty answer, not a crash
    expect(manager.store.getTimelineOverview([], ["advert"], 240).total).toBe(0);
    expect(manager.store.getTimelineOverview([radioId], [], 240).total).toBe(0);
  });

  it("keeps a single-instant history bucketable", () => {
    const { manager, db } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");
    const insert = db.prepare("INSERT INTO timeline_events (radio_id, kind, ts, payload_json) VALUES (?, 'link', ?, '{}')");
    insert.run(radioId, BASE);
    insert.run(radioId, BASE);

    const overview = manager.store.getTimelineOverview([radioId], ["link"], 240);
    expect(overview.from).toBe(BASE);
    expect(overview.to).toBe(BASE);
    expect(overview.bucketSecs).toBe(1);
    expect(overview.buckets).toEqual([{ ts: BASE, counts: { link: 2 } }]);
  });
});

describe("timeline overview route", () => {
  it("serves the summary and excludes telemetry by default", async () => {
    const { app, manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.recordAdvert(radioId, contact(CONTACT_A, "A-node"), "new");
    store.recordTelemetry(radioId, 4100);

    const res = await request(app).get(`/api/v1/timeline/overview?radioIds=${radioId}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.buckets[0].counts).toEqual({ advert: 1 });

    const withTelemetry = await request(app).get(`/api/v1/timeline/overview?radioIds=${radioId}&kinds=advert,telemetry`);
    expect(withTelemetry.body.total).toBe(2);
  });

  it("falls back to the default radio and validates its inputs", async () => {
    const { app, manager } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");
    manager.store.recordAdvert(radioId, contact(CONTACT_A, "A-node"), "new");

    expect((await request(app).get("/api/v1/timeline/overview")).body.total).toBe(1);
    expect((await request(app).get("/api/v1/timeline/overview?kinds=bogus")).status).toBe(400);
    expect((await request(app).get("/api/v1/timeline/overview?buckets=1")).status).toBe(400);
    expect((await request(app).get("/api/v1/timeline/overview?radioIds=9999")).status).toBe(404);
  });
});

describe("timeline route", () => {
  it("serves a merged multi-radio feed", async () => {
    const { app, manager } = buildHarness();
    const store = manager.store;
    const radioA = store.resolveRadio("f".repeat(64), "Alpha");
    const radioB = store.resolveRadio("e".repeat(64), "Bravo");
    store.recordAdvert(radioA, contact(CONTACT_A, "A-node"), "new");
    store.recordAdvert(radioB, contact(CONTACT_B, "B-node"), "new");
    store.recordTelemetry(radioA, 4100);

    const to = Math.floor(Date.now() / 1000) + 10;
    const res = await request(app).get(`/api/v1/timeline?radioIds=${radioA},${radioB}&from=0&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    // telemetry is excluded by default
    expect(res.body.events).toHaveLength(2);
    expect(new Set(res.body.events.map((e: { radioId: number }) => e.radioId))).toEqual(new Set([radioA, radioB]));

    const withTelemetry = await request(app).get(`/api/v1/timeline?radioIds=${radioA}&from=0&to=${to}&kinds=advert,telemetry`);
    expect(withTelemetry.body.events).toHaveLength(2);
  });

  it("falls back to the default radio when radioIds is omitted", async () => {
    const { app, manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.recordAdvert(radioId, contact(CONTACT_A, "A-node"), "new");

    const to = Math.floor(Date.now() / 1000) + 10;
    const res = await request(app).get(`/api/v1/timeline?from=0&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });

  it("rejects malformed and unknown inputs", async () => {
    const { app, manager } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");

    expect((await request(app).get(`/api/v1/timeline?from=100&to=100&radioIds=${radioId}`)).status).toBe(400);
    expect((await request(app).get(`/api/v1/timeline?from=0&to=100&radioIds=1;2`)).status).toBe(400);
    expect((await request(app).get(`/api/v1/timeline?from=0&to=100&radioIds=${radioId}&kinds=bogus`)).status).toBe(400);
    expect((await request(app).get("/api/v1/timeline?from=0&to=100&radioIds=9999")).status).toBe(404);
  });
});
