/* Radarhound: Log sighting. A quick spotter log for what you can actually see (dust devil, funnel, hail,
   wind damage…), with where and when. The server (or the phone, in phone mode) keeps each one together with
   the radar frame nearest that time and the forecast model's numbers for that spot and hour, so sightings can
   be lined up against the forecast and the radar afterwards. The map markers are drawn by layers.js.
   Uses globals from app.js, layers.js and ux.js. */
"use strict";

const SIGHT = { kind: "dustdevil", gps: null, gpsBusy: false, gpsDenied: false, userPicked: false, hinted: false, urls: new Map(), shown: 12, fails: 0, nextTry: 0 };
const sightOffset = (lat, lon, brg, km) => {
  const b = brg * Math.PI / 180, la = lat + km * Math.cos(b) / KM_PER_DEG;
  return [la, lon + km * Math.sin(b) / (KM_PER_DEG * Math.cos(la * Math.PI / 180))];
};
// the newest fix from this dialog or the Me button, if it's under two minutes old
const sightGpsFresh = () => {
  const cands = [SIGHT.gps, S.me, S.me2].filter(p => p && p.t && Date.now() - p.t < 2 * 60e3);
  return cands.sort((a, b) => b.t - a.t)[0] || null;
};
const sightCanGps = () => !!(navigator.geolocation && window.isSecureContext);

