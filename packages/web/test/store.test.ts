import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Message, WsEvent } from "@meshkeep/shared";

const apiMock = vi.hoisted(() => vi.fn());
const connectEventsMock = vi.hoisted(() => vi.fn(() => () => {}));
const browserRadioMock = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
}));

vi.mock("../src/api/client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  connectEvents: connectEventsMock,
}));

vi.mock("../src/sources/browser-radio", () => ({
  BrowserRadioSource: class {
    start() {
      return browserRadioMock.start();
    }

    stop() {
      return browserRadioMock.stop();
    }
  },
}));

import { useAppStore, conversationKey } from "../src/stores/app";

const KEY_A = "a".repeat(64);

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    kind: "dm",
    contactKey: KEY_A,
    channelIdx: null,
    direction: "in",
    text: "hello",
    senderTimestamp: 1_784_000_000,
    pathLen: null,
    status: "sent",
    createdAt: 1_784_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  apiMock.mockReset();
  connectEventsMock.mockClear();
  browserRadioMock.start.mockReset();
  browserRadioMock.stop.mockReset();
  browserRadioMock.start.mockResolvedValue();
  browserRadioMock.stop.mockResolvedValue();
});

describe("bootstrap and auth state", () => {
  it("halts at the login gate when a password is required", async () => {
    apiMock.mockResolvedValueOnce({ passwordRequired: true, authorized: false });
    const store = useAppStore();
    await store.bootstrap();
    expect(store.needsLogin).toBe(true);
    expect(store.loaded).toBe(false);
    expect(connectEventsMock).not.toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledTimes(1); // only /auth/session
  });

  it("loads status, contacts, and channels and opens the event feed in open mode", async () => {
    apiMock.mockImplementation((path: string) => {
      switch (path) {
        case "/auth/session":
          return Promise.resolve({ passwordRequired: false, authorized: true });
        case "/status":
          return Promise.resolve({ connection: { state: "connected" }, self: null, batteryMilliVolts: 4000 });
        case "/contacts":
          return Promise.resolve({ contacts: [{ publicKey: KEY_A, name: "Alice", type: "chat" }] });
        case "/channels":
          return Promise.resolve({ channels: [] });
        case "/messages/unknown-senders":
          return Promise.resolve({ messages: [] });
        default:
          return Promise.reject(new Error(`unexpected ${path}`));
      }
    });
    const store = useAppStore();
    await store.bootstrap();
    expect(store.loaded).toBe(true);
    expect(store.needsLogin).toBe(false);
    expect(store.contacts).toHaveLength(1);
    expect(store.connectionState).toBe("connected");
    expect(connectEventsMock).toHaveBeenCalledOnce();
  });

  it("login surfaces a friendly error on 401", async () => {
    const { ApiError } = await import("../src/api/client");
    apiMock.mockRejectedValueOnce(new ApiError(401, "wrong password"));
    const store = useAppStore();
    await expect(store.login("bad")).rejects.toThrow("Wrong password");
  });
});

describe("browser radio ownership", () => {
  it("requires server standby before opening the browser transport", async () => {
    apiMock.mockResolvedValue({ ok: true, state: "standby" });
    const store = useAppStore();
    store.status = {
      connection: { state: "error", transport: "serial", target: "/dev/ttyUSB0", lastError: "stale failure", connectedAt: null },
      self: null,
      batteryMilliVolts: null,
      counts: { contacts: 0, messages: 0, unread: 0 },
      version: "test",
    };

    await store.startBrowserRadio("webserial", true);

    expect(apiMock).toHaveBeenCalledWith("/connection/release", { method: "POST" });
    expect(browserRadioMock.start).toHaveBeenCalledOnce();
    expect(apiMock.mock.invocationCallOrder[0]).toBeLessThan(browserRadioMock.start.mock.invocationCallOrder[0]!);

    await store.stopBrowserRadio(false);
  });

  it("does not open the browser transport unless release confirms standby", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/connection/release") return Promise.resolve({ ok: true, state: "connecting" });
      if (path === "/connection/claim") return Promise.resolve({ ok: true, state: "connecting" });
      if (path === "/status") return Promise.resolve({ connection: { state: "connecting" } });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const store = useAppStore();

    await expect(store.startBrowserRadio("webserial", true)).rejects.toThrow("did not enter standby");
    expect(browserRadioMock.start).not.toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledWith("/connection/claim", { method: "POST" });
  });

  it("does not open the browser transport when the server release request fails", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/connection/release") return Promise.reject(new Error("network unavailable"));
      if (path === "/connection/claim") return Promise.resolve({ ok: true, state: "connecting" });
      if (path === "/status") return Promise.resolve({ connection: { state: "connecting" } });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const store = useAppStore();

    await expect(store.startBrowserRadio("webserial", true)).rejects.toThrow("network unavailable");
    expect(browserRadioMock.start).not.toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledWith("/connection/claim", { method: "POST" });
  });

  it("reclaims the server if browser picker or transport startup fails", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/connection/release") return Promise.resolve({ ok: true, state: "standby" });
      if (path === "/connection/claim") return Promise.resolve({ ok: true, state: "connecting" });
      if (path === "/status") return Promise.resolve({ connection: { state: "connecting" } });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    browserRadioMock.start.mockRejectedValue(new Error("No device selected"));
    const store = useAppStore();

    await expect(store.startBrowserRadio("webserial", true)).rejects.toThrow("No device selected");
    expect(apiMock).toHaveBeenCalledWith("/connection/claim", { method: "POST" });
    expect(store.browserRadio).toBeNull();
  });
});

