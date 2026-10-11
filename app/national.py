"""All-Australia radar mosaic.

Every BoM radar has a 512 km composite product (IDRxx1). We poll each one's loop page, keep the newest
frame, and every 10 minutes stitch them into one national image on the same flat-earth (sinusoidal)
projection the rest of wxdeck uses, centred on the middle of Australia. Where radars overlap, the
strongest echo wins. Output frames look exactly like a BoM reflectivity image (same 15-colour palette),
so the browser decodes, recolours and tracks cells on them like any other radar loop.
"""
import asyncio
import io
import json
import logging
import math
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

log = logging.getLogger("wxdeck.national")

LAT0, LON0 = -27.0, 133.5          # centre of the national view
HALF_KM = 2560
SIZE = 1024                        # 5 km pixels
PID = "AUS"
REFL = ["#f5f5ff", "#b4b4ff", "#7878ff", "#1414ff", "#00d8c3", "#009690", "#006666", "#ffff00", "#ffc800",
        "#ff9600", "#ff6400", "#ff0000", "#c80000", "#780000", "#280000"]
PAL = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in REFL], np.int32)

state = {"radars": {}, "last_cycle": None, "error": None, "frames_built": 0}
_maps: dict = {}                    # rid -> (national flat indices, source flat indices)


def _levels(png: bytes) -> np.ndarray:
    """BoM frame -> reflectivity level per pixel (0 = none, 1..15), nearest palette colour within tolerance."""
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA")).astype(np.int32)
    key = (a[..., 0] << 16) | (a[..., 1] << 8) | a[..., 2]
    key = np.where(a[..., 3] >= 128, key, -1)
    uniq, inv = np.unique(key, return_inverse=True)       # a frame only has a few dozen distinct colours
    lut = np.zeros(len(uniq), np.uint8)
    for i, k in enumerate(uniq):
        if k < 0:
            continue
        rgb = np.array([(k >> 16) & 255, (k >> 8) & 255, k & 255])
        d2 = ((PAL - rgb) ** 2).sum(1)
        j = int(d2.argmin())
        lut[i] = j + 1 if d2[j] <= 400 else 0
    return lut[inv].reshape(key.shape)


_lv_cache: dict = {}


def _levels_cached(path: Path):
    """Each radar's frame only changes every 5-10 minutes; decode it once."""
    key = (str(path), path.stat().st_mtime)
    hit = _lv_cache.get(key)
    if hit is None:
        hit = _levels(path.read_bytes()).ravel()
        _lv_cache[key] = hit
        if len(_lv_cache) > 200:
            for k in list(_lv_cache)[:len(_lv_cache) - 150]:
                del _lv_cache[k]
    return hit


def _mapping(rid, rlat, rlon, km):
    key = (rid, round(rlat, 3), round(rlon, 3), km)
    if key in _maps:
        return _maps[key]
    k = 2 * HALF_KM / SIZE
    # national pixels near this radar only
    cx = (rlon - LON0) * 111.11 * math.cos(math.radians(rlat))
    cy = (rlat - LAT0) * 111.11
    i0 = max(0, int((cx - km * 1.3 + HALF_KM) / k)); i1 = min(SIZE, int((cx + km * 1.3 + HALF_KM) / k) + 1)
    j0 = max(0, int((HALF_KM - cy - km * 1.3) / k)); j1 = min(SIZE, int((HALF_KM - cy + km * 1.3) / k) + 1)
    if i1 <= i0 or j1 <= j0:                      # radar outside the national frame (e.g. offshore territories)
        _maps[key] = (np.zeros(0, np.int64), np.zeros(0, np.int64))
        return _maps[key]
    jj, ii = np.mgrid[j0:j1, i0:i1]
    x = -HALF_KM + (ii + 0.5) * k
    y = HALF_KM - (jj + 0.5) * k
    lat = LAT0 + y / 111.11
    lon = LON0 + x / (111.11 * np.cos(np.radians(lat)))
    kpp = km / 256
    xr = (lon - rlon) * 111.11 * np.cos(np.radians(lat))
    yr = (lat - rlat) * 111.11
    px = np.floor(256 + xr / kpp).astype(np.int64)
    py = np.floor(256 - yr / kpp).astype(np.int64)
    ok = (px >= 0) & (px < 512) & (py >= 0) & (py < 512) & (np.hypot(xr, yr) <= km)
    nat = (jj[ok] * SIZE + ii[ok]).astype(np.int64)
    src = (py[ok] * 512 + px[ok]).astype(np.int64)
    _maps[key] = (nat, src)
    return nat, src


def known_ids(data_dir: Path) -> set:
    """BoM radar ids seen so far (from this run, or the list saved by a previous one)."""
    ids = set(state["radars"])
    f = data_dir / "national_radars.json"
    if len(ids) < 20 and f.exists():
        try:
            ids |= set(json.loads(f.read_text()))
        except ValueError:
            pass
    return ids


