/* Radarhound phone mode: small adjustments to the page when it runs on the phone without a server. */
"use strict";
(() => {
  if (typeof WXP === "undefined") return;
  // satellite: NASA GIBS images only (no raw Himawari bands without the server)
  SAT_DEFS.geocolor = { kind: "png", name: "Himawari (NASA: visible by day, infrared at night)" };
  SAT_DEFS.ir13e = { kind: "png", name: "Himawari infrared (NASA)" };
  for (const k of ["ir13g", "wv08", "nmp", "dust", "dcp"]) delete SAT_DEFS[k];
  if (!SAT_DEFS[S.settings.satLayer]) { S.settings.satLayer = "geocolor"; save(); }
  window.addEventListener("DOMContentLoaded", () => {
    [...$("satSel").options].forEach(o => { if (!SAT_DEFS[o.value]) o.remove(); });
    $("satSel").value = S.settings.satLayer;
    const ga = document.querySelector(".get-app"); if (ga) ga.hidden = true;
  });
  // modes built on raw archive volumes need the server
  for (let i = MODES.length - 1; i >= 0; i--) if (MODES[i].tag === "Archive" || (MODES[i].set && MODES[i].set.product === "raw")) MODES.splice(i, 1);
  if (S.settings.product === "raw") { S.settings.product = "3"; save(); }
  // voice: the phone's own text-to-speech (the server's voice isn't here)
  const P = () => window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.WxAlerts;
  const _speak = speak;
  speak = async function (text) {
    if (S.settings.alertVoice === false) return;
    const p = P();
    if (p && p.speak) { try { await p.speak({ text }); return; } catch { /* fall back */ } }
    return _speak(text);
  };
  // the background service stays quiet while the page is on screen (the page alerts for itself), and
  // learns home and alert settings from here
  const sync = () => {
    const p = P(); if (!p) return;
    try { p.pageVisible && p.pageVisible({ visible: !document.hidden }); } catch { /* old app */ }
  };
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("DOMContentLoaded", () => {
    sync();
    const h = WXP.home();
    if (!h.unset) WXP.native("setPhoneHome", h);
    // first run in phone mode: ask where home is
    setTimeout(() => { if (WXP.home().unset && store.get("tourDone", 0) && $("homeDlg").hidden) openHomeDialog({ msg: "Where's home? Search for your suburb or address." }); }, 4000);
  });
  // the national view's first mosaic takes ~30 s to stitch on a phone: say so
  const _sr = selectRadar;
  selectRadar = function (id) {
    _sr(id);
    if (id === "AUS" && !(WXP.frameIndex.get("AUS") || new Map()).size) toast("Stitching every BoM radar into one map on your phone… about 30 seconds the first time.", 8000);
  };
})();
