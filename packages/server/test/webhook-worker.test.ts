import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/bus.js";
import { openDb } from "../src/db/index.js";
import { Store } from "../src/db/store.js";
import { clearLogs, recentLogs, setLogLevel } from "../src/logger.js";
import { createWebhookCrypto } from "../src/webhooks/crypto.js";
import {
  isForbiddenAddress,
  retryDelaySeconds,
  validateWebhookDestination,
  WebhookWorker,
  webhookSignature,
  type WebhookResolver,
  type WebhookTransport,
  type WebhookTransportResult,
} from "../src/webhooks/worker.js";

const masterKey = Buffer.alloc(32, 7);
const signingSecret = Buffer.alloc(32, 9);
const now = 1_700_000_000;
type WebhookRequest = Parameters<WebhookTransport["post"]>[0];

class FakeResolver implements WebhookResolver {
  readonly hostnames: string[] = [];

  constructor(private readonly answers: string[]) {}

  async resolve(hostname: string): Promise<string[]> {
    this.hostnames.push(hostname);
    return this.answers;
  }
}

class FakeTransport implements WebhookTransport {
  readonly requests: WebhookRequest[] = [];

  constructor(
    private readonly outcomes: Array<WebhookTransportResult | Error> = [
      { status: 204 },
    ],
  ) {}

  async post(input: WebhookRequest): Promise<WebhookTransportResult> {
    this.requests.push(input);
    const outcome = this.outcomes.shift() ?? { status: 204 };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function setup(destination = "https://hooks.example.test/meshkeep") {
  const db = openDb(":memory:", masterKey);
  const store = new Store(db);
  const subscription = store.createWebhookSubscription({
    label: "Home Assistant",
    destination,
    eventTypes: ["message.status_changed"],
    radioIds: [1],
    includeSensitive: false,
  });
  store.createWebhookSigningKey(
    subscription.id,
    "key-1",
    signingSecret,
    createWebhookCrypto(masterKey),
  );
  const bus = new Bus();
  return { db, store, subscription, bus };
}

function publishDueEvent(bus: Bus): void {
  bus.publish({ type: "message.status", radioId: 1, id: 42, status: "sent" });
}

afterEach(() => {
  clearLogs();
  setLogLevel("error");
});

describe("webhook delivery security primitives", () => {
  it("rejects every forbidden literal destination class and accepts a public HTTPS endpoint", () => {
    for (const destination of [
      "http://public.example.test/hook",
      "https://user:pass@public.example.test/hook",
      "https://public.example.test:8443/hook",
      "https://public.example.test/hook#fragment",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
    ]) {
      expect(() => validateWebhookDestination(destination)).toThrow();
    }
    expect(
      validateWebhookDestination("https://hooks.example.test/meshkeep")
        .hostname,
    ).toBe("hooks.example.test");
  });

  it("rejects every local, metadata, documentation, multicast, and mapped-address SSRF class", () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "172.16.0.1",
      "192.0.0.1",
      "192.168.0.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:7f00:1",
      "::ffff:0a00:1",
      "::ffff:a9fe:a9fe",
      "fe80::1",
      "fc00::1",
      "ff02::1",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    expect(isForbiddenAddress("93.184.216.34")).toBe(false);
    expect(isForbiddenAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(
      false,
    );
  });

  it("signs the exact immutable raw delivery bytes using the pinned DNS address", async () => {
    const { db, store, bus } = setup();
    const resolver: WebhookResolver = {
      resolve: async () => ["93.184.216.34"],
    };
    const requests: WebhookRequest[] = [];
    const transport: WebhookTransport = {
      post: async (input) => (requests.push(input), { status: 204 }),
    };
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      resolver,
      transport,
      { clock: () => now, random: () => 0.5 },
    );

    publishDueEvent(bus);
    await worker.drain();

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.address).toBe("93.184.216.34");
    expect(request.headers["meshkeep-signature"]).toBe(
      webhookSignature(signingSecret, now, request.body),
    );
    expect(request.headers["meshkeep-event-id"]).toBe(
      JSON.parse(request.body.toString("utf8")).id,
    );
    expect(
      store.listWebhookDeliveries({ subscriptionId: 1, limit: 10 })[0]?.state,
    ).toBe("delivered");
    worker.stop();
    db.close();
  });

  it("terminates a DNS-rebinding-safe forbidden answer without invoking transport", async () => {
    const { db, store, bus, subscription } = setup();
    const resolver: WebhookResolver = {
      resolve: async () => ["93.184.216.34", "::ffff:7f00:1"],
    };
    const transport: WebhookTransport = {
      post: async () => {
        throw new Error("must not connect");
      },
    };
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      resolver,
      transport,
      { clock: () => now },
    );

    publishDueEvent(bus);
    await worker.drain();

    expect(store.getWebhookSubscription(subscription.id)?.state).toBe(
      "disabled",
    );
    expect(
      store.listWebhookDeliveries({
        subscriptionId: subscription.id,
        limit: 10,
      })[0],
    ).toMatchObject({ state: "failed", errorSummary: "destination_rejected" });
    worker.stop();
    db.close();
  });

