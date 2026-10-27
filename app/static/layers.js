/* Radarhound: forecast map layers (Windy-style), station plots, sharp town labels, radar mosaic,
   lightning sparkline and palette import/export. Uses globals from app.js. */
"use strict";

// ---------------------------------------------------------------- forecast fields
const SC_WIND = scale([[0, "#25306e"], [10, "#2f6fb0"], [20, "#3fb0a0"], [30, "#7dd36a"], [40, "#f7e83a"], [55, "#f07b17"], [70, "#e0261f"], [90, "#e23ad6"], [120, "#ffffff"]]);
const SC_JET = scale([[0, "#25306e"], [40, "#2f6fb0"], [80, "#3fb0a0"], [120, "#7dd36a"], [160, "#f7e83a"], [200, "#f07b17"], [250, "#e0261f"], [300, "#e23ad6"], [360, "#ffffff"]]);
const SC_TEMP = scale([[-5, "#3b2f8f"], [0, "#2f5fb0"], [8, "#3fb0d0"], [15, "#7dd36a"], [22, "#f7e83a"], [30, "#f07b17"], [38, "#e0261f"], [45, "#8f1a5f"]]);
const SC_UTEMP = scale([[-60, "#3b2f8f"], [-45, "#2f5fb0"], [-30, "#3fb0d0"], [-15, "#7dd36a"], [-5, "#f7e83a"], [5, "#f07b17"], [15, "#e0261f"], [25, "#8f1a5f"]]);
const SC_RH = scale([[0, "#5a3a14"], [30, "#a0743a"], [50, "#d8c89a"], [70, "#7fb0c0"], [85, "#2f8fb0"], [100, "#1a4f8a"]]);
const SC_CLOUD = scale([[0, "#0b1820"], [50, "#6f7f88"], [100, "#e8eef0"]]);
const SC_RAIN = scale([[0.1, "#3f7f98"], [1, "#2fc0c9"], [2, "#2fd16c"], [5, "#f7e83a"], [10, "#f07b17"], [20, "#e0261f"], [40, "#e23ad6"]], { clearBelow: true });
const SC_ACC = scale([[0.5, "#3f7f98"], [2, "#2fc0c9"], [5, "#2fd16c"], [10, "#f7e83a"], [25, "#f07b17"], [50, "#e0261f"], [100, "#e23ad6"]], { clearBelow: true });
const SC_WAVE = scale([[0, "#1a2a5a"], [0.5, "#2f5fb0"], [1, "#3fb0d0"], [2, "#7dd36a"], [3, "#f7e83a"], [4, "#f07b17"], [6, "#e0261f"], [9, "#e23ad6"]]);
const SC_PM = scale([[0, "#1f3a2a"], [5, "#3c8a4a"], [12, "#7dd36a"], [25, "#f7e83a"], [55, "#f07b17"], [150, "#e0261f"], [250, "#8f1a5f"]]);
const FC_LAYERS = {
  wind: { name: "Wind", unit: "km/h", kind: "sfc", vec: true, sc: SC_WIND, group: "Surface" },
  gust: { name: "Wind gusts", unit: "km/h", kind: "sfc", key: "gust", sc: scale([[0, "#25306e"], [15, "#2f6fb0"], [30, "#3fb0a0"], [45, "#7dd36a"], [60, "#f7e83a"], [75, "#f07b17"], [90, "#e0261f"], [110, "#e23ad6"], [140, "#ffffff"]]), group: "Surface" },
  temp: { name: "Temperature", unit: "°C", kind: "sfc", key: "temp", sc: SC_TEMP, group: "Surface" },
  dew: { name: "Dew point", unit: "°C", kind: "sfc", key: "dew", sc: scale([[-10, "#5a3a14"], [0, "#a0743a"], [8, "#d8c89a"], [14, "#7dd36a"], [18, "#2fc0a0"], [22, "#2f6fb0"], [26, "#5a2fb0"]]), group: "Surface" },
  rh: { name: "Humidity", unit: "%", kind: "sfc", key: "rh", sc: SC_RH, group: "Surface" },
  wbt: { name: "Wet-bulb temperature", unit: "°C", kind: "sfc2", key: "wbt", sc: SC_TEMP, group: "Surface" },
  mslp: { name: "Pressure", unit: "hPa", kind: "sfc", key: "mslp", sc: scale([[990, "#3b2f8f"], [1000, "#2f6fb0"], [1008, "#3fb0a0"], [1014, "#7dd36a"], [1020, "#f7e83a"], [1028, "#f07b17"], [1036, "#e0261f"]]), group: "Surface" },
  uv: { name: "UV index", unit: "", kind: "sfc2", key: "uv", sc: scale([[0, "#1f3a2a"], [3, "#7dd36a"], [6, "#f7e83a"], [8, "#f07b17"], [11, "#e0261f"], [14, "#8f1a5f"]]), group: "Surface" },
  rain: { name: "Rain", unit: "mm/h", kind: "sfc", key: "rain", sc: SC_RAIN, group: "Rain and storms" },
  rainacc: { name: "Rain accumulation", unit: "mm", kind: "sfc", key: "rain", acc: true, sc: SC_ACC, group: "Rain and storms" },
  cape: { name: "CAPE", unit: "J/kg", kind: "sfc", key: "cape", sc: scale([[50, "#2a4b5c"], [250, "#2f6f8f"], [500, "#7dd36a"], [1000, "#f7e83a"], [2000, "#f07b17"], [3000, "#e0261f"], [4000, "#e23ad6"]], { clearBelow: true }), group: "Rain and storms" },
  li: { name: "Lifted index", unit: "", kind: "sfc2", key: "li", sc: scale([[-8, "#e23ad6"], [-6, "#e0261f"], [-4, "#f07b17"], [-2, "#f7e83a"], [0, "#7dd36a"], [3, "#3fb0a0"], [8, "#25306e"]]), group: "Rain and storms" },
  cloud: { name: "Cloud cover", unit: "%", kind: "sfc", key: "cloud", sc: SC_CLOUD, group: "Clouds" },
  low: { name: "Low cloud", unit: "%", kind: "sfc2", key: "low", sc: SC_CLOUD, group: "Clouds" },
  mid: { name: "Mid cloud", unit: "%", kind: "sfc2", key: "mid", sc: SC_CLOUD, group: "Clouds" },
  high: { name: "High cloud", unit: "%", kind: "sfc2", key: "high", sc: SC_CLOUD, group: "Clouds" },
  vis: { name: "Visibility", unit: "km", kind: "sfc2", key: "vis", div: 1000, sc: scale([[0, "#e8eef0"], [1, "#b0b8bc"], [5, "#6f7f88"], [10, "#3a4a52"], [30, "#0b1820"]]), group: "Clouds" },
  fzl: { name: "Freezing level", unit: "m", kind: "sfc2", key: "fzl", sc: scale([[0, "#ffffff"], [1000, "#7fb0e0"], [2000, "#3fb0a0"], [3000, "#7dd36a"], [4000, "#f7e83a"], [5000, "#f07b17"]]), group: "Clouds" },
  uwind: { name: "Wind aloft", unit: "km/h", kind: "level", vec: true, sc: SC_JET, group: "Upper air" },
  utemp: { name: "Temperature aloft", unit: "°C", kind: "level", key: "temp", sc: SC_UTEMP, group: "Upper air" },
  urh: { name: "Humidity aloft", unit: "%", kind: "level", key: "rh", sc: SC_RH, group: "Upper air" },
  ugph: { name: "Geopotential height", unit: "m", kind: "level", key: "gph", sc: scale([[500, "#3b2f8f"], [1500, "#2f6fb0"], [3000, "#3fb0a0"], [5600, "#7dd36a"], [5900, "#f7e83a"], [9300, "#f07b17"], [11000, "#e0261f"]]), group: "Upper air" },
  wave: { name: "Waves", unit: "m", kind: "marine", key: "wave", sc: SC_WAVE, group: "Sea" },
  swell: { name: "Swell", unit: "m", kind: "marine", key: "swell", sc: SC_WAVE, group: "Sea" },
  sper: { name: "Swell period", unit: "s", kind: "marine", key: "sper", sc: scale([[4, "#25306e"], [8, "#2f6fb0"], [11, "#3fb0a0"], [14, "#f7e83a"], [17, "#f07b17"], [20, "#e0261f"]]), group: "Sea" },
  sst: { name: "Sea temperature", unit: "°C", kind: "marine", key: "sst", sc: scale([[10, "#3b2f8f"], [14, "#2f6fb0"], [18, "#3fb0a0"], [22, "#7dd36a"], [26, "#f7e83a"], [30, "#e0261f"]]), group: "Sea" },
  cur: { name: "Ocean currents", unit: "km/h", kind: "marine", key: "cur", sc: scale([[0, "#1a2a5a"], [0.5, "#2f5fb0"], [1, "#3fb0d0"], [2, "#7dd36a"], [3, "#f7e83a"], [5, "#e0261f"]]), group: "Sea" },
  pm25: { name: "PM2.5 (smoke)", unit: "µg/m³", kind: "air", key: "pm25", sc: SC_PM, group: "Air quality" },
  pm10: { name: "PM10", unit: "µg/m³", kind: "air", key: "pm10", sc: SC_PM, group: "Air quality" },
  dust: { name: "Dust", unit: "µg/m³", kind: "air", key: "dust", sc: SC_PM, group: "Air quality" },
  aod: { name: "Aerosol optical depth", unit: "", kind: "air", key: "aod", sc: scale([[0, "#1f3a2a"], [0.1, "#3c8a4a"], [0.3, "#f7e83a"], [0.6, "#f07b17"], [1, "#e0261f"], [2, "#8f1a5f"]]), group: "Air quality" },
  aqi: { name: "Air quality index (US)", unit: "", kind: "air", key: "aqi", sc: scale([[0, "#3c8a4a"], [50, "#f7e83a"], [100, "#f07b17"], [150, "#e0261f"], [200, "#8f1a5f"], [300, "#5a1020"]]), group: "Air quality" },
  co: { name: "Carbon monoxide (smoke)", unit: "µg/m³", kind: "air", key: "co", sc: scale([[50, "#1f3a2a"], [150, "#3c8a4a"], [300, "#f7e83a"], [600, "#f07b17"], [1200, "#e0261f"], [3000, "#8f1a5f"]]), group: "Air quality" },
};
// McArthur forest fire danger index from model temperature, humidity and wind (drought factor assumed 10)
FC_LAYERS.ffdi = { name: "Fire danger (FFDI)", unit: "", kind: "sfc", group: "Surface",
  sc: scale([[0, "#3c8a4a"], [12, "#7dd36a"], [25, "#f7e83a"], [50, "#f07b17"], [75, "#e0261f"], [100, "#8f1a5f"], [150, "#2a0a1a"]]),
  fn: (x, y, D) => {
    const t = fcSample("temp", x, y, null, D), rh = fcSample("rh", x, y, null, D), u = fcSample("u", x, y, null, D), v = fcSample("v", x, y, null, D);
    if ([t, rh, u, v].some(q => q == null)) return null;
    return 2 * Math.exp(-0.45 + 0.987 * Math.log(10) - 0.0345 * rh + 0.0338 * t + 0.0234 * Math.hypot(u, v));
  } };
