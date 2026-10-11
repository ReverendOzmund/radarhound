"""Volume products computed from one raw ODIM volume (all tilts).

Grid products (1 km cells, radar-centred square, x east / y north):
  CR    composite reflectivity, dBZ (max over tilts)
  ET18  18 dBZ echo top, km above sea level
  ET45  45 dBZ echo top, km
  VIL   vertically integrated liquid, kg/m2 (Greene & Clark 1972)
  MESH  maximum expected size of hail, mm (Witt et al. 1998)
  POSH  probability of severe hail, %
Plus vertical cross-sections along any line, for any moment.

Beam geometry uses the 4/3 effective earth radius model.
"""
import math
from pathlib import Path

import h5py
import numpy as np

RE = 8494.7                      # km, 4/3 earth radius
GRID_HALF = 250                  # km
GRID_SIZE = 500                  # 1 km cells
BEAMWIDTH = 1.0                  # degrees, typical for BoM S/C-band radars

# uint8 encodings (0 = no data): value = raw * gain + offset
ENC = {
    "CR": (0.5, -32.0), "ET18": (0.1, 0.0), "ET45": (0.1, 0.0),
    "VIL": (0.5, 0.0), "MESH": (0.5, 0.0), "POSH": (1.0, 0.0),
    "ROT": (0.1, 0.0),            # cyclonic azimuthal shear, units of 1e-3 / s
}


def _s(v):
    return v.decode() if isinstance(v, (bytes, np.bytes_)) else v


def load_moment(path: Path, quantity: str, fallback=None):
    """All non-vertical tilts of one quantity: list of dicts with float arrays (NaN = none)."""
    out = []
    with h5py.File(path, "r") as f:
        height_m = float(f["where"].attrs.get("height", 0.0))
        for k in f:
            if not k.startswith("dataset"):
                continue
            g = f[k]
            el = float(g["where"].attrs["elangle"])
            if el >= 60:
                continue
            key = None
            for q in g:
                if q.startswith("data") and _s(g[q]["what"].attrs["quantity"]) == quantity:
                    key = q
            if key is None and fallback:
                for q in g:
                    if q.startswith("data") and _s(g[q]["what"].attrs["quantity"]) == fallback:
                        key = q
            if key is None:
                continue
            w = g[key]["what"].attrs
            raw = g[key]["data"][:]
            val = raw.astype(np.float32) * float(w["gain"]) + float(w["offset"])
            val[(raw == w["nodata"]) | (raw == w["undetect"])] = np.nan
            ww = g["where"].attrs
            out.append({"elev": el, "data": val, "rscale": float(ww["rscale"]) / 1000.0,
                        "rstart": float(ww.get("rstart", 0.0)), "nrays": int(ww["nrays"]), "nbins": int(ww["nbins"])})
    out.sort(key=lambda t: t["elev"])
    return out, height_m / 1000.0


def slant_and_height(d, elev_deg, h0):
    """ground distance d (km) -> slant range (km) and beam centre height ASL (km)."""
    th = math.radians(elev_deg)
    a = d / RE
    s = RE * np.sin(a) / np.cos(th + a)
    h = np.sqrt(s * s + RE * RE + 2 * s * RE * math.sin(th)) - RE + h0
    return s, h


def sample(t, s, az):
    """Nearest-gate sample of tilt t at slant range s (km) and azimuth az (rad)."""
    g = np.floor((s - t["rstart"]) / t["rscale"]).astype(np.int64)
    r = np.floor(az * t["nrays"] / (2 * np.pi) + 0.5).astype(np.int64) % t["nrays"]
    ok = (g >= 0) & (g < t["nbins"])
    out = np.full(s.shape, np.nan, np.float32)
    out[ok] = t["data"][r[ok], g[ok]]
    return out


def _encode(v, name):
    gain, off = ENC[name]
    e = np.rint((v - off) / gain)
    return np.where(np.isnan(v) | (e < 1), 0, np.clip(e, 1, 255)).astype(np.uint8)


def _nan_smooth_range(v, n=3):
    """Mean over n neighbouring gates along range, ignoring NaN."""
    w = (~np.isnan(v)).astype(np.float32)
    x = np.nan_to_num(v)
    k = np.ones(n, np.float32)
    num = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, x)
    den = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, w)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den >= 2, num / den, np.nan)


