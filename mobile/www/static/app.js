/* wxdeck core: shared km-based map view, live BoM loop, raw volume viewer,
   satellite + lightning overlays, readout. Panels (obs/forecast) live in panels.js. */
"use strict";

// ================================================================== helpers
const $ = id => document.getElementById(id);
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgbKey = (r, g, b) => (r << 16) | (g << 8) | b;
const lerp = (a, b, t) => a + (b - a) * t;
const mixHex = (a, b, t) => { const A = hex(a), B = hex(b); return "#" + A.map((v, i) => Math.round(lerp(v, B[i], t)).toString(16).padStart(2, "0")).join(""); };
const ramp = (a, b, n) => Array.from({ length: n }, (_, i) => mixHex(a, b, n === 1 ? 0 : i / (n - 1)));
const pack = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];
const KM_PER_DEG = 111.11;
// escape text that came from users or outside feeds before putting it into HTML
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RE43 = 8494.7; // 4/3 earth radius, km

const store = {
  get(k, d) { try { const v = localStorage.getItem("wxdeck." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("wxdeck." + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

let fmtTime, fmtDate, fmtH23, fmtDay;
function setupFormatters(tz) {
  fmtTime = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  fmtDate = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  fmtH23 = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" });
  fmtDay = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short" });
}

// ================================================================== live (BoM image) palettes
const REFL_BOM = ["#f5f5ff", "#b4b4ff", "#7878ff", "#1414ff", "#00d8c3", "#009690", "#006666", "#ffff00", "#ffc800", "#ff9600", "#ff6400", "#ff0000", "#c80000", "#780000", "#280000"];
const REFL_RATE = [0.2, 0.5, 1.5, 2.5, 4, 6, 10, 15, 20, 35, 50, 80, 120, 200, 360];
const REFL_DBZ = REFL_RATE.map(r => 10 * Math.log10(200 * Math.pow(r, 1.6)));
const NWS_STOPS = [[5, "#04e9e7"], [10, "#019ff4"], [15, "#0300f4"], [20, "#02fd02"], [25, "#01c501"], [30, "#008e00"], [35, "#fdf802"], [40, "#e5bc00"], [45, "#fd9500"], [50, "#fd0000"], [55, "#d40000"], [60, "#bc0000"], [65, "#f800fd"], [70, "#9854c6"]];
const nwsColor = dbz => { let c = NWS_STOPS[0][1]; for (const [v, col] of NWS_STOPS) if (dbz >= v) c = col; return c; };
const DOPP_BOM = ["#000066", "#111e78", "#20398a", "#2d509a", "#3b6bac", "#4a85be", "#59a0d0", "#66b7e0", "#75d2f2", "#ffffff", "#ffea00", "#ffcc00", "#ffb600", "#ff9900", "#ff7e00", "#ff6600", "#ff4900", "#ff3300", "#ff0000"];
const DOPP_VAL = Array.from({ length: 19 }, (_, i) => (i - 9) * 10);
const RAIN_BOM = ["#7ffeff", "#7fe4ff", "#7fcbff", "#7fb2ff", "#7f99ff", "#7f7fcc", "#7fff99", "#7fe57f", "#7fcc7f", "#ffe47f", "#ffcb7f", "#ffb27f", "#ff7f7f", "#e57f7f", "#cc7f7f", "#ff4040"];
const RAIN_BAND = ["0.2–10", "0.2–10", "0.2–10", "10–25", "10–25", "10–25", "25–50", "25–50", "25–50", "50–100", "50–100", "50–100", "100–250", "100–250", "100–250", "250+"];

const PALETTES = {
  "0": {
    source: REFL_BOM,
    tables: {
      night: { name: "Night (wxdeck)", colors: ["#3b5868", "#4f7d8a", "#5fa0a4", "#5cbf8e", "#7dd36a", "#c3e058", "#f2d64b", "#f2a93b", "#ef7f3a", "#e5533d", "#c42f4f", "#a3226e", "#d04fd0", "#f0a0f0", "#ffffff"] },
      nws: { name: "NWS dBZ", colors: REFL_DBZ.map(nwsColor) },
      bom: { name: "BoM classic", colors: REFL_BOM },
    },
    thresholds: REFL_RATE.map((r, i) => ({ v: i, label: i === 0 ? "Show all" : `${r} mm/h (~${Math.round(REFL_DBZ[i])} dBZ)` })),
    describe(i) { return { main: `~${Math.round(REFL_DBZ[i])} dBZ`, sub: `${REFL_RATE[i]}${i < 14 ? "–" + REFL_RATE[i + 1] : "+"} mm/h` }; },
    legendLabels: ["Light", "Moderate", "Heavy"],
  },
  "2": {
    source: DOPP_BOM,
    tables: {
      greenred: { name: "Green / red (chaser)", colors: [...ramp("#00ff6a", "#0f4a2a", 9), "#4a5256", ...ramp("#4f1414", "#ff2a2a", 9)] },
      bom: { name: "BoM classic", colors: DOPP_BOM },
    },
    thresholds: [{ v: 0, label: "Show all" }, { v: 1, label: "Hide 0" }, { v: 2, label: "Hide ±10" }, { v: 3, label: "Hide ±20" }],
    describe(i) {
      const v = DOPP_VAL[i];
      if (v === 0) return { main: "~0 km/h", sub: "no radial motion" };
      return { main: `~${Math.abs(v)} km/h`, sub: v < 0 ? "towards radar" : "away from radar" };
    },
    legendLabels: ["−90 towards", "0", "away +90"],
  },
  "1": {
    source: RAIN_BOM,
    tables: { bom: { name: "BoM classic", colors: RAIN_BOM } },
    thresholds: [{ v: 0, label: "Show all" }, { v: 3, label: "≥ 10 mm" }, { v: 6, label: "≥ 25 mm" }, { v: 9, label: "≥ 50 mm" }],
    describe(i) { return { main: `${RAIN_BAND[i]} mm`, sub: "accumulated" }; },
    legendLabels: ["0.2", "25", "250+"],
  },
};
for (const t of Object.values(PALETTES)) {
  t.lookup = new Map(t.source.map((h, i) => { const [r, g, b] = hex(h); return [rgbKey(r, g, b), i]; }));
}
const C_TRANSPARENT = 255, C_BAR = 254, C_TEXT = 253;

// ================================================================== raw volume colour scales
function scale(stops, { clearBelow = false } = {}) {
  const S = stops.map(([v, h]) => [v, hex(h)]);
  const fn = v => {
    if (v < S[0][0]) return clearBelow ? null : S[0][1];
    for (let i = 1; i < S.length; i++) {
      if (v <= S[i][0]) {
        const [v0, c0] = S[i - 1], [v1, c1] = S[i];
        const t = (v - v0) / (v1 - v0);
        return [Math.round(lerp(c0[0], c1[0], t)), Math.round(lerp(c0[1], c1[1], t)), Math.round(lerp(c0[2], c1[2], t))];
      }
    }
    return S[S.length - 1][1];
  };
  fn.stops = stops;
  fn.clear = clearBelow;
  return fn;
}
const REF_SCALE = scale([[-10, "#1c2a33"], [5, "#3d5566"], [12, "#4f8fa8"], [18, "#2fc0c9"], [22, "#2fd16c"], [30, "#11a33a"], [35, "#f7e83a"], [40, "#f2b41f"], [45, "#f07b17"], [50, "#e0261f"], [55, "#b0151a"], [60, "#e23ad6"], [65, "#9b2ff0"], [72, "#ffffff"]], { clearBelow: true });
const VEL_SCALE = scale([[-40, "#a9ffd0"], [-30, "#00ff8c"], [-18, "#14b85a"], [-8, "#127040"], [-1, "#1d3a2b"], [0, "#3c4246"], [1, "#3d1d1d"], [8, "#801c22"], [18, "#c8202c"], [30, "#ff3d6e"], [40, "#ffc0d6"]]);
const SW_SCALE = scale([[0, "#1f2a30"], [2, "#2f6f8f"], [4, "#3fb0a0"], [6, "#e5d24a"], [8, "#f07b17"], [12, "#e0261f"], [16, "#ffffff"]]);
const ZDR_SCALE = scale([[-3, "#3b3f8f"], [-1, "#5f6ab0"], [0, "#8a9aa6"], [1, "#3fb0a0"], [2, "#7dd36a"], [3, "#f7e83a"], [4, "#f07b17"], [5, "#e0261f"], [7, "#e23ad6"], [8, "#ffffff"]]);
const CC_SCALE = scale([[0.2, "#1f2a30"], [0.6, "#3b3f8f"], [0.8, "#2f6f8f"], [0.9, "#3fb0a0"], [0.95, "#7dd36a"], [0.97, "#f7e83a"], [0.99, "#f07b17"], [1.0, "#e0261f"], [1.05, "#e23ad6"]]);
const KDP_SCALE = scale([[-1, "#3b3f8f"], [0, "#3c4246"], [0.5, "#3fb0a0"], [1, "#7dd36a"], [2, "#f7e83a"], [3, "#f07b17"], [5, "#e0261f"], [8, "#e23ad6"]]);
const PHI_SCALE = scale([[0, "#3b3f8f"], [60, "#2f6f8f"], [120, "#3fb0a0"], [180, "#7dd36a"], [240, "#f7e83a"], [300, "#f07b17"], [360, "#e0261f"]]);
const SNR_SCALE = scale([[0, "#1f2a30"], [10, "#4b5d66"], [20, "#8a9aa6"], [40, "#ffffff"]]);

const ET_SCALE = scale([[1, "#2a4b5c"], [3, "#2f6f8f"], [5, "#3fb0a0"], [7, "#7dd36a"], [9, "#f7e83a"], [11, "#f07b17"], [13, "#e0261f"], [15, "#e23ad6"], [17, "#ffffff"]], { clearBelow: true });
const VIL_SCALE = scale([[1, "#2a4b5c"], [5, "#3fb0a0"], [10, "#7dd36a"], [20, "#f7e83a"], [30, "#f07b17"], [40, "#e0261f"], [55, "#e23ad6"], [70, "#ffffff"]], { clearBelow: true });
const MESH_SCALE = scale([[1, "#2a4b5c"], [5, "#2f6f8f"], [10, "#3fb0a0"], [20, "#f7e83a"], [30, "#f07b17"], [40, "#e0261f"], [50, "#e23ad6"], [75, "#ffffff"]], { clearBelow: true });
const ROT_SCALE = scale([[1, "#2a3a44"], [2, "#3b5f72"], [4, "#62b6ea"], [6, "#f7e83a"], [8, "#f07b17"], [12, "#e0261f"], [18, "#e23ad6"], [25, "#ffffff"]], { clearBelow: true });
const POSH_SCALE = scale([[1, "#2a4b5c"], [20, "#2f6f8f"], [40, "#7dd36a"], [60, "#f7e83a"], [80, "#f07b17"], [95, "#e0261f"], [100, "#e23ad6"]], { clearBelow: true });

const HCA_CLASSES = [null,
  ["Biological (insects, birds)", "#8a7a5a"], ["Ground clutter", "#5a5a5a"], ["Ice crystals", "#c8d8ff"], ["Dry snow / aggregates", "#7f99ff"],
  ["Wet snow (melting layer)", "#b06ad8"], ["Rain", "#2fd16c"], ["Heavy rain", "#14a33a"], ["Big drops", "#f7e83a"],
  ["Graupel", "#f2a93b"], ["Hail and rain", "#e0261f"], ["Large hail", "#ff4fd8"]];
function hcaScale() {
  const fn = v => { const c = HCA_CLASSES[Math.round(v)]; return c ? hex(c[1]) : null; };
  fn.stops = HCA_CLASSES.slice(1).map((c, i) => [i + 1, c[1]]);
  fn.clear = true;
  return fn;
}

const MOMENTS = {
  DBZH: { label: "Reflectivity", unit: "dBZ", sc: REF_SCALE, dp: 1, ref: true, key: "R" },
  DBZH_CLEAN: { label: "Reflectivity (clutter removed)", unit: "dBZ", sc: REF_SCALE, dp: 1, ref: true },
  VRADDH: { label: "Velocity (dealiased)", unit: "m/s", sc: VEL_SCALE, dp: 1, vel: true, key: "V" },
  SRV: { label: "Storm-relative velocity", unit: "m/s", sc: VEL_SCALE, dp: 1, vel: true, derived: true, key: "S" },
  VRADH: { label: "Velocity (raw)", unit: "m/s", sc: VEL_SCALE, dp: 1, vel: true },
  WRADH: { label: "Spectrum width", unit: "m/s", sc: SW_SCALE, dp: 1 },
  ZDR: { label: "Differential reflectivity (ZDR)", unit: "dB", sc: ZDR_SCALE, dp: 2 },
  RHOHV: { label: "Correlation coefficient (CC)", unit: "", sc: CC_SCALE, dp: 3 },
  KDP: { label: "Specific diff. phase (KDP)", unit: "°/km", sc: KDP_SCALE, dp: 2 },
  PHIDP: { label: "Differential phase", unit: "°", sc: PHI_SCALE, dp: 0 },
  TH: { label: "Reflectivity (unfiltered)", unit: "dBZ", sc: REF_SCALE, dp: 1, ref: true },
  SNRH: { label: "Signal to noise", unit: "dB", sc: SNR_SCALE, dp: 1 },
  // per-tilt products computed on the server from the dual-pol moments
  HCA: { label: "Hydrometeor class", unit: "", sc: hcaScale(), dp: 0, cat: true },
  RR: { label: "Rain rate", unit: "mm/h", sc: scale([[0.5, "#3f7f98"], [2, "#2fc0c9"], [5, "#2fd16c"], [10, "#f7e83a"], [25, "#f07b17"], [50, "#e0261f"], [100, "#e23ad6"]], { clearBelow: true }), dp: 1 },
  // whole-volume products, computed on the server on a 1 km grid
  CR: { label: "Composite reflectivity", unit: "dBZ", sc: REF_SCALE, dp: 1, ref: true, grid: true },
  ET18: { label: "Echo tops (18 dBZ)", unit: "km", sc: ET_SCALE, dp: 1, grid: true },
  ET45: { label: "Echo tops (45 dBZ)", unit: "km", sc: ET_SCALE, dp: 1, grid: true },
  VIL: { label: "Vertically integrated liquid", unit: "kg/m²", sc: VIL_SCALE, dp: 1, grid: true },
  MESH: { label: "Hail size (MESH)", unit: "mm", sc: MESH_SCALE, dp: 0, grid: true, note: v => (v >= 20 ? "severe size" : "") },
  POSH: { label: "Severe hail probability", unit: "%", sc: POSH_SCALE, dp: 0, grid: true },
  ROT: { label: "Low-level rotation", unit: "×10⁻³ /s cyclonic shear", sc: ROT_SCALE, dp: 1, grid: true, note: v => (v >= 8 ? "mesocyclone strength" : "") },
};

// ================================================================== state
const S = {
  cfg: null, radar: null, product: null, mode: "live",
  frames: [], idx: 0, playing: false, timer: null,
  view: { scale: null, cx: 0, cy: 0 },
  hover: null,
  layerSets: new Map(),
  sat: { cache: new Map(), current: null },
  ltg: { a: 0, b: 0, strikes: [], status: null, fetchedAt: 0, loading: false, radar: null },
  raw: { days: [], date: null, scans: [], idx: 0, metas: new Map(), sweeps: new Map(), sweep: null, polar: null, token: 0, anchor: null },
  settings: Object.assign({
    mapStyle: "dark", palette: { "0": "night", "2": "greenred", "1": "bom" }, opacity: 90,
    threshold: { "0": 0, "2": 0, "1": 0 }, topo: true, range: true, loc: true, home: true, smooth: false,
    speed: 250, window: 1, radar: null, product: "3",
    view: "radar", satLayer: "geocolor", satOpacity: 60, lightning: true, ltgWindow: 15,
    moment: "DBZH", elev: 0.5, refMin: 5,
    layout: 1, paneSrc: [null, { live: "I", raw: "VRADDH" }, { live: "A", raw: "ZDR" }, { live: "2", raw: "RHOHV" }],
    motion: { dir: 60, spd: 40 }, cells: false, cellThr: 6, ltgAlertKm: 0,
    fcLayer: "wind", fcModel: "best", fcLevel: 500, fcIso: "none", ltgDensity: false, fcParticles: true, fcIsobars: false, stations: false, roads: false, fires: false, reports: true, contour: "none", rotDet: true, couplets: true, envOverlay: "none", wxw: true, watches: true, mode: null, gpu: true, seamless: true, alerts: "near", alertVoice: true, alertBom: true, alertNear: 50, townLabels: "bom", mosaic: false,
  }, store.get("settings", {})),
};
const save = () => store.set("settings", S.settings);
if ("sat" in S.settings) { // migrate v2 setting
  if (S.settings.sat !== "off") { S.settings.view = "both"; S.settings.satLayer = S.settings.sat; }
  delete S.settings.sat; save();
}
S.satFrames = []; S.satIdx = 0; S.coast = null;
if (!["radar", "both", "sat", "fc"].includes(S.settings.view)) S.settings.view = "radar";
if (S.settings.satLayer === "ir") S.settings.satLayer = "ir13e";
if (![1, 2, 4].includes(S.settings.layout)) S.settings.layout = 1;
const satTimeline = () => S.mode === "live" && S.settings.view === "sat";

// ================================================================== canvas & view (km space: x east, y north of radar)
const PANES = [...document.querySelectorAll(".pane")].map((el, i) => {
  const c = el.querySelector("canvas");
  return { i, el, canvas: c, ctx: c.getContext("2d"), sel: el.querySelector(".pane-sel"), polar: null, polarCanvas: null };
});
let canvas = PANES[0].canvas, ctx = PANES[0].ctx;   // the pane currently being drawn or handled
const usePane = p => { canvas = p.canvas; ctx = p.ctx; };
const activePanes = () => PANES.slice(0, S.settings.layout);
const work = document.createElement("canvas"); work.width = work.height = 512;
const wctx = work.getContext("2d", { willReadFrequently: true });
const recolorCanvas = document.createElement("canvas"); recolorCanvas.width = recolorCanvas.height = 512;
const rctx = recolorCanvas.getContext("2d");
const recolorData = rctx.createImageData(512, 512);

const dpr = () => canvas.width / Math.max(1, canvas.getBoundingClientRect().width);

function fitView(halfKm) {
  S.view.scale = Math.min(canvas.width, canvas.height) / (2 * halfKm);
  S.view.cx = 0; S.view.cy = 0;
}
function kmToScreen(x, y) { const v = S.view; return [canvas.width / 2 + (x - v.cx) * v.scale, canvas.height / 2 - (y - v.cy) * v.scale]; }
function screenToKm(sx, sy) { const v = S.view; return [(sx - canvas.width / 2) / v.scale + v.cx, -(sy - canvas.height / 2) / v.scale + v.cy]; }
function latLonToKm(lat, lon) {
  const r = S.radar;
  return [(lon - r.lon) * KM_PER_DEG * Math.cos(lat * Math.PI / 180), (lat - r.lat) * KM_PER_DEG];
}
function kmToLatLon(x, y) {
  const lat = S.radar.lat + y / KM_PER_DEG;
  return [lat, S.radar.lon + x / (KM_PER_DEG * Math.cos(lat * Math.PI / 180))];
}
// draw an image whose centre is the radar and whose edges are ±halfKm
// Draw only the part of an image that is on screen. Drawing a whole image through a huge zoom
// transform is slow and some GPUs (phones especially) silently skip it, so things vanished when zoomed in.
// (x0, y0) = top-left corner in km, kpp = km per image pixel.
function drawKmImage(img, x0, y0, kpp) {
  const v = S.view, W = canvas.width, H = canvas.height, s = v.scale;
  const iw = img.width, ih = img.height;
  const sx0 = Math.max(0, Math.floor((v.cx - W / 2 / s - x0) / kpp)), sx1 = Math.min(iw, Math.ceil((v.cx + W / 2 / s - x0) / kpp));
  const sy0 = Math.max(0, Math.floor((y0 - (v.cy + H / 2 / s)) / kpp)), sy1 = Math.min(ih, Math.ceil((y0 - (v.cy - H / 2 / s)) / kpp));
  if (sx1 <= sx0 || sy1 <= sy0) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0,
    W / 2 + (x0 + sx0 * kpp - v.cx) * s, H / 2 - (y0 - sy0 * kpp - v.cy) * s, (sx1 - sx0) * kpp * s, (sy1 - sy0) * kpp * s);
}
function drawCentered(img, px, halfKm) { drawKmImage(img, -halfKm, halfKm, 2 * halfKm / px); }
// same as drawCentered, for an image centred on another point (km offset from the main radar)
function drawCenteredAt(img, px, halfKm, ox, oy) { drawKmImage(img, ox - halfKm, oy + halfKm, 2 * halfKm / px); }

// 3x phone screens cost 2.25x the work of 2x for no visible gain on radar data
const pixelRatio = () => Math.min(2, window.devicePixelRatio || 1);
function resizeCanvas() {
  const d = pixelRatio();
  const c0 = PANES[0].canvas;
  const oldMin = Math.min(c0.width, c0.height);
  for (const p of PANES) {
    const r = p.canvas.getBoundingClientRect();
    p.canvas.width = Math.max(1, Math.round(r.width * d));
    p.canvas.height = Math.max(1, Math.round(r.height * d));
    p.polar = null;
  }
  usePane(PANES[0]);
  if (S.view.scale == null) fitView(128);
  else if (oldMin > 1) S.view.scale *= Math.min(c0.width, c0.height) / oldMin;
  draw();
}
new ResizeObserver(resizeCanvas).observe($("scopeFrame"));

function loadImage(url) {
  if (typeof WXP !== "undefined" && /^\/(api|layers|frames)\//.test(url)) return WXP.loadImageUrl(url);     // phone mode
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}

// ================================================================== basemap layer sets
function recolorLayer(img, fn) {
  wctx.clearRect(0, 0, 512, 512);
  wctx.drawImage(img, 0, 0);
  const id = wctx.getImageData(0, 0, 512, 512);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const c = fn(d[i], d[i + 1], d[i + 2]);
    if (c) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; }
  }
  const c = document.createElement("canvas"); c.width = c.height = 512;
  c.getContext("2d").putImageData(id, 0, 0);
  return c;
}
const darkBase = (r, g, b) => {
  if (b > r + 5) return [11, 24, 32];
  if (r > 190 && g < 150 && b < 40) return null; // keep orange crosshair
  const lum = 0.3 * r + 0.59 * g + 0.11 * b;
  const t = Math.min(1, Math.max(0, (220 - lum) / 40));
  return [Math.round(lerp(27, 66, t)), Math.round(lerp(38, 70, t)), Math.round(lerp(40, 54, t))];
};
const darkLoc = (r, g, b) => (r < 60 && g < 60 && b < 60 ? [196, 210, 213] : null);

function layerSet(id, km) {
  let L = S.layerSets.get(id);
  if (!L) {
    L = { id, km, raw: null, built: null, key: null };
    S.layerSets.set(id, L);
    Promise.all(["background", "topography", "range", "locations"].map(n => loadImage(`/layers/${id}.${n}.png`).catch(() => null)))
      .then(([background, topography, range, locations]) => { L.raw = { background, topography, range, locations }; draw(); });
  }
  if (!L.raw) return null;
  const key = `${S.settings.mapStyle}|${S.settings.topo}`;
  if (L.key !== key) {
    const dark = S.settings.mapStyle === "dark";
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const g = c.getContext("2d");
    if (L.raw.background) g.drawImage(L.raw.background, 0, 0);
    if (L.raw.topography && S.settings.topo) g.drawImage(L.raw.topography, 0, 0);
    L.built = {
      base: dark ? recolorLayer(c, darkBase) : c,
      range: L.raw.range,
      loc: L.raw.locations ? (dark ? recolorLayer(L.raw.locations, darkLoc) : L.raw.locations) : null,
    };
    L.key = key;
  }
  return L;
}

// Returns { fine, fills }: `fine` supplies range rings and towns; coarser `fills` are drawn
// underneath so the map still covers the screen when zoomed out past the fine set's extent.
const isNational = () => !!(S.radar && S.radar.national);
function currentLayerSets() {
  if (!S.radar) return { fine: null, fills: [], labels: false };
  if (isNational()) return { fine: null, fills: [], labels: false };
  const sets = (S.radar.layer_sets || []).slice().sort((a, b) => a.km - b.km);
  if (!sets.length) return { fine: null, fills: [], labels: false };
  const halfMin = Math.min(canvas.width, canvas.height) / 2 / S.view.scale;
  // how far from the radar the screen reaches: zoomed in on a town 150 km out still needs a 256 km map
  const reach = Math.max(Math.abs(S.view.cx) + canvas.width / 2 / S.view.scale, Math.abs(S.view.cy) + canvas.height / 2 / S.view.scale);
  const pick = sets.find(s => s.km >= Math.max(halfMin * 0.9, Math.min(reach, sets[sets.length - 1].km))) || sets[sets.length - 1];
  let fills = [];
  if (reach > pick.km) {
    const cover = sets.find(s => s.km >= reach) || sets[sets.length - 1];
    if (cover !== pick) fills = [layerSet(cover.id, cover.km)].filter(Boolean);
  }
  // far zoomed out (regional satellite) the towns and rings become clutter
  const labels = halfMin <= pick.km * 1.3;
  return { fine: layerSet(pick.id, pick.km), fills, labels };
}

// ================================================================== live mode (BoM images)
const frameN = data => Math.round(Math.sqrt(data.length));     // frames are square: 512 (BoM) or 1024 (national)
function decodeFrame(img, type) {
  const N = img.width;
  if (work.width !== N) { work.width = work.height = N; }
  wctx.clearRect(0, 0, N, N);
  wctx.drawImage(img, 0, 0);
  const d = wctx.getImageData(0, 0, N, N).data;
  const out = new Uint8Array(N * N);
  const lookup = PALETTES[type].lookup;
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    if (d[i + 3] < 128) { out[p] = C_TRANSPARENT; continue; }
    const k = rgbKey(d[i], d[i + 1], d[i + 2]);
    let v = lookup.get(k);
    if (v === undefined) v = nearest(type, k, d[i], d[i + 1], d[i + 2]);
    out[p] = v;
  }
  return out;
}
// BoM frames use a few colours slightly off the legend (#ffce00 vs #ffcc00): snap to nearest.
const nearestCache = { "0": new Map(), "1": new Map(), "2": new Map() };
function nearest(type, k, r, g, b) {
  const cache = nearestCache[type];
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  let res;
  if (k === 0xc0c0c0) res = C_BAR;
  else if (Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && r < 170) res = C_TEXT;
  else {
    let best = C_TRANSPARENT, bestD = 400;
    PALETTES[type].source.forEach((h, idx) => {
      const [pr, pg, pb] = hex(h);
      const dd = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
      if (dd < bestD) { bestD = dd; best = idx; }
    });
    res = best;
  }
  cache.set(k, res);
  return res;
}

async function refreshFrames(keepEnd = true) {
  const p = S.product;
  if (!p || S.mode !== "live") return;
  if (fcTimeline()) return refreshFcFrames();
  if (satTimeline()) return refreshSatFrames();
  const r = await fetch(`/api/frames/${p.pid}?hours=${S.settings.window}`).then(r => r.json()).catch(() => null);
  if (!r || S.mode !== "live" || satTimeline() || fcTimeline() || r.pid !== S.product.pid) return;
  const atEnd = S.idx >= S.frames.length - 1;
  const old = new Map(S.frames.map(f => [f.url, f]));
  S.frames = r.frames.map(f => old.get(f.url) || { ...f, time: new Date(f.t), data: null, loading: false });
  $("emptyMsg").hidden = S.frames.length > 0;
  $("scrub").max = Math.max(0, S.frames.length - 1);
  if (keepEnd && (atEnd || !S.playing)) S.idx = S.frames.length - 1;
  S.idx = Math.min(Math.max(0, S.idx), S.frames.length - 1);
  preloadFrames();
  showFrame(S.idx);
}

// ---------------------------------------------------------------- background worker
const WK = (() => {
  if (!window.Worker || typeof OffscreenCanvas === "undefined") return null;
  try {
    const V = window.WXV || {};
    const w = new Worker(`/static/worker.js?v=${V["worker.js"] || 1}&a=${V["algo.js"] || 1}`);
    const pending = new Map();
    let id = 0;
    w.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data); };
    w.onerror = () => { for (const p of pending.values()) p.reject(new Error("worker failed")); pending.clear(); };
    const call = (op, msg = {}, transfer = []) => new Promise((resolve, reject) => {
      const n = ++id; pending.set(n, { resolve, reject, t0: performance.now(), op });
      w.postMessage({ ...msg, op, id: n }, transfer);
    });
    const palettes = {};
    for (const [t, P] of Object.entries(PALETTES)) palettes[t] = P.source.map(hex);
    call("init", { palettes });
    return { call, pending };
  } catch { return null; }
})();
// PNG bytes -> palette indices, in the worker when possible
async function decodeBytes(buf, type) {
  const t0 = performance.now();
  let out;
  if (WK) {
    try { out = (await WK.call("decode", { buf, type }, [buf])).data; } catch { out = null; }
  }
  if (!out) {
    const img = await createImageBitmap(new Blob([buf], { type: "image/png" }));
    out = decodeFrame(img, type);
  }
  PERF.note("decode", performance.now() - t0);
  return out;
}
// split a /api/loop bundle into {name: ArrayBuffer}
function parseBundle(buf) {
  const v = new DataView(buf), out = new Map();
  let o = 4;
  const n = v.getUint32(0, true);
  for (let i = 0; i < n; i++) {
    const nl = v.getUint16(o, true); o += 2;
    const name = new TextDecoder().decode(new Uint8Array(buf, o, nl)); o += nl;
    const bl = v.getUint32(o, true); o += 4;
    out.set(name, buf.slice(o, o + bl)); o += bl;
  }
  return out;
}
// fetch and decode several frames of one product in one request (newest first, small first batch)
async function loadFrames(pid, frames, type, onFrame) {
  const need = frames.filter(f => !f.data && !f.loading);
  if (!need.length) return;
  need.forEach(f => (f.loading = true));
  const batches = [need.slice(0, 3)];
  for (let i = 3; i < need.length; i += 40) batches.push(need.slice(i, i + 40));
  try {
    for (const b of batches) {
      if (!b.length) continue;
      const names = b.map(f => f.url.split("/").pop());
      const r = await timedFetch(`/api/loop/${pid}?names=${names.join(",")}`);
      if (!r.ok) throw new Error("bundle failed");
      const parts = parseBundle(await r.arrayBuffer());
      await Promise.all(b.map(async f => {
        const buf = parts.get(f.url.split("/").pop());
        if (!buf) return;
        try { f.data = await decodeBytes(buf, type); onFrame && onFrame(f); } catch { /* skip broken frame */ }
      }));
    }
  } finally { need.forEach(f => (f.loading = false)); }
}
async function preloadFrames() {
  const type = S.product.type || "0";
  const pid = S.product.pid;
  await loadFrames(pid, [...S.frames].reverse(), type, f => {
    if (S.mode !== "live" || S.product.pid !== pid) return;
    if (S.frames[S.idx] === f || cellsOn()) { draw(); renderCellPanel(); }
  });
}

