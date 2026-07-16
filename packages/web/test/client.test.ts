import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api/client";

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  };
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("prefixes /api/v1, sends JSON headers, and returns the body", async () => {
    const fetch = mockFetch(200, { contacts: [] });
    const body = await api("/contacts");
    expect(body).toEqual({ contacts: [] });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/contacts",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("throws ApiError carrying the server's error message and status", async () => {
    mockFetch(401, { error: "unauthorized" });
    const failure = api("/status").catch((e: unknown) => e);
    const error = (await failure) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("unauthorized");
  });

  it("falls back to HTTP status when the error body is not JSON", async () => {
    mockFetch(502, undefined);
    const error = (await api("/status").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("HTTP 502");
  });

  it("passes through method and body options", async () => {
    const fetch = mockFetch(201, { message: {} });
    await api("/messages", { method: "POST", body: JSON.stringify({ kind: "dm" }) });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/messages",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ kind: "dm" }) }),
    );
  });
});
