import { describe, expect, it, vi } from "vitest";
import type { Contact } from "@meshkeep/shared";
import {
  contactFromRaw,
  flushQueueOnce,
  ingestItemFromSync,
  INGEST_QUEUE_MAX_BYTES,
  INGEST_QUEUE_MAX_RECORDS,
  INGEST_QUEUE_TTL_MS,
  localMessageFromItem,
  pruneQueue,
  selfInfoFromRaw,
  takePendingAck,
  type IngestQueue,
  type QueueEntry,
  type StoredQueueEntry,
} from "../src/sources/browser-radio-core";

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

describe("selfInfoFromRaw", () => {
  const raw = {
    type: 1,
    txPower: 22,
    maxTxPower: 30,
    publicKey: Uint8Array.from([0xab, 0xcd]),
    advLat: 44_260_000,
    advLon: -72_575_000,
    radioFreq: 910_525,
    radioBw: 250_000,
    radioSf: 10,
    radioCr: 5,
    name: "MyNode",
  };

  it("scales coordinates and hex-encodes the key", () => {
    const self = selfInfoFromRaw(raw, null);
    expect(self.publicKey).toBe("abcd");
    expect(self.lat).toBeCloseTo(44.26);
    expect(self.lon).toBeCloseTo(-72.575);
    expect(self.firmwareVer).toBeNull();
  });

  it("treats zero coordinates as unset and normalizes device text", () => {
    const self = selfInfoFromRaw(
      { ...raw, advLat: 0, advLon: 0 },
      { firmwareVer: 8, firmware_build_date: "1 Jul 2026", manufacturerModel: "RAK\0WisBlock\0" },
    );
    expect(self.lat).toBeNull();
    expect(self.lon).toBeNull();
    expect(self.manufacturerModel).toBe("RAK WisBlock");
  });
});

describe("contactFromRaw", () => {
  it("maps adv types and coordinates", () => {
    const mapped = contactFromRaw({
      publicKey: Uint8Array.from([0x01, 0x02]),
      type: 2,
      flags: 0,
      outPathLen: 3,
      advName: "Repeater One",
      lastAdvert: 42,
      advLat: 44_000_000,
      advLon: 0,
    });
    expect(mapped).toMatchObject({ publicKey: "0102", type: "repeater", lat: 44, lon: null, outPathLen: 3 });
  });
});

describe("ingestItemFromSync", () => {
  const known = contact("aabbccddeeff" + "0".repeat(52), "Alice");

  it("resolves DM contacts by pubkey prefix and preserves unknown prefixes", () => {
    const base = { pathLen: 2, txtType: 0, senderTimestamp: 111, text: "hi" };
    const knownItem = ingestItemFromSync(
      { contactMessage: { ...base, pubKeyPrefix: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]) } },
      [known],
    );
    expect(knownItem).toMatchObject({ kind: "dm", contactKey: known.publicKey, contactPrefix: "aabbccddeeff", pathLen: 2, status: "sent" });
    const unknownItem = ingestItemFromSync(
      { contactMessage: { ...base, pubKeyPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]) } },
      [known],
    );
    expect(unknownItem).toMatchObject({ contactKey: undefined, contactPrefix: "010203040506" });
  });

  it("maps direct-path 0xff to null and carries the signed author prefix", () => {
    const item = ingestItemFromSync(
      {
        contactMessage: {
          pubKeyPrefix: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
          pathLen: 0xff,
          txtType: 2,
          senderTimestamp: 5,
          signedAuthorPrefix: "deadbeef",
          text: "signed post",
        },
      },
      [known],
    );
    expect(item).toMatchObject({ pathLen: null, authorPrefix: "deadbeef" });
  });

  it("maps channel messages and ignores channelData frames", () => {
    const item = ingestItemFromSync(
      { channelMessage: { channelIdx: 3, pathLen: 1, txtType: 0, senderTimestamp: 9, text: "yo" } },
      [],
    );
    expect(item).toMatchObject({ kind: "channel", channelIdx: 3, pathLen: 1 });
    expect(ingestItemFromSync({ channelData: {} }, [])).toBeNull();
  });
});

