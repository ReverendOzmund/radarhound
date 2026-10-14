// Radar picker: replaces the long site dropdown with a searchable list (nearest first, then by state).
// The original <select id="radarSel"> stays (hidden) as the source of truth: picking a radar here sets
// its value and fires its change handler, so everything else in app.js keeps working unchanged.
(function () {
  const STATE_ORDER = ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"];
  const STATE_NAME = { NSW: "New South Wales", ACT: "Australian Capital Territory", VIC: "Victoria", QLD: "Queensland",
    SA: "South Australia", WA: "Western Australia", TAS: "Tasmania", NT: "Northern Territory" };
  const app = () => (typeof S !== "undefined" ? S : null);     // app.js's state (a script-level const, not on window)
  const sel = document.getElementById("radarSel");
  if (!sel) return;
  sel.classList.add("sr-only");
  sel.tabIndex = -1;

  const btn = document.createElement("button");
  btn.id = "radarBtn"; btn.className = "radar-btn"; btn.type = "button";
  btn.setAttribute("aria-haspopup", "dialog"); btn.setAttribute("aria-expanded", "false");
  btn.title = "Choose a radar (R)";
  btn.innerHTML = `<span class="rb-dot"></span><span class="rb-text"><span class="rb-name">Radar</span><span class="rb-sub"></span></span><span class="rb-caret" aria-hidden="true">▾</span>`;
  sel.after(btn);

  const pop = document.createElement("div");
  pop.id = "radarPop"; pop.className = "radar-pop"; pop.hidden = true;
  pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Choose a radar");
  pop.innerHTML = `<div class="rp-head"><input id="radarFind" type="search" placeholder="Search radars, places or states" autocomplete="off" spellcheck="false" aria-label="Search radars"></div>
    <div class="rp-list" id="radarList" role="listbox"></div>
    <div class="rp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span class="rp-legend"><i class="d live"></i>live <i class="d wait"></i>loading <i class="d off"></i>starts when picked</span></div>`;
  document.body.appendChild(pop);
  const find = pop.querySelector("#radarFind"), list = pop.querySelector("#radarList");
  let rows = [], cur = -1;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function km(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  }
  const fmtKm = d => d == null ? "" : d < 10 ? "<10 km" : `${Math.round(d / (d < 100 ? 1 : 10)) * (d < 100 ? 1 : 10)} km`;

  function status(r) {
    if (!r.products) return "off";
    if (r.products.some(p => p.available)) return "live";
    return "wait";
  }
  function statusText(r) {
    const s = status(r);
    if (s === "live") return "Live";
    if (s === "off") return "Not followed yet: picking it starts downloading";
    const errs = (r.products || []).map(p => p.error).filter(Boolean);
    return errs.length ? `No frames: ${errs[0]}` : "Loading the first frames";
  }

  function all() {
    const st = app(), cfg = st && st.cfg;
    if (!cfg) return { home: null, groups: [] };
    const home = cfg.home;
    const followed = cfg.radars.map(r => ({ ...r, kind: r.national ? "national" : r.auto ? "auto" : "mine" }));
    const others = (cfg.all_radars || []).map(r => ({ ...r, kind: "other" }));
    for (const r of followed.concat(others)) r.dist = r.national ? null : km(home, r);
    return { home, followed, others };
  }

  function build(q) {
    const { home, followed, others } = all();
    if (!followed) return [];
    const out = [];
    q = (q || "").trim().toLowerCase();
    if (q) {
      // name matches first (start of a word beats anywhere), then radar id, then state; nearest first within each
      const rank = r => {
        const n = r.name.toLowerCase();
        if (n.startsWith(q) || n.split(/[\s(]+/).some(w => w.startsWith(q))) return 0;
        if (n.includes(q)) return 1;
        if (`idr${r.id}`.startsWith(q) || r.id === q) return 2;
        if ([r.state, STATE_NAME[r.state]].some(x => x && x.toLowerCase().includes(q))) return 3;
        return -1;
      };
      const res = followed.concat(others).map(r => [rank(r), r]).filter(([k]) => k >= 0)
        .sort((a, b) => a[0] - b[0] || (a[1].dist ?? -1) - (b[1].dist ?? -1)).map(([, r]) => r);
      out.push({ head: res.length ? `${res.length} match${res.length === 1 ? "" : "es"}` : "No radar matches" });
      res.forEach(r => out.push({ r }));
      return out;
    }
    const mine = followed.filter(r => r.kind === "mine").sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    const nat = followed.filter(r => r.kind === "national");
    out.push({ head: "Your radars" });
    nat.concat(mine).forEach(r => out.push({ r }));
    const auto = followed.filter(r => r.kind === "auto");
    if (auto.length) { out.push({ head: "Following for storms", note: "picked up automatically, for a few hours" }); auto.forEach(r => out.push({ r })); }
    const near = others.filter(r => r.dist != null).sort((a, b) => a.dist - b.dist).slice(0, 4);
    if (near.length) { out.push({ head: `Nearest to ${home && home.name ? home.name : "home"}` }); near.forEach(r => out.push({ r })); }
    const homeState = (mine[0] && mine[0].state) || (near[0] && near[0].state);
    const order = homeState ? [homeState, ...STATE_ORDER.filter(s => s !== homeState)] : STATE_ORDER;
    for (const st of order) {
      const rs = others.filter(r => r.state === st && !near.includes(r)).sort((a, b) => a.name.localeCompare(b.name));
      if (!rs.length) continue;
      out.push({ head: STATE_NAME[st] || st });
      rs.forEach(r => out.push({ r }));
    }
    return out;
  }

  function render() {
    const items = build(find.value);
    const st = app(), curId = st && st.radar ? st.radar.id : null;
    rows = [];
    list.innerHTML = items.map(it => {
      if (it.head) return `<div class="rp-head-row">${esc(it.head)}${it.tag ? ` <span class="rp-st">${esc(it.tag)}</span>` : ""}${it.note ? ` <span class="rp-note">${esc(it.note)}</span>` : ""}</div>`;
      const r = it.r, i = rows.push(r) - 1, st = status(r);
      const meta = r.national ? "Every BoM radar stitched together" :
        [r.state, fmtKm(r.dist) && `${fmtKm(r.dist)} from home`].filter(Boolean).join(" · ");
      return `<button type="button" class="rp-row${r.id === curId ? " on" : ""}" role="option" data-i="${i}" aria-selected="${r.id === curId}" title="${esc(statusText(r))}">
        <i class="d ${st}"></i><span class="rp-name">${esc(r.name)}</span><span class="rp-meta">${esc(meta)}</span>${r.national ? "" : `<span class="rp-id">IDR${esc(r.id)}</span>`}</button>`;
    }).join("");
    cur = rows.findIndex(r => r.id === curId);
    if (find.value || cur < 0) cur = rows.length ? 0 : -1;
    mark();
  }
  function mark() {
    list.querySelectorAll(".rp-row").forEach(b => b.classList.toggle("kb", +b.dataset.i === cur));
    const b = list.querySelector(`.rp-row[data-i="${cur}"]`);
    if (b) b.scrollIntoView({ block: "nearest" });
  }
  function choose(r) {
    close();
    const st = app();
    if (!r || (st && st.radar && st.radar.id === r.id)) return;
    if (![...sel.options].some(o => o.value === r.id)) {
      const o = document.createElement("option"); o.value = r.id; o.textContent = r.name; sel.appendChild(o);
    }
    sel.value = r.id;
    sel.dispatchEvent(new Event("change"));
    sync();
  }
  function place() {
    const b = btn.getBoundingClientRect();
    if (innerWidth < 640) { pop.style.left = "8px"; pop.style.right = "8px"; pop.style.width = "auto"; }
    else { pop.style.left = `${Math.max(8, b.left)}px`; pop.style.right = "auto"; pop.style.width = "420px"; }
    pop.style.top = `${b.bottom + 6}px`;
    pop.style.maxHeight = `${Math.max(240, innerHeight - b.bottom - 20)}px`;
  }
  function open() {
    const st = app();
    if (!st || !st.cfg) return;
    find.value = ""; render(); place();
    pop.hidden = false; btn.setAttribute("aria-expanded", "true");
    setTimeout(() => find.focus(), 0);
  }
  function close() {
    if (pop.hidden) return;
    pop.hidden = true; btn.setAttribute("aria-expanded", "false");
  }

  btn.addEventListener("click", () => pop.hidden ? open() : close());
  find.addEventListener("input", render);
  find.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { cur = Math.min(rows.length - 1, cur + 1); mark(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cur = Math.max(0, cur - 1); mark(); e.preventDefault(); }
    else if (e.key === "Enter") { choose(rows[cur]); e.preventDefault(); }
    else if (e.key === "Escape") { close(); btn.focus(); e.preventDefault(); }
  });
  list.addEventListener("click", e => { const b = e.target.closest(".rp-row"); if (b) choose(rows[+b.dataset.i]); });
  document.addEventListener("pointerdown", e => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(); });
  addEventListener("resize", () => { if (!pop.hidden) place(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "r" && e.key !== "R") return;
    if (e.ctrlKey || e.metaKey || e.altKey || (app() && app().mode === "raw")) return;   // raw volume uses R for reflectivity
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    pop.hidden ? open() : close();
  }, true);

  function sync() {
    const st = app(), r = st && st.radar;
    if (!r) return;
    const { home } = all();
    btn.querySelector(".rb-name").textContent = r.name || `Radar ${r.id}`;
    const d = r.national ? null : km(home, r);
    btn.querySelector(".rb-sub").textContent = r.national ? "All BoM radars" : [r.state, d != null ? `${fmtKm(d)} from home` : ""].filter(Boolean).join(" · ");
    const full = (st.cfg && st.cfg.radars.find(x => x.id === r.id)) || r;
    btn.querySelector(".rb-dot").className = `rb-dot d ${status(full)}`;
    btn.querySelector(".rb-dot").title = statusText(full);
  }
  window.radarPickerSync = sync;
  setInterval(sync, 3000);
})();
