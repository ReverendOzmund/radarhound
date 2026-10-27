// Radarhound service worker: keeps the app shell so the app opens offline and through network blips.
// The page itself always comes from the server when it answers (a saved copy is only used when the
// network fails, so old HTML never runs with newer scripts). Live data always comes from the network.
const CACHE = "radarhound-shell";
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.add("/")).catch(() => {}).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

async function remember(c, req, res) {
  const url = new URL(req.url);
  for (const k of await c.keys()) {                 // drop older versions of the same file
    const ku = new URL(k.url);
    if (ku.pathname === url.pathname && ku.search !== url.search) c.delete(k);
  }
  await c.put(req, res);
}

// only real assets are worth keeping: not a login page a redirect led to, not an error page
const cacheable = res => res.ok && !res.redirected && !/text\/html/.test(res.headers.get("content-type") || "");

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/static/") && !u.pathname.startsWith("/static/downloads")) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (cacheable(res)) remember(c, req, res.clone());
      return res;
    }));
  } else if (req.mode === "navigate" && u.pathname === "/") {
    e.respondWith(caches.open(CACHE).then(async c => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected) c.put("/", res.clone());
        return res;
      } catch (err) {
        const saved = await c.match("/");
        if (saved) return saved;
        throw err;
      }
    }));
  }
});
