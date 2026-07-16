import { describe, expect, it } from "vitest";
import {
  PUBLIC_CHANNEL_SECRET_HEX,
  buildChannelShareUri,
  channelSecretToBase64,
  deriveHashtagChannelSecret,
  isHashtagChannelName,
  normalizeChannelSecret,
  parseChannelShareUri,
} from "@meshkeep/shared";

describe("hashtag channel key derivation", () => {
  // documented vector: docs/companion_protocol.md "Channel Types"
  it("matches the official #test vector", async () => {
    expect(await deriveHashtagChannelSecret("#test")).toBe("9cd8fcf22a47333b591d96a2b848b73f");
  });

  it("includes the leading # in the digest", async () => {
    expect(await deriveHashtagChannelSecret("test")).not.toBe(await deriveHashtagChannelSecret("#test"));
  });

  it("detects hashtag names", () => {
    expect(isHashtagChannelName("#vermont")).toBe(true);
    expect(isHashtagChannelName("Public")).toBe(false);
  });
});

describe("normalizeChannelSecret", () => {
  it("accepts 32 hex chars, lowercasing", () => {
    expect(normalizeChannelSecret("8B3387E9C5CDEA6AC9E5EDBAA115CD72")).toBe(PUBLIC_CHANNEL_SECRET_HEX);
  });

  it("accepts the official app's base64 form (Public channel)", () => {
    expect(normalizeChannelSecret("izOH6cXN6mrJ5e26oRXNcg==")).toBe(PUBLIC_CHANNEL_SECRET_HEX);
    expect(normalizeChannelSecret("izOH6cXN6mrJ5e26oRXNcg")).toBe(PUBLIC_CHANNEL_SECRET_HEX);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeChannelSecret("  izOH6cXN6mrJ5e26oRXNcg==\n")).toBe(PUBLIC_CHANNEL_SECRET_HEX);
  });

  it("rejects wrong lengths and garbage", () => {
    expect(normalizeChannelSecret("abcd")).toBeNull();
    expect(normalizeChannelSecret("not a key at all!")).toBeNull();
    expect(normalizeChannelSecret("")).toBeNull();
  });
});

describe("channelSecretToBase64", () => {
  it("round-trips the Public channel key", () => {
    expect(channelSecretToBase64(PUBLIC_CHANNEL_SECRET_HEX)).toBe("izOH6cXN6mrJ5e26oRXNcg==");
  });
});

describe("channel share URIs", () => {
  // documented example: docs/qr_codes.md "Add Channel"
  it("parses the official example", () => {
    expect(parseChannelShareUri("meshcore://channel/add?name=Public&secret=8b3387e9c5cdea6ac9e5edbaa115cd72")).toEqual({
      name: "Public",
      secret: PUBLIC_CHANNEL_SECRET_HEX,
    });
  });

  it("decodes url-encoded and plus-encoded names, ignores region_scope", () => {
    expect(
      parseChannelShareUri("meshcore://channel/add?name=My+Chan%21&secret=izOH6cXN6mrJ5e26oRXNcg==&region_scope=US"),
    ).toEqual({ name: "My Chan!", secret: PUBLIC_CHANNEL_SECRET_HEX });
  });

  it("rejects contact links, bad secrets, and non-meshcore URIs", () => {
    expect(parseChannelShareUri("meshcore://contact/add?name=x&public_key=ab&type=1")).toBeNull();
    expect(parseChannelShareUri("meshcore://channel/add?name=x&secret=nope")).toBeNull();
    expect(parseChannelShareUri("https://example.com/?name=x&secret=8b3387e9c5cdea6ac9e5edbaa115cd72")).toBeNull();
  });

  it("builds a link the parser accepts", () => {
    const uri = buildChannelShareUri("My Chan!", PUBLIC_CHANNEL_SECRET_HEX);
    expect(parseChannelShareUri(uri)).toEqual({ name: "My Chan!", secret: PUBLIC_CHANNEL_SECRET_HEX });
  });
});
