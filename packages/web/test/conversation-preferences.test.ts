import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationId } from "../src/stores/app";
import {
  conversationPreferenceKey,
  savedConversationPreferences,
  saveConversationPreferences,
} from "../src/conversation-preferences";

const dm: ConversationId = { kind: "dm", contactKey: "a".repeat(64) };
const channel: ConversationId = { kind: "channel", channelIdx: 3 };

let stored: string | null = null;

beforeEach(() => {
  stored = null;
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
  });
});

describe("conversation preferences", () => {
  it("scopes channel preferences to the radio while contact preferences survive contact changes", () => {
    expect(conversationPreferenceKey(1, channel)).not.toBe(conversationPreferenceKey(2, channel));
    expect(conversationPreferenceKey(1, dm)).toContain(`dm:${dm.contactKey}`);
  });

  it("persists valid archive and mute preferences across reloads", () => {
    const key = conversationPreferenceKey(1, dm);
    saveConversationPreferences({ [key]: { archived: true, muted: true } });

    expect(savedConversationPreferences()).toEqual({ [key]: { archived: true, muted: true } });
  });

  it("discards malformed persisted data rather than applying arbitrary settings", () => {
    stored = JSON.stringify({ valid: { archived: true, muted: false }, invalid: { archived: "yes" } });

    expect(savedConversationPreferences()).toEqual({ valid: { archived: true, muted: false } });
  });
});
