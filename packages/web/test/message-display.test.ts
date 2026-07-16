import { describe, expect, it } from "vitest";
import type { Message } from "@meshkeep/shared";
import { displayMessage } from "../src/message-display";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    kind: "channel",
    contactKey: null,
    channelIdx: 0,
    direction: "in",
    text: "MCTA-Rak: Bing bong",
    senderTimestamp: 1,
    pathLen: null,
    status: "sent",
    createdAt: 1,
    ...overrides,
  };
}

describe("displayMessage", () => {
  it("uses an inline sender name for unsigned incoming channel messages", () => {
    expect(displayMessage(message())).toEqual({ sender: "MCTA-Rak", text: "Bing bong" });
  });

  it("keeps text intact when a known sender is available", () => {
    expect(displayMessage(message({ contactName: "Relay", text: "Relay: system status" }))).toEqual({
      sender: "Relay",
      text: "Relay: system status",
    });
  });

  it("does not treat a URL as an inline sender name", () => {
    expect(displayMessage(message({ text: "https://meshkeep.example" }))).toEqual({
      sender: "Unknown sender",
      text: "https://meshkeep.example",
    });
  });
});
