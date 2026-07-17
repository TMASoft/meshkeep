import { describe, expect, it, vi } from "vitest";
import { leaseDiscovery, type DiscoveryAdapter } from "../src/radio/ble-discovery.js";

function fakeAdapter(overrides: Partial<DiscoveryAdapter> & { discovering?: boolean } = {}): {
  adapter: DiscoveryAdapter;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn<() => Promise<void>>().mockResolvedValue();
  const stop = vi.fn<() => Promise<void>>().mockResolvedValue();
  const adapter: DiscoveryAdapter = {
    isDiscovering: vi.fn().mockResolvedValue(overrides.discovering ?? false),
    startDiscovery: overrides.startDiscovery ?? start,
    stopDiscovery: overrides.stopDiscovery ?? stop,
  };
  return { adapter, start, stop };
}

describe("leaseDiscovery", () => {
  it("starts discovery when idle and stops it on release", async () => {
    const { adapter, start, stop } = fakeAdapter({ discovering: false });
    const release = await leaseDiscovery(adapter);
    expect(start).toHaveBeenCalledOnce();
    await release();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not start or stop when another client is already discovering", async () => {
    const { adapter, start, stop } = fakeAdapter({ discovering: true });
    const release = await leaseDiscovery(adapter);
    expect(start).not.toHaveBeenCalled();
    await release();
    expect(stop).not.toHaveBeenCalled(); // we never owned it, so we must not stop it
  });

  it("treats a failed startDiscovery as not-owned and never stops", async () => {
    const startDiscovery = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("busy"));
    const { adapter, stop } = fakeAdapter({ discovering: false, startDiscovery });
    const release = await leaseDiscovery(adapter);
    expect(startDiscovery).toHaveBeenCalledOnce();
    await release();
    expect(stop).not.toHaveBeenCalled();
  });

  it("is idempotent — only the first release stops discovery", async () => {
    const { adapter, stop } = fakeAdapter({ discovering: false });
    const release = await leaseDiscovery(adapter);
    await release();
    await release();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("swallows a stopDiscovery rejection so cleanup never throws", async () => {
    const stopDiscovery = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("adapter gone"));
    const { adapter } = fakeAdapter({ discovering: false, stopDiscovery });
    const release = await leaseDiscovery(adapter);
    await expect(release()).resolves.toBeUndefined();
  });

  it("still stops discovery when the scan body fails (finally-release pattern)", async () => {
    const { adapter, stop } = fakeAdapter({ discovering: false });
    const release = await leaseDiscovery(adapter);
    // mirrors how scan/connect wrap their work: the body throws, finally releases
    await expect(
      (async () => {
        try {
          throw new Error("adapter.devices() failed");
        } finally {
          await release();
        }
      })(),
    ).rejects.toThrow("adapter.devices() failed");
    expect(stop).toHaveBeenCalledOnce();
  });
});
