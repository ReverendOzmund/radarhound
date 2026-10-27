"""Radarhound's own automated warnings, modelled on the US National Weather Service.

BoM issues severe thunderstorm warnings, but not radar-indicated tornado warnings, storm-based polygons
for every strong cell, or impact-based detail. This engine runs after every radar poll and issues:

  Radar-indicated (live, from BoM's 128 km reflectivity + Doppler wind frames, or the national mosaic):
    TOR  Tornado warning           cyclonic Doppler couplet with dV >= 100 km/h inside a >= 50 dBZ core
    SVR  Severe thunderstorm       core >= ~56 dBZ, or >= ~50 dBZ with a couplet or frequent lightning
    FFW  Flash flood warning       near-stationary core >= ~50 dBZ for 30+ minutes
  Forecast watches (next 12 h, from the model grid, refreshed every 6 h):
    TOA  Tornado watch             STP >= 1
    SVA  Severe thunderstorm watch SCP >= 2 with CAPE
    WND  Damaging wind watch       gusts >= 90 km/h
    HEA  Extreme heat watch        temperature >= 40 C
    FWA  Fire weather watch        McArthur FFDI >= 50 (drought factor assumed 10)

Warnings are storm-based polygons: the cell outline plus where it is projected to be in 45 minutes,
widened by 5 km, NWS style. They are re-evaluated every cycle, extended while criteria hold, and
cancelled when they don't. These are automated and unofficial; BoM warnings always take precedence.
"""
import io
import json
import math
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

REFL = ["#f5f5ff", "#b4b4ff", "#7878ff", "#1414ff", "#00d8c3", "#009690", "#006666", "#ffff00", "#ffc800",
        "#ff9600", "#ff6400", "#ff0000", "#c80000", "#780000", "#280000"]
DOPP = ["#000066", "#111e78", "#20398a", "#2d509a", "#3b6bac", "#4a85be", "#59a0d0", "#66b7e0", "#75d2f2", "#ffffff",
        "#ffea00", "#ffcc00", "#ffb600", "#ff9900", "#ff7e00", "#ff6600", "#ff4900", "#ff3300", "#ff0000"]
REFL_RATE = [0.2, 0.5, 1.5, 2.5, 4, 6, 10, 15, 20, 35, 50, 80, 120, 200, 360]
DBZ = [10 * math.log10(200 * r ** 1.6) for r in REFL_RATE]
FRAME_T = re.compile(r"\.T\.(\d{12})\.png$")
LEAD_MIN = 45

_pal = {k: np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in v], np.int32) for k, v in (("r", REFL), ("d", DOPP))}
state = {"active": {}, "recent": [], "tracks": {}, "watches": [], "watch_time": 0, "last_run": None,
         "storms": {}, "env": None, "radar_sites": {}}


# ---------------------------------------------------------------- storm threat assessment
def env_at(lat, lon):
    """Model storm environment (SCP, STP, shear, helicity, cloud base, mean wind) at a point, for now.
    Uses a fine local grid around active storms when there is one, else the regional grid."""
    for E in state.get("env_local", []):
        r = _env_from(E, lat, lon)
        if r:
            return r
    E = state.get("env")
    return _env_from(E, lat, lon) if E else None


def _env_from(E, lat, lon):
    D = E["svr"]
    n, half = D["n"], D["half"]
    step = 2 * half / (n - 1)
    x = (lon - E["lon0"]) * 111.11 * math.cos(math.radians(lat))
    y = (lat - E["lat0"]) * 111.11
    i, j = round((x + half) / step), round((half - y) / step)
    if not (0 <= i < n and 0 <= j < n):
        return None
    now = time.time()
    t = min(range(len(D["time"])), key=lambda k: abs(D["time"][k] - now))
    out = {}
    for k in ("scp", "stp", "shear6", "srh1", "srh3", "lcl", "cape", "cin", "mu", "mv"):
        if k in D["vars"]:
            out[k] = D["vars"][k][t][j * n + i]
    return out if out.get("scp") is not None else None


