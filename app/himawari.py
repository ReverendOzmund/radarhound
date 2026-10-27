"""Himawari-9 imagery straight from the source.

* Infrared / water vapour: raw Himawari Standard Data (HSD) from NOAA's open AWS bucket,
  published ~12-15 min after each 10-minute scan. We decode counts to real brightness
  temperatures (so the UI can read out cloud-top temperatures) and resample to a square
  grid centred on the radar, using the same flat-earth scaling as BoM's radar images.
* True colour: CIRA SLIDER GeoColor tiles (geostationary full-disk mosaic), reprojected
  the same way.
"""
import asyncio
import bz2
import io
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

log = logging.getLogger("radarhound.himawari")

AWS = os.getenv("HIMAWARI_AWS", "https://noaa-himawari9.s3.amazonaws.com")
SLIDER = os.getenv("SLIDER_BASE", "https://slider.cira.colostate.edu")
SIZES = {512: 1024, 1536: 1536, 2600: 1300}
BANDS = {"ir13": "B13", "wv08": "B08"}           # 10.4 um clean IR, 6.2 um upper water vapour
ENC_MIN, ENC_STEP = 170.0, 0.6                    # uint8 encoding of Tb: 0 = no data
SEG_LINES = 550                                    # 2 km bands: 5500 lines in 10 segments

_locks: dict = {}
_list_cache: dict = {}
_empty_until: dict = {}

# ---------------------------------------------------------------- HSD header layout
B1 = np.dtype([("n", "u1"), ("len", "<u2"), ("nblocks", "<u2"), ("order", "u1"), ("sat", "S16"),
               ("center", "S16"), ("area", "S4"), ("other", "S2"), ("timeline", "<u2"),
               ("t0", "<f8"), ("t1", "<f8"), ("tc", "<f8"), ("hdr_len", "<u4"), ("data_len", "<u4")])
B2 = np.dtype([("n", "u1"), ("len", "<u2"), ("bits", "<u2"), ("cols", "<u2"), ("lines", "<u2"), ("comp", "u1")])
B3 = np.dtype([("n", "u1"), ("len", "<u2"), ("sub_lon", "<f8"), ("cfac", "<u4"), ("lfac", "<u4"),
               ("coff", "<f4"), ("loff", "<f4"), ("H", "<f8"), ("req", "<f8"), ("rpol", "<f8"),
               ("k1", "<f8"), ("k2", "<f8"), ("k3", "<f8"), ("sd", "<f8")])
B5 = np.dtype([("n", "u1"), ("len", "<u2"), ("band", "<u2"), ("cwl", "<f8"), ("vbits", "<u2"),
               ("err", "<u2"), ("outside", "<u2"), ("gain", "<f8"), ("offset", "<f8"),
               ("c0", "<f8"), ("c1", "<f8"), ("c2", "<f8"), ("C0", "<f8"), ("C1", "<f8"), ("C2", "<f8"),
               ("c", "<f8"), ("h", "<f8"), ("k", "<f8")])
B7 = np.dtype([("n", "u1"), ("len", "<u2"), ("nseg", "u1"), ("seg", "u1"), ("first_line", "<u2")])


