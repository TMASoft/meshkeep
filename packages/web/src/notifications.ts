import type { Message, TelemetryAlertEvent } from "@meshkeep/shared";
import { displayMessage } from "./message-display";
import type { ConversationId } from "./stores/app";

/** off = never notify · dms = incoming DMs only · all = DMs + channel messages */
export type NotifyPref = "off" | "dms" | "all";

const STORAGE_KEY = "meshkeep-notify";
const DETAILS_STORAGE_KEY = "meshkeep-notify-details";

/** Notification API needs a secure context — same constraint as browser-direct (docs/https.md). */
export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined" && window.isSecureContext;
}

/**
 * Fallback prototype for notification display only, reached when a
 * page-owned Notification cannot be constructed (notably some Android
 * Chromium configurations). This does not register the worker — main.ts
 * registers it eagerly and unconditionally at startup as the versioned
 * static-asset cache worker (#74); this just reuses that same registration.
 */
async function showViaServiceWorker(title: string, options: NotificationOptions): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    await registration.showNotification(title, options);
  } catch {
    // Best-effort. The caller already treats notifications as unavailable
    // rather than making a received message path fail.
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

/** Local-data reset (#74): drop the saved preference so notifications default back to off. */
export function clearNotifyPref(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing persisted to clear
  }
}

/**
 * The "Show notification details" opt-in (#75, docs/pwa-feasibility.md). Off
 * by default: sender, channel, message text, location, identifiers,
 * measurements, and rule thresholds are sensitive lock-screen content and
 * require this separate, explicit consent.
 */
export function savedNotifyDetails(): boolean {
  try {
    return localStorage.getItem(DETAILS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveNotifyDetails(enabled: boolean): void {
  try {
    localStorage.setItem(DETAILS_STORAGE_KEY, String(enabled));
  } catch {
    // preference still applies for this session
  }
}

/** Reset on logout and local-data reset (#75) — never carries over to a new session. */
export function clearNotifyDetails(): void {
  try {
    localStorage.removeItem(DETAILS_STORAGE_KEY);
  } catch {
    // nothing persisted to clear
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

export interface NotificationContent {
  title: string;
  body: string;
}

/**
 * Sender, channel, message text, identifiers, and other conversation content
 * are sensitive lock-screen content (docs/pwa-feasibility.md) and only appear
 * when the user has separately opted into "Show notification details". The
 * default is a generic notification that reveals nothing about the message.
 */
export function messageNotificationContent(message: Message, showDetails: boolean): NotificationContent {
  if (!showDetails) {
    return { title: "New MeshKeep message", body: "Open MeshKeep to view." };
  }
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
  return { title, body };
}

/** Same privacy gating as messageNotificationContent, for a telemetry alert (issue #52). */
export function alertNotificationContent(event: TelemetryAlertEvent, showDetails: boolean): NotificationContent {
  if (!showDetails) {
    return {
      title: "MeshKeep telemetry alert",
      body: event.direction === "breach" ? "Open MeshKeep for details." : "Open MeshKeep — alert recovered.",
    };
  }
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
  return { title, body };
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
  const { title, body } = messageNotificationContent(message, savedNotifyDetails());

  // one notification per conversation: newer messages replace older ones.
  // The click handler only focuses/navigates the already-authenticated tab —
  // no conversation data travels in the notification payload or a URL.
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

  const { title, body } = alertNotificationContent(event, savedNotifyDetails());

  // one notification per rule: a later transition replaces the earlier one
  showNotification(title, { body, tag: `meshkeep-alert-${event.ruleId}` });
}

/**
 * Whether the UI should show "notifications are blocked" guidance: the saved
 * preference wants notifications, but the browser permission has been denied
 * (initially or revoked mid-session). Callers should re-check this whenever
 * the tab regains visibility, since permission can change via site settings
 * without any in-page event.
 */
export function notificationPermissionBlocked(): boolean {
  if (savedNotifyPref() === "off") return false;
  return notificationsSupported() && Notification.permission === "denied";
}

function conversationTag(id: ConversationId): string {
  return id.kind === "dm" ? `dm-${id.contactKey ?? `unknown-${id.contactPrefix}`}` : `ch-${id.channelIdx}`;
}

function shortKey(key: string | null | undefined): string {
  if (!key) return "Unknown sender";
  return `${key.slice(0, 8)}…`;
}
