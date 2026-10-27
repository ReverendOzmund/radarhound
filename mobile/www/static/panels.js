/* Radarhound: observation and forecast panels (uses helpers from app.js). */
"use strict";

// ------------------------------------------------------------------ observations
const DIRS = Object.fromEntries(COMPASS.map((d, i) => [d, i * 22.5]));
const fmt = (v, d = 0, u = "") => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d) + u);

function windDial(dir, spd) {
  const deg = DIRS[dir];
  if (deg == null) return `<svg class="wind-dial" viewBox="0 0 46 46"><circle cx="23" cy="23" r="20" fill="none" stroke="#263b44"/><text x="23" y="27" text-anchor="middle" fill="#8aa0a6" font-size="11">calm</text></svg>`;
  // arrow points the way the wind is blowing to; tail sits on the direction it comes from
  return `<svg class="wind-dial" viewBox="0 0 46 46" aria-label="Wind from ${dir}">
    <circle cx="23" cy="23" r="20" fill="none" stroke="#263b44"/>
    <g transform="rotate(${deg + 180} 23 23)">
      <line x1="23" y1="40" x2="23" y2="9" stroke="#f2a93b" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M23 5 L28 13 L18 13 Z" fill="#f2a93b"/>
    </g>
  </svg>`;
}

