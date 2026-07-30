import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { Bus } from "./bus.js";
import { ConnectionManager } from "./radio/manager.js";
import { MapCache } from "./map/cache.js";
import { Auth } from "./api/auth.js";
import { buildApi } from "./api/routes.js";
import { buildHealth } from "./api/health.js";
import { attachWs } from "./api/ws.js";
import { gracefulShutdown } from "./shutdown.js";
import { logger } from "./logger.js";
import { WebhookWorker, systemWebhookResolver, systemWebhookTransport } from "./webhooks/worker.js";
import { PushWorker, webPushSender } from "./push/worker.js";

const log = logger("meshkeep");

const here = fileURLToPath(new URL(".", import.meta.url));

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

const config = loadConfig();
const version = appVersion();
const db = openDb(resolve(config.dataDir, "meshkeep.db"), config.webhookMasterKey);
const bus = new Bus();
const manager = new ConnectionManager(config, db, bus, version);
const mapCache = new MapCache(config, version);
const auth = new Auth(db, config.uiPassword);
const webhookWorker = config.webhookMasterKey
  ? new WebhookWorker(
      manager.store,
      bus,
      config.webhookMasterKey,
      systemWebhookResolver,
      systemWebhookTransport,
      { failureBurst: config.webhookFailureBurst },
    )
  : null;
const pushWorker = config.vapid
  ? new PushWorker(manager.store, bus, webPushSender(config.vapid), { failureBurst: config.pushFailureBurst })
  : null;

const app = express();
app.disable("x-powered-by");
app.use("/api", buildHealth(db, version));
app.use("/api/v1", buildApi(manager, mapCache, auth, bus, { db, config, version }));

// serve the built web app when present (production image); dev uses vite
const webDist = [join(here, "..", "..", "web", "dist"), join(here, "..", "public")].find((dir) =>
  existsSync(join(dir, "index.html")),
);
if (webDist) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(join(webDist, "index.html"));
  });
}

const server = createServer(app);
const wss = attachWs(server, bus, auth);

server.listen(config.port, () => {
  log.info("listening", {
    version,
    port: config.port,
    dataDir: resolve(config.dataDir),
    transport: config.connection ?? "none",
  });
});

void manager.start();
webhookWorker?.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    log.error("second signal — exiting immediately");
    process.exit(1);
  }
  shuttingDown = true;
  log.info("shutting down");
  webhookWorker?.stop();
  pushWorker?.stop();
  const result = await gracefulShutdown({ manager, wss, server, db });
  process.exit(result === "clean" ? 0 : 1);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