def nearest_radar(lat, lon, max_km=250):
    best = None
    for rid, (la, lo, name) in state["radar_sites"].items():
        d = math.hypot((la - lat) * 111.11, (lo - lon) * 111.11 * math.cos(math.radians(lat)))
        if d <= max_km and (best is None or d < best[1]):
            best = (rid, d, name)
    return {"id": best[0], "km": round(best[1]), "name": best[2]} if best else None


def assess(c, mx_dbz, ltg, dv, has_doppler, env, southern):
    """Plain-language supercell and tornado ratings for one storm, with the reasons behind them."""
    sup = tor = 0
    why = []
    if env:
        scp, stp, sh = env.get("scp") or 0, env.get("stp") or 0, env.get("shear6") or 0
        if scp >= 4:
            sup += 2; why.append(f"SCP {scp:.1f} at the storm: environment strongly supports supercells")
        elif scp >= 1:
            sup += 1; why.append(f"SCP {scp:.1f} at the storm: environment supports supercells")
        else:
            why.append(f"SCP {scp:.1f}: environment marginal for supercells")
        if sh >= 35:
            sup += 1; why.append(f"0\u20136 km shear {sh:.0f} kt (enough for rotating updrafts)")
        elif sh < 25:
            sup -= 1; why.append(f"0\u20136 km shear only {sh:.0f} kt")
        if stp >= 1:
            tor += 2; why.append(f"STP {stp:.1f}: tornado ingredients present")
        elif stp >= 0.5:
            tor += 1; why.append(f"STP {stp:.1f}: weak tornado ingredients")
        else:
            why.append(f"STP {stp:.1f}: tornado ingredients weak")
        if (env.get("srh1") or 0) >= 150:
            tor += 1; why.append(f"strong low-level spin (0\u20131 km helicity {env['srh1']:.0f})")
        if env.get("lcl") is not None and env["lcl"] < 1000:
            tor += 1; why.append(f"low cloud base ({env['lcl']:.0f} m)")
    else:
        why.append("no model environment for this spot yet")
    if mx_dbz >= 55 and c.get("area50", 0) >= 50:
        sup += 1; why.append(f"large intense core ({c['area50']:.0f} km\u00b2 above 50 dBZ)")
    if c.get("age", 1) >= 6:
        sup += 1; why.append("long-lived (30+ minutes)")
    vx, vy = c.get("vx"), c.get("vy")
    if env and vx is not None and c.get("age", 1) >= 3 and env.get("mu") is not None and math.hypot(vx, vy) >= 10:
        mu, mv = env["mu"], env["mv"]
        ang = math.degrees(math.atan2(mu * vy - mv * vx, mu * vx + mv * vy))   # + = storm moves left of the mean wind
        if (ang >= 20 and southern) or (ang <= -20 and not southern):
            sup += 2; why.append(f"moving {abs(ang):.0f}\u00b0 {'left' if southern else 'right'} of the mean wind (classic supercell motion)")
    if has_doppler:
        if dv >= 100:
            sup += 3; tor += 3; why.append(f"strong rotation on Doppler (\u0394V {dv:.0f} km/h)")
        elif dv >= 70:
            sup += 2; tor += 2; why.append(f"rotation on Doppler (\u0394V {dv:.0f} km/h)")
        else:
            why.append("no rotation seen on Doppler")
    else:
        why.append("rotation unknown: no Doppler on this storm yet")
    if ltg >= 15:
        sup += 1
    rate = lambda v: "high" if v >= 5 else "moderate" if v >= 3 else "low"
    return {"supercell": rate(sup), "tornado": rate(tor), "reasons": why, "doppler": has_doppler,
            "env": {k: env.get(k) for k in ("scp", "stp", "shear6", "srh1", "lcl", "cape")} if env else None}


def levels(png: bytes, pal="r") -> np.ndarray:
    """Palette image -> class index per pixel (0 = none, 1..n)."""
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA")).astype(np.int32)
    key = np.where(a[..., 3] >= 128, (a[..., 0] << 16) | (a[..., 1] << 8) | a[..., 2], -1)
    uniq, inv = np.unique(key, return_inverse=True)
    lut = np.zeros(len(uniq), np.uint8)
    P = _pal[pal]
    for i, k in enumerate(uniq):
        if k < 0:
            continue
        rgb = np.array([(k >> 16) & 255, (k >> 8) & 255, k & 255])
        d2 = ((P - rgb) ** 2).sum(1)
        j = int(d2.argmin())
        lut[i] = j + 1 if d2[j] <= 400 else 0
    return lut[inv].reshape(key.shape)


