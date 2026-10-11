"""Himawari-9 imagery from NASA GIBS (free, no key).

GIBS serves Himawari AHI layers every 10 minutes in plain lat/lon (EPSG:4326). We request
a square 1024 km box centred on the radar at 1 km/pixel, using the same flat-earth scaling
BoM uses for its radar images, so it lines up with the radar without reprojection.
"""
import asyncio
import math
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
from PIL import Image
import io

WMS = os.getenv("GIBS_WMS", "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi")
HALF_KM = 512                       # local view: 1024 km box at 1 km/px
SIZES = {512: 1024, 1536: 1536, 2600: 1300}     # regional 3072 km box at 2 km/px; Australia-wide 5200 km at 4 km/px
LAYERS = {
    "ir": "Himawari_AHI_Band13_Clean_Infrared",
    "vis": "Himawari_AHI_Band3_Red_Visible_1km",
    "airmass": "Himawari_AHI_Air_Mass",
}
_empty_until: dict = {}     # (layer, rid, stamp) -> retry-after timestamp
_locks: dict = {}


def has_pixels(png: bytes) -> bool:
    """GIBS answers times that aren't fully processed with transparent or partly filled
    images (tiles arrive in strips), so only accept images that are essentially complete."""
    try:
        im = Image.open(io.BytesIO(png))
        if "A" not in im.getbands() and im.mode != "P":
            return True
        hist = im.convert("RGBA").getchannel("A").histogram()
        return hist[0] / max(1, sum(hist)) < 0.02
    except Exception:
        return False


def _grid_latlon(lat0, lon0, half, size):
    k = 2 * half / size
    y = half - (np.arange(size) + 0.5) * k
    x = -half + (np.arange(size) + 0.5) * k
    lat = np.repeat((lat0 + y / 111.11)[:, None], size, axis=1)
    lon = lon0 + x[None, :] / (111.11 * np.cos(np.radians(lat)))
    return lat, lon


def wide_bbox(lat0, lon0, half):
    """Lat/lon box that fully contains the +-half km flat-earth (sinusoidal) square."""
    dlat = half / 111.11
    far = min(85.0, abs(lat0) + dlat)
    dlon = min(179.0, half / (111.11 * math.cos(math.radians(far))))
    return lon0 - dlon, max(-89.9, lat0 - dlat), lon0 + dlon, min(89.9, lat0 + dlat)


def to_flat(png: bytes, box, lat0, lon0, half, size) -> bytes:
    """Resample a lat/lon (EPSG:4326) image onto wxdeck's radar-centred flat-earth grid, so wide
    views line up with radar, towns and Himawari data (which all use per-row cos(latitude))."""
    src = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))
    H, W = src.shape[:2]
    x0, y0, x1, y1 = box
    lat, lon = _grid_latlon(lat0, lon0, half, size)
    px = np.clip(((lon - x0) / (x1 - x0) * W).astype(np.int64), 0, W - 1)
    py = np.clip(((y1 - lat) / (y1 - y0) * H).astype(np.int64), 0, H - 1)
    out = src[py, px]
    buf = io.BytesIO()
    Image.fromarray(out, "RGBA").save(buf, "PNG")
    return buf.getvalue()


async def wms_flat(client, layer, lat0, lon0, half, size, time_param=None, fmt="image/png", transparent=True):
    box = wide_bbox(lat0, lon0, half)
    aspect = (box[2] - box[0]) / (box[3] - box[1]) * math.cos(math.radians(lat0))
    w = int(min(4096, size * max(1.0, aspect) * 1.2)); h = int(min(4096, size * 1.2))
    params = {"SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.1.1", "LAYERS": layer, "SRS": "EPSG:4326",
              "BBOX": f"{box[0]},{box[1]},{box[2]},{box[3]}", "WIDTH": w, "HEIGHT": h, "FORMAT": fmt,
              "TRANSPARENT": "TRUE" if transparent else "FALSE"}
    if time_param:
        params["TIME"] = time_param
    r = await client.get(WMS, params=params)
    r.raise_for_status()
    return r.content, box


def bbox(lat, lon, half=HALF_KM):
    dlat = half / 111.11
    dlon = half / (111.11 * math.cos(math.radians(lat)))
    return lon - dlon, lat - dlat, lon + dlon, lat + dlat


