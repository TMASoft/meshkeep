import { afterEach, describe, expect, it } from "vitest";
import type { Message, TelemetryAlertEvent, WsEvent } from "@meshkeep/shared";
import { Bus } from "../src/bus.js";
import { openDb } from "../src/db/index.js";
import { Store } from "../src/db/store.js";
import { clearLogs, setLogLevel } from "../src/logger.js";
import { genericPushPayload, PushSendError, PushWorker, type PushPayload, type PushSender } from "../src/push/worker.js";
import type { PushSubscription } from "../src/db/store.js";

class FakeSender implements PushSender {
  readonly sent: { subscription: PushSubscription; payload: PushPayload }[] = [];
  private readonly outcomes: (Error | undefined)[];

  constructor(outcomes: (Error | undefined)[] = []) {
    this.outcomes = outcomes;
  }

  async send(subscription: PushSubscription, payload: PushPayload): Promise<void> {
    this.sent.push({ subscription, payload });
    const outcome = this.outcomes.shift();
    if (outcome) throw outcome;
  }
}

function setup() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const bus = new Bus();
  return { db, store, bus };
}

function subscribe(store: Store, endpoint = "https://push.example.test/ep-1") {
  return store.upsertPushSubscription({
    sessionTokenHash: "session-hash-1",
    endpoint,
    p256dh: "p256dh-key",
    auth: "auth-secret",
  });
}

function inboundMessage(overrides: Partial<Message> = {}): WsEvent {
  const message: Message = {
    id: 1,
    kind: "dm",
    contactKey: "a".repeat(64),
    channelIdx: null,
    direction: "in",
    text: "hello there",
    senderTimestamp: 1000,
    pathLen: null,
    status: "sent",
    createdAt: 1000,
    ...overrides,
  };
  return { type: "message.new", radioId: 1, message };
}

function alertEvent(overrides: Partial<TelemetryAlertEvent> = {}): WsEvent {
  const event: TelemetryAlertEvent = {
    id: 1,
    ruleId: 9,
    contactKey: "a".repeat(64),
    contactName: "Base Camp",
    metric: "battery_mv",
    label: "Battery",
    value: 3200,
    threshold: 3400,
    comparator: "below",
    direction: "breach",
    ts: 1000,
    ...overrides,
  };
  return { type: "telemetry.alert", radioId: 1, event };
}

afterEach(() => {
  clearLogs();
  setLogLevel("error");
});

describe("genericPushPayload", () => {
  it("builds a generic, non-identifying payload for an incoming message", () => {
    const payload = genericPushPayload(inboundMessage());
    expect(payload).toEqual({ title: "New MeshKeep message", body: "Open MeshKeep to view." });
  });

  it("ignores outgoing messages (never push for our own sends)", () => {
    expect(genericPushPayload(inboundMessage({ direction: "out" }))).toBeNull();
  });

  it("builds a generic payload for a telemetry alert without leaking identifiers, values, or thresholds", () => {
    const payload = genericPushPayload(alertEvent())!;
    expect(payload.title).toBe("MeshKeep telemetry alert");
    expect(payload.body).not.toContain("Base Camp");
    expect(payload.body).not.toContain("3200");
    expect(payload.body).not.toContain("3400");
  });

  it("ignores event types with no push mapping", () => {
    expect(genericPushPayload({ type: "self.updated", radioId: 1, self: {} as never })).toBeNull();
  });
});

describe("PushWorker", () => {
  it("delivers a generic payload to every subscription on an incoming message", async () => {
    const { store, bus } = setup();
    subscribe(store, "https://push.example.test/ep-1");
    subscribe(store, "https://push.example.test/ep-2");
    const sender = new FakeSender();
    const worker = new PushWorker(store, bus, sender);

    bus.publish(inboundMessage());
    await new Promise((resolve) => setImmediate(resolve));

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent.every((s) => s.payload.title === "New MeshKeep message")).toBe(true);
    worker.stop();
  });

  it("rate-limits repeated sends to the same endpoint within the configured window", async () => {
    const { store, bus } = setup();
    subscribe(store);
    const sender = new FakeSender();
    let clock = 0;
    const worker = new PushWorker(store, bus, sender, { minSendIntervalMs: 10_000, clock: () => clock });

    bus.publish(inboundMessage());
    await new Promise((resolve) => setImmediate(resolve));
    clock = 5_000; // still inside the window
    bus.publish(inboundMessage({ id: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.sent).toHaveLength(1);

    clock = 11_000; // window elapsed
    bus.publish(inboundMessage({ id: 3 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.sent).toHaveLength(2);
    worker.stop();
  });

  it("removes a subscription immediately on a 410 Gone (dead endpoint), not a failure streak", async () => {
    const { store, bus } = setup();
    const subscription = subscribe(store);
    const sender = new FakeSender([new PushSendError("gone", 410)]);
    const worker = new PushWorker(store, bus, sender);

    bus.publish(inboundMessage());
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.getPushSubscription(subscription.endpoint)).toBeNull();
    worker.stop();
  });

  it("removes a subscription after a burst of non-fatal failures, keeping it until the threshold", async () => {
    const { store, bus } = setup();
    const subscription = subscribe(store);
    const sender = new FakeSender([
      new PushSendError("server error", 500),
      new PushSendError("server error", 500),
    ]);
    const worker = new PushWorker(store, bus, sender, { failureBurst: 2, minSendIntervalMs: 0 });

    bus.publish(inboundMessage({ id: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getPushSubscription(subscription.endpoint)).not.toBeNull();
    expect(store.getPushSubscription(subscription.endpoint)!.consecutiveFailures).toBe(1);

    bus.publish(inboundMessage({ id: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getPushSubscription(subscription.endpoint)).toBeNull();
    worker.stop();
  });

  it("clears the failure streak on a successful send", async () => {
    const { store, bus } = setup();
    const subscription = subscribe(store);
    const sender = new FakeSender([new PushSendError("server error", 500)]);
    const worker = new PushWorker(store, bus, sender, { failureBurst: 5, minSendIntervalMs: 0 });

    bus.publish(inboundMessage({ id: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getPushSubscription(subscription.endpoint)!.consecutiveFailures).toBe(1);

    bus.publish(inboundMessage({ id: 2 })); // succeeds (no more queued errors)
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getPushSubscription(subscription.endpoint)!.consecutiveFailures).toBe(0);
    worker.stop();
  });

  it("stop() unsubscribes from the bus", async () => {
    const { store, bus } = setup();
    subscribe(store);
    const sender = new FakeSender();
    const worker = new PushWorker(store, bus, sender);
    worker.stop();

    bus.publish(inboundMessage());
    await new Promise((resolve) => setImmediate(resolve));

    expect(sender.sent).toHaveLength(0);
  });
});
