import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@meshkeep/shared";
import {
  alertNotificationContent,
  clearNotificationNavigator,
  clearNotifyDetails,
  clearNotifyPref,
  messageNotificationContent,
  notificationPermissionBlocked,
  notifyAlert,
  notifyIncoming,
  setNotificationNavigator,
  savedNotifyDetails,
  savedNotifyPref,
} from "../src/notifications";

const DETAILS_KEY = "meshkeep-notify-details";

const constructed: {
  title: string;
  options: NotificationOptions;
  onclick: (() => void) | null;
  close: () => void;
}[] = [];

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
let details = false;
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
  details = false;
  hidden = false;
  focus.mockClear();
  navigate.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hidden: false });
  Object.defineProperty(globalThis.document, "hidden", { get: () => hidden, configurable: true });
  vi.stubGlobal("window", { isSecureContext: true, focus });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === DETAILS_KEY ? (details ? "true" : null) : pref),
    setItem: () => {},
    removeItem: (key: string) => {
      if (key === DETAILS_KEY) details = false;
      else pref = "off";
    },
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
    // generic by default (#75) — no sender until the details opt-in is on
    expect(constructed[0]!.title).toBe("New MeshKeep message");
  });

  it("skips channel messages on the dms preference but notifies on all", () => {
    pref = "dms";
    const channelMessage = message({
      kind: "channel",
      channelIdx: 3,
      channelName: "#test",
      contactKey: null,
    });
    notifyIncoming(channelMessage, { conversationActive: false });
    expect(constructed).toHaveLength(0);
    pref = "all";
    notifyIncoming(channelMessage, { conversationActive: false });
    expect(constructed).toHaveLength(1);
  });

  it("parses an inline 'name: msg' sender on an unsigned channel message, matching the chat thread, when details are on", () => {
    pref = "all";
    details = true;
    const channelMessage = message({
      kind: "channel",
      channelIdx: 3,
      channelName: "#test",
      contactKey: null,
      contactName: null,
      text: "MCTA-Rak: Bing bong",
    });
    notifyIncoming(channelMessage, { conversationActive: false });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.title).toBe("#test · MCTA-Rak");
    expect(constructed[0]!.options.body).toBe("Bing bong");
  });

  it("keeps unread accounting separate by suppressing notifications for a muted conversation only", () => {
    pref = "all";
    notifyIncoming(message(), { conversationActive: false, muted: true });
    expect(constructed).toHaveLength(0);

    notifyIncoming(message({ id: 2 }), { conversationActive: false });
    expect(constructed).toHaveLength(1);
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

  it("uses the narrow service-worker fallback if page notifications throw", async () => {
    pref = "dms";
    details = true;
    class ThrowingNotification {
      static permission = "granted";
      constructor() {
        throw new Error("Use ServiceWorkerRegistration.showNotification() instead");
      }
    }
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const getRegistration = vi.fn().mockResolvedValue({ showNotification });
    vi.stubGlobal("Notification", ThrowingNotification);
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    notifyIncoming(message(), { conversationActive: false });
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledWith("Alice", expect.any(Object)));
    expect(getRegistration).toHaveBeenCalled();
  });

  it("does nothing if the eager cache-worker registration never happened (unsupported/insecure context)", async () => {
    pref = "dms";
    class ThrowingNotification {
      static permission = "granted";
      constructor() {
        throw new Error("Use ServiceWorkerRegistration.showNotification() instead");
      }
    }
    const getRegistration = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Notification", ThrowingNotification);
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    notifyIncoming(message(), { conversationActive: false });
    await vi.waitFor(() => expect(getRegistration).toHaveBeenCalled());
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

  it("does not navigate after the navigator is cleared on unmount", () => {
    pref = "dms";
    clearNotificationNavigator();
    notifyIncoming(message(), { conversationActive: false });
    expect(constructed).toHaveLength(1);
    // the notification still fires, but clicking it must not route through a
    // torn-down App instance
    constructed[0]!.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("clearNotifyPref", () => {
  it("resets the saved preference back to off (local-data reset, #74)", () => {
    pref = "all";
    expect(savedNotifyPref()).toBe("all");
    clearNotifyPref();
    expect(savedNotifyPref()).toBe("off");
  });
});

describe("notification content privacy (#75)", () => {
  function alertEvent(overrides: Partial<Parameters<typeof alertNotificationContent>[0]> = {}) {
    return {
      id: 1,
      ruleId: 9,
      contactKey: "a".repeat(64),
      contactName: "Base Camp",
      metric: "battery_mv",
      label: "Battery",
      value: 3200,
      threshold: 3400,
      comparator: "below" as const,
      direction: "breach" as const,
      ts: 1000,
      ...overrides,
    };
  }

  it("messageNotificationContent is generic by default and reveals nothing sensitive", () => {
    const content = messageNotificationContent(message(), false);
    expect(content).toEqual({ title: "New MeshKeep message", body: "Open MeshKeep to view." });
  });

  it("messageNotificationContent reveals sender and text only with details on", () => {
    const content = messageNotificationContent(message(), true);
    expect(content.title).toBe("Alice");
    expect(content.body).toBe("hello there");
  });

  it("alertNotificationContent is generic by default, hiding identifiers, measurements, and thresholds", () => {
    const content = alertNotificationContent(alertEvent(), false);
    expect(content.title).toBe("MeshKeep telemetry alert");
    expect(content.body).not.toContain("Base Camp");
    expect(content.body).not.toContain("3200");
    expect(content.body).not.toContain("3400");
  });

  it("alertNotificationContent reveals subject, value, and threshold only with details on", () => {
    const content = alertNotificationContent(alertEvent(), true);
    expect(content.title).toBe("Base Camp: Battery alert");
    expect(content.body).toBe("Battery is 3200 (below 3400)");
  });

  it("notifyAlert respects the same details opt-in as messages", () => {
    pref = "all";
    notifyAlert(alertEvent());
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.title).toBe("MeshKeep telemetry alert");

    details = true;
    notifyAlert(alertEvent({ id: 2 }));
    expect(constructed).toHaveLength(2);
    expect(constructed[1]!.title).toBe("Base Camp: Battery alert");
  });
});

describe("clearNotifyDetails", () => {
  it("resets the details opt-in back off (logout/local-data reset, #75)", () => {
    details = true;
    expect(savedNotifyDetails()).toBe(true);
    clearNotifyDetails();
    expect(savedNotifyDetails()).toBe(false);
  });
});

describe("notificationPermissionBlocked", () => {
  it("is false when the preference is off, even if permission was denied", () => {
    pref = "off";
    FakeNotification.permission = "denied";
    expect(notificationPermissionBlocked()).toBe(false);
  });

  it("is true once permission is denied while the preference wants notifications", () => {
    pref = "dms";
    FakeNotification.permission = "denied";
    expect(notificationPermissionBlocked()).toBe(true);
  });

  it("is false while permission is granted", () => {
    pref = "all";
    FakeNotification.permission = "granted";
    expect(notificationPermissionBlocked()).toBe(false);
  });
});
