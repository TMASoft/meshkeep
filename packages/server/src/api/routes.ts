import { Router, json, type Request, type Response } from "express";
import { z } from "zod";
import type { ConnectionManager } from "../radio/manager.js";
import {
  ActiveProfileError,
  ActiveRadioError,
  AmbiguousLinkError,
  BleExclusivityError,
  OutboundNotFoundError,
  OutboundStateError,
  ProfileNotFoundError,
  RadioNotFoundError,
  RadioUnavailableError,
} from "../radio/manager.js";
import { DuplicateProfileNameError } from "../db/store.js";
import { listSerialPorts, scanBleRadios } from "../radio/detect.js";
import type { MapCache } from "../map/cache.js";
import type { Bus } from "../bus.js";
import type { Auth } from "./auth.js";
import type { Db } from "../db/index.js";
import type { ServerConfig } from "../config.js";
import { csvHeaderRow, messageToCsvRow } from "./export.js";
import { buildDiagnostics, buildSupportBundle } from "./diagnostics.js";
import {
  ingestContactSchema,
  ingestContacts,
  ingestMessageSchema,
  ingestMessages,
  ingestSelf,
  ingestSelfSchema,
} from "./ingest.js";

/** Conversation filters address exactly one conversation — never combine them. */
const atMostOneConversationFilter = [
  (value: { contact?: unknown; sender?: unknown; channel?: unknown }) =>
    [value.contact, value.sender, value.channel].filter((v) => v !== undefined).length <= 1,
  { message: "contact, sender, and channel are mutually exclusive" },
] as const;

function handle(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (res.headersSent) {
        // a streaming response already began — we cannot send an error body, so
        // just log and abort the connection so the client sees a truncated body
        console.error("[api] error after response started:", error);
        res.destroy();
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "invalid request", details: error.issues });
      } else if (error instanceof AmbiguousLinkError) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof RadioUnavailableError) {
        res.status(503).json({ error: error.message });
      } else if (
        error instanceof OutboundNotFoundError ||
        error instanceof ProfileNotFoundError ||
        error instanceof RadioNotFoundError
      ) {
        res.status(404).json({ error: error.message });
      } else if (
        error instanceof OutboundStateError ||
        error instanceof ActiveProfileError ||
        error instanceof ActiveRadioError ||
        error instanceof DuplicateProfileNameError ||
        error instanceof BleExclusivityError
      ) {
        res.status(409).json({ error: error.message });
      } else if (error instanceof Error && error.constructor === Error && !("code" in error)) {
        // deliberately thrown operational message (e.g. "radio rejected the message")
        res.status(500).json({ error: error.message });
      } else {
        // unexpected internals (library/system errors) never reach clients
        console.error("[api] internal error:", error);
        res.status(500).json({ error: "internal error" });
      }
    }
  };
}

