import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildHarness } from "./helpers.js";

const PASSWORD = "webhook-management-password";

async function sessionCookie(app: ReturnType<typeof buildHarness>["app"]): Promise<string> {
  const login = await request(app).post("/api/v1/auth/login").send({ password: PASSWORD }).expect(200);
  return login
    .get("Set-Cookie")!
    .find((value) => value.startsWith("meshkeep.sid="))!
    .split(";")[0]!;
}

function buildWebhookHarness() {
  return buildHarness({ uiPassword: PASSWORD, webhookMasterKey: randomBytes(32) });
}

describe("webhook management API", () => {
  it("allows only a session to create subscriptions and returns the signing secret once", async () => {
    const { app } = buildWebhookHarness();
    const cookie = await sessionCookie(app);

    const created = await request(app)
      .post("/api/v1/webhooks")
      .set("Cookie", cookie)
      .send({
        label: "Home Assistant",
        destination: "https://hooks.example.test/meshkeep",
        eventTypes: ["message.created"],
        includeSensitive: false,
      })
      .expect(201);

    expect(created.body.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.subscription).toMatchObject({
      label: "Home Assistant",
      destination: "https://hooks.example.test/meshkeep",
      eventTypes: ["message.created"],
      radioIds: null,
      includeSensitive: false,
      state: "active",
    });
    expect(JSON.stringify(created.body.subscription)).not.toContain(created.body.signingSecret);

    const fetched = await request(app).get(`/api/v1/webhooks/${created.body.subscription.id}`).set("Cookie", cookie).expect(200);
    expect(JSON.stringify(fetched.body)).not.toContain("signingSecret");

    const bearer = await request(app)
      .post("/api/v1/tokens")
      .set("Cookie", cookie)
      .send({ label: "integration", scope: "read" })
      .expect(201);
    await request(app).get("/api/v1/webhooks").set("Authorization", `Bearer ${bearer.body.token}`).expect(403);
  });

  it("requires events.read for catalog and redacted delivery summaries", async () => {
    const { app, manager } = buildWebhookHarness();
    const cookie = await sessionCookie(app);
    const created = await request(app)
      .post("/api/v1/webhooks")
      .set("Cookie", cookie)
      .send({ label: "Receiver", destination: "https://hooks.example.test/events", eventTypes: ["message.created"] })
      .expect(201);
    const subscriptionId = created.body.subscription.id as number;
    const subscription = manager.store.getWebhookSubscription(subscriptionId)!;
    manager.store.recordWebhookEvent({
      eventId: "event-redacted",
      type: "message.created",
      eventVersion: 1,
      sourceRadioId: null,
      occurredAt: 1,
      body: Buffer.from('{"private":"payload"}'),
    });
    manager.store.enqueueWebhookDelivery({ subscriptionId, eventId: "event-redacted", keyId: subscription.activeKeyId!, nextAttemptAt: 1 });

    const eventsToken = (
      await request(app).post("/api/v1/tokens").set("Cookie", cookie).send({ label: "event reader", scope: "events.read" }).expect(201)
    ).body.token as string;
    await request(app).get("/api/v1/event-catalog").set("Authorization", `Bearer ${eventsToken}`).expect(200);
    await request(app).get("/api/v1/status").set("Authorization", `Bearer ${eventsToken}`).expect(403);
    const deliveries = await request(app)
      .get(`/api/v1/webhooks/${subscriptionId}/deliveries`)
      .set("Authorization", `Bearer ${eventsToken}`)
      .expect(200);
    expect(JSON.stringify(deliveries.body)).not.toContain("hooks.example.test");
    expect(JSON.stringify(deliveries.body)).not.toContain("private");
    expect(JSON.stringify(deliveries.body)).not.toContain("keyId");

    const readToken = (
      await request(app).post("/api/v1/tokens").set("Cookie", cookie).send({ label: "ordinary reader", scope: "read" }).expect(201)
    ).body.token as string;
    await request(app).get("/api/v1/event-catalog").set("Authorization", `Bearer ${readToken}`).expect(403);
    await request(app).get(`/api/v1/webhooks/${subscriptionId}/deliveries`).set("Authorization", `Bearer ${readToken}`).expect(403);
  });

  it("validates configuration, requires sensitive opt-in confirmation, rotates once, and revokes keys", async () => {
    const { app, db } = buildWebhookHarness();
    const cookie = await sessionCookie(app);
    const base = { label: "Receiver", destination: "https://hooks.example.test/events", eventTypes: ["message.created"] };

    await request(app).post("/api/v1/webhooks").set("Cookie", cookie).send({ ...base, destination: "http://hooks.example.test" }).expect(400);
    await request(app).post("/api/v1/webhooks").set("Cookie", cookie).send({ ...base, includeSensitive: true }).expect(400);
    await request(app).post("/api/v1/webhooks").set("Cookie", cookie).send({ ...base, radioIds: [999] }).expect(400);

    const created = await request(app).post("/api/v1/webhooks").set("Cookie", cookie).send(base).expect(201);
    const originalSecret = created.body.signingSecret as string;
    const id = created.body.subscription.id as number;
    const rotated = await request(app).post(`/api/v1/webhooks/${id}/rotate-secret`).set("Cookie", cookie).send({}).expect(200);
    expect(rotated.body.signingSecret).not.toBe(originalSecret);
    expect(db.prepare("SELECT retire_at FROM webhook_keys WHERE subscription_id = ?").all(id)).toContainEqual(expect.objectContaining({ retire_at: expect.any(Number) }));

    await request(app).post(`/api/v1/webhooks/${id}/test`).set("Cookie", cookie).send({}).expect(202);
    await request(app).delete(`/api/v1/webhooks/${id}`).set("Cookie", cookie).expect(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM webhook_keys WHERE subscription_id = ?").get(id)).toEqual({ count: 0 });
  });

  it("enqueues a real signed test delivery, once per minute, only while active", async () => {
    const { app, manager } = buildWebhookHarness();
    const cookie = await sessionCookie(app);
    const created = await request(app)
      .post("/api/v1/webhooks")
      .set("Cookie", cookie)
      .send({ label: "Receiver", destination: "https://hooks.example.test/events", eventTypes: ["message.created"] })
      .expect(201);
    const id = created.body.subscription.id as number;

    const sent = await request(app).post(`/api/v1/webhooks/${id}/test`).set("Cookie", cookie).send({}).expect(202);
    expect(sent.body).toMatchObject({ accepted: true, eventId: expect.any(String) });

    // The worker now has a real queued delivery signed with the active key.
    const queued = manager.store.listWebhookDeliveries({ subscriptionId: id, limit: 10 });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ state: "queued", keyId: created.body.subscription.activeKeyId });
    const envelope = JSON.parse(
      manager.store.getWebhookDeliveryJob(queued[0]!.id)!.body.toString("utf8"),
    );
    expect(envelope).toMatchObject({
      id: sent.body.eventId,
      type: "webhook.test",
      eventVersion: 1,
      source: { product: "meshkeep", apiVersion: "v1" },
      data: { test: true, subscriptionId: id, label: "Receiver" },
    });

    // One test per subscription per minute.
    await request(app).post(`/api/v1/webhooks/${id}/test`).set("Cookie", cookie).send({}).expect(429);

    // A paused subscription cannot be probed at all.
    await request(app).patch(`/api/v1/webhooks/${id}`).set("Cookie", cookie).send({ state: "paused" }).expect(200);
    await request(app).post(`/api/v1/webhooks/${id}/test`).set("Cookie", cookie).send({}).expect(409);
  });
});