// recoloured frames are cached (small LRU), so redraws while panning/zooming cost a blit, not a recolour
const frameCanvases = new Map();
function renderLiveFrame(frame, type, hideBars = false) {
  const pal = PALETTES[type];
  const tname = S.settings.palette[type];
  const thr = S.settings.threshold[type] || 0;
  const dark = S.settings.mapStyle === "dark";
  const key = `${frame.url}|${type}|${tname}|${thr}|${dark}|${hideBars}`;
  const hit = frameCanvases.get(key);
  if (hit) { frameCanvases.delete(key); frameCanvases.set(key, hit); return hit; }
  const N = frameN(frame.data);
  const c = document.createElement("canvas"); c.width = c.height = N;
  const g = c.getContext("2d"), img = g.createImageData(N, N), out = new Uint32Array(img.data.buffer);
  const table = (pal.tables[tname] || Object.values(pal.tables)[0]).colors.map(hex).map(q => pack(q[0], q[1], q[2]));
  const bar = dark ? pack(21, 35, 43) : pack(192, 192, 192), text = dark ? pack(138, 160, 166) : pack(0, 0, 0);
  const lut = new Uint32Array(256);
  for (let v = 0; v < 256; v++) {
    if (v === C_BAR) lut[v] = hideBars ? 0 : bar;
    else if (v === C_TEXT) lut[v] = hideBars ? 0 : text;
    else if (v !== C_TRANSPARENT && v < table.length) lut[v] = (type === "2" ? Math.abs(v - 9) < thr : v < thr) ? 0 : table[v];
  }
  const src = frame.data;
  for (let p = 0; p < src.length; p++) out[p] = lut[src[p]];
  g.putImageData(img, 0, 0);
  frameCanvases.set(key, c);
  // keep ~64 MB of recoloured frames (a 512 px frame is 1 MB, a national 1024 px frame 4 MB): enough for
  // four panes of a 1-hour loop without recolouring every frame while it plays
  let px = 0;
  for (const v of frameCanvases.values()) px += v.width * v.height;
  while (px > 16e6 && frameCanvases.size > 4) {
    const k0 = frameCanvases.keys().next().value, v0 = frameCanvases.get(k0);
    px -= v0.width * v0.height; frameCanvases.delete(k0);
  }
  return c;
}

function showFrame(i) {
  if (S.mode !== "live") return;
  if (fcTimeline()) return showFcFrame(i);
  if (satTimeline()) {
    if (!S.satFrames.length) return;
    S.satIdx = Math.max(0, Math.min(i, S.satFrames.length - 1));
    $("scrub").value = S.satIdx;
    $("frameCount").textContent = `${S.satIdx + 1} / ${S.satFrames.length}`;
    onTimeChanged();
    return;
  }
  if (!S.frames.length) { $("frameStamp").innerHTML = ""; $("frameCount").textContent = "0 / 0"; draw(); return; }
  S.idx = Math.max(0, Math.min(i, S.frames.length - 1));
  $("scrub").value = S.idx;
  $("frameCount").textContent = `${S.idx + 1} / ${S.frames.length}`;
  onTimeChanged();
}

// secondary panes keep their own frame lists, matched to the main pane's time
const liveStores = new Map();
function liveStore(prod) {
  let st = liveStores.get(prod.pid);
  if (!st) { st = { pid: prod.pid, type: prod.type || "0", frames: [], fetchedAt: 0, loading: false }; liveStores.set(prod.pid, st); }
  st.used = Date.now();
  if (!st.loading && Date.now() - st.fetchedAt > 60e3) {
    st.loading = true;
    fetch(`/api/frames/${prod.pid}?hours=${S.settings.window}`).then(r => r.json()).then(r => {
      const old = new Map(st.frames.map(f => [f.url, f]));
      st.frames = r.frames.map(f => old.get(f.url) || { ...f, time: new Date(f.t), data: null, loading: false });
      st.fetchedAt = Date.now();
      draw();
    }).catch(() => {}).finally(() => { st.loading = false; });
  }
  return st;
}
function decodeStoreFrame(st, f) {
  if (f.loading || f.data) return;
  const pid = f.url.split("/")[2];
  // this frame plus the dozen nearest it in one request (not the whole loop: with a 12-48 h loop and many
  // radars on the seamless map that would be thousands of frames)
  const near = st.frames.filter(x => x !== f && !x.data).sort((a, b) => Math.abs(a.time - f.time) - Math.abs(b.time - f.time)).slice(0, 12);
  loadFrames(pid, [f, ...near], st.type, x => { if (x === f) { draw(); updateReadout(); } }).catch(() => {});
}
// free decoded frames of stores nobody has looked at for 5 minutes, and cap busy stores at 80 frames
setInterval(() => {
  const now = Date.now(), t = currentTime ? currentTime() : null;
  for (const st of liveStores.values()) {
    if (now - (st.used || 0) > 5 * 60e3) { for (const f of st.frames) { f.data = null; f.couplets = null; f.coupletsPending = false; } continue; }
    const held = st.frames.filter(f => f.data);
    if (held.length > 80 && t) held.sort((a, b) => Math.abs(b.time - t) - Math.abs(a.time - t)).slice(0, held.length - 80).forEach(f => { f.data = null; });
  }
}, 60e3);

// ================================================================== raw volume mode
const rawStatus = (msg, cls = "") => { const el = $("volStatus"); el.textContent = msg; el.className = "vol-status " + cls; };
const scanDate = (date, hhmmss) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +hhmmss.slice(0, 2), +hhmmss.slice(2, 4), +hhmmss.slice(4, 6)));

async function enterRaw() {
  const R = S.raw;
  $("volbar").hidden = false;
  $("emptyMsg").hidden = true;
  play(false);
  if (!R.days.length || R.radar !== S.radar.id) {
    R.radar = S.radar.id; R.days = []; R.metas.clear(); R.sweeps.clear(); R.sweep = null;
    rawStatus("Loading archive days…", "busy");
    const r = await fetch(`/api/archive/days?radar=${S.radar.id}`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!r || !r.days.length) { rawStatus("No archive found for this radar", "err"); return; }
    R.days = r.days;
    $("daySel").innerHTML = R.days.map(d => `<option value="${d}">${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}</option>`).join("");
    R.date = R.days[0];
  }
  $("daySel").value = R.date;
  await loadDay(R.date);
}

