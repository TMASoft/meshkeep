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
import { attachWs } from "./api/ws.js";

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
const db = openDb(resolve(config.dataDir, "meshkeep.db"));
const bus = new Bus();
const manager = new ConnectionManager(config, db, bus, version);
const mapCache = new MapCache(config, version);
const auth = new Auth(db, config.uiPassword);

const app = express();
app.disable("x-powered-by");
app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true, version });
});
app.use("/api/v1", buildApi(manager, mapCache, auth));

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
attachWs(server, bus, auth);

server.listen(config.port, () => {
  console.log(`[meshkeep] v${version} listening on :${config.port}`);
  console.log(`[meshkeep] data dir: ${resolve(config.dataDir)}`);
  console.log(`[meshkeep] radio transport: ${config.connection ?? "none (set MESHKEEP_CONNECTION)"}`);
});

void manager.start();

async function shutdown(): Promise<void> {
  console.log("[meshkeep] shutting down");
  await manager.stop();
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
