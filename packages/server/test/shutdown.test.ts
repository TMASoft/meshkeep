import { get } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { attachWs } from "../src/api/ws.js";
import { gracefulShutdown } from "../src/shutdown.js";
import { buildHarness, listen } from "./helpers.js";

/** GET without keep-alive so the server drain can complete after the response. */
function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("graceful shutdown", () => {
  it("drains in-flight requests, closes WebSocket clients, then closes SQLite", async () => {
    const harness = buildHarness();
    let slowStarted = false;
    let finishSlow!: () => void;
    harness.app.get("/slow", (_req, res) => {
      slowStarted = true;
      new Promise<void>((resolve) => {
        finishSlow = resolve;
      })
        .then(() => res.json({ ok: true }))
        .catch(() => {});
    });
    const { server, port } = await listen(harness.app);
    const wss = attachWs(server, harness.bus, harness.auth);

    const ws = await connectWs(port);
    const wsClosed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    const inflight = httpGet(`http://127.0.0.1:${port}/slow`);
    await vi.waitFor(() => {
      expect(slowStarted).toBe(true);
    });

    const shutting = gracefulShutdown({ manager: harness.manager, wss, server, db: harness.db, timeoutMs: 5000 });
    setTimeout(() => finishSlow(), 100); // the in-flight request completes mid-drain

    expect(await shutting).toBe("clean");
    expect(await inflight).toBe(200); // the request was served, not dropped
    expect(await wsClosed).toBe(1001); // clients were told the server is going away
    expect(harness.db.open).toBe(false); // SQLite closed last
    expect(harness.manager.getState()).toBe("disconnected");

    // no new requests are accepted after the drain
    await expect(httpGet(`http://127.0.0.1:${port}/slow`)).rejects.toThrow();
  });

  it("forces shutdown when the drain exceeds the bounded timeout", async () => {
    const harness = buildHarness();
    let hungStarted = false;
    harness.app.get("/hung", () => {
      hungStarted = true; // never responds
    });
    const { server, port } = await listen(harness.app);
    const wss = attachWs(server, harness.bus, harness.auth);

    const hung = httpGet(`http://127.0.0.1:${port}/hung`).catch(() => "aborted");
    await vi.waitFor(() => {
      expect(hungStarted).toBe(true);
    });

    const result = await gracefulShutdown({
      manager: harness.manager,
      wss,
      server,
      db: harness.db,
      timeoutMs: 250,
    });
    expect(result).toBe("forced");
    expect(await hung).toBe("aborted"); // the stuck connection was terminated
    expect(harness.db.open).toBe(false); // SQLite still closed cleanly
  });
});
