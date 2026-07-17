import { Router } from "express";
import { databaseReady, type Db } from "../db/index.js";

/**
 * Liveness and readiness probes, mounted at `/api` (outside the authenticated
 * `/api/v1` surface so an orchestrator can reach them).
 *
 * - `GET /api/healthz` — liveness: the process is up and serving. It never
 *   touches the radio or scans the database, so a disconnected radio or a slow
 *   query does not make a healthy server look dead.
 * - `GET /api/readyz` — readiness: storage responds and the schema is fully
 *   migrated. Returns 503 while migrations are mid-flight or the database is
 *   unreachable, so traffic waits rather than erroring.
 */
export function buildHealth(db: Db, version: string): Router {
  const health = Router();
  health.get("/healthz", (_req, res) => {
    res.json({ ok: true, version });
  });
  health.get("/readyz", (_req, res) => {
    const database = databaseReady(db);
    res.status(database.ready ? 200 : 503).json({ ready: database.ready, version, database });
  });
  return health;
}
