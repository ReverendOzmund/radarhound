/* Radarhound: forecast soundings (Open-Meteo pressure levels) — skew-T log-p, surface parcel,
   hodograph, Bunkers storm motion and helicity. Uses globals from app.js. */
"use strict";

const RD = 287.04, CP = 1005.7, LV = 2.501e6, EPS = 0.622, G0 = 9.81;
const esat = t => 6.112 * Math.exp(17.67 * t / (t + 243.5));            // hPa, t in C
const mixr = (p, t) => { const e = esat(t); return EPS * e / (p - e); };   // kg/kg at saturation

function moistLapse(p, tK) {   // dT/dp along a saturated adiabat (K per hPa)
  const rs = mixr(p, tK - 273.15);
  return (1 / p) * (RD * tK + LV * rs) / (CP + (LV * LV * rs * EPS) / (RD * tK * tK));
}

// surface parcel: returns [{p, t}] in C from the surface to 100 hPa, plus LCL
function parcelTrace(ps, ts, tds) {
  const TK = ts + 273.15, TdK = tds + 273.15;
  const tlcl = 1 / (1 / (TdK - 56) + Math.log(TK / TdK) / 800) + 56;
  const plcl = ps * Math.pow(tlcl / TK, 1 / 0.2857);
  const out = [];
  for (let p = ps; p > plcl; p -= 5) out.push({ p, t: TK * Math.pow(p / ps, 0.2857) - 273.15 });
  out.push({ p: plcl, t: tlcl - 273.15 });
  let t = tlcl;
  for (let p = plcl; p > 100; p -= 5) {
    const step = Math.min(5, p - 100);
    t -= moistLapse(p, t) * step;
    out.push({ p: p - step, t: t - 273.15 });
  }
  return { trace: out, plcl, tlcl: tlcl - 273.15 };
}

// linear interpolation of a profile in ln p
function interpLnP(prof, key, p) {
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (a.p >= p && p >= b.p) {
      const f = (Math.log(a.p) - Math.log(p)) / (Math.log(a.p) - Math.log(b.p));
      return a[key] + (b[key] - a[key]) * f;
    }
  }
  return null;
}
function interpZ(prof, key, z) {
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (a.z <= z && z <= b.z) return a[key] + (b[key] - a[key]) * (z - a.z) / (b.z - a.z || 1);
  }
  return null;
}

function buildProfile(D, levels, i) {
  const H = D.hourly, elev = D.elevation || 0;
  const ps = H.surface_pressure[i];
  const sfc = {
    p: ps, t: H.temperature_2m[i], td: H.dew_point_2m[i], z: 0,
    u: -H.wind_speed_10m[i] * Math.sin(H.wind_direction_10m[i] * Math.PI / 180),
    v: -H.wind_speed_10m[i] * Math.cos(H.wind_direction_10m[i] * Math.PI / 180),
  };
  const prof = [sfc];
  for (const p of levels) {
    if (p >= ps) continue;
    const t = H[`temperature_${p}hPa`][i], td = H[`dew_point_${p}hPa`][i], z = H[`geopotential_height_${p}hPa`][i];
    const ws = H[`wind_speed_${p}hPa`][i], wd = H[`wind_direction_${p}hPa`][i];
    if ([t, td, z, ws, wd].some(v => v == null)) continue;
    prof.push({ p, t, td, z: z - elev, u: -ws * Math.sin(wd * Math.PI / 180), v: -ws * Math.cos(wd * Math.PI / 180) });
  }
  return prof;
}

