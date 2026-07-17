import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, Message, SelfInfo } from "@meshkeep/shared";
import Constants from "@liamcottle/meshcore.js/src/constants.js";
import { BrowserRadioSource, type BrowserRadioCallbacks } from "../src/sources/browser-radio";
import type { IngestQueue, QueueEntry } from "../src/sources/browser-radio-core";

/** Minimal fake of the meshcore.js connection surface the source drives. */
class FakeConnection {
  listeners = new Map<string | number, ((...args: unknown[]) => void)[]>();
  closed = false;
  queuedSyncMessages: unknown[] = [];
  sentTexts: { key: Uint8Array; text: string; type: number }[] = [];
  sentChannelTexts: { idx: number; text: string }[] = [];
  nextAckCrc = 7777;
  nextAckTimeout = 5000;
  emitAckBeforeResponse = false;
  onContactMsgRecvResponse: unknown = null; // assigned by patchSignedPlain

  on(event: string | number, callback: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
  }
  once(event: string | number, callback: (...args: unknown[]) => void) {
    const wrapper = (...args: unknown[]) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== wrapper),
      );
      callback(...args);
    };
    this.on(event, wrapper);
  }
  off(event: string | number, callback: (...args: unknown[]) => void) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== callback),
    );
  }
  emit(event: string | number, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  async close() {
    this.closed = true;
  }
  async getSelfInfo() {
    return {
      type: 1,
      txPower: 22,
      maxTxPower: 30,
      publicKey: Uint8Array.from([0xab]),
      advLat: 0,
      advLon: 0,
      radioFreq: 910_525,
      radioBw: 250_000,
      radioSf: 10,
      radioCr: 5,
      name: "FakeNode",
    };
  }
  async deviceQuery() {
    return { firmwareVer: 8, firmware_build_date: "1 Jul 2026", manufacturerModel: "Fake\0Board" };
  }
  async getContacts() {
    return [
      {
        publicKey: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
        type: 1,
        flags: 0,
        outPathLen: -1,
        outPath: Uint8Array.of(),
        advName: "Alice",
        lastAdvert: 1,
        advLat: 0,
        advLon: 0,
        lastMod: 1,
      },
    ];
  }
  async syncNextMessage() {
    return this.queuedSyncMessages.shift() ?? null;
  }
  async getBatteryVoltage() {
    return { batteryMilliVolts: 4111 };
  }
  async sendTextMessage(key: Uint8Array, text: string, type: number) {
    this.sentTexts.push({ key, text, type });
    if (this.emitAckBeforeResponse) {
      this.emit(Constants.PushCodes.SendConfirmed, { ackCode: this.nextAckCrc, roundTrip: 0 });
    }
    return { result: 0, expectedAckCrc: this.nextAckCrc, estTimeout: this.nextAckTimeout };
  }
  async sendChannelTextMessage(idx: number, text: string) {
    this.sentChannelTexts.push({ idx, text });
  }
  async sendFloodAdvert() {}
  async sendZeroHopAdvert() {}
  channelSlots: { channelIdx: number; name: string; secret: Uint8Array }[] = [];
  async sendCommandGetChannel(idx: number) {
    const slot = this.channelSlots.find((c) => c.channelIdx === idx) ?? {
      channelIdx: idx,
      name: "", // unset slot
      secret: new Uint8Array(16),
    };
    queueMicrotask(() => this.emit(Constants.ResponseCodes.ChannelInfo, slot));
  }
}

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

interface Harness {
  source: BrowserRadioSource;
  connection: FakeConnection;
  queue: MemoryQueue;
  states: { state: ConnectionState; error: string | null }[];
  localMessages: Message[];
  localStatuses: { id: number; status: Message["status"] }[];
  syncedMessages: Message[];
  selves: SelfInfo[];
  batteries: number[];
  posts: { kind: string; payload: unknown }[];
  postIngest: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
}

