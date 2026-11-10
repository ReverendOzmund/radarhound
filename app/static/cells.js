/* Radarhound: storm cell tracking on live BoM reflectivity frames.
   Cells = connected areas above a threshold; tracked frame to frame by nearest predicted
   position; motion is smoothed over the track; paths are projected 60 minutes ahead and
   checked against home for arrival times. Uses globals from app.js. */
"use strict";

const CELL_MIN_KM2 = 8;
const CELL_MAX_SPEED = 130;        // km/h, matching limit between frames
const CELL_HOME_RADIUS = 12;       // km either side of the track counts as "hits home"
const cellCache = { key: null, tracked: 0, nextId: 1 };

function cellsOn() {
  return S.settings.cells && S.mode === "live" && S.settings.view !== "sat" && S.product && (S.product.type || "0") === "0";
}

// connected components on the 512x512 index array (8-connected)
function detectCells(data, kpp, thr) { return ALGO.detectCells(data, kpp, thr, CELL_MIN_KM2); }
// make sure frames 0..idx have cells and track links
function trackUpTo(idx) {
  const thr = S.settings.cellThr;
  const key = `${S.product.pid}|${thr}|${S.frames.length ? S.frames[0].url : ""}`;
  if (cellCache.key !== key) {
    for (const f of S.frames) f.cells = null;
    Object.assign(cellCache, { key, tracked: 0, nextId: 1 });
  }
  for (let i = 0; i <= idx && i < S.frames.length; i++) {
    const f = S.frames[i];
    if (!f.data) return false;               // wait until every earlier frame is decoded
    if (f.cells) continue;
    const kpp = S.product.km / (frameN(f.data) / 2);
    if (WK) {
      // detection runs in the background worker; link the tracks once the results are back
      if (f.cellsKey !== key) { f.cellsKey = key; f.rawCells = null; WK.call("cells", { data: f.data, kpp, thr, minKm2: CELL_MIN_KM2 }).then(r => { if (f.cellsKey === key) { f.rawCells = r.cells; draw(); renderCellPanel(); } }).catch(() => {}); }
      if (!f.rawCells) return false;
      f.cells = f.rawCells.map(c => ({ ...c }));
    } else f.cells = detectCells(f.data, kpp, thr);
    const prev = i > 0 ? S.frames[i - 1] : null;
    if (prev && prev.cells) linkCells(prev, f); else f.cells.forEach(c => { c.id = cellCache.nextId++; c.age = 1; });
    for (const c of f.cells) c.hist = (c.hist || []).concat([{ t: +f.time, max: c.max, area: c.area }]).slice(-6);
  }
  return true;
}