  it("retries network failures with bounded jitter without leaking transport errors into records or logs", async () => {
    const { db, store, bus, subscription } = setup();
    const resolver: WebhookResolver = {
      resolve: async () => ["93.184.216.34"],
    };
    const transport: WebhookTransport = {
      post: async () => {
        throw new Error("payload-super-secret");
      },
    };
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      resolver,
      transport,
      { clock: () => now, random: () => 0.5 },
    );

    publishDueEvent(bus);
    await worker.drain();

    const delivery = store.listWebhookDeliveries({
      subscriptionId: subscription.id,
      limit: 10,
    })[0]!;
    expect(delivery).toMatchObject({
      state: "queued",
      attemptCount: 1,
      errorSummary: "transport_failure",
    });
    expect(delivery.nextAttemptAt).toBe(now + 15);
    expect(JSON.stringify(recentLogs())).not.toContain("payload-super-secret");
    worker.stop();
    db.close();
  });

  it("treats redirects as terminal rather than following them and caps Retry-After", async () => {
    const { db, store, bus, subscription } = setup();
    const resolver: WebhookResolver = {
      resolve: async () => ["93.184.216.34"],
    };
    const redirectTransport: WebhookTransport = {
      post: async () => ({
        status: 302,
        headers: { location: "https://elsewhere.example.test/" },
      }),
    };
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      resolver,
      redirectTransport,
      { clock: () => now },
    );
    publishDueEvent(bus);
    await worker.drain();
    // Terminal for this delivery, but one redirect is not a subscription fault:
    // it counts toward the burst and leaves the subscription serving.
    expect(store.getWebhookSubscription(subscription.id)).toMatchObject({
      state: "active",
      consecutiveFailures: 1,
    });
    expect(
      store.listWebhookDeliveries({
        subscriptionId: subscription.id,
        limit: 10,
      })[0],
    ).toMatchObject({ state: "failed", responseStatus: 302 });
    worker.stop();
    db.close();

    const retry = setup();
    const retryWorker = new WebhookWorker(
      retry.store,
      retry.bus,
      masterKey,
      resolver,
      {
        post: async () => ({
          status: 429,
          headers: { "retry-after": "999999" },
        }),
      },
      { clock: () => now },
    );
    publishDueEvent(retry.bus);
    await retryWorker.drain();
    expect(
      retry.store.listWebhookDeliveries({
        subscriptionId: retry.subscription.id,
        limit: 10,
      })[0]?.nextAttemptAt,
    ).toBe(now + 6 * 60 * 60);
    retryWorker.stop();
    retry.db.close();
  });

  it("calculates date-form Retry-After from the worker clock, not host wall time", async () => {
    const { db, store, bus, subscription } = setup();
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      { resolve: async () => ["93.184.216.34"] },
      {
        post: async () => ({
          status: 503,
          headers: {
            "retry-after": new Date((now + 90) * 1_000).toUTCString(),
          },
        }),
      },
      { clock: () => now },
    );

    publishDueEvent(bus);
    await worker.drain();

    expect(
      store.listWebhookDeliveries({ subscriptionId: subscription.id, limit: 10 })[0]
        ?.nextAttemptAt,
    ).toBe(now + 90);
    worker.stop();
    db.close();
  });

  it("uses full jitter bounded by exponential retry ceilings", () => {
    expect(retryDelaySeconds(1, () => 0)).toBe(0);
    expect(retryDelaySeconds(1, () => 0.999999)).toBeLessThanOrEqual(30);
    expect(retryDelaySeconds(20, () => 0.999999)).toBeLessThanOrEqual(
      6 * 60 * 60,
    );
  });

  it("matches the documented v1 HMAC fixture", () => {
    const body = Buffer.from('{"id":"evt-1","type":"message.created"}');
    expect(webhookSignature(signingSecret, now, body)).toBe(
      `v1=${createHmac("sha256", signingSecret).update(`${now}.`).update(body).digest("hex")}`,
    );
  });

  it("retries an ambiguously delivered event with immutable bytes while allowing a newer event to arrive first", async () => {
    const { db, store, bus } = setup();
    let clock = now;
    const resolver = new FakeResolver(["93.184.216.34"]);
    const transport = new FakeTransport([
      new Error("receiver disconnected after accepting sensitive bytes"),
      { status: 204 },
      { status: 204 },
    ]);
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      resolver,
      transport,
      { clock: () => clock, random: () => 0.5 },
    );

    publishDueEvent(bus);
    await worker.drain();
    const first = transport.requests[0]!;

    clock = now + 5;
    publishDueEvent(bus);
    await worker.drain();
    const newer = transport.requests[1]!;

    clock = now + 15;
    await worker.drain();
    const retried = transport.requests[2]!;

    expect(transport.requests).toHaveLength(3);
    expect(newer.headers["meshkeep-event-id"]).not.toBe(
      first.headers["meshkeep-event-id"],
    );
    expect(retried.headers["meshkeep-event-id"]).toBe(
      first.headers["meshkeep-event-id"],
    );
    expect(retried.body.equals(first.body)).toBe(true);
    expect(resolver.hostnames).toEqual([
      "hooks.example.test",
      "hooks.example.test",
      "hooks.example.test",
    ]);
    worker.stop();
    db.close();
  });

  it("caps repeated transport failures at ten attempts without creating retry-amplification deliveries", async () => {
    const { db, store, bus, subscription } = setup();
    const transport = new FakeTransport(
      Array.from({ length: 10 }, () => new Error("receiver unavailable")),
    );
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      new FakeResolver(["93.184.216.34"]),
      transport,
      { clock: () => now, random: () => 0 },
    );

    publishDueEvent(bus);
    for (let attempt = 0; attempt < 10; attempt++) await worker.drain();

    expect(transport.requests).toHaveLength(10);
    expect(
      store.listWebhookDeliveries({ subscriptionId: subscription.id, limit: 10 }),
    ).toEqual([
      expect.objectContaining({
        state: "failed",
        attemptCount: 10,
        errorSummary: "transport_failure",
      }),
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM webhook_events").get(),
    ).toEqual({ count: 1 });
    worker.stop();
    db.close();
  });

  it("keeps a subscription serving through a 4xx burst below the threshold and preserves its backlog on pause", async () => {
    const { db, store, bus, subscription } = setup();
    let clock = now;
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      new FakeResolver(["93.184.216.34"]),
      new FakeTransport(Array.from({ length: 8 }, () => ({ status: 404 }))),
      { clock: () => clock, random: () => 0, failureBurst: 3 },
    );

    // One delivery is claimed per subscription per drain, so each pass is one
    // terminal failure. The first two leave the subscription serving.
    for (let i = 0; i < 2; i++) {
      publishDueEvent(bus);
      await worker.drain();
      clock += 1;
    }
    expect(store.getWebhookSubscription(subscription.id)).toMatchObject({
      state: "active",
      consecutiveFailures: 2,
    });

    // A third publish enqueues normally, then its failure trips the burst.
    publishDueEvent(bus);
    const queuedBefore = store.listWebhookDeliveries({
      subscriptionId: subscription.id,
      state: "queued",
      limit: 10,
    }).length;
    expect(queuedBefore).toBe(1);
    await worker.drain();
    clock += 1;

    expect(store.getWebhookSubscription(subscription.id)).toMatchObject({
      state: "paused",
      consecutiveFailures: 3,
      lastFailureSummary: "HTTP 404",
    });

    // A pause stops new enqueueing and scheduled delivery without dropping the
    // queue: a fourth event is refused, and a drain claims nothing.
    publishDueEvent(bus);
    await worker.drain();
    expect(
      store.listWebhookDeliveries({ subscriptionId: subscription.id, limit: 20 }),
    ).toHaveLength(3);
    expect(
      store
        .listWebhookDeliveries({ subscriptionId: subscription.id, limit: 20 })
        .filter((delivery) => delivery.state === "dropped"),
    ).toHaveLength(0);
    worker.stop();
    db.close();
  });

  it("resumes a paused subscription, drains the retained backlog, and resets the streak on success", async () => {
    const { db, store, bus, subscription } = setup();
    let clock = now;
    const transport = new FakeTransport([
      { status: 404 },
      { status: 404 },
      { status: 204 },
    ]);
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      new FakeResolver(["93.184.216.34"]),
      transport,
      { clock: () => clock, random: () => 0, failureBurst: 2 },
    );

    // Three events arrive in a burst while the subscription is still active; a
    // drain claims one per subscription, so the third is still queued when the
    // second failure trips the threshold.
    for (let i = 0; i < 3; i++) publishDueEvent(bus);
    await worker.drain();
    clock += 1;
    await worker.drain();
    clock += 1;
    expect(store.getWebhookSubscription(subscription.id)?.state).toBe("paused");

    // The operator fixes the receiver and resumes. The retained queued delivery
    // is claimable again, and delivering it clears the streak and the reason.
    const retained = store.listWebhookDeliveries({
      subscriptionId: subscription.id,
      state: "queued",
      limit: 10,
    });
    expect(retained).toHaveLength(1);

    const existing = store.getWebhookSubscription(subscription.id)!;
    store.updateWebhookSubscription(subscription.id, {
      label: existing.label,
      destination: existing.destination,
      eventTypes: existing.eventTypes,
      radioIds: existing.radioIds,
      includeSensitive: existing.includeSensitive,
      state: "active",
    });
    expect(store.getWebhookSubscription(subscription.id)).toMatchObject({
      consecutiveFailures: 0,
      lastFailureSummary: null,
    });

    await worker.drain();
    expect(transport.requests).toHaveLength(3);
    expect(
      store.getWebhookDelivery(retained[0]!.id),
    ).toMatchObject({ state: "delivered" });
    expect(store.getWebhookSubscription(subscription.id)).toMatchObject({
      state: "active",
      consecutiveFailures: 0,
    });
    worker.stop();
    db.close();
  });

  it("still disables immediately, dropping the backlog, when the signing key is gone", async () => {
    const { db, store, bus, subscription } = setup();
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      new FakeResolver(["93.184.216.34"]),
      new FakeTransport([]),
      { clock: () => now, failureBurst: 5 },
    );
    // Two queued deliveries, so the drop of the untried backlog is observable.
    publishDueEvent(bus);
    publishDueEvent(bus);
    // Soft-delete rather than DELETE: live deliveries still reference the key row.
    db.prepare("UPDATE webhook_keys SET deleted_at = ? WHERE subscription_id = ?").run(
      now,
      subscription.id,
    );

    await worker.drain();

    expect(store.getWebhookSubscription(subscription.id)).toMatchObject({
      state: "disabled",
      lastFailureSummary: "signing_key_unavailable",
    });
    const deliveries = store.listWebhookDeliveries({
      subscriptionId: subscription.id,
      limit: 10,
    });
    expect(deliveries.filter((delivery) => delivery.state === "failed")).toHaveLength(1);
    expect(deliveries.filter((delivery) => delivery.state === "dropped")).toHaveLength(1);
    worker.stop();
    db.close();
  });

  it("expires a paused subscription's backlog past the 24-hour delivery window", async () => {
    const { db, store, bus, subscription } = setup();
    let clock = now;
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      new FakeResolver(["93.184.216.34"]),
      new FakeTransport([{ status: 404 }]),
      { clock: () => clock, random: () => 0, failureBurst: 1 },
    );

    publishDueEvent(bus);
    await worker.drain();
    clock += 1;
    expect(store.getWebhookSubscription(subscription.id)?.state).toBe("paused");

    // Backlog queued before the pause, then left unattended past the window.
    store.recordWebhookEvent({
      eventId: "event-stale",
      type: "message.created",
      eventVersion: 1,
      sourceRadioId: 1,
      occurredAt: clock,
      body: Buffer.from("{}"),
    });
    store.enqueueWebhookDelivery({
      subscriptionId: subscription.id,
      eventId: "event-stale",
      keyId: "key-1",
      nextAttemptAt: clock,
    });
    db.prepare(
      "UPDATE webhook_deliveries SET created_at = ? WHERE event_id = 'event-stale'",
    ).run(clock);

    clock += 24 * 60 * 60 + 1;
    await worker.drain();

    expect(
      store.listWebhookDeliveries({
        subscriptionId: subscription.id,
        limit: 10,
      }),
    ).toContainEqual(
      expect.objectContaining({ state: "failed", errorSummary: "expired" }),
    );
    worker.stop();
    db.close();
  });

  it("keeps signing secrets and immutable payload bytes out of webhook diagnostics records", async () => {
    const { db, store, bus, subscription } = setup();
    const payload = "webhook-private-payload";
    const secretMarker = signingSecret.toString("hex");
    store.queueWebhookEvent({
      subscriptionId: subscription.id,
      keyId: "key-1",
      eventId: "event-private",
      type: "message.created",
      eventVersion: 1,
      sourceRadioId: 1,
      occurredAt: now,
      body: Buffer.from(payload),
      now,
    });
    const worker = new WebhookWorker(
      store,
      bus,
      masterKey,
      new FakeResolver(["93.184.216.34"]),
      new FakeTransport([new Error("network down")]),
      { clock: () => now, random: () => 0.5 },
    );

    await worker.drain();

    const diagnostics = JSON.stringify({
      logs: recentLogs(),
      deliveries: store.listWebhookDeliveries({
        subscriptionId: subscription.id,
        limit: 10,
      }),
    });
    expect(diagnostics).not.toContain(payload);
    expect(diagnostics).not.toContain(secretMarker);
    worker.stop();
    db.close();
  });
});