def parse_segment(raw: bytes):
    """Return (tb[lines, cols] float32 kelvin, or reflectance 0-1 for bands 1-6; first_line; projection dict)."""
    b1 = np.frombuffer(raw, B1, 1)[0]
    blocks, off = {}, 0
    for _ in range(int(b1["nblocks"])):
        n = raw[off]
        ln = int.from_bytes(raw[off + 1:off + 3], "little")
        blocks[n] = off
        off += ln
    b2 = np.frombuffer(raw, B2, 1, blocks[2])[0]
    b3 = np.frombuffer(raw, B3, 1, blocks[3])[0]
    b5 = np.frombuffer(raw, B5, 1, blocks[5])[0]
    b7 = np.frombuffer(raw, B7, 1, blocks[7])[0]
    cols, lines = int(b2["cols"]), int(b2["lines"])
    counts = np.frombuffer(raw, "<u2", cols * lines, int(b1["hdr_len"])).reshape(lines, cols)
    bad = (counts == b5["err"]) | (counts == b5["outside"])
    rad = counts.astype(np.float32) * np.float32(b5["gain"]) + np.float32(b5["offset"])
    rad = np.where(bad | (rad <= 0), np.nan, rad)
    proj = {k_: float(b3[k_]) for k_ in ("sub_lon", "cfac", "lfac", "coff", "loff", "H", "req", "rpol")}
    if int(b5["band"]) <= 6:
        # visible / near-infrared bands: radiance -> reflectance (the header's c' sits where IR bands keep c0)
        return (rad * np.float32(b5["c0"])).astype(np.float32), int(b7["first_line"]), proj
    lam = float(b5["cwl"]) * 1e-6
    h, c, k = float(b5["h"]), float(b5["c"]), float(b5["k"])
    with np.errstate(invalid="ignore", divide="ignore"):
        te = (h * c / (k * lam)) / np.log((2 * h * c * c) / (rad * 1e6 * lam ** 5) + 1)
        tb = float(b5["c0"]) + float(b5["c1"]) * te + float(b5["c2"]) * te * te
    proj = {k_: float(b3[k_]) for k_ in ("sub_lon", "cfac", "lfac", "coff", "loff", "H", "req", "rpol")}
    return tb.astype(np.float32), int(b7["first_line"]), proj


# ---------------------------------------------------------------- geometry
def grid_latlon(lat0, lon0, half, size):
    """lat/lon of every output pixel, radar-centred, BoM-style flat scaling (km per degree 111.11)."""
    k = 2 * half / size
    y = half - (np.arange(size) + 0.5) * k            # km north, top row first
    x = -half + (np.arange(size) + 0.5) * k           # km east
    lat = lat0 + y / 111.11
    lat2 = np.repeat(lat[:, None], size, axis=1)
    lon2 = lon0 + x[None, :] / (111.11 * np.cos(np.radians(lat2)))
    return lat2, lon2


def geos_line_col(lat, lon, p):
    """CGMS normalized geostationary projection: lat/lon (deg) -> 1-based line/column."""
    req, rpol, H = p["req"], p["rpol"], p["H"]
    e2 = (req * req - rpol * rpol) / (req * req)
    la, lo = np.radians(lat), np.radians(lon - p["sub_lon"])
    c_lat = np.arctan((rpol * rpol) / (req * req) * np.tan(la))
    rl = rpol / np.sqrt(1 - e2 * np.cos(c_lat) ** 2)
    r1 = H - rl * np.cos(c_lat) * np.cos(lo)
    r2 = -rl * np.cos(c_lat) * np.sin(lo)
    r3 = rl * np.sin(c_lat)
    rn = np.sqrt(r1 * r1 + r2 * r2 + r3 * r3)
    x = np.degrees(np.arctan(-r2 / r1))
    y = np.degrees(np.arcsin(-r3 / rn))
    col = p["coff"] + x * p["cfac"] / 65536.0
    line = p["loff"] + y * p["lfac"] / 65536.0
    return line, col


# Himawari-9 2 km grid constants (used before any header has been read)
DEFAULT_PROJ = {"sub_lon": 140.7, "cfac": 20466275.0, "lfac": 20466275.0, "coff": 2750.5, "loff": 2750.5,
                "H": 42164.0, "req": 6378.137, "rpol": 6356.7523}


# ---------------------------------------------------------------- AWS listing
async def _scan_keys(client, band, slot: datetime):
    """Keys present for one 10-min scan of a band (cached: recent 60 s, old forever)."""
    prefix = f"AHI-L1b-FLDK/{slot:%Y/%m/%d/%H%M}/"
    key = (prefix, band)
    hit = _list_cache.get(key)
    if hit and (hit[0] is None or hit[0] > time.time()):
        return hit[1]
    r = await client.get(AWS + "/", params={"list-type": "2", "prefix": prefix + f"HS_H09_{slot:%Y%m%d_%H%M}_{band}_FLDK"})
    r.raise_for_status()
    keys = re.findall(r"<Key>([^<]+)</Key>", r.text)
    old = datetime.now(timezone.utc) - slot > timedelta(hours=2)
    _list_cache[key] = (None if old and len(keys) >= 10 else time.time() + 60, keys)
    return keys


