import type { ConnectionTransport } from "@meshkeep/shared";

export interface ServerConfig {
  port: number;
  dataDir: string;
  connection: ConnectionTransport | null;
  serialPort: string | null;
  serialBaud: number;
  tcpHost: string | null;
  tcpPort: number;
  bleAddress: string | null;
  uiPassword: string | null;
  telemetryRetentionDays: number;
  outboundMaxAttempts: number;
  mapRefreshMinutes: number;
  mapUpstream: string;
  mapEnabled: boolean;
  mapTilesUrl: string | null;
  mapTilesAttribution: string | null;
}

function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function tileUrl(): string | null {
  if (env("MESHKEEP_MAP_TILES_ENABLED") === "false") return null;
  const value = env("MESHKEEP_MAP_TILES_URL") ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  if (!value.includes("{z}") || !value.includes("{x}") || !value.includes("{y}")) {
    throw new Error("MESHKEEP_MAP_TILES_URL must include {z}, {x}, and {y}");
  }
  // A root-relative template is served by this MeshKeep origin, which makes a
  // reverse-proxied or bundled local tile server possible without browser CORS.
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error();
    }
  } catch {
    throw new Error("MESHKEEP_MAP_TILES_URL must be an http(s) URL or root-relative tile template");
  }
  return value;
}

const TRANSPORTS: ConnectionTransport[] = ["serial", "tcp", "ble", "none"];

export function loadConfig(): ServerConfig {
  const connection = env("MESHKEEP_CONNECTION") as ConnectionTransport | null;
  if (connection !== null && !TRANSPORTS.includes(connection)) {
    throw new Error(`MESHKEEP_CONNECTION must be one of ${TRANSPORTS.join(", ")}`);
  }
  return {
    port: envInt("MESHKEEP_PORT", 8080, 1, 65_535),
    dataDir: env("MESHKEEP_DATA_DIR") ?? "./data",
    connection,
    serialPort: env("MESHKEEP_SERIAL_PORT"),
    serialBaud: envInt("MESHKEEP_SERIAL_BAUD", 115_200, 1, 10_000_000),
    tcpHost: env("MESHKEEP_TCP_HOST"),
    tcpPort: envInt("MESHKEEP_TCP_PORT", 5000, 1, 65_535),
    bleAddress: env("MESHKEEP_BLE_ADDRESS"),
    uiPassword: env("MESHKEEP_UI_PASSWORD"),
    telemetryRetentionDays: envInt("MESHKEEP_TELEMETRY_RETENTION_DAYS", 30, 1, 3650),
    outboundMaxAttempts: envInt("MESHKEEP_OUTBOUND_MAX_ATTEMPTS", 5, 1, 20),
    mapRefreshMinutes: envInt("MESHKEEP_MAP_REFRESH_MINUTES", 10, 1, 1440),
    mapUpstream: env("MESHKEEP_MAP_UPSTREAM") ?? "https://map.meshcore.io/api/v1/nodes",
    mapEnabled: env("MESHKEEP_MAP_ENABLED") !== "false",
    mapTilesUrl: tileUrl(),
    mapTilesAttribution:
      env("MESHKEEP_MAP_TILES_ENABLED") === "false"
        ? null
        : (env("MESHKEEP_MAP_TILES_ATTRIBUTION") ?? "© OpenStreetMap contributors"),
  };
}
