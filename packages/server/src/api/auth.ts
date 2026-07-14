import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getSetting, setSetting, type Db } from "../db/index.js";

const COOKIE_NAME = "meshkeep.sid";

export interface TokenRow {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

export class Auth {
  private readonly sessionSecret: Buffer;

  constructor(
    private readonly db: Db,
    private readonly uiPassword: string | null,
  ) {
    let secretHex = getSetting<string>(db, "auth.sessionSecret");
    if (!secretHex) {
      secretHex = randomBytes(32).toString("hex");
      setSetting(db, "auth.sessionSecret", secretHex);
    }
    this.sessionSecret = Buffer.from(secretHex, "hex");
  }

  get passwordRequired(): boolean {
    return this.uiPassword !== null;
  }

  private sessionCookieValue(): string {
    return createHmac("sha256", this.sessionSecret).update("meshkeep-session-v1").digest("hex");
  }

  login(password: string, res: Response): boolean {
    if (!this.uiPassword) return true;
    const expected = Buffer.from(this.uiPassword);
    const given = Buffer.from(password);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return false;
    }
    res.cookie?.(COOKIE_NAME, this.sessionCookieValue());
    // express without cookie-parser: set header manually for safety
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${this.sessionCookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    );
    return true;
  }

  logout(res: Response): void {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  private hasValidSession(req: Request): boolean {
    const header = req.headers.cookie;
    if (!header) return false;
    const expected = this.sessionCookieValue();
    return header.split(";").some((part) => {
      const [name, value] = part.trim().split("=");
      return (
        name === COOKIE_NAME &&
        value?.length === expected.length &&
        timingSafeEqual(Buffer.from(value), Buffer.from(expected))
      );
    });
  }

  private hasValidToken(req: Request): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return false;
    const hash = hashToken(token);
    const row = this.db.prepare("SELECT id FROM api_tokens WHERE token_hash = ?").get(hash) as
      | { id: number }
      | undefined;
    if (!row) return false;
    this.db
      .prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), row.id);
    return true;
  }

  isAuthorized(req: Request): boolean {
    if (!this.passwordRequired) return true;
    return this.hasValidSession(req) || this.hasValidToken(req);
  }

  /** Express middleware guarding /api routes. */
  guard = (req: Request, res: Response, next: NextFunction): void => {
    if (this.isAuthorized(req)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };

  createToken(label: string): { token: string; row: TokenRow } {
    const token = `mk_${randomBytes(24).toString("hex")}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare("INSERT INTO api_tokens (token_hash, label, created_at) VALUES (?, ?, ?)")
      .run(hashToken(token), label, createdAt);
    return {
      token,
      row: { id: Number(result.lastInsertRowid), label, created_at: createdAt, last_used_at: null },
    };
  }

  listTokens(): TokenRow[] {
    return this.db
      .prepare("SELECT id, label, created_at, last_used_at FROM api_tokens ORDER BY id")
      .all() as TokenRow[];
  }

  deleteToken(id: number): boolean {
    return this.db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes > 0;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
