import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Message, MessageSearchResult, WsEvent } from "@meshkeep/shared";

const apiMock = vi.hoisted(() => vi.fn());
const connectEventsMock = vi.hoisted(() => vi.fn(() => () => {}));
const browserRadioMock = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  getChannels: vi.fn<() => Promise<unknown[]>>(),
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

const notifyIncomingMock = vi.hoisted(() => vi.fn());

vi.mock("../src/notifications", () => ({
  notifyIncoming: notifyIncomingMock,
}));

vi.mock("../src/sources/browser-radio", () => ({
  BrowserRadioSource: class {
    start() {
      return browserRadioMock.start();
    }

    stop() {
      return browserRadioMock.stop();
    }

    getChannels() {
      return browserRadioMock.getChannels();
    }
  },
}));

import { useAppStore, conversationKey } from "../src/stores/app";

const KEY_A = "a".repeat(64);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function searchResult(overrides: Partial<MessageSearchResult> = {}): MessageSearchResult {
  return { ...message(), snippet: "hello", ...overrides };
}

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
  notifyIncomingMock.mockClear();
  browserRadioMock.start.mockReset();
  browserRadioMock.stop.mockReset();
  browserRadioMock.start.mockResolvedValue();
  browserRadioMock.stop.mockResolvedValue();
  browserRadioMock.getChannels.mockReset();
  browserRadioMock.getChannels.mockResolvedValue([]);
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
        case "/messages/unread":
          return Promise.resolve({
            conversations: [
              { kind: "dm", contactKey: KEY_A, contactPrefix: null, channelIdx: null, unread: 2 },
              { kind: "dm", contactKey: null, contactPrefix: "abcdef123456", channelIdx: null, unread: 1 },
              { kind: "channel", contactKey: null, contactPrefix: null, channelIdx: 3, unread: 4 },
            ],
          });
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
    // persisted unread counts become badges keyed by conversation
    expect(store.unread).toEqual({
      [`dm:${KEY_A}`]: 2,
      "dm:unknown:abcdef123456": 1,
      "ch:3": 4,
    });
  });

  it("login surfaces a friendly error on 401", async () => {
    const { ApiError } = await import("../src/api/client");
    apiMock.mockRejectedValueOnce(new ApiError(401, "wrong password"));
    const store = useAppStore();
    await expect(store.login("bad")).rejects.toThrow("Wrong password");
  });
});

describe("bootstrap resilience", () => {
  it("surfaces a snapshot failure, still starts the event feed, and recovers on retry", async () => {
    let statusFails = true;
    apiMock.mockImplementation((path: string) => {
      switch (path) {
        case "/auth/session":
          return Promise.resolve({ passwordRequired: false, authorized: true });
        case "/status":
          return statusFails
            ? Promise.reject(new Error("radio offline"))
            : Promise.resolve({ connection: { state: "connected" }, self: null, batteryMilliVolts: null });
        case "/contacts":
          return Promise.resolve({ contacts: [] });
        case "/channels":
          return Promise.resolve({ channels: [] });
        case "/messages/unknown-senders":
          return Promise.resolve({ messages: [] });
        case "/messages/unread":
          return Promise.resolve({ conversations: [] });
        default:
          return Promise.reject(new Error(`unexpected ${path}`));
      }
    });
    const store = useAppStore();

    await store.bootstrap();
    expect(store.bootstrapPhase).toBe("error");
    expect(store.bootstrapError).toBe("radio offline");
    expect(store.loaded).toBe(false);
    // the live feed starts independently of the initial snapshot
    expect(connectEventsMock).toHaveBeenCalledOnce();

    statusFails = false;
    await store.retryBootstrap();
    expect(store.bootstrapPhase).toBe("ready");
    expect(store.loaded).toBe(true);
    expect(store.connectionState).toBe("connected");
    // retry re-fetches the snapshot only; it must not restart the event feed
    expect(connectEventsMock).toHaveBeenCalledOnce();
  });

  it("fails bootstrap without opening the event feed when the session request fails", async () => {
    apiMock.mockRejectedValueOnce(new Error("network down"));
    const store = useAppStore();
    await store.bootstrap();
    expect(store.bootstrapPhase).toBe("error");
    expect(store.bootstrapError).toBe("network down");
    expect(store.loaded).toBe(false);
    expect(connectEventsMock).not.toHaveBeenCalled();
  });
});

