import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Auth } from "../src/api/auth.js";
import { openDb } from "../src/db/index.js";
import { buildHarness } from "./helpers.js";

const COOKIE = "meshkeep.sid";

function sessionCookie(setCookie: string[] | undefined): string {
  const header = setCookie?.find((c) => c.startsWith(`${COOKIE}=`));
  expect(header, "expected a session Set-Cookie header").toBeDefined();
  return header!.split(";")[0];
}

describe("auth: open mode (no password)", () => {
  const { app } = buildHarness();

  it("reports no password required and authorized", async () => {
    const res = await request(app).get("/api/v1/auth/session").expect(200);
    expect(res.body).toEqual({ passwordRequired: false, authorized: true });
  });

  it("lets guarded routes through without credentials", async () => {
    await request(app).get("/api/v1/status").expect(200);
    await request(app).get("/api/v1/contacts").expect(200);
  });
});

describe("auth: password mode", () => {
  const { app } = buildHarness({ uiPassword: "hunter2-swordfish" });

  it("rejects guarded routes without credentials", async () => {
    const res = await request(app).get("/api/v1/status").expect(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong password", async () => {
    await request(app).post("/api/v1/auth/login").send({ password: "nope" }).expect(401);
  });

  it("logs in and sets a hardened session cookie", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ password: "hunter2-swordfish" })
      .expect(200);
    const header = res.get("Set-Cookie")!.find((c) => c.startsWith(`${COOKIE}=`))!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`Max-Age=${60 * 60 * 24 * 30}`);
  });

  it("authorizes with the session cookie and reports the session", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ password: "hunter2-swordfish" })
      .expect(200);
    const cookie = sessionCookie(login.get("Set-Cookie"));
    await request(app).get("/api/v1/status").set("Cookie", cookie).expect(200);
    const session = await request(app).get("/api/v1/auth/session").set("Cookie", cookie).expect(200);
    expect(session.body).toEqual({ passwordRequired: true, authorized: true });
  });

  it("rejects garbage cookies, including wrong-length values", async () => {
    await request(app).get("/api/v1/status").set("Cookie", `${COOKIE}=abc`).expect(401);
    await request(app)
      .get("/api/v1/status")
      .set("Cookie", `${COOKIE}=${"f".repeat(64)}`)
      .expect(401);
  });

  it("logout clears the cookie", async () => {
    const res = await request(app).post("/api/v1/auth/logout").expect(200);
    const header = res.get("Set-Cookie")!.find((c) => c.startsWith(`${COOKIE}=`))!;
    expect(header).toContain("Max-Age=0");
  });

  it("login body must include a password string", async () => {
    await request(app).post("/api/v1/auth/login").send({}).expect(400);
  });
});

describe("auth: API tokens", () => {
  const { app } = buildHarness({ uiPassword: "hunter2-swordfish" });

  async function authed() {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ password: "hunter2-swordfish" });
    return sessionCookie(login.get("Set-Cookie"));
  }

  it("mints a token once, then authorizes with it and bumps last_used_at", async () => {
    const cookie = await authed();
    const created = await request(app)
      .post("/api/v1/tokens")
      .set("Cookie", cookie)
      .send({ label: "hll-plugin" })
      .expect(201);
    expect(created.body.token).toMatch(/^mk_[0-9a-f]{48}$/);
    expect(created.body.label).toBe("hll-plugin");
    expect(created.body.last_used_at).toBeNull();

    await request(app)
      .get("/api/v1/status")
      .set("Authorization", `Bearer ${created.body.token}`)
      .expect(200);

    const list = await request(app).get("/api/v1/tokens").set("Cookie", cookie).expect(200);
    const row = list.body.tokens.find((t: { id: number }) => t.id === created.body.id);
    expect(row.last_used_at).not.toBeNull();
    // raw tokens and hashes never appear in listings
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
    expect(Object.keys(row).sort()).toEqual(["created_at", "expires_at", "id", "label", "last_used_at", "scope"]);
    expect(row.scope).toBe("read"); // least-privilege default
  });

  it("rejects bad bearer tokens and empty labels", async () => {
    await request(app).get("/api/v1/status").set("Authorization", "Bearer mk_bogus").expect(401);
    await request(app).get("/api/v1/status").set("Authorization", "Bearer ").expect(401);
    const cookie = await authed();
    await request(app).post("/api/v1/tokens").set("Cookie", cookie).send({}).expect(400);
    await request(app).post("/api/v1/tokens").set("Cookie", cookie).send({ label: "" }).expect(400);
  });

  it("deletes a token, then 404s on repeat", async () => {
    const cookie = await authed();
    const created = await request(app)
      .post("/api/v1/tokens")
      .set("Cookie", cookie)
      .send({ label: "temp" })
      .expect(201);
    await request(app).delete(`/api/v1/tokens/${created.body.id}`).set("Cookie", cookie).expect(200);
    await request(app).delete(`/api/v1/tokens/${created.body.id}`).set("Cookie", cookie).expect(404);
    // the deleted token no longer authorizes
    await request(app)
      .get("/api/v1/status")
      .set("Authorization", `Bearer ${created.body.token}`)
      .expect(401);
  });

  it("serves the diagnostics bundle to a session but never to a bearer token", async () => {
    const cookie = await authed();
    const created = await request(app)
      .post("/api/v1/tokens")
      .set("Cookie", cookie)
      .send({ label: "read-bot" })
      .expect(201);

    // a session cookie may download the bundle
    await request(app).get("/api/v1/diagnostics/bundle").set("Cookie", cookie).expect(200);
    // a valid bearer token can read plain diagnostics…
    await request(app).get("/api/v1/diagnostics").set("Authorization", `Bearer ${created.body.token}`).expect(200);
    // …but is refused the config/log-bearing bundle (session-only)
    await request(app)
      .get("/api/v1/diagnostics/bundle")
      .set("Authorization", `Bearer ${created.body.token}`)
      .expect(403);
  });
});