async function loadDay(date) {
  const R = S.raw;
  R.date = date;
  const tok = ++R.token;
  rawStatus("Reading day index…", "busy");
  const r = await fetch(`/api/archive/scans?radar=${S.radar.id}&date=${date}`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (tok !== R.token) return;
  if (!r) { rawStatus("Could not read that day from the archive", "err"); return; }
  R.scans = r.scans;
  $("scrub").max = Math.max(0, R.scans.length - 1);
  await showScan(R.scans.length - 1);
}

async function getMeta(scan) {
  const R = S.raw, key = `${S.radar.id}/${R.date}/${scan}`;
  if (R.metas.has(key)) return R.metas.get(key);
  const p = fetch(`/api/archive/volume?radar=${S.radar.id}&date=${R.date}&time=${scan}`).then(async r => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    return r.json();
  });
  R.metas.set(key, p);
  p.catch(() => R.metas.delete(key));
  return p;
}

function pickTilt(meta) {
  let best = meta.tilts[0];
  for (const t of meta.tilts) if (Math.abs(t.elev - S.settings.elev) < Math.abs(best.elev - S.settings.elev)) best = t;
  return best;
}
function pickMoment(tilt, want = S.settings.moment) {
  if (momentAvailable(tilt, want)) return want;
  return Object.keys(MOMENTS).find(m => tilt.moments[m]) || Object.keys(tilt.moments)[0];
}

const momentAvailable = (tilt, m) => m === "SRV" ? !!(tilt.moments.VRADDH || tilt.moments.VRADH)
  : MOMENTS[m]?.grid ? !!(tilt.moments.DBZH || tilt.moments.DBZH_CLEAN) : !!tilt.moments[m];
async function getSweep(scan, meta, tilt, moment) {
  if (MOMENTS[moment]?.grid) return getGrid(scan, moment);
  if (moment === "SRV") {
    const base = await getSweep(scan, meta, tilt, tilt.moments.VRADDH ? "VRADDH" : "VRADH");
    return { ...base, moment: "SRV", key: base.key + "|srv" };
  }
  const R = S.raw, mm = tilt.moments[moment];
  const key = `${S.radar.id}/${R.date}/${scan}/${tilt.key}/${mm.key}`;
  if (R.sweeps.has(key)) return R.sweeps.get(key);
  const p = fetch(`/api/archive/sweep?radar=${S.radar.id}&date=${R.date}&time=${scan}&tilt=${tilt.key}&data=${mm.key}`).then(async r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const data = r.headers.get("X-Dtype") === "uint16" ? new Uint16Array(buf) : new Uint8Array(buf);
    return {
      key, data, moment, scan, date: R.date, elev: tilt.elev, nbins: tilt.nbins, nrays: tilt.nrays,
      rscale: tilt.rscale, rstart: tilt.rstart, gain: mm.gain, offset: mm.offset, nodata: mm.nodata,
      undetect: mm.undetect, dtype: mm.dtype, nyquist: tilt.nyquist, time: tilt.time, height: meta.height,
    };
  });
  R.sweeps.set(key, p);
  p.catch(() => R.sweeps.delete(key));
  while (R.sweeps.size > 60) R.sweeps.delete(R.sweeps.keys().next().value);
  return p;
}

function getGrid(scan, moment) {
  const R = S.raw, key = `${S.radar.id}/${R.date}/${scan}/grid/${moment}`;
  if (R.sweeps.has(key)) return R.sweeps.get(key);
  const p = fetch(`/api/archive/derived?radar=${S.radar.id}&date=${R.date}&time=${scan}&product=${moment}`).then(async r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const [h0, hm20, src] = (r.headers.get("X-Freezing") || "").split(",");
    return {
      key, grid: true, moment, scan, date: R.date, data: new Uint8Array(await r.arrayBuffer()),
      size: +r.headers.get("X-Size"), half: +r.headers.get("X-Half-Km"),
      gain: +r.headers.get("X-Gain"), offset: +r.headers.get("X-Offset"), nodata: 0, undetect: 0, dtype: "uint8",
      freezing: h0 ? { h0: +h0, hm20: +hm20, src } : null, elev: 0,
    };
  });
  R.sweeps.set(key, p);
  p.catch(() => R.sweeps.delete(key));
  return p;
}

async function loadScanSweep(i) {
  const R = S.raw, scan = R.scans[i];
  const meta = await getMeta(scan);
  const tilt = pickTilt(meta);
  const moment = pickMoment(tilt);
  const sw = await getSweep(scan, meta, tilt, moment);
  return { meta, tilt, moment, sw };
}

function fillRawSelects(meta, tilt, moment) {
  $("tiltSel").innerHTML = meta.tilts.map(t => `<option value="${t.elev}">${t.elev.toFixed(1)}°</option>`).join("");
  $("tiltSel").value = String(tilt.elev);
  const avail = Object.keys(MOMENTS).filter(m => momentAvailable(tilt, m));
  $("momentSel").innerHTML = avail.map(m => `<option value="${m}">${MOMENTS[m].label}</option>`).join("");
  $("momentSel").value = moment;
  $("refMinWrap").hidden = !MOMENTS[moment]?.ref;
  updateMotionUI();
  fillPaneSelects(tilt);
}

async function showScan(i, { fromPlay = false } = {}) {
  const R = S.raw;
  if (!R.scans.length) return;
  i = Math.max(0, Math.min(i, R.scans.length - 1));
  R.idx = i;
  $("scrub").value = i;
  $("frameCount").textContent = `${i + 1} / ${R.scans.length}`;
  const tok = ++R.token;
  const scan = R.scans[i];
  const cachedMeta = R.metas.has(`${S.radar.id}/${R.date}/${scan}`);
  if (!cachedMeta) rawStatus(`Downloading ${fmtTime.format(scanDate(R.date, scan))} scan from the archive…`, "busy");
  try {
    const { meta, tilt, moment, sw } = await loadScanSweep(i);
    if (tok !== R.token) return;
    fillRawSelects(meta, tilt, moment);
    R.sweep = sw;
    await loadPaneSweeps(scan, meta, tilt, tok);
    if (tok !== R.token) return;
    fillPaneSelects(tilt);
    const fz = [sw, ...activePanes().slice(1).map(p => p.sweep)].find(x => x && x.freezing)?.freezing;
    rawStatus(`${meta.tilts.length} tilts, ${Object.keys(tilt.moments).length} moments${tilt.nyquist ? `, Nyquist ${tilt.nyquist.toFixed(1)} m/s` : ""}`
      + (fz ? `. Freezing level ${fz.h0.toFixed(1)} km, −20 °C at ${fz.hm20.toFixed(1)} km${fz.src === "default" ? " (default)" : ""}` : ""));
    if (S.xs && S.xs.line) loadXsect();
    renderLegend();
    onTimeChanged();
    if (!fromPlay) prefetchRaw(i + 1, 2);
  } catch (e) {
    if (tok === R.token) rawStatus(`Could not load scan: ${e.message}`, "err");
  }
}

async function loadPaneSweeps(scan, meta, tilt, tok) {
  const jobs = activePanes().slice(1).map(async p => {
    const m = pickMoment(tilt, S.settings.paneSrc[p.i].raw);
    try { const sw = await getSweep(scan, meta, tilt, m); if (tok === S.raw.token) p.sweep = sw; } catch { p.sweep = null; }
  });
  await Promise.all(jobs);
}

function prefetchRaw(from, n) {
  const R = S.raw;
  for (let k = 0; k < n; k++) {
    const j = from + k;
    if (j < 0 || j >= R.scans.length) break;
    loadScanSweep(j).then(({ meta, tilt }) => {
      for (const p of activePanes().slice(1)) getSweep(R.scans[j], meta, tilt, pickMoment(tilt, S.settings.paneSrc[p.i].raw)).catch(() => {});
    }).catch(() => {});
  }
}

const lutCache = new Map();
function rawLut(sw) {
  const M = MOMENTS[sw.moment] || { sc: SNR_SCALE };
  const thr = M.ref ? S.settings.refMin : -Infinity;
  const key = `${sw.moment}|${sw.gain}|${sw.offset}|${sw.nodata}|${sw.undetect}|${sw.dtype}|${thr}`;
  let lut = lutCache.get(key);
  if (lut) return lut;
  const n = sw.dtype === "uint16" ? 65536 : 256;
  lut = new Uint32Array(n);
  for (let raw = 0; raw < n; raw++) {
    if (raw === sw.nodata || raw === sw.undetect) continue;
    const v = raw * sw.gain + sw.offset;
    if (v < thr) continue;
    const c = M.sc(v);
    if (c) lut[raw] = pack(c[0], c[1], c[2]);
  }
  lutCache.set(key, lut);
  return lut;
}

function gridCanvas(sw, pane) {
  const key = `${sw.key}|${S.settings.refMin}`;
  if (pane.gridC && pane.gridC.key === key) return pane.gridC.canvas;
  const lut = rawLut(sw);
  const cv = (pane.gridC && pane.gridC.canvas) || document.createElement("canvas");
  cv.width = cv.height = sw.size;
  const g = cv.getContext("2d");
  const img = g.createImageData(sw.size, sw.size);
  const out = new Uint32Array(img.data.buffer);
  for (let i = 0; i < sw.data.length; i++) out[i] = lut[sw.data[i]];
  g.putImageData(img, 0, 0);
  pane.gridC = { key, canvas: cv };
  return cv;
}

// storm-relative velocity: subtract the storm's motion component along each ray
const SRV_MIN = -80, SRV_STEP = 0.1;
let srvLutCache = null;
function srvLut() {
  if (srvLutCache) return srvLutCache;
  const n = Math.round((-SRV_MIN * 2) / SRV_STEP) + 1;
  srvLutCache = new Uint32Array(n);
  for (let i = 0; i < n; i++) { const c = VEL_SCALE(SRV_MIN + i * SRV_STEP); srvLutCache[i] = pack(c[0], c[1], c[2]); }
  return srvLutCache;
}
function motionMs() {
  const m = S.settings.motion;
  return { toRad: (m.dir || 0) * Math.PI / 180, spd: (m.spd || 0) / 3.6 };
}
function rayCorrection(sw) {
  const { toRad, spd } = motionMs();
  const corr = new Float32Array(sw.nrays);
  for (let r = 0; r < sw.nrays; r++) corr[r] = spd * Math.cos(r * 2 * Math.PI / sw.nrays - toRad);
  return corr;
}

function renderPolar(sw, pane, opts = {}) {
  // render at up to ~1.4 MP per pane (less on phones) for speed, then scale up
  const rs = Math.min(1, Math.sqrt((isPhone() ? 0.6e6 : 1.4e6) / (canvas.width * canvas.height)));
  const w = Math.max(1, Math.round(canvas.width * rs)), h = Math.max(1, Math.round(canvas.height * rs));
  const srv = sw.moment === "SRV";
  const mot = srv ? `${S.settings.motion.dir}/${S.settings.motion.spd}` : "";
  const smooth = S.settings.smooth && !MOMENTS[sw.moment]?.cat;
  const base = `${sw.key}|${sw.moment}|${S.settings.refMin}|${mot}|${smooth}`;
  const kNow = 1 / (S.view.scale * rs);
  const cur = pane.polar;
  const fits = q => q && q.base === base && Math.abs(q.k - kNow) / kNow < 0.01
    && S.view.cx - (w / 2) * kNow >= q.x0 && S.view.cx + (w / 2) * kNow <= q.x0 + q.w * q.k
    && S.view.cy + (h / 2) * kNow <= q.y0 && S.view.cy - (h / 2) * kNow >= q.y0 - q.h * q.k;
  if (fits(cur)) return cur;
  // while the view is moving, show the last render (stretched if zooming) and render sharply once it settles
  if (cur && cur.base === base && !opts.now) {
    clearTimeout(pane.polarTimer);
    pane.polarTimer = setTimeout(() => { renderPolar(sw, pane, { now: true }); draw(); }, 140);
    return cur;
  }
  if (!pane.polarCanvas) pane.polarCanvas = document.createElement("canvas");
  // render 25% beyond each edge so panning reuses this image
  const M = S.playing ? 1 : 1.5;                     // no margin while a loop plays: every frame is a new scan
  const W2 = Math.round(w * M), H2 = Math.round(h * M);
  const pc = document.createElement("canvas");
  pc.width = W2; pc.height = H2;
  const pctx = pc.getContext("2d");
  const img = pctx.createImageData(W2, H2);
  const out = new Uint32Array(img.data.buffer);
  const lut = srv ? null : rawLut(sw);
  const slut = srv ? srvLut() : null, corr = srv ? rayCorrection(sw) : null;
  const slen = srv ? slut.length - 1 : 0;
  const k = kNow; // km per output pixel
  const x0 = S.view.cx - (W2 / 2) * k, y0 = S.view.cy + (H2 / 2) * k;
  const cosE = Math.cos(sw.elev * Math.PI / 180);
  const gatesPerKm = 1000 / sw.rscale / cosE;
  const g0 = sw.rstart * 1000 / sw.rscale;
  const raysPerRad = sw.nrays / (2 * Math.PI);
  const nb = sw.nbins, nr = sw.nrays, data = sw.data;
  const nod = sw.nodata, und = sw.undetect, gain = sw.gain, off = sw.offset;
  for (let j = 0; j < H2; j++) {
    const y = y0 - (j + 0.5) * k;
    const row = j * W2;
    for (let i = 0; i < W2; i++) {
      const x = x0 + (i + 0.5) * k;
      const gfl = Math.sqrt(x * x + y * y) * gatesPerKm - g0;
      const g = Math.floor(gfl);
      if (g < 0 || g >= nb) continue;
      let a = Math.atan2(x, y); if (a < 0) a += 2 * Math.PI;
      let r = Math.floor(a * raysPerRad + 0.5); if (r >= nr) r -= nr;
      if (smooth) {   // bilinear between the 4 surrounding gate centres, if all hold data
        const gf = gfl - 0.5, rf = a * raysPerRad;
        const gi = Math.floor(gf), ri = Math.floor(rf);
        if (gi >= 0 && gi + 1 < nb) {
          const ra = ((ri % nr) + nr) % nr, rb = (ra + 1) % nr, fg = gf - gi, fr = rf - ri;
          const q00 = data[ra * nb + gi], q01 = data[ra * nb + gi + 1], q10 = data[rb * nb + gi], q11 = data[rb * nb + gi + 1];
          if (q00 !== nod && q00 !== und && q01 !== nod && q01 !== und && q10 !== nod && q10 !== und && q11 !== nod && q11 !== und) {
            const qv = (q00 * (1 - fg) + q01 * fg) * (1 - fr) + (q10 * (1 - fg) + q11 * fg) * fr;
            if (srv) {
              let idx = Math.round((qv * gain + off - corr[r] - SRV_MIN) / SRV_STEP);
              out[row + i] = slut[idx < 0 ? 0 : idx > slen ? slen : idx];
            } else {
              const c = lut[Math.round(qv)];
              if (c) out[row + i] = c;
            }
            continue;
          }
        }
      }
      const raw = data[r * nb + g];
      if (srv) {
        if (raw === nod || raw === und) continue;
        let idx = Math.round((raw * gain + off - corr[r] - SRV_MIN) / SRV_STEP);
        out[row + i] = slut[idx < 0 ? 0 : idx > slen ? slen : idx];
      } else {
        const c = lut[raw];
        if (c) out[row + i] = c;
      }
    }
  }
  pctx.putImageData(img, 0, 0);
  pane.polar = { base, canvas: pc, w: W2, h: H2, k, x0, y0 };
  return pane.polar;
}

function rawValueAt(sw, x, y) {
  if (sw.grid) {
    const px = Math.floor((x + sw.half) / (2 * sw.half) * sw.size), py = Math.floor((sw.half - y) / (2 * sw.half) * sw.size);
    if (px < 0 || py < 0 || px >= sw.size || py >= sw.size) return { beam: null, raw: null };
    const raw = sw.data[py * sw.size + px];
    return { beam: null, raw, value: raw ? raw * sw.gain + sw.offset : null };
  }
  const d = Math.hypot(x, y);
  const cosE = Math.cos(sw.elev * Math.PI / 180);
  const slant = d / cosE;
  const g = Math.floor((slant * 1000 - sw.rstart * 1000) / sw.rscale);
  let a = Math.atan2(x, y); if (a < 0) a += 2 * Math.PI;
  let r = Math.floor(a * sw.nrays / (2 * Math.PI) + 0.5) % sw.nrays;
  const sinE = Math.sin(sw.elev * Math.PI / 180);
  const beam = Math.sqrt(slant * slant + RE43 * RE43 + 2 * slant * RE43 * sinE) - RE43 + (sw.height || 0) / 1000;
  if (g < 0 || g >= sw.nbins) return { beam, raw: null };
  const raw = sw.data[r * sw.nbins + g];
  if (raw === sw.nodata || raw === sw.undetect) return { beam, raw, value: null };
  let value = raw * sw.gain + sw.offset;
  if (sw.moment === "SRV") { const { toRad, spd } = motionMs(); value -= spd * Math.cos(r * 2 * Math.PI / sw.nrays - toRad); }
  return { beam, raw, value };
}

// ================================================================== overlays: satellite
function currentTime() {
  if (S.mode === "raw") return S.raw.sweep ? scanDate(S.raw.date, S.raw.sweep.scan) : null;
  if (fcTimeline()) return S.fc.data ? new Date(S.fc.data.time[S.fc.idx] * 1000) : null;
  if (satTimeline()) return S.satFrames[S.satIdx]?.time || null;
  const f = S.frames[S.idx];
  return f ? f.time : null;
}
// for "now"-ish frames use real now so newest strikes count
function overlayEnd() {
  const t = currentTime();
  if (!t) return null;
  if (fcTimeline()) return t;
  if (satTimeline()) return S.satIdx === S.satFrames.length - 1 ? new Date(Math.max(Date.now(), +t)) : new Date(+t + 600e3);
  if (S.mode === "live" && S.idx === S.frames.length - 1) return new Date(Math.max(Date.now(), +t));
  return t;
}

// ---- satellite channels: "hsd" = raw Himawari brightness temperature coloured here, "png" = server images
// stops ascending (coldest first), deg C
const IR_ENH = scale([[-90, "#ffffff"], [-80, "#b02fd0"], [-75, "#d81f2a"], [-70, "#f07b17"], [-60, "#f2e23a"], [-50, "#38c95a"],
  [-40, "#2f6fd0"], [-30, "#62b6ea"], [-20, "#c8c8c8"], [0, "#787878"], [20, "#3a3a3a"], [40, "#141414"]]);
