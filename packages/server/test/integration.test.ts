import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    manager = new ConnectionManager(testConfig(mock.port), db, bus, "test");
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

  it("receives unsolicited incoming messages via MsgWaiting push", async () => {
    const incoming = waitForEvent(bus, (e) => e.type === "message.new");
    mock.injectDirectMessage("Mock Bob", "ping from the field");
    const event = (await incoming) as Extract<WsEvent, { type: "message.new" }>;
    expect(event.message.text).toBe("ping from the field");
    expect(event.message.contactName).toBe("Mock Bob");
  });

  it("dedupes identical incoming messages", async () => {
    const first = waitForEvent(bus, (e) => e.type === "message.new");
    mock.injectDirectMessage("Mock Bob", "same message");
    await first;
    const before = manager.store.counts().messages;
    // same sender/timestamp/text within the same second → same dedupe hash
    mock.injectDirectMessage("Mock Bob", "same message");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(manager.store.counts().messages).toBe(before);
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
