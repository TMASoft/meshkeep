import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildHarness } from "./helpers.js";

const PASSWORD = "push-management-password";
const VAPID = { publicKey: "test-public-key", privateKey: "test-private-key", subject: "mailto:ops@example.test" };

async function sessionCookie(app: ReturnType<typeof buildHarness>["app"]): Promise<string> {
  const login = await request(app).post("/api/v1/auth/login").send({ password: PASSWORD }).expect(200);
  return login
    .get("Set-Cookie")!
    .find((value) => value.startsWith("meshkeep.sid="))!
    .split(";")[0]!;
}

function buildPushHarness(vapid: typeof VAPID | null = VAPID) {
  return buildHarness({ uiPassword: PASSWORD, vapid });
}

describe("push subscription API", () => {
  it("reports push unavailable (404) when no VAPID keys are configured", async () => {
    const { app } = buildPushHarness(null);
    const cookie = await sessionCookie(app);
    await request(app).get("/api/v1/push/vapid-public-key").set("Cookie", cookie).expect(404);
    await request(app)
      .post("/api/v1/push/subscribe")
      .set("Cookie", cookie)
      .send({ endpoint: "https://push.example.test/ep-1", keys: { p256dh: "k", auth: "a" } })
      .expect(404);
  });

  it("returns the public key to a session, never to a bearer token", async () => {
    const { app } = buildPushHarness();
    const cookie = await sessionCookie(app);
    const res = await request(app).get("/api/v1/push/vapid-public-key").set("Cookie", cookie).expect(200);
    expect(res.body).toEqual({ publicKey: VAPID.publicKey });

    const bearer = await request(app)
      .post("/api/v1/tokens")
      .set("Cookie", cookie)
      .send({ label: "integration", scope: "read" })
      .expect(201);
    await request(app)
      .get("/api/v1/push/vapid-public-key")
      .set("Authorization", `Bearer ${bearer.body.token}`)
      .expect(403);
  });

  it("subscribes, lists it under the store, and only the owning session can unsubscribe", async () => {
    const { app, manager } = buildPushHarness();
    const cookieA = await sessionCookie(app);

    await request(app)
      .post("/api/v1/push/subscribe")
      .set("Cookie", cookieA)
      .send({ endpoint: "https://push.example.test/ep-1", keys: { p256dh: "k1", auth: "a1" } })
      .expect(201);

    const stored = manager.store.listPushSubscriptions();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ endpoint: "https://push.example.test/ep-1", p256dh: "k1", auth: "a1" });

    // a second, independent login (cookieA stays valid — logging in doesn't revoke other sessions)
    const cookieB = await sessionCookie(app);
    await request(app)
      .delete("/api/v1/push/subscribe")
      .set("Cookie", cookieB)
      .send({ endpoint: "https://push.example.test/ep-1" })
      .expect(200);
    // a different session cannot delete someone else's subscription — still present
    expect(manager.store.listPushSubscriptions()).toHaveLength(1);

    // the actual owning session can
    await request(app)
      .delete("/api/v1/push/subscribe")
      .set("Cookie", cookieA)
      .send({ endpoint: "https://push.example.test/ep-1" })
      .expect(200);
    expect(manager.store.listPushSubscriptions()).toHaveLength(0);
  });

  it("logout deletes the subscription bound to that session (server-side cleanup, #76)", async () => {
    const { app, manager } = buildPushHarness();
    const cookie = await sessionCookie(app);
    await request(app)
      .post("/api/v1/push/subscribe")
      .set("Cookie", cookie)
      .send({ endpoint: "https://push.example.test/ep-2", keys: { p256dh: "k", auth: "a" } })
      .expect(201);
    expect(manager.store.listPushSubscriptions()).toHaveLength(1);

    await request(app).post("/api/v1/auth/logout").set("Cookie", cookie).expect(200);

    expect(manager.store.listPushSubscriptions()).toHaveLength(0);
  });

  it("lets the owning session unsubscribe its own endpoint", async () => {
    const { app, manager } = buildPushHarness();
    const cookie = await sessionCookie(app);
    await request(app)
      .post("/api/v1/push/subscribe")
      .set("Cookie", cookie)
      .send({ endpoint: "https://push.example.test/ep-3", keys: { p256dh: "k", auth: "a" } })
      .expect(201);

    await request(app)
      .delete("/api/v1/push/subscribe")
      .set("Cookie", cookie)
      .send({ endpoint: "https://push.example.test/ep-3" })
      .expect(200);

    expect(manager.store.listPushSubscriptions()).toHaveLength(0);
  });

  it("rejects malformed subscribe bodies", async () => {
    const { app } = buildPushHarness();
    const cookie = await sessionCookie(app);
    await request(app)
      .post("/api/v1/push/subscribe")
      .set("Cookie", cookie)
      .send({ endpoint: "not-a-url", keys: { p256dh: "k", auth: "a" } })
      .expect(400);
    await request(app)
      .post("/api/v1/push/subscribe")
      .set("Cookie", cookie)
      .send({ endpoint: "https://push.example.test/ep-4" })
      .expect(400);
  });
});