const FC_MODEL_NAMES = { best: "Best match", ecmwf: "ECMWF", gfs: "GFS", icon: "ICON", access: "ACCESS-G" };
S.fc = { data: null, idx: 0, cache: new Map(), fields: new Map(), particles: [], anim: null };
const fcTimeline = () => S.settings.view === "fc";
const fcKindOf = layer => { const L = FC_LAYERS[layer] || FC_LAYERS.wind; return L.kind === "level" ? `p${S.settings.fcLevel}` : L.kind; };
// a forecast pane shows either another model ("m:gfs", or plain "gfs") or another layer ("l:srh1")
const fcPaneSrc = p => (p && p.i > 0 ? S.settings.paneSrc[p.i].fc || "m:gfs" : null);
const fcModelOf = p => { const v = fcPaneSrc(p); if (!v || v.startsWith("l:")) return S.settings.fcModel || "best"; return v.replace(/^m:/, ""); };
const fcLayerOf = p => { const v = fcPaneSrc(p); return v && v.startsWith("l:") && FC_LAYERS[v.slice(2)] ? v.slice(2) : S.settings.fcLayer; };
const fcCacheKey = (kind, model) => `${S.radar.id}|${kind}|${["marine", "air"].includes(kind) ? "best" : model}`;

// compact grid: [header length][JSON header][int16 per variable, time-major], -32768 = missing
function parseGridBin(buf) {
  if (!buf) return null;
  const v = new DataView(buf), hl = v.getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  let o = 4 + hl; o += o % 2;
  const nt = h.time.length, np = h.n * h.n, vars = {};
  h.vars.forEach((name, k) => {
    const q = new Int16Array(buf, o, nt * np), sc = h.scales[k], rows = [];
    for (let t = 0; t < nt; t++) {
      const row = new Float32Array(np);
      for (let i = 0; i < np; i++) { const x = q[t * np + i]; row[i] = x === -32768 ? NaN : x * sc; }
      rows.push(row);
    }
    vars[name] = rows; o += nt * np * 2;
  });
  return { half: h.half, n: h.n, time: h.time, kind: h.kind, vars };
}
// cached grid per kind and model; returns the data, or null while it loads (then redraws)
function fcData(kind, model) {
  const key = fcCacheKey(kind, model);
  let e = S.fc.cache.get(key);
  if (e && e.data && Date.now() - e.data.fetched > 30 * 60e3) e = null;
  if (e && e.failed && Date.now() - e.failed > 60e3) e = null;      // a failed grid is retried after a minute, not every frame
  if (!e) {
    e = { data: null };
    S.fc.cache.set(key, e);
    const m = ["marine", "air"].includes(kind) ? "best" : model;
    e.promise = timedFetch(`/api/fcgrid?radar=${encodeURIComponent(S.radar.id)}&model=${m}&kind=${kind}&fmt=bin`)
      .then(r => (r.ok ? r.arrayBuffer() : null)).then(parseGridBin).catch(() => null).then(d => {
        if (!d) { e.failed = Date.now(); return null; }
        d.fetched = Date.now(); e.data = d;
        draw(); updateReadout();
        return d;
      });
  }
  return e.data;
}

async function refreshFcFrames() {
  if (!S.radar) return;
  $("fcbar").hidden = false;
  syncFcControls();
  const kind = fcKindOf(S.settings.fcLayer), model = fcModelOf(null);
  let D = fcData(kind, model);
  if (!D) {
    $("frameStamp").innerHTML = "<span>Loading forecast grid…</span>";
    D = await S.fc.cache.get(fcCacheKey(kind, model))?.promise;
    if (!D) { $("frameStamp").innerHTML = "<span>Forecast grid unavailable (Open-Meteo may be rate-limiting; try again in a minute)</span>"; return; }
  }
  const prevT = S.fc.data ? S.fc.data.time[S.fc.idx] : null;
  S.fc.data = D;
  const want = prevT ?? Date.now() / 1000 - 1800;
  S.fc.idx = Math.max(0, D.time.findIndex(t => t >= want));
  if (!fcTimeline()) return;
  $("scrub").max = D.time.length - 1;
  showFcFrame(S.fc.idx);
  startParticles();
}
function showFcFrame(i) {
  const D = S.fc.data;
  if (!D) return;
  S.fc.idx = Math.max(0, Math.min(i, D.time.length - 1));
  $("scrub").value = S.fc.idx;
  $("frameCount").textContent = `+${Math.round((D.time[S.fc.idx] - D.time[0]) / 3600)} h`;
  onTimeChanged();
}

// index in D matching the current forecast time
function fcIndexIn(D) {
  if (!S.fc.data || D === S.fc.data) return S.fc.idx;
  const i = D.time.indexOf(S.fc.data.time[S.fc.idx]);
  return i >= 0 ? i : Math.min(S.fc.idx, D.time.length - 1);
}
function fcSample(key, x, y, t, D = S.fc.data) {
  if (!D || !D.vars[key]) return null;
  if (t == null) t = fcIndexIn(D);
  const n = D.n, step = 2 * D.half / (n - 1);
  const gx = (x + D.half) / step, gy = (D.half - y) / step;
  if (gx < 0 || gy < 0 || gx > n - 1 || gy > n - 1) return null;
  const i0 = Math.min(n - 2, Math.floor(gx)), j0 = Math.min(n - 2, Math.floor(gy)), fx = gx - i0, fy = gy - j0;
  const a = D.vars[key][t];
  if (!a) return null;
  const pts = [[a[j0 * n + i0], (1 - fx) * (1 - fy)], [a[j0 * n + i0 + 1], fx * (1 - fy)], [a[(j0 + 1) * n + i0], (1 - fx) * fy], [a[(j0 + 1) * n + i0 + 1], fx * fy]];
  let vs = 0, ws = 0;
  for (const [v, w] of pts) if (v != null && v === v) { vs += v * w; ws += w; }      // skips missing (NaN) points
  if (ws < 0.35) return null;              // mostly outside the data (e.g. sea layers over land)
  return vs / ws;
}
function fcLayerValue(layer, x, y, D) {
  const L = FC_LAYERS[layer];
  if (!D) return null;
  if (L.vec) { const u = fcSample("u", x, y, null, D), v = fcSample("v", x, y, null, D); return u == null ? null : Math.hypot(u, v); }
  if (L.fn) return L.fn(x, y, D);
  if (L.acc) {
    const t1 = fcIndexIn(D); let s = 0, any = false;
    for (let t = 0; t <= t1; t++) { const v = fcSample(L.key, x, y, t, D); if (v != null) { s += v; any = true; } }
    return any ? s : null;
  }
  const v = fcSample(L.key, x, y, null, D);
  return v == null ? null : L.div ? v / L.div : v;
}

// land/sea mask from BoM's 512 km background map (2 km pixels, +-512 km); sea layers are hidden over land
let seaMask = null;
function isLand(x, y) {
  if (isNational()) {
    if (!S.nat.base) return false;
    if (!seaMask || seaMask.radar !== "AUS") {
      const N = S.nat.base.width, c = document.createElement("canvas"); c.width = c.height = N;
      const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(S.nat.base, 0, 0);
      const px = g.getImageData(0, 0, N, N).data, m = new Uint8Array(N * N);
      for (let i = 0; i < m.length; i++) m[i] = px[i * 4] > 14 ? 1 : 0;      // sea is (11,24,32)
      seaMask = { radar: "AUS", m, N, half: 2600 };
    }
    const k = 2 * seaMask.half / seaMask.N, px = Math.floor((x + seaMask.half) / k), py = Math.floor((seaMask.half - y) / k);
    if (px < 0 || py < 0 || px >= seaMask.N || py >= seaMask.N) return false;
    return seaMask.m[py * seaMask.N + px] === 1;
  }
  if (!seaMask || seaMask.radar !== S.radar.id) {
    const L = layerSet(`IDR${S.radar.id}1`, 512);
    if (!L || !L.raw || !L.raw.background) return false;
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(L.raw.background, 0, 0);
    const px = g.getImageData(0, 0, 512, 512).data, m = new Uint8Array(512 * 512);
    for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 2] > px[i * 4] + 5 ? 0 : 1;
    seaMask = { radar: S.radar.id, m };
  }
  const px = Math.floor(256 + x / 2), py = Math.floor(256 - y / 2);
  if (px < 0 || py < 0 || px > 511 || py > 511) return false;
  return seaMask.m[py * 512 + px] === 1;
}

function fcFieldCanvas(p) {
  const layer = fcLayerOf(p), kind = fcKindOf(layer), model = fcModelOf(p);
  const D = fcData(kind, model);
  if (!D) return null;
  const t = fcIndexIn(D);
  if (FC_LAYERS[layer].kind === "marine") isLand(0, 0);          // make sure the land mask is built first
  const key = `${layer}|${kind}|${model}|${t}|${D.fetched}|${seaMask ? 1 : 0}`;
  const hit = S.fc.fields.get(key);
  if (hit) return { canvas: hit, D };
  const N = 200, cv = document.createElement("canvas"); cv.width = cv.height = N;
  const g = cv.getContext("2d"), img = g.createImageData(N, N), out = new Uint32Array(img.data.buffer);
  const sc = FC_LAYERS[layer].sc, k = 2 * D.half / N, sea = FC_LAYERS[layer].kind === "marine";
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -D.half + (i + 0.5) * k, y = D.half - (j + 0.5) * k;
    if (sea && isLand(x, y)) continue;
    const v = fcLayerValue(layer, x, y, D);
    if (v == null) continue;
    const c = sc(v);
    if (c) out[j * N + i] = pack(c[0], c[1], c[2]);
  }
  g.putImageData(img, 0, 0);
  S.fc.fields.set(key, cv);
  while (S.fc.fields.size > 60) S.fc.fields.delete(S.fc.fields.keys().next().value);
  return { canvas: cv, D };
}

