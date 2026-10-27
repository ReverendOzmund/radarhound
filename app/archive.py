"""Raw radar volumes from the BoM/NCI Level 1 archive (rq0).

Each day is one big zip (~1.3 GB) of 5-minute ODIM HDF5 volumes. We never download
the whole zip: the server supports HTTP range requests, so we read the zip's central
directory once per day and then pull single volumes (~5 MB) on demand.
"""
import asyncio
import json
import math
import logging
import os
import re
import struct
import time
import zlib
from pathlib import Path

import h5py
import httpx
import numpy as np

log = logging.getLogger("radarhound.archive")

NCI = os.getenv("ARCHIVE_BASE", "https://thredds.nci.org.au/thredds")
CACHE_GB = float(os.getenv("ARCHIVE_CACHE_GB", "5"))

_locks: dict = {}
_days_cache: dict = {}


def _lock(key):
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]


def zip_url(rid, date):
    return f"{NCI}/fileServer/rq0/{rid}/{date[:4]}/vol/{rid}_{date}.pvol.zip"


async def list_days(client: httpx.AsyncClient, rid: str, years: list[int]):
    key = (rid, tuple(years))
    hit = _days_cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    days = []
    for y in years:
        r = await client.get(f"{NCI}/catalog/rq0/{rid}/{y}/vol/catalog.html")
        if r.status_code == 200:
            days += re.findall(rf"{rid}_(\d{{8}})\.pvol\.zip", r.text)
    days = sorted(set(days), reverse=True)
    _days_cache[key] = (time.time() + 3600, days)
    return days


async def _range(client, url, start, end):
    r = await client.get(url, headers={"Range": f"bytes={start}-{end}"})
    if r.status_code not in (200, 206):
        raise RuntimeError(f"range request failed: HTTP {r.status_code}")
    return r.content


