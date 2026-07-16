import { describe, expect, it } from "vitest";
import type { Contact, Message, SelfInfo, WsEvent } from "@meshkeep/shared";
import { messagesToCsv } from "../src/api/export.js";
import { ingestContacts, ingestMessages, ingestSelf } from "../src/api/ingest.js";
import { openDb } from "../src/db/index.js";
import { Store } from "../src/db/store.js";
import { Bus } from "../src/bus.js";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    kind: "dm",
    contactKey: "ab".repeat(32),
    contactName: "Alice",
    channelIdx: null,
    channelName: null,
    direction: "out",
    text: "hello",
    senderTimestamp: 1_752_000_000,
    pathLen: null,
    status: "delivered",
    createdAt: 1_752_000_000,
    ...overrides,
  };
}

describe("messagesToCsv", () => {
  it("renders a header and one row per message", () => {
    const csv = messagesToCsv([message()]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("id,kind,direction,counterparty,contact_key,channel_idx,text,sender_time_utc,status");
    expect(lines[1]).toContain("Alice");
    expect(lines[1]).toContain("2025-07-08T"); // senderTimestamp rendered as ISO
  });

  it("escapes quotes, commas, and newlines", () => {
    const csv = messagesToCsv([message({ text: 'say "hi",\nplease' })]);
    expect(csv).toContain('"say ""hi"",\nplease"');
  });

  it("neutralizes spreadsheet formula injection in message text", () => {
    const csv = messagesToCsv([message({ text: "=HYPERLINK(\"http://evil\")" })]);
    expect(csv).toContain("'=HYPERLINK");
    const plain = messagesToCsv([message({ text: "normal text" })]);
    expect(plain).toContain(",normal text,");
  });

  it("falls back to channel labels for channel messages", () => {
    const csv = messagesToCsv([
      message({ kind: "channel", contactKey: null, contactName: null, channelIdx: 2, channelName: null }),
    ]);
    expect(csv).toContain("channel 2");
  });
});

describe("ingest", () => {
  function setup() {
    const db = openDb(":memory:");
    const store = new Store(db);
    const bus = new Bus();
    const events: WsEvent[] = [];
    bus.subscribe((event) => events.push(event));
    return { db, store, bus, events };
  }

  it("dedupes retried ingestion IDs without collapsing repeated messages", () => {
    const { store, bus, events } = setup();
    const items = [
      {
        kind: "dm" as const,
        contactKey: "AB".repeat(32),
        direction: "in" as const,
        text: "from the browser",
        senderTimestamp: 1_752_000_000,
        ingestionId: "00000000-0000-4000-8000-000000000001",
      },
    ];
    expect(ingestMessages(store, bus, items)).toMatchObject({ inserted: 1, duplicates: 0 });
    expect(ingestMessages(store, bus, items)).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(events.filter((e) => e.type === "message.new")).toHaveLength(1);
    // key was normalized to lowercase
    const stored = store.getRecentMessages(5)[0];
    expect(stored.contactKey).toBe("ab".repeat(32));
    expect(stored.ingestionId).toBe(items[0].ingestionId);
    expect((events.find((event) => event.type === "message.new") as Extract<WsEvent, { type: "message.new" }>).message.ingestionId).toBe(
      items[0].ingestionId,
    );

    expect(
      ingestMessages(store, bus, [{ ...items[0], ingestionId: "00000000-0000-4000-8000-000000000002" }]),
    ).toMatchObject({ inserted: 1, duplicates: 0 });
    expect(store.counts().messages).toBe(2);
  });

  it("moves a duplicate's status forward when the re-post carries an ack", () => {
    const { store, bus, events } = setup();
    const base = {
      kind: "dm" as const,
      contactKey: "ab".repeat(32),
      direction: "out" as const,
      text: "sent from browser",
      senderTimestamp: 1_752_000_100,
      ingestionId: "00000000-0000-4000-8000-000000000003",
    };
    const first = ingestMessages(store, bus, [{ ...base, status: "sent" }]);
    expect(first.inserted).toBe(1);
    const id = first.messages[0].id;

    // browser saw the SendConfirmed push after the initial sync-back
    const second = ingestMessages(store, bus, [{ ...base, status: "delivered" }]);
    expect(second).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(store.getMessage(id)?.status).toBe("delivered");
    expect(events.some((e) => e.type === "message.status" && e.id === id && e.status === "delivered")).toBe(true);

    // a delivered message does not regress
    ingestMessages(store, bus, [{ ...base, status: "sent" }]);
    expect(store.getMessage(id)?.status).toBe("delivered");
  });

  it("upserts contacts and self", () => {
    const { store, bus } = setup();
    const contact: Contact = {
      publicKey: "cd".repeat(32),
      name: "Browser Bob",
      type: "chat",
      flags: 0,
      outPathLen: -1,
      lat: null,
      lon: null,
      lastAdvert: 1_752_000_000,
      lastSeen: null,
    };
    expect(ingestContacts(store, bus, [contact])).toBe(1);
    expect(store.getContacts()[0]?.name).toBe("Browser Bob");

    const self: SelfInfo = {
      publicKey: "ef".repeat(32),
      name: "Browser Node",
      type: 1,
      txPower: 20,
      maxTxPower: 22,
      lat: null,
      lon: null,
      radioFreq: 910_525_000,
      radioBw: 250_000,
      radioSf: 10,
      radioCr: 5,
    };
    ingestSelf(store, bus, self);
    expect(store.getSelf()?.name).toBe("Browser Node");
  });
});
