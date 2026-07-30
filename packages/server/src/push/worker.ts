import webpush from "web-push";
import type { WsEvent } from "@meshkeep/shared";
import type { Bus } from "../bus.js";
import type { PushSubscription, Store } from "../db/store.js";
import { logger } from "../logger.js";

const log = logger("push");
export const DEFAULT_PUSH_FAILURE_BURST = 5;
/** Best-effort rate limit: at most one send per subscription within this window (issue #76). */
export const DEFAULT_MIN_SEND_INTERVAL_MS = 10_000;

export interface PushPayload {
  title: string;
  body: string;
}

export class PushSendError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
  ) {
    super(message);
  }
}

export interface PushSender {
  send(subscription: PushSubscription, payload: PushPayload): Promise<void>;
}

/** Real Web Push delivery via VAPID; a dead endpoint surfaces as a PushSendError with its HTTP status. */
export function webPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify(payload),
        );
      } catch (error) {
        const statusCode =
          error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : null;
        throw new PushSendError(error instanceof Error ? error.message : "push send failed", statusCode);
      }
    },
  };
}

/**
 * Sensitive lock-screen content (sender, message text, contact identity,
 * measurements, thresholds) never leaves the server as a push payload — the
 * same privacy boundary the in-page notifications apply client-side (#75).
 * Only two generic, non-identifying notifications exist.
 */
export function genericPushPayload(event: WsEvent): PushPayload | null {
  if (event.type === "message.new" && event.message.direction === "in") {
    return { title: "New MeshKeep message", body: "Open MeshKeep to view." };
  }
  if (event.type === "telemetry.alert") {
    return {
      title: "MeshKeep telemetry alert",
      body: event.event.direction === "breach" ? "Open MeshKeep for details." : "Open MeshKeep — alert recovered.",
    };
  }
  return null;
}

/** Endpoints embed an opaque per-device push-service token; log only its origin. */
function redactEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "invalid-endpoint";
  }
}

export interface PushWorkerOptions {
  /** Consecutive send failures before a dead endpoint is removed (no operator to resume it, unlike a webhook). */
  failureBurst?: number;
  /** Minimum time between sends to the same endpoint — the "delivery rate limits" this prototype must have (issue #76). */
  minSendIntervalMs?: number;
  /** Seam for deterministic tests; defaults to the wall clock. */
  clock?: () => number;
}

/**
 * Best-effort Web Push delivery (issue #76 prototype). Deliberately has no
 * durable queue or retry: a push failure here is dropped, not scheduled for
 * another attempt, matching the "must not promise reliable, exactly-once, or
 * background-radio delivery" scope boundary. Reuses the same in-process bus
 * the webhook worker and browser WebSocket hub already subscribe to.
 */
export class PushWorker {
  private readonly failureBurst: number;
  private readonly minSendIntervalMs: number;
  private readonly clock: () => number;
  private readonly lastSentAt = new Map<string, number>();
  private unsubscribe: (() => void) | null;

  constructor(
    private readonly store: Store,
    bus: Bus,
    private readonly sender: PushSender,
    options: PushWorkerOptions = {},
  ) {
    this.failureBurst = options.failureBurst ?? DEFAULT_PUSH_FAILURE_BURST;
    this.minSendIntervalMs = options.minSendIntervalMs ?? DEFAULT_MIN_SEND_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
    this.unsubscribe = bus.subscribe((event) => void this.handle(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async handle(event: WsEvent): Promise<void> {
    const payload = genericPushPayload(event);
    if (!payload) return;
    await Promise.all(this.store.listPushSubscriptions().map((subscription) => this.deliver(subscription, payload)));
  }

  private async deliver(subscription: PushSubscription, payload: PushPayload): Promise<void> {
    const now = this.clock();
    const lastSent = this.lastSentAt.get(subscription.endpoint);
    if (lastSent !== undefined && now - lastSent < this.minSendIntervalMs) return;
    this.lastSentAt.set(subscription.endpoint, now);
    try {
      await this.sender.send(subscription, payload);
      this.store.clearPushFailureStreak(subscription.endpoint);
    } catch (error) {
      const statusCode = error instanceof PushSendError ? error.statusCode : null;
      if (statusCode === 404 || statusCode === 410) {
        // the push service has permanently discarded this endpoint
        this.store.deletePushSubscription(subscription.endpoint);
        log.warn("push.endpoint_gone", { endpoint: redactEndpoint(subscription.endpoint), statusCode });
        return;
      }
      const streak = this.store.recordPushFailure(subscription.endpoint, this.failureBurst);
      if (streak.removed) {
        log.warn("push.subscription_removed", {
          endpoint: redactEndpoint(subscription.endpoint),
          consecutiveFailures: streak.consecutiveFailures,
        });
      } else {
        log.warn("push.failed", {
          endpoint: redactEndpoint(subscription.endpoint),
          statusCode,
          consecutiveFailures: streak.consecutiveFailures,
        });
      }
    }
  }
}
