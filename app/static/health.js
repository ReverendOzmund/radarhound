// Feed health in the header: one dot that says whether radar, warnings and lightning are fresh, with
// a click-through list. Hidden where the server doesn't have /api/health (phone mode).
(function () {
  const clock = document.getElementById("clock");
  if (!clock) return;
  const pill = document.createElement("button");
  pill.id = "healthPill"; pill.type = "button"; pill.className = "health"; pill.hidden = true;
  pill.setAttribute("aria-haspopup", "dialog"); pill.setAttribute("aria-expanded", "false");
  pill.innerHTML = `<i class="d"></i><span class="h-txt">Feeds</span>`;
  (document.querySelector(".top .get-app") || clock).before(pill);
  const pop = document.createElement("div");
  pop.className = "health-pop"; pop.hidden = true; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Data feeds");
  document.body.appendChild(pop);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const DOT = { ok: "live", warn: "wait", down: "bad" };
  const WORD = { ok: "Live", warn: "Delayed", down: "Problem" };
  let last = null, timer = null;

  async function poll() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (r.status === 404) { pill.hidden = true; clearInterval(timer); return; }
      if (!r.ok) throw new Error(r.status);
      last = await r.json();
    } catch {
      last = { level: "down", checks: [{ name: "Server", level: "down", detail: "Radarhound's server isn't answering" }] };
    }
    pill.hidden = false;
    pill.dataset.level = last.level;
    pill.querySelector(".d").className = `d ${DOT[last.level] || "off"}`;
    pill.querySelector(".h-txt").textContent = WORD[last.level] || "Feeds";
    const bad = last.checks.filter(c => c.level !== "ok");
    pill.title = bad.length ? bad.map(c => `${c.name}: ${c.detail}`).join("\n") : "All feeds are fresh";
    if (!pop.hidden) render();
  }
  function render() {
    if (!last) return;
    pop.innerHTML = `<div class="hp-head">Data feeds${last.source ? ` <span>BoM via ${esc(last.source)}</span>` : ""}</div>` +
      last.checks.map(c => `<div class="hp-row"><i class="d ${DOT[c.level]}"></i><div><b>${esc(c.name)}</b><small>${esc(c.detail)}</small></div></div>`).join("") +
      `<div class="hp-foot">Checked every minute. Radar frames older than 15 minutes show as delayed.</div>`;
  }
  function place() {
    const b = pill.getBoundingClientRect();
    pop.style.top = `${b.bottom + 6}px`;
    pop.style.right = `${Math.max(8, innerWidth - b.right)}px`;
  }
  pill.addEventListener("click", () => {
    if (pop.hidden) { render(); place(); pop.hidden = false; pill.setAttribute("aria-expanded", "true"); }
    else { pop.hidden = true; pill.setAttribute("aria-expanded", "false"); }
  });
  document.addEventListener("pointerdown", e => {
    if (!pop.hidden && !pop.contains(e.target) && !pill.contains(e.target)) { pop.hidden = true; pill.setAttribute("aria-expanded", "false"); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !pop.hidden) { pop.hidden = true; pill.focus(); } });
  poll();
  timer = setInterval(poll, 60e3);
})();