const ISO = {
  mslp: { kind: () => "sfc", key: "mslp", step: 2 },
  gph: { kind: () => `p${S.settings.fcLevel}`, key: "gph", step: 40 },
  temp: { kind: () => (FC_LAYERS[S.settings.fcLayer].kind === "level" ? `p${S.settings.fcLevel}` : "sfc"), key: "temp", step: 2 },
  fzl: { kind: () => "sfc2", key: "fzl", step: 250 },
};
// marching squares once per field and time; the line segments (in km) are cached and only re-projected on redraw
const segCache = new Map();
function isoSegments(cacheKey, M, half, sample, levels) {
  const hit = segCache.get(cacheKey);
  if (hit) return hit;
  const k = 2 * half / (M - 1), P = new Float32Array(M * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) P[j * M + i] = sample(-half + i * k, half - j * k) ?? NaN;
  const out = [];
  for (const lev of levels(P)) {
    const segs = [];
    for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) {
      const a = P[j * M + i], b = P[j * M + i + 1], c = P[(j + 1) * M + i + 1], e = P[(j + 1) * M + i];
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(e)) continue;
      if ((a < lev) === (b < lev) && (b < lev) === (c < lev) && (c < lev) === (e < lev)) continue;
      const pts = [];
      const edge = (v1, v2, x1, y1, x2, y2) => { if ((v1 < lev) !== (v2 < lev)) { const f = (lev - v1) / (v2 - v1); pts.push([x1 + (x2 - x1) * f, y1 + (y2 - y1) * f]); } };
      edge(a, b, i, j, i + 1, j); edge(b, c, i + 1, j, i + 1, j + 1); edge(c, e, i + 1, j + 1, i, j + 1); edge(e, a, i, j + 1, i, j);
      for (let q = 0; q + 1 < pts.length; q += 2)
        segs.push(-half + pts[q][0] * k, half - pts[q][1] * k, -half + pts[q + 1][0] * k, half - pts[q + 1][1] * k, (i + j) % 17 === 0 ? 1 : 0);
    }
    out.push({ lev, segs: new Float32Array(segs) });
  }
  segCache.set(cacheKey, out);
  while (segCache.size > 80) segCache.delete(segCache.keys().next().value);
  return out;
}
function strokeSegments(segs, label) {
  ctx.beginPath();
  let labelled = 0;
  for (let q = 0; q < segs.length; q += 5) {
    const [x1, y1] = kmToScreen(segs[q], segs[q + 1]), [x2, y2] = kmToScreen(segs[q + 2], segs[q + 3]);
    if ((x1 < 0 && x2 < 0) || (y1 < 0 && y2 < 0) || (x1 > canvas.width && x2 > canvas.width) || (y1 > canvas.height && y2 > canvas.height)) continue;
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    if (label && segs[q + 4] && labelled < 3) { ctx.fillText(label, x1 + 3, y1 - 3); labelled++; }
  }
  ctx.stroke();
}

