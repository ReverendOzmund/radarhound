/* wxdeck phone mode: the parts of the server that think, ported to run on the phone.
   - wxdeck's own warnings (same rules as warnings_engine.py): storm cells on the latest 128 km image,
     tracking, Doppler couplets on two scans in a row, lightning, model environment, NWS-style polygons
   - the all-Australia mosaic, stitched from every radar's 512 km image (strongest echo wins)
   - the rain nowcast, the alert feed and the spoken day summary
   It runs while the app is open (every couple of minutes while it's on screen). Loaded after the page. */
"use strict";

const WXP_ENGINE = (() => {
  const P = WXP, KM = P.KM;
  const st = { active: {}, recent: [], tracks: {}, storms: {}, stormsT: {}, watches: [], watchT: 0, coup: {}, lastRun: null, envRadar: null };
  const DBZ = REFL_DBZ;                       // per palette index (0 = level 1)
  const TOR = 100, LEAD = 45;

  // ---------------------------------------------------------------- frames -> palette indices
  const decodeCache = new Map();
  async function levels(name, type) {
    const key = `${name}|${type}`;
    if (decodeCache.has(key)) return decodeCache.get(key);
    const buf = await P.frameBuf(name);
    if (!buf) return null;
    const out = await decodeBytes(buf.slice(0), type);
    decodeCache.set(key, out);
    if (decodeCache.size > 160) decodeCache.delete(decodeCache.keys().next().value);
    return out;
  }
  async function latestFrames(pid, n = 2) {
    if (pid === P.NAT.PID) await national.ensure(); else await P.loopNames(pid);
    const idx = P.frameIndex.get(pid);
    if (!idx || !idx.size) return [];
    return [...idx].sort((a, b) => a[1] - b[1]).slice(-n).map(([name, t]) => ({ name, t }));
  }

  // ---------------------------------------------------------------- helpers
  const kmToLL = (lat0, lon0, x, y) => { const la = lat0 + y / KM; return [la, lon0 + x / (KM * Math.cos(la * Math.PI / 180))]; };
  function inPoly(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[0] > lat) !== (b[0] > lat) && lon < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0] + 1e-12) + a[1]) inside = !inside;
    }
    return inside;
  }
  const towns = () => (P.DATA.towns && P.DATA.towns.towns) || [];
  function townsIn(poly, limit = 8) {
    const lats = poly.map(p => p[0]), lons = poly.map(p => p[1]);
    const a = Math.min(...lats), b = Math.max(...lats), c = Math.min(...lons), d = Math.max(...lons), out = [];
    for (const t of towns()) if (t.la >= a && t.la <= b && t.lo >= c && t.lo <= d && inPoly(t.la, t.lo, poly)) { out.push(t.n); if (out.length >= limit) break; }
    return out;
  }
  function nearestTown(lat, lon) {
    let best = null;
    for (const t of towns().slice(0, 2500)) {
      const d = P.dist(lat, lon, t.la, t.lo), score = d - Math.min(40, Math.log10(Math.max(t.p || 10, 10)) * 6);
      if (d <= 150 && (!best || score < best[0])) best = [score, t, d];
    }
    return best;
  }
  const compass = deg => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16];
  function nearestRadar(lat, lon, maxKm = 250) {
    let best = null;
    for (const r of P.DATA.radars) { const d = P.dist(lat, lon, r.la, r.lo); if (d <= maxKm && (!best || d < best[1])) best = [r, d]; }
    return best ? { id: best[0].id, km: Math.round(best[1]), name: best[0].n } : null;
  }
  function strikesNear(lat, lon, km, minutes = 10) {
    const t0 = Date.now() - minutes * 60e3;
    let n = 0;
    for (const s of P.LTG.strikes) if (s[0] >= t0 && Math.abs(s[1] - lat) < km / 100 && P.dist(lat, lon, s[1], s[2]) <= km) n++;
    return n;
  }
  function hullKm(pts) {
    const P2 = [...new Map(pts.map(p => [p.join(","), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (P2.length < 3) return P2;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const p of P2) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = P2.length - 1; i >= 0; i--) { const p = P2[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  }

  // ---------------------------------------------------------------- storm environment from the model grid
  const ENV = new Map();          // radar id -> {D, lat0, lon0}
  async function ensureEnv(rid) {
    if (ENV.has(rid) && Date.now() - ENV.get(rid).t < 3 * 3600e3) return;
    try {
      const [lat0, lon0] = P.radarPoint(rid);
      const D = await P.fcgrid(rid, "best", "svr");
      ENV.set(rid, { D, lat0, lon0, t: Date.now() });
    } catch { /* environment is optional */ }
  }
  function envAt(lat, lon) {
    for (const E of ENV.values()) {
      const D = E.D, n = D.n, half = D.half, step = 2 * half / (n - 1);
      const x = (lon - E.lon0) * KM * Math.cos(lat * Math.PI / 180), y = (lat - E.lat0) * KM;
      const i = Math.round((x + half) / step), j = Math.round((half - y) / step);
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const now = Date.now() / 1000;
      let t = 0; D.time.forEach((tt, k) => { if (Math.abs(tt - now) < Math.abs(D.time[t] - now)) t = k; });
      const out = {};
      for (const k of ["scp", "stp", "shear6", "srh1", "srh3", "lcl", "cape", "cin", "mu", "mv"]) if (D.vars[k]) out[k] = D.vars[k][t][j * n + i];
      if (out.scp != null) return out;
    }
    return null;
  }
  function assess(c, mxDbz, ltg, dv, hasDop, env, southern) {
    let sup = 0, tor = 0;
    const why = [];
    if (env) {
      const scp = env.scp || 0, stp = env.stp || 0, sh = env.shear6 || 0;
      if (scp >= 4) { sup += 2; why.push(`SCP ${scp.toFixed(1)} at the storm: environment strongly supports supercells`); }
      else if (scp >= 1) { sup += 1; why.push(`SCP ${scp.toFixed(1)} at the storm: environment supports supercells`); }
      else why.push(`SCP ${scp.toFixed(1)}: environment marginal for supercells`);
      if (sh >= 35) { sup += 1; why.push(`0–6 km shear ${sh.toFixed(0)} kt (enough for rotating updrafts)`); } else if (sh < 25) { sup -= 1; why.push(`0–6 km shear only ${sh.toFixed(0)} kt`); }
      if (stp >= 1) { tor += 2; why.push(`STP ${stp.toFixed(1)}: tornado ingredients present`); }
      else if (stp >= 0.5) { tor += 1; why.push(`STP ${stp.toFixed(1)}: weak tornado ingredients`); }
      else why.push(`STP ${stp.toFixed(1)}: tornado ingredients weak`);
      if ((env.srh1 || 0) >= 150) { tor += 1; why.push(`strong low-level spin (0–1 km helicity ${env.srh1.toFixed(0)})`); }
      if (env.lcl != null && env.lcl < 1000) { tor += 1; why.push(`low cloud base (${env.lcl.toFixed(0)} m)`); }
    } else why.push("no model environment for this spot yet");
    if (mxDbz >= 55 && (c.area50 || 0) >= 50) { sup += 1; why.push(`large intense core (${c.area50.toFixed(0)} km² above 50 dBZ)`); }
    if ((c.age || 1) >= 6) { sup += 1; why.push("long-lived (30+ minutes)"); }
    if (env && c.vx != null && (c.age || 1) >= 3 && env.mu != null && Math.hypot(c.vx, c.vy) >= 10) {
      const ang = Math.atan2(env.mu * c.vy - env.mv * c.vx, env.mu * c.vx + env.mv * c.vy) * 180 / Math.PI;
      if ((ang >= 20 && southern) || (ang <= -20 && !southern)) { sup += 2; why.push(`moving ${Math.abs(ang).toFixed(0)}° ${southern ? "left" : "right"} of the mean wind (classic supercell motion)`); }
    }
    if (hasDop) {
      if (dv >= 100) { sup += 3; tor += 3; why.push(`strong rotation on Doppler (ΔV ${dv.toFixed(0)} km/h)`); }
      else if (dv >= 70) { sup += 2; tor += 2; why.push(`rotation on Doppler (ΔV ${dv.toFixed(0)} km/h)`); }
      else why.push("no rotation seen on Doppler");
    } else why.push("rotation unknown: no Doppler on this storm yet");
    if (ltg >= 15) sup += 1;
    const rate = v => (v >= 5 ? "high" : v >= 3 ? "moderate" : "low");
    return { supercell: rate(sup), tornado: rate(tor), reasons: why, doppler: hasDop,
      env: env ? { scp: env.scp, stp: env.stp, shear6: env.shear6, srh1: env.srh1, lcl: env.lcl, cape: env.cape } : null };
  }

  // ---------------------------------------------------------------- one radar (or the national mosaic)
  async function runSource(src, lat0, lon0, reflPid, km, doppPid) {
    const fs = await latestFrames(reflPid, 1);
    if (!fs.length) return;
    const { name, t: tNow } = fs[0];
    if (Date.now() - tNow > 12 * 60e3) return;
    const prev = st.tracks[src];
    if (prev && prev.t === tNow) return;
    const lv = await levels(name, "0");
    if (!lv) return;
    const N = Math.round(Math.sqrt(lv.length)), kpp = km / (N / 2);
    const cells = ALGO.detectCells(lv, kpp, 6, 10);
    const cores = ALGO.detectCells(lv, kpp, 10, 0);
    for (const c of cells) c.area50 = cores.filter(k => inPoly(k.y, k.x, c.hull.map(([x, y]) => [y, x]))).reduce((a, k) => a + k.area, 0);
    // motion from the previous tracked frame
    if (prev && tNow - prev.t > 0 && tNow - prev.t <= 1800e3) {
      const dt = (tNow - prev.t) / 3600e3, used = new Set();
      for (const c of [...cells].sort((a, b) => b.area - a.area)) {
        let best = null, bd = 1e9;
        prev.cells.forEach((p, j) => {
          if (used.has(j)) return;
          const px = p.x + (p.vx || 0) * dt, py = p.y + (p.vy || 0) * dt, d = Math.hypot(c.x - px, c.y - py);
          if (d < 130 * dt + 5 && d < bd) { best = j; bd = d; }
        });
        if (best == null) continue;
        used.add(best);
        const p = prev.cells[best];
        let vx = (c.x - p.x) / dt, vy = (c.y - p.y) / dt;
        if (Math.hypot(vx, vy) > 110) { vx = p.vx || 0; vy = p.vy || 0; }
        c.vx = p.vx == null ? vx : 0.5 * vx + 0.5 * p.vx; c.vy = p.vy == null ? vy : 0.5 * vy + 0.5 * p.vy;
        c.id = p.id; c.age = (p.age || 1) + 1; c.first = p.first;
      }
    }
    const hhmm = new Date(tNow).toISOString().slice(11, 16).replace(":", "");
    for (const c of cells) { c.id = c.id || `${src}-${hhmm}-${Math.trunc(c.x)}-${Math.trunc(c.y)}`; c.age = c.age || 1; c.first = c.first || new Date(tNow).toISOString(); }
    st.tracks[src] = { t: tNow, cells };

    let coup = [], dopOk = false;
    if (doppPid) {
      const ds = await latestFrames(doppPid, 1).catch(() => []);
      if (ds.length && Date.now() - ds[0].t < 15 * 60e3) {
        const dl = await levels(ds[0].name, "2");
        if (dl) {
          dopOk = true;
          const DN = Math.round(Math.sqrt(dl.length));
          coup = ALGO.couplets(dl, km / (DN / 2), lv, kpp, lat0 < 0).map(k => ({ x: k.x, y: k.y, dv: k.dv }));
          const h = st.coup[src] || (st.coup[src] = {});
          const prevC = h.t !== ds[0].t ? h.prev : h.prevprev;
          if (h.t !== ds[0].t) { h.prevprev = h.prev; h.prev = coup; h.t = ds[0].t; }
          for (const c0 of coup) c0.persistent = !!prevC && prevC.some(q => Math.hypot(c0.x - q.x, c0.y - q.y) <= 12);
        }
      }
    }

    const southern = lat0 < 0, seen = new Set(), storms = [], active = { ...st.active }, nowIso = new Date().toISOString();
    const h = P.home(), recentCut = Date.now() - 15 * 60e3;
    for (const c of cells) {
      const mx = DBZ[Math.min(14, c.max)], spd = Math.hypot(c.vx || 0, c.vy || 0);
      const [clat, clon] = kmToLL(lat0, lon0, c.x, c.y), rad = Math.sqrt(c.area / Math.PI);
      const ltg = strikesNear(clat, clon, rad + 10);
      const near = coup.filter(k => Math.hypot(k.x - c.x, k.y - c.y) <= rad + 6);
      const dv = Math.max(0, ...near.map(k => k.dv)), dvTor = Math.max(0, ...near.filter(k => k.persistent).map(k => k.dv));
      const hasDop = dopOk && Math.hypot(c.x, c.y) <= 110;
      let threat = null;
      if (mx >= 50) {
        threat = assess(c, mx, ltg, dv, hasDop, envAt(clat, clon), southern);
        const nt = nearestTown(clat, clon);
        storms.push({ id: c.id, source: src, lat: +clat.toFixed(4), lon: +clon.toFixed(4), dbz: Math.round(mx), lightning: ltg, speed: Math.round(spd), age: c.age,
          dir: spd >= 10 ? Math.round((Math.atan2(c.vx || 0, c.vy || 0) * 180 / Math.PI + 360) % 360) : null, near: nt ? nt[1].n : null, threat, nearest_radar: nearestRadar(clat, clon) });
      }
      const age = c.age || 1, bigCore = c.area50 >= Math.max(20, 2 * kpp * kpp);
      const confirmed = kpp >= 2 ? (ltg >= 2 || (age >= 3 && c.area50 >= 100)) : (age >= 2 || ltg >= 3);
      let kind = null; const hazards = [];
      if (dvTor >= TOR && mx >= 50) { kind = "TOR"; hazards.push(`Radar-indicated rotation on two scans in a row, ΔV ${dvTor.toFixed(0)} km/h`); }
      else if ((mx >= 55 && bigCore && confirmed) || (mx >= 50 && bigCore && (dv >= 70 || ltg >= 15))) { kind = "SVR"; if (dv >= 70) hazards.push(`Rotation detected, ΔV ${dv.toFixed(0)} km/h`); }
      else if (mx >= 50 && spd < 10 && age >= 6) kind = "FFW";
      if (!kind) continue;
      if (mx >= 59) hazards.push("Large hail possible (core above 59 dBZ)"); else if (mx >= 55) hazards.push("Hail possible (core above 55 dBZ)");
      if (ltg >= 15) hazards.push(`Frequent lightning (${ltg} strikes in 10 min)`);
      if (spd < 10 && mx >= 50 && age >= 3) hazards.push("Slow moving: heavy rain and flash flooding possible");
      if (kind === "FFW" && !hazards.length) hazards.push("Heavy rain over the same area for 30+ minutes");
      // storm-based polygon: hull now + hull 45 min ahead, widened by 5 km
      const hull = c.hull.length ? c.hull : [[c.x, c.y]], dx = (c.vx || 0) * LEAD / 60, dy = (c.vy || 0) * LEAD / 60, pts = [];
      for (const [px, py] of hull) for (const [ox, oy] of [[0, 0], [dx, dy]]) for (let a = 0; a < 360; a += 45) pts.push([+(px + ox + 5 * Math.cos(a * Math.PI / 180)).toFixed(2), +(py + oy + 5 * Math.sin(a * Math.PI / 180)).toFixed(2)]);
      const poly = hullKm(pts).map(([px, py]) => kmToLL(lat0, lon0, px, py).map(v => +v.toFixed(4)));
      const tw = townsIn(poly), wid = `${kind}-${c.id}`;
      seen.add(wid);
      const steady = age >= (kpp >= 2 ? 4 : 3);
      const motion = spd >= 10 && steady ? `moving ${compass((Math.atan2(c.vx, c.vy) * 180 / Math.PI + 360) % 360)} at ${spd.toFixed(0)} km/h` : steady ? "nearly stationary" : "movement not yet known";
      const dHome = P.dist(clat, clon, h.lat, h.lon), brg = (Math.atan2((clon - h.lon) * Math.cos(h.lat * Math.PI / 180), clat - h.lat) * 180 / Math.PI + 360) % 360;
      const nt = nearestTown(clat, clon);
      let where;
      if (dHome <= 150 || !nt) where = `${dHome.toFixed(0)} km ${compass(brg)} of ${h.name}`;
      else { const tb = (Math.atan2((clon - nt[1].lo) * Math.cos(clat * Math.PI / 180), clat - nt[1].la) * 180 / Math.PI + 360) % 360; where = nt[2] < 8 ? `near ${nt[1].n}` : `${nt[2].toFixed(0)} km ${compass(tb)} of ${nt[1].n}`; }
      const local = new Date(tNow).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const title = { TOR: "Tornado warning", SVR: "Severe thunderstorm warning", FFW: "Flash flood warning" }[kind];
      const prevW = active[wid];
      let event = prevW && prevW.event, issued = prevW ? prevW.issued : nowIso;
      if (!event) {
        const twins = Object.values(active).filter(o => o.type === kind && o.id !== wid && P.dist(o.lat, o.lon, clat, clon) <= 20)
          .concat(st.recent.filter(o => o.type === kind && P.dist(o.lat, o.lon, clat, clon) <= 20 && Date.parse(o.updated) >= recentCut));
        if (twins.length) { const tw0 = twins.sort((a, b) => P.dist(a.lat, a.lon, clat, clon) - P.dist(b.lat, b.lon, clat, clon))[0]; event = tw0.event || tw0.id; issued = tw0.issued; }
        else event = wid;
      }
      active[wid] = { id: wid, event, type: kind, title, source: src, issued, updated: nowIso, expires: new Date(Date.now() + LEAD * 60e3).toISOString(), status: "active",
        polygon: poly, hazards, towns: tw, lat: +clat.toFixed(4), lon: +clon.toFixed(4), dbz: Math.round(mx), dv: Math.round(dv), lightning: ltg, speed: Math.round(spd),
        home_inside: inPoly(h.lat, h.lon, poly), threat, nearest_radar: nearestRadar(clat, clon),
        text: `At ${local}, a ${kind === "TOR" ? "possibly tornadic " : ""}thunderstorm was located ${where}, ${motion}. Core ${mx.toFixed(0)} dBZ.` + (tw.length ? ` Locations in the warning area include ${tw.join(", ")}.` : "") };
    }
    const recent = st.recent.slice();
    for (const [wid, w] of Object.entries(active)) if (w.source === src && !seen.has(wid)) { recent.push({ ...w, status: "cancelled", updated: nowIso }); delete active[wid]; }
    st.active = active; st.storms = { ...st.storms, [src]: storms }; st.stormsT = { ...st.stormsT, [src]: Date.now() };
    st.recent = recent.filter(w => Date.parse(w.updated) > Date.now() - 6 * 3600e3).slice(-100);
    st.lastRun = nowIso;
  }

  // ---------------------------------------------------------------- model watches (every 6 hours, home radar's grid)
  const ffdi = (t, rh, w) => 2 * Math.exp(-0.45 + 0.987 * Math.log(10) - 0.0345 * rh + 0.0338 * t + 0.0234 * w);
  async function buildWatches(rid) {
    const [lat0, lon0] = P.radarPoint(rid);
    const sfc = await P.fcgrid(rid, "best", "sfc"), svr = await P.fcgrid(rid, "best", "svr").catch(() => null);
    const n = sfc.n, half = sfc.half, step = 2 * half / (n - 1), nt = Math.min(12, sfc.time.length);
    const crit = { TOA: new Map(), SVA: new Map(), WND: new Map(), HEA: new Map(), FWA: new Map() };
    const hit = (k, x, y, v) => { const key = `${x},${y}`, o = crit[k].get(key); crit[k].set(key, { x, y, v: o ? Math.max(o.v, v) : v }); };
    for (let p = 0; p < n * n; p++) {
      const x = -half + (p % n) * step, y = half - Math.floor(p / n) * step;
      for (let t = 0; t < nt; t++) {
        const V = sfc.vars, temp = V.temp[t][p], rh = V.rh[t][p], gust = V.gust[t][p], u = V.u ? V.u[t][p] : null, v = V.v ? V.v[t][p] : null;
        if (gust != null && gust >= 90) hit("WND", x, y, gust);
        if (temp != null && temp >= 40) hit("HEA", x, y, temp);
        if (temp != null && rh != null && u != null && v != null) { const f = ffdi(temp, rh, Math.hypot(u, v)); if (f >= 50) hit("FWA", x, y, f); }
        if (svr) {
          const S = svr.vars, stp = S.stp[t][p], scp = S.scp[t][p], cape = S.cape[t][p];
          if (stp != null && stp >= 1) hit("TOA", x, y, stp);
          if (scp != null && scp >= 2 && (cape || 0) >= 500) hit("SVA", x, y, scp);
        }
      }
    }
    const names = { TOA: "Tornado watch", SVA: "Severe thunderstorm watch", WND: "Damaging wind watch", HEA: "Extreme heat watch", FWA: "Fire weather watch" };
    const desc = { TOA: v => `STP up to ${v.toFixed(1)}: the environment supports supercells capable of tornadoes.`, SVA: v => `SCP up to ${v.toFixed(1)}: the environment supports organised severe thunderstorms and supercells.`,
      WND: v => `Model gusts up to ${v.toFixed(0)} km/h.`, HEA: v => `Model temperatures up to ${v.toFixed(0)} °C.`, FWA: v => `McArthur FFDI up to ${v.toFixed(0)} (drought factor assumed 10).` };
    const out = [], used = new Set();
    for (const [k, m] of Object.entries(crit)) {
      let groups = [];
      for (const p of m.values()) {
        const hitG = groups.filter(g => g.some(q => Math.hypot(p.x - q.x, p.y - q.y) <= step * 1.5));
        groups = groups.filter(g => !hitG.includes(g)).concat([[p, ...hitG.flat()]]);
      }
      groups.forEach((g, gi) => {
        if (g.length < 2) return;
        const ring = [];
        for (const p of g) for (let a = 0; a < 360; a += 45) ring.push([p.x + step * 0.6 * Math.cos(a * Math.PI / 180), p.y + step * 0.6 * Math.sin(a * Math.PI / 180)]);
        const poly = hullKm(ring).map(([x, y]) => kmToLL(lat0, lon0, x, y).map(v => +v.toFixed(3)));
        const cx = g.reduce((a, p) => a + p.x, 0) / g.length, cy = g.reduce((a, p) => a + p.y, 0) / g.length, [clat, clon] = kmToLL(lat0, lon0, cx, cy);
        const old = st.watches.find(o => o.type === k && !used.has(o.id) && P.dist(o.lat, o.lon, clat, clon) <= 150);
        const id = old ? old.id : `${k}-${rid}-${Date.now()}-${gi}`;
        used.add(id);
        out.push({ id, type: k, title: names[k], source: rid, status: "watch", lat: +clat.toFixed(3), lon: +clon.toFixed(3),
          valid_from: new Date(sfc.time[0] * 1000).toISOString(), valid_to: new Date(sfc.time[nt - 1] * 1000).toISOString(), polygon: poly,
          text: desc[k](Math.max(...g.map(p => p.v))), hazards: [] });
      });
    }
    st.watches = out;
  }

  // ---------------------------------------------------------------- national mosaic
  const national = (() => {
    const maps = new Map();
    let busy = null, builtAt = 0;
    const N = P.NAT.SIZE, H = P.NAT.HALF, k = 2 * H / N;
    function mapping(r, km) {
      const key = `${r.id}|${km}`;
      if (maps.has(key)) return maps.get(key);
      const cx = (r.lo - P.NAT.LON0) * KM * Math.cos(r.la * Math.PI / 180), cy = (r.la - P.NAT.LAT0) * KM;
      const i0 = Math.max(0, Math.floor((cx - km * 1.3 + H) / k)), i1 = Math.min(N, Math.floor((cx + km * 1.3 + H) / k) + 1);
      const j0 = Math.max(0, Math.floor((H - cy - km * 1.3) / k)), j1 = Math.min(N, Math.floor((H - cy + km * 1.3) / k) + 1);
      const nat = [], src = [], kpp = km / 256;
      for (let jj = j0; jj < j1; jj++) for (let ii = i0; ii < i1; ii++) {
        const x = -H + (ii + 0.5) * k, y = H - (jj + 0.5) * k, lat = P.NAT.LAT0 + y / KM, lon = P.NAT.LON0 + x / (KM * Math.cos(lat * Math.PI / 180));
        const xr = (lon - r.lo) * KM * Math.cos(lat * Math.PI / 180), yr = (lat - r.la) * KM;
        const px = Math.floor(256 + xr / kpp), py = Math.floor(256 - yr / kpp);
        if (px >= 0 && px < 512 && py >= 0 && py < 512 && Math.hypot(xr, yr) <= km) { nat.push(jj * N + ii); src.push(py * 512 + px); }
      }
      const m = [Int32Array.from(nat), Int32Array.from(src)];
      maps.set(key, m);
      return m;
    }
    async function build() {
      const radars = P.DATA.radars, per = new Map();
      // each radar's 512 km loop (256 km where there's no 512 km product)
      let next = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < radars.length) {
          const r = radars[next++];
          for (const s of ["1", "2"]) {
            try {
              const names = await P.loopNames(`IDR${r.id}${s}`);
              if (names.length) { per.set(r.id, { pid: `IDR${r.id}${s}`, km: s === "1" ? 512 : 256 }); break; }
            } catch { /* next */ }
          }
        }
      }));
      let newest = 0;
      for (const [, v] of per) for (const t of P.frameIndex.get(v.pid).values()) newest = Math.max(newest, t);
      if (!newest) return;
      const idxNat = P.frameIndex.get(P.NAT.PID) || new Map();
      P.frameIndex.set(P.NAT.PID, idxNat);
      for (let back = 2; back >= 0; back--) {
        const slot = Math.floor(newest / 600e3) * 600e3 - back * 600e3, name = `AUS.T.${new Date(slot).toISOString().replace(/[-:T]/g, "").slice(0, 12)}.png`;
        if (idxNat.has(name)) continue;
        const out = new Uint8Array(N * N);
        let used = 0;
        for (const [rid, v] of per) {
          let best = null;
          for (const [n2, t] of P.frameIndex.get(v.pid)) if (Math.abs(t - slot) <= 6 * 60e3 && (!best || Math.abs(t - slot) < Math.abs(best[1] - slot))) best = [n2, t];
          if (!best) continue;
          let lv;
          try { lv = await levels(best[0], "0"); } catch { continue; }
          if (!lv || lv.length !== 512 * 512) continue;
          const [nat, src] = mapping(P.radarById(rid), v.km);
          for (let i = 0; i < nat.length; i++) { const val = lv[src[i]]; if (val < 15 && val + 1 > out[nat[i]]) out[nat[i]] = val + 1; }
          used++;
        }
        if (!used) continue;
        const cv = new OffscreenCanvas(N, N), g = cv.getContext("2d"), img = g.createImageData(N, N), d = img.data;
        const pal = REFL_BOM.map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
        for (let i = 0; i < out.length; i++) if (out[i]) { const c = pal[out[i] - 1]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
        g.putImageData(img, 0, 0);
        P.frameBytes.set(name, await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer());
        idxNat.set(name, slot);
      }
      for (const [n2, t] of idxNat) if (t < Date.now() - 3 * 3600e3) { idxNat.delete(n2); P.frameBytes.delete(n2); }
      builtAt = Date.now();
    }
    return {
      ensure() {
        if (Date.now() - builtAt < 6 * 60e3) return Promise.resolve();
        if (!busy) busy = build().catch(e => console.warn("mosaic", e)).finally(() => { busy = null; });
        // the first build takes a while (about 64 small downloads): don't hold the page up after the first frame exists
        return (P.frameIndex.get(P.NAT.PID) || new Map()).size ? Promise.resolve() : busy;
      },
    };
  })();

  // ---------------------------------------------------------------- the engine loop
  let running = null;
  async function tick(force = false) {
    if (running) return running;
    if (!force && document.hidden) return;
    running = (async () => {
      await P.ready;
      const h = P.home();
      P.ltgConnect();
      const srcs = new Set(P.myRadars().slice(0, 2));
      if (typeof S !== "undefined" && S.radar && /^\d+$/.test(S.radar.id)) srcs.add(S.radar.id);
      const nr = nearestRadar(h.lat, h.lon, 300); if (nr) srcs.add(nr.id);
      for (const rid of [...srcs].slice(0, 3)) {
        const r = P.radarById(rid); if (!r) continue;
        await ensureEnv(rid);
        try { await runSource(rid, r.la, r.lo, `IDR${rid}3`, 128, `IDR${rid}I`); } catch (e) { console.warn("engine", rid, e); }
      }
      if (typeof S !== "undefined" && S.radar && S.radar.national) {
        try { await national.ensure(); await runSource(P.NAT.PID, P.NAT.LAT0, P.NAT.LON0, P.NAT.PID, P.NAT.HALF, null); } catch (e) { console.warn("engine national", e); }
      }
      if (Date.now() - st.watchT > 6 * 3600e3 && nr) {
        try { await buildWatches(nr.id); st.watchT = Date.now(); } catch { st.watchT = Date.now() - 5.5 * 3600e3; }
      }
    })().finally(() => { running = null; });
    return running;
  }
  setTimeout(() => tick(true), 8000);
  setInterval(() => tick(), 150e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

  function dedupe(items) {
    const own = [], events = new Set();
    for (const w of items) if (w.source !== P.NAT.PID) { if (w.event && events.has(w.event)) continue; if (w.event) events.add(w.event); own.push(w); }
    const nat = items.filter(w => w.source === P.NAT.PID && (!w.event || !events.has(w.event)) && !own.some(o => Math.abs(o.lat - w.lat) < 0.3 && Math.abs(o.lon - w.lon) < 0.35));
    return own.concat(nat);
  }
  async function wxwarnings() {
    if (!st.lastRun) await Promise.race([tick(true), new Promise(r => setTimeout(r, 15000))]);
    const now = Date.now();
    const active = dedupe(Object.values(st.active).filter(w => Date.parse(w.expires) > now));
    const order = { TOR: 0, SVR: 1, FFW: 2 };
    active.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || b.dbz - a.dbz);
    const rank = { high: 2, moderate: 1, low: 0 };
    const storms = dedupe(Object.entries(st.storms).filter(([k]) => now - (st.stormsT[k] || 0) < 20 * 60e3).flatMap(([, l]) => l));
    storms.sort((a, b) => rank[(b.threat || {}).tornado || "low"] - rank[(a.threat || {}).tornado || "low"] || rank[(b.threat || {}).supercell || "low"] - rank[(a.threat || {}).supercell || "low"] || b.dbz - a.dbz);
    return { active, recent: st.recent.slice(-20), watches: st.watches, storms: storms.slice(0, 30), last_run: st.lastRun, enabled: true };
  }

  // ---------------------------------------------------------------- rain nowcast (block matching motion, then extrapolation)
  async function nowcastAt(lat, lon) {
    const r = nearestRadar(lat, lon, 110);
    if (!r) return null;
    const pid = `IDR${r.id}3`, fs = await latestFrames(pid, 6).catch(() => []);
    if (fs.length < 2 || Date.now() - fs[fs.length - 1].t > 20 * 60e3) return null;
    const f1 = fs[fs.length - 1], older = fs.filter(f => (f1.t - f.t) / 60e3 >= 12 && (f1.t - f.t) / 60e3 <= 25), f0 = older.length ? older[older.length - 1] : fs[fs.length - 2];
    const b = await levels(f1.name, "0"), a = await levels(f0.name, "0");
    if (!a || !b) return null;
    const N = Math.round(Math.sqrt(b.length)), km = 128, kpp = km / (N / 2), dtH = Math.max(1e-3, (f1.t - f0.t) / 3600e3);
    // 4x downsampled block match over +-14 px (about +-50 km) shifts
    const D = 4, M = N / D, A = new Float32Array(M * M), B = new Float32Array(M * M);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y >> 2) * M + (x >> 2), va = a[y * N + x], vb = b[y * N + x];
      if (va < 15) A[i] = Math.max(A[i], va + 1); if (vb < 15) B[i] = Math.max(B[i], vb + 1);
    }
    let best = [0, 0], bestS = -1;
    const R = Math.min(14, Math.ceil(110 * dtH / (kpp * D)));
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      let s = 0;
      for (let y = Math.max(0, -dy); y < Math.min(M, M - dy); y++) for (let x = Math.max(0, -dx); x < Math.min(M, M - dx); x++) {
        const va = A[y * M + x]; if (va) s += Math.min(va, B[(y + dy) * M + x + dx]);
      }
      if (dx === 0 && dy === 0) s *= 0.9;            // clutter favours no motion
      if (s > bestS) { bestS = s; best = [dx, dy]; }
    }
    const mv = [best[0] * D * kpp / dtH, -best[1] * D * kpp / dtH];
    const x = (lon - r.lo) * KM * Math.cos(lat * Math.PI / 180), y = (lat - r.la) * KM;
    if (Math.hypot(x, y) > km * 0.95) return null;
    const rad = Math.max(1, Math.round(3 / kpp)), steps = [], lead0 = (Date.now() - f1.t) / 3600e3;
    for (let k = 0; k <= 12; k++) {
      const hh = lead0 + k * 5 / 60, sx = x - mv[0] * hh, sy = y - mv[1] * hh;
      const px = Math.round(N / 2 + sx / kpp), py = Math.round(N / 2 - sy / kpp);
      let lvMax = 0;
      for (let yy = py - rad; yy <= py + rad; yy++) for (let xx = px - rad; xx <= px + rad; xx++) {
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const v = b[yy * N + xx]; if (v < 15 && v + 1 > lvMax) lvMax = v + 1;
      }
      steps.push({ min: k * 5, rate: lvMax ? REFL_RATE[lvMax - 1] : 0, level: lvMax });
    }
    return { radar: pid, frame_time: new Date(f1.t).toISOString(), motion_kmh: mv.map(Math.round), steps };
  }
  function nowWords(nc) {
    if (!nc) return { text: "No nowcast: no live radar covers this spot.", starts_min: null, ends_min: null };
    const s = nc.steps, wet = s.map(x => x.rate >= 0.5), kind = r => (r >= 10 ? "heavy rain" : r >= 2.5 ? "moderate rain" : "light rain");
    const at = m => new Date(Date.now() + m * 60e3).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
    const cap = t => t[0].toUpperCase() + t.slice(1);
    if (wet[0]) {
      const endI = wet.findIndex(w => !w), peak = Math.max(...s.filter(x => x.rate >= 0.5).map(x => x.rate));
      if (endI < 0) return { text: `${cap(kind(s[0].rate))} now, continuing for the next hour.`, starts_min: 0, ends_min: null };
      const end = s[endI].min;
      return { text: `${cap(kind(peak))} now, easing around ${at(end)} (in about ${end} min).`, starts_min: 0, ends_min: end };
    }
    const si = wet.findIndex(w => w);
    if (si < 0) return { text: s.some(x => x.rate > 0) ? "Spits of very light rain at most in the next hour." : "No rain expected in the next hour.", starts_min: null, ends_min: null };
    const start = s[si].min, peak = Math.max(...s.slice(si).map(x => x.rate));
    return { text: `${cap(kind(peak))} starting around ${at(start)} (in about ${start} min).`, starts_min: start, ends_min: null };
  }
  async function nowcastApi(q) {
    const h = P.home(), lat = q.get("lat") != null ? +q.get("lat") : h.lat, lon = q.get("lon") != null ? +q.get("lon") : h.lon;
    const nc = await nowcastAt(lat, lon).catch(() => null);
    return { point: [lat, lon], nowcast: nc, ...nowWords(nc) };
  }

  // ---------------------------------------------------------------- alerts (same feed shape as the server's)
  const sayList = n => { n = n.filter(Boolean).slice(0, 5); return n.length === 1 ? n[0] : n.length ? n.slice(0, -1).join(", ") + " and " + n[n.length - 1] : ""; };
  const speakable = t => t.replace(/\b([A-Z]{4,}(?:\s+[A-Z]{2,})*)\b/g, m => m.toLowerCase()).replace(/km\/h/g, " kilometres per hour").replace(/&/g, " and ");
  async function alerts(q) {
    const h = P.home();
    const lat = q.get("lat") != null ? +q.get("lat") : h.lat, lon = q.get("lon") != null ? +q.get("lon") : h.lon;
    const near = Math.max(1, Math.min(+q.get("near") || 50, 500)), far = Math.max(near, Math.min(+q.get("far") || 300, 5000)), scope = q.get("scope") || "near";
    const out = [], now = Date.now(), fmtT = iso => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    tick();
    const names = { TOR: "Tornado warning", SVR: "Severe thunderstorm warning", FFW: "Flash flood warning" };
    for (const w of dedupe(Object.values(st.active).filter(w => Date.parse(w.expires) > now))) {
      const inside = inPoly(lat, lon, w.polygon), d = inside ? 0 : Math.min(...w.polygon.map(([la, lo]) => P.dist(lat, lon, la, lo))), isNear = inside || d <= near;
      if (!isNear && (scope !== "all" || d > far)) continue;
      const where = sayList(w.towns || []) || "the area " + w.text.split(" was located ").pop().split(",")[0];
      out.push({ id: w.event || w.id, source: "wxdeck", type: w.type, severity: w.type === "TOR" ? 3 : 2, title: names[w.type], areas: w.towns || [], inside, near: isNear,
        distance_km: Math.round(d), issued: w.issued, expires: w.expires, text: w.text, hazards: w.hazards, lat: w.lat, lon: w.lon,
        speech: `${names[w.type]} issued for ${where}, until ${fmtT(w.expires)}.` + (inside ? " This includes your location." : "") });
    }
    // BoM's severe warnings that name a place near the point
    const localNames = towns().filter(t => P.dist(lat, lon, t.la, t.lo) <= near && t.n.length > 3).slice(0, 60).map(t => t.n.toLowerCase());
    let bom = [];
    try { bom = await P.warnings(P.STATE_OF(lat, lon)); } catch { /* none */ }
    for (const b of bom) {
      const title = b.title.replace(/^\d{2}\/\d{2}:\d{2}\s+\w+\s+/, "").trim(), low = title.toLowerCase();
      if (/^(cancellation|final)/.test(low) || /marine wind|sheep graziers/.test(low)) continue;
      if (!(b.level === "severe" || /severe weather|fire weather|heatwave|bushfire/.test(low) || (b.level === "flood" && /major|moderate/.test(low)))) continue;
      let body = "";
      try { body = await P.warningText(b.link); } catch { /* title only */ }
      const hay = (title + " " + body).toLowerCase();
      const hits = localNames.filter(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay));
      if (!hits.length && far < 1000) continue;
      const cap = x => x.replace(/\b\w/g, c => c.toUpperCase());
      out.push({ id: "bom-" + Array.from(b.link + "|" + title).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16), source: "BoM", type: "BOM", severity: 2, title,
        areas: hits.slice(0, 6).map(cap), inside: null, near: hits.length > 0, distance_km: null, issued: b.pub, expires: null, text: title, hazards: [], link: b.link,
        speech: `Bureau of Meteorology. ${speakable(title).replace(/\.$/, "")}.` + (hits.length ? ` This includes ${sayList(hits.slice(0, 3).map(cap))}.` : "") });
    }
    for (const w of st.watches) {
      if (Date.parse(w.valid_to) <= now) continue;
      const inside = inPoly(lat, lon, w.polygon), d = inside ? 0 : Math.min(...w.polygon.map(([la, lo]) => P.dist(lat, lon, la, lo))), isNear = inside || d <= near;
      if (!isNear && (scope !== "all" || d > far)) continue;
      out.push({ id: w.id, source: "wxdeck", type: w.type, severity: 1, title: w.title, areas: [], inside, near: isNear, distance_km: Math.round(d), issued: w.valid_from, expires: w.valid_to,
        text: w.text, hazards: [], speech: `${w.title} ${inside ? "for your area" : "near your area"}, until ${new Date(w.valid_to).toLocaleTimeString([], { hour: "numeric" }).toLowerCase()}. ${speakable(w.text)}` });
    }
    // gusts at stations
    try {
      for (const s of await P.stateObs(P.STATE_OF(lat, lon))) {
        if (!s.gust || s.gust < 90 || !s.time || now - Date.parse(s.time) > 40 * 60e3) continue;
        const d = P.dist(lat, lon, s.lat, s.lon), isNear = d <= near;
        if (!isNear && (scope !== "all" || d > far)) continue;
        out.push({ id: `gust-${s.name}-${s.time.slice(0, 13)}`, source: "wxdeck", type: "WIND", severity: 2, title: "Damaging wind gust observed", areas: [s.name], inside: null, near: isNear,
          distance_km: Math.round(d), issued: s.time, expires: null, text: `A gust of ${s.gust.toFixed(0)} km/h was measured at ${s.name}.`, hazards: [],
          speech: `Damaging wind gust of ${s.gust.toFixed(0)} kilometres per hour measured at ${s.name}.` });
      }
    } catch { /* obs optional */ }
    // lightning close by
    const rows = P.LTG.strikes.filter(s => s[0] >= now - 10 * 60e3 && P.dist(lat, lon, s[1], s[2]) <= 15);
    if (rows.length) {
      const first = Math.min(...rows.map(r => r[0])), closest = Math.min(...rows.map(r => P.dist(lat, lon, r[1], r[2])));
      out.push({ id: `ltg-${Math.floor(first / 1800e3)}`, source: "wxdeck", type: "LTG", severity: 1, title: "Lightning nearby", areas: [], inside: null, near: true, distance_km: Math.round(closest),
        issued: new Date(first).toISOString(), expires: null, text: `${rows.length} lightning strike${rows.length > 1 ? "s" : ""} within 15 km in the last 10 minutes, the closest ${closest.toFixed(0)} km away.`,
        hazards: [], speech: `Lightning within ${Math.max(1, Math.round(closest))} kilometres. Head indoors.` });
    }
    // storms heading this way
    const seenK = new Set(), cos = Math.cos(lat * Math.PI / 180);
    for (const [src, list] of Object.entries(st.storms)) {
      if (now - (st.stormsT[src] || 0) > 20 * 60e3) continue;
      for (const s of list) {
        if (s.dir == null || s.speed < 10 || s.age < 3) continue;
        const x = (s.lon - lon) * KM * cos, y = (s.lat - lat) * KM, a = s.dir * Math.PI / 180, vx = s.speed * Math.sin(a), vy = s.speed * Math.cos(a);
        const tca = -(x * vx + y * vy) / (vx * vx + vy * vy);
        if (!(tca > 0 && tca <= 1) || Math.hypot(x + vx * tca, y + vy * tca) > 8) continue;
        const key = `${s.lat.toFixed(1)},${s.lon.toFixed(1)}`; if (seenK.has(key)) continue; seenK.add(key);
        const eta = new Date(now + tca * 3600e3), heavy = s.dbz >= 55, d = Math.hypot(x, y);
        out.push({ id: `arr-${s.id}`, source: "wxdeck", type: "ARR", severity: 1, near: true, title: "Storm approaching", areas: [], inside: null, distance_km: Math.round(d),
          issued: new Date(now).toISOString(), expires: new Date(eta.getTime() + 20 * 60e3).toISOString(), lat: s.lat, lon: s.lon,
          text: `A ${heavy ? "strong " : ""}thunderstorm (${s.dbz} dBZ) ${d.toFixed(0)} km away is moving towards you at ${s.speed} km/h, arriving around ${fmtT(eta.toISOString())}.`, hazards: [],
          speech: `${heavy ? "Strong thunderstorm" : "Thunderstorm"} approaching, arriving in about ${Math.max(5, Math.round(tca * 12) * 5)} minutes.` });
      }
    }
    // rain about to start
    try {
      const nc = await nowcastAt(lat, lon), w = nowWords(nc);
      if (nc && w.starts_min != null && w.starts_min > 0 && w.starts_min <= 30) {
        const start = now + w.starts_min * 60e3;
        out.push({ id: `rain-${Math.floor(start / 3600e3)}`, source: "wxdeck", type: "RAIN", severity: 0, near: true, title: "Rain soon", areas: [], inside: null, distance_km: null,
          issued: new Date(now).toISOString(), expires: null, text: w.text, hazards: [], rain: true, speech: w.text.replace(" min)", " minutes)") });
      }
    } catch { /* optional */ }
    out.sort((a, b) => (a.near === b.near ? 0 : a.near ? -1 : 1) || b.severity - a.severity || (a.distance_km || 0) - (b.distance_km || 0));
    return { alerts: out, point: [lat, lon], generated: new Date(now).toISOString() };
  }

  // ---------------------------------------------------------------- spoken day summary
  const WMO = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy", 45: "foggy", 48: "foggy", 51: "drizzly", 53: "drizzly", 55: "drizzly", 61: "rainy", 63: "rainy", 65: "heavy rain",
    80: "showers", 81: "showers", 82: "heavy showers", 95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail" };
  async function brief(q) {
    const h = P.home(), lat = q.get("lat") != null ? +q.get("lat") : h.lat, lon = q.get("lon") != null ? +q.get("lon") : h.lon;
    const now = new Date(), parts = [`Good ${now.getHours() < 12 ? "morning" : now.getHours() < 17 ? "afternoon" : "evening"}.`];
    try {
      const fc = await (await window.fetch(`/api/forecast?lat=${lat}&lon=${lon}`)).json();
      const D = fc.main.daily, today = now.toDateString();
      let i = D.time.findIndex(t => new Date(t * 1000).toDateString() === today); if (i < 0) i = 0;
      parts.push(`Today looks ${WMO[D.weather_code[i]] || "mixed"}, ${Math.round(D.temperature_2m_min[i])} to ${Math.round(D.temperature_2m_max[i])} degrees.`);
      const key = new Date(D.time[i] * 1000 + 12 * 3600e3).toISOString().slice(0, 10), rr = fc.rain_range && fc.rain_range[key];
      if (rr) {
        if (rr.chance < 15) parts.push("No rain expected.");
        else { const lo = rr.low < 1 ? 0 : Math.round(rr.low), hi = Math.max(1, Math.round(rr.high)); parts.push(`${rr.chance} percent chance of rain, ${lo ? `${lo} to ${hi}` : `up to ${hi}`} millimetres.`); }
      }
      if (D.wind_gusts_10m_max[i] >= 50) parts.push(`Gusts up to ${Math.round(D.wind_gusts_10m_max[i])} kilometres per hour.`);
      const H = fc.main.hourly, capes = H.time.map((t, k) => (new Date(t * 1000).toDateString() === today ? H.cape[k] : null)).filter(c => c != null);
      if (capes.length && Math.max(...capes) >= 800) parts.push(`Storms possible, with instability up to ${Math.round(Math.max(...capes) / 100) * 100}.`);
    } catch { parts.push("The forecast isn't available right now."); }
    const al = await alerts(new URLSearchParams({ lat, lon, scope: "near" }));
    const warns = al.alerts.filter(a => a.severity >= 1 && !["LTG", "RAIN"].includes(a.type));
    parts.push(warns.length ? `In force now: ${sayList(warns.slice(0, 3).map(a => a.title))}.` : "No warnings near you.");
    const nc = await nowcastAt(lat, lon).catch(() => null), w = nowWords(nc);
    if (nc && w.starts_min != null) parts.push(w.text.replace(" min)", " minutes)"));
    return { text: parts.join(" "), point: [lat, lon] };
  }

  return { tick, wxwarnings, alerts, nowcastApi, brief, national, state: st };
})();
window.WXP_ENGINE = WXP_ENGINE;
