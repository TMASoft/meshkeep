import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Contact } from "@meshkeep/shared";
import { openDb } from "../src/db/index.js";
import { Store } from "../src/db/store.js";
import { buildHarness } from "./helpers.js";

const contact = (publicKey: string, name: string): Contact => ({
  publicKey,
  name,
  type: "chat",
  flags: 0,
  outPathLen: -1,
  lat: null,
  lon: null,
  lastAdvert: 0,
  lastSeen: null,
});

describe("per-radio data isolation (store)", () => {
  it("keeps contacts, channels, messages and telemetry separate per radio", () => {
    const store = new Store(openDb(":memory:"));
    const r1 = store.resolveRadio("11".repeat(32), "Radio One");
    const r2 = store.resolveRadio("22".repeat(32), "Radio Two");
    const key = "ab".repeat(32); // the same counterparty key exists on both radios

    store.upsertContact(r1, contact(key, "Alice@1"));
    store.upsertContact(r2, contact(key, "Alice@2"));
    store.upsertChannel(r1, { idx: 0, name: "Chan-1", secret: "a".repeat(32) });
    store.upsertChannel(r2, { idx: 0, name: "Chan-2", secret: "b".repeat(32) });
    store.insertMessage(r1, { kind: "dm", contactKey: key, direction: "in", text: "for radio one", senderTimestamp: 1 });
    store.insertMessage(r2, { kind: "dm", contactKey: key, direction: "in", text: "for radio two", senderTimestamp: 1 });
    store.recordTelemetry(r1, 4100);
    store.recordTelemetry(r2, 3800);

    // contacts/channels are keyed by (radio, id) — same key, independent rows
    expect(store.getContacts(r1).map((c) => c.name)).toEqual(["Alice@1"]);
    expect(store.getContacts(r2).map((c) => c.name)).toEqual(["Alice@2"]);
    expect(store.getChannels(r1)[0]?.name).toBe("Chan-1");
    expect(store.getChannels(r2)[0]?.name).toBe("Chan-2");
    // messages never bleed across radios
    expect(store.getConversation(r1, { contactKey: key, limit: 10 }).map((m) => m.text)).toEqual(["for radio one"]);
    expect(store.getConversation(r2, { contactKey: key, limit: 10 }).map((m) => m.text)).toEqual(["for radio two"]);
    expect(store.counts(r1).messages).toBe(1);
    expect(store.counts(r2).messages).toBe(1);
    // telemetry likewise
    expect(store.latestBatteryMv(r1)).toBe(4100);
    expect(store.latestBatteryMv(r2)).toBe(3800);
  });

  it("claims a placeholder radio on first connect so queued work reattaches", () => {
    const store = new Store(openDb(":memory:"));
    // work attributed before any radio was identified
    const placeholder = store.ensurePlaceholderRadio();
    expect(store.getRadio(placeholder)?.publicKey).toBeNull();
    store.insertMessage(placeholder, { kind: "channel", channelIdx: 0, direction: "out", text: "queued", senderTimestamp: 1 });

    // the first real connect adopts the same row rather than creating a new one
    const resolved = store.resolveRadio("33".repeat(32), "Real Radio");
    expect(resolved).toBe(placeholder);
    expect(store.getRadio(resolved)?.publicKey).toBe("33".repeat(32));
    // the queued message now belongs to the real radio
    expect(store.getRecentMessages(resolved, 10).map((m) => m.text)).toEqual(["queued"]);
    // and there is exactly one radio (no orphan placeholder left behind)
    expect(store.listRadios(null)).toHaveLength(1);
  });

  it("purges only the forgotten radio's rows", () => {
    const store = new Store(openDb(":memory:"));
    const r1 = store.resolveRadio("11".repeat(32), "One");
    const r2 = store.resolveRadio("22".repeat(32), "Two");
    store.insertMessage(r1, { kind: "channel", channelIdx: 0, direction: "in", text: "keep", senderTimestamp: 1 });
    store.insertMessage(r2, { kind: "channel", channelIdx: 0, direction: "in", text: "drop", senderTimestamp: 1 });

    expect(store.deleteRadio(r2)).toBe(true);
    expect(store.getRadio(r2)).toBeNull();
    expect(store.counts(r2).messages).toBe(0);
    expect(store.getRecentMessages(r1, 10).map((m) => m.text)).toEqual(["keep"]);
    expect(store.deleteRadio(r2)).toBe(false); // already gone
  });
});

describe("radios API (issue #53)", () => {
  function seededHarness() {
    const harness = buildHarness();
    const store = harness.manager.store;
    const r1 = store.resolveRadio("11".repeat(32), "Radio One");
    const r2 = store.resolveRadio("22".repeat(32), "Radio Two");
    store.upsertContact(r1, contact("ab".repeat(32), "Alice"));
    store.upsertContact(r2, contact("cd".repeat(32), "Bob"));
    return { ...harness, store, r1, r2 };
  }

  it("lists the stored radios", async () => {
    const { app } = seededHarness();
    const res = await request(app).get("/api/v1/radios").expect(200);
    expect(res.body.radios.map((r: { name: string }) => r.name).sort()).toEqual(["Radio One", "Radio Two"]);
  });

  it("filters reads by ?radioId and 404s an unknown radio", async () => {
    const { app, r1, r2 } = seededHarness();
    const one = await request(app).get(`/api/v1/contacts?radioId=${r1}`).expect(200);
    expect(one.body.contacts.map((c: { name: string }) => c.name)).toEqual(["Alice"]);
    const two = await request(app).get(`/api/v1/contacts?radioId=${r2}`).expect(200);
    expect(two.body.contacts.map((c: { name: string }) => c.name)).toEqual(["Bob"]);
    await request(app).get("/api/v1/contacts?radioId=99999").expect(404);
  });

  it("renames a radio", async () => {
    const { app, r1 } = seededHarness();
    await request(app).patch(`/api/v1/radios/${r1}`).send({ name: "Renamed" }).expect(200);
    const res = await request(app).get("/api/v1/radios").expect(200);
    expect(res.body.radios.find((r: { id: number }) => r.id === r1).name).toBe("Renamed");
  });

  it("forgets a radio and purges its data", async () => {
    const { app, r2 } = seededHarness();
    await request(app).delete(`/api/v1/radios/${r2}`).expect(200);
    await request(app).get("/api/v1/radios").expect(200).expect((res) => {
      expect(res.body.radios.map((r: { name: string }) => r.name)).toEqual(["Radio One"]);
    });
    // the radio is gone, so a read scoped to it 404s
    await request(app).get(`/api/v1/contacts?radioId=${r2}`).expect(404);
  });

  it("refuses to forget the active radio", async () => {
    const { app, manager, r1 } = seededHarness();
    (manager as unknown as { activeRadioId: number | null }).activeRadioId = r1;
    await request(app).delete(`/api/v1/radios/${r1}`).expect(409);
  });
});
