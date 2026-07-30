import { api, ApiError } from "./api/client";

/**
 * Web Push subscription lifecycle (issue #76 prototype). Deliberately
 * best-effort: no promise of reliable, exactly-once, or background-radio
 * delivery. Payloads are always server-generated and generic (never sender,
 * message text, or telemetry values), matching the in-page notification
 * privacy boundary (#75) — there's nothing sensitive for a compromised
 * endpoint to leak.
 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    window.isSecureContext
  );
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Whether the server has VAPID keys configured at all (feature availability, not subscription state). */
export async function pushAvailableOnServer(): Promise<boolean> {
  try {
    await api("/push/vapid-public-key");
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** Whether this browser currently holds a live push subscription. */
export async function pushSubscribed(): Promise<boolean> {
  const registration = await getRegistration();
  if (!registration) return false;
  return (await registration.pushManager.getSubscription()) !== null;
}

/** Subscribe this browser and register it with the server. Returns whether it succeeded. */
export async function subscribeToPush(): Promise<boolean> {
  const registration = await getRegistration();
  if (!registration) return false;
  try {
    const { publicKey } = await api<{ publicKey: string }>("/push/vapid-public-key");
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await api("/push/subscribe", { method: "POST", body: JSON.stringify(json) });
    return true;
  } catch {
    return false;
  }
}

/** Unsubscribe this browser, both from the push service and the server's record. */
export async function unsubscribeFromPush(): Promise<void> {
  const registration = await getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api("/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(
    () => {
      // best-effort — the browser-side unsubscribe below still stops local delivery
    },
  );
  await subscription.unsubscribe().catch(() => {});
}
