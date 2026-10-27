/* Radarhound: supercell / tornado toolkit.
   - Archive volumes: server-side mesocyclone, TVS and debris (TDS) detections drawn as markers.
   - Vrot probe: max inbound/outbound within 2.5 km of the cursor on any velocity pane.
   - Live: couplet finder on BoM's Doppler wind images (coarse, but real time).
   - Environment: STP / SCP / shear / helicity forecast layers and contours over the radar.
   Southern hemisphere aware: cyclonic = clockwise. Uses globals from app.js / layers.js. */
"use strict";

// ---------------------------------------------------------------- archive detections
S.rot = { cache: new Map(), current: null };
function ensureRotation() {
  if (!S.settings.rotDet || S.mode !== "raw" || !S.raw.scans.length) { S.rot.current = null; return; }
  const scan = S.raw.scans[S.raw.idx], key = `${S.radar.id}/${S.raw.date}/${scan}`;
  const hit = S.rot.cache.get(key);
  if (hit) { S.rot.current = hit.list ? hit : null; return; }
  S.rot.current = null;                          // never show another scan's (or radar's) markers meanwhile
  const e = { key, list: null };
  S.rot.cache.set(key, e);
  fetch(`/api/archive/rotation?radar=${S.radar.id}&date=${S.raw.date}&time=${scan}`).then(r => (r.ok ? r.json() : null)).then(r => {
    e.list = r ? r.detections : [];
    if (S.raw.scans[S.raw.idx] === scan) { S.rot.current = e; draw(); renderRotPanel(); }
  }).catch(() => { e.list = []; if (S.raw.scans[S.raw.idx] === scan) { S.rot.current = e; draw(); } });
}

