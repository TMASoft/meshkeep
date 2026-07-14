import { Router, json, type Request, type Response } from "express";
import { z } from "zod";
import type { ConnectionManager } from "../radio/manager.js";
import { RadioUnavailableError } from "../radio/manager.js";
import type { MapCache } from "../map/cache.js";
import type { Auth } from "./auth.js";

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

export function buildApi(manager: ConnectionManager, mapCache: MapCache, auth: Auth): Router {
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

  // ---- messages ----
  api.get(
    "/messages/recent",
    handle((req, res) => {
      const limit = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit ?? 20);
      res.json({ messages: manager.store.getRecentMessages(limit) });
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
