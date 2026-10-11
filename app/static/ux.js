/* wxdeck: the friendly layer. Everything nerdy stays, but the page answers the everyday question first
   ("is it going to rain on me?"), explains what each product shows, hides depth behind a detail level,
   and gives fast paths: a command search (Ctrl+K), share links and a first-run tour.
   Ideas borrowed from: Apple Weather / RainViewer (minute rain nowcast), BoM app (rain wording, rain
   alerts), Windy (point picker, keyboard), RadarScope (inspector, storm tracks, timestamp colours),
   LightningMaps (thunder rings), Tomorrow.io (command palette), Zoom Earth (copy link). */
"use strict";

// ---------------------------------------------------------------- small helpers
function toast(msg, ms = 4500) {
  const el = $("toast");
  el.innerHTML = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}
const fuzzy = (q, s) => {          // subsequence match score (higher = better), -1 = no match
  q = q.toLowerCase(); s = s.toLowerCase();
  if (!q) return 0;
  const i0 = s.indexOf(q);
  if (i0 >= 0) return 100 - i0 + (i0 === 0 || s[i0 - 1] === " " ? 50 : 0);
  let j = 0, score = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) { j++; score += 1; }
  return j === q.length ? score : -1;
};

const UX_NEW = store.get("settings", null) === null && !store.get("tourDone", 0);   // first visit on this device

// ---------------------------------------------------------------- detail level
const LEVELS = { simple: "Simple", chaser: "Storm chaser", pro: "Pro" };
function applyLevel(lv) {
  if (!LEVELS[lv]) lv = "pro";
  document.body.dataset.level = lv;
  S.settings.uiLevel = lv; save();
  $("uiLevel").value = lv;
  if (lv === "simple") {
    if (S.mode === "raw" && S.radar) selectProduct("3");
    if (S.settings.layout === 4) setLayout(2);
  }
  if (lv !== "pro" && !$("xsect").hidden) closeXsect();
}

// ---------------------------------------------------------------- settings tabs
function bindSettingsTabs() {
  const tabs = document.querySelectorAll(".set-tabs button");
  const show = name => {
    tabs.forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll(".tuning-grid[data-group]").forEach(g => { g.hidden = g.dataset.group !== name; });
    store.set("setTab", name);
  };
  tabs.forEach(b => { b.onclick = () => show(b.dataset.tab); });
  show(store.get("setTab", "map"));
  S.showSettingsTab = name => { document.querySelector(".tuning").open = true; show(name); document.querySelector(".tuning").scrollIntoView({ behavior: "smooth", block: "nearest" }); };
  // the little explanations: hover on desktop (title), tap the ⓘ on phones
  document.querySelectorAll("[data-tip]").forEach(el => {
    el.title = el.dataset.tip;
    const i = document.createElement("button");
    i.type = "button"; i.className = "tip-i"; i.textContent = "ⓘ"; i.setAttribute("aria-label", "What is this?");
    i.onclick = e => { e.preventDefault(); e.stopPropagation(); toast(esc(el.dataset.tip), 7000); };
    el.appendChild(i);
  });
}

// ---------------------------------------------------------------- new settings
function bindUxSettings() {
  const st = S.settings;
  st.ltgRings = st.ltgRings !== false;
  const chk = (id, key, after) => {
    $(id).checked = !!st[key];
    $(id).onchange = e => { st[key] = e.target.checked; save(); if (after) after(); draw(); };
  };
  chk("lyrMetar", "metar", () => { S.metar.fetched = 0; ensureMetar(); });
  chk("lyrCams", "cams", () => { S.cams.key = null; ensureCams(); });
  chk("ltgRings", "ltgRings");
  st.alertLtg = st.alertLtg !== false; st.alertArr = st.alertArr !== false; st.alertRain = !!st.alertRain;
  chk("alertLtg", "alertLtg"); chk("alertArr", "alertArr"); chk("alertRain", "alertRain");
  $("alertWhere").value = st.alertWhere || "home";
  $("alertWhere").onchange = e => { st.alertWhere = e.target.value; save(); if (st.alertWhere === "me") watchMe(true); };
  $("uiLevel").onchange = e => applyLevel(e.target.value);
  $("shareBtn").onclick = copyShareLink;
  $("tourBtn").onclick = () => openTour(0);
  $("paletteBtn").onclick = openPalette;
  $("explainChip").onclick = () => explain();
  $("setExport").onclick = () => {
    const blob = new Blob([JSON.stringify({ wxdeck: 1, settings: S.settings, customModes: store.get("customModes", []), palettes: store.get("palettes", null) }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "wxdeck-settings.json"; a.click();
  };
  $("setImport").onclick = () => $("setFile").click();
  $("setFile").onchange = async e => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j.settings) throw new Error("not a wxdeck settings file");
      store.set("settings", j.settings);
      if (j.customModes) store.set("customModes", j.customModes);
      if (j.palettes) store.set("palettes", j.palettes);
      location.reload();
    } catch (err) { toast(`Couldn't import: ${esc(err.message)}`); }
  };
  $("nowWhere").onclick = () => { S.nowMe = !S.nowMe; if (S.nowMe) watchMe(true); loadNow(); };
  $("verifyLoad").onclick = loadVerify;
}

// ---------------------------------------------------------------- this device's position (alerts and nowcast "where I am")
S.me2 = null;
function watchMe(ask) {
  if (S.me2Watch != null) return;
  if (!navigator.geolocation || !window.isSecureContext) {
    if (ask) toast("This browser only shares location over https (or localhost). In the phone app, turn on “Alerts for where the phone is” on the start screen.", 8000);
    return;
  }
  S.me2Watch = navigator.geolocation.watchPosition(p => { S.me2 = { lat: p.coords.latitude, lon: p.coords.longitude, t: Date.now() }; },
    err => { if (ask) toast(`Location unavailable: ${esc(err.message)}`); S.me2Watch = null; }, { enableHighAccuracy: false, maximumAge: 120e3 });
}
function alertPoint() {
  if (S.settings.alertWhere === "me" && S.me2 && Date.now() - S.me2.t < 30 * 60e3) return S.me2;
  return null;
}

