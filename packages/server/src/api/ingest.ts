import { z } from "zod";
import type { Contact, Message, SelfInfo } from "@meshkeep/shared";
import type { Bus } from "../bus.js";
import type { Store } from "../db/store.js";

/**
 * Ingest endpoints let a browser-direct session (WebSerial/WebBLE) sync what
 * it saw back into the server database, so history and the HLL plugin do not
 * depend on which mode drove the radio. Messages use a browser-generated
 * ingestion ID so retries are idempotent without collapsing repeated text.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/i);
const hexPrefix = z.string().regex(/^[0-9a-f]{2,64}$/i);

export const ingestMessageSchema = z
  .object({
    kind: z.enum(["dm", "channel"]),
    contactKey: hex64.optional(),
    contactPrefix: hexPrefix.optional(),
    channelIdx: z.number().int().min(0).max(255).optional(),
    direction: z.enum(["in", "out"]),
    text: z.string().min(1).max(4000),
    senderTimestamp: z.number().int().nonnegative(),
    pathLen: z.number().int().min(0).max(255).nullish(),
    status: z.enum(["pending", "sent", "delivered", "failed"]).optional(),
    authorPrefix: z
      .string()
      .regex(/^[0-9a-f]{8}$/i)
      .nullish(),
    ingestionId: z.string().uuid(),
  })
  .refine((m) => (m.kind === "dm" ? m.contactKey !== undefined || m.contactPrefix !== undefined : m.channelIdx !== undefined), {
    message: "dm messages need a contact key or sender prefix, channel messages need channelIdx",
  });

export const ingestContactSchema = z.object({
  publicKey: hex64,
  name: z.string().max(64),
  type: z.enum(["chat", "repeater", "room", "none"]),
  flags: z.number().int().default(0),
  outPathLen: z.number().int().default(-1),
  lat: z.number().min(-90).max(90).nullable().default(null),
  lon: z.number().min(-180).max(180).nullable().default(null),
  lastAdvert: z.number().int().nonnegative().default(0),
  lastSeen: z.number().int().nonnegative().nullable().default(null),
});

export const ingestSelfSchema = z.object({
  publicKey: hex64,
  name: z.string().max(64),
  type: z.number().int(),
  txPower: z.number().int(),
  maxTxPower: z.number().int(),
  lat: z.number().min(-90).max(90).nullable(),
  lon: z.number().min(-180).max(180).nullable(),
  radioFreq: z.number().int(),
  radioBw: z.number().int(),
  radioSf: z.number().int(),
  radioCr: z.number().int(),
  firmwareVer: z.number().int().nullish(),
  firmwareBuildDate: z.string().nullish(),
  manufacturerModel: z.string().nullish(),
});

export type IngestMessage = z.infer<typeof ingestMessageSchema>;

export function ingestMessages(
  store: Store,
  bus: Bus,
  items: IngestMessage[],
): { inserted: number; duplicates: number; messages: Message[] } {
  let inserted = 0;
  let duplicates = 0;
  const messages: Message[] = [];
  for (const item of items) {
    const normalized = {
      kind: item.kind,
      contactKey: item.contactKey?.toLowerCase() ?? null,
      contactPrefix: item.contactPrefix?.toLowerCase() ?? null,
      channelIdx: item.channelIdx ?? null,
      direction: item.direction,
      text: item.text,
      senderTimestamp: item.senderTimestamp,
      authorPrefix: item.authorPrefix?.toLowerCase() ?? null,
      ingestionId: item.ingestionId,
    };
    const message = store.insertMessage({
      ...normalized,
      pathLen: item.pathLen ?? null,
      status: item.status ?? "sent",
    });
    if (message) {
      inserted += 1;
      messages.push(message);
      bus.publish({ type: "message.new", message });
    } else {
      duplicates += 1;
      // a re-post may carry a later delivery state (browser-side ack arrived)
      if (item.status === "delivered" || item.status === "failed") {
        const updated = store.updateMessageStatusByIngestionId({ ingestionId: item.ingestionId, status: item.status });
        if (updated) {
          messages.push(updated);
          bus.publish({ type: "message.status", id: updated.id, status: updated.status });
        }
      }
    }
  }
  return { inserted, duplicates, messages };
}

export function ingestContacts(store: Store, bus: Bus, contacts: Contact[]): number {
  for (const contact of contacts) {
    const normalized = { ...contact, publicKey: contact.publicKey.toLowerCase() };
    store.upsertContact(normalized);
    bus.publish({ type: "contact.updated", contact: normalized });
  }
  return contacts.length;
}

export function ingestSelf(store: Store, bus: Bus, self: SelfInfo): void {
  const normalized = { ...self, publicKey: self.publicKey.toLowerCase() };
  store.saveSelf(normalized);
  bus.publish({ type: "self.updated", self: normalized });
}
