import { afterEach, describe, expect, it } from "vitest";
import { clearLogs, logger, recentLogs, redactFields, sanitizeLogs, setLogLevel } from "../src/logger.js";

afterEach(() => {
  clearLogs();
  setLogLevel("info");
});

describe("logger ring buffer", () => {
  it("captures structured entries with scope, level, and fields", () => {
    logger("radio").warn("reconnecting", { attempt: 3, delayMs: 2000 });
    const [entry] = recentLogs();
    expect(entry).toMatchObject({ scope: "radio", level: "warn", event: "reconnecting", fields: { attempt: 3 } });
    expect(typeof entry!.ts).toBe("number");
  });

  it("isolates buffered fields from later caller mutation", () => {
    const fields = { attempt: 1 };
    logger("radio").info("reconnect-scheduled", fields);
    fields.attempt = 2;
    expect(recentLogs()[0]!.fields).toEqual({ attempt: 1 });
  });

  it("retains entries regardless of the emit level threshold", () => {
    setLogLevel("error"); // debug/info are not written to stdout…
    logger("api").debug("quiet");
    // …but they are still buffered for the diagnostics bundle
    expect(recentLogs().map((e) => e.event)).toEqual(["quiet"]);
  });

  it("bounds memory by dropping the oldest entries past capacity", () => {
    setLogLevel("error"); // keep 600 buffered entries out of the test's stdout
    const log = logger("test");
    for (let i = 0; i < 600; i++) log.info("tick", { i });
    const entries = recentLogs();
    expect(entries).toHaveLength(500); // RING_CAPACITY
    // the oldest 100 were dropped; the newest is retained
    expect(entries[0]!.fields).toEqual({ i: 100 });
    expect(entries.at(-1)!.fields).toEqual({ i: 599 });
  });
});

describe("log redaction", () => {
  it("redacts secret-shaped field keys", () => {
    expect(redactFields({ host: "radio.local", password: "hunter2", apiKey: "abc", token: "t" })).toEqual({
      host: "radio.local",
      password: "[redacted]",
      apiKey: "[redacted]",
      token: "[redacted]",
    });
  });

  it("sanitizes buffered entries without mutating the originals", () => {
    logger("api").info("login", { user: "alice", cookie: "session=secret" });
    const sanitized = sanitizeLogs(recentLogs());
    expect(sanitized[0]!.fields).toEqual({ user: "alice", cookie: "[redacted]" });
    // original ring entry is untouched
    expect(recentLogs()[0]!.fields).toEqual({ user: "alice", cookie: "session=secret" });
  });
});