// ---------------------------------------------------------------- the dialog
function sightWhereOptions() {
  const opts = [], g = sightGpsFresh();
  if (g) opts.push(["gps", `Where I am (GPS${g.acc != null ? ` ±${Math.round(g.acc)} m` : ""})`]);
  else if (sightCanGps()) opts.push(["gps", SIGHT.gpsBusy ? "Where I am (finding you…)" : "Where I am (GPS)"]);
  if (S.pin && S.radar) opts.push(["pin", "Pinned point on the map"]);
  if (S.cfg) opts.push(["home", S.cfg.home.name || "Home"]);
  if (S.radar) opts.push(["centre", "Middle of the map"]);
  return opts;
}
function sightObserver() {
  const w = $("repWhere").value;
  if (w === "gps") { const g = sightGpsFresh(); return g ? { lat: g.lat, lon: g.lon, acc: g.acc, src: "gps" } : null; }
  if (w === "pin" && S.pin) { const [lat, lon] = kmToLatLon(...S.pin); return { lat, lon, src: "pin" }; }
  if (w === "centre" && S.radar) { const [lat, lon] = kmToLatLon(S.view.cx, S.view.cy); return { lat, lon, src: "map" }; }
  return S.cfg ? { lat: S.cfg.home.lat, lon: S.cfg.home.lon, src: "home" } : null;
}
function sightTarget() {
  const o = sightObserver();
  if (!o) return null;
  const dir = $("repDir").value, km = parseFloat($("repDist").value);
  if (dir === "" || !(km > 0)) return { ...o, away: false };
  const [lat, lon] = sightOffset(o.lat, o.lon, +dir, Math.min(300, km));
  return { lat, lon, olat: o.lat, olon: o.lon, acc: o.acc, src: o.src, away: true, km: Math.min(300, km), dir: +dir };
}
function sightFillWhere(keep) {
  const sel = $("repWhere"), opts = sightWhereOptions(), prev = keep ?? sel.value;
  sel.innerHTML = opts.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join("");
  if (opts.some(o => o[0] === prev)) sel.value = prev;
  sightNote();
}
function sightNote() {
  const t = sightTarget(), el = $("repWhereNote");
  $("repDist").hidden = $("repDir").value === "";
  if ($("repWhere").value === "gps" && !sightGpsFresh()) {
    el.textContent = SIGHT.gpsBusy ? "Finding where you are…" : "No GPS fix yet. Pick another spot, or allow location and try again.";
    return;
  }
  if (!t) { el.textContent = ""; return; }
  const h = S.cfg ? haversine(S.cfg.home.lat, S.cfg.home.lon, t.lat, t.lon) : null;
  const fromHome = h ? (h.dist < 0.3 ? `at ${S.cfg.home.name}` : `${h.dist.toFixed(h.dist < 10 ? 1 : 0)} km ${compass(h.brg)} of ${S.cfg.home.name}`) : "";
  el.textContent = `${t.away ? `Plotted ${t.km} km ${compass(t.dir)} of that spot: ` : "Plotted at "}${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}${fromHome ? ` (${fromHome})` : ""}.`
    + ($("repDir").value !== "" && !t.away ? " Add the distance, or it's logged right there." : "")
    + (!sightCanGps() && !SIGHT.hinted ? " (GPS needs https or the app's phone mode; tap the map first to log somewhere else.)" : "");
  SIGHT.hinted = true;                         // said once per time the dialog is opened
}
function sightGetGps() {
  if (!sightCanGps() || SIGHT.gpsBusy) return;
  SIGHT.gpsBusy = true; sightFillWhere();
  navigator.geolocation.getCurrentPosition(p => {
    SIGHT.gpsBusy = false; SIGHT.gpsDenied = false;
    SIGHT.gps = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
    if (!$("repDlg").hidden) sightFillWhere(SIGHT.userPicked ? undefined : "gps");
  }, err => {
    SIGHT.gpsBusy = false;
    if (err && err.code === 1) SIGHT.gpsDenied = true;          // location permission refused: don't default to GPS next time
    // stays on "Where I am" with a note (Save refuses without a fix) rather than quietly logging it at home
    if (!$("repDlg").hidden) sightFillWhere();
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
}
function sightSetKind(k) {
  SIGHT.kind = REPORT_KINDS[k] ? k : "other";
  document.querySelectorAll("#repKinds button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.kind === SIGHT.kind)));
  $("repSizeWrap").hidden = SIGHT.kind !== "hail";
  store.set("sightKind", SIGHT.kind);
}
const sightLocalInput = t => new Date(+t - new Date(+t).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
function openSightingDialog(where) {
  if (!S.cfg) { toast("Still loading: try again in a moment."); return; }
  if (!$("repKinds").children.length) {
    $("repKinds").innerHTML = Object.entries(REPORT_KINDS).map(([k, n]) =>
      `<button type="button" role="radio" data-kind="${k}"><i style="background:${(REPORT_STYLE[k] || REPORT_STYLE.other)[0]}"></i>${esc(n)}</button>`).join("");
    document.querySelectorAll("#repKinds button").forEach(b => { b.onclick = () => sightSetKind(b.dataset.kind); });
  }
  sightSetKind(store.get("sightKind", "dustdevil"));
  $("repSize").value = ""; $("repNote").value = ""; $("repPhoto").value = ""; $("repDir").value = ""; $("repDist").value = "";
  SIGHT.userPicked = !!where; SIGHT.hinted = false;
  // from a pin while looking back through the radar loop, the sighting is for the frame on screen; otherwise it's now
  const ft = where === "pin" && S.mode === "live" && S.settings.view !== "fc" && S.idx < S.frames.length - 1 ? currentTime() : null;
  $("repTime").max = sightLocalInput(Date.now() + 60e3);
  $("repTime").value = sightLocalInput(ft && +ft < Date.now() ? +ft : Date.now());
  $("repSave").disabled = false; $("repSave").textContent = "Save sighting";
  const start = where || (sightGpsFresh() || (sightCanGps() && !SIGHT.gpsDenied) ? "gps" : S.pin ? "pin" : "home");
  sightFillWhere(start);
  $("toast").hidden = true;                    // a tip left on screen would sit over the Save button on phones
  $("repDlg").hidden = false;
  const first = $("repKinds").querySelector('[aria-checked="true"]');
  if (first) first.focus();
  if (!where || where === "gps") sightGetGps();      // always a new fix: an old one can be kilometres out in a moving car
}
function closeSightingDialog() {
  if ($("repDlg").hidden) return;
  $("repDlg").hidden = true;
  $("sightChip").focus();
}
// shrink the photo before it goes anywhere: country internet, and nobody needs 12 megapixels of dust
async function sightShrink(file, max = 1600, q = 0.8) {
  let src;
  try { src = await createImageBitmap(file); }
  catch {
    src = await new Promise((res, rej) => { const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = rej; im.src = u; });
  }
  const k = Math.min(1, max / Math.max(src.width, src.height)), c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", q);
}
const sightCid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
async function saveSighting() {
  const t = sightTarget();
  if (!t) { toast($("repWhere").value === "gps" ? "No GPS fix yet: wait a moment, or pick Home or the pinned point." : "No location yet: pick Home or tap the map first."); return; }
  const when = new Date($("repTime").value);
  if (Number.isNaN(+when)) { toast("That time doesn't look right."); return; }
  if (+when > Date.now() + 5 * 60e3) { toast("That time is in the future."); return; }
  const size = SIGHT.kind === "hail" ? $("repSize").value.trim() : "";
  if (size !== "" && !(+size >= 0 && +size <= 300)) { toast("Hail size should be between 0 and 300 mm."); return; }
  const btn = $("repSave");
  btn.disabled = true; btn.textContent = "Saving…";
  let photo = null;
  const f = $("repPhoto").files && $("repPhoto").files[0];
  if (f) { try { photo = await sightShrink(f); } catch { toast("Couldn't read that photo: saving without it."); } }
  const body = { cid: sightCid(), lat: +t.lat.toFixed(4), lon: +t.lon.toFixed(4), kind: SIGHT.kind, size, note: $("repNote").value.trim(), t: when.toISOString(), src: t.src,
    pid: S.product && S.product.pid && (S.product.type || "0") === "0" ? S.product.pid : "" };
  if (t.away) { body.olat = +t.olat.toFixed(4); body.olon = +t.olon.toFixed(4); }
  if (t.acc != null) body.acc = Math.round(t.acc);
  if (photo) body.photo = photo;
  // kept on the device first, so closing the page mid-upload can't lose it; taken off the list once the server has it
  const kept = sightQueue(body);
  SIGHT.saving = true;
  let res;
  try { res = await sightPost(body); } finally { SIGHT.saving = false; }
  const again = () => { btn.disabled = false; btn.textContent = "Save sighting"; };
  if (res === "ok") {
    sightUnqueue(body.cid);
    toast(`${esc(REPORT_KINDS[SIGHT.kind])} logged. The radar frame and forecast numbers for that spot are being saved with it.`, 6000);
  } else if (res === "bad") {
    sightUnqueue(body.cid); again();
    toast("That sighting wasn't accepted (check the time, hail size and photo). Nothing was saved.", 7000);
    return;
  } else if (kept === "full") {
    again();
    toast("Couldn't save it: there's no connection and this device's storage is full. Leave this open and try Save again shortly.", 9000);
    return;
  } else {
    toast((res === "auth" ? "You've been logged out, so it couldn't be sent. It's kept on this device: reload the page, log in, and it will go through."
      : "No connection to save it right now. It's kept on this device and will be sent when the connection is back.")
      + (kept === "nophoto" ? " The photo was too big to keep, so it will go without it." : ""), 9000);
  }
  closeSightingDialog();
  draw(); updateReadout();
}
// "ok" (the server has it), "bad" (it refused the data: don't retry), "auth" (logged out) or "retry" (no connection, busy, 5xx)
async function sightPost(body, noPhotoRetry = false) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), body.photo ? 60000 : 20000);
  let res = null;
  try { res = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }); }
  catch { res = null; }
  clearTimeout(timer);
  if (!res) return "retry";
  if (res.status === 413 && body.photo && !noPhotoRetry) { const { photo, ...rest } = body; return sightPost(rest, true); }      // something in between won't pass the photo
  if (res.status === 400 || res.status === 422 || res.status === 413) return "bad";
  if (res.status === 401 || res.status === 403) return "auth";
  if (!res.ok) return "retry";
  const r = await res.json().catch(() => null);
  if (!r || !Array.isArray(r.reports)) return "retry";             // a login or captive-portal page, not Radarhound
  S.reports = r.reports; S.settings.reports = true; save(); $("lyrReports").checked = true;
  renderSightings(); draw();
  setTimeout(loadReports, 8000);                     // pick up the environment and radar snapshot once they're saved
  setTimeout(loadReports, 30000);
  return "ok";
}
// sightings wait here until the server has them (country internet drops out exactly when the weather is interesting)
// returns "ok", "nophoto" (kept, but storage had no room for the photo) or "full" (couldn't be kept at all)
function sightQueue(body) {
  const has = () => store.get("sightQueue", []).some(x => x.cid === body.cid);
  store.set("sightQueue", store.get("sightQueue", []).concat([body]));
  if (has()) return "ok";
  const { photo, ...rest } = body;
  store.set("sightQueue", store.get("sightQueue", []).concat([rest]));
  return has() ? (photo ? "nophoto" : "ok") : "full";
}
const sightUnqueue = cid => store.set("sightQueue", store.get("sightQueue", []).filter(x => x.cid !== cid));
async function sightFlush() {
  if (SIGHT.flushing || SIGHT.saving || Date.now() < SIGHT.nextTry) return;
  if (!store.get("sightQueue", []).length) return;
  SIGHT.flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const q = store.get("sightQueue", []);          // read again each time: another sighting may have joined meanwhile
      if (!q.length) break;
      const item = q[0];
      if (!item.cid) item.cid = sightCid();
      const res = await sightPost(item);
      if (res === "ok" || res === "bad") {
        store.set("sightQueue", store.get("sightQueue", []).filter((x, i) => (x.cid ? x.cid !== item.cid : i !== 0)));
        SIGHT.fails = 0;
        if (res === "ok") sent++; else toast("One sighting saved earlier wasn't accepted by the server and has been dropped.", 7000);
      } else {                                         // still no connection (or logged out): wait longer each time, up to half an hour
        SIGHT.fails++;
        SIGHT.nextTry = Date.now() + Math.min(30 * 60e3, 60e3 * 2 ** Math.min(SIGHT.fails, 5));
        break;
      }
    }
  } finally { SIGHT.flushing = false; }
  if (sent) toast(`${sent === 1 ? "A sighting" : `${sent} sightings`} saved earlier ${sent === 1 ? "has" : "have"} been sent.`);
  renderSightings();
}
setInterval(sightFlush, 60e3);
window.addEventListener("online", () => { SIGHT.nextTry = 0; sightFlush(); });
setTimeout(sightFlush, 6000);

