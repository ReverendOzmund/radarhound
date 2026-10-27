/* Radarhound: NWS-style alerts in the browser. New warnings near home (or anywhere, if chosen) sound an
   attention tone, are read out loud ("Tornado warning issued for Perth, Cannington and Bentley...") and
   show a banner; a system notification is added where the browser allows it (https or localhost).
   Browsers only allow sound after you've touched the page once, so the first tap or click unlocks it. */
"use strict";

const ALERT = { ctx: null, seen: null, timer: null, unlocked: false, queue: [], speaking: false };
// inside the Android app the background service already plays the tone and reads the alert out
const IN_APP = /radarhound-app/.test(navigator.userAgent) && typeof WXP === "undefined";      // phone mode: the page alerts for itself while open

function alertSeen() {
  if (!ALERT.seen) {
    try { ALERT.seen = JSON.parse(localStorage.getItem("radarhound.alertsSeen") || "{}"); } catch { ALERT.seen = {}; }
    const cutoff = Date.now() - 24 * 3600e3;
    for (const [k, t] of Object.entries(ALERT.seen)) if (t < cutoff) delete ALERT.seen[k];
  }
  return ALERT.seen;
}
function markSeen(id) {
  alertSeen()[id] = Date.now();
  try { localStorage.setItem("radarhound.alertsSeen", JSON.stringify(ALERT.seen)); } catch { /* private mode */ }
}

// unlock audio and speech on the first interaction with the page. Phones only count a finished tap
// (touchend / pointerup / click) as permission to play sound, so listen for all of them, and only call
// it unlocked once the audio context is actually running.
function unlockAudio() {
  if (ALERT.unlocked && ALERT.ctx && ALERT.ctx.state === "running") return;
  try {
    ALERT.ctx = ALERT.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const p = ALERT.ctx.resume();
    const done = () => {
      if (ALERT.ctx.state !== "running" || ALERT.unlocked) return;
      ALERT.unlocked = true;
      // a silent blip finishes the unlock on iOS, and wakes the browser's own voice for the fallback
      const b = ALERT.ctx.createBuffer(1, 1, 22050), s = ALERT.ctx.createBufferSource(); s.buffer = b; s.connect(ALERT.ctx.destination); s.start();
      if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
      const n = document.querySelector("#alertBanner .sound-off"); if (n) n.remove();
    };
    if (p && p.then) p.then(done, () => { }); else done();
  } catch { /* no audio */ }
}
["pointerdown", "pointerup", "touchend", "click", "keydown"].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true, capture: true }));

// attention tone in the style of the US emergency alert signal: 853 Hz + 960 Hz together, in bursts
function attentionTone(bursts = 2) {
  const a = ALERT.ctx;
  if (!a) return 0;
  const t0 = a.currentTime + 0.05, len = 1.1, gap = 0.25;
  for (let b = 0; b < bursts; b++) {
    const start = t0 + b * (len + gap);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.35, start + 0.03);
    g.gain.setValueAtTime(0.35, start + len - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, start + len);
    g.connect(a.destination);
    for (const f of [853, 960]) { const o = a.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(g); o.start(start); o.stop(start + len + 0.02); }
  }
  return (bursts * (len + gap)) * 1000;
}

// spoken alert: the server makes the audio (works everywhere, including the phone app); the browser's
// own voice is only a fallback if the server can't. Resolves when it has finished speaking.
async function speak(text) {
  if (S.settings.alertVoice === false) return;
  try {
    const r = await fetch(`/api/speech?text=${encodeURIComponent(text)}`);
    if (!r.ok) throw new Error("no server voice");
    const buf = await r.arrayBuffer();
    const a = ALERT.ctx || (ALERT.ctx = new (window.AudioContext || window.webkitAudioContext)());
    await a.resume();
    const audio = await a.decodeAudioData(buf);
    const src = a.createBufferSource(); src.buffer = audio; src.connect(a.destination);
    ALERT.voice = src;
    await new Promise(res => { src.onended = res; src.start(); setTimeout(res, audio.duration * 1000 + 1500); });
    return;
  } catch { /* fall through to the browser's voice */ }
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find(v => /en-AU/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang)) || null;
  u.rate = 0.95; u.volume = 1;
  await new Promise(res => { u.onend = u.onerror = res; speechSynthesis.speak(u); setTimeout(res, 30e3); });
}

