import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pushAvailableOnServer,
  pushSubscribed,
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "../src/push";

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pushSupported", () => {
  it("requires serviceWorker, PushManager, and a secure context", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", { PushManager: class {}, isSecureContext: true });
    expect(pushSupported()).toBe(true);
  });

  it("is false without a secure context", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", { PushManager: class {}, isSecureContext: false });
    expect(pushSupported()).toBe(false);
  });

  it("is false without PushManager (e.g. Safari)", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", { isSecureContext: true });
    expect(pushSupported()).toBe(false);
  });
});

describe("pushAvailableOnServer", () => {
  it("is true when the server returns a VAPID public key", async () => {
    mockFetch(200, { publicKey: "abc" });
    expect(await pushAvailableOnServer()).toBe(true);
  });

  it("is false when the server reports push is not configured (404)", async () => {
    mockFetch(404, { error: "push is not configured" });
    expect(await pushAvailableOnServer()).toBe(false);
  });

  it("rethrows an unrelated failure (e.g. 401)", async () => {
    mockFetch(401, { error: "unauthorized" });
    await expect(pushAvailableOnServer()).rejects.toThrow("unauthorized");
  });
});

describe("subscribeToPush / pushSubscribed / unsubscribeFromPush", () => {
  function stubServiceWorker(registration: unknown) {
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration) } });
    vi.stubGlobal("window", { PushManager: class {}, isSecureContext: true, atob: (s: string) => globalThis.atob(s) });
  }

  it("does nothing when unsupported (no registration path taken)", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { isSecureContext: true });
    expect(await subscribeToPush()).toBe(false);
    expect(await pushSubscribed()).toBe(false);
    await expect(unsubscribeFromPush()).resolves.toBeUndefined();
  });

  it("subscribes via the existing registration and posts the subscription to the server", async () => {
    const subscribe = vi.fn().mockResolvedValue({
      toJSON: () => ({ endpoint: "https://push.example.test/ep-1", keys: { p256dh: "k", auth: "a" } }),
    });
    stubServiceWorker({ pushManager: { subscribe } });
    mockFetch(200, { publicKey: "AAAA" }); // fetch for the VAPID key
    const ok = await subscribeToPush();
    expect(ok).toBe(true);
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    );
    // the second fetch call posts the subscription
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toBe("/api/v1/push/subscribe");
    expect(JSON.parse(calls[1][1].body)).toEqual({
      endpoint: "https://push.example.test/ep-1",
      keys: { p256dh: "k", auth: "a" },
    });
  });

  it("returns false when the browser subscribe call fails (e.g. permission denied)", async () => {
    stubServiceWorker({ pushManager: { subscribe: vi.fn().mockRejectedValue(new Error("denied")) } });
    mockFetch(200, { publicKey: "AAAA" });
    expect(await subscribeToPush()).toBe(false);
  });

  it("pushSubscribed reflects whether a live subscription exists", async () => {
    stubServiceWorker({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } });
    expect(await pushSubscribed()).toBe(false);
  });

  it("unsubscribes both the server record and the browser subscription", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi.fn().mockResolvedValue({ endpoint: "https://push.example.test/ep-2", unsubscribe });
    stubServiceWorker({ pushManager: { getSubscription } });
    mockFetch(200, { ok: true });

    await unsubscribeFromPush();

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/push/subscribe",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ endpoint: "https://push.example.test/ep-2" }) }),
    );
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("unsubscribeFromPush is a no-op when there is no live subscription", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    stubServiceWorker({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } });
    await unsubscribeFromPush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