describe("message search sequencing", () => {
  it("discards an out-of-order stale response so the latest query wins", async () => {
    const first = deferred<{ results: MessageSearchResult[] }>();
    const second = deferred<{ results: MessageSearchResult[] }>();
    apiMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const store = useAppStore();

    const stale = store.searchMessages("alpha");
    const latest = store.searchMessages("beta");
    // the newer query resolves first, then the stale one lands late
    second.resolve({ results: [searchResult({ id: 2, text: "beta" })] });
    first.resolve({ results: [searchResult({ id: 1, text: "alpha" })] });

    expect(await latest).toEqual([searchResult({ id: 2, text: "beta" })]);
    expect(await stale).toBeNull(); // superseded — must not overwrite the latest
  });

  it("aborts a superseded in-flight search request", () => {
    const signals: AbortSignal[] = [];
    apiMock.mockImplementation((_path: string, options: RequestInit = {}) => {
      signals.push(options.signal as AbortSignal);
      return new Promise(() => {}); // never resolves
    });
    const store = useAppStore();

    void store.searchMessages("alpha");
    void store.searchMessages("beta");

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true); // cancelled when the newer search started
    expect(signals[1].aborted).toBe(false);
  });
});

describe("diagnostics fetch", () => {
  it("returns the server diagnostics payload", async () => {
    const payload = { server: { version: "test" }, guidance: [] };
    apiMock.mockResolvedValueOnce(payload);
    const store = useAppStore();
    const result = await store.fetchDiagnostics();
    expect(apiMock).toHaveBeenCalledWith("/diagnostics");
    expect(result).toBe(payload);
  });
});