function analyse(prof) {
  const sfc = prof[0];
  const { trace, plcl } = parcelTrace(sfc.p, sfc.t, sfc.td);
  let cape = 0, cin = 0, lfc = null, el = null, prevPos = false;
  for (let k = 0; k < trace.length - 1; k++) {
    const a = trace[k], b = trace[k + 1];
    const te = interpLnP(prof, "t", (a.p + b.p) / 2);
    if (te == null) continue;
    const tp = (a.t + b.t) / 2;
    const dlnp = Math.log(a.p / b.p);
    const buoy = RD * (tp - te) * dlnp;
    if (buoy > 0) { cape += buoy; if (!prevPos && lfc == null) lfc = a.p; el = b.p; prevPos = true; }
    else if (lfc == null) cin += buoy;
    else prevPos = false;
  }
  const zlcl = interpLnP(prof, "z", plcl);
  // winds: 0-6 km mean and shear, Bunkers motion (ID method), helicity
  const at = z => ({ u: interpZ(prof, "u", z), v: interpZ(prof, "v", z) });
  const zs = []; for (let z = 0; z <= 6000; z += 250) zs.push(z);
  const W = zs.map(at).filter(w => w.u != null);
  const mean = { u: W.reduce((s, w) => s + w.u, 0) / W.length, v: W.reduce((s, w) => s + w.v, 0) / W.length };
  const low = [0, 250, 500].map(at), top = [5500, 5750, 6000].map(at);
  const avg = a => ({ u: a.reduce((s, w) => s + w.u, 0) / a.length, v: a.reduce((s, w) => s + w.v, 0) / a.length });
  const lo = avg(low), hi = avg(top);
  const sh = { u: hi.u - lo.u, v: hi.v - lo.v }, shMag = Math.hypot(sh.u, sh.v) || 1;
  const dev = { u: 7.5 * sh.v / shMag, v: -7.5 * sh.u / shMag };
  const right = { u: mean.u + dev.u, v: mean.v + dev.v }, left = { u: mean.u - dev.u, v: mean.v - dev.v };
  const srh = (sm, zt) => {
    let h = 0;
    for (let z = 0; z < zt; z += 100) {
      const a = at(z), b = at(z + 100);
      if (a.u == null || b.u == null) continue;
      h += (b.u - sm.u) * (a.v - sm.v) - (a.u - sm.u) * (b.v - sm.v);
    }
    return h;
  };
  const s01 = (() => { const a = at(0), b = at(1000); return Math.hypot(b.u - a.u, b.v - a.v); })();
  const srhL = srh(left, 3000), srhR = srh(right, 3000), srh1L = srh(left, 1000), srh1R = srh(right, 1000);
  // composite parameters (cyclonic helicity taken as positive in either hemisphere)
  const south = S.radar && S.radar.lat < 0;
  const h3 = Math.max(0, south ? -srhL : srhR), h1 = Math.max(0, south ? -srh1L : srh1R);
  const lclT = zlcl == null ? 0 : zlcl < 1000 ? 1 : zlcl > 2000 ? 0 : (2000 - zlcl) / 1000;
  const shrT = shMag < 12.5 ? 0 : Math.min(1.5, shMag / 20);
  const cinT = cin > -50 ? 1 : cin < -200 ? 0 : (200 + cin) / 150;
  const stp = Math.max(0, cape / 1500) * lclT * (h1 / 150) * shrT * cinT;
  const scp = Math.max(0, cape / 1000) * (h3 / 50) * (shMag < 10 ? 0 : Math.min(1, shMag / 20));
  return { trace, cape, cin, lfc, el, plcl, zlcl, shear06: shMag, shear01: s01, mean, right, left,
    srhL, srhR, srh1L, stp, scp };
}

const motionText = m => { const spd = Math.hypot(m.u, m.v) * 3.6; return `${compass(bearingOf(m.u, m.v))} at ${spd.toFixed(0)} km/h`; };

