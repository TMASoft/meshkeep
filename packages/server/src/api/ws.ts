import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Bus } from "../bus.js";
import type { Auth } from "./auth.js";

/** Fan the internal event bus out to connected browsers over /api/v1/ws. */
export function attachWs(server: Server, bus: Bus, auth: Auth): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/ws") {
      socket.destroy();
      return;
    }
    if (!auth.isAuthorized(req as never)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const unsubscribe = bus.subscribe((event) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  });

  wss.on("close", unsubscribe);
  return wss;
}
