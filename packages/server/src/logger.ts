/**
 * Small structured logger with an in-memory ring buffer. Every entry is written
 * as a single JSON line (machine-parseable in container logs) and retained in a
 * bounded buffer so the diagnostics support bundle can include recent history
 * without a log-shipping stack. Callers pass structured `fields` rather than
 * interpolating strings, and must never log secrets or message content — the
 * bundle redacts obvious secret-shaped keys defensively, but content is a
 * caller responsibility.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  event: string;
  fields?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const raw = process.env.MESHKEEP_LOG_LEVEL?.toLowerCase();
  return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : "info";
}

const RING_CAPACITY = 500;

class RingBuffer {
  private entries: LogEntry[] = [];

  constructor(private readonly capacity: number) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  snapshot(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

const ring = new RingBuffer(RING_CAPACITY);
let minLevel = envLevel();

/** Override the minimum emitted level (mainly for tests). */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export class Logger {
  constructor(private readonly scope: string) {}

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }

  private log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, scope: this.scope, event };
    if (fields && Object.keys(fields).length > 0) entry.fields = fields;
    ring.push(entry);
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = JSON.stringify(entry);
    if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

export function logger(scope: string): Logger {
  return new Logger(scope);
}

/** Recent log history (oldest first) for the diagnostics bundle. */
export function recentLogs(): LogEntry[] {
  return ring.snapshot();
}

/** Reset the ring buffer — used by tests for isolation. */
export function clearLogs(): void {
  ring.clear();
}

const SECRET_KEY = /pass(word)?|secret|token|cookie|authorization|api[-_]?key/i;

/** Redact secret-shaped field values so a bundle never carries credentials. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : value;
  }
  return out;
}

/** A copy of the given log entries with secret-shaped fields redacted. */
export function sanitizeLogs(entries: LogEntry[]): LogEntry[] {
  return entries.map((entry) => (entry.fields ? { ...entry, fields: redactFields(entry.fields) } : entry));
}