function sparkline(hist) {
  const pts = hist.filter(h => Date.now() - new Date(h.t) < 24 * 3600e3);
  if (pts.length < 3) return "";
  const W = 360, H = 34;
  const line = (key, color) => {
    const vals = pts.map(p => p[key]).filter(v => v != null);
    if (vals.length < 2) return "";
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const t0 = new Date(pts[0].t), t1 = new Date(pts[pts.length - 1].t);
    const d = pts.filter(p => p[key] != null).map((p, i) => {
      const x = (new Date(p.t) - t0) / (t1 - t0) * W;
      const y = H - 3 - (p[key] - lo) / span * (H - 6);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join("");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  };
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Last 24 h temperature and pressure">${line("press", "#79d3e6")}${line("temp", "#f2a93b")}</svg>`;
}

function pressureTendency(hist) {
  if (!hist.length) return null;
  const last = hist[hist.length - 1];
  const target = new Date(last.t) - 3 * 3600e3;
  let best = null;
  for (const h of hist) if (h.press != null && Math.abs(new Date(h.t) - target) < 20 * 60e3) best = h;
  return best && last.press != null ? last.press - best.press : null;
}

async function loadObs() {
  const data = await fetch("/api/obs").then(r => r.json()).catch(() => null);
  if (!data) { $("obs").textContent = "Observations unavailable. Check the server can reach BoM (FTP or website)."; return; }
  $("obs").innerHTML = data.map(st => {
    if (st.error || !st.latest) return `<div class="station"><div class="station-name">${esc(st.id)}</div><div class="station-age">${esc(st.error || "no data")}</div></div>`;
    const L = st.latest;
    const age = Math.round((Date.now() - new Date(L.t)) / 60000);
    const tend = pressureTendency(st.history);
    const tendTxt = tend == null ? "" : ` ${tend > 0.3 ? "↑" : tend < -0.3 ? "↓" : "→"}${Math.abs(tend).toFixed(1)}`;
    return `<div class="station">
      <div class="station-head"><span class="station-name">${esc(st.name)}</span><span class="station-age${age > 90 ? " stale" : ""}">${fmtTime.format(new Date(L.t))}, ${age < 90 ? `${age} min` : age < 2880 ? `${Math.round(age / 60)} h` : `${Math.round(age / 1440)} days`} ago${age > 90 ? " (old reading)" : ""}</span></div>
      <div class="station-main">
        <div class="big-temp">${fmt(L.temp, 1)}<sup>°C</sup></div>
        ${windDial(L.dir, L.wind)}
        <div class="obs-grid" style="grid-template-columns:repeat(2,1fr);flex:1">
          <div><span>Wind</span>${esc(L.dir || "–")} ${fmt(L.wind, 0)} km/h</div>
          <div><span>Gust</span>${fmt(L.gust, 0, " km/h")}</div>
        </div>
      </div>
      <div class="obs-grid">
        <div><span>Feels like</span>${fmt(L.app, 1, "°")}</div>
        <div><span>Dew point</span>${fmt(L.dew, 1, "°")}</div>
        <div><span>Humidity</span>${fmt(L.rh, 0, "%")}</div>
        <div><span>Pressure (3 h)</span>${fmt(L.press, 1)}${tendTxt}</div>
        <div><span>Rain since 9am</span>${fmt(L.rain, 1, " mm")}</div>
        <div><span>24 h</span><i style="color:#f2a93b">temp</i> / <i style="color:#79d3e6">press</i></div>
      </div>
      ${sparkline(st.history)}
    </div>`;
  }).join("");
}

// ------------------------------------------------------------------ charts
const tip = $("tip");
function chart(el, { t, series, title, unit, height = 100, minZero = false, rightMax = null }) {
  const W = 370, H = height, padL = 30, padR = rightMax ? 28 : 6, padT = 6, padB = 16;
  const iw = W - padL - padR, ih = H - padT - padB;
  const left = series.filter(s => s.axis !== "right");
  const all = left.flatMap(s => s.v.filter(v => v != null));
  if (!all.length) { el.innerHTML = ""; return; }
  let lo = Math.min(...all), hi = Math.max(...all);
  if (minZero) lo = Math.min(0, lo);
  if (hi - lo < 1) hi = lo + 1;
  const pad = (hi - lo) * 0.08; if (!minZero) lo -= pad; hi += pad;
  const t0 = t[0], t1 = t[t.length - 1];
  const X = ts => padL + (ts - t0) / (t1 - t0) * iw;
  const Y = v => padT + ih - (v - lo) / (hi - lo) * ih;
  const YR = v => padT + ih - v / rightMax * ih;
  let g = "";
  for (let k = 0; k <= 2; k++) {
    const val = lo + (hi - lo) * k / 2, y = Y(val);
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="#263b44"/><text x="${padL - 4}" y="${y + 4}" text-anchor="end" fill="#8aa0a6" font-size="10">${Math.round(val)}</text>`;
  }
  if (rightMax) g += `<text x="${W - 2}" y="${padT + 8}" text-anchor="end" fill="#8aa0a6" font-size="10">${rightMax}%</text>`;
  // midnight ticks
  for (const ts of t) {
    if (fmtH23.format(new Date(ts * 1000)) === "00") g += `<line x1="${X(ts)}" x2="${X(ts)}" y1="${padT}" y2="${padT + ih}" stroke="#263b44" stroke-dasharray="2 3"/><text x="${X(ts) + 3}" y="${H - 3}" fill="#8aa0a6" font-size="10">${fmtDay.format(new Date(ts * 1000))}</text>`;
  }
  const now = Date.now() / 1000;
  if (now > t0 && now < t1) g += `<line x1="${X(now)}" x2="${X(now)}" y1="${padT}" y2="${padT + ih}" stroke="#f2a93b" stroke-width="1" opacity=".7"/>`;
  const bw = Math.max(1, iw / t.length - 0.5);
  for (const s of series) {
    const yf = s.axis === "right" ? YR : Y;
    if (s.type === "bar") {
      g += s.v.map((v, i) => v ? `<rect x="${X(t[i]) - bw / 2}" y="${yf(v)}" width="${bw}" height="${Math.max(0, yf(minZero ? 0 : lo) - yf(v))}" fill="${s.color}" opacity=".85"/>` : "").join("");
    } else {
      let d = "", pen = false;
      s.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(t[i]).toFixed(1)},${yf(v).toFixed(1)}`; pen = true; });
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/>`;
    }
  }
  const keys = series.map(s => `<span class="key"><i style="background:${s.color}"></i>${s.name}</span>`).join("");
  el.innerHTML = `<div class="chart-title"><span>${title}</span><span>${keys}</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${g}<line class="hair" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" stroke="#d6e2e4" opacity="0"/><rect x="${padL}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg>`;
  const svg = el.querySelector("svg"), hair = el.querySelector(".hair");
  svg.onmousemove = e => {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(t.length - 1, Math.round((x - padL) / iw * (t.length - 1))));
    hair.setAttribute("x1", X(t[i])); hair.setAttribute("x2", X(t[i])); hair.setAttribute("opacity", ".4");
    const d = new Date(t[i] * 1000);
    tip.innerHTML = `${fmtDay.format(d)} ${fmtTime.format(d)}<br>` + series.map(s => `<span style="color:${s.color}">${s.name}</span> ${s.v[i] == null ? "–" : (+s.v[i]).toFixed(s.dp ?? 1)}${s.unit ?? unit}`).join("<br>");
    tip.hidden = false;
    tip.style.left = Math.min(window.innerWidth - 170, e.clientX + 14) + "px";
    tip.style.top = e.clientY + 14 + "px";
  };
  svg.onmouseleave = () => { tip.hidden = true; hair.setAttribute("opacity", "0"); };
}

const WMO = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 80: "Showers", 81: "Heavy showers", 82: "Violent showers", 95: "Thunderstorms", 96: "Storms, hail", 99: "Storms, big hail", 71: "Snow", 73: "Snow", 75: "Heavy snow" };

