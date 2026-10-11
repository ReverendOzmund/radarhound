/* wxdeck: performance overlay (press P) and timed fetches. Loaded before app.js. */
"use strict";
const PERF = (() => {
  const stats = { draw: [], decode: [], api: [] }, calls = [];
  let el = null, on = false, frames = 0, fps = 0, last = performance.now();
  const note = (k, ms) => { const a = stats[k]; a.push(ms); if (a.length > 60) a.shift(); };
  const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const p95 = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * 0.95))]; };
  function tick() {
    if (!on) return;
    frames++;
    const now = performance.now();
    if (now - last >= 1000) { fps = frames * 1000 / (now - last); frames = 0; last = now; render(); }
    requestAnimationFrame(tick);
  }
  function render() {
    if (!el) return;
    const wk = typeof WK !== "undefined" && WK ? `worker on, ${WK.pending.size} queued` : "worker off";
    const gpu = typeof GL === "undefined" || S.settings.gpu === false ? "CPU raw rendering" : GL.slow ? "GPU too slow here, CPU raw rendering" : GL.available() ? "GPU raw rendering" : "no WebGL, CPU raw rendering";
    const mem = performance.memory ? `, ${(performance.memory.usedJSHeapSize / 1e6).toFixed(0)} MB JS heap` : "";
    el.innerHTML = `<b>${fps.toFixed(0)} fps</b>, draw ${avg(stats.draw).toFixed(1)} ms (p95 ${p95(stats.draw).toFixed(1)}), decode ${avg(stats.decode).toFixed(1)} ms<br>`
      + `${wk}; ${gpu}${mem}<br>`
      + calls.slice(-6).reverse().map(c => `<span class="${c.ms > 1500 ? "slow" : ""}">${c.ms.toFixed(0)} ms ${(c.kb).toFixed(0)} kB ${c.url}</span>`).join("<br>");
  }
  function toggle(force) {
    on = force ?? !on;
    if (!el) { el = document.createElement("div"); el.className = "perf"; document.getElementById("scopeFrame").appendChild(el); }
    el.hidden = !on;
    if (on) { last = performance.now(); frames = 0; requestAnimationFrame(tick); render(); }
  }
  function api(url, ms, bytes) { calls.push({ url: url.replace(/\?.*/, ""), ms, kb: bytes / 1024 }); if (calls.length > 40) calls.shift(); note("api", ms); }
  return { note, toggle, api, get on() { return on; } };
})();
// fetch wrapper that records how long each API call took (shown in the overlay)
async function timedFetch(url, opts) {
  const t0 = performance.now();
  const r = await fetch(url, opts);
  const len = +(r.headers.get("content-length") || 0);
  PERF.api(url, performance.now() - t0, len);
  return r;
}
