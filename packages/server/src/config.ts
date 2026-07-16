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
  mapRefreshMinutes: number;
  mapUpstream: string;
  mapEnabled: boolean;
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
    mapRefreshMinutes: envInt("MESHKEEP_MAP_REFRESH_MINUTES", 10, 1, 1440),
    mapUpstream: env("MESHKEEP_MAP_UPSTREAM") ?? "https://map.meshcore.io/api/v1/nodes",
    mapEnabled: env("MESHKEEP_MAP_ENABLED") !== "false",
  };
}