// ---------------------------------------------------------------- drawing
const SKEW = 35, PTOP = 100, PBOT = 1050, TMIN = -40, TMAX = 50;
function drawSkewT(cv, prof, A) {
  const d = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, m = { l: 38 * d, r: 8 * d, t: 8 * d, b: 20 * d };
  const yP = p => m.t + (Math.log(p) - Math.log(PTOP)) / (Math.log(PBOT) - Math.log(PTOP)) * (H - m.t - m.b);
  const xT = (t, p) => m.l + ((t + SKEW * Math.log(1000 / p) - TMIN) / (TMAX - TMIN)) * (W - m.l - m.r);
  g.fillStyle = "#0a1216"; g.fillRect(0, 0, W, H);
  g.save(); g.beginPath(); g.rect(m.l, m.t, W - m.l - m.r, H - m.t - m.b); g.clip();
  g.lineWidth = 1 * d;
  for (let t = -120; t <= 50; t += 10) {            // isotherms
    g.strokeStyle = t === 0 ? "#3f6f80" : "#1f3138";
    g.beginPath(); g.moveTo(xT(t, PBOT), yP(PBOT)); g.lineTo(xT(t, PTOP), yP(PTOP)); g.stroke();
  }
  g.strokeStyle = "#2b2418";                          // dry adiabats
  for (let th = -30; th <= 150; th += 10) {
    g.beginPath();
    for (let p = PBOT; p >= PTOP; p -= 10) { const t = (th + 273.15) * Math.pow(p / 1000, 0.2857) - 273.15; p === PBOT ? g.moveTo(xT(t, p), yP(p)) : g.lineTo(xT(t, p), yP(p)); }
    g.stroke();
  }
  g.strokeStyle = "#16301f";                          // moist adiabats
  for (let t0 = -10; t0 <= 32; t0 += 6) {
    let tK = t0 + 273.15; g.beginPath(); g.moveTo(xT(t0, 1000), yP(1000));
    for (let p = 1000; p > PTOP; p -= 10) { tK -= moistLapse(p, tK) * 10; g.lineTo(xT(tK - 273.15, p - 10), yP(p - 10)); }
    g.stroke();
  }
  // CAPE shading between parcel and environment
  g.fillStyle = "rgba(240,123,23,.22)";
  for (let k = 0; k < A.trace.length - 1; k++) {
    const a = A.trace[k], b = A.trace[k + 1];
    const ea = interpLnP(prof, "t", a.p), eb = interpLnP(prof, "t", b.p);
    if (ea == null || eb == null || a.t <= ea) continue;
    g.beginPath(); g.moveTo(xT(ea, a.p), yP(a.p)); g.lineTo(xT(a.t, a.p), yP(a.p)); g.lineTo(xT(b.t, b.p), yP(b.p)); g.lineTo(xT(eb, b.p), yP(b.p)); g.fill();
  }
  const line = (pts, col, w, dash) => {
    g.strokeStyle = col; g.lineWidth = w * d; g.setLineDash(dash ? dash.map(x => x * d) : []);
    g.beginPath(); pts.forEach(([t, p], i) => (i ? g.lineTo(xT(t, p), yP(p)) : g.moveTo(xT(t, p), yP(p)))); g.stroke(); g.setLineDash([]);
  };
  line(A.trace.map(o => [o.t, o.p]), "#d6e2e4", 1.5, [5, 4]);
  line(prof.map(o => [o.td, o.p]), "#38c95a", 2.5);
  line(prof.map(o => [o.t, o.p]), "#ef4f3c", 2.5);
  g.restore();
  // axes and labels
  g.fillStyle = "#8aa0a6"; g.font = `${10 * d}px "Barlow Semi Condensed", sans-serif`;
  for (const p of [1000, 850, 700, 500, 300, 200, 100]) {
    g.fillText(`${p}`, 4 * d, yP(p) + 3 * d);
    const z = interpLnP(prof, "z", p);
    if (z != null && p < prof[0].p) g.fillText(`${(z / 1000).toFixed(1)} km`, W - 46 * d, yP(p) - 3 * d);
  }
  for (let t = -40; t <= 40; t += 20) g.fillText(`${t}°`, xT(t, PBOT) - 6 * d, H - 6 * d);
  // wind barbs (simple flags) on the right edge
  g.strokeStyle = "#d6e2e4"; g.lineWidth = 1.2 * d;
  let lastY = Infinity;
  for (const o of prof) {
    const spd = Math.hypot(o.u, o.v) * 1.944, x0 = W - 70 * d, y0 = yP(o.p);
    if (y0 < m.t || y0 > H - m.b) continue;
    if (lastY - y0 < 16 * d) continue;          // keep barbs readable on high-resolution radiosonde data
    lastY = y0;
    const ang = Math.atan2(-o.u, -o.v);   // direction wind comes from
    const L = 22 * d, ex = x0 + Math.sin(ang) * L, ey = y0 - Math.cos(ang) * L;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(ex, ey); g.stroke();
    let rem = Math.round(spd / 5) * 5, pos = 0;
    while (rem >= 10) {
      const bx = x0 + Math.sin(ang) * (L - pos), by = y0 - Math.cos(ang) * (L - pos);
      g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.sin(ang + Math.PI / 2.5) * 8 * d, by - Math.cos(ang + Math.PI / 2.5) * 8 * d); g.stroke();
      rem -= 10; pos += 4 * d;
    }
    if (rem >= 5) {
      const bx = x0 + Math.sin(ang) * (L - pos), by = y0 - Math.cos(ang) * (L - pos);
      g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.sin(ang + Math.PI / 2.5) * 4 * d, by - Math.cos(ang + Math.PI / 2.5) * 4 * d); g.stroke();
    }
  }
}

