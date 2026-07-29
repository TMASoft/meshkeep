import { createHmac, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { projectWsEvent, type WsEvent } from "@meshkeep/shared";
import type { Bus } from "../bus.js";
import { Store } from "../db/store.js";
import { createWebhookCrypto, type WebhookCrypto } from "./crypto.js";
import { logger } from "../logger.js";

const log = logger("webhook");
const MAX_ATTEMPTS = 10;
const MAX_AGE_SECONDS = 24 * 60 * 60;
const RETRY_AFTER_CAP_SECONDS = 6 * 60 * 60;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_FAILURE_BURST = 5;

/**
 * A fault of the subscription itself rather than of one delivery: the
 * destination failed SSRF revalidation, or its signing key is gone. Neither can
 * improve by retrying another event, so these disable immediately instead of
 * counting toward the recoverable failure burst.
 */
class WebhookPermanentFailure extends Error {
  constructor(
    readonly code: "destination_rejected" | "signing_key_unavailable",
  ) {
    super(code);
  }
}

export interface WebhookResolver {
  resolve(hostname: string): Promise<string[]>;
}

export interface WebhookTransportResult {
  status: number;
  headers?: Record<string, string | string[] | undefined>;
}

export interface WebhookTransport {
  post(input: {
    url: URL;
    address: string;
    headers: Record<string, string>;
    body: Buffer;
  }): Promise<WebhookTransportResult>;
}

export const systemWebhookResolver: WebhookResolver = {
  async resolve(hostname) {
    return (await dns.lookup(hostname, { all: true, verbatim: true })).map(
      (answer) => answer.address,
    );
  },
};

/** Dedicated HTTPS client: no proxy, no redirects, pinned lookup, bounded discarded response. */
export const systemWebhookTransport: WebhookTransport = {
  post({ url, address, headers, body }) {
    return new Promise((resolve, reject) => {
      let connectTimer: NodeJS.Timeout | null = null;
      const clearConnectTimer = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
      };
      const req = request(
        url,
        {
          method: "POST",
          headers,
          agent: false,
          timeout: 15_000,
          lookup: (_host, _options, callback) =>
            callback(null, address, isIP(address) === 6 ? 6 : 4),
        },
        (res) => {
          clearConnectTimer();
          let bytes = 0;
          let headerBytes = 0;
          for (const [key, value] of Object.entries(res.headers))
            headerBytes +=
              Buffer.byteLength(key) +
              Buffer.byteLength(
                Array.isArray(value) ? value.join(",") : (value ?? ""),
              );
          if (headerBytes > 32 * 1024)
            return res.destroy(
              new Error("webhook response headers exceed 32 KiB"),
            );
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 64 * 1024)
              res.destroy(new Error("webhook response body exceeds 64 KiB"));
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers }),
          );
          res.resume();
        },
      );
      req.once("socket", (socket) => {
        connectTimer = setTimeout(
          () => req.destroy(new Error("webhook connect timeout")),
          5_000,
        );
        socket.once("connect", clearConnectTimer);
      });
      req.setTimeout(15_000, () =>
        req.destroy(new Error("webhook request timeout")),
      );
      req.on("error", (error) => {
        clearConnectTimer();
        reject(error);
      });
      req.end(body);
    });
  },
};

export function validateWebhookDestination(raw: string): URL {
  if (raw.length === 0 || raw.length > 2048)
    throw new Error("webhook destination must be at most 2048 bytes");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid webhook destination");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !url.hostname
  ) {
    throw new Error(
      "webhook destination must be HTTPS on port 443 without credentials or fragments",
    );
  }
  const literalAddress = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literalAddress) && isForbiddenAddress(literalAddress))
    throw new Error("webhook destination resolves to a forbidden address");
  return url;
}

function ipv6Bytes(address: string): Uint8Array | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < groups.length; i++) {
    const value = Number.parseInt(groups[i]!, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** Reject local, multicast, documentation, CGNAT and provider metadata addresses. */
export function isForbiddenAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(address) === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    const isUnspecified = bytes.every((byte) => byte === 0);
    const isLoopback =
      bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    const isMappedIpv4 =
      bytes.slice(0, 10).every((byte) => byte === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;
    if (isMappedIpv4)
      return isForbiddenAddress(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    return (
      isUnspecified ||
      isLoopback ||
      (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) ||
      (bytes[0]! & 0xfe) === 0xfc ||
      bytes[0] === 0xff
    );
  }
  return true;
}

export function webhookSignature(
  secret: Buffer,
  timestamp: number,
  body: Buffer,
): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;
}

export function retryDelaySeconds(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    RETRY_AFTER_CAP_SECONDS,
    30 * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(Math.max(0, Math.min(0.999999, random())) * (ceiling + 1));
}

function retryAfterSeconds(
  value: string | string[] | undefined,
  nowMs: number,
): number | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return null;
  if (/^\d+$/.test(text))
    return Math.min(RETRY_AFTER_CAP_SECONDS, Number(text));
  const then = Date.parse(text);
  return Number.isFinite(then)
    ? Math.max(
        0,
        Math.min(RETRY_AFTER_CAP_SECONDS, Math.ceil((then - nowMs) / 1000)),
      )
    : null;
}