describe("message handling", () => {
  it("appendMessage dedupes by id and caps recent at 50", () => {
    const store = useAppStore();
    for (let i = 1; i <= 60; i++) {
      store.appendMessage(message({ id: i, text: `m${i}` }));
    }
    store.appendMessage(message({ id: 60, text: "m60" })); // duplicate
    const key = conversationKey({ kind: "dm", contactKey: KEY_A });
    expect(store.conversations[key]).toHaveLength(60);
    expect(store.recent).toHaveLength(50);
    expect(store.recent[0].id).toBe(60);
  });

  it("counts unread for inactive conversations only", () => {
    const store = useAppStore();
    store.activeConversation = { kind: "dm", contactKey: KEY_A };
    store.appendMessage(message({ id: 1 })); // active dm → not unread
    store.appendMessage(message({ id: 2, kind: "channel", contactKey: null, channelIdx: 3 }));
    store.appendMessage(message({ id: 3, kind: "channel", contactKey: null, channelIdx: 3 }));
    store.appendMessage(message({ id: 4, direction: "out", kind: "channel", contactKey: null, channelIdx: 3 }));
    expect(store.unread[conversationKey({ kind: "dm", contactKey: KEY_A })]).toBeUndefined();
    expect(store.unread["ch:3"]).toBe(2); // outgoing messages never count
  });

  it("exposes an unknown sender and moves its live conversation after unique contact resolution", () => {
    const store = useAppStore();
    const prefix = "abcdef123456";
    const fullKey = `${prefix}${"a".repeat(52)}`;
    store.appendMessage(message({ contactKey: null, contactPrefix: prefix }));
    const unknownKey = conversationKey({ kind: "dm", contactPrefix: prefix });
    expect(store.unknownSenders).toHaveLength(1);
    expect(store.conversations[unknownKey]).toHaveLength(1);

    store.activeConversation = { kind: "dm", contactPrefix: prefix };
    store.contacts = [{ publicKey: fullKey, name: "Alice", type: "chat", flags: 0, outPathLen: -1, lat: null, lon: null, lastAdvert: 0, lastSeen: null }];
    store.reconcileUnknownConversations();

    const knownKey = conversationKey({ kind: "dm", contactKey: fullKey });
    expect(store.unknownSenders).toHaveLength(0);
    expect(store.conversations[knownKey][0].contactKey).toBe(fullKey);
    expect(store.activeConversation).toEqual({ kind: "dm", contactKey: fullKey });
  });

  it("openConversation merges history under live WebSocket arrivals", async () => {
    const store = useAppStore();
    // a live message (with a delivery upgrade) arrived before history loaded
    store.appendMessage(message({ id: 5, text: "live", status: "delivered" }));
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/messages?")
        ? Promise.resolve({ messages: [message({ id: 4, text: "old" }), message({ id: 5, text: "live", status: "sent" })] })
        : Promise.resolve({ ok: true }),
    );
    await store.openConversation({ kind: "dm", contactKey: KEY_A });
    const key = conversationKey({ kind: "dm", contactKey: KEY_A });
    expect(store.conversations[key].map((m) => m.id)).toEqual([4, 5]);
    // the in-memory (newer) object wins over the fetched row
    expect(store.conversations[key][1].status).toBe("delivered");
    expect(store.unread[key]).toBe(0);
    // marks the conversation read on the server
    expect(apiMock).toHaveBeenCalledWith("/messages/read", expect.objectContaining({ method: "POST" }));
  });

  it("replaces an offline negative row by ingestion ID without downgrading delivered status", () => {
    const store = useAppStore();
    const ingestionId = "00000000-0000-4000-8000-000000000031";
    const key = conversationKey({ kind: "dm", contactKey: KEY_A });
    store.appendMessage(message({ id: -1, direction: "out", status: "sent", ingestionId }));
    store.updateMessageStatus(-1, "delivered");

    store.onEvent({ type: "message.new", message: message({ id: 31, direction: "out", status: "sent", ingestionId }) } as WsEvent);
    store.onEvent({ type: "message.status", id: 31, status: "sent" } as WsEvent);

    expect(store.conversations[key]).toEqual([expect.objectContaining({ id: 31, ingestionId, status: "delivered" })]);
    expect(store.recent).toEqual([expect.objectContaining({ id: 31, status: "delivered" })]);
  });

  it("sendMessage posts a dm and appends the created message", async () => {
    const store = useAppStore();
    const created = message({ id: 9, direction: "out", text: "outbound", status: "pending" });
    apiMock.mockResolvedValueOnce({ message: created });
    await store.sendMessage({ kind: "dm", contactKey: KEY_A }, "outbound");
    expect(apiMock).toHaveBeenCalledWith(
      "/messages",
      expect.objectContaining({ body: JSON.stringify({ kind: "dm", to: KEY_A, text: "outbound" }) }),
    );
    expect(store.recent[0].id).toBe(9);
  });

  it("sendMessage routes repeater DMs through the CLI endpoint", async () => {
    const store = useAppStore();
    store.contacts = [
      { publicKey: KEY_A, name: "Rpt", type: "repeater", flags: 0, outPathLen: -1, lat: null, lon: null, lastAdvert: 0, lastSeen: null },
    ];
    apiMock.mockResolvedValueOnce({ message: message({ id: 10, direction: "out", text: "status" }) });
    await store.sendMessage({ kind: "dm", contactKey: KEY_A }, "status");
    expect(apiMock).toHaveBeenCalledWith(`/contacts/${KEY_A}/cli`, expect.objectContaining({ method: "POST" }));
  });
});

