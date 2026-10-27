/* Radarhound: one-click modes (presets) and Radarhound's own automated warnings. Uses globals from app.js. */
"use strict";

// ---------------------------------------------------------------- preset modes
const BASE_MODE = { view: "radar", layout: 1, envOverlay: "none", contour: "none", cells: false, couplets: true, rotDet: true, ltgDensity: false, lightning: true };
const MODES = [
  { id: "storm", name: "Storm watch", tag: "Live", desc: "128 km reflectivity beside Doppler wind, storm cells with arrival times, lightning, live couplets and the supercell composite contoured on top.",
    set: { radar: "home", product: "3", view: "radar", layout: 2, paneSrc: { 1: { live: "I" } }, cells: true, couplets: true, envOverlay: "scp", stations: true } },
  { id: "national", name: "National overview", tag: "Live", desc: "Every BoM radar stitched together, lightning, all-states warnings and storm cells across Australia.",
    set: { radar: "AUS", product: "N", view: "radar", layout: 1, cells: true, lightning: true } },
  { id: "rotation", name: "Rotation hunt", tag: "Archive", desc: "Reflectivity, storm-relative velocity, correlation coefficient and ZDR in four panes, with mesocyclone / TVS markers and rotation contours.",
    set: { radar: "home", product: "raw", view: "radar", layout: 4, moment: "DBZH", elev: 0.5, paneSrc: { 1: { raw: "SRV" }, 2: { raw: "RHOHV" }, 3: { raw: "ZDR" } }, rotDet: true, contour: "ROT" } },
  { id: "tornadolive", name: "Tornado watch", tag: "Live", desc: "Jumps to the radar nearest the highest-rated storm: reflectivity beside live Doppler, couplet finder, storm cells, STP contours, and supercell / tornado ratings.",
    set: { radar: "storm", product: "3", view: "radar", layout: 2, paneSrc: { 1: { live: "I" } }, cells: true, couplets: true, envOverlay: "stp", wxw: true } },
  { id: "tornado", name: "Tornado and debris", tag: "Archive", desc: "Lowest-tilt storm-relative velocity beside correlation coefficient: look for a tight couplet sitting on a low-CC debris ball.",
    set: { radar: "home", product: "raw", view: "radar", layout: 2, moment: "SRV", elev: 0.5, paneSrc: { 1: { raw: "RHOHV" } }, rotDet: true, contour: "none" } },
  { id: "hail", name: "Hail", tag: "Archive", desc: "Reflectivity, MESH hail size, ZDR and hydrometeor class, with hail-size contours on every pane.",
    set: { radar: "home", product: "raw", view: "radar", layout: 4, moment: "DBZH", elev: 0.5, paneSrc: { 1: { raw: "MESH" }, 2: { raw: "ZDR" }, 3: { raw: "HCA" } }, contour: "MESH" } },
  { id: "supercell", name: "Supercell environment", tag: "Forecast", desc: "SCP, STP, 0\u20136 km shear and 0\u20131 km helicity side by side: where storms could organise and rotate.",
    set: { radar: "home", view: "fc", layout: 4, fcLayer: "scp", paneSrc: { 1: { fc: "l:stp" }, 2: { fc: "l:shear6" }, 3: { fc: "l:srh1" } }, fcIso: "none", fcParticles: true } },
  { id: "shear", name: "Wind shear", tag: "Forecast", desc: "0\u20136 km bulk shear beside 0\u20133 km helicity, with low-level wind particles.",
    set: { radar: "home", view: "fc", layout: 2, fcLayer: "shear6", paneSrc: { 1: { fc: "l:srh3" } }, fcParticles: true } },
  { id: "cape", name: "Instability (CAPE)", tag: "Forecast", desc: "CAPE, lifted index, CIN (the cap) and cloud-base height: fuel, lift and how hard it is to get storms going.",
    set: { radar: "home", view: "fc", layout: 4, fcLayer: "cape", paneSrc: { 1: { fc: "l:li" }, 2: { fc: "l:cin" }, 3: { fc: "l:lcl" } }, fcParticles: false } },
  { id: "jet", name: "Jet stream", tag: "Forecast", desc: "250 hPa winds with jet particles and geopotential height contours.",
    set: { radar: "home", view: "fc", layout: 1, fcLayer: "uwind", fcLevel: 250, fcIso: "gph", fcParticles: true } },
  { id: "synoptic", name: "Synoptic chart", tag: "Forecast", desc: "Mean sea level pressure with isobars and surface wind particles.",
    set: { radar: "home", view: "fc", layout: 1, fcLayer: "mslp", fcIso: "mslp", fcParticles: true } },
  { id: "satellite", name: "Satellite and lightning", tag: "Live", desc: "Enhanced infrared cloud-top temperatures with lightning and strike density.",
    set: { radar: "home", view: "sat", layout: 1, satLayer: "ir13e", lightning: true, ltgDensity: true } },
  { id: "fire", name: "Fire weather", tag: "Forecast", desc: "McArthur fire danger, gusts, humidity and temperature, with satellite fire hotspots.",
    set: { radar: "home", view: "fc", layout: 4, fcLayer: "ffdi", paneSrc: { 1: { fc: "l:gust" }, 2: { fc: "l:rh" }, 3: { fc: "l:temp" } }, fires: true, fcParticles: true } },
  { id: "smoke", name: "Smoke and air", tag: "Forecast", desc: "PM2.5 beside carbon monoxide (a bushfire smoke tracer), with fire hotspots.",
    set: { radar: "home", view: "fc", layout: 2, fcLayer: "pm25", paneSrc: { 1: { fc: "l:co" } }, fires: true } },
  { id: "rain", name: "Heavy rain and flooding", tag: "Live", desc: "Reflectivity beside rainfall since 9am, slow-moving cells highlighted by the warning engine.",
    set: { radar: "home", product: "3", view: "radar", layout: 2, paneSrc: { 1: { live: "C" } }, cells: true } },
  { id: "surf", name: "Surf and sea", tag: "Forecast", desc: "Swell height with swell-direction particles beside swell period.",
    set: { radar: "home", view: "fc", layout: 2, fcLayer: "swell", paneSrc: { 1: { fc: "l:sper" } }, fcParticles: true } },
];