async def get_image(client: httpx.AsyncClient, data_dir: Path, layer: str, rid: str, lat: float, lon: float, when: datetime, half: int = HALF_KM):
    """Return (path, slot_time) for the newest image at or before `when`, searching back 2 hours."""
    if layer not in LAYERS or half not in SIZES:
        raise ValueError("unknown layer")
    size = SIZES[half]
    slot = when.replace(minute=when.minute - when.minute % 10, second=0, microsecond=0)
    d = data_dir / "sat" / layer / rid / str(half)
    for _ in range(13):
        stamp = slot.strftime("%Y%m%d%H%M")
        path = d / f"{stamp}.png"
        if path.exists():
            return path, slot
        key = (layer, rid, half, stamp)
        if _empty_until.get(key, 0) > time.time():
            slot -= timedelta(minutes=10)
            continue
        lock = _locks.setdefault(key, asyncio.Lock())
        async with lock:
            if path.exists():
                return path, slot
            try:
                raw, box = await wms_flat(client, LAYERS[layer], lat, lon, half, size, slot.strftime("%Y-%m-%dT%H:%M:00Z"))
            except httpx.HTTPStatusError:
                raw, box = b"", None
            if raw[:4] == b"\x89PNG" and has_pixels(raw):
                flat = await asyncio.to_thread(to_flat, raw, box, lat, lon, half, size)
                d.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".part")
                tmp.write_bytes(flat)
                tmp.replace(path)
                return path, slot
            age = datetime.now(timezone.utc) - slot
            # recent slots may still be processing; old empty slots are just missing
            _empty_until[key] = time.time() + (300 if age < timedelta(hours=3) else 86400)
        slot -= timedelta(minutes=10)
    return None, None


async def get_coastlines(client: httpx.AsyncClient, data_dir: Path, rid: str, lat: float, lon: float, half: int):
    """Static coastline overlay for the satellite view (cached forever)."""
    if half not in SIZES:
        raise ValueError("bad size")
    path = data_dir / "sat" / "coast" / rid / f"{half}.png"
    if path.exists():
        return path
    raw, box = await wms_flat(client, "Coastlines_15m", lat, lon, half, SIZES[half])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(await asyncio.to_thread(to_flat, raw, box, lat, lon, half, SIZES[half]))
    return path


async def national_base(client, data_dir: Path, lat0, lon0, half, size=1300):
    """Dark land/sea basemap with terrain shading for the all-Australia view (cached forever)."""
    path = data_dir / "sat" / "natbase" / f"{lat0}_{lon0}_{half}.png"
    if path.exists():
        return path
    land_raw, box = await wms_flat(client, "OSM_Land_Mask", lat0, lon0, half, size, fmt="image/png")
    relief_raw, box2 = await wms_flat(client, "ASTER_GDEM_Greyscale_Shaded_Relief", lat0, lon0, half, size, fmt="image/jpeg", transparent=False)
    land = np.asarray(Image.open(io.BytesIO(await asyncio.to_thread(to_flat, land_raw, box, lat0, lon0, half, size))).convert("RGBA"))
    relief = np.asarray(Image.open(io.BytesIO(await asyncio.to_thread(to_flat, relief_raw, box2, lat0, lon0, half, size))).convert("L")).astype(np.float32)
    is_land = land[..., 3] > 64
    shade = (relief - 128) / 128.0
    out = np.zeros((size, size, 4), np.uint8)
    out[..., 3] = 255
    base = np.array([27, 38, 40], np.float32)
    lit = np.clip(base[None, None, :] * (1 + 0.6 * shade[..., None]) + 8 * (shade[..., None] > 0), 0, 255)
    out[..., :3] = np.where(is_land[..., None], lit, np.array([11, 24, 32], np.float32)).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out, "RGBA").save(path)
    return path


def prune(data_dir: Path, keep_hours: float):
    cutoff = time.time() - keep_hours * 3600
    root = data_dir / "sat"
    if root.exists():
        for f in root.rglob("*"):
            # coastlines and the national basemap are kept for good; frames and their WebP copies age out
            if f.suffix in (".png", ".webp", ".part") and "coast" not in f.parts and "natbase" not in f.parts:
                try:
                    if f.stat().st_mtime < cutoff:
                        f.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass
