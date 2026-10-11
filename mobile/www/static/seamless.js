/* wxdeck: seamless all-Australia radar. On the national view, zooming in pulls the live 128 km loops of
   the radars in view and blends them over the 5 km national mosaic, reprojected on the GPU so every
   radar lines up. Where radars overlap the nearest one wins. Uses globals from app.js / gl.js. */
"use strict";

const SEAM = { asked: new Map(), reload: null, lut: null, lutKey: "" };
const seamlessOn = () => isNational() && S.settings.seamless !== false && S.mode === "live" && (S.settings.view === "radar" || S.settings.view === "both");

// radars whose 128 km circle touches the view, nearest the middle first
function seamlessRadars() {
  if (!seamlessOn() || !S.cfg) return [];
  const half = Math.max(canvas.width, canvas.height) / 2 / S.view.scale;
  if (half > 1100) return [];                       // whole-continent view: the 5 km mosaic is plenty
  const w = canvas.width / 2 / S.view.scale + 140, h = canvas.height / 2 / S.view.scale + 140;
  const seen = new Set(), out = [];
  for (const r of [...S.cfg.radars.filter(x => !x.national && x.lat != null), ...(S.cfg.all_radars || [])]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const [x, y] = latLonToKm(r.lat, r.lon);
    if (Math.abs(x - S.view.cx) > w || Math.abs(y - S.view.cy) > h) continue;
    out.push({ r, d: Math.hypot(x - S.view.cx, y - S.view.cy) });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, half > 600 ? 10 : 14).map(o => o.r);
}

// ask the server to follow radars that come into view (in the background), then refresh the radar list
function ensureSeamless() {
  const now = Date.now();
  const ids = seamlessRadars().map(r => r.id)
    .filter(id => !SEAM.asked.has(id) || now - SEAM.asked.get(id) > 20 * 60e3);
  if (!ids.length) return;
  ids.forEach(id => SEAM.asked.set(id, now));
  fetch("/api/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radars: ids, wait: false, hours: 2 }) })
    .then(r => r.json()).then(r => {
      if (!r.new || !r.new.length) return;
      clearTimeout(SEAM.reload);
      SEAM.reload = setTimeout(() => loadConfig().then(() => draw()).catch(() => {}), 7000);
    }).catch(() => {});
}

function seamlessLayers() {
  const t = currentTime();
  if (!t) return [];
  const out = [];
  for (const sr of seamlessRadars()) {
    const r = S.cfg.radars.find(x => x.id === sr.id);
    if (!r || r.lat == null) continue;
    // 128 km (0.5 km pixels) near each radar, its 256 km product (1 km) filling gaps between radars
    for (const [suf, bias] of [["3", 0], ["2", 0.0005]]) {
      const prod = r.products.find(p => p.suffix === suf && p.available);
      if (!prod) continue;
      const st = liveStore(prod);
      let best = null;
      for (const f of st.frames) if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
      if (!best || Math.abs(best.time - t) > 10 * 60e3) continue;
      if (!best.data) { decodeStoreFrame(st, best); continue; }
      out.push({ key: best.url, data: best.data, lat: r.lat, lon: r.lon, km: prod.km || (suf === "3" ? 128 : 256), r, frame: best, bias });
    }
  }
  return out;
}

// reflectivity colours for the GPU, with BoM's caption and copyright pixels made transparent
function seamLut() {
  const tname = S.settings.palette["0"], thr = S.settings.threshold["0"] || 0, key = `${tname}|${thr}`;
  if (SEAM.lut && SEAM.lutKey === key) return SEAM.lut;
  const pal = PALETTES["0"], table = (pal.tables[tname] || Object.values(pal.tables)[0]).colors.map(hex);
  // alpha: 255 = echo, 1 = "no echo" (still counts as coverage), 0 = caption/copyright (no data)
  const lut = new Uint32Array(256);
  const noEcho = (1 << 24) >>> 0;
  for (let v = 0; v < 256; v++) lut[v] = noEcho;
  lut[253] = 0; lut[254] = 0;
  table.forEach((c, v) => { if (v >= thr) lut[v] = pack(c[0], c[1], c[2]); });
  SEAM.lut = lut; SEAM.lutKey = key;
  return lut;
}

// true when the GPU will draw the national mosaic too (so radars can hide its coarse pixels where they cover)
function seamlessTakesOver(p) {
  return seamlessOn() && p.i === 0 && S.settings.gpu !== false && !GL.slow && GL.depthMosaic() && seamlessLayers().length > 0;
}
function drawSeamless(p, national) {
  if (!seamlessOn() || p.i !== 0) return;
  ensureSeamless();
  const L = seamlessLayers();
  if (!L.length) return;
  const lut = seamLut(), lutKey = `seam|${SEAM.lutKey}`;
  const layers = L.map(l => ({ ...l, lut, lutKey }));
  if (national && national.frame && national.frame.data && GL.depthMosaic())
    layers.push({ key: national.frame.url, data: national.frame.data, lat: S.radar.lat, lon: S.radar.lon, km: national.prod.km, lut, lutKey, base: true });
  ctx.globalAlpha = S.settings.opacity / 100;
  const g = S.settings.gpu !== false && !GL.slow
    ? GL.renderMosaic(layers, canvas.width, canvas.height, S.radar.lat, S.radar.lon) : null;
  if (g) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(g, 0, 0); }
  else {
    // no GPU: shift each image by its centre (slightly off far from the middle of Australia), farthest first
    for (const l of [...L].reverse()) {
      const [ox, oy] = latLonToKm(l.lat, l.lon);
      drawCenteredAt(renderLiveFrame(l.frame, "0", true), frameN(l.data), l.km, ox, oy);
    }
  }
  ctx.globalAlpha = 1;
}

// readout: value from the nearest radar covering the point, if any
function seamlessValueAt(x, y) {
  if (!seamlessOn()) return null;
  const [lat, lon] = kmToLatLon(x, y);
  let best = null;
  for (const l of seamlessLayers()) {
    const xr = (lon - l.lon) * KM_PER_DEG * Math.cos(lat * Math.PI / 180), yr = (lat - l.lat) * KM_PER_DEG, d = Math.hypot(xr, yr);
    if (d <= l.km && (!best || d < best.d - 0.01 || (Math.abs(d - best.d) < 0.01 && l.km < best.l.km))) best = { l, xr, yr, d };
  }
  if (!best) return null;
  const N = frameN(best.l.data), kpp = best.l.km / (N / 2);
  const px = Math.floor(N / 2 + best.xr / kpp), py = Math.floor(N / 2 - best.yr / kpp);
  if (px < 0 || py < 0 || px >= N || py >= N) return null;
  return { v: best.l.data[py * N + px], name: best.l.r.name, d: best.d };
}
