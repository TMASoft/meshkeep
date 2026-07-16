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
});