// on the national map, single-radar modes use the radar nearest to where you're looking
function radarNearView() {
  const list = [...S.cfg.radars.filter(r => !r.national && r.lat != null), ...(S.cfg.all_radars || [])];
  let best = null;
  for (const r of list) { const [x, y] = latLonToKm(r.lat, r.lon), d = Math.hypot(x - S.view.cx, y - S.view.cy); if (!best || d < best.d) best = { r, d }; }
  return best && best.r;
}
async function applyMode(m) {
  if (isNational() && m.set.radar === "home") {
    const near = radarNearView();
    if (near) {
      $("modesList").innerHTML = `<p class="dim">Fetching ${esc(near.name)} radar…</p>`;
      if (!S.cfg.radars.some(r => r.id === near.id))
        await fetch("/api/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radar: near.id }) }).catch(() => null);
      m = { ...m, set: { ...m.set, radar: near.id } };
    }
  }
  const st = S.settings, set = { ...BASE_MODE, ...m.set };
  for (const [k, v] of Object.entries(set)) {
    if (k === "paneSrc") for (const [i, src] of Object.entries(v)) Object.assign(st.paneSrc[+i], src);
    else if (k === "radar" && v === "storm") {
      // the most threatening storm's nearest radar, zoomed in on the storm after the reload
      const top = (S.wxw.storms || []).find(x => x.nearest_radar);
      if (top) {
        $("modesList").innerHTML = `<p class="dim">Fetching ${esc(top.nearest_radar.name)} radar…</p>`;
        const ok = await fetch("/api/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radar: top.nearest_radar.id }) }).then(r => r.ok).catch(() => false);
        if (ok) {
          st.radar = top.nearest_radar.id;
          try { sessionStorage.setItem("radarhound.zoomTo", JSON.stringify({ lat: top.lat, lon: top.lon, km: 45 })); } catch { /* private mode */ }
          continue;
        }
      }
      st.radar = (S.cfg.radars.find(r => !r.national) || S.cfg.radars[0]).id;
    }
    else if (k === "radar") st.radar = v === "home" ? (S.cfg.radars.find(r => !r.national) || S.cfg.radars[0]).id : v;
    else st[k] = v;
  }
  st.mode = m.id;
  save();
  location.reload();             // the cleanest way to bring every control in line with the new settings
}
function saveCustomMode() {
  const name = prompt("Name this mode", "My mode");
  if (!name) return;
  const keys = ["view", "layout", "product", "moment", "elev", "fcLayer", "fcLevel", "fcModel", "fcIso", "fcParticles", "envOverlay", "contour",
    "cells", "couplets", "rotDet", "lightning", "ltgDensity", "satLayer", "stations", "fires", "roads", "mosaic", "townLabels"];
  const set = { radar: S.settings.radar, paneSrc: JSON.parse(JSON.stringify(S.settings.paneSrc.slice(1).reduce((a, s, i) => ({ ...a, [i + 1]: s }), {}))) };
  for (const k of keys) set[k] = S.settings[k];
  const custom = store.get("customModes", []);
  custom.push({ id: `c${Date.now()}`, name, tag: "Mine", desc: "Saved from your own setup.", set });
  store.set("customModes", custom);
  renderModes();
}
function renderModes() {
  const custom = store.get("customModes", []);
  const card = m => `<button class="mode-card${S.settings.mode === m.id ? " on" : ""}" data-id="${esc(m.id)}"><span class="mode-name">${esc(m.name)}<em>${esc(m.tag)}</em></span><span class="mode-desc">${esc(m.desc)}</span></button>`;
  $("modesList").innerHTML = MODES.map(card).join("")
    + (custom.length ? `<div class="mode-sep">Your modes</div>` + custom.map(m => card(m) + `<button class="link-btn mode-del" data-del="${m.id}">remove</button>`).join("") : "");
  $("modesList").querySelectorAll(".mode-card").forEach(b => b.onclick = () => applyMode([...MODES, ...custom].find(m => m.id === b.dataset.id)));
  $("modesList").querySelectorAll("[data-del]").forEach(b => b.onclick = () => { store.set("customModes", custom.filter(m => m.id !== b.dataset.del)); renderModes(); });
}
$("modesChip").onclick = () => { renderModes(); $("modesDlg").hidden = false; };
$("modesClose").onclick = () => { $("modesDlg").hidden = true; };
$("modesSave").onclick = saveCustomMode;
$("modesDlg").onclick = e => { if (e.target === $("modesDlg")) $("modesDlg").hidden = true; };
(() => { const m = MODES.find(x => x.id === S.settings.mode) || store.get("customModes", []).find(x => x.id === S.settings.mode); if (m) $("modesChip").textContent = `\u25e7 ${m.name}`; })();

// ---------------------------------------------------------------- Radarhound automated warnings
const THREAT_COL = { high: "#ff3b3b", moderate: "#ffa500", low: "#5f7f88" };
const badge = (label, lvl) => `<span class="thr" style="--c:${THREAT_COL[lvl] || "#5f7f88"}">${label} ${lvl === "high" ? "HIGH" : lvl === "moderate" ? "MOD" : "LOW"}</span>`;
function threatHtml(t, nr, lat, lon, open = true) {
  if (!t) return "";
  return `<div class="thr-row">${badge("Supercell", t.supercell)}${badge("Tornado", t.tornado)}${t.doppler ? "" : `<span class="thr-note">no Doppler yet</span>`}</div>
    <details class="thr-why"><summary>Why</summary><ul>${t.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul></details>
    ${nr && nr.id !== S.radar?.id ? `<button class="tbtn thr-open" data-radar="${nr.id}" data-lat="${lat}" data-lon="${lon}">Open ${esc(nr.name)} radar (Doppler)</button>` : ""}`;
}
function bindThreatButtons(root) {
  root.querySelectorAll(".thr-open").forEach(b => b.onclick = () => openRadar(b.dataset.radar, { doppler: true, lat: +b.dataset.lat, lon: +b.dataset.lon }));
}
const WXW_STYLE = {
  TOR: { col: "#ff2020", name: "Tornado warning" }, SVR: { col: "#ffa500", name: "Severe thunderstorm warning" }, FFW: { col: "#18d850", name: "Flash flood warning" },
  TOA: { col: "#ffff00", name: "Tornado watch", watch: true }, SVA: { col: "#db7093", name: "Severe thunderstorm watch", watch: true },
  WND: { col: "#d2b48c", name: "Damaging wind watch", watch: true }, HEA: { col: "#ff4fd8", name: "Extreme heat watch", watch: true },
  FWA: { col: "#ff4500", name: "Fire weather watch", watch: true },
};
S.wxw = { active: [], watches: [], recent: [], seen: new Set(), first: true };
async function loadWxWarnings() {
  const r = await fetch("/api/wxwarnings").then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!r) return;
  S.wxw.active = r.active; S.wxw.watches = r.watches; S.wxw.recent = r.recent; S.wxw.storms = r.storms || [];
  // flash the scope when a new warning covers home (the tone and voice come from alerts.js)
  const fresh = r.active.filter(w => !S.wxw.seen.has(w.event || w.id));
  r.active.forEach(w => S.wxw.seen.add(w.event || w.id));
  if (!S.wxw.first && fresh.some(w => w.home_inside)) wxwAlert();
  S.wxw.first = false;
  renderWxWarnings(); draw();
}
function wxwAlert() {
  $("scopeFrame").classList.add("flash"); setTimeout(() => $("scopeFrame").classList.remove("flash"), 1500);
}
function relevantWarnings() {
  if (!S.radar) return [];
  const live = S.wxw.active.filter(w => new Date(w.expires) > Date.now());     // hide expired ones straight away
  if (isNational()) return live;
  // a single radar: its own warnings, plus national-mosaic ones within its 512 km reach that it didn't cover itself
  const own = live.filter(w => w.source === S.radar.id);
  const nat = live.filter(w => w.source === "AUS" && Math.hypot(...latLonToKm(w.lat, w.lon)) <= 512
    && !own.some(o => Math.hypot(o.lat - w.lat, o.lon - w.lon) < 0.3));
  return own.concat(nat);
}
function relevantWatches() {
  if (!S.radar) return [];
  if (isNational()) return S.wxw.watches;
  return S.wxw.watches.filter(w => w.polygon.some(([la, lo]) => Math.hypot(...latLonToKm(la, lo)) <= 700));
}
// strongest storms with their supercell / tornado ratings, as a side-panel table
function relevantStorms() {
  if (!S.radar) return [];
  return (S.wxw.storms || []).filter(st => isNational() || Math.hypot(...latLonToKm(st.lat, st.lon)) <= 300);
}
function renderStorms() {
  const L = relevantStorms(), panel = $("stormPanel");
  if (!S.settings.wxw || !L.length) { panel.hidden = true; return; }
  panel.hidden = false;
  $("stormBody").innerHTML = L.slice(0, 8).map(st => `<div class="storm-row">
      <div class="storm-head"><b>${st.near ? `near ${esc(st.near)}` : `${st.lat.toFixed(2)}, ${st.lon.toFixed(2)}`}</b>
        <span class="dim">${st.dbz} dBZ${st.lightning ? `, ${st.lightning} strikes/10 min` : ""}${st.dir != null ? `, moving ${compass(st.dir)} ${st.speed} km/h` : ""}</span></div>
      ${threatHtml(st.threat, st.nearest_radar, st.lat, st.lon)}</div>`).join("")
    + `<p class="dim">Ratings combine the model environment (SCP, STP, shear, helicity, cloud base) with what the radar shows (core size, storm motion, rotation). Doppler-based rotation needs the storm within ~110 km of a radar.</p>`;
  bindThreatButtons($("stormBody"));
}
// small rating tags on the map next to storms rated moderate or high
function drawStormBadges() {
  if (!S.settings.wxw) return;
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `bold ${11 * d}px "Barlow Semi Condensed", sans-serif`;
  for (const st of relevantStorms()) {
    const t = st.threat;
    if (!t || (t.supercell === "low" && t.tornado === "low")) continue;
    const [sx, sy] = kmToScreen(...latLonToKm(st.lat, st.lon));
    if (sx < 0 || sy < 0 || sx > canvas.width || sy > canvas.height) continue;
    const parts = [];
    if (t.supercell !== "low") parts.push([`SUP ${t.supercell === "high" ? "HIGH" : "MOD"}`, THREAT_COL[t.supercell]]);
    if (t.tornado !== "low") parts.push([`TOR ${t.tornado === "high" ? "HIGH" : "MOD"}`, THREAT_COL[t.tornado]]);
    let x = sx + 14 * d;
    for (const [lab, col] of parts) {
      const w = ctx.measureText(lab).width + 10 * d;
      ctx.fillStyle = "rgba(8,14,18,.92)"; ctx.fillRect(x, sy - 24 * d, w, 17 * d);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5 * d; ctx.strokeRect(x, sy - 24 * d, w, 17 * d);
      ctx.fillStyle = col; ctx.fillText(lab, x + 5 * d, sy - 11 * d);
      x += w + 4 * d;
    }
  }
}
function drawWxWarnings() {
  drawStormBadges();
  if (!S.settings.wxw || !S.radar) return;
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const poly = (pts, col, dash, width, fill) => {
    ctx.beginPath();
    pts.forEach(([la, lo], i) => { const [sx, sy] = kmToScreen(...latLonToKm(la, lo)); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.setLineDash(dash.map(x => x * d)); ctx.strokeStyle = col; ctx.lineWidth = width * d; ctx.stroke(); ctx.setLineDash([]);
  };
  if (S.settings.watches) for (const w of relevantWatches()) poly(w.polygon, WXW_STYLE[w.type]?.col || "#fff", [10, 6], 2, null);
  for (const w of relevantWarnings()) {
    const col = WXW_STYLE[w.type]?.col || "#fff";
    poly(w.polygon, "rgba(0,0,0,.7)", [], 5, null);
    poly(w.polygon, col, [], 2.6, w.type === "TOR" ? "rgba(255,32,32,.12)" : null);
  }
}
// RadarScope-style impact tags: the threats at a glance
function impactTags(w) {
  const t = [];
  if (w.type === "TOR") t.push(["TORNADO POSSIBLE", "#ff2020"]);
  if (w.dv >= 70) t.push([`ROTATION ΔV ${w.dv}`, "#ff5a5a"]);
  if (w.dbz >= 59) t.push(["LARGE HAIL", "#e23ad6"]); else if (w.dbz >= 55) t.push(["HAIL", "#c070e0"]);
  if (w.type === "FFW" || (w.speed != null && w.speed < 10)) t.push(["FLASH FLOODING", "#18d850"]);
  if (w.lightning >= 15) t.push([`LIGHTNING ${w.lightning}/10 MIN`, "#ffe14a"]);
  if (w.speed >= 10) t.push([`MOVING ${w.speed} KM/H`, "#8aa0a6"]);
  return t.length ? `<div class="tags">${t.map(([x, c]) => `<span class="tag" style="--c:${c}">${x}</span>`).join("")}</div>` : "";
}
function renderWxWarnings() {
  renderStorms();
  const L = relevantWarnings(), W = S.settings.watches ? relevantWatches() : [];
  const chip = $("wxwChip"), panel = $("wxwPanel");
  if (!S.settings.wxw || (!L.length && !W.length)) { chip.hidden = true; panel.hidden = true; return; }
  chip.hidden = false; panel.hidden = false;
  const tor = L.some(w => w.type === "TOR"), svr = L.some(w => w.type === "SVR");
  chip.className = `chip wxw ${tor ? "tor" : svr ? "svr" : L.length ? "ffw" : "watch"}`;
  chip.textContent = `\u2691 ${L.length ? `${L.length} Radarhound warning${L.length > 1 ? "s" : ""}` : `${W.length} watch${W.length > 1 ? "es" : ""}`}`;
  const fmt = iso => `${fmtTime.format(new Date(iso))}`;
  $("wxwBody").innerHTML = L.map(w => `<div class="wxw-card" style="border-color:${WXW_STYLE[w.type].col}">
      <div class="wxw-head"><b style="color:${WXW_STYLE[w.type].col}">${w.title}</b>${w.home_inside ? `<span class="wxw-home">includes ${esc(S.cfg.home.name)}</span>` : ""}</div>
      <div class="wxw-time">Issued ${fmt(w.issued)}, until ${fmt(w.expires)}${w.source === "AUS" ? ", national mosaic" : ""}</div>
      ${impactTags(w)}<p>${esc(w.text)}</p>${w.hazards.length ? `<ul>${w.hazards.map(h => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      ${threatHtml(w.threat, w.source === "AUS" || w.source !== S.radar.id ? w.nearest_radar : null, w.lat, w.lon)}
      <button class="link-btn wxw-zoom" data-lat="${w.lat}" data-lon="${w.lon}">show on map</button></div>`).join("")
    + W.map(w => `<div class="wxw-card watch" style="border-color:${WXW_STYLE[w.type].col}">
      <div class="wxw-head"><b style="color:${WXW_STYLE[w.type].col}">${w.title}</b></div>
      <div class="wxw-time">${fmtDate.format(new Date(w.valid_from))} ${fmt(w.valid_from)} to ${fmt(w.valid_to)} (model)</div><p>${esc(w.text)}</p></div>`).join("")
    + `<p class="dim">Automated and unofficial, generated by Radarhound from radar, lightning and model data. Always follow BoM warnings.</p>`;
  bindThreatButtons($("wxwBody"));
  renderStorms();
  $("wxwBody").querySelectorAll(".wxw-zoom").forEach(b => b.onclick = () => {
    const [x, y] = latLonToKm(+b.dataset.lat, +b.dataset.lon);
    S.view.cx = x; S.view.cy = y; S.view.scale = Math.max(S.view.scale, Math.min(canvas.width, canvas.height) / 300); draw();
  });
}
setInterval(() => { if (S.wxw.active.length) { renderWxWarnings(); draw(); } }, 30e3);
$("wxwChip").onclick = () => $("wxwPanel").scrollIntoView({ behavior: "smooth", block: "start" });
