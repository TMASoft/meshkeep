// Pure decision logic for the versioned static-asset cache (#74), split out
// of notification-sw.js so it can be unit-tested directly under Node/vitest
// without a real ServiceWorkerGlobalScope. Kept dependency-free (no bundler)
// since public/ files are served to the browser unmodified.

export const STATIC_CACHE_PREFIX = "meshkeep-static-";

/**
 * docs/pwa-feasibility.md: "one active build plus one rollback build; delete
 * older named caches on activate." `existingNames` is whatever CacheStorage
 * currently holds (any order); returns the subset to delete.
 */
export function staleCacheNames(existingNames, currentCacheName) {
  const managed = existingNames.filter((name) => name.startsWith(STATIC_CACHE_PREFIX));
  const others = managed.filter((name) => name !== currentCacheName);
  // caches.keys() is insertion-ordered, so the last "other" entry is the most
  // recently created build before this one — the one worth keeping as rollback.
  const keep = new Set([currentCacheName, others[others.length - 1]].filter(Boolean));
  return managed.filter((name) => !keep.has(name));
}

/**
 * Only same-origin GET requests are cache-eligible. API responses, messages,
 * contacts, telemetry, and locations are never cached here (server stays
 * authoritative) — this worker only ever touches versioned static assets.
 */
export function isCacheableRequest(request, origin) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return true;
}
