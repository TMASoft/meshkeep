import { Router, json, type Request, type Response } from "express";
import { z } from "zod";
import type { ConnectionManager } from "../radio/manager.js";
import { RadioUnavailableError } from "../radio/manager.js";
import { listSerialPorts, scanBleRadios } from "../radio/detect.js";
import type { MapCache } from "../map/cache.js";
import type { Bus } from "../bus.js";
import type { Auth } from "./auth.js";
import { messagesToCsv } from "./export.js";
import {
  ingestContactSchema,
  ingestContacts,
  ingestMessageSchema,
  ingestMessages,
  ingestSelf,
  ingestSelfSchema,
} from "./ingest.js";

function handle(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "invalid request", details: error.issues });
      } else if (error instanceof RadioUnavailableError) {
        res.status(503).json({ error: error.message });
      } else {
        const message = error instanceof Error ? error.message : "internal error";
        res.status(500).json({ error: message });
      }
    }
  };
}

export function buildApi(manager: ConnectionManager, mapCache: MapCache, auth: Auth, bus: Bus): Router {
  const api = Router();
  api.use(json({ limit: "1mb" }));

  // ---- auth (unguarded) ----
  api.post(
    "/auth/login",
    handle((req, res) => {
      const { password } = z.object({ password: z.string() }).parse(req.body);
      if (auth.login(password, res)) {
        res.json({ ok: true });
      } else {
        res.status(401).json({ error: "wrong password" });
      }
    }),
  );
  api.post(
    "/auth/logout",
    handle((_req, res) => {
      auth.logout(res);
      res.json({ ok: true });
    }),
  );
  api.get(
    "/auth/session",
    handle((req, res) => {
      res.json({ passwordRequired: auth.passwordRequired, authorized: auth.isAuthorized(req) });
    }),
  );

  // everything below requires auth (no-op when no password is configured)
  api.use(auth.guard);

  // ---- status ----
  api.get(
    "/status",
    handle((_req, res) => {
      res.json(manager.status());
    }),
  );

  // ---- contacts ----
  api.get(
    "/contacts",
    handle((_req, res) => {
      res.json({ contacts: manager.store.getContacts() });
    }),
  );
  api.post(
    "/contacts/refresh",
    handle(async (_req, res) => {
      res.json({ contacts: await manager.refreshContacts() });
    }),
  );
  api.delete(
    "/contacts/:key",
    handle(async (req, res) => {
      await manager.removeContact(hexKey(req.params.key));
      res.json({ ok: true });
    }),
  );
  api.post(
    "/contacts/:key/path-reset",
    handle(async (req, res) => {
      await manager.resetContactPath(hexKey(req.params.key));
      res.json({ ok: true });
    }),
  );
  api.get(
    "/contacts/:key/export",
    handle(async (req, res) => {
      res.json({ uri: await manager.exportContactUri(hexKey(req.params.key)) });
    }),
  );
  api.post(
    "/contacts/:key/login",
    handle(async (req, res) => {
      const { password } = z.object({ password: z.string().min(1).max(15) }).parse(req.body);
      const ok = await manager.loginToNode(hexKey(req.params.key), password);
      if (ok) {
        res.json({ ok: true });
      } else {
        res.status(401).json({ error: "login rejected (wrong password or node unreachable)" });
      }
    }),
  );
  api.get(
    "/contacts/:key/status",
    handle(async (req, res) => {
      res.json({ status: await manager.getNodeStatus(hexKey(req.params.key)) });
    }),
  );
  api.get(
    "/contacts/:key/telemetry",
    handle(async (req, res) => {
      res.json({ telemetry: await manager.requestTelemetry(hexKey(req.params.key)) });
    }),
  );
  api.get(
    "/contacts/:key/telemetry/history",
    handle((req, res) => {
      const hours = z.coerce.number().int().min(1).max(24 * 30).default(24 * 7).parse(req.query.hours ?? 24 * 7);
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      res.json({ points: manager.store.getContactTelemetry(hexKey(req.params.key), since) });
    }),
  );
  api.post(
    "/contacts/:key/cli",
    handle(async (req, res) => {
      const { command } = z.object({ command: z.string().min(1).max(2000) }).parse(req.body);
      const message = await manager.sendDirectMessage(hexKey(req.params.key), command, true);
      res.status(201).json({ message });
    }),
  );
  api.post(
    "/contacts/import",
    handle(async (req, res) => {
      const { uri } = z.object({ uri: z.string().min(8).max(2048) }).parse(req.body);
      res.json({ contacts: await manager.importContactUri(uri) });
    }),
  );

  // ---- messages ----
  api.get(
    "/messages/recent",
    handle((req, res) => {
      const limit = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit ?? 20);
      res.json({ messages: manager.store.getRecentMessages(limit) });
    }),
  );
  api.get(
    "/messages/search",
    handle((req, res) => {
      const query = z
        .object({
          q: z.string().min(1).max(200),
          contact: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
          channel: z.coerce.number().int().min(0).max(255).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(req.query);
      res.json({
        results: manager.store.searchMessages({
          query: query.q,
          contactKey: query.contact?.toLowerCase(),
          channelIdx: query.channel,
          limit: query.limit,
        }),
      });
    }),
  );
  api.get(
    "/messages/export",
    handle((req, res) => {
      const query = z
        .object({
          format: z.enum(["csv", "json"]).default("csv"),
          contact: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
          channel: z.coerce.number().int().min(0).max(255).optional(),
        })
        .parse(req.query);
      const messages = manager.store.getMessagesForExport({
        contactKey: query.contact?.toLowerCase(),
        channelIdx: query.channel,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      if (query.format === "json") {
        res.setHeader("Content-Disposition", `attachment; filename="meshkeep-messages-${stamp}.json"`);
        res.json({ exportedAt: Math.floor(Date.now() / 1000), messages });
      } else {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="meshkeep-messages-${stamp}.csv"`);
        res.send(messagesToCsv(messages));
      }
    }),
  );
  api.get(
    "/messages",
    handle((req, res) => {
      const query = z
        .object({
          contact: z.string().regex(/^[0-9a-f]{2,64}$/i).optional(),
          channel: z.coerce.number().int().min(0).max(255).optional(),
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      res.json({
        messages: manager.store.getConversation({
          contactKey: query.contact?.toLowerCase(),
          channelIdx: query.channel,
          beforeId: query.before,
          limit: query.limit,
        }),
      });
    }),
  );
  api.post(
    "/messages",
    handle(async (req, res) => {
      const body = z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("dm"), to: z.string().regex(/^[0-9a-f]{64}$/i), text: z.string().min(1).max(2000) }),
          z.object({ kind: z.literal("channel"), channelIdx: z.number().int().min(0).max(255), text: z.string().min(1).max(2000) }),
        ])
        .parse(req.body);
      const message =
        body.kind === "dm"
          ? await manager.sendDirectMessage(body.to.toLowerCase(), body.text)
          : await manager.sendChannelMessage(body.channelIdx, body.text);
      res.status(201).json({ message });
    }),
  );
  api.post(
    "/messages/read",
    handle((req, res) => {
      const body = z
        .object({
          contact: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
          channel: z.number().int().min(0).max(255).optional(),
        })
        .refine((value) => value.contact !== undefined || value.channel !== undefined, {
          message: "contact or channel is required",
        })
        .parse(req.body);
      manager.store.markConversationRead({ contactKey: body.contact?.toLowerCase(), channelIdx: body.channel });
      res.json({ ok: true });
    }),
  );

  // ---- channels ----
  api.get(
    "/channels",
    handle((_req, res) => {
      res.json({ channels: manager.store.getChannels() });
    }),
  );
  api.post(
    "/channels/refresh",
    handle(async (_req, res) => {
      res.json({ channels: await manager.refreshChannels() });
    }),
  );
  api.put(
    "/channels/:idx",
    handle(async (req, res) => {
      const idx = z.coerce.number().int().min(0).max(7).parse(req.params.idx);
      const body = z
        .object({ name: z.string().min(1).max(31), secret: z.string().regex(/^[0-9a-f]{32}$/i) })
        .parse(req.body);
      res.json({ channel: await manager.setChannel(idx, body.name, body.secret.toLowerCase()) });
    }),
  );
  api.delete(
    "/channels/:idx",
    handle(async (req, res) => {
      const idx = z.coerce.number().int().min(0).max(7).parse(req.params.idx);
      await manager.deleteChannel(idx);
      res.json({ ok: true });
    }),
  );

  // ---- device ----
  api.post(
    "/advert",
    handle(async (req, res) => {
      const { flood } = z.object({ flood: z.boolean().default(false) }).parse(req.body ?? {});
      await manager.sendAdvert(flood);
      res.json({ ok: true });
    }),
  );
  api.patch(
    "/device",
    handle(async (req, res) => {
      const patch = z
        .object({
          name: z.string().min(1).max(31).optional(),
          lat: z.number().min(-90).max(90).optional(),
          lon: z.number().min(-180).max(180).optional(),
          txPower: z.number().int().min(0).max(30).optional(),
          radioFreq: z.number().int().positive().optional(),
          radioBw: z.number().int().positive().optional(),
          radioSf: z.number().int().min(5).max(12).optional(),
          radioCr: z.number().int().min(5).max(8).optional(),
        })
        .refine((value) => (value.lat === undefined) === (value.lon === undefined), {
          message: "lat and lon must be set together",
        })
        .parse(req.body);
      res.json({ self: await manager.setDeviceSettings(patch) });
    }),
  );

  api.get(
    "/device/share",
    handle(async (_req, res) => {
      res.json({ uri: await manager.exportContactUri(null) });
    }),
  );

  // ---- telemetry ----
  api.get(
    "/telemetry",
    handle((req, res) => {
      const hours = z.coerce.number().int().min(1).max(24 * 30).default(24).parse(req.query.hours ?? 24);
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      res.json({ points: manager.store.getTelemetry(since) });
    }),
  );

  // ---- hardware detection (Radio → Connection) ----
  api.get(
    "/system/ports",
    handle(async (_req, res) => {
      res.json({ ports: await listSerialPorts() });
    }),
  );
  api.get(
    "/system/ble-scan",
    handle(async (req, res) => {
      const seconds = z.coerce.number().min(2).max(15).default(6).parse(req.query.seconds ?? 6);
      try {
        res.json({ devices: await scanBleRadios(seconds * 1000) });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        res.status(503).json({ error: `BLE scan unavailable (BlueZ/D-Bus not reachable): ${detail}` });
      }
    }),
  );

  // ---- connection ownership ----
  api.post(
    "/connection/release",
    handle(async (_req, res) => {
      await manager.release();
      res.json({ ok: true, state: manager.getState() });
    }),
  );
  api.post(
    "/connection/claim",
    handle(async (_req, res) => {
      await manager.claim();
      res.json({ ok: true, state: manager.getState() });
    }),
  );
  api.get(
    "/connection/config",
    handle((_req, res) => {
      res.json(manager.connectionSettings());
    }),
  );
  api.put(
    "/connection/config",
    handle(async (req, res) => {
      const override = z
        .object({
          connection: z.enum(["serial", "tcp", "ble", "none"]),
          serialPort: z.string().min(1).max(256).nullish(),
          tcpHost: z.string().min(1).max(256).nullish(),
          tcpPort: z.number().int().min(1).max(65535).optional(),
          bleAddress: z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i).nullish(),
        })
        .nullable()
        .parse(req.body?.override ?? null);
      await manager.setConnectionOverride(override);
      res.json({ ...manager.connectionSettings(), state: manager.getState() });
    }),
  );

  // ---- ingest (browser-direct sessions sync what they saw back to the server) ----
  api.post(
    "/ingest/messages",
    handle((req, res) => {
      const { messages } = z.object({ messages: z.array(ingestMessageSchema).max(500) }).parse(req.body);
      res.json(ingestMessages(manager.store, bus, messages));
    }),
  );
  api.post(
    "/ingest/contacts",
    handle((req, res) => {
      const { contacts } = z.object({ contacts: z.array(ingestContactSchema).max(500) }).parse(req.body);
      res.json({ upserted: ingestContacts(manager.store, bus, contacts) });
    }),
  );
  api.post(
    "/ingest/self",
    handle((req, res) => {
      const { self } = z.object({ self: ingestSelfSchema }).parse(req.body);
      ingestSelf(manager.store, bus, self);
      res.json({ ok: true });
    }),
  );

  // ---- map ----
  api.get(
    "/map/nodes",
    handle(async (_req, res) => {
      if (!mapCache.enabled) {
        res.status(404).json({ error: "global map disabled" });
        return;
      }
      const { payload, fetchedAt, stale } = await mapCache.getNodes();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ fetchedAt, stale, nodes: payload });
    }),
  );

  // ---- API tokens (for the HLL plugin and other integrations) ----
  api.get(
    "/tokens",
    handle((_req, res) => {
      res.json({ tokens: auth.listTokens() });
    }),
  );
  api.post(
    "/tokens",
    handle((req, res) => {
      const { label } = z.object({ label: z.string().min(1).max(64) }).parse(req.body);
      const created = auth.createToken(label);
      // the raw token is only ever returned once
      res.status(201).json({ token: created.token, ...created.row });
    }),
  );
  api.delete(
    "/tokens/:id",
    handle((req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      if (auth.deleteToken(id)) {
        res.json({ ok: true });
      } else {
        res.status(404).json({ error: "token not found" });
      }
    }),
  );

  return api;
}

function hexKey(value: string): string {
  const parsed = z.string().regex(/^[0-9a-f]{64}$/i).parse(value);
  return parsed.toLowerCase();
}
