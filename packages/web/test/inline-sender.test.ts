import { describe, expect, it } from "vitest";
import { parseInlineSender } from "@meshkeep/shared";

describe("parseInlineSender", () => {
  it("splits the MeshCore group-text convention", () => {
    expect(parseInlineSender("MCTA-Rak: Bing bong")).toEqual({ sender: "MCTA-Rak", text: "Bing bong" });
  });

  it("keeps colons inside the body intact", () => {
    expect(parseInlineSender("Alice: meet at 10:30: sharp")).toEqual({
      sender: "Alice",
      text: "meet at 10:30: sharp",
    });
  });

  it("handles multiline bodies", () => {
    expect(parseInlineSender("Bob: line one\nline two")).toEqual({ sender: "Bob", text: "line one\nline two" });
  });

  it("rejects URLs and text without the ': ' separator", () => {
    expect(parseInlineSender("https://example.com/x")).toBeNull();
    expect(parseInlineSender("see docs/https.md: details")).toBeNull(); // slash in would-be sender
    expect(parseInlineSender("no separator here")).toBeNull();
    expect(parseInlineSender("colon:but-no-space")).toBeNull();
  });

  it("rejects over-long senders, empty parts, and leading-newline names", () => {
    expect(parseInlineSender(`${"x".repeat(32)}: hi`)).toBeNull(); // > 31-char name limit
    expect(parseInlineSender(":  ")).toBeNull();
    expect(parseInlineSender("   : hi")).toBeNull();
    expect(parseInlineSender("a\nb: hi")).toBeNull();
  });
});
