// wxdeck service worker: keeps the app shell so the app opens fast and works through network blips.
// The page itself is fetched fresh when the server answers within 1.5 s (so updates show straight away),
// otherwise the saved copy is used. Live data always comes from the network.
const CACHE = "wxdeck-shell";
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.add("/")).catch(() => {}).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

async function remember(c, req, res) {
  const url = new URL(req.url);
  for (const k of await c.keys()) {                 // drop older versions of the same file
    const ku = new URL(k.url);
    if (ku.pathname === url.pathname && ku.search !== url.search) c.delete(k);
  }
  await c.put(req, res);
}

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/static/") && !u.pathname.startsWith("/static/downloads")) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) remember(c, req, res.clone());
      return res;
    }));
  } else if (req.mode === "navigate" && u.pathname === "/") {
    e.respondWith(caches.open(CACHE).then(async c => {
      const net = fetch(req).then(res => { if (res.ok) c.put("/", res.clone()); return res; });
      const slow = new Promise(r => setTimeout(r, 1500));
      const first = await Promise.race([net.catch(() => null), slow.then(() => null)]);
      if (first) return first;
      return (await c.match("/")) || net;
    }));
  }
});