function alertBanner(a, more = 0) {
  const el = $("alertBanner");
  el.className = `alert-banner ${a.type === "TOR" ? "tor" : a.source === "BoM" ? "bom" : "svr"}`;
  const muted = !IN_APP && !(ALERT.ctx && ALERT.ctx.state === "running");
  const sub = a.source === "BoM"
    ? ["Bureau of Meteorology", (a.areas || []).length ? `includes ${a.areas.slice(0, 4).join(", ")}` : "",
       a.issued ? `issued ${new Date(a.issued).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""].filter(Boolean).join(" · ")
    : a.speech;
  el.innerHTML = `<b>${esc(a.title)}</b><span>${esc(sub)}${more ? ` <i>(+${more} more)</i>` : ""}</span>
    ${muted ? `<em class="sound-off">Tap anywhere to turn alert sound on</em>` : ""}
    <button id="alertShow">Show</button><button id="alertClose" aria-label="Dismiss">×</button>`;
  el.hidden = false;
  $("alertClose").onclick = () => { el.hidden = true; ALERT.queue = []; try { ALERT.voice && ALERT.voice.stop(); window.speechSynthesis && speechSynthesis.cancel(); } catch { } };
  $("alertShow").onclick = () => {
    el.hidden = true;
    if (typeof a.lat === "number" && typeof a.lon === "number" && S.view) {
      const [x, y] = latLonToKm(a.lat, a.lon); S.view.cx = x; S.view.cy = y; draw();
    }
    const panel = $(a.source === "BoM" ? "warnPanel" : "wxwPanel");
    if (panel) { panel.hidden = false; panel.scrollIntoView({ behavior: "smooth", block: "start" }); }
  };
}

// a short two-note chime for warnings further away (shown, but not read out)
function chime() {
  const a = ALERT.ctx;
  if (!a) return;
  [[880, 0], [660, 0.22]].forEach(([f, d]) => {
    const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + d;
    o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + 0.4);
  });
}
// New alerts in one go: the tone once (for the most severe), then each nearby one read out in turn
// (up to three; the banner counts the rest). Warnings further away only chime.
async function fireAlerts(list, test = false) {
  if (!list.length) return;
  if (!test) list.forEach(a => markSeen(a.id));
  const near = list.filter(a => a.near !== false);
  alertBanner(near[0] || list[0], list.length - 1);
  if (window.Notification && Notification.permission === "granted" && document.hidden && !IN_APP) {
    for (const a of near.slice(0, 3)) {
      try { new Notification(a.title, { body: a.source === "BoM" ? a.title : a.speech, tag: a.id, renotify: true, requireInteraction: a.type === "TOR" }); } catch { /* not allowed */ }
    }
  }
  if (IN_APP && !test) return;          // the app's background service plays its own tone and voice
  if (!near.length) { chime(); return; }
  if (ALERT.speaking) { ALERT.queue = (ALERT.queue || []).concat(near.slice(0, 3)); return; }
  ALERT.speaking = true;
  try {
    const top = near[0];
    const ms = top.severity === 0 ? (chime(), 900)                          // rain soon: just a chime before the voice
      : attentionTone(near.some(a => a.type === "TOR") ? 3 : (top.severity || 2) >= 2 ? 2 : 1);   // watches, lightning, approach: one burst
    await new Promise(r => setTimeout(r, ms + 300));
    let queue = near.slice(0, 3);
    while (queue.length) {
      for (const a of queue) {
        if ($("alertBanner").hidden && !test) break;          // dismissed: stop talking
        await speak((test ? "This is a test. " : "Radarhound alert. ") + a.speech);
        await new Promise(r => setTimeout(r, 500));
      }
      queue = ALERT.queue || []; ALERT.queue = [];
    }
  } finally { ALERT.speaking = false; }
}
function fireAlert(a, test = false) { return fireAlerts([a], test); }

async function checkAlerts() {
  const mode = S.settings.alerts || "near";
  if (mode === "off") return;
  // always fetch everything: warnings near home get tone and voice, the rest a chime (unless turned off)
  const me = typeof alertPoint === "function" ? alertPoint() : null;
  const at = me ? `&lat=${me.lat.toFixed(3)}&lon=${me.lon.toFixed(3)}` : "";
  const r = await fetch(`/api/alerts?scope=all&near=${S.settings.alertNear || 50}${at}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!r) return;
  const st = S.settings;
  // lightning nearby, storm approaching and rain soon each have their own switch (rain is off unless asked for)
  const wanted = a => !(a.type === "LTG" && st.alertLtg === false) && !(a.type === "ARR" && st.alertArr === false) && !(a.type === "RAIN" && !st.alertRain);
  ALERT.lastList = r.alerts.filter(wanted);
  const seen = alertSeen();
  let fresh = ALERT.lastList.filter(a => !seen[a.id] && (st.alertBom !== false || a.source !== "BoM")
    && (a.near !== false || mode === "all" || st.alertFar !== false));
  // quiet hours: lightning / approaching storm / rain only show a banner; warnings still sound
  if (typeof inQuietHours === "function" && inQuietHours()) {
    const minor = fresh.filter(a => ["LTG", "ARR", "RAIN"].includes(a.type));
    if (minor.length) { minor.forEach(a => markSeen(a.id)); alertBanner(minor[0], minor.length - 1); }
    fresh = fresh.filter(a => !minor.includes(a));
  }
  if (mode === "all") fresh.forEach(a => { a.near = true; });     // "every warning": all get the full alert
  if (!fresh.length) return;
  fireAlerts(fresh);                                    // the server lists near ones first, most severe first
}