$("repCancel").onclick = closeSightingDialog;
$("repSave").onclick = saveSighting;
$("repNow").onclick = () => { $("repTime").value = sightLocalInput(Date.now()); };
$("repWhere").onchange = () => { SIGHT.userPicked = true; if ($("repWhere").value === "gps" && !sightGpsFresh()) sightGetGps(); sightNote(); };
$("repDir").onchange = () => { sightNote(); if ($("repDir").value !== "") $("repDist").focus(); };
$("repDist").oninput = sightNote;
$("sightChip").onclick = () => openSightingDialog();
$("pinReport").onclick = () => openSightingDialog("pin");
window.addEventListener("radarhound-sightings", () => loadReports());      // phone mode: snapshot finished

// ---------------------------------------------------------------- the log
const SIGHT_ENV = [      // [key, label, formatter, highlighted for these kinds]
  ["ddp", "Dust devil", v => `${v.toFixed(1)} / 10`, ["dustdevil"]], ["wstar", "Thermals", v => `${v.toFixed(1)} m/s`, ["dustdevil"]],
  ["blh", "Mixed layer", v => `${(v / 1000).toFixed(1)} km`, ["dustdevil"]], ["dts", "Ground − air", v => `${v > 0 ? "+" : ""}${v.toFixed(0)}°`, ["dustdevil"]],
  ["temp", "Temp", v => `${v.toFixed(0)}°`], ["rh", "Humidity", v => `${v.toFixed(0)}%`], ["wind", "Wind", v => `${v.toFixed(0)} km/h`],
  ["gust", "Gust", v => `${v.toFixed(0)} km/h`, ["wind", "shelf"]], ["cloud", "Cloud", v => `${v.toFixed(0)}%`],
  ["cape", "CAPE", v => `${Math.round(v)} J/kg`, ["hail", "funnel", "tornado", "wallcloud", "wind", "shelf", "lightning", "rain"]],
  ["cin", "CIN", v => `${Math.round(v)}`], ["li", "LI", v => v.toFixed(1)], ["lcl", "Cloud base", v => `${Math.round(v)} m`, ["funnel", "tornado", "wallcloud"]],
  ["shear6", "0–6 km shear", v => `${v.toFixed(0)} kt`, ["hail", "funnel", "tornado", "wallcloud"]], ["srh1", "0–1 km SRH", v => `${Math.round(v)}`, ["funnel", "tornado", "wallcloud"]],
  ["srh3", "0–3 km SRH", v => `${Math.round(v)}`], ["stp", "STP", v => v.toFixed(1), ["tornado", "funnel"]], ["scp", "SCP", v => v.toFixed(1), ["hail", "wallcloud"]],
  ["lr75", "Lapse 700–500", v => `${v.toFixed(1)}°/km`, ["hail"]], ["lr85", "Lapse 850–500", v => `${v.toFixed(1)}°/km`],
];
const SIGHT_CSV = ["id", "t", "kind", "size", "lat", "lon", "olat", "olon", "src", "acc", "note", "photo", "radar_pid", "radar_frame", "radar_range_km", "radar_beam_km",
  "ddp", "wstar", "blh", "dts", "temp", "dew", "rh", "wind", "wdir", "gust", "cloud", "rain", "cape", "cin", "li", "lcl", "shear6", "srh1", "srh3", "stp", "scp", "lr75", "lr85"];
