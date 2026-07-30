import type { ConversationId } from "./stores/app";

export interface ConversationPreference {
  archived: boolean;
  muted: boolean;
}

export type ConversationPreferences = Record<string, ConversationPreference>;

const STORAGE_KEY = "meshkeep-conversation-preferences-v1";

/**
 * Channel slots are radio-local, so every preference is scoped to the selected
 * radio. Direct-message keys retain their stable public key, which preserves a
 * preference when a contact is renamed, removed, or added back.
 */
export function conversationPreferenceKey(radioId: number | null, id: ConversationId): string {
  const conversation = id.kind === "dm" ? `dm:${id.contactKey ?? `unknown:${id.contactPrefix}`}` : `ch:${id.channelIdx}`;
  return `radio:${radioId ?? "unknown"}:${conversation}`;
}

export function savedConversationPreferences(): ConversationPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const preferences: ConversationPreferences = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object" &&
        "archived" in value &&
        "muted" in value &&
        typeof value.archived === "boolean" &&
        typeof value.muted === "boolean"
      ) {
        preferences[key] = { archived: value.archived, muted: value.muted };
      }
    }
    return preferences;
  } catch {
    return {};
  }
}

export function saveConversationPreferences(preferences: ConversationPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preference updates still apply for this session when storage is unavailable.
  }
}

/** Local-data reset (#74). */
export function clearConversationPreferences(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing persisted to clear
  }
}