def _needed_segments(lat0, lon0, half):
    lat, lon = grid_latlon(lat0, lon0, half, 64)
    line, _ = geos_line_col(lat, lon, DEFAULT_PROJ)
    lo, hi = int(np.nanmin(line)), int(np.nanmax(line))
    return sorted({min(10, max(1, (ln - 1) // SEG_LINES + 1)) for ln in range(lo - 2, hi + 3)})


async def _download_segment(client, data_dir: Path, key: str) -> bytes:
    cache = data_dir / "hsd_raw" / Path(key).name.replace(".bz2", "")
    if cache.exists():
        return cache.read_bytes()
    r = await client.get(f"{AWS}/{key}")
    r.raise_for_status()
    raw = await asyncio.to_thread(bz2.decompress, r.content)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(raw)
    return raw


def _resample_float(segments, lat0, lon0, half, size):
    tbs = []
    proj = None
    for raw in segments:
        tb, first, proj = parse_segment(raw)
        tbs.append((first, tb))
    tbs.sort(key=lambda t: t[0])
    first_line = tbs[0][0]
    stack = np.concatenate([t[1] for t in tbs], axis=0)
    lat, lon = grid_latlon(lat0, lon0, half, size)
    line, col = geos_line_col(lat, lon, proj)
    li = np.rint(line - first_line).astype(np.int64)
    ci = np.rint(col - 1).astype(np.int64)
    ok = (li >= 0) & (li < stack.shape[0]) & (ci >= 0) & (ci < stack.shape[1])
    out = np.full((size, size), np.nan, np.float32)
    out[ok] = stack[li[ok], ci[ok]]
    return out


def _resample_tb(segments, lat0, lon0, half, size):
    tbs = []
    proj = None
    for raw in segments:
        tb, first, proj = parse_segment(raw)
        tbs.append((first, tb))
    tbs.sort(key=lambda t: t[0])
    first_line = tbs[0][0]
    stack = np.concatenate([t[1] for t in tbs], axis=0)
    lat, lon = grid_latlon(lat0, lon0, half, size)
    line, col = geos_line_col(lat, lon, proj)
    li = np.rint(line - first_line).astype(np.int64)
    ci = np.rint(col - 1).astype(np.int64)
    ok = (li >= 0) & (li < stack.shape[0]) & (ci >= 0) & (ci < stack.shape[1])
    out = np.full((size, size), np.nan, np.float32)
    out[ok] = stack[li[ok], ci[ok]]
    enc = np.where(np.isnan(out), 0, np.clip(np.rint((out - ENC_MIN) / ENC_STEP), 1, 255)).astype(np.uint8)
    return enc


async def get_band(client, data_dir: Path, product: str, rid: str, lat0: float, lon0: float, when: datetime, half: int):
    """Newest complete scan at/before `when` -> (path to uint8 Tb grid, slot)."""
    band = BANDS[product]
    size = SIZES[half]
    segs = _needed_segments(lat0, lon0, half)
    slot = when.replace(minute=when.minute - when.minute % 10, second=0, microsecond=0)
    d = data_dir / "hsd" / product / rid / str(half)
    for _ in range(13):
        stamp = slot.strftime("%Y%m%d%H%M")
        path = d / f"{stamp}.bin"
        if path.exists():
            return path, slot
        ek = (product, rid, half, stamp)
        if _empty_until.get(ek, 0) > time.time():
            slot -= timedelta(minutes=10)
            continue
        async with _locks.setdefault(ek, asyncio.Lock()):
            if path.exists():
                return path, slot
            keys = await _scan_keys(client, band, slot)
            want = [k for k in keys if int(re.search(r"_S(\d\d)10\.DAT", k).group(1)) in segs]
            if len(want) == len(segs):
                raws = [await _download_segment(client, data_dir, k) for k in want]
                enc = await asyncio.to_thread(_resample_tb, raws, lat0, lon0, half, size)
                d.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".part")
                tmp.write_bytes(enc.tobytes())
                tmp.replace(path)
                for k in want:  # raw segments are only needed while resampling
                    (data_dir / "hsd_raw" / Path(k).name.replace(".bz2", "")).unlink(missing_ok=True)
                return path, slot
            age = datetime.now(timezone.utc) - slot
            _empty_until[ek] = time.time() + (60 if age < timedelta(hours=1) else 86400)
            if len(_empty_until) > 500:                 # forget expired "nothing there" marks
                now_s = time.time()
                for k in [k for k, v in _empty_until.items() if v < now_s]:
                    _empty_until.pop(k, None)
        slot -= timedelta(minutes=10)
    return None, None


# ---------------------------------------------------------------- SLIDER GeoColor
_slider_times = {"t": 0, "list": []}


async def slider_times(client):
    if time.time() - _slider_times["t"] < 120:
        return _slider_times["list"]
    r = await client.get(f"{SLIDER}/data/json/himawari/full_disk/geocolor/latest_times.json")
    r.raise_for_status()
    lst = sorted(r.json()["timestamps_int"])
    _slider_times.update(t=time.time(), list=lst)
    return lst


def _slider_zoom(half):
    return 4 if half <= 512 else 3 if half <= 1536 else 2     # ~1, 2 and 4 km tiles


async def get_geocolor(client, data_dir: Path, rid: str, lat0: float, lon0: float, when: datetime, half: int):
    times = await slider_times(client)
    want = int(when.strftime("%Y%m%d%H%M%S"))
    cands = [t for t in times if t <= want]
    if not cands:
        return None, None
    ts = cands[-1]
    slot = datetime.strptime(str(ts), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    path = data_dir / "geocolor" / rid / str(half) / f"{ts}.png"
    if path.exists():
        return path, slot
    async with _locks.setdefault(("gc", rid, half, ts), asyncio.Lock()):
        if path.exists():
            return path, slot
        z = _slider_zoom(half)
        tile = 688
        n = tile * 2 ** z                       # full disk width in pixels at this zoom
        scale = n / 5500.0                      # SLIDER pixels per 2 km HSD pixel
        size = SIZES[half]
        lat, lon = grid_latlon(lat0, lon0, half, size)
        line, col = geos_line_col(lat, lon, DEFAULT_PROJ)
        py = (line - 0.5) * scale
        px = (col - 0.5) * scale
        r0, r1 = int(np.floor(np.nanmin(py) / tile)), int(np.floor(np.nanmax(py) / tile))
        c0, c1 = int(np.floor(np.nanmin(px) / tile)), int(np.floor(np.nanmax(px) / tile))
        mosaic = np.zeros(((r1 - r0 + 1) * tile, (c1 - c0 + 1) * tile, 3), np.uint8)
        day = slot.strftime("%Y/%m/%d")
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                url = f"{SLIDER}/data/imagery/{day}/himawari---full_disk/geocolor/{ts}/{z:02d}/{r:03d}_{c:03d}.png"
                resp = await client.get(url)
                if resp.status_code != 200:
                    return None, None
                im = Image.open(io.BytesIO(resp.content)).convert("RGB")
                mosaic[(r - r0) * tile:(r - r0 + 1) * tile, (c - c0) * tile:(c - c0 + 1) * tile] = np.asarray(im)
        yi = np.clip(np.floor(py - r0 * tile).astype(np.int64), 0, mosaic.shape[0] - 1)
        xi = np.clip(np.floor(px - c0 * tile).astype(np.int64), 0, mosaic.shape[1] - 1)
        out = mosaic[yi, xi]
        path.parent.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO()
        Image.fromarray(out).save(buf, "PNG", optimize=False)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(buf.getvalue())
        tmp.replace(path)
    return path, slot


# ---------------------------------------------------------------- multi-band RGB composites (all 2 km IR bands)
def _scale(x, lo, hi, gamma=1.0):
    v = np.clip((x - lo) / (hi - lo), 0, 1)
    return v ** (1 / gamma)


def _cos_sza(lat, lon, when):
    """Cosine of the solar zenith angle (simple NOAA formula), for evening out visible brightness."""
    doy = when.timetuple().tm_yday
    g = 2 * np.pi / 365 * (doy - 1 + (when.hour - 12) / 24)
    decl = 0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g) + 0.000907 * np.sin(2 * g)
    eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g) - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    tst = when.hour * 60 + when.minute + eqt + 4 * lon
    ha = np.radians(tst / 4 - 180)
    la = np.radians(lat)
    return np.sin(la) * np.sin(decl) + np.cos(la) * np.cos(decl) * np.cos(ha)


def _dcp(b, lat, lon, when):
    """JMA/EUMETSAT day cloud phase distinction. Red: 10.4 um (cold = bright), green: visible reflectance
    (B02 at 1 km stands in for the 0.5 km B03), blue: 1.6 um (water cloud bright, ice cloud dark).
    Thick ice tops look yellow/orange, low water cloud cyan/blue-white, new convection green, land dark."""
    mu = np.clip(_cos_sza(lat, lon, when), 0.1, 1)
    vis = b["B02"] / mu
    nir = b["B05"] / mu
    night = _cos_sza(lat, lon, when) < 0.05
    r = _scale(280.67 - b["B13"], 0, 61.05)
    g = _scale(vis, 0, 0.78)
    bl = _scale(nir, 0.01, 0.59)
    return tuple(np.where(night, 0, ch) for ch in (r, g, bl))


RGBS = {
    # daytime: ice versus water cloud tops (glaciating towers turn from green/white to yellow/orange)
    "dcp": {"bands": ["B13", "B02", "B05"], "f": _dcp, "geo": True},
    # EUMETSAT/JMA night microphysics: fog and low cloud stand out at night
    "nmp": {"bands": ["B15", "B13", "B07"],
            "f": lambda b: (_scale(b["B15"] - b["B13"], -4, 2), _scale(b["B13"] - b["B07"], 0, 10), _scale(b["B13"], 243, 293))},
    # dust RGB: airborne dust shows magenta/pink
    "dust": {"bands": ["B15", "B13", "B11"],
             "f": lambda b: (_scale(b["B15"] - b["B13"], -4, 2), _scale(b["B13"] - b["B11"], 0, 15, 2.5), _scale(b["B13"], 261, 289))},
}


async def get_rgb(client, data_dir: Path, product: str, rid: str, lat0: float, lon0: float, when: datetime, half: int):
    spec = RGBS[product]
    size = SIZES[half]
    segs = _needed_segments(lat0, lon0, half)
    slot = when.replace(minute=when.minute - when.minute % 10, second=0, microsecond=0)
    d = data_dir / "hsd" / product / rid / str(half)
    for _ in range(13):
        stamp = slot.strftime("%Y%m%d%H%M")
        path = d / f"{stamp}.png"
        if path.exists():
            return path, slot
        ek = (product, rid, half, stamp)
        if _empty_until.get(ek, 0) > time.time():
            slot -= timedelta(minutes=10)
            continue
        async with _locks.setdefault(ek, asyncio.Lock()):
            if path.exists():
                return path, slot
            want = {}
            for band in spec["bands"]:
                keys = await _scan_keys(client, band, slot)
                want[band] = [k for k in keys if int(re.search(r"_S(\d\d)10\.DAT", k).group(1)) in segs]
            if all(len(v) == len(segs) for v in want.values()):
                bands = {}
                for band, keys in want.items():
                    raws = [await _download_segment(client, data_dir, k) for k in keys]
                    bands[band] = await asyncio.to_thread(_resample_float, raws, lat0, lon0, half, size)
                def compose(bands=bands, spec=spec, slot=slot):      # the RGB maths and PNG encode: off the event loop
                    if spec.get("geo"):
                        la, lo = grid_latlon(lat0, lon0, half, size)
                        r, g, b = spec["f"](bands, la, lo, slot)
                    else:
                        r, g, b = spec["f"](bands)
                    rgb = np.nan_to_num(np.stack([r, g, b], axis=-1) * 255).astype(np.uint8)
                    d.mkdir(parents=True, exist_ok=True)
                    buf = io.BytesIO()
                    Image.fromarray(rgb).save(buf, "PNG")
                    tmp = path.with_suffix(".part")
                    tmp.write_bytes(buf.getvalue())
                    tmp.replace(path)
                await asyncio.to_thread(compose)
                for keys in want.values():
                    for k in keys:
                        (data_dir / "hsd_raw" / Path(k).name.replace(".bz2", "")).unlink(missing_ok=True)
                return path, slot
            age = datetime.now(timezone.utc) - slot
            _empty_until[ek] = time.time() + (60 if age < timedelta(hours=1) else 86400)
        slot -= timedelta(minutes=10)
    return None, None


def prune(data_dir: Path, keep_hours: float):
    cutoff = time.time() - keep_hours * 3600
    for sub in ("hsd", "geocolor", "hsd_raw"):
        root = data_dir / sub
        if root.exists():
            for f in root.rglob("*"):
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink(missing_ok=True)
