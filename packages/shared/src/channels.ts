// Channel key/share conventions from the official MeshCore app.
// Sources: meshcore-dev/MeshCore docs/companion_protocol.md ("Channel Types")
// and docs/qr_codes.md ("Add Channel").

// This module runs in both Node and browsers; the base tsconfig has neither
// lib, so declare the WinterCG globals we rely on.
declare const crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
declare class TextEncoder {
  encode(input: string): Uint8Array;
}

export const PUBLIC_CHANNEL_SECRET_HEX = "8b3387e9c5cdea6ac9e5edbaa115cd72";

export const CHANNEL_SECRET_BYTES = 16;

const HEX_SECRET_RE = /^[0-9a-fA-F]{32}$/;
// 16 bytes of base64 is 22 significant chars + "==" padding.
const BASE64_SECRET_RE = /^[0-9a-zA-Z+/]{22}(==)?$/;

export function isHashtagChannelName(name: string): boolean {
  return name.startsWith("#");
}

/**
 * Hashtag channels derive their PSK from the channel name (including the
 * leading '#') so everyone typing the same #name lands on the same channel:
 * the key is the first 16 bytes of sha256(name).
 * Verified against the documented vector: "#test" → 9cd8fcf22a47333b591d96a2b848b73f.
 */
export async function deriveHashtagChannelSecret(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  return bytesToHex(new Uint8Array(digest).subarray(0, CHANNEL_SECRET_BYTES));
}

/**
 * Accept a channel secret as 32 hex chars or as the 16-byte base64 form the
 * official app shares (e.g. Public is "izOH6cXN6mrJ5e26oRXNcg==").
 * Returns lowercase hex, or null when the input is neither.
 */
export function normalizeChannelSecret(input: string): string | null {
  const value = input.trim();
  if (HEX_SECRET_RE.test(value)) return value.toLowerCase();
  if (BASE64_SECRET_RE.test(value)) {
    const padded = value.endsWith("==") ? value : `${value}==`;
    try {
      const bytes = base64ToBytes(padded);
      if (bytes.length === CHANNEL_SECRET_BYTES) return bytesToHex(bytes);
    } catch {
      return null;
    }
  }
  return null;
}

export function channelSecretToBase64(hex: string): string {
  const bytes = new Uint8Array(CHANNEL_SECRET_BYTES);
  for (let i = 0; i < CHANNEL_SECRET_BYTES; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
}

export interface ChannelShare {
  name: string;
  /** Lowercase hex secret. */
  secret: string;
}

/**
 * Parse the official app's channel share URI:
 * meshcore://channel/add?name=Public&secret=8b3387e9c5cdea6ac9e5edbaa115cd72
 * (optional region_scope is ignored). Returns null when the URI is not a
 * channel share or the secret is malformed.
 */
export function parseChannelShareUri(uri: string): ChannelShare | null {
  const match = /^meshcore:\/\/channel\/add\/?\?(.+)$/i.exec(uri.trim());
  if (!match) return null;
  const params = new Map<string, string>();
  for (const pair of match[1]!.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      // the official app encodes spaces as '+' (e.g. name=Example+Contact)
      params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " ")));
    } catch {
      return null;
    }
  }
  const name = params.get("name")?.trim();
  if (!name) return null;
  const normalized = normalizeChannelSecret(params.get("secret") ?? "");
  if (!normalized) return null;
  return { name, secret: normalized };
}

export function buildChannelShareUri(name: string, secretHex: string): string {
  return `meshcore://channel/add?name=${encodeURIComponent(name)}&secret=${secretHex}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(value: string): Uint8Array {
  const stripped = value.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((stripped.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of stripped) {
    const sextet = BASE64_ALPHABET.indexOf(char);
    if (sextet < 0) throw new Error("invalid base64");
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = [bytes[i], bytes[i + 1], bytes[i + 2]];
    output += BASE64_ALPHABET[chunk[0]! >> 2];
    output += BASE64_ALPHABET[((chunk[0]! & 0x03) << 4) | ((chunk[1] ?? 0) >> 4)];
    output += chunk[1] === undefined ? "=" : BASE64_ALPHABET[((chunk[1] & 0x0f) << 2) | ((chunk[2] ?? 0) >> 6)];
    output += chunk[2] === undefined ? "=" : BASE64_ALPHABET[chunk[2] & 0x3f];
  }
  return output;
}
