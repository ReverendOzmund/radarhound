// One line-icon set for the toolbar instead of emoji (which look different on every device and OS).
// Other scripts set chip labels like "◧ Modes" or "⚠ 2 warnings"; a small observer swaps the leading
// glyph for the matching icon whenever a label changes, so none of that code needs to know about icons.
(function () {
  const P = {
    modes: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    find: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    bolt: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z"/>',
    ruler: '<path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="m7 13 1.8 1.8M10 10l1.8 1.8M13 7l1.8 1.8"/>',
    cells: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    me: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7.5"/>',
    section: '<path d="M4 19 20 5"/><path d="M4 9v10h16"/><path d="M8 15v4M12 12v7M16 10v9" opacity=".55"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".9" fill="currentColor"/>',
    warn: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".9" fill="currentColor"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  };
  const svg = n => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;
  const GLYPH = /^[\s◧⚡\u{1F50E}\u{1F4CF}⛈◎✂ⓘ⚠⚑️]+/u;
  const CHIPS = { modesChip: "modes", findChip: "find", ltgChip: "bolt", rulerChip: "ruler", cellsChip: "cells",
    meChip: "me", xsChip: "section", explainChip: "info", warnChip: "warn", wxwChip: "flag" };

  function dress(el, icon) {
    const text = el.textContent.replace(GLYPH, "").trim();
    if (el.dataset.icoText === text && el.querySelector(".ico")) return;
    el.dataset.icoText = text;
    obs.disconnect();
    el.innerHTML = `${svg(icon)}<span class="ico-label">${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span>`;
    watch();
  }
  const els = Object.entries(CHIPS).map(([id, icon]) => [document.getElementById(id), icon]).filter(([el]) => el);
  const obs = new MutationObserver(() => els.forEach(([el, icon]) => dress(el, icon)));
  const watch = () => els.forEach(([el]) => obs.observe(el, { childList: true, characterData: true, subtree: true }));
  els.forEach(([el, icon]) => dress(el, icon));
  watch();
})();
