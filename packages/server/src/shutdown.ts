import type { Server } from "node:http";
import type { WebSocketServer } from "ws";
import type { Db } from "./db/index.js";

export interface ShutdownDeps {
  manager: { stop(): Promise<void> };
  wss: WebSocketServer;
  server: Server;
  db: Db;
  /** Upper bound on the orderly phase before open work is forcibly terminated. */
  timeoutMs?: number;
}

/**
 * Orderly shutdown: stop radio work, tell WebSocket clients to go away, stop
 * accepting HTTP and await the drain of in-flight requests, then checkpoint
 * and close SQLite last. A bounded timeout forcibly terminates whatever has
 * not drained so shutdown can never hang. Returns how it went.
 */
export async function gracefulShutdown({
  manager,
  wss,
  server,
  db,
  timeoutMs = 10_000,
}: ShutdownDeps): Promise<"clean" | "forced"> {
  const orderly = (async () => {
    // 1. stop radio work so no new events or DB writes originate
    await manager.stop();
    // 2. close WebSocket clients (1001 = going away) and refuse new upgrades
    for (const client of wss.clients) client.close(1001, "server shutting down");
    wss.close();
    // 3. stop accepting requests and await the in-flight drain
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.(); // keep-alive sockets must not hold the drain open
    });
  })();
  orderly.catch(() => {}); // observed via race; never an unhandled rejection

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"forced">((resolve) => {
    timer = setTimeout(() => resolve("forced"), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([orderly.then(() => "clean" as const, () => "clean" as const), expired]);
  clearTimeout(timer);
  if (result === "forced") {
    console.error(`[meshkeep] shutdown did not drain within ${timeoutMs}ms; terminating open connections`);
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections?.();
  }

  // 4. SQLite goes last, after every writer has stopped
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // in-memory databases and already-clean WALs have nothing to checkpoint
  }
  db.close();
  return result;
}
