import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Server } from "node:http";
import request from "supertest";
import { attachWs } from "../src/api/ws.js";
import { buildHarness, listen, type Harness } from "./helpers.js";

const COOKIE = "meshkeep.sid";

async function wsHarness(uiPassword: string | null): Promise<{
  harness: Harness;
  server: Server;
  port: number;
}> {
  const harness = buildHarness({ uiPassword });
  const { server, port } = await listen(harness.app);
  attachWs(server, harness.bus, harness.auth);
  return { harness, server, port };
}

function connect(port: number, path = "/api/v1/ws", headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("websocket endpoint", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server!.close(resolve));
      server = null;
    }
  });

  it("destroys upgrades on unknown paths", async () => {
    const ctx = await wsHarness(null);
    server = ctx.server;
    await expect(connect(ctx.port, "/api/v1/nope")).rejects.toThrow();
  });

  it("rejects unauthenticated upgrades in password mode", async () => {
    const ctx = await wsHarness("hunter2-swordfish");
    server = ctx.server;
    await expect(connect(ctx.port)).rejects.toThrow(/401/);
  });

  it("accepts a session cookie and a bearer token", async () => {
    const ctx = await wsHarness("hunter2-swordfish");
    server = ctx.server;

    const login = await request(ctx.harness.app)
      .post("/api/v1/auth/login")
      .send({ password: "hunter2-swordfish" })
      .expect(200);
    const cookie = login.get("Set-Cookie")!.find((c) => c.startsWith(`${COOKIE}=`))!.split(";")[0];
    const byCookie = await connect(ctx.port, "/api/v1/ws", { Cookie: cookie });
    byCookie.close();

    const token = ctx.harness.auth.createToken("ws-test").token;
    const byToken = await connect(ctx.port, "/api/v1/ws", { Authorization: `Bearer ${token}` });
    byToken.close();
  });

  it("fans bus events out to connected clients", async () => {
    const ctx = await wsHarness(null);
    server = ctx.server;
    const ws = await connect(ctx.port);
    const received = new Promise<unknown>((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    ctx.harness.bus.publish({ type: "status.changed", status: ctx.harness.manager.status() });
    const event = (await received) as { type: string; status: { connection: { state: string } } };
    expect(event.type).toBe("status.changed");
    expect(event.status.connection.state).toBe("disconnected");
    ws.close();
  });
});