async def radar_ids(client, bom, data_dir: Path | None = None):
    """Every BoM radar id, from BoM's national radar page. That page sometimes refuses requests for an hour
    or more (403), so the last good list is kept on disk and used meanwhile."""
    saved = data_dir / "national_radars.json" if data_dir else None
    try:
        r = await client.get(f"{bom}/australia/radar/")
        r.raise_for_status()
        ids = sorted({m for m in re.findall(r"IDR(\d+)3\.loop\.shtml", r.text)}, key=int)
        if len(ids) < 20:
            raise ValueError(f"only {len(ids)} radars listed")
        if saved:
            saved.write_text(json.dumps(ids))
        return ids
    except (httpx.HTTPError, ValueError) as e:
        known = sorted(state["radars"], key=int)
        if not known and saved and saved.exists():
            try:
                known = json.loads(saved.read_text())
            except ValueError:
                known = []
        if known:
            log.warning("BoM radar list unavailable (%s); using the last known %d radars", e, len(known))
            return known
        raise


async def poll_once(client, bom, frames_dir: Path):
    ids = await radar_ids(client, bom, frames_dir.parent)
    for rid in ids:
        info = state["radars"].setdefault(rid, {"id": rid, "suffix": "1", "lat": None, "lon": None, "km": 512, "name": rid})
        for suf in ([info["suffix"]] + [s for s in ("1", "2") if s != info["suffix"]]):
            pid = f"IDR{rid}{suf}"
            try:
                r = await client.get(f"{bom}/products/{pid}.loop.shtml")
            except httpx.HTTPError:
                continue
            if r.status_code != 200:
                continue
            html = r.text
            names = re.findall(r'theImageNames\[\d+\]\s*=\s*"(/radar/[^"]+\.png)"', html)
            km = re.search(r"^\s*Km\s*=\s*(\d+)", html, re.M)
            lat = re.search(r'var lat\s*=\s*(-?[\d.]+)', html)
            lon = re.search(r'var lon\s*=\s*(-?[\d.]+)', html)
            title = re.search(r"<h1>\s*\d+\s*km\s+(?:composite\s+)?(.+?)\s+Radar Loop", html)
            if not (names and lat and lon):
                continue
            info.update(suffix=suf, lat=float(lat.group(1)), lon=float(lon.group(1)), km=int(km.group(1)) if km else 512,
                        name=title.group(1) if title else rid, pid=pid)
            newest = names[-1]
            dest = frames_dir / pid / newest.rsplit("/", 1)[-1]
            if not dest.exists():
                b = await client.get(f"{bom}{newest}")
                if b.status_code == 200 and b.content[:4] == b"\x89PNG":
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(b.content)
            break
        await asyncio.sleep(0.25)


FRAME_T = re.compile(r"\.T\.(\d{12})\.png$")


def build_mosaic(frames_dir: Path, slot: datetime, window_min=15):
    """Stitch the newest frame of every radar from the `window_min` minutes up to `slot`."""
    out = np.zeros(SIZE * SIZE, np.uint8)
    used = 0
    for rid, info in state["radars"].items():
        if info.get("lat") is None or not info.get("pid"):
            continue
        d = frames_dir / info["pid"]
        best = None
        for f in d.glob("*.png") if d.exists() else []:
            m = FRAME_T.search(f.name)
            if not m:
                continue
            t = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            if slot - timedelta(minutes=window_min) < t <= slot and (best is None or t > best[0]):
                best = (t, f)
        if not best:
            continue
        try:
            lv = _levels_cached(best[1])
        except Exception:
            continue
        nat, src = _mapping(rid, info["lat"], info["lon"], info["km"])
        np.maximum.at(out, nat, lv[src])
        used += 1
    if used < 5:
        return None, used
    lv = out.reshape(SIZE, SIZE)
    rgba = np.zeros((SIZE, SIZE, 4), np.uint8)
    has = lv > 0
    rgba[has, :3] = PAL[lv[has] - 1]
    rgba[has, 3] = 255
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue(), used


async def run(client, bom, frames_dir: Path, every_s: int):
    while True:
        start = time.time()
        try:
            await poll_once(client, bom, frames_dir)
            now = datetime.now(timezone.utc)
            stamp = now.replace(minute=now.minute - now.minute % 5, second=0, microsecond=0)
            for s in (stamp,):
                path = frames_dir / PID / f"{PID}.T.{s:%Y%m%d%H%M}.png"
                png, used = await asyncio.to_thread(build_mosaic, frames_dir, now)
                if png:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = path.with_suffix(".part")
                    tmp.write_bytes(png)
                    tmp.replace(path)
                    state["frames_built"] += 1
                    state["radars_used"] = used
            state.update(last_cycle=datetime.now(timezone.utc).isoformat(), error=None)
            log.info("national cycle done in %.0fs (%d radars)", time.time() - start, len(state["radars"]))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            state["error"] = str(e)
            log.warning("national cycle failed: %s", e)
        await asyncio.sleep(max(30, every_s - (time.time() - start)))