function drawHodo(cv, prof, A) {
  const d = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  g.fillStyle = "#0a1216"; g.fillRect(0, 0, W, H);
  const pts = prof.filter(o => o.z <= 10000);
  const maxV = Math.max(15, ...pts.map(o => Math.hypot(o.u, o.v)), Math.hypot(A.left.u, A.left.v), Math.hypot(A.right.u, A.right.v)) * 1.1;
  const s = Math.min(W, H) / 2 / maxV, cx = W / 2, cy = H / 2;
  const X = u => cx + u * s, Y = v => cy - v * s;
  g.strokeStyle = "#1f3138"; g.lineWidth = 1 * d;
  for (let k = 10; k < maxV; k += 10) { g.beginPath(); g.arc(cx, cy, k * s, 0, Math.PI * 2); g.stroke(); }
  g.beginPath(); g.moveTo(0, cy); g.lineTo(W, cy); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke();
  g.fillStyle = "#4b5d66"; g.font = `${10 * d}px "Barlow Semi Condensed", sans-serif`;
  for (let k = 10; k < maxV; k += 10) g.fillText(`${k} m/s`, cx + k * s + 2 * d, cy - 2 * d);
  const segs = [[0, 1000, "#ef4f3c"], [1000, 3000, "#f2a93b"], [3000, 6000, "#38c95a"], [6000, 10000, "#62b6ea"]];
  g.lineWidth = 2.5 * d;
  for (const [z0, z1, col] of segs) {
    g.strokeStyle = col; g.beginPath(); let started = false;
    for (let z = z0; z <= z1; z += 100) {
      const u = interpZ(prof, "u", z), v = interpZ(prof, "v", z);
      if (u == null) continue;
      started ? g.lineTo(X(u), Y(v)) : (g.moveTo(X(u), Y(v)), started = true);
    }
    g.stroke();
  }
  for (const [mv, lab] of [[A.left, "L"], [A.right, "R"]]) {
    g.fillStyle = lab === "L" && S.radar && S.radar.lat < 0 ? "#ef6f5c" : "#d6e2e4";
    g.beginPath(); g.arc(X(mv.u), Y(mv.v), 4 * d, 0, Math.PI * 2); g.fill();
    g.font = `bold ${11 * d}px "Barlow Semi Condensed", sans-serif`; g.fillText(lab, X(mv.u) + 6 * d, Y(mv.v) + 4 * d);
  }
}

