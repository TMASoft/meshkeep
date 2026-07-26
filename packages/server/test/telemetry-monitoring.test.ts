import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildHarness } from "./helpers.js";

const CONTACT_A = "a".repeat(64);
const CONTACT_B = "b".repeat(64);

describe("telemetry monitors", () => {
  it("adds, lists, and removes a monitored contact", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");

    expect(store.listMonitors(radioId)).toHaveLength(0);
    store.addMonitor(radioId, CONTACT_A);
    store.addMonitor(radioId, CONTACT_B);
    expect(store.listMonitors(radioId).map((m) => m.contactKey).sort()).toEqual([CONTACT_A, CONTACT_B].sort());

    // adding the same contact twice does not duplicate it
    store.addMonitor(radioId, CONTACT_A);
    expect(store.listMonitors(radioId)).toHaveLength(2);

    store.removeMonitor(radioId, CONTACT_A);
    expect(store.listMonitors(radioId).map((m) => m.contactKey)).toEqual([CONTACT_B]);
  });

  it("picks the never-polled contact before any that already have a sample", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.addMonitor(radioId, CONTACT_A);
    store.addMonitor(radioId, CONTACT_B);

    // A has been polled once, B never has — B is due first regardless of A's age.
    store.recordContactTelemetry(radioId, CONTACT_A, [{ channel: 1, type: 2, label: "Analog", unit: "V", value: 3.3 }]);
    expect(store.nextDueMonitor(radioId)).toBe(CONTACT_B);

    // once B also has a sample, the older of the two (A) becomes due again.
    store.recordContactTelemetry(radioId, CONTACT_B, [{ channel: 1, type: 2, label: "Analog", unit: "V", value: 3.3 }]);
    expect(store.nextDueMonitor(radioId)).toBe(CONTACT_A);
  });

  it("returns null when nothing is monitored", () => {
    const { manager } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");
    expect(manager.store.nextDueMonitor(radioId)).toBeNull();
  });

  it("round-trips through the monitor toggle routes", async () => {
    const { app, manager } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");

    const before = await request(app).get(`/api/v1/contacts/${CONTACT_A}/telemetry/monitor?radioId=${radioId}`);
    expect(before.body.monitored).toBe(false);

    const added = await request(app).post(`/api/v1/contacts/${CONTACT_A}/telemetry/monitor?radioId=${radioId}`);
    expect(added.status).toBe(201);

    const after = await request(app).get(`/api/v1/contacts/${CONTACT_A}/telemetry/monitor?radioId=${radioId}`);
    expect(after.body.monitored).toBe(true);

    const list = await request(app).get(`/api/v1/telemetry/monitors?radioId=${radioId}`);
    expect(list.body.monitors).toHaveLength(1);
    expect(list.body.monitors[0].contactKey).toBe(CONTACT_A);

    await request(app).delete(`/api/v1/contacts/${CONTACT_A}/telemetry/monitor?radioId=${radioId}`);
    const removed = await request(app).get(`/api/v1/contacts/${CONTACT_A}/telemetry/monitor?radioId=${radioId}`);
    expect(removed.body.monitored).toBe(false);
  });
});

