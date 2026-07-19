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
    outboundMaxAttempts: 5,
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

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it("drains v3 queued messages during initial sync", async () => {
    const v3Mock = new MockRadio({ port: 0, messageProtocolVersion: 3 });
    await v3Mock.start();
    v3Mock.injectDirectMessage("Mock Alice", "v3 direct message");
    v3Mock.injectChannelMessage(0, "v3 channel message");
    const v3Db = openDb(":memory:");
    const v3Manager = new ConnectionManager(testConfig(v3Mock.port), v3Db, new Bus(), "test", 50);

    try {
      await v3Manager.start();
      await waitForState(v3Manager, "connected");
      expect(
        v3Manager.store
          .getConversation({ contactKey: Buffer.from(v3Mock.contacts[0].publicKey).toString("hex"), limit: 10 })
          .map((message) => message.text),
      ).toContain("v3 direct message");
      expect(v3Manager.store.getConversation({ channelIdx: 0, limit: 10 }).map((message) => message.text)).toContain(
        "v3 channel message",
      );
    } finally {
      await v3Manager.stop();
      await v3Mock.stop();
      v3Db.close();
    }
  });

  it("drops contacts the radio no longer has on refresh but keeps their history", async () => {
    const phantomKey = "f".repeat(64);
    // a contact that was removed on the radio through another app
    manager.store.upsertContact({
      publicKey: phantomKey,
      name: "Ghost",
      type: "chat",
      flags: 0,
      outPathLen: -1,
      lat: null,
      lon: null,
      lastAdvert: 0,
      lastSeen: null,
    });
    manager.store.insertMessage({
      kind: "dm",
      contactKey: phantomKey,
      direction: "in",
      text: "from beyond",
      senderTimestamp: 1_000,
    });

    const removedEvent = waitForEvent(bus, (e) => e.type === "contact.removed");
    const contacts = await manager.refreshContacts();

    expect((await removedEvent) as Extract<WsEvent, { type: "contact.removed" }>).toMatchObject({ publicKey: phantomKey });
    expect(contacts.map((c) => c.name)).not.toContain("Ghost");
    expect(manager.store.getContacts().map((c) => c.name)).not.toContain("Ghost");
    // radio contacts survive the reconciliation
    expect(manager.store.getContacts()).toHaveLength(4);
    // the removed contact's history keeps its identity
    const history = manager.store.getConversation({ contactKey: phantomKey, limit: 10 });
    expect(history.map((m) => m.text)).toEqual(["from beyond"]);
  });

  it("sends a DM, sees it delivered, and receives the echo", async () => {
    const alice = manager.store.getContacts().find((c) => c.name === "Mock Alice")!;

    const delivered = waitForEvent(bus, (e) => e.type === "message.status" && e.status === "delivered");
    const echoed = waitForEvent(
      bus,
      (e) => e.type === "message.new" && e.message.direction === "in" && e.message.kind === "dm",
    );

    // Sends are queued: the call returns immediately as pending, and the
    // outbound worker hands it to the radio and drives it to delivered.
    const sent = await manager.sendDirectMessage(alice.publicKey, "hello mesh");
    expect(sent.status).toBe("pending");

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
      const delivered = waitForEvent(bus, (e) => e.type === "message.status" && e.status === "delivered");
      const message = await manager.sendDirectMessage("ab".repeat(32), "early ack");
      expect(message.status).toBe("pending");
      await delivered;
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
      const firstMessage = await manager.sendDirectMessage("ab".repeat(32), "first");
      const secondMessage = await manager.sendDirectMessage("ab".repeat(32), "second");
      // The worker hands off the first and holds the second until the first's ack.
      await until(() => sent.length === 1);
      expect(sent).toEqual(["first"]);

      emitter.emit(Constants.PushCodes.SendConfirmed, { ackCode: 4321, roundTrip: 0 });
      await until(() => sent.length === 2);
      expect(sent).toEqual(["first", "second"]);
      emitter.emit(Constants.PushCodes.SendConfirmed, { ackCode: 4321, roundTrip: 0 });

      await until(
        () =>
          manager.store.getMessage(firstMessage.id)?.status === "delivered" &&
          manager.store.getMessage(secondMessage.id)?.status === "delivered",
      );
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
      const secondMessage = await manager.sendDirectMessage("ab".repeat(32), "second");
      await until(() => sent.length === 1);
      expect(sent).toEqual(["first"]);

      // first's ack never arrives; it times out (estTimeout 10ms) and the
      // worker moves on to the second without failing the first.
      await until(() => sent.length === 2);
      expect(sent).toEqual(["first", "second"]);
      emitter.emit(Constants.PushCodes.SendConfirmed, { ackCode: 4321, roundTrip: 0 });

      await until(() => manager.store.getMessage(secondMessage.id)?.status === "delivered");
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

  it("delivers a message that was queued while the radio was away, on reconnect", async () => {
    await manager.release();
    // a send enqueued while the radio was in another owner's hands (simulated
    // here by seeding the queue directly): it must not attempt until reclaimed
    const queued = manager.store.insertMessage({
      kind: "channel",
      channelIdx: 0,
      direction: "out",
      text: "queued while away",
      senderTimestamp: 1_000,
      status: "pending",
    })!;
    manager.store.enqueueOutbound({
      messageId: queued.id,
      kind: "channel",
      channelIdx: 0,
      text: "queued while away",
      maxAttempts: 5,
      nextAttemptAt: 1_000,
    });
    expect(manager.store.getOutbound(queued.id)?.state).toBe("pending");

    const echoed = waitForEvent(
      bus,
      (e) => e.type === "message.new" && e.message.direction === "in" && e.message.text.includes("queued while away"),
    );
    await manager.claim();
    await waitForState(manager, "connected");
    await echoed;

    // handed off on reconnect: removed from the queue and marked sent
    await until(() => manager.store.getOutbound(queued.id) === null);
    expect(manager.store.getMessage(queued.id)?.status).toBe("sent");
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

  it("activates, edits, and deactivates radio profiles", async () => {
    // a profile pointing at the mock radio becomes the effective connection
    const profile = manager.store.createRadioProfile({
      name: "Bench",
      connection: "tcp",
      tcpHost: "127.0.0.1",
      tcpPort: mock.port,
    });
    await manager.activateProfile(profile.id);
    await waitForState(manager, "connected");
    const settings = manager.connectionSettings();
    expect(settings.activeProfile?.name).toBe("Bench");
    expect(settings.effective).toMatchObject({ connection: "tcp", tcpHost: "127.0.0.1", tcpPort: mock.port });

    // the active profile is protected from deletion
    expect(() => manager.deleteProfile(profile.id)).toThrow(/active/);

    // editing the active profile applies the new settings immediately
    await manager.updateProfile(profile.id, { connection: "none" });
    await waitForState(manager, "disconnected");
    expect(manager.connectionSettings().effective.connection).toBe("none");

    // an explicit override replaces the profile selection
    await manager.setConnectionOverride({ connection: "tcp", tcpHost: "127.0.0.1", tcpPort: mock.port });
    await waitForState(manager, "connected");
    expect(manager.connectionSettings().activeProfile).toBeNull();

    // back to env settings; the now-inactive profile can be deleted
    await manager.setConnectionOverride(null);
    await waitForState(manager, "connected");
    manager.deleteProfile(profile.id);
    expect(manager.store.listRadioProfiles()).toHaveLength(0);
    await expect(manager.activateProfile(9999)).rejects.toThrow(/not found/);
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

  it("treats configuration errors as permanent and suppresses reconnect until settings change", async () => {
    db = openDb(":memory:");
    const factory = vi.fn(() => {
      throw new Error("factory must not run for invalid configuration");
    });
    const config: ServerConfig = { ...testConfig(1), connection: "serial", serialPort: null };
    manager = new ConnectionManager(config, db, new Bus(), "test", 50, factory as never);

    vi.useFakeTimers();
    await manager.start();
    expect(manager.getState()).toBe("error");
    expect(manager.status().connection.lastError).toContain("configuration error");
    expect(manager.status().connection.lastError).toContain("serial port");

    // no reconnect loop: retrying cannot fix missing configuration
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(factory).not.toHaveBeenCalled();
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

describe("outbound retry worker", () => {
  // A bare manager with an injected connection and a forced "connected" state,
  // so we can exercise hand-off failures without real hardware or slow backoff.
  function bareManager(overrides: Partial<ServerConfig> = {}) {
    const db = openDb(":memory:");
    const bus = new Bus();
    const manager = new ConnectionManager({ ...testConfig(0), ...overrides }, db, bus, "test");
    const internals = manager as unknown as { connection: Connection | null; state: string };
    return { db, bus, manager, internals };
  }

  function fakeConnection(sendTextMessage: () => Promise<{ result: number; expectedAckCrc: number; estTimeout: number }>): Connection {
    return Object.assign(new EventEmitter(), { sendTextMessage }) as unknown as Connection;
  }

  it("queues a send while offline and leaves it pending without an attempt", async () => {
    const { db, manager } = bareManager();
    try {
      const message = await manager.sendDirectMessage("ab".repeat(32), "offline");
      expect(message.status).toBe("pending");
      const entry = manager.store.getOutbound(message.id);
      expect(entry).toMatchObject({ state: "pending", attempts: 0 });
    } finally {
      await manager.stop();
      db.close();
    }
  });

  it("fails a send after exhausting attempts, then re-drives it on retry", async () => {
    const { db, manager, internals } = bareManager({ outboundMaxAttempts: 1 });
    try {
      internals.connection = fakeConnection(() => Promise.reject(new Error("radio rejected")));
      internals.state = "connected";

      const message = await manager.sendDirectMessage("ab".repeat(32), "will fail");
      await until(() => manager.store.getMessage(message.id)?.status === "failed");
      expect(manager.store.getOutbound(message.id)).toMatchObject({ state: "failed", attempts: 1, lastError: "radio rejected" });

      // retrying a non-failed entry is rejected; an unknown id is not found
      expect(() => manager.retryOutbound(999_999)).toThrow(/not in the outbound queue/);

      // swap in a working radio and retry: it hands off and clears the queue
      internals.connection = fakeConnection(() => Promise.resolve({ result: 0, expectedAckCrc: 7, estTimeout: 20 }));
      const retried = manager.retryOutbound(message.id);
      expect(retried.status).toBe("pending");
      await until(() => manager.store.getMessage(message.id)?.status === "sent");
      await until(() => manager.store.getOutbound(message.id) === null);
    } finally {
      await manager.stop();
      db.close();
    }
  });

  it("cancels a queued send: drops it from the queue and marks it failed", async () => {
    const { db, manager } = bareManager();
    try {
      const message = await manager.sendDirectMessage("ab".repeat(32), "cancel me");
      expect(manager.store.getOutbound(message.id)?.state).toBe("pending");

      const cancelled = manager.cancelOutbound(message.id);
      expect(cancelled.status).toBe("failed");
      expect(manager.store.getOutbound(message.id)).toBeNull();
      expect(() => manager.cancelOutbound(message.id)).toThrow(/not in the outbound queue/);
    } finally {
      await manager.stop();
      db.close();
    }
  });

  it("rejects sends while the radio is in standby", async () => {
    const { db, manager } = bareManager();
    try {
      await manager.release(); // standby
      await expect(manager.sendDirectMessage("ab".repeat(32), "nope")).rejects.toThrow(/standby/);
    } finally {
      await manager.stop();
      db.close();
    }
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