// observed radiosonde (University of Wyoming) -> same profile shape as the model one
function obsProfile(o) {
  const L = o.levels.filter(l => l.p && l.t != null && l.td != null);
  if (!L.length) return null;
  const z0 = L[0].z;
  const prof = [];
  let lastP = Infinity;
  for (const l of L) {
    if (l.p >= lastP || l.p < 100) continue;
    if (prof.length && lastP - l.p < 3) continue;          // thin the 1 s data to every ~3 hPa
    lastP = l.p;
    const ws = l.spd || 0, wd = l.dir || 0;
    prof.push({ p: l.p, t: l.t, td: l.td, z: l.z - z0, u: -ws * Math.sin(wd * Math.PI / 180), v: -ws * Math.cos(wd * Math.PI / 180) });
  }
  return prof;
}

// time-height section: humidity shading, isotherms and wind barbs for the next 48 hours
function drawTimeHeight(cv, D, levels) {
  const d = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, m = { l: 42 * d, r: 10 * d, t: 10 * d, b: 24 * d };
  const T = D.hourly.time, n = T.length, P0 = 1000, P1 = 200;
  const xT = i => m.l + (i / (n - 1)) * (W - m.l - m.r);
  const yP = p => m.t + (Math.log(P0) - Math.log(p)) / (Math.log(P0) - Math.log(P1)) * (H - m.t - m.b);
  g.fillStyle = "#0a1216"; g.fillRect(0, 0, W, H);
  const lv = levels.filter(p => p >= P1 && p <= P0);
  const rh = (t, td) => 100 * esat(td) / esat(t);
  const cellW = (W - m.l - m.r) / (n - 1);
  for (let k = 0; k < lv.length; k++) {
    const p = lv[k], pTop = k + 1 < lv.length ? Math.sqrt(p * lv[k + 1]) : P1, pBot = k > 0 ? Math.sqrt(p * lv[k - 1]) : P0;
    for (let i = 0; i < n; i++) {
      const t = D.hourly[`temperature_${p}hPa`][i], td = D.hourly[`dew_point_${p}hPa`][i];
      if (t == null || td == null) continue;
      const h = rh(t, td), c = SC_RH_TH(h);
      g.fillStyle = `rgb(${c.join(",")})`;
      g.fillRect(xT(i) - cellW / 2, yP(pBot), cellW + 1, yP(pTop) - yP(pBot) + 1);
    }
  }
  // isotherms by linear interpolation in log-p between levels
  g.lineWidth = 1 * d; g.font = `${10 * d}px "Barlow Semi Condensed", sans-serif`;
  for (let iso = -60; iso <= 30; iso += 5) {
    g.strokeStyle = iso === 0 ? "#79d3e6" : iso === -20 ? "#ffffff" : "rgba(255,255,255,.35)";
    g.lineWidth = (iso === 0 || iso === -20 ? 2 : 1) * d;
    g.beginPath(); let started = false;
    for (let i = 0; i < n; i++) {
      let py = null;
      for (let k = 0; k + 1 < lv.length; k++) {
        const ta = D.hourly[`temperature_${lv[k]}hPa`][i], tb = D.hourly[`temperature_${lv[k + 1]}hPa`][i];
        if (ta == null || tb == null) continue;
        if ((ta - iso) * (tb - iso) <= 0 && ta !== tb) {
          const f = (ta - iso) / (ta - tb);
          py = Math.exp(Math.log(lv[k]) + f * (Math.log(lv[k + 1]) - Math.log(lv[k])));
          break;
        }
      }
      if (py == null) { started = false; continue; }
      started ? g.lineTo(xT(i), yP(py)) : (g.moveTo(xT(i), yP(py)), started = true);
    }
    g.stroke();
  }
  // wind barbs every 3 hours
  g.strokeStyle = "#d6e2e4"; g.lineWidth = 1.1 * d;
  for (let i = 0; i < n; i += 3) for (const p of [925, 850, 700, 500, 300, 250]) {
    const ws = D.hourly[`wind_speed_${p}hPa`]?.[i], wd = D.hourly[`wind_direction_${p}hPa`]?.[i];
    if (ws == null || wd == null) continue;
    const x0 = xT(i), y0 = yP(p), a = wd * Math.PI / 180, L = 16 * d;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + Math.sin(a) * L, y0 - Math.cos(a) * L);
    let kt = Math.round(ws * 1.944 / 5) * 5, pos = 0;
    while (kt >= 50) { const bx = x0 + Math.sin(a) * (L - pos), by = y0 - Math.cos(a) * (L - pos); g.moveTo(bx, by); g.lineTo(bx + Math.sin(a + 1.2) * 7 * d, by - Math.cos(a + 1.2) * 7 * d); g.lineTo(bx + Math.sin(a) * -4 * d, by + Math.cos(a) * 4 * d); kt -= 50; pos += 5 * d; }
    while (kt >= 10) { const bx = x0 + Math.sin(a) * (L - pos), by = y0 - Math.cos(a) * (L - pos); g.moveTo(bx, by); g.lineTo(bx + Math.sin(a + 1.2) * 7 * d, by - Math.cos(a + 1.2) * 7 * d); kt -= 10; pos += 3 * d; }
    if (kt >= 5) { const bx = x0 + Math.sin(a) * (L - pos), by = y0 - Math.cos(a) * (L - pos); g.moveTo(bx, by); g.lineTo(bx + Math.sin(a + 1.2) * 4 * d, by - Math.cos(a + 1.2) * 4 * d); }
    g.stroke();
  }
  // axes, selected hour
  g.fillStyle = "#8aa0a6";
  for (const p of [1000, 850, 700, 500, 300, 200]) g.fillText(`${p}`, 6 * d, yP(p) + 3 * d);
  for (let i = 0; i < n; i += 6) g.fillText(`${fmtDay.format(new Date(T[i] * 1000))} ${fmtH23.format(new Date(T[i] * 1000))}h`, xT(i) - 16 * d, H - 6 * d);
  g.strokeStyle = "#f2a93b"; g.lineWidth = 2 * d; g.beginPath(); g.moveTo(xT(SND.idx), m.t); g.lineTo(xT(SND.idx), H - m.b); g.stroke();
  g.fillStyle = "#79d3e6"; g.fillText("0 °C", W - 40 * d, m.t + 12 * d);
}
const SC_RH_TH = scale([[0, "#3a2410"], [30, "#6e4a20"], [50, "#4a4a40"], [70, "#2f5a50"], [85, "#2f7f6a"], [95, "#3fb08a"], [100, "#7fe0b0"]]);

