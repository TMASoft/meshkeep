import { describe, expect, it } from "vitest";
import { canSaveWebhook, dismissCopiedSecret } from "../src/api/webhook-ui";

describe("webhook sensitive and one-time-secret UX", () => {
  it("requires explicit confirmation only when sensitive content is enabled", () => {
    expect(canSaveWebhook({ includeSensitive: false, confirmSensitive: false, eventTypes: ["message.created"] })).toBe(true);
    expect(canSaveWebhook({ includeSensitive: true, confirmSensitive: false, eventTypes: ["message.created"] })).toBe(false);
    expect(canSaveWebhook({ includeSensitive: true, confirmSensitive: true, eventTypes: ["message.created"] })).toBe(true);
  });

  it("removes a copied signing secret from view state", () => {
    expect(dismissCopiedSecret("shown-once")).toBeNull();
  });
});