def _parse_central_directory(cd: bytes):
    entries = {}
    p = 0
    while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
        method, = struct.unpack_from("<H", cd, p + 10)
        csize, usize = struct.unpack_from("<II", cd, p + 20)
        nlen, xlen, clen = struct.unpack_from("<HHH", cd, p + 28)
        lho, = struct.unpack_from("<I", cd, p + 42)
        name = cd[p + 46:p + 46 + nlen].decode()
        extra = cd[p + 46 + nlen:p + 46 + nlen + xlen]
        if 0xFFFFFFFF in (csize, usize, lho):  # zip64 extra field
            q = 0
            while q + 4 <= len(extra):
                hid, hlen = struct.unpack_from("<HH", extra, q)
                if hid == 1:
                    vals = list(struct.unpack_from("<" + "Q" * (hlen // 8), extra, q + 4))
                    if usize == 0xFFFFFFFF: usize = vals.pop(0)
                    if csize == 0xFFFFFFFF: csize = vals.pop(0)
                    if lho == 0xFFFFFFFF: lho = vals.pop(0)
                q += 4 + hlen
        m = re.search(r"_(\d{6})\.pvol\.h5$", name)
        if m:
            entries[m.group(1)] = {"name": name, "method": method, "csize": csize, "lho": lho}
        p += 46 + nlen + xlen + clen
    return entries


async def day_index(client, data_dir: Path, rid: str, date: str):
    d = data_dir / "archive" / rid / date
    idx_file = d / "index.json"
    if idx_file.exists():
        return json.loads(idx_file.read_text())
    async with _lock(("idx", rid, date)):
        if idx_file.exists():
            return json.loads(idx_file.read_text())
        url = zip_url(rid, date)
        head = await client.head(url)
        if head.status_code != 200:
            raise FileNotFoundError(f"no archive for radar {rid} on {date}")
        size = int(head.headers["content-length"])
        tail_len = min(size, 256 * 1024)
        tail = await _range(client, url, size - tail_len, size - 1)
        e = tail.rfind(b"PK\x05\x06")
        if e < 0:
            raise RuntimeError("zip end record not found")
        cd_size, cd_off = struct.unpack_from("<II", tail, e + 12)
        z64 = tail.rfind(b"PK\x06\x06")
        if cd_off == 0xFFFFFFFF and z64 >= 0:
            cd_size, cd_off = struct.unpack_from("<QQ", tail, z64 + 40)
        tail_start = size - tail_len
        if cd_off >= tail_start:
            cd = tail[cd_off - tail_start:cd_off - tail_start + cd_size]
        else:
            cd = await _range(client, url, cd_off, cd_off + cd_size - 1)
        entries = _parse_central_directory(cd)
        if not entries:
            raise RuntimeError("archive zip has no volumes")
        d.mkdir(parents=True, exist_ok=True)
        idx_file.write_text(json.dumps(entries))
        return entries


async def fetch_volume(client, data_dir: Path, rid: str, date: str, hhmmss: str) -> Path:
    d = data_dir / "archive" / rid / date
    path = d / f"{hhmmss}.h5"
    if path.exists():
        os.utime(path)
        return path
    entries = await day_index(client, data_dir, rid, date)
    ent = entries.get(hhmmss)
    if not ent:
        raise FileNotFoundError(f"no scan at {hhmmss}")
    async with _lock(("vol", rid, date, hhmmss)):
        if path.exists():
            return path
        url = zip_url(rid, date)
        start = ent["lho"]
        blob = await _range(client, url, start, start + 30 + 1024 + ent["csize"])
        if blob[:4] != b"PK\x03\x04":
            raise RuntimeError("bad local header")
        nlen, xlen = struct.unpack_from("<HH", blob, 26)
        off = 30 + nlen + xlen
        comp = blob[off:off + ent["csize"]]
        if len(comp) < ent["csize"]:  # extra field longer than guessed
            comp = await _range(client, url, start + off, start + off + ent["csize"] - 1)
        raw = zlib.decompressobj(-15).decompress(comp) if ent["method"] == 8 else comp
        d.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(raw)
        tmp.replace(path)
    prune_cache(data_dir)
    return path


def prune_cache(data_dir: Path):
    """Keep the archive cache under ARCHIVE_CACHE_GB, oldest volumes first. A volume's derived products
    (.derived.npz/.txt, .rotation.json) count towards the limit and go with it; leftovers are removed too."""
    root = data_dir / "archive"
    if not root.exists():
        return
    vols = []
    for f in root.rglob("*.h5"):
        try:
            side = [x for x in (f.with_suffix(".derived.npz"), f.with_suffix(".derived.txt"), f.with_suffix(".rotation.json")) if x.exists()]
            vols.append((f.stat().st_mtime, f, side, f.stat().st_size + sum(x.stat().st_size for x in side)))
        except FileNotFoundError:
            continue
    vols.sort(key=lambda v: v[0])
    total = sum(v[3] for v in vols)
    limit = CACHE_GB * 1024 ** 3
    while vols and total > limit:
        _, f, side, size = vols.pop(0)
        total -= size
        for x in [f, *side]:
            x.unlink(missing_ok=True)
    for x in [*root.rglob("*.derived.npz"), *root.rglob("*.derived.txt"), *root.rglob("*.rotation.json"), *root.rglob("*.part.npz")]:
        stem = x.name.split(".")[0]
        if not (x.parent / f"{stem}.h5").exists():
            x.unlink(missing_ok=True)


def _s(v):
    return v.decode() if isinstance(v, (bytes, np.bytes_)) else v


_meta_cache: dict = {}


def volume_meta(path: Path):
    """Volume metadata, cached per file (it is read by every sweep, product and detection request)."""
    key = (str(path), path.stat().st_mtime)
    if key not in _meta_cache:
        if len(_meta_cache) > 300:
            _meta_cache.clear()
        _meta_cache[key] = _volume_meta(path)
    return _meta_cache[key]


def _volume_meta(path: Path):
    with h5py.File(path, "r") as f:
        where = dict(f["where"].attrs)
        what = dict(f["what"].attrs)
        tilts = []
        for k in f:
            if not k.startswith("dataset"):
                continue
            g = f[k]
            w = dict(g["where"].attrs)
            el = float(w["elangle"])
            if el >= 60:  # skip vertically pointing scan
                continue
            gw = dict(g["what"].attrs)
            moments = {}
            for q in g:
                if not q.startswith("data"):
                    continue
                qw = dict(g[q]["what"].attrs)
                moments[_s(qw["quantity"])] = {
                    "key": q, "gain": float(qw["gain"]), "offset": float(qw["offset"]),
                    "nodata": float(qw["nodata"]), "undetect": float(qw["undetect"]),
                    "dtype": str(g[q]["data"].dtype),
                }
            if all(q in moments for q in ("DBZH", "ZDR", "RHOHV")):
                # computed per tilt on request: hydrometeor classification and rain rate
                moments["HCA"] = {"key": "HCA", "gain": 1.0, "offset": 0.0, "nodata": 0.0, "undetect": 255.0, "dtype": "uint8"}
                moments["RR"] = {"key": "RR", "gain": 0.5, "offset": 0.0, "nodata": 0.0, "undetect": 255.0, "dtype": "uint8"}
            tilts.append({
                "key": k, "elev": round(el, 2), "nbins": int(w["nbins"]), "nrays": int(w["nrays"]),
                "rscale": float(w["rscale"]), "rstart": float(w.get("rstart", 0.0)),
                "time": f"{_s(gw.get('startdate'))}{_s(gw.get('starttime'))}",
                "nyquist": float(g["how"].attrs["NI"]) if "how" in g and "NI" in g["how"].attrs else None,
                "moments": moments,
            })
        tilts.sort(key=lambda t: t["elev"])
        return {
            "lat": float(where["lat"]), "lon": float(where["lon"]), "height": float(where.get("height", 0)),
            "time": f"{_s(what['date'])}{_s(what['time'])}", "tilts": tilts,
        }


def sweep_bytes(path: Path, tilt_key: str, data_key: str) -> tuple[bytes, str]:
    with h5py.File(path, "r") as f:
        arr = f[tilt_key][data_key]["data"][:]
    if arr.dtype == np.uint16:
        return arr.astype("<u2").tobytes(), "uint16"
    return arr.astype(np.uint8).tobytes(), "uint8"


RE43 = 8494.7   # km


def _moment(g, quantity):
    for q in g:
        if q.startswith("data") and _s(g[q]["what"].attrs["quantity"]) == quantity:
            w = g[q]["what"].attrs
            raw = g[q]["data"][:]
            v = raw.astype(np.float32) * float(w["gain"]) + float(w["offset"])
            v[(raw == w["nodata"]) | (raw == w["undetect"])] = np.nan
            return v
    return None


def polarimetric_sweep(path: Path, tilt_key: str, product: str, h0_km: float):
    """Rule-based hydrometeor classification (HCA) or rain rate (RR) for one tilt.
    HCA classes: 1 biological, 2 clutter, 3 ice crystals, 4 dry snow, 5 wet snow (melting layer),
    6 rain, 7 heavy rain, 8 big drops, 9 graupel, 10 hail and rain, 11 large hail."""
    with h5py.File(path, "r") as f:
        g = f[tilt_key]
        Z = _moment(g, "DBZH")
        ZDR = _moment(g, "ZDR")
        RHO = _moment(g, "RHOHV")
        KDP = _moment(g, "KDP")
        w = dict(g["where"].attrs)
        height0 = float(f["where"].attrs.get("height", 0)) / 1000
    el = math.radians(float(w["elangle"]))
    rng = (float(w.get("rstart", 0)) + (np.arange(int(w["nbins"])) + 0.5) * float(w["rscale"]) / 1000)
    h = np.sqrt(rng ** 2 + RE43 ** 2 + 2 * rng * RE43 * math.sin(el)) - RE43 + height0
    H = np.broadcast_to(h[None, :], Z.shape)
    if KDP is None:
        KDP = np.zeros_like(Z)
    zd = np.nan_to_num(ZDR, nan=0.0)
    rho = np.nan_to_num(RHO, nan=1.0)
    kdp = np.nan_to_num(KDP, nan=0.0)
    z = Z
    valid = ~np.isnan(z)

    if product == "RR":
        with np.errstate(invalid="ignore", over="ignore"):
            r_z = (10 ** (np.minimum(z, 56) / 10) / 200) ** (1 / 1.6)
            r_k = 44.0 * np.abs(kdp) ** 0.822
        rr = np.where((kdp > 0.3) & (z > 38), r_k, r_z)
        rr = np.where(valid & (H < h0_km - 0.5) & (rho > 0.85) & (z > 5), rr, np.nan)
        enc = np.where(np.isnan(rr), 0, np.clip(np.rint(rr / 0.5), 1, 254)).astype(np.uint8)
        return enc.tobytes(), "uint8"

    c = np.zeros(z.shape, np.uint8)
    above = H > h0_km + 0.3
    melt = (H >= h0_km - 0.8) & (H <= h0_km + 0.3)
    below = H < h0_km - 0.8
    # below the melting layer
    c = np.where(valid & below, 6, c)
    c = np.where(valid & below & ((z >= 45) | (kdp > 1.5)), 7, c)
    c = np.where(valid & below & (zd > 3) & (z < 50), 8, c)
    # melting layer: wet snow has lowered correlation and raised ZDR
    c = np.where(valid & melt, np.where((z >= 45), 7, 6), c)
    c = np.where(valid & melt & (rho > 0.85) & (rho < 0.97) & (z > 20) & (z < 45) & (zd > 0.8), 5, c)
    # above: ice
    c = np.where(valid & above, 4, c)
    c = np.where(valid & above & (z < 25) & (zd > 1.5), 3, c)
    c = np.where(valid & above & (z >= 40) & (zd < 1.0), 9, c)
    # hail anywhere: very high reflectivity with near-zero ZDR (tumbling stones)
    c = np.where(valid & (z >= 50) & (zd < 1.0), 10, c)
    c = np.where(valid & (z >= 58) & (zd < 0.5) & (rho < 0.96), 11, c)
    # non-meteorological echoes
    c = np.where(valid & (rho < 0.8) & (z < 35), 1, c)
    c = np.where(valid & (rho < 0.7) & (z >= 35) & (H < 2), 2, c)
    return c.astype(np.uint8).tobytes(), "uint8"
