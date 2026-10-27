/* Radarhound: GPU rendering of raw radar sweeps. The sweep is uploaded once as a texture (rays x gates);
   a fragment shader works out range and azimuth for every screen pixel and looks the colour up,
   so panning, zooming and playing raw loops no longer cost tens of milliseconds per pane.
   Falls back to the CPU renderer if WebGL isn't available. Uses globals from app.js. */
"use strict";

const GL = (() => {
  let cv = null, gl = null, prog = null, loc = {}, failed = false;
  const VS = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
  const FS = `
precision highp float;
uniform sampler2D uData, uLut, uCorr;
uniform vec2 uView, uSize;
uniform float uKpp, uGatesPerKm, uG0, uRaysPerRad, uNb, uNr, uU16, uSrv, uSmooth, uNodata, uUndetect,
  uGain, uOffset, uSrvMin, uSrvStep, uSrvN, uLutW, uLutH;
float rawAt(float ray, float gate) {
  vec4 t = texture2D(uData, vec2((gate + 0.5) / uNb, (ray + 0.5) / uNr));
  float lo = floor(t.r * 255.0 + 0.5);
  return uU16 > 0.5 ? lo + 256.0 * floor(t.a * 255.0 + 0.5) : lo;
}
bool bad(float q) { return q == uNodata || q == uUndetect; }
void main() {
  float x = uView.x + (gl_FragCoord.x - uSize.x * 0.5) * uKpp;
  float y = uView.y + (gl_FragCoord.y - uSize.y * 0.5) * uKpp;
  float gf = sqrt(x * x + y * y) * uGatesPerKm - uG0;
  float g = floor(gf);
  if (g < 0.0 || g >= uNb) discard;
  float a = atan(x, y); if (a < 0.0) a += 6.28318530718;
  float rf = a * uRaysPerRad;
  float r = floor(rf + 0.5); if (r >= uNr) r -= uNr;
  float raw = 0.0; bool ok = false;
  if (uSmooth > 0.5) {
    float gs = gf - 0.5, gi = floor(gs), ri = floor(rf);
    if (gi >= 0.0 && gi + 1.0 < uNb) {
      float ra = mod(ri, uNr), rb = mod(ri + 1.0, uNr), fg = gs - gi, fr = rf - ri;
      float q00 = rawAt(ra, gi), q01 = rawAt(ra, gi + 1.0), q10 = rawAt(rb, gi), q11 = rawAt(rb, gi + 1.0);
      if (!bad(q00) && !bad(q01) && !bad(q10) && !bad(q11)) { raw = mix(mix(q00, q01, fg), mix(q10, q11, fg), fr); ok = true; }
    }
  }
  if (!ok) { raw = rawAt(r, g); if (bad(raw)) discard; }
  vec4 c;
  if (uSrv > 0.5) {
    float corr = (texture2D(uCorr, vec2((r + 0.5) / uNr, 0.5)).r * 255.0 - 128.0) * 0.5;
    float i = clamp(floor((raw * uGain + uOffset - corr - uSrvMin) / uSrvStep + 0.5), 0.0, uSrvN - 1.0);
    c = texture2D(uLut, vec2((i + 0.5) / uSrvN, 0.5));
  } else {
    float q = floor(raw + 0.5);
    c = texture2D(uLut, vec2((mod(q, uLutW) + 0.5) / uLutW, (floor(q / uLutW) + 0.5) / uLutH));
  }
  if (c.a < 0.01) discard;
  gl_FragColor = c;
}`;

  function init() {
    if (gl || failed) return !!gl;
    try {
      cv = document.createElement("canvas");
      gl = cv.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
      if (!gl) throw new Error("no webgl");
      // phones drop the GPU context when the app is backgrounded: forget everything and rebuild on next use
      cv.addEventListener("webglcontextlost", ev => {
        ev.preventDefault();
        gl = null; prog = null; loc = {}; cv = null;
        mprog = null; mloc = {}; lutTex.clear(); idxTex.clear();
      });
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const pl = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
      for (const n of ["uData", "uLut", "uCorr", "uView", "uSize", "uKpp", "uGatesPerKm", "uG0", "uRaysPerRad", "uNb", "uNr", "uU16", "uSrv",
        "uSmooth", "uNodata", "uUndetect", "uGain", "uOffset", "uSrvMin", "uSrvStep", "uSrvN", "uLutW", "uLutH"]) loc[n] = gl.getUniformLocation(prog, n);
      gl.uniform1i(loc.uData, 0); gl.uniform1i(loc.uLut, 1); gl.uniform1i(loc.uCorr, 2);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      return true;
    } catch (e) {
      console.warn("Radarhound: WebGL unavailable, using CPU rendering", e);
      failed = true; gl = null;
      return false;
    }
  }

  function tex(w, h, fmt, bytes) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, bytes);
    return t;
  }
  const lutTex = new Map();
  function lutTexture(key, u32, w, h) {
    let t = lutTex.get(key);
    if (!t) {
      t = tex(w, h, gl.RGBA, new Uint8Array(u32.buffer, u32.byteOffset, w * h * 4));
      lutTex.set(key, t);
      if (lutTex.size > 40) { const [k0, t0] = lutTex.entries().next().value; gl.deleteTexture(t0); lutTex.delete(k0); }
    }
    return t;
  }

  // render one sweep for the current pane view; returns the GL canvas or null (caller falls back to CPU)
  function renderSweep(sw, W, H) {
    if (!init()) return null;
    const maxT = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (sw.nbins > maxT || sw.nrays > maxT) return null;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.useProgram(prog);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const u16 = sw.dtype === "uint16";
    if (!sw.glTex || sw.glCtx !== gl) {
      const bytes = u16 ? new Uint8Array(sw.data.buffer, sw.data.byteOffset, sw.data.byteLength) : sw.data;
      sw.glTex = tex(sw.nbins, sw.nrays, u16 ? gl.LUMINANCE_ALPHA : gl.LUMINANCE, bytes);
      sw.glCtx = gl;
    }
    const srv = sw.moment === "SRV";
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sw.glTex);
    gl.activeTexture(gl.TEXTURE1);
    if (srv) {
      const L = srvLut();
      gl.bindTexture(gl.TEXTURE_2D, lutTexture(`srv|${L.length}`, L, L.length, 1));
      const corr = rayCorrection(sw), cb = new Uint8Array(sw.nrays);
      for (let i = 0; i < sw.nrays; i++) cb[i] = Math.max(0, Math.min(255, Math.round(corr[i] * 2 + 128)));
      gl.activeTexture(gl.TEXTURE2);
      if (sw.glCorrKey !== `${S.settings.motion.dir}/${S.settings.motion.spd}`) {
        if (sw.glCorr) gl.deleteTexture(sw.glCorr);
        sw.glCorr = tex(sw.nrays, 1, gl.LUMINANCE, cb); sw.glCorrKey = `${S.settings.motion.dir}/${S.settings.motion.spd}`;
      }
      gl.bindTexture(gl.TEXTURE_2D, sw.glCorr);
      gl.uniform1f(loc.uSrvMin, SRV_MIN); gl.uniform1f(loc.uSrvStep, SRV_STEP); gl.uniform1f(loc.uSrvN, L.length);
    } else {
      const L = rawLut(sw), w = 256, h = L.length / 256;
      const M = MOMENTS[sw.moment];
      gl.bindTexture(gl.TEXTURE_2D, lutTexture(`${sw.moment}|${sw.gain}|${sw.offset}|${sw.dtype}|${M && M.ref ? S.settings.refMin : ""}|${M && M.sc ? M.sc.stops?.length : 0}`, L, w, h));
      gl.uniform1f(loc.uLutW, w); gl.uniform1f(loc.uLutH, h);
    }
    const cosE = Math.cos(sw.elev * Math.PI / 180);
    gl.uniform2f(loc.uView, S.view.cx, S.view.cy);
    gl.uniform2f(loc.uSize, W, H);
    gl.uniform1f(loc.uKpp, 1 / S.view.scale);
    gl.uniform1f(loc.uGatesPerKm, 1000 / sw.rscale / cosE);
    gl.uniform1f(loc.uG0, sw.rstart * 1000 / sw.rscale);
    gl.uniform1f(loc.uRaysPerRad, sw.nrays / (2 * Math.PI));
    gl.uniform1f(loc.uNb, sw.nbins); gl.uniform1f(loc.uNr, sw.nrays);
    gl.uniform1f(loc.uU16, u16 ? 1 : 0); gl.uniform1f(loc.uSrv, srv ? 1 : 0);
    gl.uniform1f(loc.uSmooth, S.settings.smooth && !MOMENTS[sw.moment]?.cat ? 1 : 0);
    gl.uniform1f(loc.uNodata, sw.nodata); gl.uniform1f(loc.uUndetect, sw.undetect);
    gl.uniform1f(loc.uGain, sw.gain); gl.uniform1f(loc.uOffset, sw.offset);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return cv;
  }
  // ---------------------------------------------------------------- seamless mosaic of live radar frames
  // Each radar's image is in its own flat projection. The shader converts every screen pixel of the
  // national map to latitude/longitude and then into that radar's image, so neighbouring radars line up
  // exactly (just shifting images by their centres would misalign them by up to ~20 km in the east).
  // With EXT_frag_depth the nearest radar wins where coverage overlaps.
  let mprog = null, mloc = {}, mdepth = false;
  const idxTex = new Map();
  function mosaicProgram() {
    if (mprog) return mprog;
    mdepth = !!gl.getExtension("EXT_frag_depth");
    const fs = (mdepth ? "#extension GL_EXT_frag_depth : enable\n" : "") + `
precision highp float;
uniform sampler2D uIdx, uLut;
uniform vec2 uView, uSize;
uniform float uKpp, uLat0, uLon0, uRLat, uRLon, uRKpp, uN, uRange, uDepth, uBias;
void main() {
  float x = uView.x + (gl_FragCoord.x - uSize.x * 0.5) * uKpp;
  float y = uView.y + (gl_FragCoord.y - uSize.y * 0.5) * uKpp;
  float lat = uLat0 + y / 111.11;
  float lon = uLon0 + x / (111.11 * cos(radians(lat)));
  float xr = (lon - uRLon) * 111.11 * cos(radians(lat));
  float yr = (lat - uRLat) * 111.11;
  float d = sqrt(xr * xr + yr * yr);
  if (d > uRange) discard;
  float px = floor(uN * 0.5 + xr / uRKpp), py = floor(uN * 0.5 - yr / uRKpp);
  if (px < 0.0 || py < 0.0 || px >= uN || py >= uN) discard;
  float v = floor(texture2D(uIdx, vec2((px + 0.5) / uN, (py + 0.5) / uN)).r * 255.0 + 0.5);
  vec4 c = texture2D(uLut, vec2((v + 0.5) / 256.0, 0.5));
  if (c.a < 0.002) discard;                          // caption / copyright pixels: no data
  ${mdepth ? `if (c.a < 0.01) c = vec4(0.0);             // "no echo" from a nearer radar hides coarser data behind it
  gl_FragColor = c;
  gl_FragDepthEXT = uDepth > 0.0 ? uDepth : d / 1000.0 + uBias;` : `if (c.a < 0.01) discard;
  gl_FragColor = c;`}
}`;
    const sh = (type, src) => { const q = gl.createShader(type); gl.shaderSource(q, src); gl.compileShader(q);
      if (!gl.getShaderParameter(q, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(q)); return q; };
    mprog = gl.createProgram();
    gl.attachShader(mprog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(mprog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(mprog);
    if (!gl.getProgramParameter(mprog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(mprog));
    for (const n of ["uIdx", "uLut", "uView", "uSize", "uKpp", "uLat0", "uLon0", "uRLat", "uRLon", "uRKpp", "uN", "uRange", "uDepth", "uBias"]) mloc[n] = gl.getUniformLocation(mprog, n);
    return mprog;
  }
  // layers: [{key, data (palette indices, N x N), lat, lon, km, lut (Uint32Array 256)}], view origin lat0/lon0
  function renderMosaic(layers, W, H, lat0, lon0) {
    if (!init()) return null;
    try { mosaicProgram(); } catch (e) { console.warn("Radarhound: mosaic shader failed", e); return null; }
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.useProgram(mprog);
    const pl = gl.getAttribLocation(mprog, "p"); gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (mdepth) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); }
    gl.uniform1i(mloc.uIdx, 0); gl.uniform1i(mloc.uLut, 1);
    gl.uniform2f(mloc.uView, S.view.cx, S.view.cy); gl.uniform2f(mloc.uSize, W, H);
    gl.uniform1f(mloc.uKpp, 1 / S.view.scale); gl.uniform1f(mloc.uLat0, lat0); gl.uniform1f(mloc.uLon0, lon0);
    for (const L of layers) {
      const N = Math.round(Math.sqrt(L.data.length));
      let t = idxTex.get(L.key);
      if (!t) {
        t = tex(N, N, gl.LUMINANCE, L.data);
        idxTex.set(L.key, t);
        if (idxTex.size > 150) { const [k0, t0] = idxTex.entries().next().value; gl.deleteTexture(t0); idxTex.delete(k0); }
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutTexture(L.lutKey, L.lut, 256, 1));
      gl.uniform1f(mloc.uRLat, L.lat); gl.uniform1f(mloc.uRLon, L.lon);
      gl.uniform1f(mloc.uRKpp, L.km / (N / 2)); gl.uniform1f(mloc.uN, N);
      gl.uniform1f(mloc.uRange, L.base ? 1e6 : L.km); gl.uniform1f(mloc.uDepth, L.base ? 0.999 : 0);
      gl.uniform1f(mloc.uBias, L.bias || 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    const p0 = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(p0); gl.vertexAttribPointer(p0, 2, gl.FLOAT, false, 0, 0);
    return cv;
  }

  // a "GPU" that is really software emulation can be slower than the CPU path: switch over if so
  const times = [];
  const api = { slow: false };
  function timed(ms) {
    times.push(ms);
    if (times.length >= 6) {
      const m = [...times].sort((a, b) => a - b)[3];
      if (m > 30) { api.slow = true; console.info(`Radarhound: GPU rendering is slow here (${m.toFixed(0)} ms), using the CPU`); }
      times.length = 0;
    }
  }
  return Object.assign(api, { renderSweep, renderMosaic, depthMosaic: () => init() && (mosaicProgram(), mdepth), timed, available: () => init(), clearLuts: () => { if (gl) { for (const t of lutTex.values()) gl.deleteTexture(t); lutTex.clear(); } } });
})();