describe("telemetry alert rules", () => {
  it("fires a breach once, does not re-fire while sustained, then fires a recovery", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.addAlertRule(radioId, { contactKey: null, metric: "battery_mv", comparator: "below", threshold: 3500 });

    const firstBreach = store.evaluateAlerts(radioId, null, [{ metric: "battery_mv", label: "Battery", value: 3000 }]);
    expect(firstBreach).toHaveLength(1);
    expect(firstBreach[0]).toMatchObject({ direction: "breach", value: 3000, threshold: 3500 });

    // still below threshold on the next sample — must not fire again
    const stillBreached = store.evaluateAlerts(radioId, null, [{ metric: "battery_mv", label: "Battery", value: 2900 }]);
    expect(stillBreached).toHaveLength(0);

    const recovered = store.evaluateAlerts(radioId, null, [{ metric: "battery_mv", label: "Battery", value: 3600 }]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ direction: "recover", value: 3600 });

    // history keeps both transitions
    expect(store.listAlertEvents(radioId, 0)).toHaveLength(2);
  });

  it("scopes rules to a specific contact and metric, resolving the contact's name", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.upsertContact(radioId, {
      publicKey: CONTACT_A,
      name: "Basecamp",
      type: "chat",
      flags: 0,
      outPathLen: -1,
      lat: null,
      lon: null,
      lastAdvert: 0,
      lastSeen: null,
    });
    store.addAlertRule(radioId, { contactKey: CONTACT_A, metric: "3:103", comparator: "above", threshold: 30 });

    // an own-node battery sample must not trigger a contact-scoped rule
    expect(store.evaluateAlerts(radioId, null, [{ metric: "3:103", label: "Temperature", value: 40 }])).toHaveLength(0);

    const fired = store.evaluateAlerts(radioId, CONTACT_A, [{ metric: "3:103", label: "Temperature", value: 40 }]);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ contactKey: CONTACT_A, contactName: "Basecamp", metric: "3:103" });
  });

  it("round-trips through the alert rule CRUD and history routes", async () => {
    const { app, manager } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");

    const created = await request(app)
      .post(`/api/v1/telemetry/alerts/rules?radioId=${radioId}`)
      .send({ contactKey: null, metric: "battery_mv", comparator: "below", threshold: 3400 });
    expect(created.status).toBe(201);
    const ruleId = created.body.rule.id;

    const listed = await request(app).get(`/api/v1/telemetry/alerts/rules?radioId=${radioId}`);
    expect(listed.body.rules).toHaveLength(1);

    manager.store.evaluateAlerts(radioId, null, [{ metric: "battery_mv", label: "Battery", value: 3000 }]);
    const events = await request(app).get(`/api/v1/telemetry/alerts?radioId=${radioId}`);
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0].direction).toBe("breach");

    const removed = await request(app).delete(`/api/v1/telemetry/alerts/rules/${ruleId}?radioId=${radioId}`);
    expect(removed.status).toBe(200);
    const afterRemove = await request(app).get(`/api/v1/telemetry/alerts/rules?radioId=${radioId}`);
    expect(afterRemove.body.rules).toHaveLength(0);
  });
});

describe("telemetry export", () => {
  it("flattens own-node battery and numeric contact readings, skipping non-numeric ones", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    const radioId = store.resolveRadio("f".repeat(64), "Radio");
    store.recordTelemetry(radioId, 4100);
    store.recordContactTelemetry(radioId, CONTACT_A, [
      { channel: 1, type: 2, label: "Analog input", unit: "V", value: 3.92 },
      { channel: 4, type: 136, label: "GPS", unit: null, value: { lat: 1, lon: 2, alt: 3 } },
    ]);

    const rows = store.exportTelemetry(radioId, 0);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.contactKey === null)).toMatchObject({ metric: "battery_mv", value: 4100, unit: "mV" });
    expect(rows.find((r) => r.contactKey === CONTACT_A)).toMatchObject({ metric: "1:2", value: 3.92, unit: "V" });
  });

  it("serves CSV and JSON downloads with the expected headers", async () => {
    const { app, manager } = buildHarness();
    const radioId = manager.store.resolveRadio("f".repeat(64), "Radio");
    manager.store.recordTelemetry(radioId, 4100);

    const csv = await request(app).get(`/api/v1/telemetry/export?format=csv&radioId=${radioId}`);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text.split("\r\n")[0]).toBe("ts_utc,contact_key,contact_name,metric,label,value,unit");
    expect(csv.text).toContain("battery_mv");

    const json = await request(app).get(`/api/v1/telemetry/export?format=json&radioId=${radioId}`);
    expect(json.status).toBe(200);
    expect(json.body.samples).toHaveLength(1);
    expect(json.body.samples[0]).toMatchObject({ metric: "battery_mv", value: 4100 });
  });
});