describe("auth: session persistence", () => {
  it("two Auth instances over one db accept each other's sessions", () => {
    const db = openDb(":memory:");
    const first = new Auth(db, "pw-shared-secret");
    const second = new Auth(db, "pw-shared-secret");

    let cookieValue = "";
    const res = {
      setHeader: (_name: string, value: string) => {
        cookieValue = value.split(";")[0];
      },
    };
    const req = { headers: {}, ip: "127.0.0.1" };
    expect(first.login("pw-shared-secret", req as never, res as never)).toBe("ok");

    const authedReq = { headers: { cookie: cookieValue }, ip: "127.0.0.1" };
    expect(second.isAuthorized(authedReq as never)).toBe(true);
    db.close();
  });
});

describe("auth: hardened sessions (#39)", () => {
  const password = "hunter2-swordfish";

  async function login(app: ReturnType<typeof buildHarness>["app"], extra: Record<string, string> = {}) {
    let req = request(app).post("/api/v1/auth/login");
    for (const [name, value] of Object.entries(extra)) req = req.set(name, value);
    const res = await req.send({ password }).expect(200);
    return { res, cookie: sessionCookie(res.get("Set-Cookie")) };
  }

  it("issues a distinct random session per login", async () => {
    const { app } = buildHarness({ uiPassword: password });
    const first = await login(app);
    const second = await login(app);
    expect(first.cookie).not.toBe(second.cookie);
    expect(first.cookie.split("=")[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("logout revokes only that session server-side", async () => {
    const { app } = buildHarness({ uiPassword: password });
    const first = await login(app);
    const second = await login(app);
    await request(app).post("/api/v1/auth/logout").set("Cookie", first.cookie).expect(200);
    await request(app).get("/api/v1/status").set("Cookie", first.cookie).expect(401);
    await request(app).get("/api/v1/status").set("Cookie", second.cookie).expect(200);
  });

  it("sessions expire", async () => {
    vi.useFakeTimers();
    try {
      const { app } = buildHarness({ uiPassword: password });
      const { cookie } = await login(app);
      await request(app).get("/api/v1/status").set("Cookie", cookie).expect(200);
      vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000);
      await request(app).get("/api/v1/status").set("Cookie", cookie).expect(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the cookie Secure behind an https proxy", async () => {
    const { app } = buildHarness({ uiPassword: password });
    const plain = await login(app);
    expect(plain.res.get("Set-Cookie")!.find((c) => c.startsWith(COOKIE))).not.toContain("Secure");
    const proxied = await login(app, { "X-Forwarded-Proto": "https" });
    expect(proxied.res.get("Set-Cookie")!.find((c) => c.startsWith(COOKIE))).toContain("Secure");
  });

  it("throttles logins after repeated failures", async () => {
    const { app } = buildHarness({ uiPassword: password });
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/v1/auth/login").send({ password: "wrong" }).expect(401);
    }
    // even the correct password is refused during the cooldown
    await request(app).post("/api/v1/auth/login").send({ password }).expect(429);
  });
});

describe("auth: cross-site mutation defense (#39)", () => {
  it("rejects cookie-mode mutations with a foreign origin or cross-site fetch metadata", async () => {
    const { app } = buildHarness();
    await request(app)
      .post("/api/v1/messages/read")
      .set("Origin", "https://evil.example")
      .send({ channel: 0 })
      .expect(403);
    await request(app)
      .post("/api/v1/messages/read")
      .set("Sec-Fetch-Site", "cross-site")
      .send({ channel: 0 })
      .expect(403);
    // login itself is protected too
    await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "null")
      .send({ password: "x" })
      .expect(403);
  });

  it("allows same-origin mutations and reads", async () => {
    const { app } = buildHarness();
    const host = "meshkeep.local";
    await request(app)
      .post("/api/v1/messages/read")
      .set("Host", host)
      .set("Origin", `http://${host}`)
      .send({ channel: 0 })
      .expect(200);
    await request(app).get("/api/v1/status").set("Origin", "https://evil.example").expect(200);
  });

  it("bearer-token mutations skip the origin check", async () => {
    const { app, auth } = buildHarness({ uiPassword: "hunter2-swordfish" });
    const { token } = auth.createToken("integration", "write");
    await request(app)
      .post("/api/v1/messages/read")
      .set("Authorization", `Bearer ${token}`)
      .set("Origin", "https://elsewhere.example")
      .send({ channel: 0 })
      .expect(200);
  });
});

describe("auth: token scopes and lifecycle (#40)", () => {
  const password = "hunter2-swordfish";

  it("authorization matrix: read tokens read, only write tokens mutate", async () => {
    const { app, auth } = buildHarness({ uiPassword: password });
    const read = auth.createToken("reader"); // read-only by default
    const write = auth.createToken("writer", "write");

    await request(app).get("/api/v1/status").set("Authorization", `Bearer ${read.token}`).expect(200);
    await request(app).get("/api/v1/messages/recent").set("Authorization", `Bearer ${read.token}`).expect(200);
    const denied = await request(app)
      .post("/api/v1/messages/read")
      .set("Authorization", `Bearer ${read.token}`)
      .send({ channel: 0 })
      .expect(403);
    expect(denied.body.error).toContain("write scope");

    await request(app)
      .post("/api/v1/messages/read")
      .set("Authorization", `Bearer ${write.token}`)
      .send({ channel: 0 })
      .expect(200);
  });

  it("tokens never manage tokens, regardless of scope", async () => {
    const { app, auth } = buildHarness({ uiPassword: password });
    const write = auth.createToken("writer", "write");
    await request(app).get("/api/v1/tokens").set("Authorization", `Bearer ${write.token}`).expect(403);
    await request(app)
      .post("/api/v1/tokens")
      .set("Authorization", `Bearer ${write.token}`)
      .send({ label: "escalation" })
      .expect(403);
    await request(app).delete("/api/v1/tokens/1").set("Authorization", `Bearer ${write.token}`).expect(403);
  });

  it("expired tokens stop authorizing", async () => {
    vi.useFakeTimers();
    try {
      const { app, auth } = buildHarness({ uiPassword: password });
      const { token } = auth.createToken("short-lived", "read", 3600);
      await request(app).get("/api/v1/status").set("Authorization", `Bearer ${token}`).expect(200);
      vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
      await request(app).get("/api/v1/status").set("Authorization", `Bearer ${token}`).expect(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotation invalidates the old secret and keeps the row", async () => {
    const { app, auth } = buildHarness({ uiPassword: password });
    const created = auth.createToken("rotate-me", "read");
    const rotated = auth.rotateToken(created.row.id)!;
    expect(rotated.token).not.toBe(created.token);
    expect(rotated.row.id).toBe(created.row.id);
    await request(app).get("/api/v1/status").set("Authorization", `Bearer ${created.token}`).expect(401);
    await request(app).get("/api/v1/status").set("Authorization", `Bearer ${rotated.token}`).expect(200);
  });

  it("throttles last-used persistence instead of writing every request", async () => {
    vi.useFakeTimers();
    try {
      const { app, auth } = buildHarness({ uiPassword: password });
      const { token, row } = auth.createToken("busy", "read");
      await request(app).get("/api/v1/status").set("Authorization", `Bearer ${token}`).expect(200);
      const first = auth.listTokens().find((t) => t.id === row.id)!.last_used_at;
      expect(first).not.toBeNull();

      vi.setSystemTime(Date.now() + 60 * 1000); // within the throttle window
      await request(app).get("/api/v1/status").set("Authorization", `Bearer ${token}`).expect(200);
      expect(auth.listTokens().find((t) => t.id === row.id)!.last_used_at).toBe(first);

      vi.setSystemTime(Date.now() + 10 * 60 * 1000); // past the window
      await request(app).get("/api/v1/status").set("Authorization", `Bearer ${token}`).expect(200);
      expect(auth.listTokens().find((t) => t.id === row.id)!.last_used_at).toBeGreaterThan(first!);
    } finally {
      vi.useRealTimers();
    }
  });
});