describe("websocket event application", () => {
  it("applies status, message-status, contact, self, and telemetry events", () => {
    const store = useAppStore();
    const events: WsEvent[] = [
      {
        type: "status.changed",
        status: { connection: { state: "connected", transport: "tcp", target: null, lastError: null, connectedAt: 1 }, self: null, batteryMilliVolts: 4000 },
      } as WsEvent,
      { type: "message.new", message: message({ id: 1, status: "sent" }) } as WsEvent,
      { type: "message.status", id: 1, status: "delivered" } as WsEvent,
      { type: "contact.updated", contact: { publicKey: KEY_A, name: "Alice v2", type: "chat", flags: 0, outPathLen: -1, lat: null, lon: null, lastAdvert: 0, lastSeen: null } } as WsEvent,
      { type: "telemetry", batteryMilliVolts: 3900 } as WsEvent,
    ];
    for (const event of events) store.onEvent(event);

    expect(store.connectionState).toBe("connected");
    const key = conversationKey({ kind: "dm", contactKey: KEY_A });
    expect(store.conversations[key][0].status).toBe("delivered");
    expect(store.contacts[0].name).toBe("Alice v2");
    expect(store.status?.batteryMilliVolts).toBe(3900);
    expect(store.batteryPercent).toBe(67);
  });

  it("contact.removed drops the contact, unread, and active conversation", () => {
    const store = useAppStore();
    store.contacts = [
      { publicKey: KEY_A, name: "Alice", type: "chat", flags: 0, outPathLen: -1, lat: null, lon: null, lastAdvert: 0, lastSeen: null },
    ];
    store.appendMessage(message({ id: 1 }));
    store.activeConversation = { kind: "dm", contactKey: KEY_A };
    store.onEvent({ type: "contact.removed", publicKey: KEY_A } as WsEvent);
    expect(store.contacts).toHaveLength(0);
    expect(store.unread[`dm:${KEY_A}`]).toBeUndefined();
    expect(store.activeConversation).toBeNull();
  });
});
