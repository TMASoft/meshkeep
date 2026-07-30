import { describe, expect, it } from "vitest";
import { isCacheableRequest, staleCacheNames, STATIC_CACHE_PREFIX } from "../public/sw-cache-logic.js";

describe("staleCacheNames", () => {
  it("keeps the current build plus the single most recently created other one", () => {
    const names = [
      "meshkeep-static-v0",
      "meshkeep-static-v1",
      "meshkeep-static-v2", // current
      "unrelated-cache", // never managed by this worker
    ];
    // v1 (the immediately preceding build) is kept as the rollback cache; only v0 is stale
    expect(staleCacheNames(names, "meshkeep-static-v2")).toEqual(["meshkeep-static-v0"]);
  });

  it("deletes nothing on first activation with only the current cache present", () => {
    expect(staleCacheNames(["meshkeep-static-v1"], "meshkeep-static-v1")).toEqual([]);
  });

  it("never touches caches outside the managed prefix", () => {
    expect(staleCacheNames(["some-other-app-cache"], "meshkeep-static-v1")).toEqual([]);
  });

  it("uses the documented prefix", () => {
    expect(STATIC_CACHE_PREFIX).toBe("meshkeep-static-");
  });
});

describe("isCacheableRequest", () => {
  const origin = "https://meshkeep.example";

  it("accepts same-origin GET requests outside /api/", () => {
    const request = new Request(`${origin}/assets/app-abc123.js`, { method: "GET" });
    expect(isCacheableRequest(request, origin)).toBe(true);
  });

  it("rejects non-GET requests", () => {
    const request = new Request(`${origin}/assets/app.js`, { method: "POST" });
    expect(isCacheableRequest(request, origin)).toBe(false);
  });

  it("never caches API responses, keeping the server authoritative", () => {
    const request = new Request(`${origin}/api/v1/messages`, { method: "GET" });
    expect(isCacheableRequest(request, origin)).toBe(false);
  });

  it("rejects cross-origin requests (e.g. a basemap tile provider)", () => {
    const request = new Request("https://tiles.example/z/x/y.png", { method: "GET" });
    expect(isCacheableRequest(request, origin)).toBe(false);
  });
});
