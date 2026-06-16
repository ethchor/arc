/* eslint-disable */
/**
 * arc-vault PWA service worker — hand-written, deliberately small.
 *
 * Why not next-pwa / Workbox?
 *  - This is a zero-knowledge vault. Aggressive opaque caching of API
 *    responses could leak ciphertext into the on-disk Cache Storage, where
 *    a stolen device could replay it. Every cache rule below is reasoned
 *    about explicitly.
 *  - The surface we need is small: app shell, static assets, offline
 *    fallback. Workbox brings ~30 KB of runtime we don't need.
 *
 * Caching policy
 *  - SHELL_CACHE: pre-cached navigation shell + offline fallback.
 *  - STATIC_CACHE: `_next/static/*`, icons, manifest — cache-first; these
 *    are content-hashed (Next.js) or rarely-changing (icons), safe to keep.
 *  - Everything else: network-only. We do NOT cache `/auth/*`,
 *    `/v1/*`, `/vaults/*`, or any response with `Authorization` /
 *    `Cookie` headers. Vault ciphertext lives in IndexedDB, not here.
 *  - Navigation requests fall back to /offline.html when both network and
 *    cache miss — gives "Add to Home Screen" launches a usable shell while
 *    air-gapped.
 *
 * Lifecycle
 *  - Bump CACHE_VERSION on every release so the install step gets a fresh
 *    shell and the activate step prunes old buckets. Without that bump
 *    users would be pinned to whatever HTML was cached the first time.
 */

// Bumped per release so the install step pulls a fresh shell and activate prunes old
// buckets. Without the bump, users get pinned to whatever HTML was first cached.
const CACHE_VERSION = "v3";
const SHELL_CACHE = `arc-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `arc-static-${CACHE_VERSION}`;

const SHELL_URLS = ["/", "/offline.html", "/manifest.json", "/icon.svg"];

// Paths whose responses must never be cached — anything that could contain
// vault material, auth tokens, or per-user data. The match is conservative
// (prefix only) so a future endpoint added under one of these roots is
// covered by default.
const NEVER_CACHE_PREFIXES = [
  "/auth/",
  "/v1/",
  "/vaults/",
  "/vault/",
  "/agents/",
  "/devices/",
  "/invites/",
  "/recovery/",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== STATIC_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icon-") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/favicon-32.png" ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/manifest.json"
  );
}

function isNeverCache(url) {
  return NEVER_CACHE_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Skip cross-origin, non-GET, and anything that sends an Authorization
  // header — the latter is a strong signal it's a per-user API call.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has("Authorization")) return;
  if (isNeverCache(url)) return;

  // Static, content-hashed assets: cache-first.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations: network-first, fall through to cached shell, then to the
  // offline page. The offline page is intentionally tiny + key-free.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("/offline.html")),
        ),
    );
    return;
  }

  // Everything else: network-only. No silent caching of unknown paths.
});

// Listen for skipWaiting nudge from the page (used by the install banner
// "reload to apply update" flow).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