def hull(points):
    pts = sorted(set(map(tuple, points)))
    if len(pts) < 3:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def cells_from(lv: np.ndarray, kpp: float, thr=7, min_km2=10.0):
    """Cores at or above level `thr` (~42 dBZ) as connected areas, in km relative to the image centre."""
    N = lv.shape[0]
    lab, n = ndimage.label(lv >= thr, structure=np.ones((3, 3)))
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        m = lab[sl] == i
        area = m.sum() * kpp * kpp
        if area < max(min_km2, 3 * kpp * kpp):
            continue
        ys, xs = np.nonzero(m)
        ys = ys + sl[0].start; xs = xs + sl[1].start
        w = lv[ys, xs].astype(np.float32) - thr + 1
        cx, cy = (xs * w).sum() / w.sum(), (ys * w).sum() / w.sum()
        edge = [((x - N / 2) * kpp, (N / 2 - y) * kpp) for x, y in zip(xs, ys)]
        vals = lv[ys, xs]
        out.append({"x": (cx - N / 2) * kpp, "y": (N / 2 - cy) * kpp, "area": float(area), "max": int(vals.max()),
                    "area50": float((vals >= 11).sum() * kpp * kpp),
                    "hull": hull([(round(a, 1), round(b, 1)) for a, b in edge])})
    return out


def couplets_from(dv_idx: np.ndarray, kpp: float, southern=True, refl=None, rkpp=None):
    """Cyclonic couplets on a BoM Doppler wind image (bins of 10 km/h, index 10 = 0)."""
    N = dv_idx.shape[0]
    v = np.where((dv_idx >= 1) & (dv_idx <= 19), (dv_idx.astype(np.float32) - 10) * 10, np.nan)
    yy, xx = np.mgrid[0:N, 0:N]
    x = (xx - N / 2) * kpp; y = (N / 2 - yy) * kpp; r = np.hypot(x, y)
    ok = (r > 8) & (r < 110)
    tx, ty = np.where(r > 0, y / np.maximum(r, 1e-6), 0), np.where(r > 0, -x / np.maximum(r, 1e-6), 0)
    hits = np.zeros((N, N), np.float32)
    for s in (1.5, 3.0):
        sp = s / 2 / kpp
        ax = np.clip(np.rint(xx - tx * sp), 0, N - 1).astype(int); ay = np.clip(np.rint(yy + ty * sp), 0, N - 1).astype(int)
        bx = np.clip(np.rint(xx + tx * sp), 0, N - 1).astype(int); by = np.clip(np.rint(yy - ty * sp), 0, N - 1).astype(int)
        va, vb = v[ay, ax], v[by, bx]
        d = (va - vb) if southern else (vb - va)
        good = ok & (d >= 70) & (np.abs(va) >= 30) & (np.abs(vb) >= 30) & (va * vb < 0)
        hits = np.maximum(hits, np.where(good, d, 0))
    lab, n = ndimage.label(hits > 0, structure=np.ones((3, 3)))
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        m = lab[sl] == i
        if m.sum() < 3:
            continue
        ys, xs = np.nonzero(m); ys = ys + sl[0].start; xs = xs + sl[1].start
        k = int(np.argmax(hits[ys, xs]))
        cx, cy = (xs[k] - N / 2) * kpp, (N / 2 - ys[k]) * kpp
        # A real couplet is two broad patches of opposite flow. Check the median velocity in a ~1 km
        # patch either side of the centre; BoM images often carry streaks of single top-of-scale pixels
        # (+/-90 km/h) at echo edges, which on their own look like a huge gate-to-gate shear.
        dvm = _couplet_patches(v, xs[k], ys[k], kpp, southern)
        if dvm is None:
            continue
        if refl is not None:
            RN = refl.shape[0]
            px, py = int(RN / 2 + cx / rkpp), int(RN / 2 - cy / rkpp)
            win = refl[max(0, py - 3):py + 4, max(0, px - 3):px + 4]
            if win.size == 0 or win.max() < 8:                 # need a >= ~42 dBZ core around it
                continue
        out.append({"x": float(cx), "y": float(cy), "dv": float(dvm)})
    return out