def rotation_tilts(path: Path, refl_tilts, southern: bool):
    """Cyclonic azimuthal shear (1/s) per low tilt, from dealiased velocity."""
    vel, _ = load_moment(path, "VRADDH", fallback="VRADH")
    zmap = {round(t["elev"], 1): t for t in refl_tilts}
    out = []
    for t in vel:
        if t["elev"] > 2.6:
            continue
        v = _nan_smooth_range(t["data"])
        z = zmap.get(round(t["elev"], 1))
        if z is not None and z["data"].shape == v.shape:
            v = np.where(z["data"] >= 20, v, np.nan)
        dth = 2 * np.pi / t["nrays"]
        rng = (t["rstart"] + (np.arange(t["nbins"]) + 0.5) * t["rscale"]) * 1000.0
        with np.errstate(invalid="ignore"):
            shear = (np.roll(v, -1, axis=0) - np.roll(v, 1, axis=0)) / (2 * dth * rng[None, :])
        cyc = -shear if southern else shear          # clockwise is cyclonic south of the equator
        cyc[:, rng < 5000] = np.nan
        cyc[:, rng > 150000] = np.nan
        out.append({**t, "data": cyc.astype(np.float32)})
    return out


def grid_products(path: Path, h0c_km: float, hm20_km: float, southern: bool = True):
    """Compute all grid products; returns dict name -> uint8 [GRID_SIZE, GRID_SIZE]."""
    tilts, h0 = load_moment(path, "DBZH_CLEAN", fallback="DBZH")
    k = 2 * GRID_HALF / GRID_SIZE
    y = GRID_HALF - (np.arange(GRID_SIZE) + 0.5) * k
    x = -GRID_HALF + (np.arange(GRID_SIZE) + 0.5) * k
    X, Y = np.meshgrid(x, y)
    d = np.hypot(X, Y)
    az = np.mod(np.arctan2(X, Y), 2 * np.pi)

    Z, H = [], []
    for t in tilts:
        s, h = slant_and_height(d, t["elev"], h0)
        Z.append(sample(t, s, az))
        H.append(h)
    Z = np.stack(Z)                      # [ntilt, ny, nx] dBZ (NaN none)
    H = np.stack(H)                      # beam heights km
    any_echo = ~np.all(np.isnan(Z), axis=0)

    with np.errstate(invalid="ignore"):
        cr = np.nanmax(np.where(np.isnan(Z), -np.inf, Z), axis=0)
    cr = np.where(any_echo, cr, np.nan)

    def echo_top(th):
        hit = Z >= th
        top = np.where(hit, H, -np.inf).max(axis=0)
        return np.where(np.isfinite(top), top, np.nan)

    # VIL and SHI by trapezoids between consecutive tilts (tilts are ordered by elevation, so by height)
    Zf = np.where(np.isnan(Z), -np.inf, Z)
    zlin = np.where(np.isfinite(Zf), 10 ** (np.minimum(Zf, 56) / 10), 0.0)
    m = zlin ** (4 / 7)
    dh_m = np.diff(H, axis=0) * 1000.0
    vil = (3.44e-6 * 0.5 * (m[1:] + m[:-1]) * dh_m).sum(axis=0)
    vil = np.where(any_echo, vil, np.nan)

    zc = np.where(np.isfinite(Zf), Zf, 0)
    wz = np.clip((zc - 40) / 10, 0, 1)
    E = 5e-6 * 10 ** (0.084 * np.minimum(zc, 70)) * wz
    wt = np.clip((H - h0c_km) / max(0.1, hm20_km - h0c_km), 0, 1)
    f = E * wt
    shi = 0.1 * (0.5 * (f[1:] + f[:-1]) * dh_m).sum(axis=0)
    mesh = np.where(shi > 0, 2.54 * np.sqrt(shi), 0.0)
    wthr = 57.5 * h0c_km - 121
    with np.errstate(divide="ignore", invalid="ignore"):
        posh = np.where((shi > 0) & (wthr > 0), np.clip(29 * np.log(shi / wthr) + 50, 0, 100), 0.0)

    rot = np.full(d.shape, np.nan, np.float32)
    for t in rotation_tilts(path, tilts, southern):
        s, h = slant_and_height(d, t["elev"], h0)
        v = sample(t, s, az)
        v = np.where(h - h0 <= 3.0, v, np.nan)
        rot = np.fmax(rot, v)
    rot = np.where(rot * 1000 >= 1.0, rot * 1000, np.nan)

    return {
        "ROT": _encode(rot, "ROT"),
        "CR": _encode(cr, "CR"),
        "ET18": _encode(echo_top(18), "ET18"),
        "ET45": _encode(echo_top(45), "ET45"),
        "VIL": _encode(np.where(vil > 0.25, vil, np.nan), "VIL"),
        "MESH": _encode(np.where(mesh >= 1, mesh, np.nan), "MESH"),
        "POSH": _encode(np.where(posh >= 1, posh, np.nan), "POSH"),
    }