// ---------------------------------------------------------------- dialog
const SND = { data: null, idx: 0, obs: null };
async function openSounding() {
  $("sndDlg").hidden = false;
  const pt = S.fcPoint || S.cfg.home;
  $("sndTitle").textContent = `Sounding, ${pt.name}`;
  $("sndStats").textContent = "Loading model profiles…";
  const q = S.fcPoint ? `?lat=${pt.lat}&lon=${pt.lon}` : "";
  const r = await fetch(`/api/sounding${q}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!r) { $("sndStats").textContent = "Sounding data unavailable right now."; return; }
  SND.data = r;
  const T = r.data.hourly.time;
  $("sndTime").innerHTML = T.map((t, i) => `<option value="${i}">${fmtDay.format(new Date(t * 1000))} ${fmtTime.format(new Date(t * 1000))}</option>`).join("");
  const now = Date.now() / 1000;
  SND.idx = Math.max(0, T.findIndex(t => t >= now - 1800));
  $("sndTime").value = String(SND.idx);
  renderSounding();
}
async function loadObsSounding() {
  $("sndStats").textContent = "Fetching the latest radiosonde…";
  const r = await fetch("/api/obssounding").then(r => (r.ok ? r.json() : null)).catch(() => null);
  SND.obs = r;
  if (!r) { $("sndStats").textContent = "No recent radiosonde found."; return; }
  renderSounding();
}
function renderSounding() {
  if (!SND.data) return;
  const obs = $("sndSrc").value === "obs";
  $("sndTime").hidden = obs && $("sndView").value === "skewt";
  if (obs && !SND.obs) { loadObsSounding(); return; }
  const prof = obs ? obsProfile(SND.obs) : buildProfile(SND.data.data, SND.data.levels, SND.idx);
  if (!prof || prof.length < 5) { $("sndStats").textContent = "Not enough levels in that sounding."; return; }
  const A = analyse(prof);
  SND.last = A;
  if ($("sndView").value === "th") drawTimeHeight($("sndSkew"), SND.data.data, SND.data.levels);
  else drawSkewT($("sndSkew"), prof, A);
  drawHodo($("sndHodo"), prof, A);
  const sh = S.radar && S.radar.lat < 0;   // southern hemisphere: left movers are the cyclonic ones
  const dev = sh ? A.left : A.right, devName = sh ? "Left mover (cyclonic)" : "Right mover (cyclonic)";
  const srh = sh ? A.srhL : A.srhR, srh1 = sh ? A.srh1L : null;
  const fz = obs ? null : SND.data.data.hourly.freezing_level_height?.[SND.idx];
  const rows = [
    ...(obs ? [["Radiosonde", `${SND.obs.station}, ${fmtDate.format(new Date(SND.obs.time))} ${fmtTime.format(new Date(SND.obs.time))}`]] : []),
    ["Surface CAPE", `${Math.round(A.cape)} J/kg`], ["CIN", `${Math.round(A.cin)} J/kg`],
    ...(obs ? [] : [["Model CAPE", `${Math.round(SND.data.data.hourly.cape[SND.idx] ?? 0)} J/kg`], ["Lifted index", `${(SND.data.data.hourly.lifted_index[SND.idx] ?? 0).toFixed(1)}`]]),
    ["LCL", A.zlcl != null ? `${Math.round(A.zlcl)} m` : "–"], ["Freezing level", fz != null ? `${Math.round(fz)} m` : "–"],
    ["0–1 km shear", `${(A.shear01 * 1.944).toFixed(0)} kt`], ["0–6 km shear", `${(A.shear06 * 1.944).toFixed(0)} kt`],
    ["0–3 km helicity", `${Math.round(srh)} m²/s²`], ...(srh1 != null ? [["0–1 km helicity", `${Math.round(srh1)} m²/s²`]] : []),
    [devName, motionText(dev)], ["Mean wind 0–6 km", motionText(A.mean)],
    ["Supercell composite (SCP)", `<b class="${A.scp >= 1 ? "hot" : ""}">${A.scp.toFixed(1)}</b>`],
    ["Sig. tornado parameter (STP)", `<b class="${A.stp >= 1 ? "hot" : ""}">${A.stp.toFixed(2)}</b>`],
  ];
  $("sndStats").innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`
    + `<button class="tbtn" id="sndUseMotion">Use ${sh ? "left" : "right"} mover for storm-relative velocity</button>`
    + `<p class="dim">Southern hemisphere supercells usually turn left, so helicity is negative for cyclonic rotation. SCP of 1 or more supports supercells; STP of 1 or more is where significant tornadoes become more likely (both use cyclonic helicity).</p>`;
  $("sndUseMotion").onclick = () => {
    S.settings.motion = { dir: Math.round(bearingOf(dev.u, dev.v)), spd: Math.round(Math.hypot(dev.u, dev.v) * 3.6) };
    save(); $("motionDir").value = S.settings.motion.dir; $("motionSpd").value = S.settings.motion.spd;
    draw(); updateReadout();
    $("sndUseMotion").textContent = `Storm motion set: toward ${S.settings.motion.dir}° at ${S.settings.motion.spd} km/h`;
  };
}
$("sndTime").onchange = e => { SND.idx = +e.target.value; renderSounding(); };
$("sndSrc").onchange = () => renderSounding();
$("sndView").onchange = () => renderSounding();
$("sndClose").onclick = () => { $("sndDlg").hidden = true; };
$("sndDlg").onclick = e => { if (e.target === $("sndDlg")) $("sndDlg").hidden = true; };
new ResizeObserver(() => { if (!$("sndDlg").hidden) renderSounding(); }).observe($("sndSkew"));