def _couplet_patches(v, px, py, kpp, southern):
    """Median velocity of the anticlockwise and clockwise patches around (px, py); None unless both are
    mostly valid, clearly opposite in sign and at least 60 km/h apart."""
    N = v.shape[0]
    x, y = (px - N / 2) * kpp, (N / 2 - py) * kpp
    r = math.hypot(x, y) or 1
    tx, ty = y / r, -x / r                                  # clockwise tangential direction (pixels: +x, -y)
    best = None
    for s in (1.5, 3.0):
        sp = s / 2 / kpp
        meds = []
        for sign in (-1, 1):                                # -1 = anticlockwise side, +1 = clockwise side
            cx, cy = px + sign * tx * sp, py - sign * ty * sp
            rad = max(2.0, 1.0 / kpp)
            yy, xx = np.ogrid[0:N, 0:N]
            disc = (xx - cx) ** 2 + (yy - cy) ** 2 <= rad * rad
            vals = v[disc]
            ok = vals[~np.isnan(vals)]
            if vals.size == 0 or ok.size < 0.6 * vals.size:
                meds = None
                break
            meds.append(float(np.median(ok)))
        if not meds:
            continue
        va, vb = meds
        dv = (va - vb) if southern else (vb - va)
        if va * vb < 0 and abs(va) >= 25 and abs(vb) >= 25 and dv >= 60:
            best = max(best or 0, dv)
    return best


def _latest(frames_dir: Path, pid: str, max_age_min=12):
    d = frames_dir / pid
    if not d.exists():
        return []
    fs = []
    for f in d.glob("*.png"):
        m = FRAME_T.search(f.name)
        if m:
            fs.append((datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc), f))
    fs.sort()
    if not fs or datetime.now(timezone.utc) - fs[-1][0] > timedelta(minutes=max_age_min):
        return []
    return fs


def _km_to_ll(lat0, lon0, x, y):
    la = lat0 + y / 111.11
    return la, lon0 + x / (111.11 * math.cos(math.radians(la)))


def _in_poly(lat, lon, poly):
    inside = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i - 1]
        if (a[0] > lat) != (b[0] > lat) and lon < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0] + 1e-12) + a[1]:
            inside = not inside
    return inside


def _strikes(db: Path, lat, lon, km, minutes=10):
    if not db.exists():
        return 0
    t0 = int((time.time() - minutes * 60) * 1000)
    dl = km / 111.0; dn = km / (111.0 * max(0.2, math.cos(math.radians(lat))))
    with sqlite3.connect(db) as c:
        return c.execute("SELECT COUNT(*) FROM strikes WHERE t >= ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                         (t0, lat - dl, lat + dl, lon - dn, lon + dn)).fetchone()[0]


_town_cache = {"mtime": None, "towns": []}


def _load_towns(data_dir: Path):
    f = data_dir / "towns.json"
    if not f.exists():
        return []
    m = f.stat().st_mtime
    if _town_cache["mtime"] != m:
        _town_cache.update(mtime=m, towns=json.loads(f.read_text()).get("towns", []))
    return _town_cache["towns"]


def _towns(data_dir: Path, poly, limit=8):
    towns = _load_towns(data_dir)
    if not towns:
        return []
    lats = [p[0] for p in poly]; lons = [p[1] for p in poly]
    out = []
    for t in towns:
        if min(lats) <= t["la"] <= max(lats) and min(lons) <= t["lo"] <= max(lons) and _in_poly(t["la"], t["lo"], poly):
            out.append(t["n"])
            if len(out) >= limit:
                break
    return out


def _nearest_town(data_dir: Path, lat, lon):
    best = None
    for t in _load_towns(data_dir)[:2500]:
        d = math.hypot((t["la"] - lat) * 111.11, (t["lo"] - lon) * 111.11 * math.cos(math.radians(lat)))
        score = d - min(40, math.log10(max(t["p"], 10)) * 6)       # prefer bigger places when distances are similar
        if d <= 150 and (best is None or score < best[0]):
            best = (score, t, d)
    return best


def _compass(deg):
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][round(deg / 22.5) % 16]