// ---------------------------------------------------------------- "Right now" card: rain in the next hour
async function loadNow() {
  if (!S.cfg) return;
  const me = S.nowMe && S.me2;
  const q = me ? `?lat=${me.lat.toFixed(3)}&lon=${me.lon.toFixed(3)}` : "";
  $("nowTitle").textContent = me ? "Right now where you are" : `Right now at ${S.cfg.home.name}`;
  $("nowWhere").textContent = S.nowMe ? "use home" : "use my location";
  const r = await fetch(`/api/nowcast${q}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!r) { $("nowLine").textContent = "Nowcast unavailable right now."; return; }
  $("nowLine").textContent = r.text;
  const steps = r.nowcast ? r.nowcast.steps : [];
  if (!steps.length) { $("nowBars").innerHTML = ""; renderNowFacts(); return; }
  const H = 46, n = steps.length;
  const bars = steps.map((s, i) => {
    const h = s.rate > 0 ? Math.max(3, Math.min(H, 8 + Math.log2(1 + s.rate) * 7)) : 1.5;
    const col = s.level ? NOW_COLS[Math.min(14, s.level - 1)] : "#2a3a44";
    return `<rect x="${i * (300 / n) + 1}" y="${H - h}" width="${300 / n - 2}" height="${h}" rx="1.5" fill="${col}"><title>+${s.min} min: ${s.rate ? s.rate + " mm/h" : "dry"}</title></rect>`;
  }).join("");
  $("nowBars").innerHTML = `<svg viewBox="0 0 300 ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(r.text)}">${bars}</svg>
    <div class="now-axis"><span>now</span><span>+15</span><span>+30</span><span>+45</span><span>+60 min</span></div>`;
  renderNowFacts();
}
const NOW_COLS = ["#8fc8ff", "#6fb0ff", "#4f93ff", "#2f74f0", "#17b0a6", "#109488", "#2fc45a", "#f5d02e", "#f5a623", "#f57a1f", "#ef4444", "#d62a2a", "#b11c3c", "#9333ea", "#c026d3"];
function renderNowFacts() {
  const L = (typeof ALERT !== "undefined" && ALERT.lastList) || [];
  const near = L.filter(a => a.near !== false && a.type !== "RAIN");
  const parts = [];
  if (near.length) parts.push(`<b class="hot">${near.length} alert${near.length > 1 ? "s" : ""}:</b> ${near.slice(0, 3).map(a => esc(a.title)).join(", ")}`);
  else parts.push("No warnings near you.");
  const ltg = $("ltgSummary").textContent.trim();
  if (ltg) parts.push(esc(ltg));
  $("nowFacts").innerHTML = parts.map(p => `<div>${p}</div>`).join("");
}

// ---------------------------------------------------------------- METAR airports
S.metar = { list: [], fetched: 0 };
async function ensureMetar() {
  if (!S.settings.metar || Date.now() - S.metar.fetched < 10 * 60e3) return;
  S.metar.fetched = Date.now();
  const r = await fetch("/api/metar").then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (r) { S.metar.list = r.metars; draw(); } else S.metar.fetched = Date.now() - 9 * 60e3;
}
const FLT_COL = { VFR: "#3fbf5f", MVFR: "#4a8cff", IFR: "#ff4040", LIFR: "#e040e0" };
function drawMetar() {
  if (!S.settings.metar || !S.radar || S.radar.lat == null) return;
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${10.5 * d}px "Barlow Semi Condensed", sans-serif`;
  const zoomed = S.view.scale * 50 > 25 * d;
  for (const m of S.metar.list) {
    const [sx, sy] = kmToScreen(...latLonToKm(m.lat, m.lon));
    if (sx < 0 || sy < 0 || sx > canvas.width || sy > canvas.height) continue;
    ctx.fillStyle = FLT_COL[m.fltCat] || "#8aa0a6"; ctx.strokeStyle = "#0f1a20"; ctx.lineWidth = 1.5 * d;
    ctx.beginPath(); ctx.rect(sx - 4 * d, sy - 4 * d, 8 * d, 8 * d); ctx.fill(); ctx.stroke();
    const txt = `${zoomed ? m.icaoId + " " : ""}${m.temp != null ? Math.round(m.temp) + "°" : ""}${m.wxString ? " " + m.wxString : ""}`;
    if (!txt.trim()) continue;
    ctx.lineWidth = 3 * d; ctx.strokeStyle = "rgba(10,18,22,.9)"; ctx.strokeText(txt, sx + 7 * d, sy - 5 * d);
    ctx.fillStyle = "#e9f2f3"; ctx.fillText(txt, sx + 7 * d, sy - 5 * d);
  }
}

// ---------------------------------------------------------------- webcams (optional, needs a Windy key on the server)
S.cams = { list: [], key: null };
async function ensureCams() {
  if (!S.settings.cams || !S.cfg || !S.cfg.webcams || !S.radar || S.radar.lat == null) return;
  const [lat, lon] = kmToLatLon(S.view.cx, S.view.cy);
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (S.cams.key === key) return;
  S.cams.key = key;
  const r = await fetch(`/api/webcams?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&radius=150`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (r) { S.cams.list = r.webcams; draw(); }
}
function drawCams() {
  if (!S.settings.cams || !S.cams.list.length || !S.radar) return;
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const c of S.cams.list) {
    if (c.lat == null) continue;
    const [sx, sy] = kmToScreen(...latLonToKm(c.lat, c.lon));
    if (sx < 0 || sy < 0 || sx > canvas.width || sy > canvas.height) continue;
    ctx.fillStyle = "#f2a93b"; ctx.strokeStyle = "#0f1a20"; ctx.lineWidth = 1.2 * d;
    ctx.beginPath(); ctx.roundRect(sx - 6 * d, sy - 4 * d, 9 * d, 8 * d, 2 * d); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx + 3 * d, sy - 1 * d); ctx.lineTo(sx + 7 * d, sy - 4 * d); ctx.lineTo(sx + 7 * d, sy + 4 * d); ctx.lineTo(sx + 3 * d, sy + 1 * d); ctx.fill();
  }
}

