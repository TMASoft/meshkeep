import { CONTACT_TYPE_FROM_ADV, type Contact, type Message, type SelfInfo } from "@meshkeep/shared";

/**
 * Pure pieces of the browser-radio source (frame/response mapping, sync-queue
 * replay, private-session message synthesis), extracted so they unit-test
 * without a device, IndexedDB, or the meshcore.js transports (issue #16).
 */

export const GEO_SCALE = 1e6;

export interface IngestItem {
  kind: "dm" | "channel";
  contactKey?: string;
  channelIdx?: number;
  direction: "in" | "out";
  text: string;
  senderTimestamp: number;
  pathLen?: number | null;
  status?: Message["status"];
  authorPrefix?: string | null;
}

export interface QueueEntry {
  kind: "messages" | "contacts" | "self";
  payload: unknown;
}

/** Storage seam for offline sync-backs (IndexedDB in the browser). */
export interface IngestQueue {
  put(entry: QueueEntry): Promise<void>;
  takeAll(): Promise<QueueEntry[]>;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeDeviceText(value: string): string {
  return value.split("\0").filter(Boolean).join(" ").trim();
}

interface RawSelf {
  type: number;
  txPower: number;
  maxTxPower: number;
  publicKey: Uint8Array;
  advLat: number;
  advLon: number;
  radioFreq: number;
  radioBw: number;
  radioSf: number;
  radioCr: number;
  name: string;
}

interface RawDevice {
  firmwareVer: number;
  firmware_build_date: string;
  manufacturerModel: string;
}

export function selfInfoFromRaw(rawSelf: RawSelf, device: RawDevice | null): SelfInfo {
  return {
    publicKey: bytesToHex(rawSelf.publicKey),
    name: rawSelf.name,
    type: rawSelf.type,
    txPower: rawSelf.txPower,
    maxTxPower: rawSelf.maxTxPower,
    lat: rawSelf.advLat === 0 ? null : rawSelf.advLat / GEO_SCALE,
    lon: rawSelf.advLon === 0 ? null : rawSelf.advLon / GEO_SCALE,
    radioFreq: rawSelf.radioFreq,
    radioBw: rawSelf.radioBw,
    radioSf: rawSelf.radioSf,
    radioCr: rawSelf.radioCr,
    firmwareVer: device?.firmwareVer ?? null,
    firmwareBuildDate: device?.firmware_build_date ?? null,
    manufacturerModel: device ? normalizeDeviceText(device.manufacturerModel) : null,
  };
}

interface RawContact {
  publicKey: Uint8Array;
  type: number;
  flags: number;
  outPathLen: number;
  advName: string;
  lastAdvert: number;
  advLat: number;
  advLon: number;
}

export function contactFromRaw(raw: RawContact): Contact {
  return {
    publicKey: bytesToHex(raw.publicKey),
    name: raw.advName,
    type: CONTACT_TYPE_FROM_ADV[raw.type] ?? "none",
    flags: raw.flags,
    outPathLen: raw.outPathLen,
    lat: raw.advLat === 0 ? null : raw.advLat / GEO_SCALE,
    lon: raw.advLon === 0 ? null : raw.advLon / GEO_SCALE,
    lastAdvert: raw.lastAdvert,
    lastSeen: null,
  };
}

export interface SyncedMessage {
  contactMessage?: {
    pubKeyPrefix: Uint8Array;
    pathLen: number;
    txtType: number;
    senderTimestamp: number;
    signedAuthorPrefix?: string | null;
    text: string;
  };
  channelMessage?: {
    channelIdx: number;
    pathLen: number;
    txtType: number;
    senderTimestamp: number;
    text: string;
  };
  channelData?: unknown;
}

/** Map one syncNextMessage response to an ingest item (null for e.g. channelData). */
export function ingestItemFromSync(next: SyncedMessage, contacts: Contact[]): IngestItem | null {
  if (next.contactMessage) {
    const m = next.contactMessage;
    const prefixHex = bytesToHex(m.pubKeyPrefix);
    const contact = contacts.find((c) => c.publicKey.startsWith(prefixHex));
    return {
      kind: "dm",
      contactKey: contact?.publicKey ?? prefixHex.padEnd(64, "0"),
      direction: "in",
      text: m.text,
      senderTimestamp: m.senderTimestamp,
      pathLen: m.pathLen === 0xff ? null : m.pathLen,
      status: "sent",
      authorPrefix: m.signedAuthorPrefix ?? null,
    };
  }
  if (next.channelMessage) {
    const m = next.channelMessage;
    return {
      kind: "channel",
      channelIdx: m.channelIdx,
      direction: "in",
      text: m.text,
      senderTimestamp: m.senderTimestamp,
      pathLen: m.pathLen === 0xff ? null : m.pathLen,
      status: "sent",
    };
  }
  return null;
}

/** Synthesize a private-session Message (negative ids, never touches the server). */
export function localMessageFromItem(item: IngestItem, contacts: Contact[], id: number, nowSecs: number): Message {
  const contact = item.contactKey ? contacts.find((c) => c.publicKey === item.contactKey) : null;
  return {
    id,
    kind: item.kind,
    contactKey: item.contactKey ?? null,
    contactName: contact?.name ?? null,
    channelIdx: item.channelIdx ?? null,
    channelName: null,
    direction: item.direction,
    text: item.text,
    senderTimestamp: item.senderTimestamp,
    pathLen: item.pathLen ?? null,
    status: item.status ?? "sent",
    createdAt: nowSecs,
    authorPrefix: item.authorPrefix ?? null,
    authorName: item.authorPrefix
      ? contacts.find((c) => c.publicKey.startsWith(item.authorPrefix!))?.name ?? null
      : null,
  };
}

/** Remove and return the pending ack matching a SendConfirmed push, if any. */
export function takePendingAck<T extends { ackCrc: number }>(pending: T[], ackCode: number): T | null {
  const index = pending.findIndex((p) => p.ackCrc === ackCode);
  if (index < 0) return null;
  return pending.splice(index, 1)[0] ?? null;
}

/**
 * Replay queued sync-backs oldest-first. On the first failure the entry (and
 * everything after it, which was never taken out of order) goes back to the
 * queue and the flush stops — the server is still unreachable.
 */
export async function flushQueueOnce(
  queue: IngestQueue,
  post: (kind: QueueEntry["kind"], payload: unknown) => Promise<void>,
): Promise<void> {
  const entries = await queue.takeAll();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    try {
      await post(entry.kind, entry.payload);
    } catch {
      for (const remaining of entries.slice(i)) await queue.put(remaining);
      return;
    }
  }
}
