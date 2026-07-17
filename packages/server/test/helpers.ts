import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { Bus } from "../src/bus.js";
import { openDb, type Db } from "../src/db/index.js";
import { ConnectionManager } from "../src/radio/manager.js";
import { MapCache } from "../src/map/cache.js";
import { Auth } from "../src/api/auth.js";
import { buildApi } from "../src/api/routes.js";
import { buildHealth } from "../src/api/health.js";
import type { ServerConfig } from "../src/config.js";

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    dataDir: ":memory:",
    connection: null,
    serialPort: null,
    serialBaud: 115200,
    tcpHost: null,
    tcpPort: 5000,
    bleAddress: null,
    uiPassword: null,
    telemetryRetentionDays: 30,
    mapRefreshMinutes: 10,
    mapUpstream: "https://map.meshcore.io/api/v1/nodes",
    mapEnabled: true,
    ...overrides,
  };
}

export interface Harness {
  app: Express;
  db: Db;
  bus: Bus;
  manager: ConnectionManager;
  auth: Auth;
}

/**
 * The HTTP surface with a never-started manager: routes that read the store
 * work, routes that touch the radio surface RadioUnavailableError (503).
 * Mirrors src/index.ts wiring minus static serving.
 */
export function buildHarness(overrides: Partial<ServerConfig> = {}): Harness {
  const config = testConfig(overrides);
  const db = openDb(":memory:");
  const bus = new Bus();
  const manager = new ConnectionManager(config, db, bus, "test");
  const mapCache = new MapCache(config, "test");
  const auth = new Auth(db, config.uiPassword);
  const app = express();
  app.disable("x-powered-by");
  app.use("/api", buildHealth(db, "test"));
  app.use("/api/v1", buildApi(manager, mapCache, auth, bus, { db, config, version: "test" }));
  return { app, db, bus, manager, auth };
}

export async function listen(app: Express): Promise<{ server: Server; port: number }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}
