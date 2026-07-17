import { describe, expect, it } from "vitest";
import type { Contact, Message, SelfInfo, WsEvent } from "@meshkeep/shared";
import { csvHeaderRow, messageToCsvRow, messagesToCsv } from "../src/api/export.js";
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

  it("composes the same output from the streaming header and per-row helpers", () => {
    const list = [message(), message({ id: 2, text: "=DANGER,formula" })];
    const streamed = csvHeaderRow() + list.map(messageToCsvRow).join("");
    expect(streamed).toBe(messagesToCsv(list));
    // formula neutralization is preserved on the per-row path used by streaming
    expect(list.map(messageToCsvRow).join("")).toContain("\"'=DANGER,formula\"");
  });
});

describe("streaming message export", () => {
  it("yields the full history oldest-first, matching the buffered export", () => {
    const store = new Store(openDb(":memory:"));
    const count = 500;
    for (let i = 0; i < count; i++) {
      store.insertMessage({ kind: "channel", channelIdx: 1, direction: "in", text: `m${i}`, senderTimestamp: 1_000 + i });
    }

    const streamed = [...store.iterateMessagesForExport({ channelIdx: 1 })];
    expect(streamed).toHaveLength(count);
    expect(streamed[0]!.text).toBe("m0");
    expect(streamed.at(-1)!.text).toBe(`m${count - 1}`);
    for (let i = 1; i < streamed.length; i++) {
      expect(streamed[i]!.id).toBeGreaterThan(streamed[i - 1]!.id); // ascending id order
    }
    // the buffered convenience wrapper returns the identical sequence
    expect(store.getMessagesForExport({ channelIdx: 1 }).map((m) => m.id)).toEqual(streamed.map((m) => m.id));
  });

  it("finalizes the statement cleanly when the consumer stops early", () => {
    const store = new Store(openDb(":memory:"));
    for (let i = 0; i < 10; i++) {
      store.insertMessage({ kind: "channel", channelIdx: 2, direction: "in", text: `x${i}`, senderTimestamp: i });
    }

    const iterator = store.iterateMessagesForExport({ channelIdx: 2 });
    expect(iterator.next().value?.text).toBe("x0");
    // abandoning mid-stream (as a disconnecting client does) must not throw
    expect(() => iterator.return(undefined)).not.toThrow();
    // and the store stays usable — the SQLite iterator was released
    expect(store.getMessagesForExport({ channelIdx: 2 })).toHaveLength(10);
  });
});

describe("author-prefix attribution", () => {
  const prefix = "deadbeef";
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

  function setup() {
    const store = new Store(openDb(":memory:"));
    store.upsertContact(contact(`${prefix}${"a".repeat(56)}`, "Alice"));
    store.insertMessage({
      kind: "channel",
      channelIdx: 1,
      direction: "in",
      text: "signed room post",
      senderTimestamp: 1_000,
      authorPrefix: prefix,
    });
    return store;
  }

  it("resolves the author name when the prefix matches exactly one contact", () => {
    const store = setup();
    const messages = store.getConversation({ channelIdx: 1, limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.authorName).toBe("Alice");
  });

  it("returns one unattributed row per message when the prefix is ambiguous", () => {
    const store = setup();
    store.upsertContact(contact(`${prefix}${"b".repeat(56)}`, "Mallory"));

    const conversation = store.getConversation({ channelIdx: 1, limit: 10 });
    expect(conversation).toHaveLength(1); // never duplicated by the collision
    expect(conversation[0]!.authorName).toBeNull(); // never guessed either

    expect(store.getRecentMessages(10)).toHaveLength(1);
    expect(store.getMessagesForExport({ channelIdx: 1 })).toHaveLength(1);
    const results = store.searchMessages({ query: "signed", limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]!.authorName).toBeNull();
    expect(store.counts().messages).toBe(1);
  });
});

describe("contact reconciliation", () => {
  const KEY_A = "a".repeat(64);
  const KEY_B = "b".repeat(64);
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

  it("syncContacts mirrors the radio list without orphaning message history", () => {
    const store = new Store(openDb(":memory:"));
    store.syncContacts([contact(KEY_A, "Alice"), contact(KEY_B, "Bob")]);
    store.insertMessage({ kind: "dm", contactKey: KEY_A, direction: "in", text: "hi", senderTimestamp: 1 });

    // Alice was removed on the radio elsewhere; the next full scan omits her
    const { removed } = store.syncContacts([contact(KEY_B, "Bob v2")]);

    expect(removed).toEqual([KEY_A]);
    expect(store.getContacts().map((c) => c.name)).toEqual(["Bob v2"]);
    // her history keeps its identity and stays queryable
    const history = store.getConversation({ contactKey: KEY_A, limit: 10 });
    expect(history).toHaveLength(1);
    expect(history[0]!.text).toBe("hi");
  });

  it("touchContactSeen reports a missing contact instead of losing the update", () => {
    const store = new Store(openDb(":memory:"));
    // newly discovered advert: the contact is not stored yet
    expect(store.touchContactSeen(KEY_A)).toBeNull();
    // after the contact list sync the touch lands and returns the row
    store.syncContacts([contact(KEY_A, "Alice")]);
    const touched = store.touchContactSeen(KEY_A);
    expect(touched?.publicKey).toBe(KEY_A);
    expect(touched?.lastSeen).toBeGreaterThan(0);
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
