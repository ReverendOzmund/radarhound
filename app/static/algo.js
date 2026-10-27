/* Radarhound: pure algorithms shared by the page and the background worker (no DOM, no globals). */
"use strict";

const ALGO = (() => {
  const C_TRANSPARENT = 255, C_BAR = 254, C_TEXT = 253;

  // RGBA pixels of a BoM frame -> palette index per pixel (same rules as the page used to apply)
  function decodePixels(d, N, pal) {
    const out = new Uint8Array(N * N);
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      if (d[i + 3] < 128) { out[p] = C_TRANSPARENT; continue; }
      const r = d[i], g = d[i + 1], b = d[i + 2], k = (r << 16) | (g << 8) | b;
      let v = pal.lookup.get(k);
      if (v === undefined) {
        v = pal.near.get(k);
        if (v === undefined) {
          if (k === 0xc0c0c0) v = C_BAR;
          else if (Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && r < 170) v = C_TEXT;
          else {
            let best = C_TRANSPARENT, bestD = 400;
            pal.source.forEach(([pr, pg, pb], idx) => { const dd = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2; if (dd < bestD) { bestD = dd; best = idx; } });
            v = best;
          }
          pal.near.set(k, v);
        }
      }
      out[p] = v;
    }
    return out;
  }

  function convexHull(flat) {
    const P = [];
    for (let i = 0; i < flat.length; i += 2) P.push([flat[i], flat[i + 1]]);
    if (P.length < 4) return P;
    P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    hi.pop(); lo.pop();
    return lo.concat(hi);
  }

  // connected cores at or above level `thr` (8-connected), in km from the image centre
  function detectCells(data, kpp, thr, minKm2) {
    const N = Math.round(Math.sqrt(data.length)), H = N / 2, seen = new Uint8Array(N * N), cells = [];
    const pxArea = kpp * kpp, stack = new Int32Array(N * N);
    for (let start = 0; start < N * N; start++) {
      const v0 = data[start];
      if (seen[start] || v0 >= 250 || v0 < thr) continue;
      let sp = 0, n = 0, sx = 0, sy = 0, sw = 0, max = 0;
      const pts = [];
      stack[sp++] = start; seen[start] = 1;
      while (sp) {
        const p = stack[--sp], x = p % N, y = (p - x) / N, v = data[p], w = v - thr + 1;
        n++; sx += x * w; sy += y * w; sw += w; if (v > max) max = v;
        pts.push(x, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const q = ny * N + nx;
          if (seen[q]) continue;
          const vq = data[q];
          if (vq >= 250 || vq < thr) continue;
          seen[q] = 1; stack[sp++] = q;
        }
      }
      const area = n * pxArea;
      if (area < Math.max(minKm2, 3 * pxArea)) continue;
      const cxp = sx / sw, cyp = sy / sw;
      cells.push({ x: (cxp - H) * kpp, y: (H - cyp) * kpp, area, max,
        hull: convexHull(pts).map(([px, py]) => [(px - H) * kpp, (H - py) * kpp]) });
    }
    return cells;
  }

  // cyclonic couplets on a BoM Doppler image, kept only inside >= ~42 dBZ echo
  function couplets(data, kpp, refl, rkpp, southern) {
    const N = Math.round(Math.sqrt(data.length)), H = N / 2;
    const RN = Math.round(Math.sqrt(refl.length)), RH = RN / 2;
    const reflAt = (x, y) => {
      let mx = -1;
      for (let dy = -3; dy <= 3; dy += 1.5) for (let dx = -3; dx <= 3; dx += 1.5) {
        const px = Math.floor(RH + (x + dx) / rkpp), py = Math.floor(RH - (y + dy) / rkpp);
        if (px < 0 || py < 0 || px >= RN || py >= RN) continue;
        const v = refl[py * RN + px];
        if (v < 250 && v > mx) mx = v;
      }
      return mx;
    };
    const vel = v => (v < 19 ? (v - 9) * 10 : null);            // index 9 = 0 km/h, 10 km/h steps
    const hits = [];
    for (let py = 2; py < N - 2; py++) for (let px = 2; px < N - 2; px++) {
      const x = (px - H) * kpp, y = (H - py) * kpp, r = Math.hypot(x, y);
      if (r < 8 || r > 110) continue;
      const tx = y / r, ty = -x / r;
      for (const s of [1.5, 3]) {
        const sp = s / 2 / kpp;
        const ax = Math.round(px - tx * sp), ay = Math.round(py + ty * sp), bx = Math.round(px + tx * sp), by = Math.round(py - ty * sp);
        if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= N || bx >= N || ay >= N || by >= N) continue;
        const va = vel(data[ay * N + ax]), vb = vel(data[by * N + bx]);
        if (va == null || vb == null) continue;
        const dv = southern ? va - vb : vb - va;
        if (dv >= 70 && Math.abs(va) >= 30 && Math.abs(vb) >= 30 && va * vb < 0) hits.push({ x, y, dv, diam: s });
      }
    }
    hits.sort((a, b) => b.dv - a.dv);
    const out = [];
    for (const h of hits) {
      const o = out.find(c => Math.hypot(c.x - h.x, c.y - h.y) < 4);
      if (o) o.n++; else out.push({ ...h, n: 1 });
    }
    // A real couplet is two broad patches of opposite flow: check the median velocity of a ~1 km patch on
    // each side. BoM images carry streaks of single top-of-scale pixels at echo edges that would otherwise
    // look like a huge shear (this caused a false tornado warning near Yanchep on 6 Oct 2026).
    const patchMedian = (cx, cy) => {
      const rad = Math.max(2, 1 / kpp), vals = [];
      let total = 0;
      for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++) for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
        if (dx * dx + dy * dy > rad * rad) continue;
        const px = Math.round(cx + dx), py = Math.round(cy + dy);
        if (px < 0 || py < 0 || px >= N || py >= N) continue;
        total++;
        const v = vel(data[py * N + px]);
        if (v != null) vals.push(v);
      }
      if (!total || vals.length < 0.6 * total) return null;
      vals.sort((a, b) => a - b);
      return vals[vals.length >> 1];
    };
    const confirmed = [];
    for (const c of out) {
      if (c.n < 3 || reflAt(c.x, c.y) < 7) continue;
      const px = H + c.x / kpp, py = H - c.y / kpp, r = Math.hypot(c.x, c.y), tx = c.y / r, ty = -c.x / r;
      let best = 0;
      for (const s of [1.5, 3]) {
        const sp = s / 2 / kpp;
        const va = patchMedian(px - tx * sp, py + ty * sp), vb = patchMedian(px + tx * sp, py - ty * sp);
        if (va == null || vb == null) continue;
        const dv = southern ? va - vb : vb - va;
        if (va * vb < 0 && Math.abs(va) >= 25 && Math.abs(vb) >= 25 && dv >= 60) best = Math.max(best, dv);
      }
      if (best) confirmed.push({ ...c, dv: best });
    }
    return confirmed.slice(0, 12);
  }

  function makePalette(rgbList) {
    const lookup = new Map();
    rgbList.forEach(([r, g, b], i) => lookup.set((r << 16) | (g << 8) | b, i));
    return { lookup, source: rgbList, near: new Map() };
  }

  return { decodePixels, detectCells, couplets, convexHull, makePalette, C_TRANSPARENT, C_BAR, C_TEXT };
})();
if (typeof self !== "undefined") self.ALGO = ALGO;