function sightCsv() {
  const cell = v => {
    let s = v == null ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;      // so a spreadsheet doesn't run a note as a formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [SIGHT_CSV.join(",")];
  for (const r of S.reports) {
    const rad = r.radar || {}, flat = { ...(r.env || {}), ...r, radar_pid: rad.pid, radar_frame: rad.frame, radar_range_km: rad.range_km, radar_beam_km: rad.beam_km, photo: r.photo ? "yes" : "" };
    rows.push(SIGHT_CSV.map(k => cell(typeof flat[k] === "object" ? "" : flat[k])).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff", rows.join("\r\n")], { type: "text/csv;charset=utf-8" }));      // the mark makes Excel read ° and … properly
  a.download = "radarhound-sightings.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function renderSightings() {
  const list = $("sightList");
  if (!list || $("sightDlg").hidden) return;
  const all = (S.reports || []).filter(r => !Number.isNaN(+new Date(r.t))).sort((a, b) => +new Date(b.t) - +new Date(a.t));
  for (const [k, u] of SIGHT.urls) if (!all.some(r => k.startsWith(r.id + "/"))) { URL.revokeObjectURL(u); SIGHT.urls.delete(k); }      // pictures of deleted sightings
  const queued = store.get("sightQueue", []).length;
  if (!all.length) {
    list.innerHTML = `<p class="dim">Nothing logged yet. Use <b>Log sighting</b> when you see a dust devil, funnel, hail or damage.${queued ? ` ${queued} waiting to be sent.` : ""}</p>`;
    return;
  }
  const home = S.cfg && S.cfg.home;
  list.innerHTML = (queued ? `<p class="dim">${queued} sighting${queued > 1 ? "s" : ""} waiting for a connection.</p>` : "") + all.slice(0, SIGHT.shown).map(r => {
    const t = new Date(r.t), env = r.env || {}, rad = r.radar;
    const h = home ? haversine(home.lat, home.lon, r.lat, r.lon) : null;
    const chips = SIGHT_ENV.filter(([k]) => env[k] != null).map(([k, lab, f, hi]) => `<span class="${hi && hi.includes(r.kind) ? "hi" : ""}"><small>${lab}</small>${esc(f(+env[k]))}</span>`).join("");
    const seen = r.olat != null ? haversine(r.olat, r.olon, r.lat, r.lon) : null;
    return `<article class="sight-item" data-id="${esc(r.id)}">
      <header><b style="color:${(REPORT_STYLE[r.kind] || REPORT_STYLE.other)[0]}">${esc(REPORT_KINDS[r.kind] || r.kind)}${r.size ? ` ${esc(r.size)} mm` : ""}</b>
        <span>${fmtDate ? `${fmtDate.format(t)} ${fmtTime.format(t)}` : esc(t.toLocaleString())}</span>
        <span class="dim">${h ? `${h.dist.toFixed(h.dist < 10 ? 1 : 0)} km ${compass(h.brg)} of ${esc(home.name)}` : ""}${seen ? `, seen from ${seen.dist.toFixed(1)} km away` : ""}</span>
        <button class="link-btn" data-act="show">show on map</button><button class="link-btn" data-act="del">delete</button></header>
      ${r.note ? `<div>${esc(r.note)}</div>` : ""}
      ${chips ? `<div class="sight-env">${chips}</div>` : `<div class="dim">${Date.now() - parseInt(String(r.id).slice(1), 10) < 3 * 60e3 ? "Saving the forecast numbers for this spot…" : "No forecast numbers were saved with this one."}</div>`}
      ${rad ? `<div class="dim">Radar: ${esc(rad.radar || rad.pid)} ${rad.km || ""} km, frame ${fmtTime ? fmtTime.format(new Date(rad.frame)) : ""}${rad.range_km != null ? `, ${Math.round(rad.range_km)} km from the radar, beam ${beamShort(rad.beam_km)}` : ""}.${rad.beam_km >= BEAM_NOTE_KM ? " Too high to see near the ground there." : ""}</div>` : ""}
      <div class="sight-pics">${r.photo ? `<figure><img data-file="photo" alt="Photo of the sighting"><figcaption>Your photo</figcaption></figure>` : ""}${rad ? `<figure><img data-file="radar" alt="Radar frame at the time"><figcaption>Radar at the time</figcaption></figure>` : ""}</div>
    </article>`;
  }).join("") + (all.length > SIGHT.shown ? `<button class="tbtn" id="sightMore" type="button">Show ${Math.min(12, all.length - SIGHT.shown)} older</button>` : "");
  const more = $("sightMore");
  if (more) more.onclick = () => { SIGHT.shown += 12; renderSightings(); };
  list.querySelectorAll(".sight-item").forEach(el => {
    const id = el.dataset.id, r = S.reports.find(x => x.id === id);
    el.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm("Delete this sighting, with its photo and saved radar frame?")) return;
      const d = await fetch(`/api/reports/${encodeURIComponent(id)}`, { method: "DELETE" }).then(x => (x.ok ? x.json() : null)).catch(() => null);
      if (d) { S.reports = d.reports; renderSightings(); draw(); } else toast("Couldn't delete it right now.");
    };
    el.querySelector('[data-act="show"]').onclick = () => {
      if (!S.radar || !r) { toast("The map isn't ready yet."); return; }
      const [x, y] = latLonToKm(r.lat, r.lon);
      if (!isNational() && Math.hypot(x, y) > 700) { toast(`That one is ${Math.round(Math.hypot(x, y))} km from ${esc(S.radar.name)}: switch to a closer radar (or All Australia) and try again.`, 7000); return; }
      closeSightings();
      S.pin = [x, y]; S.view.cx = x; S.view.cy = y;
      S.settings.reports = true; save(); $("lyrReports").checked = true;
      draw(); updateReadout();
      if (Date.now() - +new Date(r.t) > 24 * 3600e3) toast("Pinned where it was. Markers are only drawn for 24 hours after a sighting.");
    };
    el.querySelectorAll("img[data-file]").forEach(async img => {      // through fetch, so it works with a password and in phone mode
      const key = `${id}/${img.dataset.file}`;
      // the radar frame can be replaced by a later one, so its picture is kept per frame time
      const ver = img.dataset.file === "radar" && r && r.radar ? `${key}@${r.radar.frame}` : key;
      if (SIGHT.urls.has(ver)) { img.src = SIGHT.urls.get(ver); return; }
      try {
        const b = await fetch(`/api/reports/${encodeURIComponent(id)}/${img.dataset.file}${ver !== key ? `?f=${encodeURIComponent(r.radar.frame)}` : ""}`).then(x => (x.ok ? x.blob() : null));
        if (!b) { img.closest("figure").remove(); return; }
        for (const [k, u] of SIGHT.urls) if (k.startsWith(key + "@")) { URL.revokeObjectURL(u); SIGHT.urls.delete(k); }
        const u = URL.createObjectURL(b); SIGHT.urls.set(ver, u); img.src = u;
      } catch { const fg = img.closest("figure"); if (fg) fg.remove(); }
    });
  });
}
function openSightings() { SIGHT.shown = 12; $("sightDlg").hidden = false; renderSightings(); loadReports(); $("sightClose").focus(); }
function closeSightings() {
  if ($("sightDlg").hidden) return;
  $("sightDlg").hidden = true;
  for (const u of SIGHT.urls.values()) URL.revokeObjectURL(u);
  SIGHT.urls.clear();
}
$("sightLogBtn").onclick = openSightings;
$("sightClose").onclick = closeSightings;
$("sightCsv").onclick = sightCsv;
$("sightNew").onclick = () => { closeSightings(); openSightingDialog(); };
// Escape with the cursor in one of the dialog's own fields (app.js handles it everywhere else, and ignores keys typed into fields)
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (!$("repDlg").hidden) closeSightingDialog(); else if (!$("sightDlg").hidden) closeSightings();
});
