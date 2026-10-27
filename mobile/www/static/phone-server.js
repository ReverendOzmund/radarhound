/* Radarhound phone mode: the server, inside the app.
   The full Radarhound page runs unchanged; this file answers its /api/... requests on the phone by fetching
   straight from BoM, Open-Meteo, NASA GIBS, LightningMaps, the Aviation Weather Center and Nominatim.
   BoM sends no CORS headers, so its pages and images come through Capacitor's native HTTP. Things that
   need a server running all day (48 h history, raw volumes, raw Himawari bands, verification) say so.
   Loaded before the page's own scripts; only active when the page is opened as the app's phone mode. */
"use strict";

const WXP = (() => {
  const BOM = "https://reg.bom.gov.au";
  const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36 radarhound-phone";
  const origFetch = window.fetch.bind(window);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("wxp." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("wxp." + k, JSON.stringify(v)); } catch { /* full */ } },
  };
  const DATA = {};                      // bundled reference data (radars, towns, borders, highways)
  const ready = (async () => {
    for (const k of ["radars", "towns", "borders", "highways"]) {
      try { DATA[k] = await (await origFetch(`/data/${k}.json`)).json(); } catch { DATA[k] = k === "radars" ? [] : { lines: [], towns: [] }; }
    }
  })();

  // ---------------------------------------------------------------- network
  const capHttp = () => window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.CapacitorHttp;
  const b64ToBuf = b64 => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
  async function http(url, type = "text", { params, headers, timeout = 25000 } = {}) {
    if (params) url += (url.includes("?") ? "&" : "?") + new URLSearchParams(params).toString();
    const H = capHttp();
    if (H && /^https?:/.test(url)) {
      const r = await H.get({ url, headers: { "User-Agent": UA, ...(headers || {}) }, responseType: type === "bytes" ? "blob" : type === "json" ? "json" : "text",
        connectTimeout: timeout, readTimeout: timeout });
      if (r.status >= 400) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      if (type === "bytes") return typeof r.data === "string" ? b64ToBuf(r.data) : r.data;
      if (type === "json") return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await origFetch(url, { headers, signal: ctl.signal });
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      return type === "bytes" ? r.arrayBuffer() : type === "json" ? r.json() : r.text();
    } finally { clearTimeout(t); }
  }
  // memo with shared in-flight requests; failures are kept for a short while so we don't hammer a source
  const memo = new Map();
  function cached(key, ttlMs, fn, failMs = 60e3) {
    const e = memo.get(key);
    if (e && e.until > Date.now()) return e.p;
    const p = fn();
    memo.set(key, { p, until: Date.now() + ttlMs });
    p.catch(() => memo.set(key, { p, until: Date.now() + failMs }));
    if (memo.size > 400) for (const [k, v] of memo) if (v.until < Date.now()) memo.delete(k);
    return p;
  }

  // ---------------------------------------------------------------- geometry
  const KM = 111.11;
  const dist = (a, b, c, d) => Math.hypot((a - c) * KM, (b - d) * KM * Math.cos(a * Math.PI / 180));
  const radarById = id => DATA.radars.find(r => r.id === id);
  const NAT = { PID: "AUS", LAT0: -27.0, LON0: 133.5, HALF: 2560, SIZE: 1024 };
  function radarPoint(rid) {
    if (rid === NAT.PID) return [NAT.LAT0, NAT.LON0];
    const r = radarById(rid);
    if (!r) throw httpError(404, "unknown radar");
    return [r.la, r.lo];
  }
  const httpError = (status, detail) => Object.assign(new Error(detail), { status });

  // ---------------------------------------------------------------- settings kept on the phone
  function home() {
    const h = LS.get("home", null);
    if (h) return h;
    return { name: "Home", lat: -31.95, lon: 115.86, unset: true };
  }
  function myRadars() {
    let list = LS.get("radars", null);
    if (!list || !list.length) {
      const h = home();
      list = [...DATA.radars].sort((a, b) => dist(h.lat, h.lon, a.la, a.lo) - dist(h.lat, h.lon, b.la, b.lo)).slice(0, 1).map(r => r.id);
    }
    return list.filter(id => radarById(id));
  }
  function followed() {
    const auto = LS.get("auto", {}), now = Date.now();
    for (const k of Object.keys(auto)) if (auto[k] < now) delete auto[k];
    LS.set("auto", auto);
    const mine = myRadars();
    return mine.concat(Object.keys(auto).filter(k => !mine.includes(k) && radarById(k)));
  }

  // ---------------------------------------------------------------- radar loops (BoM's last hour or so)
  const LABELS = { "4": "64 km", "3": "128 km", "2": "256 km", "1": "512 km", I: "Doppler wind", A: "Rain 5 min", B: "Rain 1 h", C: "Rain since 9am", D: "Rain 24 h" };
  const KMS = { "4": 64, "3": 128, "2": 256, "1": 512 };
  const TYPE = s => (s === "I" ? "2" : "ABCD".includes(s) ? "1" : "0");
  const frameIndex = new Map();         // pid -> Map(name -> time ms)
  const frameBytes = new Map();         // name -> ArrayBuffer (LRU)
  const productInfo = new Map();        // pid -> {km, available, error}
  const nameTime = n => { const m = n.match(/\.T\.(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)\.png$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null; };
  async function loopNames(pid) {
    return cached(`loop|${pid}`, 120e3, async () => {
      const html = await http(`${BOM}/products/${pid}.loop.shtml`);
      const names = [...html.matchAll(/theImageNames\[\d+\]\s*=\s*"(\/radar\/[^"]+\.png)"/g)].map(m => m[1].split("/").pop());
      const km = html.match(/^\s*Km\s*=\s*(\d+)/m);
      const idx = frameIndex.get(pid) || new Map();
      for (const n of names) { const t = nameTime(n); if (t) idx.set(n, t); }
      frameIndex.set(pid, idx);
      productInfo.set(pid, { km: km ? +km[1] : KMS[pid.slice(-1)] || 128, available: names.length > 0, error: names.length ? null : "no recent images" });
      return names;
    });
  }
  async function frameBuf(name) {
    if (frameBytes.has(name)) { const b = frameBytes.get(name); frameBytes.delete(name); frameBytes.set(name, b); return b; }
    if (name.startsWith("AUS.")) return null;
    const buf = await cached(`img|${name}`, 3600e3, () => http(`${BOM}/radar/${name}`, "bytes"));
    frameBytes.set(name, buf);
    while (frameBytes.size > 260) frameBytes.delete(frameBytes.keys().next().value);
    return buf;
  }
  async function framesList(pid, hours) {
    if (pid === NAT.PID) { LTG.national = true; if (window.WXP_ENGINE) await WXP_ENGINE.national.ensure(); }
    else { try { await loopNames(pid); } catch { /* keep what we have */ } }
    const idx = frameIndex.get(pid) || new Map(), cut = Date.now() - hours * 3600e3;
    const frames = [...idx].filter(([, t]) => t >= cut).sort((a, b) => a[1] - b[1])
      .map(([n, t]) => ({ t: new Date(t).toISOString(), url: `/frames/${pid}/${n}` }));
    return { pid, frames };
  }
  function bundle(parts) {
    let size = 4;
    const enc = parts.map(([n, b]) => { const nb = new TextEncoder().encode(n); size += 2 + nb.length + 4 + b.byteLength; return [nb, b]; });
    const out = new Uint8Array(size), v = new DataView(out.buffer);
    v.setUint32(0, enc.length, true);
    let o = 4;
    for (const [nb, b] of enc) {
      v.setUint16(o, nb.length, true); o += 2; out.set(nb, o); o += nb.length;
      v.setUint32(o, b.byteLength, true); o += 4; out.set(new Uint8Array(b), o); o += b.byteLength;
    }
    return out.buffer;
  }
  async function layerImage(id, name) {
    // BoM basemaps never change: keep them in the Cache API
    const url = `${BOM}/products/radar_transparencies/${id}.${name}.png`;
    let cache = null;
    try { cache = await caches.open("wxp-layers"); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch { /* no cache */ }
    const buf = await cached(`layer|${id}|${name}`, 86400e3, () => http(url, "bytes"), 3600e3);
    try { if (cache) await cache.put(url, new Response(buf, { headers: { "content-type": "image/png" } })); } catch { /* ignore */ }
    return buf;
  }

  // ---------------------------------------------------------------- config
  async function config() {
    await ready;
    const h = home();
    const mine = myRadars();
    const radars = followed().map(id => {
      const r = radarById(id);
      const sufs = mine.includes(id) ? ["4", "3", "2", "1", "I", "A", "B", "C", "D"] : ["3", "2", "I"];
      return { id, name: r.n, lat: r.la, lon: r.lo, state: r.st, auto: !mine.includes(id),
        layer_sets: [["IDR" + id + "4", 64], ["IDR" + id + "3", 128], ["IDR" + id + "2", 256], ["IDR" + id + "1", 512]].map(([lid, km]) => ({ id: lid, km })),
        products: sufs.map(s => {
          const pid = `IDR${id}${s}`, info = productInfo.get(pid) || {};
          const km = info.km || KMS[s] || 128;
          return { pid, radar: id, suffix: s, label: LABELS[s], km, type: TYPE(s), layer_id: `IDR${id}${({ 64: "4", 128: "3", 256: "2", 512: "1" })[km] || "3"}`,
            available: info.available !== false, error: info.error || null, frames: (frameIndex.get(pid) || new Map()).size };
        }) };
    });
    radars.push({ id: NAT.PID, name: "Australia (all radars)", lat: NAT.LAT0, lon: NAT.LON0, national: true, layer_sets: [],
      products: [{ pid: NAT.PID, radar: NAT.PID, suffix: "N", label: "National mosaic", km: NAT.HALF, px: NAT.SIZE, type: "0", layer_id: null,
        available: true, error: null, frames: (frameIndex.get(NAT.PID) || new Map()).size }] });
    const fol = new Set(followed());
    const all = DATA.radars.filter(r => !fol.has(r.id)).map(r => ({ id: r.id, name: r.n, lat: r.la, lon: r.lo, state: r.st })).sort((a, b) => a.name.localeCompare(b.name));
    return { radars, all_radars: all, home: { name: h.name, lat: h.lat, lon: h.lon }, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Perth",
      retention_hours: 1, poll_seconds: 120, auth: false, webcams: false, ltg_alert_km: 15, phone: true, home_unset: !!h.unset };
  }

  // ---------------------------------------------------------------- lightning (LightningMaps area feed, while the app is open)
  const LTG = { strikes: [], ws: null, box: null, status: { connected: false, kept: 0, feed: "area (phone)" } };
  function ltgBox() {
    const pts = [home()];
    for (const id of followed()) { const r = radarById(id); if (r) pts.push({ lat: r.la, lon: r.lo }); }
    let n = -90, s = 90, e = -180, w = 180;
    for (const p of pts) {
      const dl = 650 / 111, dn = 650 / (111 * Math.cos(p.lat * Math.PI / 180));
      n = Math.max(n, p.lat + dl); s = Math.min(s, p.lat - dl); e = Math.max(e, p.lon + dn); w = Math.min(w, p.lon - dn);
    }
    if (LTG.national) { n = -8; s = -45; e = 156; w = 110; }
    return [n, e, s, w].map(v => +v.toFixed(2));
  }
  function ltgConnect() {
    const box = ltgBox();
    if (LTG.ws && LTG.ws.readyState <= 1 && JSON.stringify(box) === JSON.stringify(LTG.box)) return;
    try { LTG.ws && LTG.ws.close(); } catch { /* ignore */ }
    LTG.box = box;
    let ws;
    try { ws = new WebSocket(["wss://live.lightningmaps.org/", "wss://live2.lightningmaps.org/"][Math.floor(Date.now() / 60e3) % 2]); } catch { return; }
    LTG.ws = ws;
    ws.onopen = () => { LTG.status.connected = true; ws.send(JSON.stringify({ v: 24, i: {}, s: false, x: 0, w: 0, tx: 0, tw: 1, a: 4, z: 4, b: true, h: "", l: 1, t: 1, from_lightningmaps_org: true, p: box })); };
    ws.onmessage = e => {
      let j; try { j = JSON.parse(e.data); } catch { return; }
      const seen = LTG.seen || (LTG.seen = new Set());
      for (const s of j.strokes || []) {
        if (s.lat == null || s.time == null) continue;
        const k = `${s.time}|${s.lat.toFixed(3)}|${s.lon.toFixed(3)}`;
        if (seen.has(k)) continue;
        seen.add(k); LTG.strikes.push([+s.time, s.lat, s.lon]); LTG.status.kept++; LTG.status.last_strike = +s.time;
      }
      if (seen.size > 40000) seen.clear();
      const cut = Date.now() - 3 * 3600e3;
      if (LTG.strikes.length > 60000 || (LTG.strikes[0] && LTG.strikes[0][0] < cut)) LTG.strikes = LTG.strikes.filter(s => s[0] >= cut);
    };
    ws.onclose = () => { LTG.status.connected = false; if (LTG.ws === ws) { LTG.ws = null; setTimeout(ltgConnect, 15e3); } };
  }
  function lightning(q) {
    const [lat, lon] = radarPoint(q.get("radar"));
    LTG.national = q.get("radar") === NAT.PID;
    ltgConnect();
    const t0 = Date.parse(q.get("start")), t1 = Date.parse(q.get("end"));
    if (!isFinite(t0) || !isFinite(t1) || t1 < t0) throw httpError(400, "start and end must be ISO times");
    const radius = Math.min(3000, +q.get("radius") || 600);
    const rows = LTG.strikes.filter(s => s[0] >= t0 && s[0] <= t1 && dist(lat, lon, s[1], s[2]) <= radius).sort((a, b) => a[0] - b[0]);
    if (q.get("fmt") !== "bin") return { strikes: rows, status: LTG.status };
    const hdr = new TextEncoder().encode(JSON.stringify({ t0, n: rows.length, status: LTG.status }));
    const pad = (4 - (hdr.length % 4)) % 4, n = rows.length, off = 4 + hdr.length + pad;
    const out = new ArrayBuffer(off + 12 * n), v = new DataView(out);
    v.setUint32(0, hdr.length, true); new Uint8Array(out, 4, hdr.length).set(hdr);
    const secs = new Uint32Array(out, off, n), la = new Float32Array(out, off + 4 * n, n), lo = new Float32Array(out, off + 8 * n, n);
    rows.forEach((r, i) => { secs[i] = Math.round((r[0] - t0) / 1000); la[i] = r[1]; lo[i] = r[2]; });
    return out;
  }

  // ---------------------------------------------------------------- forecasts (Open-Meteo, same requests the server makes)
  const OM = "https://api.open-meteo.com/v1/forecast";
  const tzName = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Perth";
  async function forecast(q) {
    const h = home();
    const lat = q.get("lat") != null ? +(+q.get("lat")).toFixed(3) : h.lat, lon = q.get("lon") != null ? +(+q.get("lon")).toFixed(3) : h.lon;
    const common = { latitude: lat, longitude: lon, timezone: tzName(), timeformat: "unixtime" };
    const main = await cached(`fcm|${lat},${lon}`, 900e3, () => http(OM, "json", { params: { ...common, forecast_days: 7,
      hourly: "temperature_2m,apparent_temperature,dew_point_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cape,lifted_index,cloud_cover,pressure_msl",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max" } }));
    const models = await cached(`fcmod|${lat},${lon}`, 900e3, () => http(OM, "json", { params: { ...common, forecast_hours: 72,
      hourly: "temperature_2m,precipitation", models: "ecmwf_ifs025,gfs_seamless,icon_seamless" } })).catch(() => ({ hourly: { time: [] } }));
    let rain_range = null;
    try {
      const d = await cached(`fcens|${lat},${lon}`, 3600e3, () => http("https://ensemble-api.open-meteo.com/v1/ensemble", "json", { params: { ...common,
        hourly: "precipitation", models: "ecmwf_ifs025", forecast_days: 7 } }));
      rain_range = rainRanges(d);
    } catch { /* optional */ }
    return { main, models, rain_range };
  }
  function rainRanges(d) {
    const H = d.hourly, off = d.utc_offset_seconds || 0, days = {};
    const members = Object.keys(H).filter(k => k.startsWith("precipitation"));
    H.time.forEach((t, i) => {
      const day = new Date((t + off) * 1000).toISOString().slice(0, 10);
      for (const k of members) { const v = H[k][i]; if (v != null) { days[day] = days[day] || {}; days[day][k] = (days[day][k] || 0) + v; } }
    });
    const out = {};
    for (const [day, sums] of Object.entries(days)) {
      const vals = Object.values(sums).sort((a, b) => a - b);
      if (vals.length < 10) continue;
      const qf = f => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
      out[day] = { chance: Math.round(100 * vals.filter(v => v >= 0.2).length / vals.length), low: +qf(0.25).toFixed(1), high: +qf(0.75).toFixed(1) };
    }
    return out;
  }
  async function sounding(q) {
    const h = home();
    const lat = q.get("lat") != null ? +(+q.get("lat")).toFixed(3) : h.lat, lon = q.get("lon") != null ? +(+q.get("lon")).toFixed(3) : h.lon;
    const levels = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100];
    let hourly = ["temperature_2m", "dew_point_2m", "surface_pressure", "wind_speed_10m", "wind_direction_10m", "cape", "lifted_index",
      "convective_inhibition", "freezing_level_height", "boundary_layer_height"];
    for (const p of levels) hourly = hourly.concat([`temperature_${p}hPa`, `dew_point_${p}hPa`, `wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]);
    const data = await cached(`snd|${lat},${lon}`, 1800e3, () => http(OM, "json", { params: { latitude: lat, longitude: lon, hourly: hourly.join(","),
      forecast_hours: 48, wind_speed_unit: "ms", timeformat: "unixtime", timezone: tzName() } }));
    return { levels, data };
  }

  // forecast grids around a radar: same point layout, variables and binary encoding as the server
  const KINDS = {
    sfc: { api: OM, vars: { temp: "temperature_2m", dew: "dew_point_2m", rh: "relative_humidity_2m", gust: "wind_gusts_10m", rain: "precipitation", cloud: "cloud_cover", mslp: "pressure_msl", cape: "cape" }, wind: ["wind_speed_10m", "wind_direction_10m"], models: true },
    sfc2: { api: OM, vars: { wbt: "wet_bulb_temperature_2m", low: "cloud_cover_low", mid: "cloud_cover_mid", high: "cloud_cover_high", vis: "visibility", li: "lifted_index", fzl: "freezing_level_height", uv: "uv_index" }, models: true },
    marine: { api: "https://marine-api.open-meteo.com/v1/marine", vars: { wave: "wave_height", wper: "wave_period", swell: "swell_wave_height", sper: "swell_wave_period", sst: "sea_surface_temperature", cur: "ocean_current_velocity" }, wind: ["swell_wave_height", "swell_wave_direction"], dirOnly: true, models: false },
    air: { api: "https://air-quality-api.open-meteo.com/v1/air-quality", vars: { pm25: "pm2_5", pm10: "pm10", dust: "dust", aod: "aerosol_optical_depth", aqi: "us_aqi", co: "carbon_monoxide", uvi: "uv_index" }, models: false },
    svr: { api: OM, vars: { t2: "temperature_2m", td2: "dew_point_2m", cape: "cape", cin: "convective_inhibition", ws0: "wind_speed_10m", wd0: "wind_direction_10m",
      ws925: "wind_speed_925hPa", wd925: "wind_direction_925hPa", ws850: "wind_speed_850hPa", wd850: "wind_direction_850hPa", ws700: "wind_speed_700hPa", wd700: "wind_direction_700hPa",
      ws500: "wind_speed_500hPa", wd500: "wind_direction_500hPa" }, models: true, derive: true },
  };
  for (const p of [925, 850, 700, 500, 300, 250]) KINDS[`p${p}`] = { api: OM, vars: { temp: `temperature_${p}hPa`, rh: `relative_humidity_${p}hPa`, gph: `geopotential_height_${p}hPa` }, wind: [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`], models: true };
  const FC_MODELS = { best: null, ecmwf: "ecmwf_ifs025", gfs: "gfs_seamless", icon: "icon_seamless", access: "bom_access_global" };
  function gridPoints(lat0, lon0, half, n) {
    const step = 2 * half / (n - 1), pts = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -half + i * step, y = half - j * step, la = lat0 + y / KM;
      pts.push([+la.toFixed(3), +(lon0 + x / (KM * Math.cos(la * Math.PI / 180))).toFixed(3)]);
    }
    return pts;
  }
  const SVR_Z = [0, 0.75, 1.5, 3, 5.6];
  function svrPoint(get, southern) {
    const U = [], V = [];
    for (const lv of ["0", "925", "850", "700", "500"]) {
      const ws = get(`ws${lv}`), wd = get(`wd${lv}`);
      if (ws == null || wd == null) return null;
      const w = ws / 3.6; U.push(-w * Math.sin(wd * Math.PI / 180)); V.push(-w * Math.cos(wd * Math.PI / 180));
    }
    const at = z => {
      for (let i = 0; i < SVR_Z.length - 1; i++) if (SVR_Z[i] <= z && z <= SVR_Z[i + 1]) { const f = (z - SVR_Z[i]) / (SVR_Z[i + 1] - SVR_Z[i]); return [U[i] + (U[i + 1] - U[i]) * f, V[i] + (V[i + 1] - V[i]) * f]; }
      return [U[4], V[4]];
    };
    let mu = 0, mv = 0;
    for (let k = 0; k < 23; k++) { const [a, b] = at(k * 0.25); mu += a / 23; mv += b / 23; }
    const su = U[4] - U[0], sv = V[4] - V[0], bwd = Math.hypot(su, sv) || 0.1;
    const dev = [7.5 * sv / bwd, -7.5 * su / bwd];
    const sm = southern ? [mu - dev[0], mv - dev[1]] : [mu + dev[0], mv + dev[1]];
    const srh = ztop => { let h = 0; for (let z = 0; z < ztop - 1e-6; z += 0.1) { const [u1, v1] = at(z), [u2, v2] = at(Math.min(ztop, z + 0.1)); h += (u2 - sm[0]) * (v1 - sm[1]) - (u1 - sm[0]) * (v2 - sm[1]); } return southern ? -h : h; };
    const srh1 = srh(1), srh3 = srh(3), cape = get("cape") || 0, cin = -Math.abs(get("cin") || 0), t2 = get("t2"), td2 = get("td2");
    const lcl = t2 != null && td2 != null ? 125 * (t2 - td2) : 1500;
    const lclT = lcl < 1000 ? 1 : lcl > 2000 ? 0 : (2000 - lcl) / 1000, shrT = bwd < 12.5 ? 0 : Math.min(1.5, bwd / 20), cinT = cin > -50 ? 1 : cin < -200 ? 0 : (200 + cin) / 150;
    const stp = Math.max(0, cape / 1500) * lclT * Math.max(0, srh1 / 150) * shrT * cinT;
    const scp = Math.max(0, cape / 1000) * Math.max(0, srh3 / 50) * (bwd < 10 ? 0 : Math.min(1, bwd / 20));
    return { stp: +stp.toFixed(2), scp: +scp.toFixed(2), shear6: +(bwd * 1.944).toFixed(1), srh1: Math.round(srh1), srh3: Math.round(srh3), lcl: Math.round(lcl),
      cin: Math.round(cin), cape: Math.round(cape), u: +(sm[0] * 3.6).toFixed(1), v: +(sm[1] * 3.6).toFixed(1), mu: +(mu * 3.6).toFixed(1), mv: +(mv * 3.6).toFixed(1) };
  }
  async function forecastGrid(lat0, lon0, model, kind, half, n = 13) {
    const spec = KINDS[kind];
    if (!spec) throw httpError(400, "unknown kind");
    const pts = gridPoints(lat0, lon0, half, n);
    const want = [...new Set(Object.values(spec.vars).concat(spec.wind || []))];
    const rows = [];
    for (let k = 0; k < pts.length; k += 100) {
      const ch = pts.slice(k, k + 100);
      const params = { latitude: ch.map(p => p[0]).join(","), longitude: ch.map(p => p[1]).join(","), hourly: want.join(","), forecast_hours: 48, timeformat: "unixtime", timezone: tzName() };
      if (kind !== "air" && kind !== "marine") params.wind_speed_unit = "kmh";
      if (spec.models && FC_MODELS[model]) params.models = FC_MODELS[model];
      const d = await http(spec.api, "json", { params, timeout: 60000 });
      rows.push(...(Array.isArray(d) ? d : [d]));
    }
    const times = rows[0].hourly.time.slice(0, 48), nt = times.length, vars = {};
    if (spec.derive) {
      const keys = ["stp", "scp", "shear6", "srh1", "srh3", "lcl", "cin", "cape", "u", "v", "mu", "mv"];
      for (const k of keys) vars[k] = Array.from({ length: nt }, () => new Array(rows.length).fill(null));
      rows.forEach((row, p) => {
        const H = row.hourly || {};
        for (let t = 0; t < nt; t++) {
          const r = svrPoint(k => { const a = H[spec.vars[k]]; return a && t < a.length ? a[t] : null; }, lat0 < 0);
          if (r) for (const k of keys) vars[k][t][p] = r[k];
        }
      });
    } else {
      const keys = Object.keys(spec.vars).concat(spec.wind ? ["u", "v"] : []);
      for (const k of keys) vars[k] = Array.from({ length: nt }, () => new Array(rows.length).fill(null));
      rows.forEach((row, p) => {
        const H = row.hourly || {};
        for (let t = 0; t < nt; t++) {
          if (spec.wind) {
            let ws = (H[spec.wind[0]] || [])[t], wd = (H[spec.wind[1]] || [])[t];
            if (ws != null && wd != null) {
              if (spec.dirOnly) { ws = 30; wd = (wd + 180) % 360; }
              vars.u[t][p] = +(-ws * Math.sin(wd * Math.PI / 180)).toFixed(1); vars.v[t][p] = +(-ws * Math.cos(wd * Math.PI / 180)).toFixed(1);
            }
          }
          for (const [key, v] of Object.entries(spec.vars)) { const a = H[v]; const x = a && t < a.length ? a[t] : null; vars[key][t][p] = x == null ? null : +x.toFixed(key === "aod" ? 2 : 1); }
        }
      });
    }
    return { half, n, time: times, kind, vars };
  }
  function gridBin(D) {
    const names = [], scales = [], blobs = [];
    for (const [k, arr] of Object.entries(D.vars)) {
      let amax = 0;
      for (const row of arr) for (const v of row) if (v != null && isFinite(v)) amax = Math.max(amax, Math.abs(v));
      const sc = Math.max((amax || 1) / 32000, 1e-4), q = new Int16Array(arr.length * arr[0].length);
      let i = 0;
      for (const row of arr) for (const v of row) q[i++] = v == null || !isFinite(v) ? -32768 : Math.round(v / sc);
      names.push(k); scales.push(sc); blobs.push(q);
    }
    const hdr = new TextEncoder().encode(JSON.stringify({ half: D.half, n: D.n, time: D.time, kind: D.kind, vars: names, scales }));
    const pad = (2 - (hdr.length % 2)) % 2, total = 4 + hdr.length + pad + blobs.reduce((a, b) => a + b.byteLength, 0);
    const out = new Uint8Array(total);
    new DataView(out.buffer).setUint32(0, hdr.length, true); out.set(hdr, 4);
    let o = 4 + hdr.length + pad;
    for (const b of blobs) { out.set(new Uint8Array(b.buffer), o); o += b.byteLength; }
    return out.buffer;
  }
  function fcgrid(radar, model, kind) {
    const [lat, lon] = radarPoint(radar), half = radar === NAT.PID ? 2600 : 600;
    return cached(`fcg|${radar}|${model}|${kind}`, 3 * 3600e3, () => forecastGrid(lat, lon, model, kind, half), 120e3);
  }

  // ---------------------------------------------------------------- BoM observations and warnings
  const STATE_OF = (la, lo) => lo < 129 ? "W" : la < -39.3 ? "T" : (lo < 138 && la > -26) ? "D" : lo < 141 ? "S" : la > -28.6 ? "Q" : (la < -34 && lo < 150 && (la < -36 || lo < 144.5)) ? "V" : "N";
  const FEED = { W: "IDZ00060.warnings_wa", N: "IDZ00054.warnings_nsw", V: "IDZ00059.warnings_vic", Q: "IDZ00056.warnings_qld", S: "IDZ00057.warnings_sa", T: "IDZ00058.warnings_tas", D: "IDZ00055.warnings_nt" };
  const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
  async function stateObs(st) {
    return cached(`obsxml|${st}`, 600e3, async () => {
      const doc = new DOMParser().parseFromString(await http(`${BOM}/fwo/ID${st}60920.xml`), "text/xml");
      return [...doc.querySelectorAll("station")].map(s => {
        const vals = {}; let tm = null;
        s.querySelectorAll("period").forEach(p => { tm = p.getAttribute("time-utc") || tm; p.querySelectorAll("element").forEach(e => { vals[e.getAttribute("type")] = e.textContent; }); });
        return { name: s.getAttribute("description") || s.getAttribute("stn-name"), wmo: s.getAttribute("wmo-id"), state: st, lat: num(s.getAttribute("lat")), lon: num(s.getAttribute("lon")), time: tm,
          t: num(vals.air_temperature), td: num(vals.dew_point), dir: num(vals.wind_dir_deg), spd: num(vals.wind_spd_kmh), gust: num(vals.gust_kmh), msl: num(vals.msl_pres), rain: num(vals.rainfall) };
      }).filter(s => s.lat != null);
    });
  }
  async function obsmap(scope) {
    const h = home();
    const states = scope === "national" ? ["W", "N", "V", "Q", "S", "T", "D"] : [STATE_OF(h.lat, h.lon)];
    let out = [];
    for (const s of states) { try { out = out.concat(await stateObs(s)); } catch { /* skip state */ } }
    if (!out.length) throw httpError(502, "BoM station observations didn't load");
    return { stations: out };
  }
  async function obs() {
    const h = home(), st = STATE_OF(h.lat, h.lon);
    const list = (await stateObs(st).catch(() => [])).filter(s => s.wmo).sort((a, b) => dist(h.lat, h.lon, a.lat, a.lon) - dist(h.lat, h.lon, b.lat, b.lon)).slice(0, 3);
    return Promise.all(list.map(async s => {
      const id = `ID${st}60801.${s.wmo}`;
      try {
        const j = await cached(`obsjson|${id}`, 300e3, () => http(`${BOM}/fwo/ID${st}60801/${id}.json`, "json"));
        const rows = j.observations.data, hist = [];
        for (const x of [...rows].reverse()) {
          const t = x.aifstime_utc; if (!t) continue;
          hist.push({ t: new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12))).toISOString(),
            temp: num(x.air_temp), app: num(x.apparent_t), dew: num(x.dewpt), rh: num(x.rel_hum), press: num(x.press_msl), wind: num(x.wind_spd_kmh), gust: num(x.gust_kmh), dir: x.wind_dir, rain: num(x.rain_trace) });
        }
        return { id, name: rows[0] ? rows[0].name : s.name, lat: s.lat, lon: s.lon, latest: hist[hist.length - 1] || null, history: hist };
      } catch (e) { return { id, error: String(e.message || e) }; }
    }));
  }
  async function bomWarnings(st) {
    return cached(`warn|${st}`, 300e3, async () => {
      const doc = new DOMParser().parseFromString(await http(`${BOM}/fwo/${FEED[st]}.xml`), "text/xml");
      return [...doc.querySelectorAll("item")].map(it => {
        const title = (it.querySelector("title")?.textContent || "").replace(/\s+/g, " ").trim(), low = title.toLowerCase();
        const level = /thunderstorm|severe weather|cyclone|tsunami|emergency/.test(low) ? "severe" : /flood/.test(low) ? "flood" : "other";
        return { title, link: (it.querySelector("link")?.textContent || "").replace("http://", "https://"), pub: it.querySelector("pubDate")?.textContent, level };
      });
    });
  }
  async function warnings(scope) {
    const h = home(), states = scope === "national" ? Object.keys(FEED) : [STATE_OF(h.lat, h.lon)];
    let out = [];
    for (const s of states) { try { out = out.concat(await bomWarnings(s)); } catch { /* skip */ } }
    return { warnings: out };
  }
  async function warningText(link) {
    return cached(`wtext|${link}`, 600e3, async () => {
      const html = await http(link);
      const doc = new DOMParser().parseFromString(html, "text/html");
      return (doc.querySelector("#content") || doc.body).textContent.replace(/\s+/g, " ").trim();
    }, 300e3);
  }

  // ---------------------------------------------------------------- satellite (NASA GIBS, flattened to the radar's grid)
  const GIBS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
  const SAT_SIZE = { 512: 768, 1536: 1024, 2600: 1100 };
  function sunUp(lat, lon, when) {
    const d = new Date(when), doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
    const decl = 23.44 * Math.sin((2 * Math.PI / 365) * (doy - 81)) * Math.PI / 180;
    const ha = ((d.getUTCHours() + d.getUTCMinutes() / 60 + lon / 15 - 12) * 15) * Math.PI / 180, la = lat * Math.PI / 180;
    return Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha) > 0.05;
  }
  async function wmsFlat(layer, lat0, lon0, half, size, time, fmt = "image/png") {
    const dl = half / KM, latN = lat0 + dl, latS = lat0 - dl;
    // the widest longitude span is at the box edge furthest from the equator
    const cosMin = Math.cos(Math.min(80, Math.max(Math.abs(latN), Math.abs(latS))) * Math.PI / 180);
    const dn = half / (KM * cosMin);
    const W = size, Hh = size;
    const params = { SERVICE: "WMS", REQUEST: "GetMap", VERSION: "1.1.1", LAYERS: layer, SRS: "EPSG:4326", BBOX: [lon0 - dn, latS, lon0 + dn, latN].map(v => v.toFixed(4)).join(","),
      WIDTH: W, HEIGHT: Hh, FORMAT: fmt, TRANSPARENT: "TRUE" };
    if (time) params.TIME = time;
    const buf = await http(GIBS, "bytes", { params, timeout: 45000 });
    const src = await createImageBitmap(new Blob([buf]));
    // each output row: same latitude, longitudes stretched by 1/cos(lat) (BoM's flat-earth radar grid)
    const cv = new OffscreenCanvas(size, size), g = cv.getContext("2d");
    for (let j = 0; j < size; j++) {
      const y = half - (j + 0.5) * 2 * half / size, la = lat0 + y / KM;
      const sy = (latN - la) / (latN - latS) * src.height;
      const spanLon = half / (KM * Math.cos(la * Math.PI / 180));
      const sx0 = (lon0 - spanLon - (lon0 - dn)) / (2 * dn) * src.width, sw = (2 * spanLon) / (2 * dn) * src.width;
      g.drawImage(src, sx0, Math.floor(sy), sw, 1, 0, j, size, 1);
    }
    src.close();
    return cv.convertToBlob({ type: "image/png" });
  }
  async function sat(layer, q) {
    const radar = q.get("radar"), half = +q.get("half") || 512, [lat, lon] = radarPoint(radar);
    const want = q.get("t") ? Date.parse(q.get("t")) : Date.now();
    const slot = Math.floor(Math.min(want, Date.now() - 50 * 60e3) / 600e3) * 600e3;      // GIBS runs ~40-50 min behind
    let name = { ir13e: "Himawari_AHI_Band13_Clean_Infrared", ir: "Himawari_AHI_Band13_Clean_Infrared", vis: "Himawari_AHI_Band3_Red_Visible_1km", airmass: "Himawari_AHI_Air_Mass" }[layer];
    if (layer === "geocolor") name = sunUp(lat, lon, slot) ? "Himawari_AHI_Band3_Red_Visible_1km" : "Himawari_AHI_Band13_Clean_Infrared";
    if (!name) throw httpError(404, "That satellite channel needs the Radarhound server");
    const size = SAT_SIZE[half] || 768;
    const blob = await cached(`sat|${name}|${radar}|${half}|${slot}`, 6 * 3600e3, () => wmsFlat(name, lat, lon, half, size, new Date(slot).toISOString().slice(0, 16) + ":00Z"), 120e3);
    return new Response(blob, { headers: { "content-type": "image/png", "X-Sat-Time": new Date(slot).toISOString(), "X-Sat-Half-Km": String(half) } });
  }
  async function satcoast(q) {
    const radar = q.get("radar"), half = +q.get("half") || 1536, [lat, lon] = radarPoint(radar);
    const blob = await cached(`coast|${radar}|${half}`, 30 * 86400e3, () => wmsFlat("Coastlines_15m", lat, lon, half, SAT_SIZE[half] || 1300), 600e3);
    return new Response(blob, { headers: { "content-type": "image/png" } });
  }
  async function natbase() {
    const blob = await cached("natbase", 30 * 86400e3, async () => {
      const b = await wmsFlat("BlueMarble_ShadedRelief_Bathymetry", NAT.LAT0, NAT.LON0, 2600, 1300, null, "image/jpeg");
      // darken to match Radarhound's night map
      const bmp = await createImageBitmap(b), cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext("2d");
      g.fillStyle = "#0b1820"; g.fillRect(0, 0, cv.width, cv.height);
      g.globalAlpha = 0.45; g.drawImage(bmp, 0, 0); bmp.close();
      return cv.convertToBlob({ type: "image/png" });
    }, 600e3);
    return new Response(blob, { headers: { "content-type": "image/png" } });
  }

  // ---------------------------------------------------------------- other feeds
  async function metar() {
    const h = home();
    const box = LTG.national ? [-45, 110, -9, 155] : [h.lat - 6, h.lon - 7, h.lat + 6, h.lon + 7];
    const list = await cached(`metar|${box.join(",")}`, 600e3, () => http("https://aviationweather.gov/api/data/metar", "json", { params: { bbox: box.map(v => v.toFixed(2)).join(","), format: "json" } }));
    return { metars: (list || []).filter(m => m.lat != null).map(m => ({ icaoId: m.icaoId, name: m.name, lat: m.lat, lon: m.lon, temp: m.temp, dewp: m.dewp, wdir: m.wdir, wspd: m.wspd,
      wgst: m.wgst, visib: m.visib, altim: m.altim, rawOb: m.rawOb, reportTime: m.reportTime, fltCat: m.fltCat, cover: m.cover, wxString: m.wxString })) };
  }
  async function fires() {
    const csv = await cached("fires", 900e3, () => http("https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Australia_NewZealand_24h.csv"));
    const lines = csv.trim().split("\n"), head = lines.shift().split(",");
    const I = k => head.indexOf(k);
    return { fires: lines.map(l => l.split(",")).map(c => ({ la: +c[I("latitude")], lo: +c[I("longitude")],
      t: `${c[I("acq_date")]}T${(c[I("acq_time")] || "0000").padStart(4, "0").replace(/(\d\d)(\d\d)/, "$1:$2")}:00Z`, frp: +c[I("frp")], conf: c[I("confidence")], sat: "VIIRS S-NPP" })).filter(f => isFinite(f.la)) };
  }
  async function geocode(q) {
    q = (q || "").trim();
    if (q.length < 3) throw httpError(400, "type at least 3 characters");
    return cached(`geo|${q.toLowerCase()}`, 86400e3, async () => {
      const out = [];
      try {
        const r = await http("https://nominatim.openstreetmap.org/search", "json", { params: { q, countrycodes: "au", format: "jsonv2", limit: 6, addressdetails: 1 } });
        for (const x of r) {
          const a = x.address || {};
          out.push({ label: x.display_name.replace(", Australia", ""), name: (a.suburb || a.town || a.city || a.village || a.hamlet || x.name || x.display_name.split(",")[0]).slice(0, 40), lat: +(+x.lat).toFixed(5), lon: +(+x.lon).toFixed(5) });
        }
      } catch { /* fall back */ }
      if (out.length < 3) {
        try {
          const r = await http("https://geocoding-api.open-meteo.com/v1/search", "json", { params: { name: q, count: 6, language: "en", format: "json", countryCode: "AU" } });
          for (const x of r.results || []) if (!out.some(o => Math.abs(o.lat - x.latitude) < 0.01 && Math.abs(o.lon - x.longitude) < 0.01))
            out.push({ label: [x.name, x.admin2, x.admin1].filter(Boolean).join(", "), name: x.name.slice(0, 40), lat: +x.latitude.toFixed(5), lon: +x.longitude.toFixed(5) });
        } catch { /* nothing */ }
      }
      return { results: out.slice(0, 8) };
    }, 30e3);
  }

  // ---------------------------------------------------------------- the router
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const bin = buf => new Response(buf, { headers: { "content-type": "application/octet-stream" } });
  const listStore = key => ({ get: () => LS.get(key, []), set: v => LS.set(key, v) });
  async function route(path, q, method, body) {
    await ready;
    const parts = path.split("/").filter(Boolean);          // ["api", "frames", "IDR703"]
    if (parts[0] === "frames") { const b = await frameBuf(parts[2]); if (!b) throw httpError(404, "gone"); return new Response(b, { headers: { "content-type": "image/png" } }); }
    if (parts[0] === "layers") { const m = parts[1].match(/^(IDR\w+)\.(\w+)\.png$/); return new Response(await layerImage(m[1], m[2]), { headers: { "content-type": "image/png" } }); }
    const ep = parts[1];
    const E = window.WXP_ENGINE;
    switch (ep) {
      case "config": return json(await config());
      case "frames": return json(await framesList(parts[2], +q.get("hours") || 1));
      case "loop": {
        const names = (q.get("names") || "").split(",").filter(Boolean);
        const got = await Promise.all(names.map(async n => { try { return [n, await frameBuf(n)]; } catch { return null; } }));
        return bin(bundle(got.filter(x => x && x[1])));
      }
      case "lightning": { const r = lightning(q); return r instanceof ArrayBuffer ? bin(r) : json(r); }
      case "forecast": return json(await forecast(q));
      case "sounding": return json(await sounding(q));
      case "fcgrid": {
        const D = await fcgrid(q.get("radar"), q.get("model") || "best", q.get("kind") || "sfc");
        return q.get("fmt") === "bin" ? bin(gridBin(D)) : json(D);
      }
      case "obs": return json(await obs());
      case "obsmap": return json(await obsmap(q.get("scope")));
      case "warnings": return json(await warnings(q.get("scope")));
      case "towns": return json({ towns: DATA.towns.towns || [] });
      case "borders": return json({ lines: DATA.borders.lines || DATA.borders || [] });
      case "highways": return json({ lines: DATA.highways.lines || [] });
      case "fires": return json(await fires());
      case "metar": return json(await metar());
      case "webcams": return json({ webcams: [], enabled: false });
      case "geocode": return json(await geocode(q.get("q")));
      case "sat": return sat(parts[2], q);
      case "satcoast": return satcoast(q);
      case "natbase": return natbase();
      case "home": {
        if (method === "POST") {
          const lat = +body.lat, lon = +body.lon;
          if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw httpError(400, "lat/lon out of range");
          const h = { name: String(body.name || "Home").slice(0, 40), lat: +lat.toFixed(5), lon: +lon.toFixed(5) };
          LS.set("home", h);
          if (!LS.get("radars", null)) LS.set("radars", myRadars());
          for (const k of [...memo.keys()]) if (k.startsWith("fc")) memo.delete(k);
          native("setPhoneHome", h);
          return json(h);
        }
        return json(home());
      }
      case "radars": {
        const ids = (body.radars || []).map(String).filter(id => radarById(id)).slice(0, 8);
        if (!ids.length) throw httpError(400, "need at least one radar number");
        LS.set("radars", ids); return json({ radars: ids });
      }
      case "follow": {
        const ids = (body.radars || [body.radar]).map(String).filter(id => radarById(id)).slice(0, 16);
        if (!ids.length) throw httpError(400, "bad radar");
        const auto = LS.get("auto", {}), hours = Math.min(24, Math.max(0.25, +body.hours || 3));
        const fresh = ids.filter(id => !followed().includes(id));
        for (const id of ids) if (!myRadars().includes(id)) auto[id] = Math.max(auto[id] || 0, Date.now() + hours * 3600e3);
        LS.set("auto", auto);
        if (body.wait !== false) await Promise.all(fresh.flatMap(id => ["3", "I"].map(s => loopNames(`IDR${id}${s}`).catch(() => null))));
        return json({ radars: followed(), new: fresh });
      }
      case "spots": case "reports": case "cases": {
        const S_ = listStore(ep);
        if (method === "POST") {
          const lat = +body.lat, lon = +body.lon;
          if (ep !== "cases" && (!isFinite(lat) || !isFinite(lon))) throw httpError(400, "lat/lon out of range");
          const item = ep === "spots" ? { name: String(body.name || "Spot").slice(0, 40), lat: +lat.toFixed(4), lon: +lon.toFixed(4) }
            : ep === "reports" ? { lat: +lat.toFixed(4), lon: +lon.toFixed(4), kind: String(body.kind || "other").slice(0, 20), size: body.size ? +body.size : null, note: String(body.note || "").slice(0, 200), t: body.t || new Date().toISOString() }
            : { ...body };
          item.id = ep === "spots" ? `${item.lat},${item.lon}` : ep === "reports" ? `r${Date.now()}` : `${body.radar}-${body.date}-${body.scan}`;
          S_.set(S_.get().filter(x => x.id !== item.id).concat([item]).slice(-500));
        } else if (method === "DELETE") S_.set(S_.get().filter(x => x.id !== decodeURIComponent(parts[2])));
        return json({ [ep]: S_.get() });
      }
      case "speech": throw httpError(503, "phone voice");
      case "wxwarnings": return json(E ? await E.wxwarnings() : { active: [], recent: [], watches: [], storms: [], enabled: false });
      case "alerts": return json(E ? await E.alerts(q) : { alerts: [] });
      case "nowcast": return json(E ? await E.nowcastApi(q) : { text: "" });
      case "brief": return json(E ? await E.brief(q) : { text: "" });
      case "verify": return json({ days: 30, stats: { warnings: 0, by_type: {}, with_bom: 0, with_reports: 0, bom_thunderstorm_warnings: 0, bom_without_radarhound: 0 }, warnings: [], bom_missed: [], phone: true });
      case "status": return json({ phone: true, lightning: LTG.status });
      case "archive": case "hsd": case "obssounding":
        throw httpError(404, "This needs your Radarhound server (raw radar archive, raw satellite bands and observed soundings aren't available in phone mode)");
      default: throw httpError(404, "not available in phone mode");
    }
  }
  function native(method, arg) { try { const P = window.Capacitor && Capacitor.Plugins.WxAlerts; if (P && P[method]) return P[method](arg); } catch { /* not in the app */ } return null; }

  // ---------------------------------------------------------------- hook the page's fetch and image loading
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !/^\/(api|frames|layers)\//.test(u.pathname)) return origFetch(input, init);
    let body = {};
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = {}; } }
    try { return await route(u.pathname, u.searchParams, (init.method || "GET").toUpperCase(), body); }
    catch (e) { return json({ detail: e.message || String(e) }, e.status || 502); }
  };
  async function loadImageUrl(url) {
    const r = await window.fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const obj = URL.createObjectURL(await r.blob());
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(obj); res(im); };      // the decoded image stays; the blob can go
      im.onerror = e => { URL.revokeObjectURL(obj); rej(e); };
      im.src = obj;
    });
  }

  document.documentElement.classList.add("phone-mode");
  return { http, cached, home, followed, myRadars, radarById, radarPoint, frameBuf, loopNames, frameIndex, frameBytes, LTG, ltgConnect, DATA, ready, NAT,
    fcgrid, forecast, warnings: bomWarnings, warningText, stateObs, STATE_OF, dist, loadImageUrl, native, LS, origFetch, KM, nameTime };
})();
