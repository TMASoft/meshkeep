// Registered eagerly at app startup (src/main.ts) so it can also serve as the
// versioned static-asset cache worker (#74); notifications.ts separately
// reuses this same registration as its display-fallback path (docs/pwa-feasibility.md).
// It still does not cache messages, contacts, telemetry, locations, or any
// `/api/` response — only same-origin static assets, per the cache policy.
import { isCacheableRequest, staleCacheNames, STATIC_CACHE_PREFIX } from "./sw-cache-logic.js";

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `${STATIC_CACHE_PREFIX}${VERSION}`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(staleCacheNames(names, STATIC_CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (!isCacheableRequest(event.request, self.location.origin)) return;
  const isNavigation = event.request.mode === "navigate";
  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      if (isNavigation) {
        // network-first: a stale index.html would keep pointing at an old build's
        // hashed asset URLs, which may no longer exist once those are evicted
        try {
          const response = await fetch(event.request);
          if (response.ok) await cache.put(event.request, response.clone());
          return response;
        } catch {
          return (await cache.match(event.request)) ?? Response.error();
        }
      }
      // cache-first: content-hashed build assets never change once fetched
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })(),
  );
});

// Push payloads are always server-generated and generic (#76 prototype) — see
// genericPushPayload in packages/server/src/push/worker.ts. There is never
// sender, message text, or telemetry data to guard here.
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  const title = typeof payload.title === "string" ? payload.title : "MeshKeep";
  const body = typeof payload.body === "string" ? payload.body : "";
  event.waitUntil(self.registration.showNotification(title, { body }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) return client.focus();
      return self.clients.openWindow("/chat");
    }),
  );
});