// ---------------------------------------------------------------- thunder rings (LightningMaps style)
function drawThunder() {
  if (!S.settings.lightning || !S.settings.ltgRings || !S.cfg || !S.radar || S.radar.lat == null) return;
  const end = overlayEnd();
  if (!end || Date.now() - end > 15 * 60e3) return;          // only on the live end of the loop
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 10 / 20 / 40 km around home: how close is the storm?
  const h = S.cfg.home, [hx, hy] = kmToScreen(...latLonToKm(h.lat, h.lon));
  ctx.setLineDash([3 * d, 5 * d]); ctx.lineWidth = 1 * d;
  ctx.font = `600 ${10 * d}px "Barlow Semi Condensed", sans-serif`;
  for (const km of [10, 20, 40]) {
    const r = km * S.view.scale;
    if (r < 12 * d) continue;
    ctx.strokeStyle = km === 10 ? "rgba(255,225,74,.55)" : "rgba(255,225,74,.3)";
    ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,225,74,.7)"; ctx.fillText(`${km} km`, hx + 3 * d, hy - r - 3 * d);
  }
  ctx.setLineDash([]);
  // each new strike's sound front, travelling at 343 m/s (0.343 km/s); gone after 2.5 minutes
  const now = Date.now();
  let live = false;
  for (const s of S.ltg.strikes) {
    const age = (now - s[0]) / 1000;
    if (age < 0 || age > 150) continue;
    live = true;
    const [sx, sy] = kmToScreen(...latLonToKm(s[1], s[2]));
    const r = age * 0.343 * S.view.scale;
    ctx.strokeStyle = `rgba(255,240,170,${(0.7 * (1 - age / 150)).toFixed(3)})`; ctx.lineWidth = 1.5 * d;
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, r), 0, Math.PI * 2); ctx.stroke();
  }
  if (live && !drawThunder.pending) {            // keep the rings moving
    drawThunder.pending = true;
    setTimeout(() => { drawThunder.pending = false; if (!S.playing && !document.hidden) draw(); }, 700);
  }
}

// hook the new layers into the existing drawing pipeline
{
  const _dl = drawLightning;
  drawLightning = function () { _dl(); drawThunder(); };
  const _ds = drawStations;
  drawStations = function () { _ds(); drawMetar(); drawCams(); };
}

// ---------------------------------------------------------------- frame time colour: fresh / stale / archive
{
  const _us = updateStamp;
  updateStamp = function () {
    _us();
    const t = currentTime(), el = $("frameStamp");
    if (!t) { el.dataset.age = ""; return; }
    const ageMin = (Date.now() - t) / 60000;
    el.dataset.age = S.mode === "raw" ? "archive" : ageMin < -1 ? "future" : ageMin <= 12 ? "fresh" : ageMin <= 30 ? "stale" : "old";
  };
}

