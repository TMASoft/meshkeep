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
    expect(status.batteryMilliVolts).toBe(4111);

    const contacts = manager.store.getContacts();
    expect(contacts).toHaveLength(3);
    expect(contacts.map((c) => c.name)).toContain("Mock Alice");
    expect(contacts.find((c) => c.name === "Mock Repeater")?.type).toBe("repeater");
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
