import type { Message, TelemetryAlertEvent } from "@meshkeep/shared";
import { displayMessage } from "./message-display";
import type { ConversationId } from "./stores/app";

/** off = never notify · dms = incoming DMs only · all = DMs + channel messages */
export type NotifyPref = "off" | "dms" | "all";

const STORAGE_KEY = "meshkeep-notify";

/** Notification API needs a secure context — same constraint as browser-direct (docs/https.md). */
export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined" && window.isSecureContext;
}

/**
 * Deliberately narrow service-worker fallback prototype. It is only reached
 * when a page-owned Notification cannot be constructed (notably some Android
 * Chromium configurations). It does not add offline caching or Push support.
 */
async function showViaServiceWorker(title: string, options: NotificationOptions): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/notification-sw.js");
    await registration.showNotification(title, options);
  } catch {
    // Registration is best-effort. The caller already treats notifications as
    // unavailable rather than making a received message path fail.
  }
}

function showNotification(title: string, options: NotificationOptions, onClick?: () => void): void {
  try {
    const notification = new Notification(title, options);
    notification.onclick = onClick ?? null;
  } catch {
    void showViaServiceWorker(title, options);
  }
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
 * Drop the registered navigator (App unmount). Without this the module-global
 * callback keeps a stale App instance — and its router — alive, and a
 * notification click would route through the torn-down instance.
 */
export function clearNotificationNavigator(): void {
  navigate = null;
}

/**
 * Notify for an incoming message when the tab is hidden or the conversation
 * isn't the active one. Messages arriving in the active, visible conversation
 * never notify (they're already on screen — mirrors the unread accounting).
 */
export function notifyIncoming(
  message: Message,
  opts: { conversationActive: boolean; muted?: boolean },
): void {
  const pref = savedNotifyPref();
  if (pref === "off") return;
  if (message.direction !== "in") return;
  if (opts.muted) return;
  if (message.kind === "channel" && pref !== "all") return;
  if (!document.hidden && opts.conversationActive) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  const id: ConversationId =
    message.kind === "dm"
      ? message.contactKey
        ? { kind: "dm", contactKey: message.contactKey }
        : { kind: "dm", contactPrefix: message.contactPrefix ?? "" }
      : { kind: "channel", channelIdx: message.channelIdx ?? 0 };
  // channel texts carry their sender inline as "name: msg" (group-text convention);
  // displayMessage is the same helper the chat thread uses for this split (issue #22).
  const display = displayMessage(message);
  const sender =
    display.sender ??
    message.contactName ??
    message.authorName ??
    shortKey(message.contactKey ?? message.contactPrefix);
  const title =
    message.kind === "dm" ? sender : `${message.channelName ?? `channel ${message.channelIdx}`} · ${sender}`;
  const body = display.text.length > 140 ? `${display.text.slice(0, 139)}…` : display.text;

  // one notification per conversation: newer messages replace older ones
  showNotification(title, { body, tag: `meshkeep-${conversationTag(id)}` }, () => {
    window.focus();
    navigate?.(id);
  });
}

/**
 * Notify for a telemetry threshold transition (issue #52). Gated on the same
 * on/off preference as message notifications — turning notifications off
 * should silence everything, not just messages.
 */
export function notifyAlert(event: TelemetryAlertEvent): void {
  if (savedNotifyPref() === "off") return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  const subject = event.contactName ?? (event.contactKey ? shortKey(event.contactKey) : "This radio");
  const comparison = event.comparator === "below" ? "below" : "above";
  const title =
    event.direction === "breach"
      ? `${subject}: ${event.label} alert`
      : `${subject}: ${event.label} recovered`;
  const body =
    event.direction === "breach"
      ? `${event.label} is ${event.value} (${comparison} ${event.threshold})`
      : `${event.label} is back to ${event.value}`;

  // one notification per rule: a later transition replaces the earlier one
  showNotification(title, { body, tag: `meshkeep-alert-${event.ruleId}` });
}

function conversationTag(id: ConversationId): string {
  return id.kind === "dm" ? `dm-${id.contactKey ?? `unknown-${id.contactPrefix}`}` : `ch-${id.channelIdx}`;
}

function shortKey(key: string | null | undefined): string {
  if (!key) return "Unknown sender";
  return `${key.slice(0, 8)}…`;
}
