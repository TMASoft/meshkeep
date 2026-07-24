import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { Bus } from "../bus.js";
import type { Auth } from "./auth.js";

export interface WsOptions {
  /** Simultaneous client cap; further upgrades get 503. */
  maxClients?: number;
  /** Heartbeat cadence; a client that misses one whole interval is terminated. */
  pingIntervalMs?: number;
  /** Per-client unsent-bytes cap; slower clients are disconnected (they reconnect and re-bootstrap). */
  maxBufferedBytes?: number;
}

/** Fan the internal event bus out to connected browsers over /api/v1/ws. */
export function attachWs(server: Server, bus: Bus, auth: Auth, options: WsOptions = {}): WebSocketServer {
  const { maxClients = 32, pingIntervalMs = 30_000, maxBufferedBytes = 1_048_576 } = options;
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/ws") {
      socket.destroy();
      return;
    }
    // Origin policy: browsers always send Origin on WebSocket upgrades — it
    // must match our host. Non-browser clients (no Origin) authenticate below.
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      let originHost: string | null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost === null || originHost !== req.headers.host) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (!auth.isAuthorized(req as never)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (wss.clients.size >= maxClients) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };
  server.on("upgrade", onUpgrade);

  // liveness: ping every interval, terminate clients that never ponged back
  const liveness = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws) => {
    liveness.set(ws, true);
    ws.on("pong", () => liveness.set(ws, true));
  });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (liveness.get(client) === false) {
        client.terminate();
        continue;
      }
      liveness.set(client, false);
      client.ping();
    }
  }, pingIntervalMs);
  heartbeat.unref?.();

  const unsubscribe = bus.subscribe((event) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // backpressure: never buffer unbounded event data for a client that
      // cannot keep up — drop it instead; the app reconnects and re-bootstraps
      if (client.bufferedAmount > maxBufferedBytes) {
        client.terminate();
        continue;
      }
      client.send(data);
    }
  });

  wss.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    server.off("upgrade", onUpgrade);
  });
  return wss;
}
