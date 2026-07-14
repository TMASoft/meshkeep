import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../config.js";

interface CacheState {
  fetchedAt: number;
  payload: unknown;
}

/**
 * Rate-friendly cache of the public map.meshcore.io node feed. One upstream
 * fetch at most every `mapRefreshMinutes`, shared by every browser; the last
 * good payload survives restarts on disk.
 */
export class MapCache {
  private state: CacheState | null = null;
  private inflight: Promise<unknown> | null = null;
  private readonly file: string;
  private readonly ttlMs: number;
  private lastError: string | null = null;

  constructor(private readonly config: ServerConfig, appVersion: string) {
    this.file = join(config.dataDir, "map-cache.json");
    this.ttlMs = Math.max(config.mapRefreshMinutes, 1) * 60_000;
    this.userAgent = `meshkeep/${appVersion} (+https://github.com/arroyo/meshkeep)`;
    try {
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as CacheState;
    } catch {
      // no cache yet
    }
  }

  private readonly userAgent: string;

  get enabled(): boolean {
    return this.config.mapEnabled;
  }

  status(): { fetchedAt: number | null; lastError: string | null } {
    return { fetchedAt: this.state?.fetchedAt ?? null, lastError: this.lastError };
  }

  async getNodes(): Promise<{ payload: unknown; fetchedAt: number; stale: boolean }> {
    if (!this.enabled) throw new Error("global map is disabled (MESHKEEP_MAP_ENABLED=false)");
    const fresh = this.state && Date.now() - this.state.fetchedAt < this.ttlMs;
    if (!fresh) {
      try {
        await this.refresh();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (!this.state) throw error;
      }
    }
    return {
      payload: this.state!.payload,
      fetchedAt: this.state!.fetchedAt,
      stale: Date.now() - this.state!.fetchedAt >= this.ttlMs,
    };
  }

  private refresh(): Promise<unknown> {
    this.inflight ??= (async () => {
      try {
        const response = await fetch(this.config.mapUpstream, {
          headers: { "User-Agent": this.userAgent, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new Error(`upstream map API returned ${response.status}`);
        }
        const payload = await response.json();
        this.state = { fetchedAt: Date.now(), payload };
        this.lastError = null;
        try {
          mkdirSync(dirname(this.file), { recursive: true });
          writeFileSync(this.file, JSON.stringify(this.state));
        } catch {
          // disk cache is best-effort
        }
        return payload;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
