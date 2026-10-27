// Funziona anche senza campo: app e orari già visti restano in cache.
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const DATA = "data";
const TILES = "tiles";
const ASSETS = ["./", "index.html", "style.css", "app.js", "gioco.js", "orari.js", "routing.js", "config.js", "cripto.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/sangria.svg", "data/locali.json", "data/actv/index.json",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css",
  "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // no-cache: chiede sempre al server se il file è cambiato (GitHub Pages altrimenti tiene 10 minuti)
    const res = await fetch(req, new URL(req.url).origin === location.origin ? { cache: "no-cache" } : {});
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req)) || (await caches.match(req)) || Response.error();
  }
}

let tilePuts = 0;
async function tileCacheFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    cache.put(req, res.clone());
    if (++tilePuts % 100 === 0) {
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) cache.delete(k);
    }
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "tile.openstreetmap.org" || (url.hostname === "tiles.openfreemap.org" && !url.pathname.startsWith("/styles/"))) return e.respondWith(tileCacheFirst(e.request));
  if (url.origin === location.origin && url.pathname.includes("/data/")) return e.respondWith(networkFirst(e.request, DATA));
  if (url.origin === location.origin || url.hostname.includes("cdnjs") || url.hostname === "unpkg.com" || url.hostname === "cdn.jsdelivr.net" || url.pathname.startsWith("/styles/") || url.hostname.includes("fonts.")) {
    return e.respondWith(networkFirst(e.request, SHELL));
  }
});

// notifiche push (punti doppi, sfide lampo, messaggi dell'admin)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { testo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titolo || "Bacaro Tour", {
    body: d.testo || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: d.tag || "avviso", renotify: true,
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow("./"))));
});
