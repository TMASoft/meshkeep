import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildHarness } from "./helpers.js";

const KEY = "c".repeat(64);
const READINGS = [
  { channel: 1, type: 2, label: "Analog input", unit: "V", value: 3.92 },
  { channel: 2, type: 103, label: "Temperature", unit: "°C", value: 21.5 },
];

describe("per-contact telemetry history", () => {
  it("stores remote responses separately from self battery polls", async () => {
    const { app, manager } = buildHarness();
    const store = manager.store;
    store.recordTelemetry(4100);
    store.recordContactTelemetry(KEY, READINGS);

    // self history is unaffected by contact rows
    expect(store.getTelemetry(0)).toHaveLength(1);
    expect(store.latestBatteryMv()).toBe(4100);

    const res = await request(app).get(`/api/v1/contacts/${KEY}/telemetry/history`);
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(1);
    expect(res.body.points[0].readings).toEqual(READINGS);

    const other = await request(app).get(`/api/v1/contacts/${"d".repeat(64)}/telemetry/history`);
    expect(other.body.points).toHaveLength(0);
  });

  it("trims contact telemetry with the same retention window", () => {
    const { manager } = buildHarness();
    const store = manager.store;
    store.recordContactTelemetry(KEY, READINGS);
    const db = store["db"] as import("../src/db/index.js").Db;
    db.prepare("UPDATE telemetry SET ts = ts - 40 * 86400").run();
    expect(store.trimTelemetry(30)).toBe(1);
    expect(store.getContactTelemetry(KEY, 0)).toHaveLength(0);
  });
});