async function loadForecast() {
  const q = S.fcPoint ? `?lat=${S.fcPoint.lat}&lon=${S.fcPoint.lon}` : "";
  const r = await fetch(`/api/forecast${q}`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!r) { $("fcTemp").textContent = "Forecast unavailable right now."; return; }
  const H = r.main.hourly;
  const now = Date.now() / 1000 - 3600;
  const start = H.time.findIndex(ts => ts >= now);
  const sl = a => a.slice(start, start + 72);
  const t = sl(H.time);
  chart($("fcTemp"), { t, title: "Temperature", unit: "°", series: [
    { name: "Air", v: sl(H.temperature_2m), color: "#f2a93b" },
    { name: "Feels", v: sl(H.apparent_temperature), color: "#8aa0a6", dash: "3 3", width: 1.3 },
    { name: "Dew pt", v: sl(H.dew_point_2m), color: "#79d3e6", width: 1.4 },
  ] });
  chart($("fcRain"), { t, title: "Rain", unit: "", minZero: true, rightMax: 100, height: 80, series: [
    { name: "mm", v: sl(H.precipitation), color: "#79d3e6", type: "bar", unit: " mm" },
    { name: "Chance", v: sl(H.precipitation_probability), color: "#8aa0a6", axis: "right", unit: "%", dp: 0, width: 1.3 },
  ] });
  chart($("fcWind"), { t, title: "Wind", unit: " km/h", minZero: true, height: 80, series: [
    { name: "Mean", v: sl(H.wind_speed_10m), color: "#d6e2e4", width: 1.4, dp: 0 },
    { name: "Gusts", v: sl(H.wind_gusts_10m), color: "#ef6f5c", dp: 0 },
  ] });
  chart($("fcCape"), { t, title: "Instability", unit: "", minZero: true, height: 70, series: [
    { name: "CAPE J/kg", v: sl(H.cape), color: "#f2a93b", type: "bar", unit: " J/kg", dp: 0 },
  ] });

  const M = r.models.hourly;
  const mstart = M.time.findIndex(ts => ts >= now);
  const ms = a => (a || []).slice(mstart, mstart + 72);
  const mt = ms(M.time);
  const models = [["ecmwf_ifs025", "ECMWF", "#f2a93b"], ["gfs_seamless", "GFS", "#79d3e6"], ["icon_seamless", "ICON", "#ef6f5c"]];
  chart($("fcModels"), { t: mt, title: "Temperature by model", unit: "°", series: models.map(([k, n, c]) => ({ name: n, v: ms(M[`temperature_2m_${k}`]), color: c, width: 1.5 })) });
  const cum = a => { let s = 0; return a.map(v => (v == null ? null : (s += v))); };
  chart($("fcModelRain"), { t: mt, title: "Accumulated rain by model", unit: " mm", minZero: true, height: 80, series: models.map(([k, n, c]) => ({ name: n, v: cum(ms(M[`precipitation_${k}`])), color: c, width: 1.5 })) });

  const D = r.main.daily;
  $("daily").innerHTML = D.time.map((ts, i) => `
    <span class="d">${fmtDay.format(new Date(ts * 1000 + 12 * 3600e3))}</span>
    <span class="desc">${WMO[D.weather_code[i]] || "–"}, gusts ${fmt(D.wind_gusts_10m_max[i], 0)}</span>
    <span class="mm">${fmt(D.temperature_2m_min[i], 0)}° / <b>${fmt(D.temperature_2m_max[i], 0)}°</b></span>
    <span class="rain">${rainWords(r.rain_range, ts, D, i)}</span>`).join("");
}

// BoM-style rain wording from the ECMWF ensemble: "70%: 2–8 mm" (at least 2 mm likely, more than 8 mm unlikely)
function rainWords(R, ts, D, i) {
  const key = new Date(ts * 1000 + 12 * 3600e3).toISOString().slice(0, 10);
  const e = R && R[key];
  if (!e) return `${fmt(D.precipitation_sum[i], 1)} mm ${D.precipitation_probability_max[i] != null ? D.precipitation_probability_max[i] + "%" : ""}`;
  if (e.chance < 15 || e.high < 0.2) return `<span title="Under 15% of ECMWF ensemble members give rain">No rain</span>`;
  const lo = e.low < 1 ? 0 : Math.round(e.low), hi = Math.max(1, Math.round(e.high));
  const amt = lo === 0 ? `up to ${hi} mm` : lo === hi ? `${lo} mm` : `${lo}–${hi} mm`;
  return `<span title="${e.chance}% of the 51 ECMWF ensemble members give rain. Low number: 75% chance of at least that much. High number: 25% chance of more.">${e.chance}%, ${amt}</span>`;
}
