import type { Message } from "@meshkeep/shared";
import { parseInlineSender } from "@meshkeep/shared";
import type { ConversationId } from "./stores/app";

/** off = never notify · dms = incoming DMs only · all = DMs + channel messages */
export type NotifyPref = "off" | "dms" | "all";

const STORAGE_KEY = "meshkeep-notify";

/** Notification API needs a secure context — same constraint as browser-direct (docs/https.md). */
export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined" && window.isSecureContext;
}

export function savedNotifyPref(): NotifyPref {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "dms" || value === "all" ? value : "off";
  } catch {
    return "off";
  }
}

export function saveNotifyPref(pref: NotifyPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // preference still applies for this session
  }
}

/** Request permission when turning notifications on. Returns whether usable. */
export async function requestNotifyPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

// App.vue registers a navigator so a notification click can route to the
// conversation without this module importing the router (or vice versa).
let navigate: ((id: ConversationId) => void) | null = null;

export function setNotificationNavigator(fn: (id: ConversationId) => void): void {
  navigate = fn;
}

/**
 * Notify for an incoming message when the tab is hidden or the conversation
 * isn't the active one. Messages arriving in the active, visible conversation
 * never notify (they're already on screen — mirrors the unread accounting).
 */
export function notifyIncoming(message: Message, opts: { conversationActive: boolean }): void {
  const pref = savedNotifyPref();
  if (pref === "off") return;
  if (message.direction !== "in") return;
  if (message.kind === "channel" && pref !== "all") return;
  if (!document.hidden && opts.conversationActive) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  const id: ConversationId =
    message.kind === "dm"
      ? { kind: "dm", contactKey: message.contactKey ?? "" }
      : { kind: "channel", channelIdx: message.channelIdx ?? 0 };
  // channel texts carry their sender inline as "name: msg" (group-text convention)
  const inline = message.kind === "channel" ? parseInlineSender(message.text) : null;
  const sender = inline?.sender ?? message.contactName ?? message.authorName ?? shortKey(message.contactKey);
  const title =
    message.kind === "dm" ? sender : `${message.channelName ?? `channel ${message.channelIdx}`} · ${sender}`;
  const text = inline?.text ?? message.text;
  const body = text.length > 140 ? `${text.slice(0, 139)}…` : text;

  try {
    // one notification per conversation: newer messages replace older ones
    const notification = new Notification(title, { body, tag: `meshkeep-${conversationTag(id)}` });
    notification.onclick = () => {
      window.focus();
      navigate?.(id);
      notification.close();
    };
  } catch {
    // some platforms (e.g. Android Chrome) only allow Notification via a
    // service worker — treat as unsupported rather than erroring the app
  }
}

function conversationTag(id: ConversationId): string {
  return id.kind === "dm" ? `dm-${id.contactKey}` : `ch-${id.channelIdx}`;
}

function shortKey(key: string | null | undefined): string {
  if (!key) return "Unknown sender";
  return `${key.slice(0, 8)}…`;
}