def cross_section(path: Path, quantity: str, x1, y1, x2, y2, nx=320, nz=160, ztop=16.0, motion=None):
    """Vertical slice A->B (km coords). Returns float32 [nz, nx] (row 0 = top), NaN = no data.
    For each point the tilt whose beam centre is nearest in height is used, if within one beamwidth."""
    base = quantity
    if quantity == "SRV":
        base = "VRADDH"
    tilts, h0 = load_moment(path, base, fallback="VRADH" if base == "VRADDH" else ("DBZH" if base == "DBZH_CLEAN" else None))
    if not tilts:
        return None
    t = np.linspace(0, 1, nx)
    xs, ys = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
    d = np.hypot(xs, ys)
    az = np.mod(np.arctan2(xs, ys), 2 * np.pi)
    zs = ztop * (1 - (np.arange(nz) + 0.5) / nz)          # top row first
    best = np.full((nz, nx), np.nan, np.float32)
    bestdiff = np.full((nz, nx), np.inf, np.float32)
    for tl in tilts:
        s, h = slant_and_height(d, tl["elev"], h0)
        v = sample(tl, s, az)
        if quantity == "SRV" and motion:
            to = math.radians(motion[0])
            v = v - (motion[1] / 3.6) * np.cos(az - to)
        half_bw = np.maximum(s * math.tan(math.radians(BEAMWIDTH)), 0.25)   # generous so beams touch
        diff = np.abs(zs[:, None] - h[None, :])
        use = (diff < half_bw[None, :]) & (diff < bestdiff) & ~np.isnan(v)[None, :]
        best = np.where(use, v[None, :], best)
        bestdiff = np.where(use, diff, bestdiff)
    return best


# ---------------------------------------------------------------- mesocyclone / TVS / debris detection
def _cluster(mask):
    """4-connected components on a polar boolean mask (azimuth wraps). Returns list of index arrays."""
    nr, nb = mask.shape
    lab = np.zeros(mask.shape, np.int32)
    comps = []
    nxt = 1
    pts = np.argwhere(mask)
    for r0, g0 in pts:
        if lab[r0, g0]:
            continue
        stack = [(r0, g0)]
        lab[r0, g0] = nxt
        members = []
        while stack:
            r, g = stack.pop()
            members.append((r, g))
            for dr, dg in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                rr, gg = (r + dr) % nr, g + dg
                if 0 <= gg < nb and mask[rr, gg] and not lab[rr, gg]:
                    lab[rr, gg] = nxt
                    stack.append((rr, gg))
        comps.append(np.array(members))
        nxt += 1
    return comps