function harness(opts: { privateSession?: boolean; postFails?: boolean } = {}): Harness {
  const connection = new FakeConnection();
  const queue = new MemoryQueue();
  const states: Harness["states"] = [];
  const localMessages: Message[] = [];
  const localStatuses: Harness["localStatuses"] = [];
  const syncedMessages: Message[] = [];
  const selves: SelfInfo[] = [];
  const batteries: number[] = [];
  const posts: Harness["posts"] = [];
  const releaseLock = vi.fn();
  const postIngest = vi.fn(async (kind: string, payload: unknown) => {
    if (opts.postFails) throw new Error("server unreachable");
    posts.push({ kind, payload });
    if (kind === "messages") {
      const { messages } = payload as { messages: unknown[] };
      return { messages: messages.map((item, i) => ({ ...(item as object), id: 100 + i })) };
    }
    return {};
  });
  const callbacks: BrowserRadioCallbacks = {
    onState: (state, error) => states.push({ state, error }),
    onLocalMessage: (message) => localMessages.push(message),
    onLocalStatus: (id, status) => localStatuses.push({ id, status }),
    onSyncedMessage: (message) => syncedMessages.push(message),
    onSelf: (self) => selves.push(self),
    onBattery: (mv) => batteries.push(mv),
  };
  const source = new BrowserRadioSource("webserial", opts.privateSession ?? false, callbacks, {
    async openConnection() {
      // the real transports resolve before the app-start handshake completes;
      // fire "connected" once waitForConnected has subscribed
      setTimeout(() => connection.emit("connected"), 0);
      return connection as never;
    },
    acquireLock: async () => releaseLock,
    queue,
    postIngest: postIngest as never,
  });
  return {
    source,
    connection,
    queue,
    states,
    localMessages,
    localStatuses,
    syncedMessages,
    selves,
    batteries,
    posts,
    postIngest,
    releaseLock,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("BrowserRadioSource lifecycle", () => {
  it("walks connecting → syncing → connected and syncs self/contacts back", async () => {
    const h = harness();
    await h.source.start();
    expect(h.states.map((s) => s.state)).toEqual(["connecting", "syncing", "connected"]);
    expect(h.selves[0]).toMatchObject({ name: "FakeNode", manufacturerModel: "Fake Board" });
    expect(h.batteries).toEqual([4111]);
    expect(h.posts.map((p) => p.kind)).toEqual(["self", "contacts"]);
    await h.source.stop();
  });

  it("getChannels reads the radio's live channel slots and skips unset ones", async () => {
    const h = harness();
    h.connection.channelSlots = [
      { channelIdx: 0, name: "Public", secret: new Uint8Array(16).fill(0x11) },
      { channelIdx: 3, name: "Ops", secret: new Uint8Array(16).fill(0x22) },
    ];
    await h.source.start();
    const channels = await h.source.getChannels();
    expect(channels).toEqual([
      { idx: 0, name: "Public", secret: "11".repeat(16) },
      { idx: 3, name: "Ops", secret: "22".repeat(16) },
    ]);
    await h.source.stop();
  });

  it("stop() closes the connection, releases the lock, and reports disconnected", async () => {
    const h = harness();
    await h.source.start();
    await h.source.stop();
    expect(h.connection.closed).toBe(true);
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toEqual({ state: "disconnected", error: null });
  });

  it("a device-side disconnect tears down and surfaces an error state", async () => {
    const h = harness();
    await h.source.start();
    h.connection.emit("disconnected");
    await vi.waitFor(() => {
      expect(h.states.at(-1)).toEqual({ state: "error", error: "Radio disconnected" });
    });
    expect(h.releaseLock).toHaveBeenCalled();
  });

  it("start() failure (no device picked) cleans up and rethrows", async () => {
    const h = harness();
    const source = new BrowserRadioSource("webserial", false, {
      onState: (state, error) => h.states.push({ state, error }),
      onLocalMessage: () => {},
      onLocalStatus: () => {},
      onSyncedMessage: () => {},
      onSelf: () => {},
      onBattery: () => {},
    }, {
      openConnection: async () => null,
      acquireLock: async () => h.releaseLock,
      queue: h.queue,
      postIngest: h.postIngest as never,
    });
    await expect(source.start()).rejects.toThrow("No device selected");
    expect(h.releaseLock).toHaveBeenCalled();
    expect(h.states.at(-1)).toMatchObject({ state: "error", error: "No device selected" });
  });
});

describe("message flow", () => {
  it("drains waiting messages and syncs them back", async () => {
    const h = harness();
    await h.source.start();
    h.connection.queuedSyncMessages.push({
      channelMessage: { channelIdx: 0, pathLen: 1, txtType: 0, senderTimestamp: 5, text: "hello mesh" },
    });
    h.connection.emit(Constants.PushCodes.MsgWaiting);
    await vi.waitFor(() => {
      const messagePost = h.posts.find((p) => p.kind === "messages");
      expect(messagePost).toBeTruthy();
      expect((messagePost!.payload as { messages: { text: string }[] }).messages[0]!.text).toBe("hello mesh");
    });
    await h.source.stop();
  });

  it("sendDirectMessage posts through ingest and upgrades to delivered on ack", async () => {
    const h = harness();
    await h.source.start();
    const key = "ab".repeat(32);
    const message = await h.source.sendDirectMessage(key, "ping");
    expect(message.id).toBe(100); // server-assigned via ingest
    expect(h.connection.sentTexts[0]!.text).toBe("ping");

    h.connection.emit(Constants.PushCodes.SendConfirmed, { ackCode: h.connection.nextAckCrc });
    await vi.waitFor(() => {
      const delivered = h.posts.filter((p) => p.kind === "messages").at(-1);
      expect((delivered!.payload as { messages: { status: string }[] }).messages[0]!.status).toBe("delivered");
    });
    await h.source.stop();
  });

  it("retains an acknowledgement that arrives before the send response", async () => {
    const h = harness();
    h.connection.emitAckBeforeResponse = true;
    await h.source.start();

    const message = await h.source.sendDirectMessage("ab".repeat(32), "early ack");
    expect(message.status).toBe("delivered");
    await vi.waitFor(() => {
      const delivered = h.posts.filter((p) => p.kind === "messages").at(-1);
      expect((delivered!.payload as { messages: { status: string }[] }).messages[0]!.status).toBe("delivered");
    });
    await h.source.stop();
  });

  it("serializes same-CRC sends so each acknowledgement updates its own message", async () => {
    const h = harness();
    h.connection.nextAckCrc = 1234;
    await h.source.start();

    const first = h.source.sendDirectMessage("ab".repeat(32), "first");
    const second = h.source.sendDirectMessage("ab".repeat(32), "second");
    await first;
    expect(h.connection.sentTexts.map((sent) => sent.text)).toEqual(["first"]);

    h.connection.emit(Constants.PushCodes.SendConfirmed, { ackCode: 1234, roundTrip: 0 });
    await vi.waitFor(() => expect(h.connection.sentTexts.map((sent) => sent.text)).toEqual(["first", "second"]));
    await second;
    h.connection.emit(Constants.PushCodes.SendConfirmed, { ackCode: 1234, roundTrip: 0 });
    await vi.waitFor(() => {
      const delivered = h.posts
        .filter((post) => post.kind === "messages")
        .filter((post) => (post.payload as { messages: { status: string }[] }).messages[0]!.status === "delivered");
      expect(delivered).toHaveLength(2);
    });
    await h.source.stop();
  });

  it("private sessions keep traffic local with negative ids and never post", async () => {
    const h = harness({ privateSession: true });
    await h.source.start();
    expect(h.posts).toHaveLength(0);

    const message = await h.source.sendDirectMessage("ab".repeat(32), "secret");
    expect(message.id).toBeLessThan(0);
    h.connection.emit(Constants.PushCodes.SendConfirmed, { ackCode: h.connection.nextAckCrc });
    await vi.waitFor(() => {
      expect(h.localStatuses).toEqual([{ id: message.id, status: "delivered" }]);
    });
    expect(h.posts).toHaveLength(0);
    expect(h.queue.entries).toHaveLength(0);
    await h.source.stop();
  });
});

describe("offline queue", () => {
  it("buffers sync-backs while the server is unreachable, then flushes", async () => {
    const failing = harness({ postFails: true });
    await failing.source.start();
    const message = await failing.source.sendDirectMessage("ab".repeat(32), "offline ping");
    expect(message.id).toBeLessThan(0); // local fallback while the server is down
    // start() kicks an immediate flush that races with the sends; wait for it
    // to fail and re-queue rather than asserting an exact order
    await vi.waitFor(() => {
      expect(failing.queue.entries.map((e) => e.kind).sort()).toEqual(["contacts", "messages", "self"]);
    });
    await failing.source.stop();

    // server back: a fresh session flushes the same queue on start
    const recovered = harness();
    recovered.queue.entries = failing.queue.entries;
    await recovered.source.start();
    await vi.waitFor(() => {
      const flushed = recovered.posts.filter((p) => p.kind === "messages");
      expect(flushed.some((p) => (p.payload as { messages: { text: string }[] }).messages[0]!.text === "offline ping")).toBe(
        true,
      );
    });
    expect(recovered.queue.entries).toHaveLength(0);
    await recovered.source.stop();
  });

  it("renders incoming messages locally while the server is unreachable, then reconciles on replay", async () => {
    const failing = harness({ postFails: true });
    await failing.source.start();
    failing.localMessages.length = 0; // ignore anything drained during start
    failing.connection.queuedSyncMessages.push({
      channelMessage: { channelIdx: 0, pathLen: 1, txtType: 0, senderTimestamp: 9, text: "offline inbound" },
    });
    failing.connection.emit(Constants.PushCodes.MsgWaiting);

    // shown right away with a synthetic negative id and queued for sync-back
    await vi.waitFor(() => {
      expect(failing.localMessages.some((m) => m.text === "offline inbound" && m.id < 0)).toBe(true);
    });
    const rendered = failing.localMessages.find((m) => m.text === "offline inbound")!;
    expect(failing.queue.entries.some((e) => e.kind === "messages")).toBe(true);
    await failing.source.stop();

    // server back: replay reports the server row carrying the same ingestionId
    const recovered = harness();
    recovered.queue.entries = failing.queue.entries;
    await recovered.source.start();
    await vi.waitFor(() => {
      const synced = recovered.syncedMessages.find((m) => m.text === "offline inbound");
      expect(synced).toBeTruthy();
      expect(synced!.ingestionId).toBe(rendered.ingestionId);
    });
    await recovered.source.stop();
  });

  it("keeps a local ACK status and reports the server row when an offline send replays", async () => {
    const failing = harness({ postFails: true });
    await failing.source.start();
    const local = await failing.source.sendDirectMessage("ab".repeat(32), "offline ack");
    failing.connection.emit(Constants.PushCodes.SendConfirmed, { ackCode: failing.connection.nextAckCrc });
    await vi.waitFor(() => expect(failing.localStatuses).toContainEqual({ id: local.id, status: "delivered" }));
    await failing.source.stop();

    const recovered = harness();
    recovered.queue.entries = failing.queue.entries;
    await recovered.source.start();
    await vi.waitFor(() => {
      expect(recovered.syncedMessages.some((message) => message.ingestionId && message.text === "offline ack")).toBe(true);
    });
    await recovered.source.stop();
  });
});
