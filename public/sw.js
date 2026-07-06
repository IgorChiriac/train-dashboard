/* Service worker for the S2 Board PWA. */
const CACHE = "s2board-v12";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icon.svg",
  "trains.html",
  "trains.js",
  "trains.css",
  "train-icon.svg",
  "vendor/maplibre-gl.js",
  "vendor/maplibre-gl.css",
];

// Live data hosts → network-first so we always prefer fresh times, but fall
// back to the last cached response when offline.
const NETWORK_FIRST_HOSTS = [
  "transport.opendata.ch",
  "api.open-meteo.com",
  "geocoding-api.open-meteo.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Vendored libraries are big and only change together with a CACHE bump
  // (install re-fetches the SHELL), so serve them cache-first.
  if (url.origin === self.location.origin && url.pathname.includes("/vendor/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Network-first for both live-data hosts and the same-origin app shell, so a
  // new deploy is always picked up when online; cache is the offline fallback.
  // Map tiles and the geOps/opentransportdata APIs are cross-origin and
  // unlisted, so they bypass the service worker entirely.
  if (url.origin === self.location.origin || NETWORK_FIRST_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
