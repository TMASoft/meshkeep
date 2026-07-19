/**
 * Crash containment for the BlueZ D-Bus connection.
 *
 * node-ble talks to BlueZ through dbus-next, whose `MessageBus` is an
 * EventEmitter. When the D-Bus transport dies — bluetoothd restarts, the socket
 * is torn down, the container loses the mount — dbus-next reports it by
 * emitting `error` on the bus. Node turns an `error` event with no listener
 * into an uncaught exception, so a recoverable radio-transport fault would take
 * the whole server down: HTTP, WebSocket clients, and the SQLite handle with
 * it. It also skips every cleanup path, which leaves BlueZ discovery running
 * (observed 2026-07-19: the adapter stayed `Discovering: yes` after the crash
 * and needed a power cycle).
 *
 * Attaching a listener is the entire fix — the failure becomes an ordinary
 * connect/disconnect error the reconnect policy already knows how to pace.
 * Kept separate from the transport so it is unit-testable without BlueZ.
 */

/** Structural subset of dbus-next's MessageBus that we need for error guarding. */
export interface BusErrorSource {
  on(event: "error", listener: (error: unknown) => void): unknown;
  off?(event: "error", listener: (error: unknown) => void): unknown;
  removeListener?(event: "error", listener: (error: unknown) => void): unknown;
}

/** Undo the guard. Safe to call more than once. */
export type DetachBusGuard = () => void;

/**
 * Listen for fatal D-Bus transport errors on `bus` and route them to `onError`
 * instead of letting Node abort the process. Returns a detach function so a
 * closed connection stops holding a listener on a discarded bus.
 *
 * A missing or non-EventEmitter bus is tolerated: node-ble does not document
 * `dbus` as public API, so the guard degrades to a no-op rather than breaking
 * the transport if the shape ever changes.
 */
export function attachBusErrorGuard(bus: BusErrorSource | undefined | null, onError: (error: Error) => void): DetachBusGuard {
  if (!bus || typeof bus.on !== "function") return () => {};
  const listener = (error: unknown) => {
    onError(error instanceof Error ? error : new Error(String(error ?? "D-Bus error")));
  };
  bus.on("error", listener);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    const remove = bus.off ?? bus.removeListener;
    remove?.call(bus, "error", listener);
  };
}