// ---------------------------------------------------------------- tap anywhere: the pinned point gets everything
const pinCache = new Map();
async function pinData(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (pinCache.has(key)) return pinCache.get(key);
  const p = Promise.all([
    fetch(`/api/forecast?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/nowcast?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]).then(([fc, nc]) => ({ fc, nc }));
  pinCache.set(key, p);
  if (pinCache.size > 40) pinCache.delete(pinCache.keys().next().value);
  return p;
}
function pinSummary(fc) {
  if (!fc || !fc.main || !fc.main.hourly) return "";
  const H = fc.main.hourly, now = Date.now() / 1000;
  const idx = H.time.map((t, i) => [t, i]).filter(([t]) => t >= now - 1800 && t <= now + 12 * 3600).map(([, i]) => i);
  if (!idx.length) return "";
  const v = k => idx.map(i => H[k][i]).filter(x => x != null);
  const T = v("temperature_2m"), R = v("precipitation"), P = v("precipitation_probability"), G = v("wind_gusts_10m"), C = v("cape");
  const sum = R.reduce((a, b) => a + b, 0);
  const bits = [`${Math.round(Math.min(...T))}–${Math.round(Math.max(...T))}°`,
    sum >= 0.2 ? `rain ${sum.toFixed(1)} mm (${Math.max(...P)}%)` : `dry (${P.length ? Math.max(...P) : 0}%)`,
    `gusts to ${Math.round(Math.max(...G))} km/h`];
  if (C.length && Math.max(...C) >= 300) bits.push(`CAPE up to ${Math.round(Math.max(...C))} J/kg`);
  return `<b>Next 12 h:</b> ${bits.join(", ")}`;
}
{
  const _rp = renderPin;
  renderPin = function () {
    _rp();
    if (!S.pin || $("pinPanel").hidden) return;
    const [lat, lon] = kmToLatLon(...S.pin);
    const box = document.createElement("div");
    box.className = "pin-extra"; box.innerHTML = `<div class="dim">Loading forecast for this spot…</div>`;
    $("pinBody").appendChild(box);
    const near = (list, km) => list.filter(m => m.lat != null).map(m => [haversine(lat, lon, m.lat, m.lon).dist, m]).filter(([dd]) => dd <= km).sort((a, b) => a[0] - b[0])[0];
    pinData(lat, lon).then(({ fc, nc }) => {
      if (!box.isConnected) return;
      const rows = [];
      if (nc && nc.text) rows.push(`<div><b>Next hour:</b> ${esc(nc.text)}</div>`);
      const sm = pinSummary(fc); if (sm) rows.push(`<div>${sm}</div>`);
      const mt = S.settings.metar && near(S.metar.list, 30);
      if (mt) rows.push(`<div class="metar"><b>${esc(mt[1].icaoId)}</b> ${mt[0].toFixed(0)} km: <code>${esc(mt[1].rawOb || "")}</code></div>`);
      const cam = S.settings.cams && near(S.cams.list, 15);
      if (cam && cam[1].preview) rows.push(`<a class="cam" href="${esc(cam[1].url || cam[1].preview)}" target="_blank" rel="noopener"><img src="${esc(cam[1].preview)}" alt="${esc(cam[1].title || "Webcam")}" loading="lazy"><span>${esc(cam[1].title || "Webcam")}, ${cam[0].toFixed(0)} km</span></a>`);
      box.innerHTML = rows.join("") || `<div class="dim">No forecast for this spot right now.</div>`;
    });
  };
}

// ---------------------------------------------------------------- "What am I looking at?"
const EXPLAIN = {
  refl: { t: "Radar reflectivity (rain intensity)", what: "How much rain or hail the radar beam is hitting, in dBZ. BoM's image shows the lowest beam, every 5–10 minutes.",
    read: "Blue and green: light rain. Yellow and orange: heavy rain. Red, dark red and black: very heavy rain, often hail. The colour scale is under the readout.",
    watch: "Hook or kidney shapes on the back edge of a storm, a sharp gradient on the inflow side, and cores of 55+ dBZ (hail). Rings near the radar and speckles on clear days are clutter.",
    note: "Beams rise with distance: far from the radar it looks over the top of low rain." },
  dopp: { t: "Doppler wind", what: "Wind speed towards or away from the radar, in 10 km/h steps (BoM's live Doppler image).",
    read: "Blue/green-blue: blowing towards the radar. Yellow to red: away from it. White: across the beam (or calm). Speed is only the part along the beam.",
    watch: "Strong towards and away colours side by side (a couplet) inside a storm can mean rotation. wxdeck marks them with rings when Live Doppler couplets is on.",
    note: "Only works within about 110 km of the radar and only where it's raining." },
  rain: { t: "Rainfall totals", what: "BoM's radar-estimated rain over the period (5 min, 1 h, since 9 am, 24 h).",
    read: "Colours are millimetres of rain; the legend shows the bands.", watch: "Bullseyes of 50+ mm in an hour can mean flash flooding.", note: "Radar estimates; gauges can differ a lot under hail or bright band." },
  nat: { t: "All of Australia", what: "Every BoM radar stitched into one map (strongest echo wins where they overlap), rebuilt every few minutes.",
    read: "Same colours as single-radar reflectivity. Zoom in and each radar's own sharper image takes over (seamless).",
    watch: "Lines and clusters on the move; pick a storm and open its radar for Doppler.", note: "Coarser (5 km) than single radars." },
  VEL: { t: "Velocity (archive)", what: "Exact wind along the beam from the full-resolution archive scan.",
    read: "Green: towards the radar, red: away. Brighter = faster.", watch: "Tight green-red pairs = rotation; the tighter and stronger, the more serious.", note: "Archive volumes are usually a day behind." },
  SRV: { t: "Storm-relative velocity", what: "Velocity with the storm's own motion taken away, so rotation stands out.",
    read: "Green towards, red away (relative to the moving storm).", watch: "A tight green-red couplet in the low tilts on the storm's inflow side: mesocyclone, possibly tornadic.", note: "Set the storm motion under the scan or use the arrow." },
  ZDR: { t: "Differential reflectivity (ZDR)", what: "Whether targets are flat (big raindrops, positive) or round/tumbling (hail, near zero).",
    read: "High ZDR: big drops. Near 0 dB with high reflectivity: hail. A ZDR column above the freezing level marks a strong updraft.", watch: "ZDR arcs on the inflow edge of supercells.", note: "" },
  RHOHV: { t: "Correlation coefficient (CC)", what: "How alike the targets in a beam are. Rain and snow: near 1. Hail, debris, birds, smoke: lower.",
    read: "Above 0.97: pure rain. 0.8–0.95: mixed, melting or hail. Below 0.8 inside strong rotation: possible tornado debris.", watch: "A low-CC blob on a velocity couplet = debris ball.", note: "" },
  KDP: { t: "Specific differential phase (KDP)", what: "How much liquid water the beam passes through.", read: "High KDP: very heavy rain.", watch: "Heavy rain cores and flash-flood risk.", note: "" },
  MESH: { t: "Hail size (MESH)", what: "Estimated maximum hail size from the volume scan.", read: "Millimetres. 20+ mm is severe, 50+ giant.", watch: "", note: "Estimates; real stones vary." },
  ROT: { t: "Low-level rotation", what: "Strongest cyclonic shear in the low tilts, from the velocity volume.", read: "Hot colours = strong spin.", watch: "Tracks of rotation following a storm = a rotating storm.", note: "" },
  ET: { t: "Echo tops", what: "How high the storm reaches (18 or 45 dBZ).", read: "Kilometres. 45 dBZ tops above 10 km mean a powerful updraft.", watch: "", note: "" },
  VIL: { t: "Vertically integrated liquid", what: "All the water in the column above each point.", read: "kg/m². High values with small area: hail.", watch: "", note: "" },
  HCA: { t: "Hydrometeor class", what: "A best guess at what the radar sees: rain, hail, snow, graupel, clutter, birds.", read: "Colours by class; the legend names them.", watch: "", note: "An algorithm: treat as a hint." },
  geocolor: { t: "True colour satellite", what: "Himawari's view as your eyes would see it by day; city lights and infrared cloud at night (CIRA GeoColor).",
    read: "Bright white: thick cloud. Grey: thin cloud or haze. Brown smudges: smoke or dust.", watch: "Towers bubbling up with sharp shadows in the afternoon = storms starting.", note: "" },
  ir: { t: "Infrared satellite", what: "Cloud-top temperature from Himawari's 10.4 µm channel, every 10 minutes, day and night.",
    read: "Colder = higher. Reds, purples and white (below −60 °C) are tall thunderstorm tops.", watch: "Small cold spots that grow fast = new storms; overshooting tops = very strong updrafts.", note: "" },
  wv: { t: "Water vapour", what: "Moisture in the middle and upper atmosphere.", read: "Blue/white: moist. Brown/orange: dry air.", watch: "Dry slots and jet streaks behind cold fronts.", note: "" },
  nmp: { t: "Night microphysics", what: "A night-time mix of infrared channels.", read: "Fog and low cloud: aqua/green. Thick high cloud: red. Clear land: varies.", watch: "Fog forming before dawn.", note: "" },
  dust: { t: "Dust RGB", what: "Infrared channels mixed so dust stands out.", read: "Dust: magenta/pink. Thick ice cloud: dark red. Clear: blue-purple.", watch: "", note: "" },
  dcp: { t: "Day cloud phase", what: "Daytime mix that tells ice cloud from water cloud.", read: "Cyan/blue-white: low water cloud. Green: new cumulus. Yellow-orange: thick ice tops (mature storms). Dark blue: land.", watch: "Towers turning from green to yellow are glaciating: storm about to mature.", note: "Only in daylight." },
  fc: { t: "Forecast layer", what: "Open-Meteo model forecast on a ~100 km grid for the next 48 hours.", read: "Use the bottom timeline to step through the hours; tap the map for values.", watch: "", note: "Models can be wrong by hours or tens of km for storms." },
};
const FC_EXPLAIN = {
  cape: "CAPE: fuel for thunderstorms. 500+ J/kg can support storms, 1500+ strong ones, 3000+ explosive. Needs a trigger to use it.",
  li: "Lifted index: negative = unstable. Below −4 strong storms possible.",
  scp: "Supercell composite: 1+ supports supercells, 4+ strongly.",
  stp: "Significant tornado parameter: 1+ means tornado ingredients overlap.",
  srh1: "0–1 km helicity: low-level spin available to a storm. 100+ notable, 200+ strong.",
  shear6: "0–6 km shear: 35+ kt lets updrafts rotate (supercells).",
  ffdi: "Fire danger (McArthur FFDI): 25 high, 50 extreme, 75+ catastrophic.",
  wind: "Wind at 10 m; particles show the flow.", gust: "Strongest gusts expected: 90+ km/h is damaging.",
  rain: "Rain rate each hour.", rainacc: "Rain added up from now.", mslp: "Pressure at sea level: tight lines = strong wind.",
};
function explainKey() {
  const v = S.settings.view;
  if (v === "fc") return { k: "fc", fc: S.settings.fcLayer };
  if (v === "sat") { const l = S.settings.satLayer; return { k: l.startsWith("ir") ? "ir" : l === "wv08" ? "wv" : EXPLAIN[l] ? l : "geocolor" }; }
  if (S.mode === "raw" && S.raw.sweep) {
    const m = S.raw.sweep.moment;
    if (/^VRAD/.test(m)) return { k: "VEL" };
    if (/^ET/.test(m)) return { k: "ET" };
    if (/^DBZH|^TH|^CR/.test(m)) return { k: "refl" };
    return { k: EXPLAIN[m] ? m : "refl" };
  }
  const suf = S.product && S.product.suffix;
  if (!suf) return { k: "refl" };
  if (suf === "N") return { k: "nat" };
  if (suf === "I") return { k: "dopp" };
  if ("ABCD".includes(suf)) return { k: "rain" };
  return { k: "refl" };
}
function explain() {
  const { k, fc } = explainKey();
  const e = EXPLAIN[k];
  const L = fc && FC_LAYERS[fc];
  const title = L ? `${L.name} (forecast)` : e.t;
  const extra = fc && FC_EXPLAIN[fc] ? `<p><b>How to read it:</b> ${esc(FC_EXPLAIN[fc])}</p>` : "";
  const el = $("explain");
  el.innerHTML = `<button class="pop-x" aria-label="Close">×</button><h3>${esc(title)}</h3>
    <p>${esc(e.what)}</p>${extra || `<p><b>How to read it:</b> ${esc(e.read)}</p>`}
    ${e.watch ? `<p><b>Look for:</b> ${esc(e.watch)}</p>` : ""}${e.note ? `<p class="dim">${esc(e.note)}</p>` : ""}
    <p class="dim">Tap anywhere on the map for the value there and a forecast for that spot.</p>`;
  el.hidden = false;
  el.querySelector(".pop-x").onclick = () => { el.hidden = true; };
  store.set(`seen.${k}${fc ? "." + fc : ""}`, 1);
}
// first time a product is on screen: a gentle hint
setInterval(() => {
  if (!S.radar || !$("tourDlg").hidden) return;
  const { k, fc } = explainKey(), id = `${k}${fc ? "." + fc : ""}`;
  if (id === explain.last) return;
  explain.last = id;
  if (!store.get(`seen.${id}`, 0) && store.get("tourDone", 0)) {
    store.set(`seen.${id}`, 1);
    const name = fc && FC_LAYERS[fc] ? FC_LAYERS[fc].name : EXPLAIN[k].t;
    toast(`New to <b>${esc(name)}</b>? <button class="link-btn" onclick="explain()">How to read it</button>`, 6000);
  }
}, 1500);

// ---------------------------------------------------------------- share links: the view lives in the address bar
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("r")) return;
  const st = S.settings;
  st.radar = h.get("r");
  if (h.get("p")) st.product = h.get("p");
  if (["radar", "both", "sat", "fc"].includes(h.get("v"))) st.view = h.get("v");
  if (["1", "2", "4"].includes(h.get("l"))) st.layout = +h.get("l");
  if (h.get("fl") && FC_LAYERS[h.get("fl")]) st.fcLayer = h.get("fl");
  if (h.get("s") && SAT_DEFS[h.get("s")]) st.satLayer = h.get("s");
  const ll = (h.get("ll") || "").split(",").map(Number);
  if (ll.length === 2 && ll.every(Number.isFinite)) {
    try { sessionStorage.setItem("wxdeck.zoomTo", JSON.stringify({ lat: ll[0], lon: ll[1], km: Math.max(5, Math.min(3000, +h.get("z") || 120)) })); } catch { /* private */ }
  }
  save();
})();
function shareHash() {
  if (!S.radar || S.view.scale == null || S.radar.lat == null) return "";
  const [lat, lon] = kmToLatLon(S.view.cx, S.view.cy);
  const z = Math.round(Math.min(canvas.width, canvas.height) / 2 / S.view.scale);
  const st = S.settings;
  const q = new URLSearchParams({ r: S.radar.id, p: S.mode === "raw" ? "raw" : (S.product ? S.product.suffix : st.product), v: st.view, l: st.layout,
    ll: `${lat.toFixed(3)},${lon.toFixed(3)}`, z });
  if (st.view === "fc") q.set("fl", st.fcLayer);
  if (st.view === "sat" || st.view === "both") q.set("s", st.satLayer);
  return "#" + q.toString();
}
setInterval(() => {
  const h = shareHash();
  if (h && h !== location.hash) history.replaceState(null, "", h);
}, 1500);
async function copyShareLink() {
  const url = location.origin + location.pathname + shareHash();
  try { await navigator.clipboard.writeText(url); toast("Link copied: it opens this radar, product and view."); }
  catch { prompt("Copy this link", url); }
}

// ---------------------------------------------------------------- command search (Ctrl+K)
function paletteItems() {
  const items = [];
  const add = (group, label, run, hint = "") => items.push({ group, label, run, hint });
  for (const [v, n] of [["radar", "Radar"], ["both", "Radar + satellite"], ["sat", "Satellite"], ["fc", "Forecast map"]]) add("View", n, () => setView(v));
  if (S.radar) for (const p of S.radar.products.filter(p => p.available)) add("Product", p.label, () => { setView("radar"); selectProduct(p.suffix); }, S.radar.name);
  if (S.radar && !isNational() && S.radar.lat != null && document.body.dataset.level === "pro") add("Product", "Raw volume (archive)", () => selectRaw());
  for (const r of (S.cfg ? S.cfg.radars : [])) add("Radar", r.name, () => { $("radarSel").value = r.id; selectRadar(r.id); }, r.id);
  for (const r of (S.cfg ? S.cfg.all_radars || [] : [])) add("Radar", r.name, () => openRadar(r.id), `${r.id}, start following`);
  for (const m of MODES.concat(store.get("customModes", []))) add("Mode", m.name, () => applyMode(m), m.tag);
  for (const [k, L] of Object.entries(FC_LAYERS)) add("Forecast layer", L.name, () => { S.settings.fcLayer = k; save(); $("fcLayer").value = k; setView("fc"); syncFcControls(); renderLegend(); refreshFcFrames(); }, L.group || "");
  for (const [k, D] of Object.entries(SAT_DEFS)) add("Satellite", D.name, () => { S.settings.satLayer = k; save(); $("satSel").value = k; S.sat.current = null; setView(S.settings.view === "radar" ? "both" : S.settings.view); renderLegend(); onTimeChanged(); });
  const tog = (label, id) => add("Layer", `${$(id).checked ? "Hide" : "Show"} ${label}`, () => $(id).click());
  tog("station obs", "lyrStations"); tog("airport obs (METAR)", "lyrMetar"); tog("highways", "lyrRoads"); tog("fires", "lyrFires");
  tog("towns", "lyrLoc"); tog("range rings", "lyrRange"); tog("thunder rings", "ltgRings"); tog("wxdeck warnings", "lyrWxw"); tog("model watches", "lyrWatches");
  add("Layer", `${S.settings.lightning ? "Hide" : "Show"} lightning`, () => $("ltgChip").click());
  add("Layer", `${cellsOn() ? "Hide" : "Show"} storm cells`, () => $("cellsChip").click());
  for (const [lv, n] of Object.entries(LEVELS)) add("Detail level", n, () => applyLevel(lv));
  add("Action", "Set home", () => openHomeDialog());
  add("Action", "Find a place on the map", () => toggleFind(true));
  add("Action", "Copy link to this view", copyShareLink);
  add("Action", "What am I looking at?", explain);
  add("Action", "Jump to newest frame", jumpNow);
  add("Action", "Test alert sound and voice", () => $("alertTest").click());
  add("Action", "Alert settings", () => S.showSettingsTab("alerts"));
  add("Action", "Welcome tour", () => openTour(0));
  add("Action", "Read me today's weather", readBrief);
  add("Action", "Kiosk view (wall screen)", () => window.open("/?kiosk=1", "_blank"));
  add("Action", "Keyboard shortcuts", () => toggleHelp(true));
  add("Action", "Warning verification log", () => { applyLevel("pro"); $("verifyPanel").scrollIntoView({ behavior: "smooth" }); loadVerify(); });
  return items;
}
let palState = { items: [], shown: [], sel: 0, places: [], seq: 0 };
function openPalette() {
  palState.items = paletteItems(); palState.places = [];
  $("cmdIn").value = ""; $("cmdDlg").hidden = false;
  renderPalette();
  $("cmdIn").focus();
}
function closePalette() { $("cmdDlg").hidden = true; }
function renderPalette() {
  const q = $("cmdIn").value.trim();
  let shown = palState.items.map(it => ({ it, s: Math.max(fuzzy(q, it.label), fuzzy(q, it.group + " " + it.label) - 5) })).filter(x => x.s >= 0);
  shown.sort((a, b) => b.s - a.s);
  shown = shown.slice(0, q ? 30 : 14).map(x => x.it);
  shown = shown.concat(palState.places.map(p => ({ group: "Place", label: p.label, run: () => goToPlace(p) })));
  palState.shown = shown;
  palState.sel = Math.min(palState.sel, Math.max(0, shown.length - 1));
  const favKeys = new Set(favs().map(f => f.group + "|" + f.label));
  $("cmdList").innerHTML = shown.map((it, i) => `<div class="cmd-row"><button class="cmd-item${i === palState.sel ? " on" : ""}" data-i="${i}" role="option"><em>${esc(it.group)}</em>${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ""}</button>${it.group !== "Place" ? `<button class="cmd-star" data-i="${i}" title="Pin to the bar above the map (Shift+Enter)">${favKeys.has(it.group + "|" + it.label.replace(/^(Show|Hide) /, "")) ? "★" : "☆"}</button>` : ""}</div>`).join("")
    || `<div class="dim">${q.length >= 3 ? "Searching places…" : "Nothing matches."}</div>`;
  $("cmdList").querySelectorAll(".cmd-item").forEach(b => { b.onclick = () => runPalette(+b.dataset.i); });
  $("cmdList").querySelectorAll(".cmd-star").forEach(b => { b.onclick = () => { toggleFav(palState.shown[+b.dataset.i]); renderPalette(); }; });
  const on = $("cmdList").querySelector(".on"); if (on) on.scrollIntoView({ block: "nearest" });
}
function runPalette(i) {
  const it = palState.shown[i];
  if (!it) return;
  closePalette();
  try { it.run(); } catch (e) { toast(esc(e.message)); }
}
$("cmdIn").addEventListener("input", () => {
  palState.sel = 0; palState.places = [];
  renderPalette();
  const q = $("cmdIn").value.trim(), my = ++palState.seq;
  clearTimeout(palState.t);
  if (q.length >= 3) palState.t = setTimeout(async () => {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (my !== palState.seq || !r) return;
    palState.places = r.results.slice(0, 5); renderPalette();
  }, 500);
});
$("cmdIn").addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); palState.sel = Math.min(palState.shown.length - 1, palState.sel + 1); renderPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palState.sel = Math.max(0, palState.sel - 1); renderPalette(); }
  else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); const it = palState.shown[palState.sel]; if (it && it.group !== "Place") { toggleFav(it); renderPalette(); } }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(palState.sel); }
  else if (e.key === "Escape") closePalette();
});
$("cmdDlg").onclick = e => { if (e.target === $("cmdDlg")) closePalette(); };

// ---------------------------------------------------------------- keyboard: Ctrl+K, /, N, I
function jumpNow() {
  if (S.mode === "raw") { if (S.raw.scans.length) showScan(S.raw.scans.length - 1); return; }
  if (S.settings.view === "fc") { refreshFcFrames(); return; }
  play(false);
  if (satTimeline()) { if (S.satFrames.length) { S.satIdx = S.satFrames.length - 1; refreshSatFrames(); } return; }
  if (S.frames.length) showFrame(S.frames.length - 1);
}
document.addEventListener("keydown", e => {
  const tag = document.activeElement?.tagName;
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(tag) && document.activeElement.type !== "range";
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("cmdDlg").hidden ? openPalette() : closePalette(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openPalette(); }
  else if (e.key === "n" || e.key === "N") jumpNow();
  else if (e.key === "i" || e.key === "I") $("explain").hidden ? explain() : ($("explain").hidden = true);
  else if (e.key === "Escape") { if (!$("explain").hidden) $("explain").hidden = true; if (!$("cmdDlg").hidden) closePalette(); }
}, true);

// ---------------------------------------------------------------- first-run tour
const TOUR = [
  () => `<h2>Welcome to wxdeck</h2>
    <p>Live BoM radar, Doppler, lightning, satellite and forecasts from your own server, plus wxdeck's own storm warnings.</p>
    <p><b>How much detail do you want?</b> You can change this any time under Layers and settings, More.</p>
    <div class="tour-levels">
      <button data-lv="simple"><b>Simple</b><span>Rain radar, lightning, warnings and the forecast. Clean and quick.</span></button>
      <button data-lv="chaser"><b>Storm chaser</b><span>Adds Doppler couplets, storm cells, SCP/STP overlays, model spread and 4 panes.</span></button>
      <button data-lv="pro"><b>Pro</b><span>Everything: raw volumes, dual-pol, cross-sections, rotation detection, verification log.</span></button>
    </div>`,
  () => `<h2>Where's home?</h2>
    <p>Home sets the forecast, distances, storm arrival times and which warnings count as near you. It's now <b>${esc(S.cfg ? S.cfg.home.name : "not set")}</b>.</p>
    <div class="tour-actions"><button id="tourHome" class="primary">Search for my address</button></div>`,
  () => `<h2>Alerts</h2>
    <p>New warnings near you play a tone and are read out ("Severe thunderstorm warning issued for…"). You can also get <b>lightning nearby</b>, <b>storm approaching</b> and <b>rain in the next 30 minutes</b> alerts.</p>
    <label class="check"><input type="checkbox" id="tourRain" ${S.settings.alertRain ? "checked" : ""}> Tell me when rain is about to start</label>
    <div class="tour-actions"><button id="tourSound" class="primary">Turn on sound and play a test</button></div>
    <p class="dim">Phone: get the app (top right) so alerts reach you with the screen off.</p>`,
  () => `<h2>Getting around</h2>
    <ul class="tour-tips">
      <li><b>Tap or click the map</b> for the value there, the next hour's rain and a 12-hour forecast.</li>
      <li><b>ⓘ Explain</b> (or I) tells you how to read whatever is on screen.</li>
      <li><b>◧ Modes</b> are one-click setups: storm watch, rotation hunt, hail, fire weather…</li>
      <li><b>Ctrl + K</b> (or /) searches everything: layers, radars, modes and places.</li>
      <li><b>🔎 Find</b> (F) jumps to a town or address. <b>N</b> jumps to the newest frame.</li>
    </ul>`,
];
function openTour(i = 0) {
  const step = Math.max(0, Math.min(TOUR.length - 1, i));
  $("tourCard").innerHTML = TOUR[step]() + `<div class="tour-nav"><span class="dim">${step + 1} / ${TOUR.length}</span>
    <button id="tourSkip">${step === TOUR.length - 1 ? "Close" : "Skip"}</button>${step < TOUR.length - 1 ? `<button id="tourNext" class="primary">Next</button>` : `<button id="tourDone" class="primary">Start</button>`}</div>`;
  $("tourDlg").hidden = false;
  const done = () => { $("tourDlg").hidden = true; store.set("tourDone", 1); };
  $("tourSkip").onclick = done;
  if ($("tourNext")) $("tourNext").onclick = () => openTour(step + 1);
  if ($("tourDone")) $("tourDone").onclick = done;
  $("tourCard").querySelectorAll("[data-lv]").forEach(b => {
    b.classList.toggle("on", b.dataset.lv === (S.settings.uiLevel || "simple"));
    b.onclick = () => { applyLevel(b.dataset.lv); openTour(step + 1); };
  });
  if ($("tourHome")) $("tourHome").onclick = () => { done(); openHomeDialog(); };
  if ($("tourRain")) $("tourRain").onchange = e => { S.settings.alertRain = e.target.checked; save(); $("alertRain").checked = e.target.checked; };
  if ($("tourSound")) $("tourSound").onclick = () => { unlockAudio(); $("alertTest").click(); };
}

// ---------------------------------------------------------------- verification log
async function loadVerify() {
  $("verifyBody").innerHTML = `<p class="dim">Loading…</p>`;
  const r = await fetch("/api/verify?days=30").then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!r) { $("verifyBody").innerHTML = `<p class="dim">Couldn't load the log.</p>`; return; }
  const s = r.stats;
  const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : "–");
  const rows = r.warnings.slice(0, 40).map(w => `<tr><td>${fmtDate.format(new Date(w.issued))} ${fmtTime.format(new Date(w.issued))}</td>
    <td><b class="wt-${w.type}">${w.type}</b></td><td>${esc(w.towns.slice(0, 3).join(", ") || `${w.lat.toFixed(2)}, ${w.lon.toFixed(2)}`)}</td>
    <td>${w.minutes} min</td><td>${Math.round(w.dbz)} dBZ${w.dv >= 50 ? `, ΔV ${Math.round(w.dv)}` : ""}${w.lightning ? `, ${w.lightning} ⚡` : ""}</td>
    <td>${w.bom.length ? "✔ BoM" : "–"}${w.reports.length ? ` · ${w.reports.length} report${w.reports.length > 1 ? "s" : ""}` : ""}</td></tr>`).join("");
  $("verifyBody").innerHTML = `
    <div class="verify-stats">
      <div><b>${s.warnings}</b><span>wxdeck warnings (30 days)</span></div>
      <div><b>${pct(s.with_bom, s.warnings)}</b><span>also warned by BoM</span></div>
      <div><b>${pct(s.with_reports, s.warnings)}</b><span>with a storm report</span></div>
      <div><b>${s.bom_without_wxdeck}</b><span>BoM storm warnings wxdeck didn't match</span></div>
    </div>
    ${rows ? `<div class="verify-scroll"><table class="verify-table"><thead><tr><th>Issued</th><th>Type</th><th>Area</th><th>Lasted</th><th>Peak</th><th>Verified</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="dim">No wxdeck warnings yet. Every warning is logged here as it happens.</p>`}
    ${r.bom_missed.length ? `<details><summary>BoM thunderstorm warnings without a wxdeck warning (${r.bom_missed.length})</summary><ul>${r.bom_missed.slice(0, 20).map(b => `<li>${esc(b.title)} <span class="dim">${fmtDate.format(new Date(b.first))}</span></li>`).join("")}</ul></details>` : ""}
    <p class="dim">Matching is by town names and storm reports inside the warning area. Log a report from a pinned point to help.</p>`;
}


// ---------------------------------------------------------------- "Read me today": a spoken day summary
async function readBrief() {
  unlockAudio();
  const me = S.nowMe && S.me2;
  $("briefText").textContent = "Getting today's summary…";
  const r = await fetch(`/api/brief${me ? `?lat=${me.lat.toFixed(3)}&lon=${me.lon.toFixed(3)}` : ""}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!r) { $("briefText").textContent = "Couldn't get the summary right now."; return; }
  $("briefText").textContent = r.text;
  const was = S.settings.alertVoice; S.settings.alertVoice = true;
  try { await speak(r.text); } finally { S.settings.alertVoice = was; }
}

// ---------------------------------------------------------------- quiet hours for minor alerts
function inQuietHours() {
  const f = S.settings.quietFrom, t = S.settings.quietTo;
  if (f == null || f < 0 || f === t) return false;
  const h = new Date().getHours();
  return f < t ? h >= f && h < t : h >= f || h < t;
}
function bindQuiet() {
  const opts = `<option value="-1">Off</option>` + Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, "0")}:00</option>`).join("");
  $("quietFrom").innerHTML = opts; $("quietTo").innerHTML = opts.replace(`<option value="-1">Off</option>`, "");
  $("quietFrom").value = String(S.settings.quietFrom ?? -1); $("quietTo").value = String(S.settings.quietTo ?? 7);
  $("quietFrom").onchange = e => { S.settings.quietFrom = +e.target.value; save(); };
  $("quietTo").onchange = e => { S.settings.quietTo = +e.target.value; save(); };
}

// ---------------------------------------------------------------- favourite chips (pin anything from the command search)
function favs() { return store.get("favs", []); }
function renderFavs() {
  const list = favs(), el = $("favChips");
  el.hidden = !list.length;
  el.innerHTML = list.map((f, i) => `<button class="chip fav" data-i="${i}" title="${esc(f.group)}: ${esc(f.label)} (right-click or long-press to remove)">★ ${esc(f.label)}</button>`).join("");
  el.querySelectorAll("button").forEach(b => {
    const f = list[+b.dataset.i];
    b.onclick = () => { const it = paletteItems().find(x => x.group === f.group && x.label.replace(/^(Show|Hide) /, "") === f.label); if (it) it.run(); else toast("That item isn't available here."); };
    const rm = e => { e.preventDefault(); store.set("favs", favs().filter(x => !(x.group === f.group && x.label === f.label))); renderFavs(); toast(`Removed ★ ${esc(f.label)}`); };
    b.oncontextmenu = rm;
    let t; b.onpointerdown = () => { t = setTimeout(() => rm(new Event("x")), 700); }; b.onpointerup = b.onpointerleave = () => clearTimeout(t);
  });
}
function toggleFav(it) {
  const label = it.label.replace(/^(Show|Hide) /, ""), list = favs();
  const has = list.findIndex(f => f.group === it.group && f.label === label);
  if (has >= 0) list.splice(has, 1); else list.push({ group: it.group, label });
  store.set("favs", list.slice(0, 12)); renderFavs();
  toast(has >= 0 ? `Removed ★ ${esc(label)}` : `Added ★ ${esc(label)} to the bar above the map`);
}

// ---------------------------------------------------------------- legend: tap to switch words / mm/h / dBZ
{
  const _rl = renderLegend;
  renderLegend = function () {
    _rl();
    const live = S.mode === "live" && S.settings.view !== "sat" && S.settings.view !== "fc" && (S.product?.type || "0") === "0";
    const lab = $("legend").nextElementSibling;
    $("legend").title = live ? "Tap to switch between words, mm/h and dBZ" : "";
    if (!live || !lab) return;
    $("legend").querySelectorAll("span").forEach((sp, i) => { sp.title = `${REFL_RATE[i]} mm/h · ~${Math.round(REFL_DBZ[i])} dBZ`; });
    const u = S.settings.legendUnit || "words";
    if (u === "mmh") lab.innerHTML = ["0.2 mm/h", "6", "35", "360 mm/h"].map(t => `<span>${t}</span>`).join("");
    if (u === "dbz") lab.innerHTML = [`${Math.round(REFL_DBZ[0])} dBZ`, "40", "55", `${Math.round(REFL_DBZ[14])} dBZ`].map(t => `<span>${t}</span>`).join("");
  };
}

// ---------------------------------------------------------------- kiosk view (?kiosk=1): wall tablet / spare screen
function startKiosk() {
  document.body.classList.add("kiosk");
  applyLevel("simple");
  if ("wakeLock" in navigator) {
    const lock = () => navigator.wakeLock.request("screen").catch(() => { });
    lock(); document.addEventListener("visibilitychange", () => { if (!document.hidden) lock(); });
  }
  // loop the radar, jump back to live every few minutes, reload twice a day to pick up updates
  setInterval(() => { if (!S.playing && S.mode === "live") play(true); }, 15e3);
  setTimeout(() => location.reload(), 12 * 3600e3);
  document.addEventListener("dblclick", () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => { }); });
}

