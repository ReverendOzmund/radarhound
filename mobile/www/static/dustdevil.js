/* Radarhound: dust devil potential. Dust devils are too small and shallow for weather radar, so this is a
   forecast-model index (0-10) worked out on the server (app/dustdevil.py; phone mode does the same sums):
   strong sunshine on dry ground + a deep boundary layer + light wind + dry air.
   The forecast layers and the contour overlay are registered in supercell.js (before share links are read);
   this file adds the explanations and the line on the "Right now" card.
   Uses globals from app.js, layers.js, supercell.js and ux.js. */
"use strict";

Object.assign(FC_EXPLAIN, {
  ddp: "0 to 10. Under 2 unlikely, 2 to 4 possible, 4 to 7 likely, 7 and over very likely (and big ones). Built from sunshine on dry ground, boundary layer depth, humidity and wind. Peaks early to mid afternoon. It's a model estimate: log what you see so it can be checked.",
  wstar: "How hard the thermals are rising. Around 2 m/s is ordinary; 3.5 m/s and over is when dust devils get common over bare dry ground.",
  blh: "How deep the sun-heated, well-mixed layer is. Deeper means bigger thermals and taller dust devils; 3 km and over is a deep desert-style layer.",
});

// ---------------------------------------------------------------- "Right now" card: dust devil outlook for home (or where you are)
S.dd = null;
const ddQuery = () => { const me = S.nowMe && S.me2; return me ? `?lat=${me.lat.toFixed(2)}&lon=${me.lon.toFixed(2)}` : ""; };
async function loadDustDevil() {
  if (!S.cfg) return;
  const q = ddQuery();
  if (S.dd && S.dd.q === q && Date.now() - S.dd.got < 20 * 60e3) { renderDustDevil(); return; }      // the model only changes hourly
  if (loadDustDevil.busy === q) return;
  loadDustDevil.busy = q;
  const r = await fetch(`/api/env${q}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  loadDustDevil.busy = null;
  if (r && q === ddQuery()) S.dd = { ...r, q, got: Date.now() };       // an answer for a place we've since left is dropped
  renderDustDevil();
}
function renderDustDevil() {
  const el = $("nowDd"), r = S.dd;
  // nothing shown for another place, or from a fetch too old to call "right now"
  if (!r || r.q !== ddQuery() || Date.now() - r.got > 90 * 60e3 || !r.now || r.now.ddp == null) { el.hidden = true; return; }
  const now = r.now.ddp, pk = r.peak && r.peak.t * 1000 > Date.now() ? r.peak : null;
  if (!(now >= 2 || (pk && pk.ddp >= 2))) { el.hidden = true; return; }            // nothing to say on cool, wet, windy or dark hours
  const col = DD_SCALE(Math.max(1, now)) || [42, 75, 92];
  let peakTxt = "";
  if (pk && pk.ddp >= 2 && pk.ddp > now + 0.4) {
    const pt = new Date(pk.t * 1000), otherDay = fmtDate.format(pt) !== fmtDate.format(new Date());
    peakTxt = `Peaks ${pk.ddp.toFixed(1)} (${ddLabel(pk.ddp)}) around ${otherDay ? `${fmtDay.format(pt)} ` : ""}${fmtTime.format(pt)}.`;
  }
  const why = [r.now.temp != null ? `${Math.round(r.now.temp)}°` : null, r.now.rh != null ? `${Math.round(r.now.rh)}% humidity` : null,
    r.now.wind != null ? `wind ${Math.round(r.now.wind)} km/h` : null, r.now.blh != null ? `mixed layer ${(r.now.blh / 1000).toFixed(1)} km` : null].filter(Boolean).join(", ");
  el.innerHTML = `<span class="dd-score" style="background:rgb(${col.join(",")})">${now.toFixed(1)}</span>
    <span><b>Dust devils ${now >= 2 ? ddLabel(now) : "unlikely right now"}</b> ${esc(peakTxt)}<small>${esc(why)}</small></span>`;
  el.hidden = false;
}
$("nowDd").onclick = () => {
  S.settings.fcLayer = "ddp"; save();
  if (S.settings.view !== "fc") setView("fc"); else { syncFcControls(); refreshFcFrames(); renderLegend(); }
  $("fcLayer").value = "ddp";
};
// rides along with the Right-now card (which refreshes every couple of minutes and when it switches between home and
// "where I am"); loadDustDevil itself only asks the server every 20 minutes
{
  const _loadNow = loadNow;
  loadNow = async function () { await _loadNow(); loadDustDevil(); };
}
setTimeout(loadDustDevil, 2500);
