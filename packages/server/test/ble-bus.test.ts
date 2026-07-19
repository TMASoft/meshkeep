import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachBusErrorGuard } from "../src/radio/ble-bus.js";

describe("attachBusErrorGuard", () => {
  it("reproduces the crash it prevents: an unguarded bus error throws", () => {
    const bus = new EventEmitter();
    // Node's documented behavior — an 'error' event with no listener is raised
    // as an exception. In the server this reached the top level and killed the
    // process, taking HTTP and SQLite down with the radio (2026-07-19).
    expect(() => bus.emit("error", new Error("Cannot send message, stream is closed"))).toThrow(
      /stream is closed/,
    );
  });

  it("captures the error instead of throwing once guarded", () => {
    const bus = new EventEmitter();
    const onError = vi.fn();
    attachBusErrorGuard(bus, onError);

    expect(() => bus.emit("error", new Error("Cannot send message, stream is closed"))).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("Cannot send message, stream is closed");
  });

  it("normalizes non-Error payloads so callers always get an Error", () => {
    const bus = new EventEmitter();
    const onError = vi.fn();
    attachBusErrorGuard(bus, onError);

    expect(() => bus.emit("error", "disconnected before authentication")).not.toThrow();
    const received = onError.mock.calls[0]![0] as Error;
    expect(received).toBeInstanceOf(Error);
    expect(received.message).toBe("disconnected before authentication");
  });

  it("stops delivering after detach, and detaching twice is safe", () => {
    const bus = new EventEmitter();
    const onError = vi.fn();
    const detach = attachBusErrorGuard(bus, onError);

    bus.emit("error", new Error("first"));
    expect(onError).toHaveBeenCalledOnce();

    detach();
    detach(); // idempotent
    expect(bus.listenerCount("error")).toBe(0);
    // back to unguarded: the emit throws again rather than silently reaching a
    // listener held by a connection that has already closed
    expect(() => bus.emit("error", new Error("second"))).toThrow(/second/);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not leak a listener per reconnect", () => {
    const bus = new EventEmitter();
    for (let i = 0; i < 20; i++) {
      const detach = attachBusErrorGuard(bus, () => {});
      detach();
    }
    expect(bus.listenerCount("error")).toBe(0);
  });

  it("degrades to a no-op when node-ble exposes no usable bus", () => {
    // `dbus` is undocumented on the node-ble session; if it ever disappears the
    // transport must keep working rather than throwing on startup
    expect(() => attachBusErrorGuard(undefined, () => {})()).not.toThrow();
    expect(() => attachBusErrorGuard(null, () => {})()).not.toThrow();
    expect(() => attachBusErrorGuard({} as never, () => {})()).not.toThrow();
  });

  it("removes the listener through removeListener when off is unavailable", () => {
    // older EventEmitter-likes expose only removeListener
    const inner = new EventEmitter();
    const bus = {
      on: (event: "error", listener: (error: unknown) => void) => inner.on(event, listener),
      removeListener: (event: "error", listener: (error: unknown) => void) => inner.removeListener(event, listener),
    };
    const detach = attachBusErrorGuard(bus, () => {});
    expect(inner.listenerCount("error")).toBe(1);
    detach();
    expect(inner.listenerCount("error")).toBe(0);
  });
});
