import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuration bounds", () => {
  it("loads defaults when nothing is set", () => {
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.serialBaud).toBe(115_200);
    expect(config.telemetryRetentionDays).toBe(30);
    expect(config.telemetryPollMinutes).toBe(5);
    expect(config.telemetryMonitorMinutes).toBe(30);
    expect(config.timelineRetentionDays).toBe(90);
    expect(config.webhookMasterKey).toBeNull();
    expect(config.vapid).toBeNull();
    expect(config.pushFailureBurst).toBe(5);
  });

  it("requires all three VAPID env vars together, or none", () => {
    vi.stubEnv("MESHKEEP_VAPID_PUBLIC_KEY", "pub");
    expect(() => loadConfig()).toThrow(/MESHKEEP_VAPID_PUBLIC_KEY, MESHKEEP_VAPID_PRIVATE_KEY, and MESHKEEP_VAPID_SUBJECT must all be set/);
    vi.stubEnv("MESHKEEP_VAPID_PRIVATE_KEY", "priv");
    vi.stubEnv("MESHKEEP_VAPID_SUBJECT", "mailto:ops@example.test");
    expect(loadConfig().vapid).toEqual({ publicKey: "pub", privateKey: "priv", subject: "mailto:ops@example.test" });
  });

  it("rejects a VAPID subject that isn't mailto: or https:", () => {
    vi.stubEnv("MESHKEEP_VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("MESHKEEP_VAPID_PRIVATE_KEY", "priv");
    vi.stubEnv("MESHKEEP_VAPID_SUBJECT", "ops@example.test");
    expect(() => loadConfig()).toThrow(/MESHKEEP_VAPID_SUBJECT must be a mailto: address or an https URL/);
  });

  it("accepts only a base64 32-byte webhook master key", () => {
    vi.stubEnv("MESHKEEP_WEBHOOK_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    expect(loadConfig().webhookMasterKey?.equals(Buffer.alloc(32, 7))).toBe(true);
    vi.stubEnv("MESHKEEP_WEBHOOK_MASTER_KEY", "not-a-32-byte-base64-key");
    expect(() => loadConfig()).toThrow(/MESHKEEP_WEBHOOK_MASTER_KEY must be base64-encoded 32 bytes/);
  });

  it("rejects non-integer numeric values", () => {
    vi.stubEnv("MESHKEEP_PORT", "eighty-eighty");
    expect(() => loadConfig()).toThrow(/MESHKEEP_PORT must be an integer/);
  });

  const outOfRange: Array<[string, string]> = [
    ["MESHKEEP_PORT", "0"],
    ["MESHKEEP_PORT", "70000"],
    ["MESHKEEP_SERIAL_BAUD", "-115200"],
    ["MESHKEEP_TCP_PORT", "65536"],
    ["MESHKEEP_TELEMETRY_RETENTION_DAYS", "0"],
    ["MESHKEEP_MAP_REFRESH_MINUTES", "0"],
    ["MESHKEEP_MAP_REFRESH_MINUTES", "999999"],
    ["MESHKEEP_TELEMETRY_POLL_MINUTES", "0"],
    ["MESHKEEP_TELEMETRY_POLL_MINUTES", "61"],
    ["MESHKEEP_TELEMETRY_MONITOR_MINUTES", "1"],
    ["MESHKEEP_TELEMETRY_MONITOR_MINUTES", "99999"],
    ["MESHKEEP_TIMELINE_RETENTION_DAYS", "0"],
    ["MESHKEEP_TIMELINE_RETENTION_DAYS", "4000"],
    ["MESHKEEP_WEBHOOK_FAILURE_BURST", "0"],
    ["MESHKEEP_WEBHOOK_FAILURE_BURST", "101"],
    ["MESHKEEP_PUSH_FAILURE_BURST", "0"],
    ["MESHKEEP_PUSH_FAILURE_BURST", "101"],
  ];

  for (const [name, value] of outOfRange) {
    it(`rejects ${name}=${value}`, () => {
      vi.stubEnv(name, value);
      expect(() => loadConfig()).toThrow(new RegExp(`${name} must be between`));
    });
  }

  it("rejects unknown transports", () => {
    vi.stubEnv("MESHKEEP_CONNECTION", "carrier-pigeon");
    expect(() => loadConfig()).toThrow(/MESHKEEP_CONNECTION must be one of/);
  });

  it("accepts a same-origin self-hosted tile template", () => {
    vi.stubEnv("MESHKEEP_MAP_TILES_URL", "/tiles/{z}/{x}/{y}.png");
    expect(loadConfig().mapTilesUrl).toBe("/tiles/{z}/{x}/{y}.png");
  });

  it("disables browser tile requests for an offline map", () => {
    vi.stubEnv("MESHKEEP_MAP_TILES_ENABLED", "false");
    expect(loadConfig().mapTilesUrl).toBeNull();
    expect(loadConfig().mapTilesAttribution).toBeNull();
  });

  it("rejects tile URLs without a complete Leaflet template", () => {
    vi.stubEnv("MESHKEEP_MAP_TILES_URL", "https://tiles.example.com/map.png");
    expect(() => loadConfig()).toThrow(/MESHKEEP_MAP_TILES_URL must include/);
  });
});
