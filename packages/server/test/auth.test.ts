import { describe, expect, it } from "vitest";
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
    expect(Object.keys(row).sort()).toEqual(["created_at", "id", "label", "last_used_at"]);
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
});

describe("auth: session secret persistence", () => {
  it("two Auth instances over one db accept each other's cookies", () => {
    const db = openDb(":memory:");
    const first = new Auth(db, "pw-shared-secret");
    const second = new Auth(db, "pw-shared-secret");

    let cookieValue = "";
    const res = {
      cookie: () => {},
      setHeader: (_name: string, value: string) => {
        cookieValue = value.split(";")[0];
      },
    };
    expect(first.login("pw-shared-secret", res as never)).toBe(true);

    const req = { headers: { cookie: cookieValue } };
    expect(second.isAuthorized(req as never)).toBe(true);
    db.close();
  });
});