def run_source(src: str, lat0: float, lon0: float, refl_pid: str, km: float, dopp_pid: str | None, frames_dir: Path,
               data_dir: Path, home: dict, tz):
    """Evaluate one radar (or the national mosaic) and update the active warnings."""
    fs = _latest(frames_dir, refl_pid)
    if not fs:
        return
    t_now, f_now = fs[-1]
    prev0 = state["tracks"].get(src)
    if prev0 and prev0["t"] == t_now:
        return                                   # nothing new since the last run
    lv = levels(f_now.read_bytes())
    N = lv.shape[0]
    kpp = km / (N / 2)
    cells = cells_from(lv, kpp)
    # motion from the previous tracked frame
    prev = state["tracks"].get(src)
    if prev and 0 < (t_now - prev["t"]).total_seconds() <= 1800:
        dt = (t_now - prev["t"]).total_seconds() / 3600
        used = set()
        for c in sorted(cells, key=lambda c: -c["area"]):
            best, bd = None, 1e9
            for j, p in enumerate(prev["cells"]):
                if j in used:
                    continue
                px, py = p["x"] + p.get("vx", 0) * dt, p["y"] + p.get("vy", 0) * dt
                d = math.hypot(c["x"] - px, c["y"] - py)
                if d < 130 * dt + 5 and d < bd:
                    best, bd = j, d
            if best is not None:
                used.add(best)
                p = prev["cells"][best]
                vx, vy = (c["x"] - p["x"]) / dt, (c["y"] - p["y"]) / dt
                if math.hypot(vx, vy) > 110:            # cells merging/splitting, not real motion
                    vx, vy = p.get("vx", 0.0), p.get("vy", 0.0)
                c["vx"] = vx if "vx" not in p else 0.5 * vx + 0.5 * p["vx"]
                c["vy"] = vy if "vy" not in p else 0.5 * vy + 0.5 * p["vy"]
                c["id"] = p["id"]; c["age"] = p.get("age", 1) + 1
                c["first"] = p.get("first", prev["t"].isoformat())
    for c in cells:
        c.setdefault("id", f"{src}-{t_now:%H%M}-{int(c['x'])}-{int(c['y'])}")
        c.setdefault("age", 1); c.setdefault("first", t_now.isoformat())
    state["tracks"][src] = {"t": t_now, "cells": cells}

    coup = []
    dop_ok = False
    if dopp_pid:
        ds = _latest(frames_dir, dopp_pid)
        if ds:
            dop_ok = True
            dl = levels(ds[-1][1].read_bytes(), "d")
            coup = couplets_from(dl, km / (dl.shape[0] / 2), lat0 < 0, refl=lv, rkpp=kpp)
            # remember each scan's couplets: a tornado warning needs the same couplet on two scans in a row
            hist = state.setdefault("coup_hist", {}).setdefault(src, {})
            prev_c = hist.get("prev") if hist.get("t") != ds[-1][0] else hist.get("prevprev")
            if hist.get("t") != ds[-1][0]:
                hist["prevprev"], hist["prev"], hist["t"] = hist.get("prev"), coup, ds[-1][0]
            for c0 in coup:
                c0["persistent"] = bool(prev_c) and any(math.hypot(c0["x"] - q["x"], c0["y"] - q["y"]) <= 12 for q in prev_c)

    southern = lat0 < 0
    seen = set()
    storms = []
    active = dict(state["active"])           # edited here, then swapped in whole (the API reads it from another thread)
    now_utc = datetime.now(timezone.utc)
    recent_cut = now_utc - timedelta(minutes=15)
    for c in cells:
        mx_dbz = DBZ[min(14, c["max"] - 1)]
        spd = math.hypot(c.get("vx", 0), c.get("vy", 0))
        clat, clon = _km_to_ll(lat0, lon0, c["x"], c["y"])
        rad = math.sqrt(c["area"] / math.pi)
        ltg = _strikes(data_dir / "lightning.sqlite", clat, clon, rad + 10)
        near_coup = [k for k in coup if math.hypot(k["x"] - c["x"], k["y"] - c["y"]) <= rad + 6]
        dv = max((k["dv"] for k in near_coup), default=0)
        dv_tor = max((k["dv"] for k in near_coup if k.get("persistent")), default=0)
        has_dop = dop_ok and math.hypot(c["x"], c["y"]) <= 110
        threat = None
        if mx_dbz >= 50:
            threat = assess(c, mx_dbz, ltg, dv, has_dop, env_at(clat, clon), southern)
            nt0 = _nearest_town(data_dir, clat, clon)
            spd0 = math.hypot(c.get("vx", 0), c.get("vy", 0))
            storms.append({"id": c["id"], "source": src, "lat": round(clat, 4), "lon": round(clon, 4), "dbz": round(mx_dbz),
                           "lightning": ltg, "speed": round(spd0), "age": c.get("age", 1),
                           "dir": round((math.degrees(math.atan2(c.get("vx", 0), c.get("vy", 0))) + 360) % 360) if spd0 >= 10 else None,
                           "near": nt0[1]["n"] if nt0 else None, "threat": threat, "nearest_radar": nearest_radar(clat, clon)})
        kind = None
        hazards = []
        age = c.get("age", 1)
        big_core = c["area50"] >= max(20.0, 2 * kpp * kpp)          # a real >= 50 dBZ core, not a hot pixel
        if kpp >= 2:      # coarse national mosaic: needs lightning, or a large core that persists (clutter rarely does both)
            confirmed = ltg >= 2 or (age >= 3 and c["area50"] >= 100)
        else:
            confirmed = age >= 2 or ltg >= 3                        # seen twice, or lightning backs it up
        if dv_tor >= 100 and mx_dbz >= 50:
            kind = "TOR"; hazards.append(f"Radar-indicated rotation on two scans in a row, \u0394V {dv_tor:.0f} km/h")
        elif (mx_dbz >= 55 and big_core and confirmed) or (mx_dbz >= 50 and big_core and (dv >= 70 or ltg >= 15)):
            kind = "SVR"
            if dv >= 70:
                hazards.append(f"Rotation detected, \u0394V {dv:.0f} km/h")
        elif mx_dbz >= 50 and spd < 10 and age >= 6:
            kind = "FFW"
        if not kind:
            continue
        if mx_dbz >= 59:
            hazards.append("Large hail possible (core above 59 dBZ)")
        elif mx_dbz >= 55:
            hazards.append("Hail possible (core above 55 dBZ)")
        if ltg >= 15:
            hazards.append(f"Frequent lightning ({ltg} strikes in 10 min)")
        if spd < 10 and mx_dbz >= 50 and age >= 3:
            hazards.append("Slow moving: heavy rain and flash flooding possible")
        if kind == "FFW" and not hazards:
            hazards.append("Heavy rain over the same area for 30+ minutes")
        # storm-based polygon: hull now + hull projected LEAD_MIN ahead, widened by 5 km
        h = c["hull"] or [(c["x"], c["y"])]
        dx, dy = c.get("vx", 0) * LEAD_MIN / 60, c.get("vy", 0) * LEAD_MIN / 60
        pts = []
        for (px, py) in h:
            for ox, oy in ((0, 0), (dx, dy)):
                for a in range(0, 360, 45):
                    pts.append((round(px + ox + 5 * math.cos(math.radians(a)), 2), round(py + oy + 5 * math.sin(math.radians(a)), 2)))
        poly_km = hull(pts)
        poly = [list(map(lambda v: round(v, 4), _km_to_ll(lat0, lon0, px, py))) for px, py in poly_km]
        towns = _towns(data_dir, poly)
        wid = f"{kind}-{c['id']}"
        seen.add(wid)
        now = datetime.now(timezone.utc)
        steady = age >= (4 if kpp >= 2 else 3)          # the 5 km national mosaic needs a longer track
        motion = (f"moving {_compass((math.degrees(math.atan2(c['vx'], c['vy'])) + 360) % 360)} at {spd:.0f} km/h" if spd >= 10 and steady
                  else "nearly stationary" if steady else "movement not yet known")
        dist_home = math.hypot((clat - home["lat"]) * 111.11, (clon - home["lon"]) * 111.11 * math.cos(math.radians(home["lat"])))
        brg = (math.degrees(math.atan2((clon - home["lon"]) * math.cos(math.radians(home["lat"])), clat - home["lat"])) + 360) % 360
        title = {"TOR": "Tornado warning", "SVR": "Severe thunderstorm warning", "FFW": "Flash flood warning"}[kind]
        prev_w = active.get(wid)
        local = t_now.astimezone(tz).strftime("%-I:%M %p")
        nt = _nearest_town(data_dir, clat, clon)
        if dist_home <= 150 or not nt:
            where = f"{dist_home:.0f} km {_compass(brg)} of {home['name']}"
        else:
            tb = (math.degrees(math.atan2((clon - nt[1]['lo']) * math.cos(math.radians(clat)), clat - nt[1]['la'])) + 360) % 360
            where = f"near {nt[1]['n']}" if nt[2] < 8 else f"{nt[2]:.0f} km {_compass(tb)} of {nt[1]['n']}"
        text = (f"At {local}, a {'possibly tornadic ' if kind == 'TOR' else ''}thunderstorm was located "
                f"{where}, {motion}. Core {mx_dbz:.0f} dBZ."
                + (f" Locations in the warning area include {', '.join(towns)}." if towns else ""))
        # one event per storm: the same storm seen by another radar or the national mosaic, or re-warned
        # within 15 minutes of being cancelled, keeps its event id (so it isn't announced again)
        event = prev_w.get("event") if prev_w else None
        issued = prev_w["issued"] if prev_w else now.isoformat()
        if not event:
            near_km = lambda o: math.hypot((o["lat"] - clat) * 111.11, (o["lon"] - clon) * 111.11 * math.cos(math.radians(clat)))
            twins = [o for o in active.values() if o["type"] == kind and o["id"] != wid and near_km(o) <= 20]
            twins += [o for o in state["recent"] if o["type"] == kind and near_km(o) <= 20
                      and datetime.fromisoformat(o["updated"]) >= recent_cut]
            if twins:
                twin = min(twins, key=near_km)
                event, issued = twin.get("event") or twin["id"], twin["issued"]
            else:
                event = wid
        w = {"id": wid, "event": event, "type": kind, "title": title, "source": src, "issued": issued,
             "updated": now.isoformat(), "expires": (now + timedelta(minutes=LEAD_MIN)).isoformat(), "status": "active",
             "polygon": poly, "hazards": hazards, "text": text, "towns": towns, "lat": round(clat, 4), "lon": round(clon, 4),
             "dbz": round(mx_dbz), "dv": round(dv), "lightning": ltg, "speed": round(spd), "home_inside": _in_poly(home["lat"], home["lon"], poly),
             "threat": threat, "nearest_radar": nearest_radar(clat, clon)}
        active[wid] = w
    # cancel this source's warnings whose cells no longer meet criteria
    recent = list(state["recent"])
    for wid, w in list(active.items()):
        if w["source"] == src and wid not in seen:
            recent.append({**w, "status": "cancelled", "updated": now_utc.isoformat()})
            del active[wid]
    state["active"] = active
    state["storms"] = {**state["storms"], src: storms}
    state["storms_t"] = {**state.get("storms_t", {}), src: time.time()}
    state["recent"] = [w for w in recent if datetime.fromisoformat(w["updated"]) > now_utc - timedelta(hours=6)][-100:]
    state["last_run"] = now_utc.isoformat()


