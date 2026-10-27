/* Radarhound background worker: PNG decode -> palette indices, storm cells and Doppler couplets,
   so the map never stalls while frames arrive. */
"use strict";
importScripts(`/static/algo.js?v=${new URLSearchParams(self.location.search).get("a") || 1}`);

let PAL = {};
let canvas = null, g = null;

onmessage = async e => {
  const m = e.data;
  try {
    if (m.op === "init") {
      PAL = {};
      for (const [t, list] of Object.entries(m.palettes)) PAL[t] = ALGO.makePalette(list);
      postMessage({ id: m.id, ok: true });
    } else if (m.op === "decode") {
      const bmp = await createImageBitmap(new Blob([m.buf], { type: "image/png" }));
      const N = bmp.width;
      if (!canvas || canvas.width !== N) { canvas = new OffscreenCanvas(N, N); g = canvas.getContext("2d", { willReadFrequently: true }); }
      g.clearRect(0, 0, N, N);
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const out = ALGO.decodePixels(g.getImageData(0, 0, N, N).data, N, PAL[m.type]);
      postMessage({ id: m.id, data: out }, [out.buffer]);
    } else if (m.op === "cells") {
      postMessage({ id: m.id, cells: ALGO.detectCells(m.data, m.kpp, m.thr, m.minKm2) });
    } else if (m.op === "couplets") {
      postMessage({ id: m.id, couplets: ALGO.couplets(m.data, m.kpp, m.refl, m.rkpp, m.southern) });
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err) });
  }
};
