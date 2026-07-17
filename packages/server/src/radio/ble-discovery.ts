/**
 * Explicit ownership for BlueZ discovery. Scan and connect both need discovery
 * running only transiently, and either can fail at several points; a lease
 * makes the ownership one thing to release. `leaseDiscovery` starts discovery
 * only when we aren't already piggybacking another client's scan, and returns
 * an idempotent release that stops discovery only if this lease started it.
 * Callers must release in a `finally` so no failure leaves discovery active.
 */

/** Structural subset of node-ble's Adapter used for discovery ownership. */
export interface DiscoveryAdapter {
  isDiscovering(): Promise<boolean>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
}

export type DiscoveryLease = () => Promise<void>;

export async function leaseDiscovery(adapter: DiscoveryAdapter): Promise<DiscoveryLease> {
  let started = false;
  if (!(await adapter.isDiscovering())) {
    try {
      await adapter.startDiscovery();
      started = true;
    } catch {
      // another BlueZ client is already discovering — its scan feeds us too
    }
  }
  return async () => {
    if (!started) return; // we never owned discovery, or already released it
    started = false;
    await adapter.stopDiscovery().catch(() => {});
  };
}
