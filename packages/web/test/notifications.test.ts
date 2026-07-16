import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@meshkeep/shared";
import { notifyIncoming, setNotificationNavigator, savedNotifyPref } from "../src/notifications";

const constructed: { title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }[] =
  [];

class FakeNotification {
  static permission = "granted";
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    constructed.push(this as unknown as (typeof constructed)[number]);
  }
}

let pref = "off";
let hidden = false;
const focus = vi.fn();
const navigate = vi.fn();

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    kind: "dm",
    contactKey: "a".repeat(64),
    contactName: "Alice",
    channelIdx: null,
    channelName: null,
    direction: "in",
    text: "hello there",
    senderTimestamp: 1000,
    pathLen: null,
    status: "sent",
    createdAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  constructed.length = 0;
  FakeNotification.permission = "granted";
  pref = "off";
  hidden = false;
  focus.mockClear();
  navigate.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hidden: false });
  Object.defineProperty(globalThis.document, "hidden", { get: () => hidden, configurable: true });
  vi.stubGlobal("window", { isSecureContext: true, focus });
  vi.stubGlobal("localStorage", {
    getItem: () => pref,
    setItem: () => {},
  });
  setNotificationNavigator(navigate);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifyIncoming", () => {
  it("does nothing when the preference is off", () => {
    pref = "off";
    notifyIncoming(message(), { conversationActive: false });
    expect(constructed).toHaveLength(0);
  });

  it("notifies for a DM in an inactive conversation", () => {
    pref = "dms";
    notifyIncoming(message(), { conversationActive: false });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.title).toBe("Alice");
  });

  it("skips channel messages on the dms preference but notifies on all", () => {
    pref = "dms";
    const channelMessage = message({ kind: "channel", channelIdx: 3, channelName: "#test", contactKey: null });
    notifyIncoming(channelMessage, { conversationActive: false });
    expect(constructed).toHaveLength(0);
    pref = "all";
    notifyIncoming(channelMessage, { conversationActive: false });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.title).toContain("#test");
  });

  it("stays quiet for the active conversation while the tab is visible", () => {
    pref = "dms";
    notifyIncoming(message(), { conversationActive: true });
    expect(constructed).toHaveLength(0);
  });

  it("notifies for the active conversation when the tab is hidden", () => {
    pref = "dms";
    hidden = true;
    notifyIncoming(message(), { conversationActive: true });
    expect(constructed).toHaveLength(1);
  });

  it("never notifies for outgoing messages or without permission", () => {
    pref = "all";
    notifyIncoming(message({ direction: "out" }), { conversationActive: false });
    expect(constructed).toHaveLength(0);
    FakeNotification.permission = "denied";
    notifyIncoming(message(), { conversationActive: false });
    expect(constructed).toHaveLength(0);
  });

  it("uses the inline 'name: msg' sender for channel notifications", () => {
    pref = "all";
    notifyIncoming(
      message({ kind: "channel", channelIdx: 0, channelName: "Public", contactKey: null, contactName: null, text: "MCTA-Rak: Bing bong" }),
      { conversationActive: false },
    );
    expect(constructed[0]!.title).toBe("Public · MCTA-Rak");
    expect(constructed[0]!.options.body).toBe("Bing bong");
  });

  it("click focuses the window and navigates to the conversation", () => {
    pref = "dms";
    notifyIncoming(message(), { conversationActive: false });
    constructed[0]!.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ kind: "dm", contactKey: "a".repeat(64) });
  });

  it("treats a stored garbage preference as off", () => {
    pref = "banana";
    expect(savedNotifyPref()).toBe("off");
  });
});