def rotation_detections(path: Path, southern: bool, max_range_km=150.0):
    """Find cyclonic velocity couplets tilt by tilt, then stack them vertically.

    For every gate the cyclonic azimuthal velocity difference dV is taken over arcs of 0.5-10 km
    (the couplet diameter). Rotational velocity Vrot = dV / 2. Tilt features are grouped when they sit
    within 5 km of each other horizontally. A group is a mesocyclone with Vrot >= 12 m/s over at least
    two tilts; it gets a tornado vortex signature (TVS) flag when the gate-to-gate dV reaches 25 m/s
    within 2 km of the ground. Low correlation (CC <= 0.82) with >= 35 dBZ and near-zero ZDR at the
    lowest tilt marks a possible tornado debris signature (TDS)."""
    vel, h0 = load_moment(path, "VRADDH", fallback="VRADH")
    refl = {round(t["elev"], 1): t for t in load_moment(path, "DBZH")[0]}
    rho = {round(t["elev"], 1): t for t in load_moment(path, "RHOHV")[0]}
    zdr = {round(t["elev"], 1): t for t in load_moment(path, "ZDR")[0]}
    feats = []
    for t in vel:
        if t["elev"] > 10:
            continue
        V = t["data"]
        nr, nb = V.shape
        dth = 2 * np.pi / nr
        rng = t["rstart"] + (np.arange(nb) + 0.5) * t["rscale"]
        okr = (rng > 4) & (rng < max_range_km)
        z = refl.get(round(t["elev"], 1))
        Vm = np.where(z["data"] >= 15, V, np.nan) if z is not None and z["data"].shape == V.shape else V
        best = np.zeros(V.shape, np.float32)
        best_d = np.zeros(V.shape, np.float32)
        g2g = np.zeros(V.shape, np.float32)
        kmax = int(np.ceil(10.0 / (rng[okr].min() * dth))) if okr.any() else 1
        kmax = max(1, min(kmax, 40))
        for k in range(1, kmax + 1):
            a, b = Vm, np.roll(Vm, -k, axis=0)           # b is k rays clockwise of a
            dv = (a - b) if southern else (b - a)       # cyclonic: outbound on the anticlockwise side in the south
            arc = rng[None, :] * dth * k
            dv = np.where((arc >= 0.5) & (arc <= 10.0) & okr[None, :], dv, np.nan)
            dv = np.nan_to_num(dv, nan=0.0)
            upd = dv > best
            best = np.where(upd, dv, best)
            best_d = np.where(upd, arc, best_d)
            if k <= 2:
                g2g = np.maximum(g2g, np.where(arc <= 2.0, dv, 0))
        cand = best >= 24.0                              # dV >= 24 m/s, i.e. Vrot >= 12 m/s
        if not cand.any():
            continue
        h = np.sqrt(rng ** 2 + RE ** 2 + 2 * rng * RE * math.sin(math.radians(t["elev"]))) - RE + h0
        for comp in _cluster(cand):
            if len(comp) < 3:
                continue
            r_idx, g_idx = comp[:, 0], comp[:, 1]
            dvs = best[r_idx, g_idx]
            i = int(np.argmax(dvs))
            r0, gi = int(r_idx[i]), int(g_idx[i])
            az = (r0 + 0.5) * dth * 1 + 0.5 * best_d[r0, gi] / max(rng[gi], 1e-3)   # centre of the couplet
            s = rng[gi]
            d_ground = RE * math.asin(min(1.0, s * math.cos(math.radians(t["elev"])) / (RE + h[gi] - h0)))
            x, y = d_ground * math.sin(az), d_ground * math.cos(az)
            feats.append({"elev": t["elev"], "x": x, "y": y, "dv": float(dvs[i]), "diam": float(best_d[r0, gi]),
                          "h": float(h[gi]), "g2g": float(g2g[r_idx, g_idx].max()), "ray": r0, "gate": gi})
    # vertical association
    feats.sort(key=lambda f: -f["dv"])
    groups = []
    for f in feats:
        for gr in groups:
            if math.hypot(f["x"] - gr["x"], f["y"] - gr["y"]) <= 5.0 and f["elev"] not in gr["elevs"]:
                gr["m"].append(f); gr["elevs"].add(f["elev"])
                break
        else:
            groups.append({"x": f["x"], "y": f["y"], "m": [f], "elevs": {f["elev"]}})
    out = []
    for gr in groups:
        m = gr["m"]
        if len(m) < 2:
            continue
        vrot = max(f["dv"] for f in m) / 2
        base = min(f["h"] for f in m)
        top = max(f["h"] for f in m)
        low = min(m, key=lambda f: f["elev"])
        tvs = any(f["g2g"] >= 25.0 and f["h"] - h0 <= 2.0 for f in m)
        rank = "strong" if vrot >= 25 else "moderate" if vrot >= 18 else "weak"
        tds = False
        rt, zt, dt = rho.get(round(low["elev"], 1)), refl.get(round(low["elev"], 1)), zdr.get(round(low["elev"], 1))
        if rt is not None and zt is not None and dt is not None:
            nr = rt["data"].shape[0]
            rr = [(low["ray"] + k) % nr for k in range(-3, 4)]
            gs = slice(max(0, low["gate"] - 8), low["gate"] + 9)
            c, zz, dd = rt["data"][rr, gs], zt["data"][rr, gs], dt["data"][rr, gs]
            with np.errstate(invalid="ignore"):
                tds = bool(np.any((c <= 0.82) & (zz >= 35) & (np.abs(dd) <= 1.5)))
        out.append({"x": round(low["x"], 2), "y": round(low["y"], 2), "vrot": round(vrot, 1), "dv": round(2 * vrot, 1),
                    "diam": round(low["diam"], 1), "base": round(base, 2), "top": round(top, 2), "depth": round(top - base, 2),
                    "tilts": len(m), "rank": rank, "tvs": tvs, "tds": tds, "type": "TVS" if tvs else "MESO"})
    out.sort(key=lambda d: -d["vrot"])
    return out[:30]