function drawIsolines(p) {
  const iso = ISO[S.settings.fcIso];
  if (!iso) return;
  const D = fcData(iso.kind(), fcModelOf(p));
  if (!D || !D.vars[iso.key]) return;
  const d = dpr(), t = fcIndexIn(D);
  const L = isoSegments(`iso|${D.fetched}|${D.kind}|${iso.key}|${t}`, 81, D.half, (x, y) => fcSample(iso.key, x, y, t, D), P => {
    let lo = Infinity, hi = -Infinity;
    for (const v of P) if (!Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const out = [];
    if (Number.isFinite(lo)) for (let lev = Math.ceil(lo / iso.step) * iso.step; lev <= hi; lev += iso.step) out.push(lev);
    return out;
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = "rgba(255,255,255,.8)";
  ctx.font = `${10 * d}px "Barlow Semi Condensed", sans-serif`; ctx.fillStyle = "#ffffff";
  for (const { lev, segs } of L) {
    ctx.lineWidth = (iso.key === "temp" && lev === 0 ? 2.4 : 1.2) * d;
    strokeSegments(segs, `${Math.round(lev)}`);
  }
}
function drawForecast(p) {
  const f = fcFieldCanvas(p);
  if (f) {
    ctx.globalAlpha = /cloud|low|mid|high/.test(S.settings.fcLayer) ? 0.85 : 0.72;
    ctx.imageSmoothingEnabled = true;
    drawCentered(f.canvas, 200, f.D.half);
    ctx.imageSmoothingEnabled = S.settings.smooth;
    ctx.globalAlpha = 1;
  }
  drawIsolines(p);
  if (S.settings.layout > 1) {          // say which model each pane shows
    const d = dpr(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `600 ${12 * d}px "Barlow Semi Condensed", sans-serif`;
    const byLayer = activePanes().some(q => (fcPaneSrc(q) || "").startsWith("l:"));
    const lab = byLayer ? FC_LAYERS[fcLayerOf(p)].name : FC_MODEL_NAMES[fcModelOf(p)], w = ctx.measureText(lab).width;
    ctx.fillStyle = "rgba(15,26,32,.85)"; ctx.fillRect(canvas.width - w - 22 * d, canvas.height - 30 * d, w + 14 * d, 20 * d);
    ctx.fillStyle = "#f2a93b"; ctx.fillText(lab, canvas.width - w - 15 * d, canvas.height - 15 * d);
  }
}

function fcPaneValue(p, x, y) {
  const layer = fcLayerOf(p), L = FC_LAYERS[layer];
  const D = fcData(fcKindOf(layer), fcModelOf(p));
  const v = L.kind === "marine" && isLand(x, y) ? null : fcLayerValue(layer, x, y, D);
  if (v == null) return { html: "<small>No forecast value here</small>" };
  const c = L.sc(v);
  let extra = "";
  if (L.kind === "sfc" || L.kind === "sfc2" || L.kind === "level") {
    const W = fcData(L.kind === "level" ? `p${S.settings.fcLevel}` : "sfc", fcModelOf(p));
    const u = fcSample("u", x, y, null, W), w = fcSample("v", x, y, null, W);
    if (u != null) extra = L.vec ? ` from ${compass(bearingOf(-u, -w))}` : `, wind ${compass(bearingOf(-u, -w))} ${Math.hypot(u, w).toFixed(0)} km/h`;
  }
  const dp = L.key === "aod" ? 2 : (L.unit === "hPa" || L.kind === "marine") ? 1 : 0;
  return { html: `${v.toFixed(dp)} <small>${L.unit}${extra}</small>`, color: c ? `rgb(${c.join(",")})` : null };
}

function syncFcControls() {
  const sel = $("fcLayer");
  if (!sel.dataset.built) {
    const groups = {};
    for (const [k, L] of Object.entries(FC_LAYERS)) (groups[L.group] = groups[L.group] || []).push(`<option value="${k}">${L.name}</option>`);
    sel.innerHTML = Object.entries(groups).map(([g, o]) => `<optgroup label="${g}">${o.join("")}</optgroup>`).join("");
    sel.dataset.built = "1";
  }
  if (!FC_LAYERS[S.settings.fcLayer]) S.settings.fcLayer = "wind";
  sel.value = S.settings.fcLayer;
  const L = FC_LAYERS[S.settings.fcLayer];
  $("fcLevelWrap").hidden = L.kind !== "level" && S.settings.fcIso !== "gph";
  $("fcModelWrap").hidden = L.kind === "marine" || L.kind === "air";
}

// wind (or swell) particles on an overlay above pane 1
function particleField() {
  const L = FC_LAYERS[S.settings.fcLayer];
  const kind = L.kind === "level" ? `p${S.settings.fcLevel}` : L.kind === "marine" ? "marine" : "sfc";
  return { D: fcData(kind, fcModelOf(null)), swell: kind === "marine", jet: L.kind === "level" };
}
function startParticles() {
  if (S.fc.anim || !fcTimeline() || !S.settings.fcParticles) return;
  const ov = $("particles");
  ov.hidden = false;
  const step = () => {
    if (!fcTimeline() || !S.settings.fcParticles || !S.fc.data) { ov.hidden = true; S.fc.anim = null; ov.getContext("2d").clearRect(0, 0, ov.width, ov.height); return; }
    const p0 = PANES[0], d = window.devicePixelRatio || 1;
    if (ov.width !== p0.canvas.width || ov.height !== p0.canvas.height) { ov.width = p0.canvas.width; ov.height = p0.canvas.height; }
    const g = ov.getContext("2d");
    g.globalCompositeOperation = "destination-in"; g.fillStyle = "rgba(0,0,0,.9)"; g.fillRect(0, 0, ov.width, ov.height);
    g.globalCompositeOperation = "source-over";
    const { D, swell, jet } = particleField();
    if (!D || !D.vars.u) { S.fc.anim = requestAnimationFrame(step); return; }
    usePane(p0);
    const P = S.fc.particles, want = Math.round(ov.width * ov.height / (2400 * d * d));
    while (P.length < want) P.push({ age: Math.random() * 80 | 0, x: 0, y: 0, dead: true });
    P.length = Math.min(P.length, want);
    g.strokeStyle = swell ? "rgba(190,230,255,.75)" : "rgba(255,255,255,.8)"; g.lineWidth = 1.1 * d; g.beginPath();
    const pxPerFrame = (jet ? 0.016 : 0.045) * d;
    for (const q of P) {
      if (q.dead || q.age++ > 90) {
        const [x, y] = screenToKm(Math.random() * ov.width, Math.random() * ov.height);
        Object.assign(q, { x, y, age: 0, dead: false });
      }
      const u = fcSample("u", q.x, q.y, null, D), v = fcSample("v", q.x, q.y, null, D);
      if (u == null || (swell && isLand(q.x, q.y))) { q.dead = true; continue; }
      const [sx, sy] = kmToScreen(q.x, q.y);
      const nx = sx + u * pxPerFrame, ny = sy - v * pxPerFrame;
      g.moveTo(sx, sy); g.lineTo(nx, ny);
      [q.x, q.y] = screenToKm(nx, ny);
      if (nx < 0 || ny < 0 || nx > ov.width || ny > ov.height) q.dead = true;
    }
    g.stroke();
    S.fc.anim = requestAnimationFrame(step);
  };
  S.fc.anim = requestAnimationFrame(step);
}
function clearParticles() { const ov = $("particles"); ov.getContext("2d").clearRect(0, 0, ov.width, ov.height); }

// ---------------------------------------------------------------- station plots
S.obsmap = { list: [], fetched: 0 };
async function ensureObsMap() {
  if (!S.settings.stations || Date.now() - S.obsmap.fetched < 10 * 60e3) return;
  S.obsmap.fetched = Date.now();
  const r = await fetch(`/api/obsmap?scope=${isNational() ? "national" : "state"}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (r) { S.obsmap.list = r.stations; draw(); }
}
function drawStations() {
  if (!S.settings.stations || !S.radar || S.radar.lat == null) return;
  const d = dpr(), used = [];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${11 * d}px "Barlow Semi Condensed", sans-serif`;
  for (const s of S.obsmap.list) {
    if (s.t == null) continue;
    const [sx, sy] = kmToScreen(...latLonToKm(s.lat, s.lon));
    if (sx < 0 || sy < 0 || sx > canvas.width || sy > canvas.height) continue;
    if (used.some(([ux, uy]) => Math.abs(ux - sx) < 44 * d && Math.abs(uy - sy) < 30 * d)) continue;
    used.push([sx, sy]);
    if (s.spd != null && s.dir != null && s.spd > 0) {           // wind barb, pointing to where the wind comes from
      const a = s.dir * Math.PI / 180, L = 20 * d, ex = sx + Math.sin(a) * L, ey = sy - Math.cos(a) * L;
      ctx.strokeStyle = "#d6e2e4"; ctx.lineWidth = 1.3 * d;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
      let kt = Math.round(s.spd / 1.852 / 5) * 5, pos = 0;
      while (kt >= 10) { const bx = sx + Math.sin(a) * (L - pos), by = sy - Math.cos(a) * (L - pos); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.sin(a + 1.2) * 8 * d, by - Math.cos(a + 1.2) * 8 * d); kt -= 10; pos += 4 * d; }
      if (kt >= 5) { const bx = sx + Math.sin(a) * (L - pos), by = sy - Math.cos(a) * (L - pos); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.sin(a + 1.2) * 4 * d, by - Math.cos(a + 1.2) * 4 * d); }
      ctx.stroke();
    }
    const c = FC_LAYERS.temp.sc(s.t);
    ctx.fillStyle = `rgb(${c.join(",")})`; ctx.strokeStyle = "#0f1a20"; ctx.lineWidth = 1.5 * d;
    ctx.beginPath(); ctx.arc(sx, sy, 4 * d, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const txt = `${Math.round(s.t)}°`;
    ctx.lineWidth = 3 * d; ctx.strokeStyle = "rgba(10,18,22,.9)"; ctx.strokeText(txt, sx + 6 * d, sy + 12 * d);
    ctx.fillStyle = "#ffffff"; ctx.fillText(txt, sx + 6 * d, sy + 12 * d);
    if (s.gust != null && s.gust >= 40) {
      const gt = `G${Math.round(s.gust)}`;
      ctx.strokeText(gt, sx + 6 * d, sy + 24 * d); ctx.fillStyle = "#f2a93b"; ctx.fillText(gt, sx + 6 * d, sy + 24 * d);
    }
  }
}
function stationNear(x, y) {
  let best = null;
  for (const s of S.obsmap.list) {
    const [sx, sy] = latLonToKm(s.lat, s.lon), dd = Math.hypot(sx - x, sy - y);
    if (!best || dd < best.dd) best = { s, dd };
  }
  return best && best.dd * S.view.scale < 14 * dpr() ? best.s : null;
}

// ---------------------------------------------------------------- sharp town labels
S.towns = { list: null, loading: false };
function ensureTowns(force = false) {
  if ((S.settings.townLabels !== "sharp" && !isNational() && !force) || S.towns.list || S.towns.loading) return;
  S.towns.loading = true;
  fetch("/api/towns").then(r => (r.ok ? r.json() : null)).then(r => { if (r) { S.towns.list = r.towns; S.towns.kmFor = null; draw(); } })
    .catch(() => {}).finally(() => { S.towns.loading = false; });
}
function drawTowns() {
  if ((S.settings.townLabels !== "sharp" && !isNational() && !S.autoSharp) || !S.radar) return;
  if (!S.towns.list) { ensureTowns(true); return; }
  const d = dpr(), boxes = [];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textBaseline = "middle";
  let shown = 0;
  const cap = Math.max(12, Math.round(canvas.width * canvas.height / (d * d) / 9000));
  if (S.towns.kmFor !== S.radar.id) { for (const t of S.towns.list) [t.x, t.y] = latLonToKm(t.la, t.lo); S.towns.kmFor = S.radar.id; }
  for (const t of S.towns.list) {
    const [sx, sy] = kmToScreen(t.x, t.y);
    if (sx < 0 || sy < 0 || sx > canvas.width || sy > canvas.height) continue;
    const big = t.p > 50000, size = (big ? 13 : 11) * d;
    ctx.font = `${big ? 600 : 500} ${size}px "Barlow", sans-serif`;
    const w = ctx.measureText(t.n).width + 10 * d, h = size + 4 * d, pad = 10 * d;
    const box = [sx - 3 * d - pad, sy - h / 2 - pad / 2, sx + w + pad, sy + h / 2 + pad / 2];
    if (boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box);
    ctx.fillStyle = "#d6e2e4"; ctx.beginPath(); ctx.arc(sx, sy, 2.2 * d, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3 * d; ctx.strokeStyle = S.settings.mapStyle === "dark" ? "rgba(10,18,22,.85)" : "rgba(255,255,255,.85)";
    ctx.strokeText(t.n, sx + 5 * d, sy);
    ctx.fillStyle = S.settings.mapStyle === "dark" ? "#e6eef0" : "#101010"; ctx.fillText(t.n, sx + 5 * d, sy);
    if (++shown >= cap) break;
  }
  ctx.textBaseline = "alphabetic";
}

// ---------------------------------------------------------------- radar mosaic (live)
function drawMosaic(p) {
  if (!S.settings.mosaic || p.i !== 0 || !S.product || !S.cfg) return;
  const t = currentTime();
  if (!t) return;
  const others = S.cfg.radars.filter(r => r.id !== S.radar.id && r.lat != null)
    .map(r => ({ r, prod: r.products.find(x => x.suffix === S.product.suffix && x.available) })).filter(o => o.prod);
  // farthest first so nearer radars sit on top
  others.sort((a, b) => Math.hypot(...latLonToKm(b.r.lat, b.r.lon)) - Math.hypot(...latLonToKm(a.r.lat, a.r.lon)));
  for (const { r, prod } of others) {
    const st = liveStore(prod);
    let best = null;
    for (const f of st.frames) if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
    if (!best || Math.abs(best.time - t) > 8 * 60e3) continue;
    if (!best.data) { decodeStoreFrame(st, best); continue; }
    const [ox, oy] = latLonToKm(r.lat, r.lon);
    drawCenteredAt(renderLiveFrame(best, prod.type || "0", true), 512, prod.km, ox, oy);
  }
}

// ---------------------------------------------------------------- lightning sparkline (last 2 h, 100 km of home)
function lightningSparkline() {
  if (!S.cfg || !S.ltg.strikes.length) return "";
  const home = S.cfg.home, end = +(overlayEnd() || Date.now()), bins = new Array(24).fill(0);
  for (const s of S.ltg.strikes) {
    const age = end - s[0];
    if (age < 0 || age >= 120 * 60e3) continue;
    if (haversine(home.lat, home.lon, s[1], s[2]).dist > 100) continue;
    bins[23 - Math.floor(age / 300e3)]++;
  }
  const max = Math.max(...bins);
  if (!max) return "";
  const bars = bins.map((b, i) => `<rect x="${i * 10}" y="${30 - (b / max) * 28}" width="8" height="${(b / max) * 28}" fill="#ffe14a"/>`).join("");
  return `<svg class="ltg-spark" viewBox="0 0 240 30" preserveAspectRatio="none" aria-label="Strikes per 5 minutes, last 2 hours">${bars}</svg><div class="ltg-axis"><span>2 h ago</span><span>peak ${max} per 5 min</span><span>now</span></div>`;
}

// ---------------------------------------------------------------- palette import / export
function exportPalettes() {
  const out = { radarhound_palettes: 1, raw: {}, forecast: {} };
  for (const [k, m] of Object.entries(MOMENTS)) if (m.sc.stops) out.raw[k] = m.sc.stops;
  for (const [k, l] of Object.entries(FC_LAYERS)) out.forecast[k] = l.sc.stops;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" }));
  a.download = "radarhound-palettes.json"; a.click();
}
function applyPalettes(obj) {
  let n = 0;
  const ok = st => Array.isArray(st) && st.length >= 2 && st.every(s => Array.isArray(s) && typeof s[0] === "number" && /^#[0-9a-f]{6}$/i.test(s[1]));
  for (const [k, st] of Object.entries(obj.raw || {})) if (MOMENTS[k] && ok(st)) { MOMENTS[k].sc = scale(st.slice().sort((a, b) => a[0] - b[0]), { clearBelow: !!MOMENTS[k].sc.clear }); n++; }
  for (const [k, st] of Object.entries(obj.forecast || {})) if (FC_LAYERS[k] && ok(st)) { FC_LAYERS[k].sc = scale(st.slice().sort((a, b) => a[0] - b[0]), { clearBelow: !!FC_LAYERS[k].sc.clear }); n++; }
  lutCache.clear(); srvLutCache = null; if (typeof GL !== "undefined") GL.clearLuts();
  for (const p of PANES) { p.polar = null; p.gridC = null; }
  S.fc.fields.clear();
  return n;
}
function importPalettes(file) {
  file.text().then(txt => {
    const obj = JSON.parse(txt);
    const n = applyPalettes(obj);
    store.set("palettes", obj);
    renderLegend(); draw(); renderXsect();
    alert(`Loaded ${n} colour tables.`);
  }).catch(e => alert(`Could not read that palette file: ${e.message}`));
}
(() => { const saved = store.get("palettes", null); if (saved) applyPalettes(saved); })();


// ---------------------------------------------------------------- BoM warnings (public RSS)
S.warn = { list: [], fetched: 0 };
async function loadWarnings() {
  const r = await fetch(`/api/warnings?scope=${isNational() ? "national" : "state"}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!r) return;
  S.warn.list = r.warnings; S.warn.fetched = Date.now();
  renderWarnings();
}
function renderWarnings() {
  const L = S.warn.list, chip = $("warnChip"), panel = $("warnPanel");
  if (!L.length) { chip.hidden = true; panel.hidden = true; return; }
  const severe = L.filter(w => w.level === "severe").length;
  chip.hidden = false;
  chip.classList.toggle("severe", severe > 0);
  chip.textContent = `⚠ ${L.length} warning${L.length > 1 ? "s" : ""}`;
  panel.hidden = false;
  const order = { severe: 0, flood: 1, other: 2 };
  $("warnBody").innerHTML = L.slice().sort((a, b) => order[a.level] - order[b.level]).map(w =>
    `<a class="warn-row ${esc(w.level)}" href="${/^https?:\/\//.test(w.link) ? esc(w.link) : "#"}" target="_blank" rel="noopener">${esc(w.title)}<small>${w.pub ? fmtDate.format(new Date(w.pub)) + " " + fmtTime.format(new Date(w.pub)) : ""}</small></a>`).join("");
}
$("warnChip").onclick = () => $("warnPanel").scrollIntoView({ behavior: "smooth", block: "start" });

// ---------------------------------------------------------------- highways (Natural Earth)
S.roads = { lines: null, loading: false };
function ensureRoads() {
  if (!S.settings.roads || S.roads.lines || S.roads.loading) return;
  S.roads.loading = true;
  fetch("/api/highways").then(r => (r.ok ? r.json() : null)).then(r => { if (r) { S.roads.lines = r.lines; S.roads.kmFor = null; draw(); } })
    .catch(() => {}).finally(() => { S.roads.loading = false; });
}
function drawRoads() {
  if (!S.settings.roads || !S.roads.lines || !S.radar) return;
  const d = dpr(), dark = S.settings.mapStyle === "dark";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.roads.kmFor !== S.radar.id) { for (const l of S.roads.lines) l.km = l.c.map(([la, lo]) => latLonToKm(la, lo)); S.roads.kmFor = S.radar.id; }
  for (const pass of [2, 1]) {
    ctx.strokeStyle = pass === 1 ? (dark ? "rgba(214,190,140,.75)" : "rgba(150,90,20,.8)") : (dark ? "rgba(170,160,140,.45)" : "rgba(120,90,60,.5)");
    ctx.lineWidth = (pass === 1 ? 1.6 : 1) * d;
    ctx.beginPath();
    for (const l of S.roads.lines) {
      if (l.t !== pass) continue;
      l.km.forEach(([x, y], i) => { const [sx, sy] = kmToScreen(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    }
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- active fires (NASA FIRMS, last 24 h)
S.fires = { list: [], fetched: 0 };
async function ensureFires() {
  if (!S.settings.fires || Date.now() - S.fires.fetched < 15 * 60e3) return;
  S.fires.fetched = Date.now();
  const r = await fetch("/api/fires").then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (r) { S.fires.list = r.fires.map(f => ({ ...f, time: new Date(f.t) })); draw(); }
}
function drawFires() {
  if (!S.settings.fires || !S.fires.list.length || !S.radar) return;
  const d = dpr(), now = Date.now();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const f of S.fires.list) {
    const [sx, sy] = kmToScreen(...latLonToKm(f.la, f.lo));
    if (sx < -5 || sy < -5 || sx > canvas.width + 5 || sy > canvas.height + 5) continue;
    const ageH = (now - f.time) / 3600e3, r = (2.5 + Math.min(4, Math.sqrt(f.frp) / 3)) * d;
    ctx.fillStyle = ageH < 6 ? "#ff3d1f" : ageH < 12 ? "#ff8a1f" : "#c9a23a";
    ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = 1 * d;
    ctx.beginPath(); ctx.moveTo(sx, sy - r * 1.4); ctx.lineTo(sx + r, sy + r * 0.8); ctx.lineTo(sx - r, sy + r * 0.8); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
}
function fireNear(x, y) {
  let best = null;
  for (const f of S.fires.list) {
    const [fx, fy] = latLonToKm(f.la, f.lo), dd = Math.hypot(fx - x, fy - y);
    if (!best || dd < best.dd) best = { f, dd };
  }
  return best && best.dd * S.view.scale < 10 * dpr() ? best.f : null;
}

// ---------------------------------------------------------------- storm reports (your own spotter log)
const REPORT_KINDS = { hail: "Hail", wind: "Wind damage", rain: "Heavy rain / flooding", funnel: "Funnel / tornado", lightning: "Lightning damage", other: "Other" };
S.reports = [];
async function loadReports() {
  const r = await fetch("/api/reports").then(r => r.json()).catch(() => null);
  if (r) { S.reports = r.reports; draw(); }
}
function drawReports() {
  if (!S.settings.reports || !S.reports.length || !S.radar) return;
  const d = dpr(), end = +(overlayEnd() || Date.now());
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `bold ${11 * d}px "Barlow Semi Condensed", sans-serif`;
  ctx.textAlign = "center";
  for (const r of S.reports) {
    const t = +new Date(r.t);
    if (t > end + 60e3 || end - t > 24 * 3600e3) continue;          // the 24 h before the frame shown
    const [sx, sy] = kmToScreen(...latLonToKm(r.lat, r.lon));
    const col = { hail: "#62b6ea", wind: "#f2a93b", rain: "#2fd16c", funnel: "#e0261f", lightning: "#ffe14a" }[r.kind] || "#d6e2e4";
    ctx.fillStyle = col; ctx.strokeStyle = "#0f1a20"; ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.rect(sx - 8 * d, sy - 8 * d, 16 * d, 16 * d); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#0f1a20";
    ctx.fillText({ hail: "H", wind: "W", rain: "R", funnel: "T", lightning: "L" }[r.kind] || "?", sx, sy + 4 * d);
  }
  ctx.textAlign = "start";
}
function reportNear(x, y) {
  let best = null;
  for (const r of S.reports) {
    const [rx, ry] = latLonToKm(r.lat, r.lon), dd = Math.hypot(rx - x, ry - y);
    if (!best || dd < best.dd) best = { r, dd };
  }
  return best && best.dd * S.view.scale < 12 * dpr() ? best.r : null;
}
function openReportDialog() {
  if (!S.pin) return;
  const t = currentTime() || new Date();
  $("repKind").value = "hail"; $("repSize").value = ""; $("repNote").value = "";
  $("repTime").value = new Date(+t - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  $("repDlg").hidden = false;
}
$("repCancel").onclick = () => { $("repDlg").hidden = true; };
$("repSave").onclick = async () => {
  const [lat, lon] = kmToLatLon(...S.pin);
  const body = { lat, lon, kind: $("repKind").value, size: $("repSize").value, note: $("repNote").value, t: new Date($("repTime").value).toISOString() };
  const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => null);
  if (r) { S.reports = r.reports; S.settings.reports = true; save(); $("lyrReports").checked = true; }
  $("repDlg").hidden = true; draw(); updateReadout();
};
$("pinReport").onclick = () => openReportDialog();

// ---------------------------------------------------------------- your location (needs https or localhost)
S.me = null;
let meWatch = null;
function toggleMe() {
  if (meWatch != null) { navigator.geolocation.clearWatch(meWatch); meWatch = null; S.me = null; $("meChip").setAttribute("aria-pressed", "false"); draw(); return; }
  if (!navigator.geolocation || !window.isSecureContext) { alert("Browsers only share your location over https or on localhost."); return; }
  $("meChip").setAttribute("aria-pressed", "true");
  meWatch = navigator.geolocation.watchPosition(p => {
    S.me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading };
    draw(); updateReadout();
  }, err => { alert(`Location unavailable: ${err.message}`); toggleMe(); }, { enableHighAccuracy: true, maximumAge: 10000 });
}
$("meChip").onclick = toggleMe;
function drawMe() {
  if (!S.me || !S.radar) return;
  const d = dpr(), [sx, sy] = kmToScreen(...latLonToKm(S.me.lat, S.me.lon));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const accPx = (S.me.acc / 1000) * S.view.scale;
  if (accPx > 8 * d) { ctx.fillStyle = "rgba(66,140,255,.15)"; ctx.beginPath(); ctx.arc(sx, sy, accPx, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = "#428cff"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5 * d;
  ctx.beginPath(); ctx.arc(sx, sy, 7 * d, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (S.me.heading != null && !Number.isNaN(S.me.heading)) {
    const a = S.me.heading * Math.PI / 180;
    ctx.fillStyle = "#428cff";
    ctx.beginPath(); ctx.moveTo(sx + Math.sin(a) * 16 * d, sy - Math.cos(a) * 16 * d);
    ctx.lineTo(sx + Math.sin(a + 2.6) * 9 * d, sy - Math.cos(a + 2.6) * 9 * d); ctx.lineTo(sx + Math.sin(a - 2.6) * 9 * d, sy - Math.cos(a - 2.6) * 9 * d); ctx.fill();
  }
}

// ---------------------------------------------------------------- contour overlays on raw volume panes (MESH, rotation, echo tops)
const CONTOURS = { MESH: { levels: [10, 20, 40, 60], unit: "mm" }, ROT: { levels: [4, 8, 12], unit: "" }, ET45: { levels: [6, 9, 12], unit: "km" }, VIL: { levels: [20, 40, 60], unit: "" } };
function drawContours() {
  const prod = S.settings.contour;
  if (!prod || prod === "none" || S.mode !== "raw" || S.settings.view === "sat" || !S.raw.scans.length) return;
  const scan = S.raw.scans[S.raw.idx];
  const key = `${S.radar.id}/${S.raw.date}/${scan}/grid/${prod}`;
  const pr = S.raw.sweeps.get(key);
  if (!pr) { getGrid(scan, prod).then(() => draw()).catch(() => {}); return; }
  if (!pr.done) { pr.then(sw => { pr.done = sw; draw(); }).catch(() => {}); return; }
  const sw = pr.done, spec = CONTOURS[prod], N = sw.size, step = 2;     // contour on a 2 km grid
  const M = Math.floor(N / step), k = 2 * sw.half / M, d = dpr();
  if (!sw.contourSegs) sw.contourSegs = isoSegments(`ct|${key}`, M, sw.half - k / 2, (x, y) => {
    const px = Math.floor((x + sw.half) / (2 * sw.half) * N), py = Math.floor((sw.half - y) / (2 * sw.half) * N);
    let mx = 0;
    for (let b = 0; b < step; b++) for (let a = 0; a < step; a++) {
      const r = sw.data[Math.min(N - 1, py + b) * N + Math.min(N - 1, px + a)];
      if (r) mx = Math.max(mx, r * sw.gain + sw.offset);
    }
    return mx;
  }, () => spec.levels);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  sw.contourSegs.forEach(({ segs }, li) => {
    ctx.strokeStyle = ["#ffffff", "#f7e83a", "#f07b17", "#e23ad6"][li] || "#ffffff";
    ctx.lineWidth = (1.4 + li * 0.5) * d;
    strokeSegments(segs, null);
  });
  if (sw.contourSegs) return;
  const V = new Float32Array(M * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    let mx = 0;
    for (let b = 0; b < step; b++) for (let a = 0; a < step; a++) { const r = sw.data[(j * step + b) * N + i * step + a]; if (r) mx = Math.max(mx, r * sw.gain + sw.offset); }
    V[j * M + i] = mx;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `bold ${10 * d}px "Barlow Semi Condensed", sans-serif`;
  const xy = (i, j) => kmToScreen(-sw.half + (i + 0.5) * k, sw.half - (j + 0.5) * k);
  spec.levels.forEach((lev, li) => {
    ctx.strokeStyle = ["#ffffff", "#f7e83a", "#f07b17", "#e23ad6"][li] || "#ffffff";
    ctx.lineWidth = (1.4 + li * 0.5) * d;
    ctx.beginPath();
    for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) {
      const a = V[j * M + i], b = V[j * M + i + 1], c = V[(j + 1) * M + i + 1], e = V[(j + 1) * M + i];
      if (a < lev && b < lev && c < lev && e < lev) continue;
      const pts = [];
      const edge = (v1, v2, x1, y1, x2, y2) => { if ((v1 < lev) !== (v2 < lev)) { const f = (lev - v1) / (v2 - v1); pts.push([x1 + (x2 - x1) * f, y1 + (y2 - y1) * f]); } };
      edge(a, b, i, j, i + 1, j); edge(b, c, i + 1, j, i + 1, j + 1); edge(c, e, i + 1, j + 1, i, j + 1); edge(e, a, i, j + 1, i, j);
      for (let q = 0; q + 1 < pts.length; q += 2) { const [x1, y1] = xy(...pts[q]), [x2, y2] = xy(...pts[q + 1]); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    }
    ctx.stroke();
  });
}

// ---------------------------------------------------------------- state borders (Natural Earth)
S.borders = { lines: null, loading: false };
function drawBorders() {
  if (!S.radar) return;
  if (!S.borders.lines) {
    if (!S.borders.loading) {
      S.borders.loading = true;
      fetch("/api/borders").then(r => (r.ok ? r.json() : null)).then(r => { if (r) { S.borders.lines = r.lines; S.borders.kmFor = null; draw(); } }).catch(() => {});
    }
    return;
  }
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = S.settings.mapStyle === "dark" ? "rgba(200,210,214,.55)" : "rgba(60,60,60,.6)";
  ctx.lineWidth = 1.2 * d; ctx.setLineDash([6 * d, 4 * d]);
  if (S.borders.kmFor !== S.radar.id) { S.borders.km = S.borders.lines.map(ln => ln.map(([la, lo]) => latLonToKm(la, lo))); S.borders.kmFor = S.radar.id; }
  ctx.beginPath();
  for (const ln of S.borders.km) ln.forEach(([x, y], i) => { const [sx, sy] = kmToScreen(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
  ctx.stroke(); ctx.setLineDash([]);
}