const IR_GREY = scale([[-80, "#ffffff"], [45, "#000000"]]);
const WV_PAL = scale([[-70, "#16246a"], [-58, "#2f5fb0"], [-48, "#7fb0e0"], [-40, "#e8e8e8"], [-32, "#d8d0c0"], [-25, "#b08850"], [-15, "#6e4418"], [-5, "#2a1808"]]);
const SAT_DEFS = {
  geocolor: { kind: "png", name: "Himawari true colour" },
  ir13e: { kind: "hsd", band: "ir13", pal: IR_ENH, name: "Himawari infrared", what: "Cloud-top or surface" },
  ir13g: { kind: "hsd", band: "ir13", pal: IR_GREY, name: "Himawari infrared", what: "Cloud-top or surface" },
  wv08: { kind: "hsd", band: "wv08", pal: WV_PAL, name: "Himawari water vapour", what: "Upper water vapour" },
  nmp: { kind: "png", name: "Himawari night microphysics" },
  dust: { kind: "png", name: "Himawari dust" },
  dcp: { kind: "png", name: "Himawari day cloud phase" },
  vis: { kind: "png", name: "Himawari visible (NASA)" },
  airmass: { kind: "png", name: "Himawari air mass (NASA)" },
};
const satDef = () => SAT_DEFS[S.settings.satLayer] || SAT_DEFS.geocolor;
const tbC = v => 170 + 0.6 * v - 273.15;
function colourTb(data, size, pal) {
  const lut = new Uint32Array(256);
  for (let v = 1; v < 256; v++) { const c = pal(tbC(v)); lut[v] = pack(c[0], c[1], c[2]); }
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const g = cv.getContext("2d");
  const img = g.createImageData(size, size);
  const out = new Uint32Array(img.data.buffer);
  for (let i = 0; i < data.length; i++) out[i] = lut[data[i]];
  g.putImageData(img, 0, 0);
  return cv;
}
// brightness temperature (deg C) under a km point, if the current satellite image carries it
function satTbAt(x, y) {
  const e = S.sat.current;
  if (!e || !e.tb || S.settings.view === "radar") return null;
  const px = Math.floor((x + e.half) / (2 * e.half) * e.size), py = Math.floor((e.half - y) / (2 * e.half) * e.size);
  if (px < 0 || py < 0 || px >= e.size || py >= e.size) return null;
  const v = e.tb[py * e.size + px];
  return v ? tbC(v) : null;
}
function satReadout(x, y) {
  const t = satTbAt(x, y);
  if (t == null) return "";
  const def = satDef();
  const c = def.pal(t);
  return `<span class="swatch" style="background:rgb(${c.join(",")})"></span>${t.toFixed(1)} °C <small>${def.what}</small>`;
}

function satHalf() {
  if (S.settings.view === "radar" || S.view.scale == null) return 512;
  const halfMax = Math.max(canvas.width, canvas.height) / 2 / S.view.scale;
  const reach = Math.max(Math.abs(S.view.cx) + canvas.width / 2 / S.view.scale, Math.abs(S.view.cy) + canvas.height / 2 / S.view.scale);
  const need = Math.max(halfMax, reach * 0.98);
  return need > 1400 ? 2600 : need > 470 ? 1536 : 512;
}

// fetch (or reuse) the satellite image for the 10-min slot at/before t
function fetchSat(t, layer, half) {
  const slot = new Date(Math.floor(+t / 600e3) * 600e3);
  const key = `${S.radar.id}|${layer}|${half}|${slot.toISOString()}`;
  const c = S.sat.cache;
  let entry = c.get(key);
  if (entry && entry.failed && Date.now() - entry.failed > 30e3) { c.delete(key); entry = null; }
  if (entry) return entry;
  entry = { key, loading: true };
  const def = SAT_DEFS[layer] || SAT_DEFS.geocolor;
  const url = def.kind === "hsd"
    ? `/api/hsd/${def.band}?radar=${S.radar.id}&half=${half}&t=${slot.toISOString()}`
    : `/api/sat/${layer}?radar=${S.radar.id}&half=${half}&t=${slot.toISOString()}`;
  entry.promise = fetch(url).then(async r => {
    if (!r.ok) throw new Error(r.status);
    entry.time = new Date(r.headers.get("X-Sat-Time"));
    entry.half = +(r.headers.get("X-Sat-Half-Km") || half);
    if (def.kind === "hsd") {
      entry.size = +r.headers.get("X-Size");
      entry.tb = new Uint8Array(await r.arrayBuffer());
      entry.bmp = colourTb(entry.tb, entry.size, def.pal);
    } else {
      entry.bmp = await createImageBitmap(await r.blob());
    }
    entry.loading = false;
    entry.bytes = (entry.bmp ? entry.bmp.width * entry.bmp.height * 4 : 0) + (entry.tb ? entry.tb.length : 0);
    trimSatCache();
    return entry;
  }).catch(() => { entry.loading = false; entry.failed = Date.now(); return entry; });
  c.set(key, entry);
  return entry;
}
// decoded satellite frames are big (a national one is ~7 MB): keep the cache to a memory budget, not a count
function trimSatCache() {
  const c = S.sat.cache, budget = (isPhone() ? 120 : 400) * 1048576;
  let total = 0;
  for (const e of c.values()) total += e.bytes || 0;
  for (const [k, e] of c) {
    if (total <= budget && c.size <= 300) break;
    if (e === S.sat.current || e.loading) continue;
    total -= e.bytes || 0;
    try { e.bmp && e.bmp.close && e.bmp.close(); } catch { /* canvas */ }
    c.delete(k);
  }
}

function ensureSat() {
  // only the Satellite and Both views show it (the forecast view's timeline is in the future)
  if ((S.settings.view !== "sat" && S.settings.view !== "both") || !S.radar) { S.sat.current = null; return; }
  const t = currentTime();
  if (!t || +t > Date.now() + 5 * 60e3) return;
  const layer = S.settings.satLayer, half = satHalf();
  const entry = fetchSat(t, layer, half);
  if (entry.bmp) { S.sat.current = entry; return; }
  entry.promise.then(e => {
    const now = currentTime();
    if (e.bmp && now && fetchSat(now, S.settings.satLayer, satHalf()) === e) { S.sat.current = e; draw(); updateStamp(); }
  });
  if (half > 512) ensureCoast(half);
}

function ensureCoast(half = 1536) {
  if (S.coast && S.coast.radar === S.radar.id && S.coast.half === half) return;
  S.coast = { radar: S.radar.id, img: null, half };
  const c = S.coast;
  loadImage(`/api/satcoast?radar=${S.radar.id}&half=${half}`).then(img => {
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
    const id = g.getImageData(0, 0, cv.width, cv.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 20) { d[i] = 214; d[i + 1] = 226; d[i + 2] = 228; d[i + 3] = 200; } else d[i + 3] = 0;
    }
    g.putImageData(id, 0, 0);
    c.img = cv; draw();
  }).catch(() => { S.coast = null; });
}

// Satellite-only view has its own 10-minute timeline
async function refreshSatFrames() {
  if (!satTimeline() || !S.radar) return;
  const layer = S.settings.satLayer, half = satHalf();
  const latest = fetchSat(new Date(), layer, half);
  await latest.promise;
  if (!satTimeline()) return;
  if (!latest.time) {
    $("frameStamp").innerHTML = "<span>Satellite not available yet, retrying…</span>";
    setTimeout(refreshSatFrames, 30e3);
    return;
  }
  const n = Math.min(72, Math.max(3, Math.round(S.settings.window * 6)));
  const atEnd = S.satIdx >= S.satFrames.length - 1;
  S.satFrames = Array.from({ length: n }, (_, i) => ({ time: new Date(+latest.time - (n - 1 - i) * 600e3) }));
  $("emptyMsg").hidden = true;
  $("scrub").max = S.satFrames.length - 1;
  if (atEnd || !S.playing) S.satIdx = S.satFrames.length - 1;
  showFrame(S.satIdx);
  for (const f of [...S.satFrames].reverse()) {  // warm the cache for smooth looping
    if (!satTimeline() || S.settings.satLayer !== layer) break;
    await fetchSat(f.time, layer, half).promise;
  }
}

// ================================================================== overlays: lightning
async function ensureLightning() {
  const L = S.ltg;
  if (!S.settings.lightning || !S.radar || S.radar.lat == null) return;
  const end = overlayEnd();
  if (!end) return;
  const win = S.settings.ltgWindow * 60e3;
  const need0 = +end - win, need1 = +end;
  if (need0 > Date.now()) return;                 // forecast frames: no lightning in the future
  const live = Date.now() - need1 < 15 * 60e3;
  const stale = live && Date.now() - L.fetchedAt > 60e3;
  if (L.radar === S.radar.id && need0 >= L.a && need1 <= L.b && !stale) return;
  if (L.loading) return;
  L.loading = true;
  const a = need0 - 3 * 3600e3, b = Math.min(Date.now(), need1 + 3600e3);
  try {
    const r = await timedFetch(`/api/lightning?radar=${S.radar.id}&radius=${isNational() ? 2900 : 600}&fmt=bin&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`)
      .then(r => (r.ok ? r.arrayBuffer() : null)).then(buf => {
        if (!buf) return null;
        const v = new DataView(buf), hl = v.getUint32(0, true);
        const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
        let o = 4 + hl; o += (4 - (o % 4)) % 4;
        const n = hdr.n, secs = new Uint32Array(buf, o, n), la = new Float32Array(buf, o + 4 * n, n), lo = new Float32Array(buf, o + 8 * n, n);
        const strikes = new Array(n);
        for (let i = 0; i < n; i++) strikes[i] = [hdr.t0 + secs[i] * 1000, la[i], lo[i]];
        return { strikes, status: hdr.status };
      });
    if (r) { Object.assign(L, { a, b: Math.max(b, live ? Date.now() : b), strikes: r.strikes, status: r.status, fetchedAt: Date.now(), radar: S.radar.id }); checkLightningAlert(); }
  } catch { /* keep old */ }
  L.loading = false;
  draw(); updateLightningSummary();
}

function visibleStrikes() {
  const end = overlayEnd();
  if (!end || !S.settings.lightning) return [];
  const t1 = +end, t0 = t1 - S.settings.ltgWindow * 60e3;
  return S.ltg.strikes.filter(s => s[0] > t0 && s[0] <= t1);
}