export function buildApi(
  manager: ConnectionManager,
  mapCache: MapCache,
  auth: Auth,
  bus: Bus,
  deps: { db: Db; config: ServerConfig; version: string },
): Router {
  const api = Router();
  api.use(json({ limit: "1mb" }));
  // cross-site mutation defense applies to every route, including login
  api.use(auth.originGuard);

  // ---- auth (unguarded) ----
  api.post(
    "/auth/login",
    handle((req, res) => {
      const { password } = z.object({ password: z.string() }).parse(req.body);
      const result = auth.login(password, req, res);
      if (result === "ok") {
        res.json({ ok: true });
      } else if (result === "throttled") {
        res.status(429).json({ error: "too many failed logins; try again later" });
      } else {
        res.status(401).json({ error: "wrong password" });
      }
    }),
  );
  api.post(
    "/auth/logout",
    handle((req, res) => {
      auth.logout(req, res);
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

  // Reads target a physical radio (issue #53): an explicit `?radioId=` (which
  // must exist, else 404) lets a client browse any stored radio, otherwise the
  // active radio. Returns 0 — which matches no radio, yielding empty results —
  // when nothing has synced yet, so read endpoints need no null branch.
  const radioIdQuery = z.coerce.number().int().positive().optional();
  const readRadioId = (req: Request): number => {
    const requested = radioIdQuery.parse(req.query.radioId);
    if (requested != null) {
      if (!manager.hasRadio(requested)) throw new RadioNotFoundError(`radio ${requested} not found`);
      return requested;
    }
    return manager.defaultRadioId() ?? 0;
  };
  // Writes need a *live* link, so unlike reads there is no store-backed
  // fallback: an omitted `radioId` is left undefined and the manager resolves
  // it against the running links (single link → that one; none or several
  // with no id given → RadioUnavailableError/AmbiguousLinkError, 503/400).
  const writeRadioId = (req: Request): number | undefined => radioIdQuery.parse(req.query.radioId);

  // ---- status ----
  api.get(
    "/status",
    handle((_req, res) => {
      res.json(manager.status());
    }),
  );

  // ---- diagnostics ----
  // Aggregated, secret-free diagnostics for any authenticated client.
  api.get(
    "/diagnostics",
    handle((_req, res) => {
      res.json(buildDiagnostics(manager, deps.db, mapCache, deps.config, deps.version));
    }),
  );
  // The support bundle carries effective config and recent logs; keep it
  // session-only so an API token cannot exfiltrate it.
  api.get(
    "/diagnostics/bundle",
    auth.sessionGuard,
    handle((_req, res) => {
      const bundle = buildSupportBundle(manager, deps.db, mapCache, deps.config, deps.version);
      const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="meshkeep-diagnostics-${stamp}.json"`);
      res.json(bundle);
    }),
  );

  // ---- contacts ----
  api.get(
    "/contacts",
    handle((req, res) => {
      res.json({ contacts: manager.store.getContacts(readRadioId(req)) });
    }),
  );
  api.post(
    "/contacts/refresh",
    handle(async (req, res) => {
      res.json({ contacts: await manager.refreshContacts(writeRadioId(req)) });
    }),
  );
  api.delete(
    "/contacts/:key",
    handle(async (req, res) => {
      await manager.removeContact(hexKey(req.params.key), writeRadioId(req));
      res.json({ ok: true });
    }),
  );
  api.post(
    "/contacts/:key/path-reset",
    handle(async (req, res) => {
      await manager.resetContactPath(hexKey(req.params.key), writeRadioId(req));
      res.json({ ok: true });
    }),
  );
  api.get(
    "/contacts/:key/export",
    handle(async (req, res) => {
      res.json({ uri: await manager.exportContactUri(hexKey(req.params.key), writeRadioId(req)) });
    }),
  );
  api.post(
    "/contacts/:key/login",
    handle(async (req, res) => {
      const { password } = z.object({ password: z.string().min(1).max(15) }).parse(req.body);
      const ok = await manager.loginToNode(hexKey(req.params.key), password, writeRadioId(req));
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
      res.json({ status: await manager.getNodeStatus(hexKey(req.params.key), writeRadioId(req)) });
    }),
  );
  api.get(
    "/contacts/:key/telemetry",
    handle(async (req, res) => {
      res.json({ telemetry: await manager.requestTelemetry(hexKey(req.params.key), writeRadioId(req)) });
    }),
  );
  api.get(
    "/contacts/:key/telemetry/history",
    handle((req, res) => {
      const hours = z.coerce
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .default(24 * 7)
        .parse(req.query.hours ?? 24 * 7);
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      res.json({
        points: manager.store.getContactTelemetry(readRadioId(req), hexKey(req.params.key), since),
      });
    }),
  );
  api.post(
    "/contacts/:key/cli",
    handle(async (req, res) => {
      const { command } = z.object({ command: z.string().min(1).max(2000) }).parse(req.body);
      const message = await manager.sendDirectMessage(hexKey(req.params.key), command, true, writeRadioId(req));
      res.status(201).json({ message });
    }),
  );
  api.post(
    "/contacts/import",
    handle(async (req, res) => {
      const { uri } = z.object({ uri: z.string().min(8).max(2048) }).parse(req.body);
      res.json({ contacts: await manager.importContactUri(uri, writeRadioId(req)) });
    }),
  );

  // ---- messages ----
  api.get(
    "/messages/recent",
    handle((req, res) => {
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .parse(req.query.limit ?? 20);
      res.json({ messages: manager.store.getRecentMessages(readRadioId(req), limit) });
    }),
  );
  api.get(
    "/messages/unknown-senders",
    handle((req, res) => {
      res.json({ messages: manager.store.getUnknownDirectMessages(readRadioId(req)) });
    }),
  );
  api.get(
    "/messages/unread",
    handle((req, res) => {
      res.json({ conversations: manager.store.getUnreadSummary(readRadioId(req)) });
    }),
  );
  api.get(
    "/messages/outbound",
    handle((req, res) => {
      res.json({ queue: manager.store.listOutbound(readRadioId(req)) });
    }),
  );
  api.get(
    "/messages/search",
    handle((req, res) => {
      const query = z
        .object({
          q: z.string().min(1).max(200),
          contact: z
            .string()
            .regex(/^[0-9a-f]{64}$/i)
            .optional(),
          sender: z
            .string()
            .regex(/^[0-9a-f]{2,64}$/i)
            .optional(),
          channel: z.coerce.number().int().min(0).max(255).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .refine(...atMostOneConversationFilter)
        .parse(req.query);
      res.json({
        results: manager.store.searchMessages(readRadioId(req), {
          query: query.q,
          contactKey: query.contact?.toLowerCase(),
          contactPrefix: query.sender?.toLowerCase(),
          channelIdx: query.channel,
          limit: query.limit,
        }),
      });
    }),
  );
  api.get(
    "/messages/export",
    handle(async (req, res) => {
      const query = z
        .object({
          format: z.enum(["csv", "json"]).default("csv"),
          contact: z
            .string()
            .regex(/^[0-9a-f]{64}$/i)
            .optional(),
          sender: z
            .string()
            .regex(/^[0-9a-f]{2,64}$/i)
            .optional(),
          channel: z.coerce.number().int().min(0).max(255).optional(),
        })
        .refine(...atMostOneConversationFilter)
        .parse(req.query);
      // Stream matching history row-by-row so a large database neither buffers
      // the whole export in memory nor blocks the event loop: backpressure
      // (awaiting "drain") paces the write loop and yields to other requests.
      const messages = manager.store.iterateMessagesForExport(readRadioId(req), {
        contactKey: query.contact?.toLowerCase(),
        contactPrefix: query.sender?.toLowerCase(),
        channelIdx: query.channel,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      let clientGone = false;
      res.on("close", () => {
        clientGone = !res.writableEnded;
      });
      // Await backpressure relief, but never hang if the client disconnects
      // while the buffer is full ("drain" would never arrive) — "close" resolves
      // the wait so the loop can observe clientGone and finalize the iterator.
      const write = (chunk: string): Promise<void> =>
        new Promise<void>((resolve) => {
          if (res.write(chunk)) {
            resolve();
            return;
          }
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      if (query.format === "json") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="meshkeep-messages-${stamp}.json"`);
        await write(`{"exportedAt":${Math.floor(Date.now() / 1000)},"messages":[`);
        let first = true;
        for (const message of messages) {
          if (clientGone) return; // generator's finally finalizes the SQLite iterator
          await write(`${first ? "" : ","}${JSON.stringify(message)}`);
          first = false;
        }
        await write("]}");
      } else {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="meshkeep-messages-${stamp}.csv"`);
        await write(csvHeaderRow());
        for (const message of messages) {
          if (clientGone) return;
          await write(messageToCsvRow(message));
        }
      }
      res.end();
    }),
  );
  api.get(
    "/messages",
    handle((req, res) => {
      const query = z
        .object({
          contact: z
            .string()
            .regex(/^[0-9a-f]{2,64}$/i)
            .optional(),
          sender: z
            .string()
            .regex(/^[0-9a-f]{2,64}$/i)
            .optional(),
          channel: z.coerce.number().int().min(0).max(255).optional(),
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .refine(...atMostOneConversationFilter)
        .parse(req.query);
      res.json({
        messages: manager.store.getConversation(readRadioId(req), {
          contactKey: query.contact?.toLowerCase(),
          contactPrefix: query.sender?.toLowerCase(),
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
          z.object({
            kind: z.literal("dm"),
            to: z.string().regex(/^[0-9a-f]{64}$/i),
            text: z.string().min(1).max(2000),
          }),
          z.object({
            kind: z.literal("channel"),
            channelIdx: z.number().int().min(0).max(255),
            text: z.string().min(1).max(2000),
          }),
        ])
        .parse(req.body);
      const message =
        body.kind === "dm"
          ? await manager.sendDirectMessage(body.to.toLowerCase(), body.text, false, writeRadioId(req))
          : await manager.sendChannelMessage(body.channelIdx, body.text, writeRadioId(req));
      res.status(201).json({ message });
    }),
  );
  api.post(
    "/messages/:id/retry",
    handle((req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      res.json({ message: manager.retryOutbound(id) });
    }),
  );
  api.post(
    "/messages/:id/cancel",
    handle((req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      res.json({ message: manager.cancelOutbound(id) });
    }),
  );
  api.post(
    "/messages/read",
    handle((req, res) => {
      const body = z
        .object({
          contact: z
            .string()
            .regex(/^[0-9a-f]{64}$/i)
            .optional(),
          sender: z
            .string()
            .regex(/^[0-9a-f]{2,64}$/i)
            .optional(),
          channel: z.number().int().min(0).max(255).optional(),
        })
        .refine(
          (value) => value.contact !== undefined || value.sender !== undefined || value.channel !== undefined,
          {
            message: "contact, sender, or channel is required",
          },
        )
        .refine(...atMostOneConversationFilter)
        .parse(req.body);
      // `?radioId=` lets the client mark-read the conversation of the radio it is
      // viewing; defaults to the active radio.
      manager.store.markConversationRead(readRadioId(req), {
        contactKey: body.contact?.toLowerCase(),
        contactPrefix: body.sender?.toLowerCase(),
        channelIdx: body.channel,
      });
      res.json({ ok: true });
    }),
  );

  // ---- channels ----
  api.get(
    "/channels",
    handle((req, res) => {
      res.json({ channels: manager.store.getChannels(readRadioId(req)) });
    }),
  );
  api.post(
    "/channels/refresh",
    handle(async (req, res) => {
      res.json({ channels: await manager.refreshChannels(writeRadioId(req)) });
    }),
  );
  api.put(
    "/channels/:idx",
    handle(async (req, res) => {
      const idx = z.coerce.number().int().min(0).max(7).parse(req.params.idx);
      const body = z
        .object({ name: z.string().min(1).max(31), secret: z.string().regex(/^[0-9a-f]{32}$/i) })
        .parse(req.body);
      res.json({ channel: await manager.setChannel(idx, body.name, body.secret.toLowerCase(), writeRadioId(req)) });
    }),
  );
  api.delete(
    "/channels/:idx",
    handle(async (req, res) => {
      const idx = z.coerce.number().int().min(0).max(7).parse(req.params.idx);
      await manager.deleteChannel(idx, writeRadioId(req));
      res.json({ ok: true });
    }),
  );

  // ---- device ----
  api.post(
    "/advert",
    handle(async (req, res) => {
      const { flood } = z.object({ flood: z.boolean().default(false) }).parse(req.body ?? {});
      await manager.sendAdvert(flood, writeRadioId(req));
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
      res.json({ self: await manager.setDeviceSettings(patch, writeRadioId(req)) });
    }),
  );

  api.get(
    "/device/share",
    handle(async (req, res) => {
      res.json({ uri: await manager.exportContactUri(null, writeRadioId(req)) });
    }),
  );

  // ---- telemetry ----
  api.get(
    "/telemetry",
    handle((req, res) => {
      const hours = z.coerce
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .default(24)
        .parse(req.query.hours ?? 24);
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      res.json({ points: manager.store.getTelemetry(readRadioId(req), since) });
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
      const seconds = z.coerce
        .number()
        .min(2)
        .max(15)
        .default(6)
        .parse(req.query.seconds ?? 6);
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
          bleAddress: z
            .string()
            .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)
            .nullish(),
        })
        .nullable()
        .parse(req.body?.override ?? null);
      await manager.setConnectionOverride(override);
      res.json({ ...manager.connectionSettings(), state: manager.getState() });
    }),
  );

  // ---- radio profiles (saved, named connection targets — issue #53) ----
  const profileFields = {
    connection: z.enum(["serial", "tcp", "ble", "none"]),
    serialPort: z.string().min(1).max(256).nullish(),
    serialBaud: z.number().int().min(1).max(10_000_000).optional(),
    tcpHost: z.string().min(1).max(256).nullish(),
    tcpPort: z.number().int().min(1).max(65535).optional(),
    bleAddress: z
      .string()
      .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)
      .nullish(),
  };
  const profileName = z.string().trim().min(1).max(64);
  api.get(
    "/radio/profiles",
    handle((_req, res) => {
      res.json({
        profiles: manager.store.listRadioProfiles(),
        activeProfileId: manager.activeProfile()?.id ?? null,
      });
    }),
  );
  api.post(
    "/radio/profiles",
    handle((req, res) => {
      const body = z.object({ name: profileName, ...profileFields }).parse(req.body);
      res.status(201).json(manager.store.createRadioProfile(body));
    }),
  );
  api.put(
    "/radio/profiles/:id",
    handle(async (req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const patch = z
        .object({ name: profileName.optional(), ...profileFields })
        .partial()
        .parse(req.body);
      res.json(await manager.updateProfile(id, patch));
    }),
  );
  api.delete(
    "/radio/profiles/:id",
    handle((req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      manager.deleteProfile(id);
      res.json({ ok: true });
    }),
  );
  // Additive: activating a profile leaves any other active profiles (or the
  // default link) running, so several radios can be connected at once. BLE
  // is the exception — a second concurrent BLE profile 409s immediately.
  api.post(
    "/radio/profiles/:id/activate",
    handle(async (req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      await manager.activateProfile(id);
      res.json({ ...manager.connectionSettings(), state: manager.getState() });
    }),
  );
  // Deactivate just this profile's link — other active links are untouched.
  api.post(
    "/radio/profiles/:id/deactivate",
    handle(async (req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      await manager.deactivateProfile(id);
      res.json({ ...manager.connectionSettings(), state: manager.getState() });
    }),
  );
  // Deactivate every active profile and fall back to env + override settings.
  api.post(
    "/radio/profiles/deactivate",
    handle(async (_req, res) => {
      await manager.deactivateProfile(null);
      res.json({ ...manager.connectionSettings(), state: manager.getState() });
    }),
  );

  // ---- radios (physical devices with isolated stored data — issue #53) ----
  // A radio is a distinct MeshCore node the server has synced, identified by its
  // self public key. Reads elsewhere take `?radioId=` to browse any of them.
  api.get(
    "/radios",
    handle((_req, res) => {
      res.json({ radios: manager.listRadios(), activeRadioId: manager.getActiveRadioId() });
    }),
  );
  api.patch(
    "/radios/:id",
    handle((req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const { name } = z.object({ name: z.string().trim().min(1).max(64) }).parse(req.body);
      res.json(manager.renameRadio(id, name));
    }),
  );
  // Forget a radio and purge its stored data. The active radio is protected (409).
  api.delete(
    "/radios/:id",
    handle((req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      manager.forgetRadio(id);
      res.json({ ok: true });
    }),
  );

  // ---- ingest (browser-direct sessions sync what they saw back to the server) ----
  // A browser-direct session may own a radio the server never connected to, so
  // each batch names its radio by self public key; the server resolves (creating
  // if needed) the matching radios row and scopes the write to it (issue #53).
  const radioKey = z.string().regex(/^[0-9a-f]{64}$/i);
  api.post(
    "/ingest/messages",
    handle((req, res) => {
      const { radioKey: key, messages } = z
        .object({ radioKey, messages: z.array(ingestMessageSchema).max(500) })
        .parse(req.body);
      const radioId = manager.store.resolveRadio(key.toLowerCase(), null);
      res.json(ingestMessages(manager.store, bus, radioId, messages));
    }),
  );
  api.post(
    "/ingest/contacts",
    handle((req, res) => {
      const { radioKey: key, contacts } = z
        .object({ radioKey, contacts: z.array(ingestContactSchema).max(500) })
        .parse(req.body);
      const radioId = manager.store.resolveRadio(key.toLowerCase(), null);
      res.json({ upserted: ingestContacts(manager.store, bus, radioId, contacts) });
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
  // Tile URLs are public client configuration: the browser must receive the
  // template to request tiles, while the global node index stays server-cached.
  api.get(
    "/map/config",
    handle((_req, res) => {
      res.json({
        tiles: { url: deps.config.mapTilesUrl, attribution: deps.config.mapTilesAttribution },
        nodeIndex: { enabled: mapCache.enabled },
      });
    }),
  );
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
  // Session-only: bearer tokens can never mint, rotate, list, or revoke tokens.
  api.get(
    "/tokens",
    auth.sessionGuard,
    handle((_req, res) => {
      res.json({ tokens: auth.listTokens() });
    }),
  );
  api.post(
    "/tokens",
    auth.sessionGuard,
    handle((req, res) => {
      const body = z
        .object({
          label: z.string().min(1).max(64),
          // integrations are read-only unless write access is requested explicitly
          scope: z.enum(["read", "write"]).default("read"),
          expiresInDays: z.number().int().min(1).max(3650).nullish(),
        })
        .parse(req.body);
      const created = auth.createToken(
        body.label,
        body.scope,
        body.expiresInDays ? body.expiresInDays * 86_400 : null,
      );
      // the raw token is only ever returned once
      res.status(201).json({ token: created.token, ...created.row });
    }),
  );
  api.post(
    "/tokens/:id/rotate",
    auth.sessionGuard,
    handle((req, res) => {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const rotated = auth.rotateToken(id);
      if (rotated) {
        res.json({ token: rotated.token, ...rotated.row });
      } else {
        res.status(404).json({ error: "token not found" });
      }
    }),
  );
  api.delete(
    "/tokens/:id",
    auth.sessionGuard,
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
  const parsed = z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .parse(value);
  return parsed.toLowerCase();
}
