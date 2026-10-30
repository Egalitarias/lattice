// Lattice Navigator's service worker. It only makes things faster and survivable offline; the app and the host work
// without it.
//
//   /.lattice/blob/<hash>      content-addressed, so cached forever: the cache can never be stale
//   /.lattice/navigator/*      the host's own files: network first, so an update is picked up, with the cache as the
//                              fallback when the network is gone
//
// Everything else (the manifest, RPC, authentication, payments, analytics) goes to the network untouched: a worker
// that could cache those would be a place for the wrong session or price to hide.

const BUILD = "__BUILD_ID__";
const BLOBS = "lattice-blobs-v1";
const SHELL = `lattice-shell-${BUILD}`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("lattice-shell-") && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  if (/^\/\.lattice\/blob\/sha256-[A-Za-z0-9_-]{43}$/.test(url.pathname)) e.respondWith(cacheFirst(BLOBS, e.request));
  else if (url.pathname.startsWith("/.lattice/navigator/") && url.pathname !== "/.lattice/navigator/sw.js") e.respondWith(networkFirst(SHELL, e.request));
});

async function cacheFirst(name, request) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(name, request) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}