describe("localMessageFromItem", () => {
  it("synthesizes a private-session message with author resolution", () => {
    const author = contact("deadbeef" + "0".repeat(56), "Author");
    const message = localMessageFromItem(
      {
        kind: "dm",
        contactKey: author.publicKey,
        direction: "in",
        text: "x",
        senderTimestamp: 7,
        authorPrefix: "deadbeef",
        ingestionId: "00000000-0000-4000-8000-000000000007",
      },
      [author],
      -3,
      1_000,
    );
    expect(message).toMatchObject({ id: -3, contactName: "Author", authorName: "Author", createdAt: 1_000 });
  });
});

describe("takePendingAck", () => {
  it("removes and returns only the matching ack", () => {
    const pending = [
      { ackCrc: 1, localId: -1 },
      { ackCrc: 2, localId: -2 },
    ];
    expect(takePendingAck(pending, 2)).toMatchObject({ localId: -2 });
    expect(pending).toHaveLength(1);
    expect(takePendingAck(pending, 99)).toBeNull();
    expect(pending).toHaveLength(1);
  });
});

describe("pruneQueue", () => {
  const entry = (enqueuedAt: number, payload: unknown = 1): StoredQueueEntry => ({
    kind: "self",
    payload,
    enqueuedAt,
  });

  it("drops entries past the 24h TTL but keeps fresher ones", () => {
    const now = 1_000_000;
    const stale = entry(now - INGEST_QUEUE_TTL_MS - 1);
    const fresh = entry(now - 1);
    expect(pruneQueue([stale, fresh], now)).toEqual([fresh]);
  });

  it("FIFO-evicts down to the max record count, keeping the newest", () => {
    const now = 0;
    const entries = Array.from({ length: INGEST_QUEUE_MAX_RECORDS + 5 }, (_, i) => entry(now, i));
    const pruned = pruneQueue(entries, now);
    expect(pruned).toHaveLength(INGEST_QUEUE_MAX_RECORDS);
    expect((pruned[0]!.payload as number)).toBe(5);
    expect((pruned.at(-1)!.payload as number)).toBe(INGEST_QUEUE_MAX_RECORDS + 4);
  });

  it("FIFO-evicts down to the 1 MiB byte cap, oldest first", () => {
    const now = 0;
    const big = "x".repeat(INGEST_QUEUE_MAX_BYTES - 10);
    const entries = [entry(now, big), entry(now, "small-1"), entry(now, "small-2")];
    const pruned = pruneQueue(entries, now);
    // the oversized oldest entry is evicted first; the small ones fit easily
    expect(pruned.map((e) => e.payload)).toEqual(["small-1", "small-2"]);
  });
});

class MemoryQueue implements IngestQueue {
  entries: QueueEntry[] = [];
  async put(entry: QueueEntry) {
    this.entries.push(entry);
  }
  async takeAll() {
    const taken = this.entries;
    this.entries = [];
    return taken;
  }
}

describe("flushQueueOnce", () => {
  it("posts everything oldest-first and empties the queue", async () => {
    const queue = new MemoryQueue();
    await queue.put({ kind: "self", payload: 1 });
    await queue.put({ kind: "messages", payload: 2 });
    const post = vi.fn().mockResolvedValue(undefined);
    await flushQueueOnce(queue, post);
    expect(post.mock.calls.map(([kind]) => kind)).toEqual(["self", "messages"]);
    expect(queue.entries).toHaveLength(0);
  });

  it("re-queues the failed entry AND everything after it, preserving order", async () => {
    const queue = new MemoryQueue();
    await queue.put({ kind: "self", payload: 1 });
    await queue.put({ kind: "messages", payload: 2 });
    await queue.put({ kind: "contacts", payload: 3 });
    const post = vi
      .fn()
      .mockResolvedValueOnce(undefined) // self posts fine
      .mockRejectedValueOnce(new Error("server down")); // messages fails
    await flushQueueOnce(queue, post);
    expect(post).toHaveBeenCalledTimes(2);
    // nothing taken out of the queue was dropped
    expect(queue.entries.map((e) => e.kind)).toEqual(["messages", "contacts"]);
  });
});