export interface WebhookWorkerOptions {
  /** Seam for deterministic tests; defaults to the wall clock in seconds. */
  clock?: () => number;
  /** Seam for deterministic retry jitter in tests. */
  random?: () => number;
  /** Consecutive terminal failures tolerated before the subscription pauses. */
  failureBurst?: number;
}

export class WebhookWorker {
  private readonly crypto: WebhookCrypto;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly failureBurst: number;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    bus: Bus,
    masterKey: Buffer | null,
    private readonly resolver: WebhookResolver,
    private readonly transport: WebhookTransport,
    options: WebhookWorkerOptions = {},
  ) {
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.random = options.random ?? Math.random;
    this.failureBurst = options.failureBurst ?? DEFAULT_FAILURE_BURST;
    if (masterKey === null)
      throw new Error(
        "MESHKEEP_WEBHOOK_MASTER_KEY is required for webhook delivery",
      );
    this.crypto = createWebhookCrypto(masterKey);
    this.unsubscribe = bus.subscribe((event) => this.enqueue(event));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), 1_000);
    this.timer.unref();
    void this.drain();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(event: WsEvent): void {
    for (const subscription of this.store.listActiveWebhookSubscriptions()) {
      const envelope = projectWsEvent(event, {
        id: randomUUID(),
        includeSensitive: subscription.includeSensitive,
        eventTypes: subscription.eventTypes as never,
        radioIds: subscription.radioIds ?? undefined,
      });
      if (!envelope || subscription.activeKeyId === null) continue;
      const body = Buffer.from(JSON.stringify(envelope), "utf8");
      const result = this.store.queueWebhookEvent({
        subscriptionId: subscription.id,
        keyId: subscription.activeKeyId,
        eventId: envelope.id,
        type: envelope.type,
        eventVersion: envelope.eventVersion,
        sourceRadioId: envelope.source.radioId,
        occurredAt: Math.floor(Date.parse(envelope.occurredAt) / 1000),
        body,
        now: this.clock(),
      });
      if (result === "queued") {
        log.info("webhook.enqueued", {
          subscriptionId: subscription.id,
          eventId: envelope.id,
          type: envelope.type,
        });
      } else if (result !== "subscription_not_active") {
        log.warn("webhook.dropped", {
          subscriptionId: subscription.id,
          eventId: envelope.id,
          type: envelope.type,
          reason: result,
        });
      }
    }
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.clock();
      this.store.pruneWebhookRetention(now - RETENTION_SECONDS, 100);
      this.store.pruneRetiredWebhookKeys(now - RETENTION_SECONDS, 100);
      const expired = this.store.expireStaleWebhookDeliveries(
        now - MAX_AGE_SECONDS,
        100,
      );
      if (expired > 0) log.warn("webhook.expired", { deliveries: expired });
      const deliveries = this.store.claimDueWebhookDeliveries(
        `webhook-${process.pid}`,
        now,
        30,
        10,
      );
      await Promise.all(
        deliveries.map((delivery) => this.deliver(delivery.id)),
      );
    } finally {
      this.running = false;
    }
  }

  private async deliver(deliveryId: number): Promise<void> {
    const job = this.store.getWebhookDeliveryJob(deliveryId);
    if (!job || job.state !== "leased" || job.subscriptionState !== "active")
      return;
    const now = this.clock();
    try {
      const url = validateWebhookDestination(job.destination);
      const answers = await this.resolver.resolve(url.hostname);
      if (answers.length === 0 || answers.some(isForbiddenAddress))
        throw new WebhookPermanentFailure("destination_rejected");
      const secret = this.store.getWebhookSigningKey(
        job.subscriptionId,
        job.keyId,
        this.crypto,
        now,
      );
      if (!secret) throw new WebhookPermanentFailure("signing_key_unavailable");
      const timestamp = now;
      const result = await this.transport.post({
        url,
        address: answers[0]!,
        body: job.body,
        headers: {
          "content-type": "application/json",
          "content-length": String(job.body.length),
          "meshkeep-event-id": job.eventId,
          "meshkeep-event-type": job.type,
          "meshkeep-event-version": String(job.eventVersion),
          "meshkeep-delivery-id": String(deliveryId),
          "meshkeep-timestamp": String(timestamp),
          "meshkeep-key-id": job.keyId,
          "meshkeep-signature": webhookSignature(secret, timestamp, job.body),
        },
      });
      if (result.status >= 200 && result.status < 300) {
        if (
          this.store.finishWebhookDelivery(deliveryId, {
            state: "delivered",
            completedAt: now,
            responseStatus: result.status,
            responseClass: "2xx",
            leaseOwner: job.leaseOwner,
          })
        ) {
          this.store.clearWebhookFailureStreak(job.subscriptionId);
          log.info("webhook.delivered", {
            subscriptionId: job.subscriptionId,
            eventId: job.eventId,
            deliveryId,
            status: result.status,
          });
        }
        return;
      }
      const retryable =
        result.status === 408 || result.status === 429 || result.status >= 500;
      this.recordFailure(
        job,
        deliveryId,
        now,
        result.status,
        retryable,
        retryAfterSeconds(result.headers?.["retry-after"], now * 1_000),
      );
    } catch (error) {
      if (error instanceof WebhookPermanentFailure) {
        this.recordFailure(job, deliveryId, now, null, false, null, error.code);
      } else if (
        error instanceof Error &&
        error.message.includes("webhook destination")
      ) {
        this.recordFailure(
          job,
          deliveryId,
          now,
          null,
          false,
          null,
          "destination_rejected",
        );
      } else {
        this.recordFailure(
          job,
          deliveryId,
          now,
          null,
          true,
          null,
          "transport_failure",
        );
      }
    }
  }

  private recordFailure(
    job: ReturnType<Store["getWebhookDeliveryJob"]> & {},
    deliveryId: number,
    now: number,
    status: number | null,
    retryable: boolean,
    retryAfter: number | null,
    detail?: string,
  ): void {
    if (!job) return;
    const exhausted =
      job.attemptCount >= MAX_ATTEMPTS ||
      (job.firstAttemptAt !== null &&
        now - job.firstAttemptAt >= MAX_AGE_SECONDS);
    if (!retryable || exhausted) {
      const finished = this.store.finishWebhookDelivery(deliveryId, {
        state: "failed",
        completedAt: now,
        responseStatus: status,
        responseClass:
          status === null ? "network" : `${Math.floor(status / 100)}xx`,
        errorSummary: detail ?? `HTTP ${status}`,
        leaseOwner: job.leaseOwner,
      });
      if (!finished) return;
      const reason = detail ?? `HTTP ${status}`;
      if (
        detail === "destination_rejected" ||
        detail === "signing_key_unavailable"
      ) {
        // Subscription-level fault: no future event can succeed, so stop hard
        // and drop the backlog rather than replaying it against a bad target.
        const dropped = this.store.disableWebhookSubscription(
          job.subscriptionId,
          reason,
        );
        log.warn("webhook.subscription_disabled", {
          subscriptionId: job.subscriptionId,
          deliveryId,
          reason,
          droppedDeliveries: dropped,
        });
      } else {
        // A receiver-side fault (4xx burst, or a delivery that exhausted its
        // retries) is recoverable: pause after the burst threshold and keep the
        // queue so a resume drains it.
        const streak = this.store.recordWebhookTerminalFailure(
          job.subscriptionId,
          reason,
          this.failureBurst,
        );
        if (streak.paused) {
          log.warn("webhook.subscription_paused", {
            subscriptionId: job.subscriptionId,
            deliveryId,
            reason,
            consecutiveFailures: streak.consecutiveFailures,
          });
        }
      }
      log.warn("webhook.failed", {
        subscriptionId: job.subscriptionId,
        eventId: job.eventId,
        deliveryId,
        status,
        reason: detail ?? "terminal",
      });
      return;
    }
    const delay =
      retryAfter ?? retryDelaySeconds(job.attemptCount, this.random);
    if (
      this.store.retryWebhookDelivery(
        deliveryId,
        now + delay,
        status,
        status === null ? "network" : `${Math.floor(status / 100)}xx`,
        detail ?? `HTTP ${status}`,
        job.leaseOwner,
      )
    ) {
      log.warn("webhook.retry_scheduled", {
        subscriptionId: job.subscriptionId,
        eventId: job.eventId,
        deliveryId,
        status,
        delaySeconds: delay,
      });
    }
  }
}