function setupAlerts() {
  const st = S.settings;
  if (IN_APP) {
    // in the phone app, alerts come from its background service, set up on the app's start screen
    ["alertMode", "alertNear", "alertFar", "alertVoice", "alertBom", "alertLtg", "alertArr", "alertRain", "alertWhere"].forEach(id => { const l = $(id).closest("label"); if (l) l.hidden = true; });
    if (!$("alertAppNote")) $("alertTest").insertAdjacentHTML("beforebegin", `<p class="menu-note" id="alertAppNote">Phone alerts are set on the app's start screen: tap ⇄ at the top.</p>`);
  }
  $("alertMode").value = st.alerts || "near";
  $("alertNear").value = String(st.alertNear || 50);
  $("alertFar").checked = st.alertFar !== false;
  $("alertNear").onchange = e => { st.alertNear = +e.target.value; save(); };
  $("alertFar").onchange = e => { st.alertFar = e.target.checked; save(); };
  $("alertVoice").checked = st.alertVoice !== false;
  $("alertBom").checked = st.alertBom !== false;
  $("alertMode").onchange = e => { st.alerts = e.target.value; save(); };
  $("alertVoice").onchange = e => { st.alertVoice = e.target.checked; save(); };
  $("alertBom").onchange = e => { st.alertBom = e.target.checked; save(); };
  $("alertTest").onclick = () => {
    unlockAudio();
    if (window.Notification && Notification.permission === "default" && window.isSecureContext) Notification.requestPermission();
    fireAlert({ id: "test", source: "radarhound", type: "TOR", title: "Tornado warning", speech: `Tornado warning issued for ${S.cfg.home.name}, until ${fmtTime.format(new Date(Date.now() + 45 * 60e3))}.` }, true);
  };
  clearInterval(ALERT.timer);
  ALERT.timer = setInterval(checkAlerts, 30e3);
  setTimeout(checkAlerts, 3000);
}
