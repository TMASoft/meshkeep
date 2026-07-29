import { afterEach, describe, expect, it, vi } from "vitest";
import { webhookApi, safeDeliveryFailure } from "../src/api/webhooks";

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhook API", () => {
  it("uses session API calls for management and preserves explicit sensitive confirmation", async () => {
    const fetch = mockFetch(201, {
      subscription: { id: 7, label: "ops", destination: "https://hooks.example.test/inbound", eventTypes: ["message.created"], radioIds: [3], includeSensitive: true, state: "active", createdAt: 1, updatedAt: 1 },
      signingSecret: "shown-once",
    });

    await webhookApi.create({
      label: "ops",
      destination: "https://hooks.example.test/inbound",
      eventTypes: ["message.created"],
      radioIds: [3],
      includeSensitive: true,
      confirmSensitive: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/webhooks",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          label: "ops",
          destination: "https://hooks.example.test/inbound",
          eventTypes: ["message.created"],
          radioIds: [3],
          includeSensitive: true,
          confirmSensitive: true,
        }),
      }),
    );
  });

  it("calls rotation, test, pause, and redacted delivery endpoints", async () => {
    const fetch = mockFetch(200, { signingSecret: "shown-once", deliveries: [] });
    await webhookApi.rotate(7);
    await webhookApi.test(7);
    await webhookApi.update(7, { state: "paused" });
    await webhookApi.deliveries(7, "failed");

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/webhooks/7/rotate-secret",
      "/api/v1/webhooks/7/test",
      "/api/v1/webhooks/7",
      "/api/v1/webhooks/7/deliveries?state=failed",
    ]);
  });
});

describe("redacted delivery display", () => {
  it("exposes only state and approved redacted failure fields", () => {
    const failure = safeDeliveryFailure({
      state: "failed",
      attemptCount: 3,
      responseStatus: 502,
      responseClass: "5xx",
      errorSummary: "upstream rejected request",
      payload: "must never be rendered",
      signingHeaders: { "x-meshkeep-signature": "must never be rendered" },
      responseBody: "must never be rendered",
    });

    expect(failure).toEqual({ state: "failed", attemptCount: 3, responseStatus: 502, responseClass: "5xx", errorSummary: "upstream rejected request" });
    expect(JSON.stringify(failure)).not.toContain("must never be rendered");
  });
});
