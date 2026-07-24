import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/index.js";

const COOKIE_NAME = "meshkeep.sid";
const SESSION_TTL_SECS = 60 * 60 * 24 * 30;
/** Failed logins allowed per client before a cooldown. */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
/** Persist a token's last-used time at most this often, not on every request. */
const LAST_USED_THROTTLE_SECS = 5 * 60;

const now = () => Math.floor(Date.now() / 1000);

export type TokenScope = "read" | "write";

export interface TokenRow {
  id: number;
  label: string;
  scope: TokenScope;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

export type LoginResult = "ok" | "invalid" | "throttled";

function isMutation(req: Request): boolean {
  return req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
}

export class Auth {
  /** Failed-login tracker per client address (in memory; resets on restart). */
  private readonly loginFailures = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly db: Db,
    private readonly uiPassword: string | null,
  ) {}

  get passwordRequired(): boolean {
    return this.uiPassword !== null;
  }

  /** HTTPS either directly or via a reverse proxy that sets x-forwarded-proto. */
  private secureRequest(req: Request): boolean {
    if (req.secure) return true;
    const proto = req.headers["x-forwarded-proto"];
    return typeof proto === "string" && proto.split(",")[0]!.trim() === "https";
  }

  private clientKey(req: Request): string {
    return req.ip ?? req.socket?.remoteAddress ?? "unknown";
  }

  private isThrottled(client: string): boolean {
    const entry = this.loginFailures.get(client);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
      this.loginFailures.delete(client);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  private recordFailure(client: string): void {
    const entry = this.loginFailures.get(client);
    if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
      this.loginFailures.set(client, { count: 1, windowStart: Date.now() });
    } else {
      entry.count += 1;
    }
  }

  login(password: string, req: Request, res: Response): LoginResult {
    if (!this.uiPassword) return "ok";
    const client = this.clientKey(req);
    if (this.isThrottled(client)) {
      console.warn(`[auth] login throttled for ${client}`);
      return "throttled";
    }
    const expectedHash = createHash("sha256").update(this.uiPassword).digest();
    const givenHash = createHash("sha256").update(password).digest();
    if (!timingSafeEqual(expectedHash, givenHash)) {
      this.recordFailure(client);
      console.warn(`[auth] failed login from ${client}`);
      return "invalid";
    }
    this.loginFailures.delete(client);
    // random server-side session: revocable, expiring, one per login
    const session = randomBytes(32).toString("hex");
    const created = now();
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(created);
    this.db
      .prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(session), created, created + SESSION_TTL_SECS);
    const secure = this.secureRequest(req) ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECS}${secure}`,
    );
    console.log(`[auth] login from ${client}`);
    return "ok";
  }

  logout(req: Request, res: Response): void {
    const session = this.readSessionCookie(req);
    if (session) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(session));
    }
    const secure = this.secureRequest(req) ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  }

  private readSessionCookie(req: Request): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === COOKIE_NAME && value) return value;
    }
    return null;
  }

  private hasValidSession(req: Request): boolean {
    const session = this.readSessionCookie(req);
    if (!session) return false;
    const row = this.db
      .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(session)) as { expires_at: number } | undefined;
    return row !== undefined && row.expires_at > now();
  }

  /** Bearer-token authentication; returns the token's scope or null. */
  private tokenAuth(req: Request): { scope: TokenScope } | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return null;
    const row = this.db
      .prepare("SELECT id, scope, last_used_at, expires_at FROM api_tokens WHERE token_hash = ?")
      .get(hashToken(token)) as
      | { id: number; scope: TokenScope; last_used_at: number | null; expires_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now()) return null;
    if (row.last_used_at === null || now() - row.last_used_at >= LAST_USED_THROTTLE_SECS) {
      this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
    }
    return { scope: row.scope };
  }

  isAuthorized(req: Request): boolean {
    if (!this.passwordRequired) return true;
    return this.hasValidSession(req) || this.tokenAuth(req) !== null;
  }

  /** Express middleware guarding /api routes; mutations need a write-capable principal. */
  guard = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.passwordRequired || this.hasValidSession(req)) {
      next();
      return;
    }
    const token = this.tokenAuth(req);
    if (token) {
      if (isMutation(req) && token.scope !== "write") {
        res.status(403).json({ error: "token lacks write scope" });
        return;
      }
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };

  /** Token management is session-only: bearer tokens can never mint, list, or revoke tokens. */
  sessionGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.passwordRequired || this.hasValidSession(req)) {
      next();
      return;
    }
    const viaToken = this.tokenAuth(req) !== null;
    res.status(viaToken ? 403 : 401).json({ error: viaToken ? "session required" : "unauthorized" });
  };

  /**
   * Cross-site mutation defense for cookie/open-mode requests. Bearer-token
   * clients skip the check (a browser cannot attach the header cross-site);
   * everything else must arrive same-origin when the browser says otherwise.
   */
  originGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!isMutation(req) || req.headers.authorization?.startsWith("Bearer ")) {
      next();
      return;
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite === "cross-site") {
      res.status(403).json({ error: "cross-site request rejected" });
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        res.status(403).json({ error: "cross-site request rejected" });
        return;
      }
      if (originHost !== req.headers.host) {
        res.status(403).json({ error: "cross-site request rejected" });
        return;
      }
    }
    next();
  };

  createToken(label: string, scope: TokenScope = "read", expiresInSecs: number | null = null): { token: string; row: TokenRow } {
    const token = `mk_${randomBytes(24).toString("hex")}`;
    const createdAt = now();
    const expiresAt = expiresInSecs === null ? null : createdAt + expiresInSecs;
    const result = this.db
      .prepare("INSERT INTO api_tokens (token_hash, label, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(token), label, scope, createdAt, expiresAt);
    return {
      token,
      row: {
        id: Number(result.lastInsertRowid),
        label,
        scope,
        created_at: createdAt,
        last_used_at: null,
        expires_at: expiresAt,
      },
    };
  }

  /** Replace a token's secret in place; the old value stops working immediately. */
  rotateToken(id: number): { token: string; row: TokenRow } | null {
    const existing = this.db
      .prepare("SELECT id, label, scope, created_at, expires_at FROM api_tokens WHERE id = ?")
      .get(id) as Omit<TokenRow, "last_used_at"> | undefined;
    if (!existing) return null;
    const token = `mk_${randomBytes(24).toString("hex")}`;
    this.db
      .prepare("UPDATE api_tokens SET token_hash = ?, last_used_at = NULL WHERE id = ?")
      .run(hashToken(token), id);
    return { token, row: { ...existing, last_used_at: null } };
  }

  listTokens(): TokenRow[] {
    return this.db
      .prepare("SELECT id, label, scope, created_at, last_used_at, expires_at FROM api_tokens ORDER BY id")
      .all() as TokenRow[];
  }

  deleteToken(id: number): boolean {
    return this.db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes > 0;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