function drawRotation() {
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.mode === "raw" && S.settings.rotDet && S.rot.current && S.rot.current.list) {
    for (const m of S.rot.current.list) {
      const [sx, sy] = kmToScreen(m.x, m.y);
      const col = m.rank === "strong" ? "#ff3b3b" : m.rank === "moderate" ? "#ff9a2e" : "#f7e83a";
      const r = Math.max(9 * d, (m.diam / 2) * S.view.scale);
      ctx.lineWidth = (m.rank === "strong" ? 3 : 2) * d; ctx.strokeStyle = col;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
      if (m.tvs) {          // inverted red triangle = tornado vortex signature
        ctx.fillStyle = "#ff1a1a"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5 * d;
        ctx.beginPath(); ctx.moveTo(sx - 9 * d, sy - 7 * d); ctx.lineTo(sx + 9 * d, sy - 7 * d); ctx.lineTo(sx, sy + 9 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      if (m.tds) {          // debris ball flag
        ctx.font = `bold ${12 * d}px "Barlow Semi Condensed", sans-serif`;
        ctx.fillStyle = "#000"; ctx.fillRect(sx + r + 2 * d, sy - 9 * d, 40 * d, 16 * d);
        ctx.fillStyle = "#ff4fd8"; ctx.fillText("DEBRIS", sx + r + 4 * d, sy + 3 * d);
      }
      ctx.font = `600 ${11 * d}px "Barlow Semi Condensed", sans-serif`;
      const lab = `${m.tvs ? "TVS" : "M"} ${Math.round(m.vrot * 1.944)} kt`;
      ctx.lineWidth = 3 * d; ctx.strokeStyle = "rgba(10,18,22,.9)"; ctx.strokeText(lab, sx + r + 3 * d, sy - 11 * d);
      ctx.fillStyle = col; ctx.fillText(lab, sx + r + 3 * d, sy - 11 * d);
    }
  }
  if (S.mode === "live" && S.settings.couplets) drawCouplets();
}

function rotationNear(x, y) {
  const L = S.mode === "raw" ? S.rot.current?.list : liveCouplets();
  if (!L) return null;
  let best = null;
  for (const m of L) { const dd = Math.hypot(m.x - x, m.y - y); if (!best || dd < best.dd) best = { m, dd }; }
  return best && best.dd * S.view.scale < 16 * dpr() ? best.m : null;
}

function renderRotPanel() {
  const panel = $("rotPanel"), body = $("rotBody");
  const raw = S.mode === "raw" && S.settings.rotDet, live = S.mode === "live" && S.settings.couplets && liveDopplerFrame();
  if (!raw && !live) { panel.hidden = true; return; }
  panel.hidden = false;
  const home = S.cfg.home;
  const rows = (raw ? S.rot.current?.list : liveCouplets()) || [];
  if (raw && !S.rot.current) { body.innerHTML = "<p class='dim'>Scanning this volume for rotation…</p>"; return; }
  if (!rows.length) {
    body.innerHTML = `<p class="dim">${raw ? "No mesocyclones or tornado vortex signatures in this volume." : "No cyclonic couplets in the live Doppler image."}</p>`;
    return;
  }
  body.innerHTML = rows.slice(0, 8).map(m => {
    const [lat, lon] = kmToLatLon(m.x, m.y), hh = haversine(home.lat, home.lon, lat, lon);
    const what = raw ? `${m.tvs ? "<b class='hot'>TVS</b>" : "Mesocyclone"} (${m.rank})${m.tds ? ", <b style='color:#ff4fd8'>possible debris</b>" : ""}`
      : "Doppler couplet";
    const detail = raw ? `Vrot ${Math.round(m.vrot * 1.944)} kt, ${m.diam} km wide, ${m.base.toFixed(1)}\u2013${m.top.toFixed(1)} km high over ${m.tilts} tilts`
      : `\u0394V ${Math.round(m.dv)} km/h across ${m.diam.toFixed(1)} km`;
    return `<div class="cell-row"><span class="cell-dbz">${Math.round((raw ? m.vrot * 1.944 : m.dv / 3.6 / 2 * 1.944))} kt</span>
      <span>${what}. ${detail}. ${hh.dist.toFixed(0)} km ${compass(hh.brg)} of ${home.name}.</span></div>`;
  }).join("") + `<p class="dim" style="margin-top:8px">${raw ? "Automated: confirm on storm-relative velocity, CC and a cross-section." : "BoM's live Doppler is coarse (10 km/h steps); treat as a heads-up."}</p>`;
}

// ---------------------------------------------------------------- Vrot probe for velocity panes
function vrotProbe(sw, x, y, radiusKm = 2.5) {
  let vmax = -Infinity, vmin = Infinity, pmax = null, pmin = null;
  const st = 0.35;
  for (let dy = -radiusKm; dy <= radiusKm; dy += st) for (let dx = -radiusKm; dx <= radiusKm; dx += st) {
    if (dx * dx + dy * dy > radiusKm * radiusKm) continue;
    const r = rawValueAt(sw, x + dx, y + dy);
    if (r.value == null) continue;
    if (r.value > vmax) { vmax = r.value; pmax = [dx, dy]; }
    if (r.value < vmin) { vmin = r.value; pmin = [dx, dy]; }
  }
  if (pmax == null || pmin == null || vmax <= 0 || vmin >= 0) return null;
  return { vrot: (vmax - vmin) / 2, vin: vmin, vout: vmax, span: Math.hypot(pmax[0] - pmin[0], pmax[1] - pmin[1]) };
}

// ---------------------------------------------------------------- live couplets on BoM Doppler wind images
function liveDopplerFrame() {
  // the Doppler pane: pane 1 if it shows Doppler, else any pane whose product is Doppler wind
  for (const p of activePanes()) {
    const lv = p.i === 0 ? (S.product && (S.product.type === "2") ? { frame: S.frames[S.idx], prod: S.product } : null) : paneLive(p);
    if (lv && lv.prod && lv.prod.type === "2" && lv.frame && lv.frame.data) return lv;
  }
  return null;
}
// reflectivity frame (128 km or similar) closest in time, to keep couplets inside real storms
function liveReflFrame(t) {
  if (S.product && (S.product.type || "0") === "0" && S.frames[S.idx] && S.frames[S.idx].data) return { frame: S.frames[S.idx], prod: S.product };
  const prod = S.radar.products.find(x => x.suffix === "3" && x.available) || S.radar.products.find(x => (x.type || "0") === "0" && x.available);
  if (!prod) return null;
  const st = liveStore(prod);
  let best = null;
  for (const f of st.frames) if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
  if (!best || Math.abs(best.time - t) > 8 * 60e3) return null;
  if (!best.data) { decodeStoreFrame(st, best); return null; }
  return { frame: best, prod };
}
function liveCouplets() {
  const lv = liveDopplerFrame();
  if (!lv) return [];
  const f = lv.frame;
  if (f.couplets) return f.couplets;
  const rf = liveReflFrame(f.time);
  if (!rf) return [];                                        // wait for a reflectivity frame to gate against
  const kpp = lv.prod.km / (frameN(f.data) / 2), rkpp = rf.prod.km / (frameN(rf.frame.data) / 2), south = S.radar.lat < 0;
  if (WK) {
    if (!f.coupletsPending) {
      f.coupletsPending = true;
      WK.call("couplets", { data: f.data, kpp, refl: rf.frame.data, rkpp, southern: south })
        .then(r => { f.couplets = r.couplets; draw(); renderRotPanel(); }).catch(() => { f.coupletsPending = false; });
    }
    return [];
  }
  f.couplets = ALGO.couplets(f.data, kpp, rf.frame.data, rkpp, south);
  return f.couplets;
}
function drawCouplets() {
  const L = liveCouplets(), d = dpr();
  if (!L.length) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const c of L) {
    const [sx, sy] = kmToScreen(c.x, c.y), col = c.dv >= 100 ? "#ff3b3b" : c.dv >= 80 ? "#ff9a2e" : "#f7e83a";
    ctx.strokeStyle = col; ctx.lineWidth = 2.2 * d; ctx.setLineDash([4 * d, 3 * d]);
    ctx.beginPath(); ctx.arc(sx, sy, 11 * d, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `600 ${11 * d}px "Barlow Semi Condensed", sans-serif`;
    const lab = `\u0394V ${Math.round(c.dv)}`;
    ctx.lineWidth = 3 * d; ctx.strokeStyle = "rgba(10,18,22,.9)"; ctx.strokeText(lab, sx + 13 * d, sy - 8 * d);
    ctx.fillStyle = col; ctx.fillText(lab, sx + 13 * d, sy - 8 * d);
  }
}

// ---------------------------------------------------------------- environment contours over the radar (STP / SCP)
const ENV = { stp: { key: "stp", levels: [0.5, 1, 2, 4], name: "STP" }, scp: { key: "scp", levels: [1, 4, 8, 16], name: "SCP" },
  srh1: { key: "srh1", levels: [100, 150, 250], name: "0\u20131 km SRH" }, shear6: { key: "shear6", levels: [30, 40, 50], name: "0\u20136 km shear" } };
function drawEnvOverlay() {
  const e = ENV[S.settings.envOverlay];
  if (!e || S.settings.view === "fc" || !S.radar) return;
  const D = fcData("svr", S.settings.fcModel || "best");
  if (!D) return;
  const t = currentTime();
  if (!t) return;
  let ti = 0, bestd = Infinity;
  D.time.forEach((tt, i) => { const dd = Math.abs(tt * 1000 - t); if (dd < bestd) { bestd = dd; ti = i; } });
  if (bestd > 3 * 3600e3) return;
  const d = dpr();
  const L = isoSegments(`env|${D.fetched}|${e.key}|${ti}`, 61, D.half, (x, y) => fcSample(e.key, x, y, ti, D), () => e.levels);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `bold ${10 * d}px "Barlow Semi Condensed", sans-serif`;
  L.forEach(({ lev, segs }, li) => {
    ctx.strokeStyle = ctx.fillStyle = ["#7dd36a", "#f7e83a", "#f07b17", "#e23ad6"][li];
    ctx.lineWidth = (1.4 + li * 0.5) * d;
    ctx.setLineDash(li === 0 ? [5 * d, 4 * d] : []);
    strokeSegments(segs, `${e.name} ${lev}`);
    ctx.setLineDash([]);
  });
}

// severe-weather forecast layers (computed on the server from the model wind profile)
Object.assign(FC_LAYERS, {
  stp: { name: "Significant tornado parameter", unit: "", kind: "svr", key: "stp", sc: scale([[0.25, "#2a4b5c"], [0.5, "#3fb0a0"], [1, "#f7e83a"], [2, "#f07b17"], [4, "#e0261f"], [8, "#e23ad6"]], { clearBelow: true }), group: "Severe weather" },
  scp: { name: "Supercell composite", unit: "", kind: "svr", key: "scp", sc: scale([[0.5, "#2a4b5c"], [1, "#3fb0a0"], [4, "#f7e83a"], [8, "#f07b17"], [16, "#e0261f"], [30, "#e23ad6"]], { clearBelow: true }), group: "Severe weather" },
  shear6: { name: "0\u20136 km bulk shear", unit: "kt", kind: "svr", key: "shear6", sc: scale([[10, "#25306e"], [20, "#2f6fb0"], [30, "#3fb0a0"], [40, "#f7e83a"], [50, "#f07b17"], [60, "#e0261f"], [80, "#e23ad6"]]), group: "Severe weather" },
  srh1: { name: "0\u20131 km helicity (cyclonic)", unit: "m\u00b2/s\u00b2", kind: "svr", key: "srh1", sc: scale([[25, "#2a4b5c"], [50, "#3fb0a0"], [100, "#f7e83a"], [150, "#f07b17"], [250, "#e0261f"], [400, "#e23ad6"]], { clearBelow: true }), group: "Severe weather" },
  srh3: { name: "0\u20133 km helicity (cyclonic)", unit: "m\u00b2/s\u00b2", kind: "svr", key: "srh3", sc: scale([[50, "#2a4b5c"], [100, "#3fb0a0"], [150, "#f7e83a"], [250, "#f07b17"], [400, "#e0261f"], [600, "#e23ad6"]], { clearBelow: true }), group: "Severe weather" },
  lcl: { name: "Cloud base (LCL)", unit: "m", kind: "svr", key: "lcl", sc: scale([[250, "#e23ad6"], [750, "#e0261f"], [1000, "#f07b17"], [1500, "#f7e83a"], [2000, "#3fb0a0"], [3000, "#25306e"]]), group: "Severe weather" },
  cin: { name: "CIN (cap)", unit: "J/kg", kind: "svr", key: "cin", sc: scale([[-300, "#3b2f8f"], [-150, "#2f6fb0"], [-50, "#3fb0a0"], [-10, "#7dd36a"], [0, "#25306e"]]), group: "Severe weather" },
});
