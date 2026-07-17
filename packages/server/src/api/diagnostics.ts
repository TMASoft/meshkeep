import type { ServerDiagnostics } from "@meshkeep/shared";
import { databaseDiagnostics, type Db } from "../db/index.js";
import type { ConnectionManager } from "../radio/manager.js";
import type { MapCache } from "../map/cache.js";
import type { ServerConfig } from "../config.js";
import { recentLogs, sanitizeLogs, type LogEntry } from "../logger.js";

/**
 * Assemble a secret-free diagnostics snapshot: transport/reconnect, firmware,
 * radio, database durability, and map health, plus actionable guidance. It
 * carries no message content, credentials, or keys, so it is safe to show any
 * authenticated user and to embed in the support bundle.
 */
export function buildDiagnostics(
  manager: ConnectionManager,
  db: Db,
  mapCache: MapCache,
  config: ServerConfig,
  version: string,
): ServerDiagnostics {
  const status = manager.status();
  const reconnect = manager.reconnectState();
  const self = status.self;
  const database = databaseDiagnostics(db);
  const map = mapCache.status();

  const guidance: string[] = [];
  if (status.connection.state === "error" && status.connection.lastError) {
    guidance.push(`Radio connection error: ${status.connection.lastError}. Review the transport settings on the Radio page.`);
  }
  if (status.connection.state === "connected" && (self?.firmwareVer ?? null) === null) {
    guidance.push(
      "Firmware version could not be read — some device controls may be limited. Update to current MeshCore companion firmware.",
    );
  }
  if (database.integrity !== "ok") {
    guidance.push("Database integrity check failed — restore from a backup (see docs/operations.md).");
  }
  if (database.foreignKeyViolations > 0) {
    guidance.push(`Database has ${database.foreignKeyViolations} foreign-key violation(s) — see docs/operations.md.`);
  }
  if (database.schemaVersion !== database.latestSchemaVersion) {
    guidance.push(
      `Database schema is at version ${database.schemaVersion} of ${database.latestSchemaVersion} — restart the server to finish migrating.`,
    );
  }
  if (config.mapEnabled && map.lastError) {
    guidance.push(`Global map fetch is failing: ${map.lastError}.`);
  }

  return {
    server: {
      version,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
    },
    connection: { ...status.connection, reconnectScheduled: reconnect.scheduled, reconnectDelayMs: reconnect.delayMs },
    firmware: {
      version: self?.firmwareVer ?? null,
      buildDate: self?.firmwareBuildDate ?? null,
      model: self?.manufacturerModel ?? null,
    },
    radio: self
      ? {
          freqHz: self.radioFreq ?? null,
          bandwidthHz: self.radioBw ?? null,
          spreadingFactor: self.radioSf ?? null,
          codingRate: self.radioCr ?? null,
        }
      : null,
    database,
    map: { enabled: config.mapEnabled, fetchedAt: map.fetchedAt, lastError: map.lastError },
    counts: status.counts,
    guidance,
  };
}

export interface SupportBundle {
  generatedAt: number;
  diagnostics: ServerDiagnostics;
  /** Effective configuration with secrets redacted (uiPassword → uiPasswordSet). */
  config: Record<string, unknown>;
  /** Recent structured logs with secret-shaped fields redacted. */
  logs: LogEntry[];
}

/** Effective config for the bundle with the UI password replaced by a boolean. */
function redactedConfig(config: ServerConfig): Record<string, unknown> {
  const { uiPassword, ...rest } = config;
  return { ...rest, uiPasswordSet: uiPassword !== null };
}

/**
 * Full support bundle: diagnostics plus redacted configuration and recent logs.
 * Secrets are redacted and no message content is included, so it is safe to
 * attach to a bug report. Session-only so an API token cannot exfiltrate it.
 */
export function buildSupportBundle(
  manager: ConnectionManager,
  db: Db,
  mapCache: MapCache,
  config: ServerConfig,
  version: string,
): SupportBundle {
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    diagnostics: buildDiagnostics(manager, db, mapCache, config, version),
    config: redactedConfig(config),
    logs: sanitizeLogs(recentLogs()),
  };
}