// ---------------------------------------------------------------- start
function uxBoot() {
  bindSettingsTabs();
  bindUxSettings();
  bindQuiet();
  renderFavs();
  $("briefBtn").onclick = readBrief;
  $("legend").addEventListener("click", () => {
    const order = ["words", "mmh", "dbz"], u = S.settings.legendUnit || "words";
    S.settings.legendUnit = order[(order.indexOf(u) + 1) % 3]; save(); renderLegend();
  });
  if (new URLSearchParams(location.search).has("kiosk")) startKiosk();
  const lv = S.settings.uiLevel || (UX_NEW ? "simple" : "pro");      // people already using wxdeck keep everything
  applyLevel(lv);
  if (S.settings.alertWhere === "me") watchMe(false);
  const waitCfg = setInterval(() => {
    if (!S.cfg) return;
    clearInterval(waitCfg);
    if (S.cfg.auth) $("logoutBtn").hidden = false;
    $("lyrCamsWrap").hidden = !S.cfg.webcams;
    ensureMetar(); ensureCams();
    loadNow(); setInterval(loadNow, 2 * 60e3);
    if (!store.get("tourDone", 0)) openTour(0);
  }, 300);
  setInterval(() => { ensureMetar(); ensureCams(); }, 60e3);
  setInterval(renderNowFacts, 30e3);
}
window.addEventListener("DOMContentLoaded", uxBoot);