# ---------------------------------------------------------------- forecast watches
def ffdi(t, rh, wind_kmh, df=10.0):
    return 2 * math.exp(-0.45 + 0.987 * math.log(df) - 0.0345 * rh + 0.0338 * t + 0.0234 * wind_kmh)


def build_watches(region: str, sfc: dict, svr: dict | None, lat0, lon0, hours=12, previous=None):
    """Watch areas from the model grid: grid points meeting criteria anywhere in the next `hours`."""
    n, half = sfc["n"], sfc["half"]
    step = 2 * half / (n - 1)
    nt = min(hours, len(sfc["time"]))
    crit = {"TOA": {}, "SVA": {}, "WND": {}, "HEA": {}, "FWA": {}}     # type -> {grid point: peak value}
    def hit(k, pt, val):
        crit[k][pt] = max(crit[k].get(pt, val), val)
    for p in range(n * n):
        x, y = -half + (p % n) * step, half - (p // n) * step
        for t in range(nt):
            V = sfc["vars"]
            temp, rh, gust = V["temp"][t][p], V["rh"][t][p], V["gust"][t][p]
            u, v = V.get("u", [[None]])[t][p], V.get("v", [[None]])[t][p]
            if gust is not None and gust >= 90:
                hit("WND", (x, y), gust)
            if temp is not None and temp >= 40:
                hit("HEA", (x, y), temp)
            if None not in (temp, rh, u, v):
                f = ffdi(temp, rh, math.hypot(u, v))
                if f >= 50:
                    hit("FWA", (x, y), f)
            if svr:
                S = svr["vars"]
                stp, scp, cape = S["stp"][t][p], S["scp"][t][p], S["cape"][t][p]
                if stp is not None and stp >= 1:
                    hit("TOA", (x, y), stp)
                if scp is not None and scp >= 2 and (cape or 0) >= 500:
                    hit("SVA", (x, y), scp)
    names = {"TOA": "Tornado watch", "SVA": "Severe thunderstorm watch", "WND": "Damaging wind watch",
             "HEA": "Extreme heat watch", "FWA": "Fire weather watch"}
    desc = {"TOA": "STP up to {:.1f}: the environment supports supercells capable of tornadoes.",
            "SVA": "SCP up to {:.1f}: the environment supports organised severe thunderstorms and supercells.",
            "WND": "Model gusts up to {:.0f} km/h.", "HEA": "Model temperatures up to {:.0f} \u00b0C.",
            "FWA": "McArthur FFDI up to {:.0f} (drought factor assumed 10)."}
    out = []
    old_w = [w for w in (previous or []) if w.get("source") == region]
    used = set()
    for k, vals in crit.items():
        pts = sorted(vals)
        # separate areas: grid points within 1.5 steps of each other belong together
        groups = []
        for p in pts:
            hit = [g for g in groups if any(math.hypot(p[0] - q[0], p[1] - q[1]) <= step * 1.5 for q in g)]
            merged = [p] + [q for g in hit for q in g]
            groups = [g for g in groups if g not in hit] + [merged]
        for gi, g in enumerate(groups):
            if len(g) < 2:
                continue
            ring = []
            for (px, py) in g:
                for a in range(0, 360, 45):
                    ring.append((px + step * 0.6 * math.cos(math.radians(a)), py + step * 0.6 * math.sin(math.radians(a))))
            poly = [list(map(lambda v: round(v, 3), _km_to_ll(lat0, lon0, px, py))) for px, py in hull(ring)]
            cx, cy = sum(q[0] for q in g) / len(g), sum(q[1] for q in g) / len(g)
            clat, clon = _km_to_ll(lat0, lon0, cx, cy)
            # keep the id of last run's watch of the same type over roughly the same area, so a 6-hourly
            # refresh isn't announced as a new watch
            wid = None
            for o in old_w:
                if o["type"] == k and o["id"] not in used and "lat" in o and \
                        math.hypot((o["lat"] - clat) * 111.11, (o["lon"] - clon) * 111.11 * math.cos(math.radians(clat))) <= 150:
                    wid = o["id"]
                    break
            wid = wid or f"{k}-{region}-{int(time.time())}-{gi}"
            used.add(wid)
            out.append({"id": wid, "type": k, "lat": round(clat, 3), "lon": round(clon, 3), "title": names[k], "source": region, "status": "watch",
                        "valid_from": datetime.fromtimestamp(sfc["time"][0], timezone.utc).isoformat(),
                        "valid_to": datetime.fromtimestamp(sfc["time"][nt - 1], timezone.utc).isoformat(),
                        "polygon": poly, "text": desc[k].format(max(vals[q] for q in g)), "hazards": []})
    return out