describe("battery display follows the active radio driver", () => {
  it("prefers the browser-direct live reading over the stored server value", () => {
    const store = useAppStore();
    store.status = { batteryMilliVolts: 3600 } as typeof store.status;
    // server driver: the stored value is shown
    expect(store.batteryMilliVolts).toBe(3600);

    // a browser-direct session reports its own live reading and wins
    store.browserRadio = {
      kind: "webserial",
      state: "connected",
      error: null,
      privateSession: false,
      batteryMilliVolts: 4100,
    };
    expect(store.batteryMilliVolts).toBe(4100);
    expect(store.batteryPercent).toBe(89); // (4100-3300)/900 → 89%
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

describe("browser-direct capabilities", () => {
  const browserRadioState = () =>
    ({ kind: "webserial", state: "connected", error: null, privateSession: false, batteryMilliVolts: null }) as const;

  it("exposes full capabilities on the server driver and a narrow subset in browser mode", () => {
    const store = useAppStore();
    expect(store.capabilities).toMatchObject({
      sendMessages: true,
      sendAdvert: true,
      manageDevice: true,
      manageChannels: true,
      manageContacts: true,
      nodeTools: true,
      guidance: null,
    });

    store.browserRadio = { ...browserRadioState() };

    expect(store.capabilities).toMatchObject({
      sendMessages: true,
      sendAdvert: true,
      manageDevice: false,
      manageChannels: false,
      manageContacts: false,
      nodeTools: false,
    });
    expect(store.capabilities.guidance).toContain("driven by this browser");
  });

  it("rejects unsupported operations with guidance instead of a server 503", async () => {
    const store = useAppStore();
    store.browserRadio = { ...browserRadioState() };
    await expect(store.saveChannel(0, "x", "0".repeat(32))).rejects.toThrow(/driven by this browser/);
    await expect(store.deleteChannel(0)).rejects.toThrow(/driven by this browser/);
    await expect(store.loginToNode(KEY_A, "pw")).rejects.toThrow(/driven by this browser/);
    await expect(store.fetchNodeStatus(KEY_A)).rejects.toThrow(/driven by this browser/);
    await expect(store.fetchTelemetry(KEY_A)).rejects.toThrow(/driven by this browser/);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("reads live channels from the browser radio, then the server list after handback", async () => {
    apiMock.mockResolvedValue({ ok: true, state: "standby" });
    browserRadioMock.getChannels.mockResolvedValue([{ idx: 1, name: "Live", secret: "1".repeat(32) }]);
    const store = useAppStore();
    await store.startBrowserRadio("webserial", true);
    store.browserRadio!.state = "connected";

    apiMock.mockClear();
    await store.refreshChannels();
    expect(store.channels).toEqual([{ idx: 1, name: "Live", secret: "1".repeat(32) }]);
    expect(apiMock).not.toHaveBeenCalled(); // never the server's stored copy

    apiMock.mockResolvedValue({ channels: [{ idx: 0, name: "Server", secret: "0".repeat(32) }] });
    await store.stopBrowserRadio(false);
    expect(store.channels).toEqual([{ idx: 0, name: "Server", secret: "0".repeat(32) }]);
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

  it("applies duplicate message.new events without repeating side effects", () => {
    const store = useAppStore();
    const key = conversationKey({ kind: "dm", contactKey: KEY_A });
    store.onEvent({ type: "message.new", message: message({ id: 1 }) } as WsEvent);
    store.onEvent({ type: "message.new", message: message({ id: 2, kind: "channel", contactKey: null, channelIdx: 3 }) } as WsEvent);
    expect(store.unread[key]).toBe(1);
    expect(store.recent.map((m) => m.id)).toEqual([2, 1]);
    expect(notifyIncomingMock).toHaveBeenCalledTimes(2);

    store.onEvent({ type: "message.new", message: message({ id: 1 }) } as WsEvent); // redelivery

    expect(store.unread[key]).toBe(1); // unread counted once
    expect(store.recent.map((m) => m.id)).toEqual([2, 1]); // recent order untouched
    expect(store.conversations[key]).toHaveLength(1); // no duplicate row
    expect(notifyIncomingMock).toHaveBeenCalledTimes(2); // notified once per message
  });

  it("keeps duplicate unknown-sender events from re-adding the sender", () => {
    const store = useAppStore();
    const prefix = "abcdef123456";
    store.onEvent({ type: "message.new", message: message({ id: 1, contactKey: null, contactPrefix: prefix }) } as WsEvent);
    store.onEvent({ type: "message.new", message: message({ id: 1, contactKey: null, contactPrefix: prefix }) } as WsEvent);
    expect(store.unknownSenders).toHaveLength(1);
    expect(store.unread[conversationKey({ kind: "dm", contactPrefix: prefix })]).toBe(1);
  });

  it("preserves a delivery upgrade when a duplicate arrives with a stale status", () => {
    const store = useAppStore();
    const key = conversationKey({ kind: "dm", contactKey: KEY_A });
    store.appendMessage(message({ id: 1, direction: "out", status: "sent" }));
    store.updateMessageStatus(1, "delivered");

    store.onEvent({ type: "message.new", message: message({ id: 1, direction: "out", status: "sent" }) } as WsEvent);

    expect(store.conversations[key][0].status).toBe("delivered");
    expect(store.recent[0].status).toBe("delivered");
  });

  it("drops malformed message events instead of grouping them under a default conversation", () => {
    const store = useAppStore();
    // channel post without an index must not land in ch:0
    store.onEvent({ type: "message.new", message: message({ id: 1, kind: "channel", contactKey: null, channelIdx: null }) } as WsEvent);
    // dm without any sender identity must not land in dm:unknown:
    store.onEvent({ type: "message.new", message: message({ id: 2, contactKey: null, contactPrefix: null }) } as WsEvent);
    expect(store.conversations).toEqual({});
    expect(store.recent).toHaveLength(0);
    expect(store.unread).toEqual({});
    expect(notifyIncomingMock).not.toHaveBeenCalled();
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
