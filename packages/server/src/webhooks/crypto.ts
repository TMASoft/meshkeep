import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";

export interface EncryptedWebhookSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

export interface WebhookCrypto {
  encrypt(secret: Buffer): EncryptedWebhookSecret;
  decrypt(encrypted: EncryptedWebhookSecret): Buffer;
}

/** Decode the deployment secret without ever retaining the original env string. */
export function parseWebhookMasterKey(value: string | null): Buffer | null {
  if (value === null) return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("MESHKEEP_WEBHOOK_MASTER_KEY must be base64-encoded 32 bytes");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("MESHKEEP_WEBHOOK_MASTER_KEY must be base64-encoded 32 bytes");
  return key;
}

export function createWebhookCrypto(masterKey: Buffer): WebhookCrypto {
  if (masterKey.length !== 32) throw new Error("webhook master key must be 32 bytes");
  return {
    encrypt(secret) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
      return { ciphertext: Buffer.concat([cipher.update(secret), cipher.final()]), nonce, authTag: cipher.getAuthTag() };
    },
    decrypt(encrypted) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", masterKey, encrypted.nonce);
        decipher.setAuthTag(encrypted.authTag);
        return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
      } catch {
        throw new Error("cannot decrypt existing webhook signing keys");
      }
    },
  };
}

/**
 * A forward-migrated database must never silently start with a different key.
 * Operators roll back by restoring a SQLite backup made before the migration;
 * running an old binary against this newer schema is unsupported.
 */
export function verifyStoredWebhookKeys(db: Db, masterKey: Buffer | null): void {
  const row = db
    .prepare("SELECT secret_ciphertext, secret_nonce, secret_auth_tag FROM webhook_keys LIMIT 1")
    .get() as { secret_ciphertext: Buffer; secret_nonce: Buffer; secret_auth_tag: Buffer } | undefined;
  if (!row) return;
  if (masterKey === null) throw new Error("MESHKEEP_WEBHOOK_MASTER_KEY is required to open a database with webhook signing keys");
  createWebhookCrypto(masterKey).decrypt({
    ciphertext: row.secret_ciphertext,
    nonce: row.secret_nonce,
    authTag: row.secret_auth_tag,
  });
}