function linkCells(prev, cur) {
  const dtH = (cur.time - prev.time) / 3600e3;
  if (dtH <= 0 || dtH > 0.5) { cur.cells.forEach(c => { c.id = cellCache.nextId++; c.age = 1; }); return; }
  const maxD = CELL_MAX_SPEED * dtH + 4;
  const pairs = [];
  cur.cells.forEach((c, i) => prev.cells.forEach((p, j) => {
    const px = p.x + (p.vx || 0) * dtH, py = p.y + (p.vy || 0) * dtH;   // predicted position
    const d = Math.hypot(c.x - px, c.y - py);
    if (d < maxD) pairs.push([d + Math.abs(Math.log(c.area / p.area)) * 3, i, j]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const usedC = new Set(), usedP = new Set();
  for (const [, i, j] of pairs) {
    if (usedC.has(i) || usedP.has(j)) continue;
    usedC.add(i); usedP.add(j);
    const c = cur.cells[i], p = prev.cells[j];
    c.id = p.id; c.age = (p.age || 1) + 1; c.hist = p.hist || [];
    const vx = (c.x - p.x) / dtH, vy = (c.y - p.y) / dtH;
    c.vx = p.vx == null ? vx : 0.5 * vx + 0.5 * p.vx;
    c.vy = p.vy == null ? vy : 0.5 * vy + 0.5 * p.vy;
  }
  cur.cells.forEach((c, i) => { if (!usedC.has(i)) { c.id = cellCache.nextId++; c.age = 1; } });
}

function currentCells() {
  if (!cellsOn() || !S.frames.length) return null;
  if (!trackUpTo(S.idx)) return null;
  return S.frames[S.idx].cells || null;
}

// closest approach of a moving cell to home in the next `maxH` hours
function homeApproach(c, maxH = 1.5) {
  if (!S.cfg || !S.radar) return null;
  const [hx, hy] = latLonToKm(S.cfg.home.lat, S.cfg.home.lon);
  const rx = hx - c.x, ry = hy - c.y;
  const now = Math.hypot(rx, ry);
  const cellR = Math.sqrt(c.area / Math.PI);
  if (now <= cellR) return { now, t: 0, miss: 0, over: true };
  if (c.vx == null || c.age < 2) return { now, t: null };
  const v2 = c.vx * c.vx + c.vy * c.vy;
  if (v2 < 25) return { now, t: null };                       // slower than 5 km/h: treat as stationary
  const t = Math.max(0, Math.min(maxH, (rx * c.vx + ry * c.vy) / v2));
  const miss = Math.hypot(c.x + c.vx * t - hx, c.y + c.vy * t - hy);
  return { now, t, miss, hits: t > 0 && t < maxH && miss <= CELL_HOME_RADIUS + cellR };
}

// intensity trend over the last ~15 minutes: +1 strengthening, -1 weakening, 0 steady
function cellTrend(c) {
  const h = c.hist || [];
  if (h.length < 3) return 0;
  const a = h[h.length - 3], b = h[h.length - 1];
  const dz = REFL_DBZ[Math.min(14, b.max)] - REFL_DBZ[Math.min(14, a.max)];
  const da = (b.area - a.area) / Math.max(1, a.area);
  if (dz >= 3 || (dz >= 0 && da > 0.35)) return 1;
  if (dz <= -3 || (dz <= 0 && da < -0.35)) return -1;
  return 0;
}
const trendIcon = t => (t > 0 ? "<b class='hot'>▲ strengthening</b>" : t < 0 ? "<span class='dim'>▼ weakening</span>" : "<span class='dim'>steady</span>");

// ---------------------------------------------------------------- how high the radar is looking
// The lowest scan (taken as 0.5 degrees, typical for BoM) climbs with distance and the Earth curves away under
// it: roughly 1 km above the radar at 80 km, 3 km at 165 km, 6 km at 255 km, 13 km at 400 km, 19 km at 500 km.
// Far from the radar a cell's dBZ is measured high in the storm (or over the top of it), and the beam is wide
// enough to be only partly filled, so it says little about the rain, hail or wind at the ground.
const BEAM_NOTE_KM = 3, BEAM_HIGH_KM = 6;
function beamHeightKm(rangeKm, elevDeg = 0.5) { return rangeKm * Math.sin(elevDeg * Math.PI / 180) + rangeKm * rangeKm / (2 * 8495); }
// rough beam height above the radar at a point on the live single-radar view (null on the national map, satellite,
// forecast or raw volumes, and outside the product's own coverage)
function liveBeamKm(x, y) {
  if (!S.radar || S.mode !== "live" || isNational() || S.settings.view === "sat" || S.settings.view === "fc") return null;
  if (!S.product || !["0", "2"].includes(S.product.type || "0")) return null;
  if (S.product.km && Math.max(Math.abs(x), Math.abs(y)) > S.product.km) return null;
  return beamHeightKm(Math.hypot(x, y));
}
const beamShort = b => `~${b < 10 ? b.toFixed(1) : Math.round(b)} km up`;
function beamCaveat(b) {
  if (b == null || b < BEAM_NOTE_KM) return "";
  return b >= BEAM_HIGH_KM
    ? `The radar beam is roughly ${b < 10 ? b.toFixed(1) : Math.round(b)} km up at this range: it is looking at the upper part of the storm, so what reaches the ground can differ a lot from what is shown (often stronger), and shallow storms are missed altogether.`
    : `The radar beam is roughly ${b.toFixed(1)} km up at this range, above the lowest part of the storm: intensity at the ground may differ from what is shown.`;
}

function drawCells() {
  const cells = currentCells();
  if (!cells) return;
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${11 * d}px "Barlow Semi Condensed", sans-serif`;
  for (const c of cells) {
    const hit = homeApproach(c)?.hits;
    ctx.strokeStyle = hit ? "#ef6f5c" : "rgba(255,255,255,.85)";
    ctx.lineWidth = (hit ? 2 : 1.2) * d;
    if (c.hull.length > 2) {
      ctx.beginPath();
      c.hull.forEach(([x, y], i) => { const [sx, sy] = kmToScreen(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.closePath(); ctx.stroke();
    }
    const [cx, cy] = kmToScreen(c.x, c.y);
    if (c.vx != null && c.age >= 2) {
      const [ex, ey] = kmToScreen(c.x + c.vx, c.y + c.vy);      // 60 min ahead
      ctx.setLineDash([4 * d, 3 * d]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
      for (const f of [0.25, 0.5, 0.75, 1]) {
        const [tx, ty] = kmToScreen(c.x + c.vx * f, c.y + c.vy * f);
        ctx.beginPath(); ctx.arc(tx, ty, (f === 1 ? 3.5 : 2.2) * d, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle; ctx.fill();
      }
    }
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(cx, cy, 2.5 * d, 0, Math.PI * 2); ctx.fill();
    const tr = cellTrend(c);
    // range caveat: far from the radar the beam is high in the storm, so the label says how high (one line, to keep clusters readable)
    const beam = liveBeamKm(c.x, c.y), far = beam != null && beam >= BEAM_NOTE_KM;
    const lab = `${far && beam >= BEAM_HIGH_KM ? "~" : ""}${Math.round(REFL_DBZ[Math.min(14, c.max)])}${tr > 0 ? "▲" : tr < 0 ? "▼" : ""}`;
    const note = far ? ` ↑${beam < 10 ? beam.toFixed(1) : Math.round(beam)} km` : "";
    const w1 = ctx.measureText(lab).width, w2 = note ? ctx.measureText(note).width : 0;
    ctx.fillStyle = "rgba(15,26,32,.85)"; ctx.fillRect(cx + 5 * d, cy - 15 * d, w1 + w2 + 8 * d, 14 * d);
    ctx.fillStyle = "#f2d6a0"; ctx.fillText(lab, cx + 9 * d, cy - 4 * d);
    if (note) { ctx.fillStyle = beam >= BEAM_HIGH_KM ? "#ff9a7a" : "#9fb4bd"; ctx.fillText(note, cx + 9 * d + w1, cy - 4 * d); }
  }
}

function renderCellPanel() {
  const panel = $("cellPanel");
  if (!cellsOn()) { panel.hidden = true; return; }
  panel.hidden = false;
  const cells = currentCells();
  const body = $("cellBody");
  if (!cells) { body.innerHTML = "<p class='dim'>Tracking needs every frame in the loop decoded. Hang on a moment.</p>"; return; }
  const home = S.cfg.home;
  const rows = cells.map(c => ({ c, a: homeApproach(c) })).filter(o => o.a);
  const coming = rows.filter(o => o.a.over || o.a.hits).sort((a, b) => (a.a.t ?? 0) - (b.a.t ?? 0));
  const moving = cells.filter(c => c.age >= 2 && c.vx != null);
  let html = `<p class="dim">${cells.length} cell${cells.length === 1 ? "" : "s"} above ~${Math.round(REFL_DBZ[S.settings.cellThr])} dBZ, ${moving.length} with a track.</p>`;
  if (!coming.length) html += `<p>Nothing heading for ${esc(home.name)} in the next 90 minutes.</p>`;
  for (const { c, a } of coming.slice(0, 6)) {
    const [lat, lon] = kmToLatLon(c.x, c.y);
    const hh = haversine(home.lat, home.lon, lat, lon);
    const spd = Math.hypot(c.vx || 0, c.vy || 0), dir = bearingOf(c.vx || 0, c.vy || 0);
    const what = a.over ? `<b class="hot">over ${esc(home.name)} now</b>`
      : `<b class="hot">reaches ${esc(home.name)} in ~${Math.max(1, Math.round(a.t * 60))} min</b>${a.miss > 3 ? `, passing ${a.miss.toFixed(0)} km away` : ""}`;
    const bm = liveBeamKm(c.x, c.y);
    html += `<div class="cell-row"><span class="cell-dbz">${bm != null && bm >= BEAM_HIGH_KM ? "~" : ""}${Math.round(REFL_DBZ[Math.min(14, c.max)])} dBZ</span>
      <span>${hh.dist.toFixed(0)} km ${compass(hh.brg)}${spd >= 5 ? `, moving ${compass(dir)} at ${spd.toFixed(0)} km/h` : ", near stationary"}. ${what}. ${trendIcon(cellTrend(c))}${bm != null && bm >= BEAM_NOTE_KM ? ` <span class="beam-note">beam ${beamShort(bm)}</span>` : ""}</span></div>`;
  }
  // strongest cells anywhere in view, with their trend
  const strong = cells.filter(c => !coming.some(o => o.c === c)).sort((a, b) => b.max - a.max || b.area - a.area).slice(0, 3);
  if (strong.length) {
    html += `<p class="dim" style="margin-top:10px">Strongest elsewhere</p>`;
    for (const c of strong) {
      const [lat, lon] = kmToLatLon(c.x, c.y), hh = haversine(home.lat, home.lon, lat, lon);
      const spd = Math.hypot(c.vx || 0, c.vy || 0), dir = bearingOf(c.vx || 0, c.vy || 0);
      const bm = liveBeamKm(c.x, c.y);
      html += `<div class="cell-row"><span class="cell-dbz">${bm != null && bm >= BEAM_HIGH_KM ? "~" : ""}${Math.round(REFL_DBZ[Math.min(14, c.max)])} dBZ</span>
        <span>${hh.dist.toFixed(0)} km ${compass(hh.brg)} of ${esc(home.name)}, ${c.area.toFixed(0)} km²${c.age >= 2 && spd >= 5 ? `, moving ${compass(dir)} at ${spd.toFixed(0)} km/h` : ""}. ${trendIcon(cellTrend(c))}${bm != null && bm >= BEAM_NOTE_KM ? ` <span class="beam-note">beam ${beamShort(bm)}</span>` : ""}</span></div>`;
    }
  }
  const listed = coming.slice(0, 6).map(o => o.c).concat(strong);
  const highest = listed.reduce((m, c) => Math.max(m, liveBeamKm(c.x, c.y) ?? 0), 0);
  if (highest >= BEAM_NOTE_KM)
    html += `<p class="beam-warn">${beamCaveat(highest).replace("at this range", "at the farthest cell listed")}${highest >= BEAM_HIGH_KM ? " A closer radar (radar picker) or a shorter range gives a truer reading." : ""}</p>`;
  body.innerHTML = html;
}
