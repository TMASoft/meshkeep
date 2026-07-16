import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Constants, type Connection } from "@liamcottle/meshcore.js";
import type { Message, WsEvent } from "@meshkeep/shared";
import { MockRadio } from "../src/radio/mock/mock-radio.js";
import { ConnectionManager } from "../src/radio/manager.js";
import { openDb, type Db } from "../src/db/index.js";
import { Bus } from "../src/bus.js";
import type { ServerConfig } from "../src/config.js";

function testConfig(port: number): ServerConfig {
  return {
    port: 0,
    dataDir: ":memory:",
    connection: "tcp",
    serialPort: null,
    serialBaud: 115200,
    tcpHost: "127.0.0.1",
    tcpPort: port,
    bleAddress: null,
    uiPassword: null,
    telemetryRetentionDays: 30,
    mapRefreshMinutes: 10,
    mapUpstream: "https://map.meshcore.io/api/v1/nodes",
    mapEnabled: true,
  };
}

function waitForEvent(bus: Bus, predicate: (event: WsEvent) => boolean, timeoutMs = 10_000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for bus event"));
    }, timeoutMs);
    const unsubscribe = bus.subscribe((event) => {
      if (predicate(event)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

async function waitForState(manager: ConnectionManager, state: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (manager.getState() !== state) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for state ${state}, still ${manager.getState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("mock radio end-to-end", () => {
  let mock: MockRadio;
  let db: Db;
  let bus: Bus;
  let manager: ConnectionManager;

  beforeEach(async () => {
    mock = new MockRadio({ port: 0, echoDelayMs: 50 });
    await mock.start();
    db = openDb(":memory:");
    bus = new Bus();
    manager = new ConnectionManager(testConfig(mock.port), db, bus, "test", 50);
    await manager.start();
    await waitForState(manager, "connected");
  });

  afterEach(async () => {
    await manager.stop();
    await mock.stop();
    db.close();
  });

  it("syncs self info, contacts, and channels on connect", () => {
    const status = manager.status();
    expect(status.connection.state).toBe("connected");
    expect(status.self?.name).toBe("MockKeep RAK4631");
    expect(status.self?.firmwareVer).toBe(3);
    expect(status.self?.manufacturerModel).toBe("MockKeep,RAK4631 firmware");
    expect(status.batteryMilliVolts).toBe(4111);

    const contacts = manager.store.getContacts();
    expect(contacts).toHaveLength(4);
    expect(contacts.map((c) => c.name)).toContain("Mock Alice");
    expect(contacts.find((c) => c.name === "Mock Repeater")?.type).toBe("repeater");
    expect(contacts.find((c) => c.name === "Mock Room")?.type).toBe("room");
    expect(contacts.find((c) => c.name === "Mock Alice")?.lat).toBeCloseTo(44.265);

    const channels = manager.store.getChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("Public");
  });

  it("sends a DM, sees it delivered, and receives the echo", async () => {
    const alice = manager.store.getContacts().find((c) => c.name === "Mock Alice")!;

    const delivered = waitForEvent(bus, (e) => e.type === "message.status" && e.status === "delivered");
    const echoed = waitForEvent(
      bus,
      (e) => e.type === "message.new" && e.message.direction === "in" && e.message.kind === "dm",
    );

    const sent = await manager.sendDirectMessage(alice.publicKey, "hello mesh");
    expect(sent.status).toBe("sent");

    await delivered;
    expect(manager.store.getMessage(sent.id)?.status).toBe("delivered");

    const echo = (await echoed) as Extract<WsEvent, { type: "message.new" }>;
    expect(echo.message.text).toBe("echo: hello mesh");
    expect(echo.message.contactKey).toBe(alice.publicKey);
    expect(echo.message.contactName).toBe("Mock Alice");
  });

  it("retains an acknowledgement that arrives before the send response", async () => {
    const originalConnection = (manager as unknown as { connection: Connection }).connection;
    const emitter = new EventEmitter();
    const connection = Object.assign(emitter, {
      async sendTextMessage() {
        emitter.emit(Constants.PushCodes.SendConfirmed, { ackCode: 4321, roundTrip: 0 });
        return { result: 0, expectedAckCrc: 4321, estTimeout: 50 };
      },
    }) as unknown as Connection;
    (manager as unknown as { connection: Connection }).connection = connection;
    (manager as unknown as { attachListeners(connection: Connection): void }).attachListeners(connection);

    try {
      const message = await manager.sendDirectMessage("ab".repeat(32), "early ack");
      expect(message.status).toBe("delivered");
      expect(manager.store.getMessage(message.id)?.status).toBe("delivered");
    } finally {
      (manager as unknown as { connection: Connection }).connection = originalConnection;
    }
  });

  it("serializes same-CRC sends so each acknowledgement updates its own message", async () => {
    const originalConnection = (manager as unknown as { connection: Connection }).connection;
    const emitter = new EventEmitter();
    const sent: string[] = [];
    const connection = Object.assign(emitter, {
      async sendTextMessage(_key: Uint8Array, text: string) {
        sent.push(text);
        return { result: 0, expectedAckCrc: 4321, estTimeout: 50 };
      },
    }) as unknown as Connection;
    (manager as unknown as { connection: Connection }).connection = connection;
    (manager as unknown as { attachListeners(connection: Connection): void }).attachListeners(connection);

    try {
      const first = manager.sendDirectMessage("ab".repeat(32), "first");
      const second = manager.sendDirectMessage("ab".repeat(32), "second");
      const firstMessage = await first;
      expect(sent).toEqual(["first"]);

      emitter.emit(Constants.PushCodes.SendConfirmed, { ackCode: 4321, roundTrip: 0 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toEqual(["first", "second"]);
      const secondMessage = await second;
      emitter.emit(Constants.PushCodes.SendConfirmed, { ackCode: 4321, roundTrip: 0 });
      await new Promise((resolve) => setImmediate(resolve));

      expect(manager.store.getMessage(firstMessage.id)?.status).toBe("delivered");
      expect(manager.store.getMessage(secondMessage.id)?.status).toBe("delivered");
    } finally {
      (manager as unknown as { connection: Connection }).connection = originalConnection;
    }
  });

  it("expires an unacknowledged send before dispatching the next one", async () => {
    const originalConnection = (manager as unknown as { connection: Connection }).connection;
    const emitter = new EventEmitter();
    const sent: string[] = [];
    const connection = Object.assign(emitter, {
      async sendTextMessage(_key: Uint8Array, text: string) {
        sent.push(text);
        return { result: 0, expectedAckCrc: 4321, estTimeout: sent.length === 1 ? 10 : 500 };
      },
    }) as unknown as Connection;
    (manager as unknown as { connection: Connection }).connection = connection;
    (manager as unknown as { attachListeners(connection: Connection): void }).attachListeners(connection);

    try {
      const first = await manager.sendDirectMessage("ab".repeat(32), "first");
      const second = manager.sendDirectMessage("ab".repeat(32), "second");
      expect(sent).toEqual(["first"]);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sent).toEqual(["first", "second"]);
      const secondMessage = await second;
      emitter.emit(Constants.PushCodes.SendConfirmed, { ackCode: 4321, roundTrip: 0 });
      await new Promise((resolve) => setImmediate(resolve));

      expect(manager.store.getMessage(first.id)?.status).toBe("sent");
      expect(manager.store.getMessage(secondMessage.id)?.status).toBe("delivered");
    } finally {
      (manager as unknown as { connection: Connection }).connection = originalConnection;
    }
  });

  it("sends and receives channel messages", async () => {
    const echoed = waitForEvent(
      bus,
      (e) => e.type === "message.new" && e.message.direction === "in" && e.message.kind === "channel",
    );
    await manager.sendChannelMessage(0, "hi channel");
    const echo = (await echoed) as Extract<WsEvent, { type: "message.new" }>;
    expect(echo.message.text).toBe("echo: hi channel");
    expect(echo.message.channelIdx).toBe(0);
    expect(echo.message.channelName).toBe("Public");
  });

  it("requests remote sensor telemetry and parses the Cayenne LPP payload", async () => {
    const alice = manager.store.getContacts().find((c) => c.name === "Mock Alice")!;
    const readings = await manager.requestTelemetry(alice.publicKey);
    expect(readings).toEqual([
      { channel: 1, type: 116, label: "Voltage", unit: "V", value: 4.03 },
      { channel: 2, type: 103, label: "Temperature", unit: "°C", value: 22.5 },
      { channel: 3, type: 104, label: "Humidity", unit: "%", value: 61 },
    ]);
  });

  it("creates and deletes a channel slot", async () => {
    await manager.setChannel(3, "test-chan", "00112233445566778899aabbccddeeff");
    expect(manager.store.getChannels().map((c) => c.idx)).toEqual([0, 3]);
    expect(await manager.refreshChannels()).toHaveLength(2);

    await manager.deleteChannel(3);
    expect(manager.store.getChannels().map((c) => c.idx)).toEqual([0]);
    // the mock reports the slot as blank on the next full read
    expect(await manager.refreshChannels()).toHaveLength(1);
  });

  it("keeps stored channels when a channel read returns an error", async () => {
    manager.store.upsertChannel({ idx: 3, name: "Stored", secret: "a".repeat(32) });
    const originalConnection = (manager as unknown as { connection: Connection }).connection;
    const connection = channelReader((idx, emitter) => {
      if (idx === 3) emitter.emit(Constants.ResponseCodes.Err);
      else emitter.emit(Constants.ResponseCodes.ChannelInfo, { channelIdx: idx, name: "", secret: new Uint8Array(16) });
    });
    (manager as unknown as { connection: Connection }).connection = connection;

    try {
      await expect(manager.refreshChannels()).rejects.toThrow("radio rejected reading channel 3");
      expect(manager.store.getChannels()).toEqual([
        { idx: 0, name: "Public", secret: expect.any(String) },
        { idx: 3, name: "Stored", secret: "a".repeat(32) },
      ]);
    } finally {
      (manager as unknown as { connection: Connection }).connection = originalConnection;
    }
  });

  it("keeps stored channels when a channel read times out", async () => {
    manager.store.upsertChannel({ idx: 3, name: "Stored", secret: "a".repeat(32) });
    const originalConnection = (manager as unknown as { connection: Connection }).connection;
    const connection = channelReader((idx, emitter) => {
      if (idx !== 3) {
        emitter.emit(Constants.ResponseCodes.ChannelInfo, { channelIdx: idx, name: "", secret: new Uint8Array(16) });
      }
    });
    (manager as unknown as { connection: Connection }).connection = connection;

    try {
      await expect(manager.refreshChannels()).rejects.toThrow("timed out reading channel 3");
      expect(manager.store.getChannels()).toEqual([
        { idx: 0, name: "Public", secret: expect.any(String) },
        { idx: 3, name: "Stored", secret: "a".repeat(32) },
      ]);
    } finally {
      (manager as unknown as { connection: Connection }).connection = originalConnection;
    }
  });

  it("serializes concurrent channel writes so each receives its own response", async () => {
    const originalConnection = (manager as unknown as { connection: Connection }).connection;
    const emitter = new EventEmitter();
    const sent: string[] = [];
    const connection = Object.assign(emitter, {
      sendCommandSetChannel(_idx: number, name: string): Promise<void> {
        sent.push(name);
        return Promise.resolve();
      },
    }) as unknown as Connection;
    (manager as unknown as { connection: Connection }).connection = connection;

    try {
      const first = manager.setChannel(2, "first", "a".repeat(32));
      const second = manager.setChannel(3, "second", "b".repeat(32));
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toEqual(["first"]);

      emitter.emit(Constants.ResponseCodes.Ok);
      await expect(first).resolves.toMatchObject({ idx: 2, name: "first" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toEqual(["first", "second"]);

      emitter.emit(Constants.ResponseCodes.Err);
      await expect(second).rejects.toThrow("radio rejected channel update");
      expect(manager.store.getChannels().map((channel) => channel.idx)).toContain(2);
      expect(manager.store.getChannels().map((channel) => channel.idx)).not.toContain(3);
    } finally {
      (manager as unknown as { connection: Connection }).connection = originalConnection;
    }
  });

  it("receives unsolicited incoming messages via MsgWaiting push", async () => {
    const incoming = waitForEvent(bus, (e) => e.type === "message.new");
    mock.injectDirectMessage("Mock Bob", "ping from the field");
    const event = (await incoming) as Extract<WsEvent, { type: "message.new" }>;
    expect(event.message.text).toBe("ping from the field");
    expect(event.message.contactName).toBe("Mock Bob");
  });

  it("preserves repeated incoming messages", async () => {
    const first = waitForEvent(bus, (e) => e.type === "message.new");
    mock.injectDirectMessage("Mock Bob", "same message");
    await first;
    const before = manager.store.counts().messages;
    // The protocol offers no frame ID, so distinct received frames are kept.
    mock.injectDirectMessage("Mock Bob", "same message");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(manager.store.counts().messages).toBe(before + 1);
  });

  it("updates device settings", async () => {
    const self = await manager.setDeviceSettings({ name: "Renamed Node", txPower: 17 });
    expect(self.name).toBe("Renamed Node");
    expect(mock.name).toBe("Renamed Node");
    expect(mock.txPower).toBe(17);
  });

  it("release puts the connection in standby and claim reconnects", async () => {
    await manager.release();
    expect(manager.getState()).toBe("standby");
    expect(manager.isStandby()).toBe(true);
    await expect(manager.sendChannelMessage(0, "nope")).rejects.toThrow();

    await manager.claim();
    await waitForState(manager, "connected");
    expect(manager.isStandby()).toBe(false);
  });

  it("round-trips a contact through export and import URIs", async () => {
    const alice = manager.store.getContacts().find((c) => c.name === "Mock Alice")!;

    const uri = await manager.exportContactUri(alice.publicKey);
    expect(uri).toMatch(/^meshcore:\/\/[0-9a-f]+$/);

    await manager.removeContact(alice.publicKey);
    expect(manager.store.getContacts().some((c) => c.publicKey === alice.publicKey)).toBe(false);

    const contacts = await manager.importContactUri(uri);
    const restored = contacts.find((c) => c.publicKey === alice.publicKey);
    expect(restored?.name).toBe("Mock Alice");
    expect(restored?.lat).toBeCloseTo(44.265);
    expect(manager.store.getContacts().some((c) => c.publicKey === alice.publicKey)).toBe(true);
  });

  it("rejects malformed contact import URIs", async () => {
    await expect(manager.importContactUri("meshcore://not-hex")).rejects.toThrow(/not a valid/);
  });

  it("exports our own identity as a share URI", async () => {
    const uri = await manager.exportContactUri(null);
    expect(uri).toMatch(/^meshcore:\/\/[0-9a-f]+$/);
    // self key is embedded in the advert packet
    expect(uri).toContain(manager.status().self!.publicKey);
  });

  it("records telemetry, serves history, and trims old rows", () => {
    const nowTs = Math.floor(Date.now() / 1000);
    // battery snapshot from initial sync
    const points = manager.store.getTelemetry(nowTs - 3600);
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(points.at(-1)?.batteryMv).toBe(4111);

    // a row far outside the retention window is trimmed
    db.prepare("INSERT INTO telemetry (ts, battery_mv, raw_json) VALUES (?, ?, NULL)").run(
      nowTs - 90 * 86_400,
      3900,
    );
    const removed = manager.store.trimTelemetry(30);
    expect(removed).toBe(1);
    expect(manager.store.getTelemetry(0).every((p) => p.ts > nowTs - 31 * 86_400)).toBe(true);
  });

  it("applies and clears connection overrides", async () => {
    const before = manager.connectionSettings();
    expect(before.override).toBeNull();
    expect(before.effective.tcpPort).toBe(mock.port);

    // an override pointing at the same mock exercises the reconnect path
    await manager.setConnectionOverride({ connection: "tcp", tcpHost: "127.0.0.1", tcpPort: mock.port });
    await waitForState(manager, "connected");
    const withOverride = manager.connectionSettings();
    expect(withOverride.override).toEqual({ connection: "tcp", tcpHost: "127.0.0.1", tcpPort: mock.port });
    expect(manager.status().connection.transport).toBe("tcp");

    await manager.setConnectionOverride(null);
    await waitForState(manager, "connected");
    expect(manager.connectionSettings().override).toBeNull();
  });

  it("logs in to a repeater, reads status, and runs CLI commands", async () => {
    const repeater = manager.store.getContacts().find((c) => c.name === "Mock Repeater")!;

    // wrong password: no LoginSuccess push, the request times out → false
    await expect(manager.loginToNode(repeater.publicKey, "wrong")).resolves.toBe(false);
    // status before login: no response → helpful error
    await expect(manager.getNodeStatus(repeater.publicKey)).rejects.toThrow(/status request failed/);

    await expect(manager.loginToNode(repeater.publicKey, "letmein")).resolves.toBe(true);

    const status = await manager.getNodeStatus(repeater.publicKey);
    expect(status.battMilliVolts).toBe(4020);
    expect(status.noiseFloor).toBe(-105);
    expect(status.lastRssi).toBe(-78);
    expect(status.totalUpTimeSecs).toBe(86_400);

    const reply = waitForEvent(
      bus,
      (e) => e.type === "message.new" && e.message.direction === "in" && e.message.contactName === "Mock Repeater",
    );
    await manager.sendDirectMessage(repeater.publicKey, "ver", true);
    const event = (await reply) as Extract<WsEvent, { type: "message.new" }>;
    expect(event.message.text).toContain("MockCore v1.16");
  }, 15_000);

  it("posts to a room server after login", async () => {
    const room = manager.store.getContacts().find((c) => c.name === "Mock Room")!;

    // unauthenticated posts are accepted on air but the room stays silent
    await manager.sendDirectMessage(room.publicKey, "anyone here?");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      manager.store.getConversation({ contactKey: room.publicKey, limit: 10 }).filter((m) => m.direction === "in"),
    ).toHaveLength(0);

    await expect(manager.loginToNode(room.publicKey, "letmein")).resolves.toBe(true);

    const echoed = waitForEvent(
      bus,
      (e) => e.type === "message.new" && e.message.direction === "in" && e.message.contactName === "Mock Room",
    );
    await manager.sendDirectMessage(room.publicKey, "hello room");
    const event = (await echoed) as Extract<WsEvent, { type: "message.new" }>;
    expect(event.message.text).toBe("room echo: hello room");
    // the mock room reposts as signed-plain attributed to Mock Alice
    const alice = manager.store.getContacts().find((c) => c.name === "Mock Alice")!;
    expect(event.message.authorPrefix).toBe(alice.publicKey.slice(0, 8));
    expect(event.message.authorName).toBe("Mock Alice");
  }, 15_000);

  it("persists history across a manager restart", async () => {
    const alice = manager.store.getContacts().find((c) => c.name === "Mock Alice")!;
    const echoed = waitForEvent(bus, (e) => e.type === "message.new");
    await manager.sendDirectMessage(alice.publicKey, "survive me");
    await echoed;
    const countBefore = manager.store.counts().messages;
    expect(countBefore).toBeGreaterThanOrEqual(2);

    await manager.stop();
    // same db handle simulates the same on-disk database after restart
    const manager2 = new ConnectionManager(testConfig(mock.port), db, bus, "test");
    await manager2.start();
    await waitForState(manager2, "connected");
    expect(manager2.store.counts().messages).toBe(countBefore);
    const history: Message[] = manager2.store.getConversation({ contactKey: alice.publicKey, limit: 10 });
    expect(history.some((m) => m.text === "survive me")).toBe(true);
    await manager2.stop();
  });
});

describe("connection lifecycle races", () => {
  let db: Db;
  let manager: ConnectionManager;

  afterEach(async () => {
    await manager?.stop();
    db?.close();
    vi.useRealTimers();
  });

  it("does not restore a connection after release while it is connecting", async () => {
    const delayed = delayedConnection();
    db = openDb(":memory:");
    manager = new ConnectionManager(testConfig(1), db, new Bus(), "test", 50, () => delayed.connection);

    const starting = manager.start();
    expect(manager.getState()).toBe("connecting");
    await manager.release();
    delayed.emitter.emit(Constants.PushCodes.NewAdvert, {
      publicKey: new Uint8Array(32).fill(7),
      type: 1,
      flags: 0,
      outPathLen: 0,
      advName: "stale advert",
      lastAdvert: 0,
      advLat: 0,
      advLon: 0,
    });
    delayed.emitter.emit("connected");
    await starting;

    expect(delayed.close).toHaveBeenCalledOnce();
    expect(manager.getState()).toBe("standby");
    expect(manager.store.getContacts()).toHaveLength(0);
  });

  it("does not restore a connection after stop while it is connecting", async () => {
    const delayed = delayedConnection();
    db = openDb(":memory:");
    manager = new ConnectionManager(testConfig(1), db, new Bus(), "test", 50, () => delayed.connection);

    const starting = manager.start();
    await manager.stop();
    delayed.emitter.emit("connected");
    await starting;

    expect(manager.getState()).toBe("disconnected");
  });

  it("does not let a stale connection override a new disabled transport", async () => {
    const delayed = delayedConnection();
    db = openDb(":memory:");
    manager = new ConnectionManager(testConfig(1), db, new Bus(), "test", 50, () => delayed.connection);

    const starting = manager.start();
    await manager.setConnectionOverride({ connection: "none" });
    delayed.emitter.emit("connected");
    await starting;

    expect(manager.getState()).toBe("disconnected");
    expect(manager.status().connection.transport).toBe("none");
  });

  it("cancels a scheduled reconnect when released", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const connect = vi.fn().mockRejectedValue(new Error("offline"));
    const connection = Object.assign(emitter, {
      connect,
      close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Connection;
    db = openDb(":memory:");
    manager = new ConnectionManager(testConfig(1), db, new Bus(), "test", 50, () => connection);

    await manager.start();
    expect(manager.getState()).toBe("error");
    await manager.release();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(connect).toHaveBeenCalledOnce();
    expect(manager.getState()).toBe("standby");
  });
});

function delayedConnection(): { emitter: EventEmitter; connection: Connection; close: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    emitter,
    connection: Object.assign(emitter, { connect: vi.fn().mockResolvedValue(undefined), close }) as unknown as Connection,
    close,
  };
}

function channelReader(respond: (idx: number, emitter: EventEmitter) => void): Connection {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    sendCommandGetChannel(idx: number): Promise<void> {
      respond(idx, emitter);
      return Promise.resolve();
    },
  }) as unknown as Connection;
}