function drawLightning() {
  if (!S.settings.lightning || !S.radar || S.settings.view === "fc") return;
  const end = +(overlayEnd() || 0), win = S.settings.ltgWindow * 60e3;
  const d = dpr(), size = 5 * d;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.settings.ltgDensity) {          // additive glow: brighter where strikes cluster
    const r = Math.max(10 * d, 8 * S.view.scale);
    ctx.globalCompositeOperation = "lighter";
    for (const [, lat, lon] of visibleStrikes()) {
      const [sx, sy] = kmToScreen(...latLonToKm(lat, lon));
      const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      gr.addColorStop(0, "rgba(255,120,40,.35)"); gr.addColorStop(1, "rgba(255,120,40,0)");
      ctx.fillStyle = gr; ctx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.lineWidth = 1.6 * d;
  for (const [t, lat, lon] of visibleStrikes()) {
    const [x, y] = latLonToKm(lat, lon);
    const [sx, sy] = kmToScreen(x, y);
    if (sx < -10 || sy < -10 || sx > canvas.width + 10 || sy > canvas.height + 10) continue;
    const age = (end - t) / win;
    ctx.strokeStyle = age < 0.1 ? "#ffffff" : age < 0.33 ? "#ffe14a" : age < 0.66 ? "#ff9a2e" : "#e0412f";
    ctx.beginPath();
    ctx.moveTo(sx - size, sy); ctx.lineTo(sx + size, sy);
    ctx.moveTo(sx, sy - size); ctx.lineTo(sx, sy + size);
    ctx.stroke();
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  const y = Math.sin(dLon) * Math.cos(lat2 * toR);
  const x = Math.cos(lat1 * toR) * Math.sin(lat2 * toR) - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos(dLon);
  return { dist: 2 * R * Math.asin(Math.sqrt(a)), brg: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
}

function updateLightningSummary() {
  const el = $("ltgSummary");
  if (!S.settings.lightning || !S.cfg) { el.innerHTML = ""; return; }
  const st = S.ltg.status;
  if (st && !st.connected && st.error) { el.innerHTML = `Lightning feed offline (${st.error}). Retrying.`; return; }
  const home = S.cfg.home;
  const near = visibleStrikes().map(s => haversine(home.lat, home.lon, s[1], s[2])).filter(h => h.dist <= 100);
  const w = S.settings.ltgWindow;
  let html;
  if (!near.length) html = `No lightning within 100 km of ${esc(home.name)} in the last ${w} min.`;
  else {
    const n = near.reduce((a, b) => (b.dist < a.dist ? b : a));
    html = `<b class="${n.dist < 20 ? "hot" : ""}">${near.length} strike${near.length > 1 ? "s" : ""}</b> within 100 km of ${esc(home.name)} in the last ${w} min. Nearest <b class="${n.dist < 20 ? "hot" : ""}">${n.dist.toFixed(0)} km ${compass(n.brg)}</b>.`;
  }
  // most recent strike within 50 km of home, from everything loaded (up to 3 h back)
  const end = +(overlayEnd() || Date.now());
  let last = null;
  for (const s of S.ltg.strikes) {
    if (s[0] > end) continue;
    const h = haversine(home.lat, home.lon, s[1], s[2]);
    if (h.dist <= 50 && (!last || s[0] > last.t)) last = { t: s[0], ...h };
  }
  if (last) {
    const mins = Math.round((end - last.t) / 60e3);
    html += ` Last strike within 50 km: <b>${mins < 1 ? "just now" : `${mins} min ago`}</b>, ${last.dist.toFixed(0)} km ${compass(last.brg)}.`;
  }
  el.innerHTML = html + lightningSparkline();
}

// optional beep when a new strike lands within the alert radius of home (live only)
let ltgAudio = null, ltgAlertSeen = Date.now();
function checkLightningAlert() {
  const r = S.settings.ltgAlertKm;
  if (!r || !S.settings.lightning || !S.cfg || S.mode !== "live") return;
  const home = S.cfg.home;
  const fresh = S.ltg.strikes.filter(s => s[0] > ltgAlertSeen && haversine(home.lat, home.lon, s[1], s[2]).dist <= r);
  if (S.ltg.strikes.length) ltgAlertSeen = Math.max(ltgAlertSeen, ...S.ltg.strikes.map(s => s[0]));
  if (!fresh.length) return;
  try {
    ltgAudio = ltgAudio || new (window.AudioContext || window.webkitAudioContext)();
    const o = ltgAudio.createOscillator(), g = ltgAudio.createGain();
    o.type = "square"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ltgAudio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ltgAudio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ltgAudio.currentTime + 0.35);
    o.connect(g).connect(ltgAudio.destination); o.start(); o.stop(ltgAudio.currentTime + 0.4);
  } catch { /* audio blocked until the page has been clicked once */ }
  $("scopeFrame").classList.add("flash");
  setTimeout(() => $("scopeFrame").classList.remove("flash"), 600);
}

// ================================================================== drawing
function draw() {
  const t0 = performance.now();
  drawInner();
  PERF.note("draw", performance.now() - t0);
}
function drawInner() {
  if (!S.radar || S.view.scale == null) return;
  for (const p of activePanes()) { usePane(p); drawPane(p); }
  usePane(PANES[0]);
}

// what radar layer a pane shows: pane 0 follows the tabs / product menu, others their own picker
function paneLive(p) {
  if (p.i === 0) return S.product ? { frame: S.frames[S.idx], prod: S.product } : null;
  const src = S.settings.paneSrc[p.i];
  const prod = S.radar.products.find(x => x.suffix === src.live && x.available);
  if (!prod) return null;
  const st = liveStore(prod);
  const t = currentTime();
  if (!t || !st.frames.length) return { frame: null, prod };
  let best = null;
  for (const f of st.frames) if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
  if (best && Math.abs(best.time - t) > 6 * 60e3) best = null;
  if (best && !best.data) decodeStoreFrame(st, best);
  return { frame: best, prod };
}

function drawPane(p) {
  const dark = S.settings.mapStyle === "dark";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = dark ? "#0a1216" : "#c3d9eb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = S.settings.smooth;

  const { fine: L, fills, labels } = currentLayerSets();
  for (const F of fills) drawCentered(F.built.base, 512, F.km);
  if (L) drawCentered(L.built.base, 512, L.km);
  if (isNational()) drawNationalBase();

  const view = S.settings.view;
  const sat = S.sat.current;
  if (sat && sat.bmp && (view === "sat" || view === "both")) {
    ctx.globalAlpha = view === "sat" ? 1 : S.settings.satOpacity / 100;
    ctx.imageSmoothingEnabled = true;
    drawCentered(sat.bmp, sat.bmp.width, sat.half);
    if (sat.half > 512 && S.coast && S.coast.img && S.coast.half === sat.half) { ctx.globalAlpha = 0.8; drawCentered(S.coast.img, S.coast.img.width, sat.half); }
    ctx.imageSmoothingEnabled = S.settings.smooth;
    ctx.globalAlpha = 1;
  }

  if (view === "fc") drawForecast(p);
  ctx.globalAlpha = S.settings.opacity / 100;
  if (view === "sat" || view === "fc") { /* radar hidden */ }
  else if (S.mode === "live") {
    drawMosaic(p);
    const lv = paneLive(p);
    const gpuSeam = seamlessTakesOver(p);            // the GPU draws the mosaic and the radars together
    if (lv && lv.frame && lv.frame.data && !gpuSeam) {
      // BoM's in-image caption and copyright bar repeat what the frame stamp shows and sit across the map:
      // always hide them (the source is credited in the footer and the data notes)
      drawCentered(renderLiveFrame(lv.frame, lv.prod.type || "0", true), frameN(lv.frame.data), lv.prod.km);
    }
    drawSeamless(p, gpuSeam ? lv : null);
  } else {
    const sw = p.i === 0 ? S.raw.sweep : p.sweep;
    if (sw && sw.grid) {
      drawCentered(gridCanvas(sw, p), sw.size, sw.half);
    } else if (sw) {
      const tg = performance.now();
      const g = S.settings.gpu !== false && !GL.slow ? GL.renderSweep(sw, canvas.width, canvas.height) : null;
      if (g) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(g, 0, 0); GL.timed(performance.now() - tg); }
      else {
        const pr = renderPolar(sw, p);
        ctx.imageSmoothingEnabled = true;
        drawKmImage(pr.canvas, pr.x0, pr.y0, pr.k);
        ctx.imageSmoothingEnabled = S.settings.smooth;
      }
    }
  }
  ctx.globalAlpha = 1;
  drawContours();
  drawEnvOverlay();

  // BoM's bitmap rings and town labels turn into big blocks when magnified: swap to sharp vector versions
  const magnified = L && (2 * L.km / 512) * S.view.scale > 1.35 * dpr();      // BoM bitmaps go blurry/blocky past ~1.35x
  if (L && labels && L.built.range && S.settings.range && !magnified) drawCentered(L.built.range, 512, L.km);
  if (magnified && S.settings.range) drawVectorRings();
  if (L && labels && L.built.loc && S.settings.loc && S.settings.townLabels !== "sharp" && !magnified) drawCentered(L.built.loc, 512, L.km);
  S.autoSharp = !!magnified;
  if (isNational()) drawNationalLines();
  drawBorders();
  drawRoads();
  if (S.settings.loc) drawTowns();
  drawStations();
  drawFires();
  drawReports();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawWxWarnings();
  if (cellsOn()) drawCells();
  drawRotation();
  drawLightning();
  drawHome();
  drawMe();
  drawMotionArrow(p);
  drawTools();
}

function drawHome() {
  if (!S.settings.home || !S.cfg || !S.radar || S.radar.lat == null) return;
  const h = S.cfg.home;
  const [sx, sy] = kmToScreen(...latLonToKm(h.lat, h.lon));
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = "#79d3e6"; ctx.lineWidth = 2 * d;
  ctx.beginPath(); ctx.arc(sx, sy, 7 * d, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 12 * d, sy); ctx.lineTo(sx - 4 * d, sy); ctx.moveTo(sx + 4 * d, sy); ctx.lineTo(sx + 12 * d, sy);
  ctx.moveTo(sx, sy - 12 * d); ctx.lineTo(sx, sy - 4 * d); ctx.moveTo(sx, sy + 4 * d); ctx.lineTo(sx, sy + 12 * d);
  ctx.stroke();
}

function drawTools() {
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // synced cursor in the panes you're not hovering
  if (S.hover && S.hoverPane != null && S.hoverPane !== PANES.indexOf(PANES.find(p => p.canvas === canvas)) && S.settings.layout > 1) {
    const [sx, sy] = kmToScreen(...S.hover);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.2 * d;
    ctx.beginPath(); ctx.moveTo(sx - 9 * d, sy); ctx.lineTo(sx + 9 * d, sy); ctx.moveTo(sx, sy - 9 * d); ctx.lineTo(sx, sy + 9 * d); ctx.stroke();
  }
  if (S.pin) {
    const [sx, sy] = kmToScreen(...S.pin);
    ctx.fillStyle = "#f2a93b"; ctx.strokeStyle = "#0f1a20"; ctx.lineWidth = 1.5 * d;
    ctx.beginPath(); ctx.moveTo(sx, sy - 8 * d); ctx.lineTo(sx + 6 * d, sy); ctx.lineTo(sx, sy + 8 * d); ctx.lineTo(sx - 6 * d, sy); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  const R = S.rulerLine;
  if (R && (R.a[0] !== R.b[0] || R.a[1] !== R.b[1])) {
    const [ax, ay] = kmToScreen(...R.a), [bx, by] = kmToScreen(...R.b);
    ctx.strokeStyle = "#f2a93b"; ctx.lineWidth = 2 * d; ctx.setLineDash([6 * d, 4 * d]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    for (const [px, py] of [[ax, ay], [bx, by]]) { ctx.beginPath(); ctx.arc(px, py, 4 * d, 0, Math.PI * 2); ctx.fillStyle = "#f2a93b"; ctx.fill(); }
    const dx = R.b[0] - R.a[0], dy = R.b[1] - R.a[1];
    const dist = Math.hypot(dx, dy), brg = bearingOf(dx, dy);
    let label = `${dist.toFixed(1)} km  ${Math.round(brg)}° ${compass(brg)}`;
    const m = S.settings.motion;
    if (m.spd > 0) label += `  ${Math.round(dist / m.spd * 60)} min at ${m.spd} km/h`;
    ctx.font = `${13 * d}px "Barlow Semi Condensed", sans-serif`;
    const tw = ctx.measureText(label).width;
    const lx = (ax + bx) / 2 + 10 * d, ly = (ay + by) / 2 - 10 * d;
    ctx.fillStyle = "rgba(15,26,32,.9)"; ctx.fillRect(lx - 5 * d, ly - 15 * d, tw + 10 * d, 21 * d);
    ctx.fillStyle = "#f2d6a0"; ctx.fillText(label, lx, ly);
  }
  const X = S.xs.draft || (S.mode === "raw" ? S.xs.line : null);
  if (X) {
    const [ax, ay] = kmToScreen(...X.a), [bx, by] = kmToScreen(...X.b);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5 * d;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.font = `bold ${13 * d}px "Barlow Semi Condensed", sans-serif`;
    for (const [txt, px, py] of [["A", ax, ay], ["B", bx, by]]) {
      ctx.fillStyle = "#0f1a20"; ctx.beginPath(); ctx.arc(px, py, 9 * d, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.fillText(txt, px, py + 4.5 * d); ctx.textAlign = "start";
    }
  }
}

function srvActive() {
  if (S.mode !== "raw") return false;
  return activePanes().some(p => (p.i === 0 ? S.raw.sweep : p.sweep)?.moment === "SRV");
}
function drawMotionArrow(p) {
  if (S.mode !== "raw" || S.settings.view === "sat" || (p.i === 0 ? S.raw.sweep : p.sweep)?.moment !== "SRV") return;
  const d = dpr(), m = S.settings.motion;
  const cx = canvas.width - 46 * d, cy = canvas.height - 46 * d, r = 26 * d;
  const a = (m.dir || 0) * Math.PI / 180;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(15,26,32,.85)"; ctx.beginPath(); ctx.arc(cx, cy, r + 8 * d, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#d6e2e4"; ctx.fillStyle = "#d6e2e4"; ctx.lineWidth = 2.5 * d;
  const tx = cx + Math.sin(a) * r, ty = cy - Math.cos(a) * r, bx = cx - Math.sin(a) * r * 0.8, by = cy + Math.cos(a) * r * 0.8;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(tx, ty);
  ctx.lineTo(tx - Math.sin(a - 0.5) * 10 * d, ty + Math.cos(a - 0.5) * 10 * d);
  ctx.lineTo(tx - Math.sin(a + 0.5) * 10 * d, ty + Math.cos(a + 0.5) * 10 * d); ctx.closePath(); ctx.fill();
  ctx.font = `${11 * d}px "Barlow Semi Condensed", sans-serif`; ctx.textAlign = "center";
  ctx.fillText(`${m.spd} km/h`, cx, cy + r + 4 * d);
  ctx.textAlign = "start";
}

function updateMotionUI() {
  const want = S.mode === "raw" && (S.settings.moment === "SRV" || activePanes().slice(1).some(p => S.settings.paneSrc[p.i].raw === "SRV"));
  $("motionWrap").hidden = !want;
}

function updateStamp() {
  const t = currentTime();
  if (!t) { $("frameStamp").innerHTML = ""; return; }
  const ageMin = Math.round((Date.now() - t) / 60000);
  let ageTxt = ageMin < 120 ? `${ageMin} min ago` : ageMin < 2880 ? `${Math.round(ageMin / 60)} h ago` : `${Math.round(ageMin / 1440)} days ago`;
  if (ageMin < 0) ageTxt = -ageMin < 90 ? `in ${-ageMin} min` : `in ${Math.round(-ageMin / 60)} h`;
  const stale = S.mode === "live" && !satTimeline() && !fcTimeline() && S.idx === S.frames.length - 1 && ageMin > 15;
  let extra = "";
  if (S.mode === "raw" && S.raw.sweep) {
    const sw = S.raw.sweep, lab = MOMENTS[sw.moment]?.label || sw.moment;
    extra = `<span>${sw.grid ? lab : `${sw.elev.toFixed(1)}° ${lab}`}</span>`;
  }
  const sat = S.sat.current;
  if (fcTimeline()) {
    const L = FC_LAYERS[S.settings.fcLayer];
    extra += `<span>${L.name}${L.kind === "level" ? ` ${S.settings.fcLevel} hPa` : ""} forecast</span>`;
  }
  else if (satTimeline()) extra += `<span>${satDef().name}</span>`;
  else if (sat && S.settings.view !== "radar") extra += `<span>sat ${fmtTime.format(sat.time)}</span>`;
  $("frameStamp").innerHTML = `<b>${fmtTime.format(t)}</b><span>${fmtDate.format(t)}</span><span class="${stale ? "stale" : ""}">${ageTxt}</span>${extra}`;
}

function onTimeChanged() {
  ensureObsMap();
  ensureTowns();
  ensureRoads();
  ensureFires();
  ensureRotation();
  ensureSat();
  ensureLightning();
  draw();
  updateStamp();
  updateReadout();
  updateLightningSummary();
  renderCellPanel();
  renderRotPanel();
}

// ================================================================== playback
function play(on) {
  S.playing = on;
  $("playBtn").textContent = on ? "❚❚" : "▶";
  clearTimeout(S.timer);
  if (on && S.mode === "raw") {
    const n = Math.min(72, Math.max(2, Math.round(S.settings.window * 12)));
    S.raw.anchor = S.raw.idx;
    S.raw.loopStart = Math.max(0, S.raw.idx - n + 1);
  }
  if (on) tick();
}
async function tick() {
  if (!S.playing) return;
  if (S.mode === "live") {
    const len = fcTimeline() ? (S.fc.data?.time.length || 0) : satTimeline() ? S.satFrames.length : S.frames.length;
    const cur = fcTimeline() ? S.fc.idx : satTimeline() ? S.satIdx : S.idx;
    if (!len) return;
    const next = cur >= len - 1 ? 0 : cur + 1;
    showFrame(next);
    S.timer = setTimeout(tick, S.settings.speed * (next === len - 1 ? 4 : 1));
    return;
  }
  const R = S.raw;
  const next = R.idx >= R.anchor ? R.loopStart : R.idx + 1;
  const started = Date.now();
  prefetchRaw(next + 1, 3);
  await showScan(next, { fromPlay: true });
  if (!S.playing || S.mode !== "raw") return;
  const wait = S.settings.speed * (next === R.anchor ? 4 : 1) - (Date.now() - started);
  S.timer = setTimeout(tick, Math.max(0, wait));
}
function step(d) {
  play(false);
  if (S.mode === "live") showFrame((fcTimeline() ? S.fc.idx : satTimeline() ? S.satIdx : S.idx) + d); else showScan(S.raw.idx + d);
}

// ================================================================== readout & legend
function bearingOf(dx, dy) { return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; }

function paneName(p) {
  if (S.mode === "raw") {
    const sw = p.i === 0 ? S.raw.sweep : p.sweep;
    return sw ? (MOMENTS[sw.moment]?.label || sw.moment) : "–";
  }
  const lv = p.i === 0 ? (S.product ? { prod: S.product } : null) : paneLive(p);
  return lv ? lv.prod.label : "–";
}

// value under a km point for one pane: { html, color, beam }
function paneValue(p, x, y) {
  if (S.settings.view === "sat") return { html: satReadout(x, y) || "<small>No satellite value here</small>" };
  if (S.settings.view === "fc") return fcPaneValue(p, x, y);
  if (S.mode === "raw") {
    const sw = p.i === 0 ? S.raw.sweep : p.sweep;
    if (!sw) return { html: "<small>No scan loaded</small>" };
    const r = rawValueAt(sw, x, y);
    if (r.raw == null) return { html: "<small>Outside the scan</small>", beam: r.beam };
    if (r.value == null) return { html: "<small>No echo</small>", beam: r.beam };
    const M = MOMENTS[sw.moment] || { unit: "", dp: 2, sc: SNR_SCALE };
    const c = M.sc(r.value) || [60, 66, 70];
    let sub = M.unit;
    if (M.vel) {
      sub = `m/s (${Math.abs(r.value * 3.6).toFixed(0)} km/h, ${Math.abs(r.value * 1.944).toFixed(0)} kt) ${r.value < 0 ? "inbound" : r.value > 0 ? "outbound" : ""}`;
      const vp = vrotProbe(sw, x, y);
      if (vp) sub += `<br>Vrot within 2.5 km: <b>${Math.round(vp.vrot * 1.944)} kt</b> (in ${Math.round(-vp.vin * 1.944)}, out ${Math.round(vp.vout * 1.944)} kt, ${vp.span.toFixed(1)} km apart)`;
    }
    if (M.note) sub += ` ${M.note(r.value)}`;
    if (M.cat) { const cls = HCA_CLASSES[Math.round(r.value)]; return { html: cls ? cls[0] : "–", color: cls ? cls[1] : null, beam: r.beam }; }
    return { html: `${r.value.toFixed(M.dp)} <small>${sub}</small>`, color: `rgb(${c.join(",")})`, beam: r.beam };
  }
  const seam = p.i === 0 ? seamlessValueAt(x, y) : null;
  if (seam) {          // national view zoomed in: read the nearest radar's own data
    if (seam.v >= 250) return { html: `<small>No echo (${esc(seam.name)})</small>` };
    const pal = PALETTES["0"], table = (pal.tables[S.settings.palette["0"]] || Object.values(pal.tables)[0]).colors, d = pal.describe(seam.v);
    return { html: `${d.main} <small>${d.sub}, ${esc(seam.name)} ${seam.d.toFixed(0)} km</small>`, color: table[seam.v] };
  }
  const lv = paneLive(p);
  if (!lv || !lv.frame || !lv.frame.data) return { html: "<small>No frame at this time</small>" };
  const N = frameN(lv.frame.data), kpp = lv.prod.km / (N / 2);
  const px = Math.floor(N / 2 + x / kpp), py = Math.floor(N / 2 - y / kpp);
  if (px < 0 || py < 0 || px >= N || py >= N) return { html: "<small>Outside the scan</small>" };
  const v = lv.frame.data[py * N + px];
  if (v >= 250) return { html: "<small>No echo</small>" };
  const type = lv.prod.type || "0";
  const pal = PALETTES[type];
  const table = (pal.tables[S.settings.palette[type]] || Object.values(pal.tables)[0]).colors;
  const d = pal.describe(v);
  return { html: `${d.main} <small>${d.sub}</small>`, color: table[v] };
}

function placeText(x, y) {
  const dist = Math.hypot(x, y);
  const [lat, lon] = kmToLatLon(x, y);
  const home = S.cfg.home;
  const hh = haversine(home.lat, home.lon, lat, lon);
  return {
    radar: `${dist.toFixed(1)} km ${compass(bearingOf(x, y))} (${Math.round(bearingOf(x, y))}°)`,
    home: `${hh.dist.toFixed(1)} km ${compass(hh.brg)} of ${esc(home.name)}`,
    pos: `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
  };
}
const beamText = b => `${b.toFixed(2)} km (${Math.round(b * 3281).toLocaleString()} ft)`;
const swatchHtml = v => (v.color ? `<span class="swatch" style="background:${v.color}"></span>` : "");

function updateReadout() {
  renderPin();
  const h = S.hover;
  if (!h || !S.radar || S.radar.lat == null || !S.cfg) return;
  const [x, y] = h;
  const pt = placeText(x, y);
  $("roRadar").textContent = pt.radar;
  $("roRadarLbl").textContent = isNational() ? "From map centre" : "From radar";
  $("roPos").textContent = pt.pos;
  $("roHome").innerHTML = pt.home;              // already escaped
  const v0 = paneValue(PANES[0], x, y);
  $("roValue").innerHTML = swatchHtml(v0) + v0.html;
  const stn = S.settings.stations ? stationNear(x, y) : null;
  const fire = S.settings.fires ? fireNear(x, y) : null, rpt = S.settings.reports ? reportNear(x, y) : null;
  const rot = rotationNear(x, y);
  $("roSat").innerHTML = rot ? (S.mode === "raw"
      ? `<small>${rot.tvs ? "TVS" : "Mesocyclone"}:</small> Vrot ${Math.round(rot.vrot * 1.944)} kt, ${rot.diam} km wide, base ${rot.base.toFixed(1)} km, depth ${rot.depth.toFixed(1)} km${rot.tds ? ", possible debris" : ""}`
      : `<small>Doppler couplet:</small> ΔV ${Math.round(rot.dv)} km/h across ${rot.diam} km`)
    : rpt ? `<small>Report:</small> ${esc(REPORT_KINDS[rpt.kind] || rpt.kind)}${rpt.size ? ` ${esc(rpt.size)} mm` : ""} at ${fmtTime.format(new Date(rpt.t))}${rpt.note ? `, ${esc(rpt.note)}` : ""}`
    : fire ? `<small>Fire hotspot:</small> ${fire.sat}, ${fmtDate.format(fire.time)} ${fmtTime.format(fire.time)}, ${fire.frp.toFixed(0)} MW`
    : stn ? `<small>${esc(stn.name)}:</small> ${stn.t ?? "–"}° dew ${stn.td ?? "–"}°, wind ${stn.spd ?? "–"} km/h${stn.gust ? ` gust ${stn.gust}` : ""}${stn.msl ? `, ${stn.msl} hPa` : ""}`
    : S.settings.view === "both" ? satReadout(x, y) : "";
  const showBeam = S.mode === "raw" && S.settings.view !== "sat" && v0.beam != null;
  $("roBeamLbl").hidden = $("roBeam").hidden = !showBeam;
  if (showBeam) $("roBeam").textContent = beamText(v0.beam);
  const others = activePanes().slice(1);
  $("roPanes").innerHTML = others.length && S.settings.view !== "sat"
    ? `<dl class="ro-panes">${others.map(p => { const v = paneValue(p, x, y); return `<dt>${paneName(p)}</dt><dd>${swatchHtml(v)}${v.html}</dd>`; }).join("")}</dl>`
    : "";
}

function renderPin() {
  const panel = $("pinPanel");
  const tap = $("tapRead");
  if (!S.pin || !S.cfg || !S.radar || S.radar.lat == null) { panel.hidden = true; tap.hidden = true; return; }
  if (isPhone()) {      // phones have no hover: show the pinned value right on the map
    const v = paneValue(PANES[0], ...S.pin), pt = placeText(...S.pin);
    tap.innerHTML = `${swatchHtml(v)}<span>${v.html}</span><small>${pt.home}</small><button id="tapClose" aria-label="Clear pin">×</button>`;
    tap.hidden = false;
    $("tapClose").onclick = () => { S.pin = null; renderPin(); draw(); };
  }
  panel.hidden = false;
  const [x, y] = S.pin;
  const pt = placeText(x, y);
  const vals = activePanes().map(p => ({ p, v: paneValue(p, x, y) }));
  const beam = vals.find(o => o.v.beam != null)?.v.beam;
  $("pinBody").innerHTML = `<dl class="ro-panes">${vals.map(({ p, v }) => `<dt>${paneName(p)}</dt><dd>${swatchHtml(v)}${v.html}</dd>`).join("")}</dl>
    ${S.settings.view === "both" && satTbAt(x, y) != null ? `<div class="ro-sat">${satReadout(x, y)}</div>` : ""}
    <dl class="ro-grid"><dt>From radar</dt><dd>${pt.radar}</dd><dt>From home</dt><dd>${pt.home}</dd><dt>Position</dt><dd>${pt.pos}</dd>${S.mode === "raw" && beam != null ? `<dt>Beam height</dt><dd>${beamText(beam)}</dd>` : ""}</dl>`;
}

function renderLegend() {
  let colors, labels;
  const def = satDef();
  if (S.settings.view === "sat" && def.kind === "hsd") {
    const st = def.pal.stops, lo = st[0][0], hi = st[st.length - 1][0];
    colors = Array.from({ length: 32 }, (_, i) => { const c = def.pal(lo + (hi - lo) * i / 31); return `rgb(${c.join(",")})`; });
    labels = [`${lo} °C`, "brightness temperature", `${hi} °C`];
  } else if (S.settings.view === "fc") {
    const L = FC_LAYERS[S.settings.fcLayer], st = L.sc.stops, lo = st[0][0], hi = st[st.length - 1][0];
    colors = Array.from({ length: 32 }, (_, i) => { const c = L.sc(lo + (hi - lo) * i / 31) || [20, 30, 36]; return `rgb(${c.join(",")})`; });
    labels = [`${lo}`, L.unit, `${hi}`];
  } else if (S.settings.view === "sat") {
    colors = []; labels = [];
  } else if (S.mode === "raw" && MOMENTS[S.raw.sweep?.moment]?.cat) {
    colors = HCA_CLASSES.slice(1).map(c => c[1]);
    labels = ["bio", "rain", "hail"];
  } else if (S.mode === "raw") {
    const M = MOMENTS[S.raw.sweep?.moment || S.settings.moment] || MOMENTS.DBZH;
    const st = M.sc.stops;
    const lo = st[0][0], hi = st[st.length - 1][0];
    colors = Array.from({ length: 32 }, (_, i) => { const c = M.sc(lo + (hi - lo) * i / 31) || [28, 42, 51]; return `rgb(${c.join(",")})`; });
    labels = [`${lo}`, M.unit || "", `${hi}`];
  } else {
    const type = S.product?.type || "0";
    const pal = PALETTES[type];
    colors = (pal.tables[S.settings.palette[type]] || Object.values(pal.tables)[0]).colors;
    labels = pal.legendLabels;
  }
  $("legend").innerHTML = colors.map(c => `<span style="background:${c}"></span>`).join("");
  let lab = $("legend").nextElementSibling;
  if (!lab || !lab.classList.contains("legend-labels")) {
    lab = document.createElement("div"); lab.className = "legend-labels"; $("legend").after(lab);
  }
  lab.innerHTML = labels.map(t => `<span>${t}</span>`).join("");
}

// ================================================================== interaction
let drag = null, drawQueued = false, readoutQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}
function eventKm(p, e) {
  usePane(p);
  const r = p.canvas.getBoundingClientRect(), d = dpr();
  return screenToKm((e.clientX - r.left) * d, (e.clientY - r.top) * d);
}
// touch: two fingers pinch-zoom and pan; one finger pans (or measures / pins like a mouse)
const touches = new Map();
let pinch = null;
function pinchStart(p) {
  const [a, b] = [...touches.values()];
  const r = p.canvas.getBoundingClientRect(), d = dpr();
  const mx = ((a.x + b.x) / 2 - r.left) * d, my = ((a.y + b.y) / 2 - r.top) * d;
  usePane(p);
  pinch = { p, dist: Math.hypot(a.x - b.x, a.y - b.y), scale: S.view.scale, km: screenToKm(mx, my) };
  drag = null;
}
function pinchMove() {
  const [a, b] = [...touches.values()], p = pinch.p;
  const r = p.canvas.getBoundingClientRect(), d = dpr();
  usePane(p);
  const v = S.view, maxHalf = isNational() ? 3000 : S.settings.view === "radar" ? 700 : 2800;
  const minScale = Math.min(canvas.width, canvas.height) / (2 * maxHalf);
  v.scale = Math.min(60 * d, Math.max(minScale, pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
  const mx = ((a.x + b.x) / 2 - r.left) * d, my = ((a.y + b.y) / 2 - r.top) * d;
  v.cx = pinch.km[0] - (mx - canvas.width / 2) / v.scale;          // keep the pinched point under the fingers
  v.cy = pinch.km[1] + (my - canvas.height / 2) / v.scale;
  if (S.settings.view !== "radar") ensureSat();
  scheduleDraw();
}
for (const p of PANES) {
  const c = p.canvas;
  c.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { c.setPointerCapture(e.pointerId); pinchStart(p); return; }
    }
    c.setPointerCapture(e.pointerId);
    const km = eventKm(p, e);
    const xs = S.tool === "xsect" && S.mode === "raw" && !e.shiftKey;
    const ruler = !xs && (e.shiftKey || S.tool === "ruler");
    drag = { p, x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy, moved: false, ruler, xs, start: km };
    if (ruler) S.rulerLine = { a: km, b: km };
    if (xs) S.xs.draft = { a: km, b: km };
  });
  c.addEventListener("pointermove", e => {
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) { pinchMove(); return; }
    }
    const km = eventKm(p, e);
    const d = dpr();
    if (drag && drag.p === p) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.ruler) S.rulerLine.b = km;
      else if (drag.xs) S.xs.draft.b = km;
      else if (drag.moved) {
        S.view.cx = drag.cx - (e.clientX - drag.x) * d / S.view.scale;
        S.view.cy = drag.cy + (e.clientY - drag.y) * d / S.view.scale;
      }
      scheduleDraw();
    } else if (S.settings.layout > 1) scheduleDraw();
    S.hover = drag && drag.moved && !drag.ruler && !drag.xs ? null : km;
    S.hoverPane = p.i;
    if (S.hover && !readoutQueued) { readoutQueued = true; requestAnimationFrame(() => { readoutQueued = false; updateReadout(); }); }
    usePane(PANES[0]);
  });
  c.addEventListener("pointerup", e => {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (pinch) { if (touches.size < 2) { pinch = null; drag = null; } return; }
    }
    if (drag && drag.xs) {
      if (drag.moved) { S.xs.line = S.xs.draft; openXsect(); }
      S.xs.draft = null; scheduleDraw();
    } else if (drag && !drag.moved && !drag.ruler && S.picking === "home") {
      S.picking = null; $("panes").classList.remove("picking");
      const [lat, lon] = kmToLatLon(...drag.start);
      openHomeDialog({ lat, lon });
    } else if (drag && !drag.moved && !drag.ruler) { S.pin = drag.start; renderPin(); scheduleDraw(); }
    if (drag && drag.ruler && !drag.moved) S.rulerLine = null;
    drag = null;
  });
  c.addEventListener("pointercancel", e => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; drag = null; });
  c.addEventListener("pointerleave", () => { S.hoverPane = null; if (S.settings.layout > 1) scheduleDraw(); });
  c.addEventListener("wheel", e => {
    e.preventDefault();
    usePane(p);
    const r = c.getBoundingClientRect(), d = dpr();
    zoomAt((e.clientX - r.left) * d, (e.clientY - r.top) * d, e.deltaY < 0 ? 1.2 : 1 / 1.2);
    usePane(PANES[0]);
  }, { passive: false });
}

function zoomAt(sx, sy, factor) {
  const [kx, ky] = screenToKm(sx, sy);
  const v = S.view;
  const maxHalf = isNational() ? 3000 : S.settings.view === "sat" || S.settings.view === "both" ? 2800 : S.settings.view === "fc" ? 1600 : 700;
  const minScale = Math.min(canvas.width, canvas.height) / (2 * maxHalf);
  v.scale = Math.min(60 * dpr(), Math.max(minScale, v.scale * factor));
  v.cx = kx - (sx - canvas.width / 2) / v.scale;
  v.cy = ky + (sy - canvas.height / 2) / v.scale;
  if (S.settings.view !== "radar") ensureSat();
  scheduleDraw();
}
$("zoomIn").onclick = () => { usePane(PANES[0]); zoomAt(canvas.width / 2, canvas.height / 2, 1.4); };
$("zoomOut").onclick = () => { usePane(PANES[0]); zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.4); };
$("zoomReset").onclick = () => { fitView(S.mode === "live" ? (S.product?.km || 128) : 128); draw(); };

$("playBtn").onclick = () => play(!S.playing);
$("exportBtn").onclick = () => exportLoop();
$("prevBtn").onclick = () => step(-1);
$("nextBtn").onclick = () => step(1);
$("scrub").oninput = e => { play(false); if (S.mode === "live") showFrame(+e.target.value); else showScan(+e.target.value); };

function changeTilt(dir) {
  const opts = [...$("tiltSel").options].map(o => +o.value);
  const i = opts.indexOf(+$("tiltSel").value);
  const j = Math.max(0, Math.min(opts.length - 1, i + dir));
  if (j !== i) { S.settings.elev = opts[j]; save(); showScan(S.raw.idx); }
}
document.addEventListener("keydown", e => {
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) && document.activeElement.type !== "range") return;
  if (document.activeElement?.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;       // leave Ctrl+C, Ctrl+P, Alt+Left etc. to the browser
  if (e.code === "Space" && tag === "BUTTON") return;   // Space on a focused button presses it
  if (e.code === "Space") { e.preventDefault(); play(!S.playing); }
  else if (e.code === "ArrowLeft") step(-1);
  else if (e.code === "ArrowRight") step(1);
  else if (e.key === "l" || e.key === "L") $("ltgChip").click();
  else if (e.key === "?") toggleHelp();
  else if (e.key === "x" || e.key === "X") $("xsChip").click();
  else if (e.key === "c" || e.key === "C") $("cellsChip").click();
  else if (e.key === "p" || e.key === "P") { PERF.toggle(); $("perfOn").checked = PERF.on; }
  else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFind(true); }
  else if (e.key === "Escape") {
    if (!$("homeDlg").hidden) $("homeDlg").hidden = true;
    else if (!$("placeBox").hidden) toggleFind(false);
    else if (S.picking) { S.picking = null; $("panes").classList.remove("picking"); updateStamp(); }
    else if (!$("help").hidden) toggleHelp(false);
    else if (!$("xsect").hidden) closeXsect();
    else if (S.rulerLine) { S.rulerLine = null; draw(); }
    else if (S.pin) { S.pin = null; renderPin(); draw(); }
  }
  else if (S.mode === "raw" && e.code === "ArrowUp") { e.preventDefault(); changeTilt(1); }
  else if (S.mode === "raw" && e.code === "ArrowDown") { e.preventDefault(); changeTilt(-1); }
  else if (S.mode === "raw" && (e.key === "r" || e.key === "v" || e.key === "s")) {
    const want = e.key === "r" ? ["DBZH", "DBZH_CLEAN", "TH"] : e.key === "v" ? ["VRADDH", "VRADH"] : ["SRV"];
    const m = want.find(x => [...$("momentSel").options].some(o => o.value === x));
    if (m) { S.settings.moment = m; save(); showScan(S.raw.idx); }
  }
});

function bindSettings() {
  const st = S.settings;
  $("mapStyle").value = st.mapStyle;
  $("opacity").value = st.opacity;
  $("speed").value = 860 - st.speed;
  $("windowSel").value = String(st.window);
  $("lyrTopo").checked = st.topo; $("lyrRange").checked = st.range; $("lyrLoc").checked = st.loc;
  $("lyrHome").checked = st.home; $("smooth").checked = st.smooth;
  $("satSel").value = st.satLayer; $("satOpacity").value = st.satOpacity;
  $("ltgWindow").value = String(st.ltgWindow);
  $("ltgAlert").value = String(st.ltgAlertKm);
  $("fcModel").value = st.fcModel;
  $("fcModel").onchange = e => { st.fcModel = e.target.value; save(); refreshFcFrames(); };
  $("fcLevel").value = String(st.fcLevel); $("fcIso").value = st.fcIso;
  $("fcLevel").onchange = e => { st.fcLevel = +e.target.value; save(); renderLegend(); updateStamp(); refreshFcFrames(); };
  $("fcIso").onchange = e => { st.fcIso = e.target.value; save(); syncFcControls(); draw(); };
  $("ltgDensity").checked = st.ltgDensity;
  $("ltgDensity").onchange = e => { st.ltgDensity = e.target.checked; save(); draw(); };
  $("fcParticles").checked = st.fcParticles;
  $("fcLayer").onchange = e => { st.fcLayer = e.target.value; save(); syncFcControls(); renderLegend(); updateStamp(); refreshFcFrames(); };
  $("fcParticles").onchange = e => { st.fcParticles = e.target.checked; save(); if (st.fcParticles) startParticles(); else clearParticles(); };

  $("lyrSeamless").checked = st.seamless !== false;
  $("lyrSeamless").onchange = e => { st.seamless = e.target.checked; save(); draw(); };
  $("gpuRender").checked = st.gpu !== false;
  $("gpuRender").onchange = e => { st.gpu = e.target.checked; save(); for (const p of PANES) p.polar = null; draw(); };
  $("perfOn").onchange = e => PERF.toggle(e.target.checked);
  $("lyrWxw").checked = st.wxw; $("lyrWatches").checked = st.watches;
  $("lyrWxw").onchange = e => { st.wxw = e.target.checked; save(); renderWxWarnings(); draw(); };
  $("lyrWatches").onchange = e => { st.watches = e.target.checked; save(); renderWxWarnings(); draw(); };
  $("lyrRotDet").checked = st.rotDet; $("lyrCouplets").checked = st.couplets; $("envOverlay").value = st.envOverlay;
  $("lyrRotDet").onchange = e => { st.rotDet = e.target.checked; save(); onTimeChanged(); };
  $("lyrCouplets").onchange = e => { st.couplets = e.target.checked; save(); onTimeChanged(); };
  $("envOverlay").onchange = e => { st.envOverlay = e.target.value; save(); draw(); };
  $("lyrFires").checked = st.fires; $("lyrReports").checked = st.reports; $("contourSel").value = st.contour;
  $("lyrFires").onchange = e => { st.fires = e.target.checked; save(); S.fires.fetched = 0; ensureFires(); draw(); };
  $("lyrReports").onchange = e => { st.reports = e.target.checked; save(); draw(); };
  $("contourSel").onchange = e => { st.contour = e.target.value; save(); draw(); };
  $("lyrRoads").checked = st.roads;
  $("lyrRoads").onchange = e => { st.roads = e.target.checked; save(); ensureRoads(); draw(); };
  $("lyrStations").checked = st.stations; $("lyrMosaic").checked = st.mosaic; $("townLabels").value = st.townLabels;
  $("lyrStations").onchange = e => { st.stations = e.target.checked; save(); S.obsmap.fetched = 0; ensureObsMap(); draw(); };
  $("lyrMosaic").onchange = e => { st.mosaic = e.target.checked; save(); draw(); };
  $("townLabels").onchange = e => { st.townLabels = e.target.value; save(); ensureTowns(); draw(); };
  $("palExport").onclick = () => exportPalettes();
  $("palImport").onclick = () => $("palFile").click();
  $("palFile").onchange = e => { if (e.target.files[0]) importPalettes(e.target.files[0]); e.target.value = ""; };
  $("ltgAlert").onchange = e => { st.ltgAlertKm = +e.target.value; save(); ltgAlertSeen = Date.now(); };
  const syncChips = () => {
    document.querySelectorAll("#viewSeg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === st.view)));
    $("ltgChip").setAttribute("aria-pressed", String(st.lightning));
  };
  syncChips();
  document.querySelectorAll("#viewSeg button").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("ltgChip").onclick = () => { st.lightning = !st.lightning; save(); syncChips(); onTimeChanged(); };
  S.syncChips = syncChips;
  $("refMin").value = String(st.refMin);

  const redraw = () => { save(); draw(); };
  $("mapStyle").onchange = e => { st.mapStyle = e.target.value; redraw(); };
  $("opacity").oninput = e => { st.opacity = +e.target.value; redraw(); };
  $("speed").oninput = e => { st.speed = 860 - +e.target.value; save(); };
  $("windowSel").onchange = e => { st.window = +e.target.value; save(); if (S.mode === "live") refreshFrames(true); };
  $("lyrTopo").onchange = e => { st.topo = e.target.checked; redraw(); };
  $("lyrRange").onchange = e => { st.range = e.target.checked; redraw(); };
  $("lyrLoc").onchange = e => { st.loc = e.target.checked; redraw(); };
  $("lyrHome").onchange = e => { st.home = e.target.checked; redraw(); };
  $("smooth").onchange = e => { st.smooth = e.target.checked; redraw(); };
  $("satSel").onchange = e => { st.satLayer = e.target.value; save(); S.sat.current = null; renderLegend(); if (satTimeline()) refreshSatFrames(); else onTimeChanged(); };
  $("satOpacity").oninput = e => { st.satOpacity = +e.target.value; redraw(); };
  $("ltgWindow").onchange = e => { st.ltgWindow = +e.target.value; save(); onTimeChanged(); };
  $("paletteSel").onchange = e => { st.palette[S.product.type] = e.target.value; save(); renderLegend(); draw(); updateReadout(); };
  $("threshold").onchange = e => { st.threshold[S.product.type] = +e.target.value; redraw(); };
  $("refMin").onchange = e => { st.refMin = +e.target.value; save(); S.raw.polar = null; draw(); renderXsect(); };
  $("daySel").onchange = e => { play(false); loadDay(e.target.value); };
  $("tiltSel").onchange = e => { st.elev = +e.target.value; save(); showScan(S.raw.idx); };
  $("momentSel").onchange = e => { st.moment = e.target.value; save(); showScan(S.raw.idx); };
}

function setView(v) {
  const st = S.settings;
  if (st.view === v) return;
  play(false);
  st.view = v; save();
  S.syncChips();
  renderLegend();
  S.sat.current = null;
  draw();
  $("fcbar").hidden = v !== "fc";
  fillPaneSelects();
  if (v !== "fc") clearParticles();
  if (v === "fc" && S.mode !== "live") { selectProduct(S.settings.product === "raw" ? "3" : S.settings.product); return; }
  if (S.mode === "live") {
    if (v === "sat") { $("frameStamp").innerHTML = "<span>Loading satellite…</span>"; refreshSatFrames(); }
    else if (v === "fc") refreshFcFrames();
    else { S.satFrames = []; refreshFrames(true); }
  } else onTimeChanged();
}

function fillLiveControls() {
  const type = S.product?.type || "0";
  const pal = PALETTES[type];
  $("paletteSel").innerHTML = Object.entries(pal.tables).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join("");
  $("paletteSel").value = pal.tables[S.settings.palette[type]] ? S.settings.palette[type] : Object.keys(pal.tables)[0];
  $("threshold").innerHTML = pal.thresholds.map(t => `<option value="${t.v}">${t.label}</option>`).join("");
  $("threshold").value = S.settings.threshold[type] || 0;
  renderLegend();
}

// ---------------------------------------------------------------- cross-sections
S.xs = { line: null, draft: null, data: null };
function xsMoments() {
  if (!lastTilt) return [];
  return Object.keys(MOMENTS).filter(m => !MOMENTS[m].grid && momentAvailable(lastTilt, m));
}
function openXsect() {
  const list = xsMoments();
  const cur = S.raw.sweep?.moment;
  const want = S.xs.moment && list.includes(S.xs.moment) ? S.xs.moment
    : list.includes(cur) ? cur : (list.includes("DBZH_CLEAN") ? "DBZH_CLEAN" : list[0]);
  $("xsMoment").innerHTML = list.map(m => `<option value="${m}">${MOMENTS[m].label}</option>`).join("");
  $("xsMoment").value = want;
  S.xs.moment = want;
  $("xsect").hidden = false;
  loadXsect();
}
function closeXsect() {
  $("xsect").hidden = true;
  S.xs.line = null; S.xs.data = null;
  draw();
}
async function loadXsect() {
  const L = S.xs.line;
  if (!L || S.mode !== "raw" || !S.raw.scans.length) return;
  const scan = S.raw.scans[S.raw.idx], m = S.xs.moment, mo = S.settings.motion;
  const url = `/api/archive/xsect?radar=${S.radar.id}&date=${S.raw.date}&time=${scan}&moment=${m}`
    + `&x1=${L.a[0].toFixed(2)}&y1=${L.a[1].toFixed(2)}&x2=${L.b[0].toFixed(2)}&y2=${L.b[1].toFixed(2)}&mdir=${mo.dir}&mspd=${mo.spd}`;
  const tok = (S.xs.tok = (S.xs.tok || 0) + 1);
  $("xsTitle").textContent = "Cross-section: loading…";
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (tok !== S.xs.tok) return;
    const [h0, hm20] = (r.headers.get("X-Freezing") || "").split(",").map(Number);
    S.xs.data = { v: new Float32Array(buf), nx: +r.headers.get("X-Nx"), nz: +r.headers.get("X-Nz"), ztop: +r.headers.get("X-Ztop"),
      moment: m, len: Math.hypot(L.b[0] - L.a[0], L.b[1] - L.a[1]), h0: h0 || null, hm20: hm20 || null };
    $("xsTitle").textContent = `Cross-section A to B, ${S.xs.data.len.toFixed(0)} km, ${fmtTime.format(scanDate(S.raw.date, scan))}`;
    renderXsect();
  } catch (e) {
    if (tok === S.xs.tok) $("xsTitle").textContent = `Cross-section failed: ${e.message}`;
  }
}
const XS_M = { l: 40, r: 10, t: 6, b: 22 };
function renderXsect() {
  const D = S.xs.data, cv = $("xsCanvas");
  if (!D) return;
  const d = window.devicePixelRatio || 1, rect = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(rect.width * d)); cv.height = Math.max(1, Math.round(rect.height * d));
  const g = cv.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#0a1216"; g.fillRect(0, 0, cv.width, cv.height);
  const M = MOMENTS[D.moment] || MOMENTS.DBZH;
  const thr = M.ref ? S.settings.refMin : -Infinity;
  const img = new ImageData(D.nx, D.nz);
  const out = new Uint32Array(img.data.buffer);
  for (let i = 0; i < D.v.length; i++) {
    const v = D.v[i];
    if (Number.isNaN(v) || v < thr) continue;
    const c = M.sc(v);
    if (c) out[i] = pack(c[0], c[1], c[2]);
  }
  const tmp = document.createElement("canvas"); tmp.width = D.nx; tmp.height = D.nz;
  tmp.getContext("2d").putImageData(img, 0, 0);
  const pl = XS_M.l * d, pr = cv.width - XS_M.r * d, pt = XS_M.t * d, pb = cv.height - XS_M.b * d;
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, pl, pt, pr - pl, pb - pt);
  // axes
  g.strokeStyle = "#263b44"; g.fillStyle = "#8aa0a6"; g.lineWidth = 1 * d;
  g.font = `${11 * d}px "Barlow Semi Condensed", sans-serif`;
  for (let z = 0; z <= D.ztop; z += 2) {
    const y = pb - (z / D.ztop) * (pb - pt);
    g.beginPath(); g.moveTo(pl, y); g.lineTo(pr, y); g.stroke();
    g.fillText(`${z} km`, 4 * d, y + 4 * d);
  }
  const step = D.len > 150 ? 25 : D.len > 60 ? 10 : 5;
  for (let k = 0; k <= D.len; k += step) {
    const x = pl + (k / D.len) * (pr - pl);
    g.fillText(`${k}`, x - 6 * d, cv.height - 6 * d);
  }
  g.fillStyle = "#ffffff"; g.font = `bold ${12 * d}px "Barlow Semi Condensed", sans-serif`;
  g.fillText("A", pl + 3 * d, pt + 14 * d); g.fillText("B", pr - 12 * d, pt + 14 * d);
  for (const [h, lab, col] of [[D.h0, "0 °C", "#79d3e6"], [D.hm20, "−20 °C", "#d6e2e4"]]) {
    if (!h) continue;
    const y = pb - (h / D.ztop) * (pb - pt);
    g.strokeStyle = col; g.setLineDash([5 * d, 4 * d]);
    g.beginPath(); g.moveTo(pl, y); g.lineTo(pr, y); g.stroke(); g.setLineDash([]);
    g.fillStyle = col; g.font = `${11 * d}px "Barlow Semi Condensed", sans-serif`;
    g.fillText(lab, pr - 40 * d, y - 4 * d);
  }
}
$("xsCanvas").addEventListener("pointermove", e => {
  const D = S.xs.data;
  if (!D) return;
  const r = $("xsCanvas").getBoundingClientRect();
  const fx = (e.clientX - r.left - XS_M.l) / (r.width - XS_M.l - XS_M.r);
  const fy = (e.clientY - r.top - XS_M.t) / (r.height - XS_M.t - XS_M.b);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) { $("xsRead").textContent = ""; return; }
  const i = Math.min(D.nx - 1, Math.floor(fx * D.nx)), j = Math.min(D.nz - 1, Math.floor(fy * D.nz));
  const v = D.v[j * D.nx + i];
  const M = MOMENTS[D.moment] || MOMENTS.DBZH;
  $("xsRead").textContent = `${(fx * D.len).toFixed(1)} km from A, ${((1 - fy) * D.ztop).toFixed(1)} km high: `
    + (Number.isNaN(v) ? "no data" : `${v.toFixed(M.dp)} ${M.unit}`);
});
$("xsMoment").onchange = e => { S.xs.moment = e.target.value; loadXsect(); };
$("xsClose").onclick = closeXsect;
$("xsChip").onclick = () => {
  if (S.mode !== "raw") { rawStatus("Cross-sections need Raw volume mode", "err"); return; }
  S.tool = S.tool === "xsect" ? "pan" : "xsect";
  syncToolChips();
};
$("cellsChip").onclick = () => {
  S.settings.cells = !S.settings.cells; save();
  $("cellsChip").setAttribute("aria-pressed", String(S.settings.cells));
  if (S.settings.cells && S.mode !== "live") rawStatus("Cell tracking runs on live reflectivity loops", "err");
  draw(); renderCellPanel();
};
$("cellsChip").setAttribute("aria-pressed", String(S.settings.cells));
$("cellThr").value = String(S.settings.cellThr);
$("cellThr").onchange = e => { S.settings.cellThr = +e.target.value; save(); draw(); renderCellPanel(); };

function syncToolChips() {
  $("rulerChip").setAttribute("aria-pressed", String(S.tool === "ruler"));
  $("xsChip").setAttribute("aria-pressed", String(S.tool === "xsect"));
}
new ResizeObserver(() => { if (!$("xsect").hidden) renderXsect(); }).observe($("xsect"));

// ---------------------------------------------------------------- home location
function updateHomeLabels() {
  if (!S.cfg) return;
  const h = S.cfg.home;
  $("homeBtn").textContent = `${h.name} (${h.lat.toFixed(3)}, ${h.lon.toFixed(3)})`;
  const fp = S.fcPoint;
  $("fcTitle").textContent = `Next 72 hours at ${fp ? fp.name : h.name}`;
  $("fcBack").hidden = !fp;
}
function openHomeDialog(pre = {}) {
  const h = S.cfg.home;
  $("homeNameIn").value = pre.name ?? (($("homeDlg").hidden ? h.name : $("homeNameIn").value) || h.name);
  $("homeLatIn").value = (pre.lat ?? h.lat).toFixed(4);
  $("homeLonIn").value = (pre.lon ?? h.lon).toFixed(4);
  $("homeMsg").textContent = pre.msg || "";
  $("homeSearch").value = ""; $("homeResults").innerHTML = "";
  setTimeout(() => $("homeSearch").focus(), 50);
  if ($("homeDlg").hidden) $("radarsIn").value = S.cfg.radars.filter(r => !r.auto && !r.national).map(r => r.id).join(", ");
  $("homeDlg").hidden = false;
}
$("homeBtn").onclick = () => openHomeDialog();
// type an address or suburb: search as you type (after a short pause) or on Enter. Used by the home
// dialog and by Find on the map.
function bindPlaceSearch(input, out, onPick) {
  let timer = null, seq = 0;
  async function search() {
    timer = null;
    const q = input.value.trim();
    if (q.length < 3) { out.innerHTML = ""; return; }
    const my = ++seq;
    out.innerHTML = `<div class="dim">Searching…</div>`;
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (my !== seq) return;                       // a newer search has started
    if (!r || !r.results.length) { out.innerHTML = `<div class="dim">${r ? "Nothing found. Try a suburb or town name." : "Search unavailable right now."}</div>`; return; }
    out.innerHTML = r.results.map((x, i) => `<button type="button" data-i="${i}">${esc(x.label)}</button>`).join("");
    out.querySelectorAll("button").forEach(b => b.onclick = () => { const x = r.results[+b.dataset.i]; out.innerHTML = ""; input.value = ""; onPick(x); });
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 600); });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = out.querySelector("button");
      if (timer || !first) { clearTimeout(timer); search(); } else first.click();     // Enter twice = take the top result
    } else if (e.key === "Escape" && input.id === "placeIn") toggleFind(false);
  });
}
bindPlaceSearch($("homeSearch"), $("homeResults"), x => {
  $("homeNameIn").value = x.name; $("homeLatIn").value = x.lat.toFixed(4); $("homeLonIn").value = x.lon.toFixed(4);
  $("homeMsg").textContent = `${x.label}. Press Save to make it home.`;
});
// Find: jump the map to a place and pin it; beyond the current radar's reach, switch to the all-Australia view
function toggleFind(force) {
  const box = $("placeBox");
  box.hidden = force === undefined ? !box.hidden : !force;
  $("findChip").setAttribute("aria-pressed", String(!box.hidden));
  if (!box.hidden) setTimeout(() => $("placeIn").focus(), 30); else $("placeResults").innerHTML = "";
}
$("findChip").onclick = () => toggleFind();
function goToPlace(x) {
  toggleFind(false);
  const go = () => {
    const [kx, ky] = latLonToKm(x.lat, x.lon);
    S.view.cx = kx; S.view.cy = ky;
    S.view.scale = Math.max(S.view.scale, Math.min(canvas.width, canvas.height) / 2 / (isNational() ? 150 : 60));
    S.pin = [kx, ky]; renderPin(); draw();
  };
  if (S.radar && !isNational() && S.radar.lat != null) {
    const [kx, ky] = latLonToKm(x.lat, x.lon), reach = S.mode === "raw" ? 250 : (S.product ? S.product.km : 256);
    const nat = S.cfg.radars.find(r => r.national);
    if (Math.hypot(kx, ky) > reach && nat) {
      S.settings.mode = null; save(); $("modesChip").textContent = "◧ Modes";
      selectRadar(nat.id); $("radarSel").value = nat.id;
      setTimeout(go, 300);
      return;
    }
  }
  go();
}
bindPlaceSearch($("placeIn"), $("placeResults"), goToPlace);
$("homeCancel").onclick = () => { $("homeDlg").hidden = true; };
$("homeDlg").onclick = e => { if (e.target === $("homeDlg")) $("homeDlg").hidden = true; };
$("homePick").onclick = () => {
  $("homeDlg").hidden = true;
  S.picking = "home"; $("panes").classList.add("picking");
  rawStatus("Click the map to place home", "busy");
  $("frameStamp").insertAdjacentHTML("beforeend", "<span>click the map to set home</span>");
};
$("homeLocate").onclick = () => {
  if (!navigator.geolocation || !window.isSecureContext) {
    $("homeMsg").textContent = "Browsers only share location over https or on localhost. Use Pick on map instead.";
    return;
  }
  $("homeMsg").textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    p => { $("homeLatIn").value = p.coords.latitude.toFixed(4); $("homeLonIn").value = p.coords.longitude.toFixed(4); $("homeMsg").textContent = `Accurate to about ${Math.round(p.coords.accuracy)} m.`; },
    err => { $("homeMsg").textContent = `Location unavailable: ${err.message}`; },
    { enableHighAccuracy: true, timeout: 15000 });
};
$("homeSave").onclick = async () => {
  const body = { name: $("homeNameIn").value.trim() || "Home", lat: +$("homeLatIn").value, lon: +$("homeLonIn").value };
  if (!Number.isFinite(body.lat) || !Number.isFinite(body.lon) || Math.abs(body.lat) > 90 || Math.abs(body.lon) > 180) {
    $("homeMsg").textContent = "Latitude must be −90 to 90 and longitude −180 to 180."; return;
  }
  const r = await fetch("/api/home", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!r || !r.ok) { $("homeMsg").textContent = "Could not save home on the server."; return; }
  S.cfg.home = await r.json();
  const want = $("radarsIn").value.split(/[\s,]+/).filter(x => /^\d+$/.test(x));
  if (want.length && want.join(",") !== S.cfg.radars.filter(r => !r.auto && !r.national).map(x => x.id).join(",")) {
    await fetch("/api/radars", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radars: want }) }).catch(() => null);
    setTimeout(() => loadConfig().catch(() => {}), 90e3);
  }
  $("homeDlg").hidden = true;
  updateHomeLabels();
  loadForecast();
  onTimeChanged();
};
$("pinFc").onclick = () => {
  if (!S.pin) return;
  const [lat, lon] = kmToLatLon(...S.pin);
  S.fcPoint = { lat: +lat.toFixed(3), lon: +lon.toFixed(3), name: `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
  updateHomeLabels(); loadForecast();
  $("fcTitle").scrollIntoView({ behavior: "smooth", block: "start" });
};
$("fcBack").onclick = () => { S.fcPoint = null; $("spotSel").value = ""; updateHomeLabels(); loadForecast(); };
let SPOTS = [];
function renderSpots() {
  $("spotSel").innerHTML = `<option value="">${SPOTS.length ? "Spots" : "No spots"}</option>` + SPOTS.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")
    + (S.fcPoint && SPOTS.some(x => x.id === S.fcPoint.id) ? `<option value="__del">Remove ${esc(S.fcPoint.name)}</option>` : "");
  $("spotSel").value = S.fcPoint?.id || "";
}
fetch("/api/spots").then(r => r.json()).then(r => { SPOTS = r.spots; renderSpots(); }).catch(() => {});
$("spotSel").onchange = async e => {
  const v = e.target.value;
  if (v === "__del" && S.fcPoint) {
    const r = await fetch(`/api/spots/${encodeURIComponent(S.fcPoint.id)}`, { method: "DELETE" }).then(r => r.json()).catch(() => null);
    if (r) SPOTS = r.spots;
    S.fcPoint = null;
  } else {
    const sp = SPOTS.find(x => x.id === v);
    S.fcPoint = sp ? { ...sp } : null;
  }
  renderSpots(); updateHomeLabels(); loadForecast();
};
$("pinSpot").onclick = async () => {
  if (!S.pin) return;
  const [lat, lon] = kmToLatLon(...S.pin);
  const name = prompt("Name this spot", `${lat.toFixed(2)}, ${lon.toFixed(2)}`);
  if (name === null) return;
  const r = await fetch("/api/spots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, lat, lon }) }).then(r => r.json()).catch(() => null);
  if (!r) return;
  SPOTS = r.spots;
  const sp = SPOTS.find(x => x.name === name);
  S.fcPoint = sp ? { ...sp } : null;
  renderSpots(); updateHomeLabels(); loadForecast();
};
$("fcSnd").onclick = () => openSounding();
$("pinHome").onclick = () => { if (S.pin) { const [lat, lon] = kmToLatLon(...S.pin); openHomeDialog({ lat, lon }); } };

// ---------------------------------------------------------------- saved cases (archive bookmarks)
let CASES = [];
function renderCases() {
  $("caseSel").innerHTML = `<option value="">Saved cases (${CASES.length})</option>` + CASES.slice().reverse().map(c =>
    `<option value="${esc(c.id)}">${esc(c.name)}: ${c.date.slice(6, 8)}/${c.date.slice(4, 6)}/${c.date.slice(0, 4)} ${fmtTime ? fmtTime.format(scanDate(c.date, c.scan)) : c.scan}</option>`).join("");
  $("caseDel").hidden = true;
}
async function loadCases() {
  const r = await fetch("/api/cases").then(r => r.json()).catch(() => null);
  if (r) { CASES = r.cases; renderCases(); }
}
$("caseSave").onclick = async () => {
  if (S.mode !== "raw" || !S.raw.scans.length) return;
  const scan = S.raw.scans[S.raw.idx];
  const name = prompt("Name this case", `Storm ${fmtDate.format(scanDate(S.raw.date, scan))}`);
  if (name === null) return;
  const r = await fetch("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ radar: S.radar.id, date: S.raw.date, scan, name }) }).then(r => r.json()).catch(() => null);
  if (r) { CASES = r.cases; renderCases(); rawStatus(`Saved "${name}"`); }
};
$("caseSel").onchange = async e => {
  const c = CASES.find(x => x.id === e.target.value);
  $("caseDel").hidden = !c;
  if (!c) return;
  play(false);
  if (S.radar.id !== c.radar) { $("radarSel").value = c.radar; S.radar = S.cfg.radars.find(r => r.id === c.radar) || S.radar; S.raw.days = []; }
  if (S.mode !== "raw") await selectRaw(); else if (!S.raw.days.length) await enterRaw();
  if (!S.raw.days.includes(c.date)) { S.raw.days.push(c.date); $("daySel").insertAdjacentHTML("beforeend", `<option value="${c.date}">${c.date.slice(6, 8)}/${c.date.slice(4, 6)}/${c.date.slice(0, 4)}</option>`); }
  $("daySel").value = c.date;
  S.raw.date = c.date;
  const r = await fetch(`/api/archive/scans?radar=${S.radar.id}&date=${c.date}`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!r) { rawStatus("Could not open that day", "err"); return; }
  S.raw.scans = r.scans; $("scrub").max = r.scans.length - 1;
  await showScan(Math.max(0, r.scans.indexOf(c.scan)));
};
$("caseDel").onclick = async () => {
  const id = $("caseSel").value;
  if (!id) return;
  const r = await fetch(`/api/cases/${encodeURIComponent(id)}`, { method: "DELETE" }).then(r => r.json()).catch(() => null);
  if (r) { CASES = r.cases; renderCases(); }
};

// ---------------------------------------------------------------- loop export (WebM video)
async function exportLoop() {
  if (S.exporting) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { alert("This browser can't record video from a canvas."); return; }
  play(false);
  const frame = $("scopeFrame"), d = pixelRatio();
  const comp = document.createElement("canvas");
  comp.width = Math.round(frame.clientWidth * d / 2) * 2; comp.height = Math.round(frame.clientHeight * d / 2) * 2;
  const g = comp.getContext("2d");
  const stream = comp.captureStream(30);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(res => (rec.onstop = res));
  const composite = () => {
    g.fillStyle = "#0a1216"; g.fillRect(0, 0, comp.width, comp.height);
    for (const p of activePanes()) g.drawImage(p.canvas, p.el.offsetLeft * d, p.el.offsetTop * d);
    const t = currentTime();
    if (t) {
      g.font = `600 ${20 * d}px "Barlow Semi Condensed", sans-serif`;
      const label = `${fmtDate.format(t)} ${fmtTime.format(t)}  wxdeck`;
      g.fillStyle = "rgba(15,26,32,.85)"; g.fillRect(10 * d, 10 * d, g.measureText(label).width + 20 * d, 32 * d);
      g.fillStyle = "#d6e2e4"; g.fillText(label, 20 * d, 33 * d);
    }
  };
  // which frames: the whole live loop, or the archive loop window ending at the current scan
  let idxs, go;
  if (S.mode === "raw") {
    const n = Math.min(72, Math.max(2, Math.round(S.settings.window * 12)));
    const end = S.raw.idx; idxs = []; for (let i = Math.max(0, end - n + 1); i <= end; i++) idxs.push(i);
    go = async i => { await showScan(i, { fromPlay: true }); prefetchRaw(i + 1, 2); };
  } else {
    const len = fcTimeline() ? (S.fc.data?.time.length || 0) : satTimeline() ? S.satFrames.length : S.frames.length;
    idxs = Array.from({ length: len }, (_, i) => i);
    go = async i => { showFrame(i); await new Promise(r => setTimeout(r, 30)); };
  }
  if (!idxs.length) return;
  S.exporting = true;
  $("exportBtn").textContent = "● Recording…";
  composite();
  rec.start(500);
  for (const i of idxs) {
    await go(i);
    composite();
    await new Promise(r => setTimeout(r, S.settings.speed));
  }
  for (let k = 0; k < 3; k++) { composite(); await new Promise(r => setTimeout(r, S.settings.speed)); }
  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: "video/webm" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const t = currentTime() || new Date();
  a.download = `wxdeck-${S.radar.id}-${t.toISOString().slice(0, 16).replace(/[:T]/g, "")}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10e3);
  S.exporting = false;
  $("exportBtn").textContent = "⏺ Export";
}

// sharp range rings (every 50 km) and crosshair, used when BoM's bitmap rings would be blocky
function drawVectorRings() {
  const d = dpr(), [cx, cy] = kmToScreen(0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = "rgba(242,169,59,.75)"; ctx.lineWidth = 1.2 * d;
  ctx.font = `${11 * d}px "Barlow Semi Condensed", sans-serif`; ctx.fillStyle = "rgba(242,169,59,.9)";
  for (let r = 50; r <= 300; r += 50) {
    const pr = r * S.view.scale;
    ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(`${r} km`, cx - pr + 4 * d, cy - 4 * d);
  }
  ctx.beginPath(); ctx.moveTo(cx - 300 * S.view.scale, cy); ctx.lineTo(cx + 300 * S.view.scale, cy);
  ctx.moveTo(cx, cy - 300 * S.view.scale); ctx.lineTo(cx, cy + 300 * S.view.scale); ctx.stroke();
}

// start following any BoM radar (live 128 km reflectivity + Doppler), then switch to it
async function openRadar(id, opts = {}) {
  $("frameStamp").innerHTML = "<span>Fetching that radar's live loop…</span>";
  const r = await fetch("/api/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radar: id }) }).catch(() => null);
  if (!r || !r.ok) { $("frameStamp").innerHTML = "<span>Couldn't reach that radar</span>"; return; }
  S.settings.product = "3";
  if (opts.doppler) {
    // reflectivity beside Doppler with couplets and cells on: reload so every control shows the new setup
    Object.assign(S.settings, { radar: id, layout: 2, couplets: true, cells: true, ...(opts.set || {}) });
    S.settings.paneSrc[1].live = "I";
    save();
    if (opts.lat != null) try { sessionStorage.setItem("wxdeck.zoomTo", JSON.stringify({ lat: opts.lat, lon: opts.lon, km: 45 })); } catch { /* private mode */ }
    location.reload();
    return;
  }
  await loadConfig();
  selectRadar(id);
  $("radarSel").value = id;
  if (opts.lat != null) setTimeout(() => {
    const [x, y] = latLonToKm(opts.lat, opts.lon);
    S.view.cx = x; S.view.cy = y; S.view.scale = Math.min(canvas.width, canvas.height) / 2 / 45; draw();
  }, 400);
}

// ---------------------------------------------------------------- national (all-Australia) basemap
S.nat = { base: null, lines: null, loading: false };
function ensureNationalBase() {
  if (S.nat.base || S.nat.loading) return;
  S.nat.loading = true;
  Promise.all([loadImage("/api/natbase?half=2600"), loadImage(`/api/satcoast?radar=AUS&half=2600`)]).then(([b, l]) => {
    S.nat.base = b;
    const cv = document.createElement("canvas"); cv.width = l.width; cv.height = l.height;
    const g = cv.getContext("2d"); g.drawImage(l, 0, 0);
    const id = g.getImageData(0, 0, cv.width, cv.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 30) { d[i] = 150; d[i + 1] = 172; d[i + 2] = 178; d[i + 3] = 220; } else d[i + 3] = 0; }
    g.putImageData(id, 0, 0);
    S.nat.lines = cv;
    draw();
  }).catch(() => {}).finally(() => { S.nat.loading = false; });
}
function drawNationalBase() {
  ensureNationalBase();
  if (S.nat.base) drawCentered(S.nat.base, S.nat.base.width, 2600);
}
function drawNationalLines() {
  if (S.nat.lines) drawCentered(S.nat.lines, S.nat.lines.width, 2600);
}

function toggleHelp(force) {
  const el = $("help");
  el.hidden = force === undefined ? !el.hidden : !force;
}
$("help").onclick = e => { if (e.target === $("help")) toggleHelp(false); };
$("helpChip").onclick = () => toggleHelp();
$("pinClear").onclick = () => { S.pin = null; renderPin(); draw(); };
$("rulerChip").onclick = () => {
  S.tool = S.tool === "ruler" ? "pan" : "ruler";
  syncToolChips();
  if (S.tool !== "ruler") { S.rulerLine = null; draw(); }
};

function syncLayoutChips() {
  document.querySelectorAll("#layoutSeg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.layout === S.settings.layout)));
  $("panes").dataset.layout = String(S.settings.layout);
}
function setLayout(n) {
  S.settings.layout = n; save();
  syncLayoutChips();
  requestAnimationFrame(() => {
    resizeCanvas();
    fillPaneSelects();
    renderRotPanel();
    if (S.mode === "raw" && S.raw.scans.length) showScan(S.raw.idx);
    updateMotionUI();
    updateReadout();
  });
}
document.querySelectorAll("#layoutSeg button").forEach(b => b.onclick = () => setLayout(+b.dataset.layout));

let lastTilt = null;
function fillPaneSelects(tilt = lastTilt) {
  if (tilt) lastTilt = tilt;
  for (const p of PANES.slice(1)) {
    const src = S.settings.paneSrc[p.i];
    if (S.settings.view === "fc") {
      const groups = {};
      for (const [k, L] of Object.entries(FC_LAYERS)) (groups[L.group] = groups[L.group] || []).push(`<option value="l:${k}">${L.name}</option>`);
      p.sel.innerHTML = `<optgroup label="Same layer, other model">${Object.entries(FC_MODEL_NAMES).map(([k, n]) => `<option value="m:${k}">${n}</option>`).join("")}</optgroup>`
        + Object.entries(groups).map(([g, o]) => `<optgroup label="${g}">${o.join("")}</optgroup>`).join("");
      let v = src.fc || (p.i === 1 ? "m:gfs" : p.i === 2 ? "m:icon" : "m:ecmwf");
      if (!v.includes(":")) v = `m:${v}`;
      p.sel.value = v;
      continue;
    }
    if (S.mode === "raw") {
      if (!lastTilt) continue;
      const avail = Object.keys(MOMENTS).filter(m => momentAvailable(lastTilt, m));
      p.sel.innerHTML = avail.map(m => `<option value="${m}">${MOMENTS[m].label}</option>`).join("");
      p.sel.value = avail.includes(src.raw) ? src.raw : pickMoment(lastTilt, src.raw);
    } else if (S.radar) {
      const prods = S.radar.products.filter(x => x.available);
      p.sel.innerHTML = prods.map(x => `<option value="${x.suffix}">${x.label}</option>`).join("");
      if (!prods.some(x => x.suffix === src.live)) {
        const other = prods.find(x => x.suffix === "I" && x.suffix !== S.product?.suffix) || prods.find(x => x.suffix !== S.product?.suffix) || prods[0];
        if (other) src.live = other.suffix;
      }
      p.sel.value = src.live;
    }
  }
  const lab = $("paneLabel0");
  lab.textContent = S.settings.view === "fc" ? "" : S.mode === "raw" ? (MOMENTS[S.raw.sweep?.moment]?.label || "") : (S.product?.label || "");
}
for (const p of PANES.slice(1)) {
  p.sel.onchange = e => {
    const src = S.settings.paneSrc[p.i];
    if (S.settings.view === "fc") { src.fc = e.target.value; save(); draw(); updateReadout(); return; }
    if (S.mode === "raw") { src.raw = e.target.value; save(); updateMotionUI(); showScan(S.raw.idx); }
    else { src.live = e.target.value; save(); draw(); updateReadout(); }
  };
}
$("motionDir").value = S.settings.motion.dir;
$("motionSpd").value = S.settings.motion.spd;
$("motionDir").oninput = e => { S.settings.motion.dir = ((+e.target.value % 360) + 360) % 360; save(); draw(); updateReadout(); };
$("motionSpd").oninput = e => { S.settings.motion.spd = Math.max(0, +e.target.value || 0); save(); draw(); updateReadout(); if (S.xs.moment === "SRV") loadXsect(); };
syncLayoutChips();

// ================================================================== radar / product selection
function renderTabs() {
  fillPaneSelects();
  const tabs = $("productTabs");
  tabs.innerHTML = "";
  // reflectivity ranges, Doppler, rainfall and raw volumes as labelled groups instead of one long row
  const GROUPS = { "4": ["Reflectivity", "64"], "3": ["Reflectivity", "128"], "2": ["Reflectivity", "256"], "1": ["Reflectivity", "512 km"],
    I: ["Doppler", "Velocity"], A: ["Rainfall", "5 min"], B: ["Rainfall", "1 h"], C: ["Rainfall", "Since 9am"], D: ["Rainfall", "24 h"] };
  const groups = new Map();
  const group = name => {
    if (!groups.has(name)) {
      const g = document.createElement("div");
      g.className = "tab-group"; g.setAttribute("role", "group"); g.setAttribute("aria-label", name);
      if (name !== "_") { const l = document.createElement("span"); l.className = "tg-label"; l.textContent = name; g.appendChild(l); }
      else g.classList.add("solo");
      tabs.appendChild(g); groups.set(name, g);
    }
    return groups.get(name);
  };
  for (const p of S.radar.products) {
    const b = document.createElement("button");
    const gl = GROUPS[p.suffix];
    b.textContent = gl ? gl[1] : p.label;
    b.disabled = !p.available;
    b.title = p.available ? `${p.label} (${p.pid})` : `${p.label} (${p.pid}): ${p.error || "not available"}`;
    b.setAttribute("aria-pressed", String(S.mode === "live" && S.product && S.product.pid === p.pid));
    b.onclick = () => selectProduct(p.suffix);
    group(gl ? gl[0] : "_").appendChild(b);
  }
  const raw = document.createElement("button");
  raw.textContent = "Raw volume";
  raw.className = "raw-tab";
  raw.title = "Full-resolution archive scans: every tilt, velocity, dual-pol";
  raw.disabled = S.radar.lat == null || isNational();
  if (isNational()) raw.title = "Raw volumes are per radar: pick a single radar to use them";
  raw.setAttribute("aria-pressed", String(S.mode === "raw"));
  raw.onclick = () => selectRaw();
  group("Archive").appendChild(raw);
}

function setLiveUI(live) {
  $("fcbar").hidden = !(live && S.settings.view === "fc");
  if (live) { $("xsect").hidden = true; if (S.tool === "xsect") { S.tool = "pan"; syncToolChips(); } }
  $("volbar").hidden = live;
  $("paletteSel").closest("label").hidden = !live;
  $("threshold").closest("label").hidden = !live;
}

async function selectProduct(suffix) {
  const p = S.radar.products.find(x => x.suffix === suffix && x.available) || S.radar.products.find(x => x.available);
  if (!p) { S.product = null; renderTabs(); return; }
  const wasRaw = S.mode === "raw";
  const kmChanged = wasRaw || !S.product || S.product.km !== p.km;
  play(false);
  S.mode = "live";
  S.product = p;
  S.settings.product = p.suffix; save();
  S.frames = []; S.idx = 0;
  setLiveUI(true);
  if (kmChanged && canvas.width > 1) fitView(p.km);
  renderTabs();
  fillLiveControls();
  draw();
  await refreshFrames(true);
  applyPendingZoom();
}
// a mode or "Open radar" that reloads the page leaves where to look in sessionStorage
function applyPendingZoom() {
  let z = null;
  try { z = JSON.parse(sessionStorage.getItem("wxdeck.zoomTo") || "null"); sessionStorage.removeItem("wxdeck.zoomTo"); } catch { /* none */ }
  if (!z || !Number.isFinite(z.lat) || !Number.isFinite(z.lon)) return;
  const [x, y] = latLonToKm(z.lat, z.lon);
  S.view.cx = x; S.view.cy = y; S.view.scale = Math.min(canvas.width, canvas.height) / 2 / (z.km || 45); draw();
}

async function selectRaw() {
  play(false);
  S.mode = "raw";
  S.settings.product = "raw"; save();
  setLiveUI(false);
  if (S.product && S.product.km > 256) fitView(128);
  renderTabs();
  renderLegend();
  draw();
  await enterRaw();
}

function selectRadar(id) {
  const found = S.cfg.radars.find(r => r.id === id);
  if (!found && (S.cfg.all_radars || []).some(r => r.id === id)) { openRadar(id); return; }   // stopped following it: start again
  S.radar = found || S.cfg.radars[0];
  S.settings.radar = S.radar.id; save();
  S.product = null;
  // the pin, ruler and cross-section are in km from the old radar: they'd land somewhere else
  S.pin = null; renderPin(); S.rulerLine = null;
  if (!$("xsect").hidden) closeXsect();
  S.ltg.radar = null;
  S.sat.current = null;
  S.obsmap.fetched = 0; S.towns.list = null; S.roads.lines = null; S.fires.fetched = 0;
  loadWarnings();
  renderWxWarnings();
  if (isNational() && S.settings.view !== "fc" && S.settings.layout > 1) setLayout(1);
  if (isNational()) { if (S.settings.product === "raw") S.settings.product = "N"; fitView(2560); }
  if (S.settings.product === "raw") selectRaw(); else selectProduct(S.settings.product);
  if (window.radarPickerSync) radarPickerSync();
}

async function loadConfig() {
  const cfg = await fetch("/api/config").then(r => r.json());
  const first = !S.cfg;
  S.cfg = cfg;
  if (first) setupFormatters(cfg.tz);
  updateHomeLabels();
  const mine = cfg.radars.filter(r => !r.auto && !r.national), auto = cfg.radars.filter(r => r.auto), nat = cfg.radars.filter(r => r.national);
  $("radarSel").innerHTML = mine.concat(nat).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")
    + (auto.length ? `<optgroup label="Following for storms">${auto.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</optgroup>` : "")
    + ((cfg.all_radars || []).length ? `<optgroup label="All BoM radars (live reflectivity + Doppler)">${cfg.all_radars.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</optgroup>` : "");
  $("radarSel").onchange = e => {
    const id = e.target.value;
    S.settings.mode = null; save(); $("modesChip").textContent = "◧ Modes";
    if (cfg.radars.some(r => r.id === id)) selectRadar(id); else openRadar(id);
  };
  const rid = S.radar ? S.radar.id : S.settings.radar;
  if (!cfg.radars.some(r => r.id === rid) && (cfg.all_radars || []).some(r => r.id === rid)) {
    // a radar followed for a while (storms, or picked from the list) expired while on screen: follow it
    // again and keep showing it; it's back in the list on the next check
    keepFollowing(rid);
    if (S.radar && S.radar.id === rid) { const o = document.createElement("option"); o.value = rid; o.textContent = S.radar.name; $("radarSel").prepend(o); $("radarSel").value = rid; return true; }
  }
  const radar = cfg.radars.find(r => r.id === rid) || cfg.radars[0];
  $("radarSel").value = radar.id;
  const ready = radar.products.some(p => p.available);
  const wasBlank = !S.product && S.mode === "live";
  S.radar = radar;
  if (S.product) S.product = radar.products.find(p => p.pid === S.product.pid) || S.product;
  if (first || wasBlank) {
    if (ready) { if (S.settings.product === "raw") selectRaw(); else selectProduct(S.settings.product); }
    else renderTabs();
  } else renderTabs();
  return ready;
}

function keepFollowing(id) {
  return fetch("/api/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radar: id, hours: 3, wait: false }) }).catch(() => null);
}

// ================================================================== boot
function clock() { if (fmtTime) $("clock").textContent = fmtTime.format(new Date()); }

const isPhone = () => window.matchMedia("(max-width: 820px)").matches;
// in the app wrapper (or any narrow screen) start with the long settings panel folded away
if (isPhone()) { document.querySelector(".tuning")?.removeAttribute("open"); $("roValue").textContent = "Tap the map"; }
// running inside the wxdeck Android app: offer a way back to its server picker
if (/wxdeck-app/.test(navigator.userAgent)) document.body.classList.add("in-app");

async function boot() {
  bindSettings();
  let ready = false;
  try { ready = await loadConfig(); } catch { $("emptyMsg").hidden = false; }
  const waitReady = setInterval(async () => {
    if (ready) { clearInterval(waitReady); return; }
    try { ready = await loadConfig(); } catch { /* retry */ }
  }, 8000);
  clock(); setInterval(clock, 10000);
  loadCases();
  loadWarnings(); setInterval(loadWarnings, 5 * 60e3);
  loadReports();
  loadWxWarnings(); setInterval(loadWxWarnings, 60e3);
  setupAlerts();
  loadObs(); setInterval(loadObs, 5 * 60e3);
  loadForecast(); setInterval(loadForecast, 15 * 60e3);
  setInterval(() => { if (S.mode === "live") refreshFrames(true); else { ensureLightning(); updateLightningSummary(); } }, 60e3);
  setInterval(() => loadConfig().catch(() => {}), 30e3);
  // while a radar that's only followed for a few hours is on screen, keep it followed
  setInterval(() => { if (S.radar && S.radar.auto && !document.hidden) keepFollowing(S.radar.id); }, 20 * 60e3);
}
window.addEventListener("DOMContentLoaded", boot);
