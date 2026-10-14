"""wxdeck - self-hosted radar + weather workstation.

Polls BoM radar loop pages, archives every frame to disk (so loops can run
far longer than BoM's 7 frames), and proxies BoM observations and Open-Meteo
forecasts with caching. All data sources are free and need no API keys.
"""
import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import archive, bomftp, bomwarn, derived, extras, himawari, lightning, national, nowcast, satellite, speech, verify, warnings_engine as wxw
from zoneinfo import ZoneInfo
import numpy as np

log = logging.getLogger("wxdeck")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ---------------------------------------------------------------- config
def env_list(name, default):
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]

BOM = os.getenv("BOM_BASE", "https://reg.bom.gov.au")
# where BoM data (radar, warnings, observations) comes from: "ftp" (BoM's anonymous FTP feed, the channel
# BoM offers for automated access), "web" (the website, which blocks busy addresses with 403s) or "auto"
# (FTP, falling back to the website while FTP is unreachable)
RADAR_SOURCE = os.getenv("BOM_SOURCE", os.getenv("RADAR_SOURCE", "auto")).lower()
RADARS = env_list("RADARS", "70")
PRODUCTS = env_list("PRODUCTS", "4,3,2,1,I,A,B,C,D")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "120"))
RETENTION_HOURS = float(os.getenv("RETENTION_HOURS", "48"))
STATIONS = env_list("STATIONS", "IDW60901.94608,IDW60901.94151,IDW60901.94602")
OBS_MAP_PRODUCT = os.getenv("OBS_MAP_PRODUCT", "IDW60920")
WXWARN = os.getenv("WXDECK_WARNINGS", "on").lower() not in ("0", "off", "false", "no")
NATIONAL = os.getenv("NATIONAL", "on").lower() not in ("0", "off", "false", "no")
NATIONAL_POLL = int(os.getenv("NATIONAL_POLL_SECONDS", "360"))
ALL_OBS = ["IDW60920", "IDN60920", "IDV60920", "IDQ60920", "IDS60920", "IDT60920", "IDD60920"]
ALL_WARNINGS = ["IDZ00060.warnings_wa", "IDZ00054.warnings_nsw", "IDZ00059.warnings_vic", "IDZ00056.warnings_qld",
                "IDZ00057.warnings_sa", "IDZ00058.warnings_tas", "IDZ00055.warnings_nt", "IDZ00085.warnings_act"]
WARNINGS_FEED = os.getenv("WARNINGS_FEED", "IDZ00060.warnings_wa")       # BoM public warnings RSS for your state
# BoM forecast districts / areas that count as "near home" for BoM warnings, e.g. "Lower West,Perth Metropolitan"
# (towns within the alert distance of home are matched automatically as well)
BOM_AREAS = [a.strip().lower() for a in os.getenv("BOM_AREAS", "").split(",") if a.strip()]   # state-wide latest obs (WA); IDN/IDV/IDQ/IDS/IDT/IDD60920 elsewhere
HOME = {
    "name": os.getenv("HOME_NAME", "Home"),
    "lat": float(os.getenv("HOME_LAT", "-31.95")),
    "lon": float(os.getenv("HOME_LON", "115.86")),
}
TZ_NAME = os.getenv("TZ_NAME", "Australia/Perth")
SETTINGS_FILE = Path(os.getenv("DATA_DIR", "/data")) / "settings.json"
CASES: list = []
SPOTS: list = []
REPORTS: list = []
OBS_SOUNDING_STATION = os.getenv("OBS_SOUNDING_STATION", "94610")   # Perth Airport radiosonde


def valid_point(x: dict) -> bool:
    try:
        lat, lon = float(x["lat"]), float(x["lon"])
    except (KeyError, TypeError, ValueError):
        return False
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def load_settings():
    """Settings changed in the UI (e.g. home) live in the data volume and override the env defaults."""
    try:
        saved = json.loads(SETTINGS_FILE.read_text())
        if isinstance(saved.get("home"), dict):
            h = saved["home"]
            if valid_point(h):
                HOME.update(name=str(h["name"])[:40], lat=float(h["lat"]), lon=float(h["lon"]))
        if isinstance(saved.get("cases"), list):
            CASES[:] = saved["cases"]
        if isinstance(saved.get("spots"), list):
            SPOTS[:] = [x for x in saved["spots"] if isinstance(x, dict) and "id" in x and valid_point(x)]
        if isinstance(saved.get("reports"), list):
            REPORTS[:] = [x for x in saved["reports"] if isinstance(x, dict) and valid_point(x)
                          and (x.get("size") is None or (isinstance(x["size"], (int, float)) and math.isfinite(x["size"])))]
        if isinstance(saved.get("radars"), list) and saved["radars"]:
            RADARS[:] = [str(r) for r in saved["radars"] if str(r).isdigit()]
    except FileNotFoundError:
        pass
    except Exception as e:
        log.warning("ignoring bad settings.json: %s", e)


def save_settings():
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"home": HOME, "cases": CASES, "radars": RADARS, "spots": SPOTS, "reports": REPORTS}, indent=2))
    tmp.replace(SETTINGS_FILE)
DATA = Path(os.getenv("DATA_DIR", "/data"))
FRAMES = DATA / "frames"
LAYERS = DATA / "layers"
STATIC = Path(__file__).parent / "static"
UA = {"User-Agent": "Mozilla/5.0 (compatible; wxdeck personal dashboard)"}

PRODUCT_LABELS = {
    "4": "64 km", "3": "128 km", "2": "256 km", "1": "512 km",
    "I": "Doppler wind", "A": "Rain 5 min", "B": "Rain 1 h",
    "C": "Rain since 9am", "D": "Rain 24 h",
}
KM_DIGIT = {64: "4", 128: "3", 256: "2", 512: "1"}
SUFFIX_KM = {"4": 64, "3": 128, "2": 256, "1": 512, "I": 128, "A": 128, "B": 128, "C": 128, "D": 128}
SUFFIX_TYPE = {"I": "2", "A": "1", "B": "1", "C": "1", "D": "1"}      # 0 reflectivity, 1 rainfall, 2 Doppler
# every BoM radar's name and position (the FTP feed only has the images)
SITES = {r["id"]: {"id": r["id"], "name": r["n"], "lat": r["la"], "lon": r["lo"], "state": r.get("st")}
         for r in json.loads((Path(__file__).parent / "radar_sites.json").read_text())}
LAYER_NAMES = ("background", "topography", "range", "locations")
FRAME_RE = re.compile(r"^([A-Z]{3}\w*)\.T\.(\d{12})\.png$")

# runtime state
radars: dict = {}     # "70" -> {id, name, lat, lon}
products: dict = {}   # "IDR703" -> {pid, radar, suffix, label, km, type, layer_id, available, error, last_ok}
cache: dict = {}      # key -> (expires_ts, value)


# ---------------------------------------------------------------- helpers
def frame_time(fname: str):
    m = FRAME_RE.match(fname)
    if not m:
        return None
    return datetime.strptime(m.group(2), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def is_png(b: bytes) -> bool:
    return b[:8] == b"\x89PNG\r\n\x1a\n"


async def fetch_bytes(client: httpx.AsyncClient, url: str):
    r = await client.get(url)
    if r.status_code != 200:
        return None
    return r.content


def write_atomic(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(path)


_inflight: dict = {}


class Partial:
    """Returned by a cached() loader when some of its sources failed: the value is used, but only kept
    for a minute so a BoM or Open-Meteo hiccup doesn't hide warnings or stations for the full TTL."""
    def __init__(self, value):
        self.value = value


async def cached(key: str, ttl: int, fn):
    """Cache a fetch for `ttl` seconds. Requests for the same key while it's being fetched share that one
    fetch (several panes or the warning engine asking at once must not double Open-Meteo usage). The
    fetch runs as its own task, so one browser disconnecting doesn't cancel it for everyone else."""
    hit = cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    task = _inflight.get(key)
    if task is None:
        async def run():
            value = await fn()
            keep = ttl
            if isinstance(value, Partial):
                value, keep = value.value, min(ttl, 60)
            cache[key] = (time.time() + keep, value)
            return value
        task = asyncio.create_task(run())
        _inflight[key] = task
        task.add_done_callback(lambda t: (_inflight.pop(key, None), t.cancelled() or t.exception()))
        if len(cache) > 500:       # drop expired entries now and then
            now = time.time()
            for k in [k for k, v in cache.items() if v[0] < now]:
                cache.pop(k, None)
    return await asyncio.shield(task)


# ---------------------------------------------------------------- radar poller
_layer_missing: dict = {}       # layer file -> time we last found it missing (many radars lack a 64 or 512 km set)


async def ensure_layers(client, layer_id: str):
    for name in LAYER_NAMES:
        p = LAYERS / f"{layer_id}.{name}.png"
        if p.exists() and time.time() - p.stat().st_mtime < 7 * 86400:
            continue
        if time.time() - _layer_missing.get(p.name, 0) < 86400:
            continue                      # don't re-ask BoM for a file it doesn't have every poll cycle
        b = None
        if RADAR_SOURCE != "web" and time.time() >= _ftp_down_until:
            try:
                b = await bomftp.aget(f"{bomftp.TRANSP_DIR}/{layer_id}.{name}.png")
            except Exception:
                b = None
        if not (b and is_png(b)):
            b = await fetch_bytes(client, f"{BOM}/products/radar_transparencies/{layer_id}.{name}.png")
        if b and is_png(b):
            write_atomic(p, b)
        else:
            _layer_missing[p.name] = time.time()
        await asyncio.sleep(0.2)


async def poll_product(client, rid: str, suffix: str, listing=None):
    pid = f"IDR{rid}{suffix}"
    info = products.setdefault(pid, {
        "pid": pid, "radar": rid, "suffix": suffix,
        "label": PRODUCT_LABELS.get(suffix, suffix),
        "km": None, "type": None, "layer_id": None,
        "available": False, "error": None, "last_ok": None,
    })
    site = SITES.get(rid)
    rad = radars.setdefault(rid, {"id": rid, "name": site["name"] if site else f"Radar {rid}",
                                  "lat": site["lat"] if site else None, "lon": site["lon"] if site else None})
    if listing is not None:
        await poll_product_ftp(client, info, rad, listing)
        return
    try:
        r = await client.get(f"{BOM}/products/{pid}.loop.shtml")
        if r.status_code != 200:
            info.update(available=False, error=f"HTTP {r.status_code}")
            return
        html = r.text
        names = re.findall(r'theImageNames\[\d+\]\s*=\s*"(/radar/[^"]+\.png)"', html)
        km = re.search(r"^\s*Km\s*=\s*(\d+)", html, re.M)
        typ = re.search(r'var type\s*=\s*"(\d)"', html)
        lat = re.search(r'var lat\s*=\s*(-?[\d.]+)', html)
        lon = re.search(r'var lon\s*=\s*(-?[\d.]+)', html)
        title = re.search(r"<h1>\s*\d+\s*km\s+(?:composite\s+)?(.+?)\s+Radar Loop", html)

        if km:
            info["km"] = int(km.group(1))
            info["layer_id"] = f"IDR{rid}{KM_DIGIT.get(info['km'], '3')}"
        if typ:
            info["type"] = typ.group(1)
        if lat and lon:
            rad["lat"], rad["lon"] = float(lat.group(1)), float(lon.group(1))
        if title and suffix in "4321" and not site:
            rad["name"] = title.group(1)

        if not names:
            info.update(available=False, error="no frames listed")
            return

        for path in names:
            fname = path.rsplit("/", 1)[-1]
            dest = FRAMES / pid / fname
            if dest.exists():
                continue
            b = await fetch_bytes(client, f"{BOM}{path}")
            if b and is_png(b):
                write_atomic(dest, b)
            await asyncio.sleep(0.15)

        if info["layer_id"]:
            await ensure_layers(client, info["layer_id"])
        info.update(available=True, error=None, last_ok=datetime.now(timezone.utc).isoformat())
    except Exception as e:  # keep polling other products
        info.update(error=str(e))
        log.warning("poll %s failed: %s", pid, e)


FTP_MAX_NEW = 36           # at most this many frames per product per cycle (3 hours of 5-minute frames)
_ftp_down_until = 0.0


async def radar_listing():
    """This cycle's file list of BoM's FTP radar folder, or None to use the radar web pages instead."""
    global _ftp_down_until
    if RADAR_SOURCE == "web" or (RADAR_SOURCE == "auto" and time.time() < _ftp_down_until):
        return None
    try:
        return await bomftp.alist()
    except Exception as e:
        if RADAR_SOURCE == "ftp":
            log.warning("BoM FTP listing failed: %s", e)
            return []
        _ftp_down_until = time.time() + 600
        log.warning("BoM FTP unreachable (%s); using the radar web pages for 10 minutes", e)
        return None


async def bom_fwo(name: str) -> bytes:
    """A BoM /fwo/ product (warnings RSS, state observations, warning text): FTP first, then the website."""
    err = None
    if RADAR_SOURCE != "web" and time.time() >= _ftp_down_until:
        try:
            return await bomftp.aget(f"{bomftp.FWO_DIR}/{name}")
        except Exception as e:
            err = e
            if RADAR_SOURCE == "ftp":
                raise
    r = await app.state.http.get(f"{BOM}/fwo/{name}")
    if r.status_code != 200 and err is not None:
        raise RuntimeError(f"BoM FTP: {err}; website: HTTP {r.status_code}")
    r.raise_for_status()
    return r.content


async def bom_warnings(feed: str):
    """One state's current BoM warnings: built from the FTP feed's warning products (the website's RSS
    isn't on FTP), or the website RSS when FTP isn't in use or hasn't loaded yet."""
    if RADAR_SOURCE != "web" and (bomwarn.state["loaded"] or RADAR_SOURCE == "ftp"):
        return bomwarn.items(feed)
    return await extras.warnings(app.state.http, BOM, feed)


def warning_feeds():
    return ALL_WARNINGS if NATIONAL else [WARNINGS_FEED]


async def poll_product_ftp(client, info: dict, rad: dict, listing: list):
    pid, suffix = info["pid"], info["suffix"]
    info["km"] = SUFFIX_KM.get(suffix, 128)
    info["type"] = SUFFIX_TYPE.get(suffix, "0")
    info["layer_id"] = f"IDR{info['radar']}{KM_DIGIT.get(info['km'], '3')}"
    names = bomftp.frames_for(pid, listing)
    if not names:
        info.update(available=False, error="not on BoM's FTP feed")
        return
    cutoff = datetime.now(timezone.utc) - timedelta(hours=RETENTION_HOURS)
    todo = [n for n in names if not (FRAMES / pid / n).exists() and (frame_time(n) or cutoff) > cutoff][-FTP_MAX_NEW:]
    try:
        for n in todo:
            b = await bomftp.aget(f"{bomftp.RADAR_DIR}/{n}")
            if is_png(b):
                write_atomic(FRAMES / pid / n, b)
        await ensure_layers(client, info["layer_id"])
        info.update(available=True, error=None, last_ok=datetime.now(timezone.utc).isoformat())
    except Exception as e:
        info.update(error=f"FTP: {e}", available=any((FRAMES / pid).glob("*.png")) if (FRAMES / pid).exists() else False)
        log.warning("FTP poll %s failed: %s", pid, e)


def prune():
    cutoff = datetime.now(timezone.utc) - timedelta(hours=RETENTION_HOURS)
    if not FRAMES.exists():
        return
    # radars' 512 km composites fetched only for the national mosaic are needed for an hour at most
    mosaic_only = {f"IDR{rid}{v.get('suffix', '1')}" for rid, v in national.state["radars"].items()}
    keep = {f"IDR{rid}{suf}" for rid in followed() for suf in (PRODUCTS if rid in RADARS else AUTO_PRODUCTS)}
    short = datetime.now(timezone.utc) - timedelta(hours=2)
    # radars followed only for storms or the seamless map keep 6 hours, not the full retention
    mine = {f"IDR{rid}{suf}" for rid in RADARS for suf in PRODUCTS}
    six = datetime.now(timezone.utc) - timedelta(hours=min(6, RETENTION_HOURS))
    for d in FRAMES.iterdir():
        if d.name in mosaic_only and d.name not in keep:
            cut = short
        elif d.name.startswith("IDR") and d.name not in mine:
            cut = six
        else:
            cut = cutoff
        for f in d.glob("*.png"):
            t = frame_time(f.name)
            if t and t < cut:
                f.unlink(missing_ok=True)


AUTO_RADARS: dict = {}            # radar id -> expiry (epoch s): followed on demand or by the warning engine
AUTO_PRODUCTS = ["3", "2", "I"]     # 128 km + 256 km reflectivity (seamless map fills gaps) and Doppler wind


def followed():
    now = time.time()
    for k in [k for k, t in AUTO_RADARS.items() if t < now]:
        del AUTO_RADARS[k]
    return list(RADARS) + [r for r in AUTO_RADARS if r not in RADARS]


def follow(rid: str, hours: float = 3):
    if rid not in RADARS:
        AUTO_RADARS[rid] = max(AUTO_RADARS.get(rid, 0), time.time() + hours * 3600)


async def poll_now(rid: str):
    async with httpx.AsyncClient(headers=UA, timeout=20, follow_redirects=True) as client:
        listing = await radar_listing()
        for suf in (PRODUCTS if rid in RADARS else AUTO_PRODUCTS):
            try:
                await poll_product(client, rid, suf, listing)
            except Exception as e:
                log.warning("poll %s%s failed: %s", rid, suf, e)
        for digit in "4321":
            try:
                await ensure_layers(client, f"IDR{rid}{digit}")
            except Exception as e:
                log.warning("basemap IDR%s%s failed: %s", rid, digit, e)


async def poller():
    async with httpx.AsyncClient(headers=UA, timeout=20, follow_redirects=True) as client:
        while True:
            start = time.time()
            # every step is guarded: one network hiccup (Wi-Fi drop, PC waking from sleep, BoM refusing a
            # request) must never stop the poller, the warning engine or pruning for good
            listing = await radar_listing()
            for rid in followed():
                for suf in (PRODUCTS if rid in RADARS else AUTO_PRODUCTS):
                    try:
                        await poll_product(client, rid, suf, listing)
                    except Exception as e:
                        log.warning("poll IDR%s%s failed: %s", rid, suf, e)
                    await asyncio.sleep(0.3 if listing is None else 0)
                for digit in "4321":  # basemaps for every range, used by the raw volume viewer
                    try:
                        await ensure_layers(client, f"IDR{rid}{digit}")
                    except Exception as e:
                        log.warning("basemap IDR%s%s failed: %s", rid, digit, e)
            for name, job in (("prune", lambda: run_in_threadpool(prune)),
                              ("warnings", run_warnings if WXWARN else None),
                              ("satellite prune", lambda: run_in_threadpool(satellite.prune, DATA, max(RETENTION_HOURS, 24))),
                              ("himawari prune", lambda: run_in_threadpool(himawari.prune, DATA, max(RETENTION_HOURS, 24)))):
                if job is None:
                    continue
                try:
                    await job()
                except Exception:
                    log.exception("%s step failed", name)
            log.info("poll cycle done in %.1fs", time.time() - start)
            await asyncio.sleep(max(10, POLL_SECONDS - (time.time() - start)))


async def run_warnings():
    """wxdeck's own radar-indicated warnings for each followed radar (and the national mosaic), plus
    model-based watches every 6 hours."""
    tz = ZoneInfo(TZ_NAME)
    # every BoM radar's position, so storms can be matched to the nearest Doppler
    wxw.state["radar_sites"] = {k: (v["lat"], v["lon"], v.get("name") or k)
                                for k, v in national.state["radars"].items() if v.get("lat") is not None}
    await refresh_env()
    for rid in followed():
        r = radars.get(rid)
        p3 = products.get(f"IDR{rid}3")
        if not r or r.get("lat") is None or not p3 or not p3.get("available"):
            continue
        dop = f"IDR{rid}I" if products.get(f"IDR{rid}I", {}).get("available") else None
        try:
            await run_in_threadpool(wxw.run_source, rid, r["lat"], r["lon"], f"IDR{rid}3", p3.get("km") or 128, dop,
                                    FRAMES, DATA, dict(HOME), tz)
        except Exception as e:
            log.warning("warning engine failed for %s: %s", rid, e)
    await refresh_local_env()
    if NATIONAL:
        try:
            await run_in_threadpool(wxw.run_source, national.PID, national.LAT0, national.LON0, national.PID, national.HALF_KM,
                                    None, FRAMES, DATA, dict(HOME), tz)
        except Exception as e:
            log.warning("warning engine failed for national: %s", e)
        # storms the national mosaic flags get their nearest radar's live Doppler from the next cycle on
        # (only storms backed by lightning or a warning, and at most 4 extra radars at a time)
        warned = {(round(w["lat"], 1), round(w["lon"], 1)) for w in wxw.state["active"].values() if w.get("source") == national.PID}
        picks = []
        for st in wxw.state["storms"].get(national.PID, []):
            t = st.get("threat") or {}
            if not st.get("nearest_radar") or st["nearest_radar"]["km"] > 150:
                continue
            if st["lightning"] >= 3 or (round(st["lat"], 1), round(st["lon"], 1)) in warned or t.get("supercell") in ("moderate", "high"):
                picks.append((-(st["lightning"] + st["dbz"]), st["nearest_radar"]["id"]))
        for _, rid in sorted(picks):
            if rid in AUTO_RADARS or len([r for r in AUTO_RADARS if r not in RADARS]) < 4:
                follow(rid, 2)
    try:
        bom = [{"id": b["id"], "title": b["title"], "text": b["title"] + " " + _bom_area_text(b["body"], b["kind"])}
               for b in await bom_severe() if b["kind"] in ("thunderstorm", "severe weather")]
        await run_in_threadpool(verify.record, DATA, list(wxw.state["active"].values()), bom, list(REPORTS))
    except Exception:
        log.exception("verification log failed")


LOCAL_ENV: dict = {}       # (lat, lon) rounded -> {"svr", "lat0", "lon0", "t"}: 50 km grids around active storms


async def refresh_local_env():
    """The regional model grid is coarse (100-430 km). Around active storm clusters fetch a fine 7 x 7 grid
    (50 km spacing, ~100 Open-Meteo calls) every 3 hours, so ratings use the environment the storm sees."""
    strong = [st for lst in wxw.state["storms"].values() for st in lst if st["dbz"] >= 55]
    now = time.time()
    for k in [k for k, v in LOCAL_ENV.items() if now - v["t"] > 3 * 3600]:
        del LOCAL_ENV[k]
    for st in strong:
        if any(abs(st["lat"] - v["lat0"]) < 1.2 and abs(st["lon"] - v["lon0"]) < 1.4 for v in LOCAL_ENV.values()):
            continue
        if len(LOCAL_ENV) >= 4:
            break
        key = (round(st["lat"]), round(st["lon"]))
        try:
            g = await extras.forecast_grid(app.state.http, key[0], key[1], TZ_NAME, "best", "svr", 150, 7)
            LOCAL_ENV[key] = {"svr": g, "lat0": key[0], "lon0": key[1], "t": now}
        except Exception as e:
            log.warning("local storm environment failed: %s", e)
            break
    wxw.state["env_local"] = list(LOCAL_ENV.values())


async def refresh_env():
    try:   # the warning engine names towns from this list, so keep it matching the current coverage
        await extras.towns(app.state.http, DATA, map_centres())
    except Exception:
        pass
    if time.time() - wxw.state["watch_time"] > 6 * 3600:
        wxw.state["watch_time"] = time.time()
        region = national.PID if NATIONAL else (RADARS[0] if RADARS else None)
        try:
            lat, lon = radar_point(region)
            half = 2600 if region == national.PID else extras.FC_HALF
            sfc = await cached(f"fcgrid|{region}|best|sfc", 3 * 3600,
                               lambda: extras.forecast_grid(app.state.http, lat, lon, TZ_NAME, "best", "sfc", half))
            svr = await cached(f"fcgrid|{region}|best|svr", 3 * 3600,
                               lambda: extras.forecast_grid(app.state.http, lat, lon, TZ_NAME, "best", "svr", half))
            wxw.state["watches"] = await run_in_threadpool(wxw.build_watches, region, sfc, svr, lat, lon, 12, wxw.state.get("watches"))
            wxw.state["env"] = {"svr": svr, "lat0": lat, "lon0": lon}
        except Exception as e:
            wxw.state["watch_time"] = time.time() - 5.5 * 3600      # retry in 30 minutes
            log.warning("watch build failed: %s", e)


@asynccontextmanager
async def lifespan(app):
    load_settings()
    FRAMES.mkdir(parents=True, exist_ok=True)
    LAYERS.mkdir(parents=True, exist_ok=True)
    app.state.http = httpx.AsyncClient(headers=UA, timeout=60, follow_redirects=True)
    app.state.strikes = lightning.Store(DATA / "lightning.sqlite")
    async def voice_bg():
        try:
            await speech.ensure_voice(DATA)
        except Exception as e:
            log.warning("alert voice download failed (alerts will use the device's own voice): %s", e)
    tasks = [
        asyncio.create_task(voice_bg()),
        *( [asyncio.create_task(national.run(app.state.http, BOM, FRAMES, NATIONAL_POLL, radar_listing, SITES))] if NATIONAL else []),
        asyncio.create_task(poller()),
        *( [asyncio.create_task(bomwarn.run(DATA, warning_feeds))] if RADAR_SOURCE != "web" else []),
        asyncio.create_task(lightning.collector(app.state.strikes, lightning_centres)),
    ]
    yield
    for t in tasks:
        t.cancel()
    await app.state.http.aclose()


def map_centres():
    """Area for towns, roads and fires: the whole continent when the national view is on, so following
    extra radars for the seamless map doesn't trigger rebuilds."""
    if NATIONAL:
        return [(HOME["lat"], HOME["lon"]), (national.LAT0, national.LON0, 2900)]
    return lightning_centres()


def lightning_centres():
    pts = [(HOME["lat"], HOME["lon"])]
    pts += [(r["lat"], r["lon"]) for r in radars.values() if r.get("lat") is not None]
    if NATIONAL:
        pts.append((national.LAT0, national.LON0, 2900))     # the whole continent
    return pts


app = FastAPI(title="wxdeck", lifespan=lifespan)

NO_GZIP = ("/frames/", "/layers/", "/api/sat/", "/api/natbase", "/api/satcoast", "/static/downloads", "/app/wxdeck.apk", "/static/icon",
           "/api/speech", "/api/loop/")       # already-compressed images, and audio that players fetch in byte ranges


class FastDelivery:
    """Compress what compresses (JSON, JS, CSS, radar sweeps) but not PNGs or the APK, and let browsers
    keep files that never change: versioned app files for a year, timestamped radar frames for a day."""

    def __init__(self, app):
        self.app = app
        self.gz = GZipMiddleware(app, minimum_size=1024)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path, query = scope["path"], scope.get("query_string", b"")
        cache = None
        if path.startswith("/static/") and b"v=" in query:
            cache = b"public, max-age=31536000, immutable"
        elif path.startswith(("/frames/", "/layers/")):
            cache = b"public, max-age=86400, immutable"

        async def send_with_cache(msg):
            if cache and msg["type"] == "http.response.start":
                msg["headers"] = [h for h in msg.get("headers", []) if h[0].lower() != b"cache-control"] + [(b"cache-control", cache)]
            await send(msg)
        inner = self.app if path.startswith(NO_GZIP) else self.gz
        await inner(scope, receive, send_with_cache)


app.add_middleware(FastDelivery)

# ---------------------------------------------------------------- optional password (before going public)
PASSWORD = os.getenv("WXDECK_PASSWORD", "")
AUTH_OPEN = ("/login", "/static/icon-", "/static/manifest.json", "/static/style.css", "/app", "/static/downloads/", "/favicon")


def _auth_token():
    return hmac.new(PASSWORD.encode(), b"wxdeck-login-v1", hashlib.sha256).hexdigest()


class PasswordGate:
    """With WXDECK_PASSWORD set, everything needs the login cookie (browsers, the app's web view) or the
    password in an X-Wxdeck-Key header (the app's background alert service)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not PASSWORD or scope["path"].startswith(AUTH_OPEN):
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode(errors="ignore") for k, v in scope.get("headers", [])}
        cookies = {}
        for part in headers.get("cookie", "").split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                cookies[k] = v
        ok = hmac.compare_digest(cookies.get("wxdeck_auth", "").encode(), _auth_token().encode()) or \
            hmac.compare_digest(headers.get("x-wxdeck-key", "").encode(), PASSWORD.encode())
        if ok:
            return await self.app(scope, receive, send)
        path = scope["path"]
        if path.startswith(("/api/", "/frames/", "/layers/")):
            resp = Response('{"detail":"login needed"}', status_code=401, media_type="application/json")
        else:
            resp = Response(status_code=302, headers={"Location": "/login?next=" + quote(path)})
        await resp(scope, receive, send)


app.add_middleware(PasswordGate)

LOGIN_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>wxdeck login</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1a20;color:#d6e2e4;font-family:"Segoe UI",Roboto,system-ui,sans-serif}
form{background:#15232b;border:1px solid #263b44;border-radius:14px;padding:24px;width:min(340px,90vw)}
h1{color:#f2a93b;margin:0 0 14px;font-size:26px}input,button{width:100%;box-sizing:border-box;font-size:17px;padding:12px;border-radius:10px}
input{background:#1b2c35;color:#d6e2e4;border:1px solid #263b44}button{margin-top:12px;border:0;background:#f2a93b;color:#0f1a20;font-weight:600}
p{color:#ef6f5c;min-height:20px;margin:10px 0 0;font-size:14px}</style></head><body>
<form id="f"><h1>wxdeck</h1><input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus>
<button>Log in</button><p id="m"></p></form><script>
document.getElementById("f").onsubmit=async e=>{e.preventDefault();
const r=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("pw").value})});
if(r.ok){const n=new URLSearchParams(location.search).get("next")||"/";location.replace(n.startsWith("/")&&!n.startsWith("//")?n:"/");}
else document.getElementById("m").textContent="Wrong password";};</script></body></html>"""


@app.get("/login")
async def login_page():
    return Response(LOGIN_HTML, media_type="text/html")


@app.post("/login")
async def login(body: dict):
    if not PASSWORD:
        return {"ok": True}
    if not hmac.compare_digest(str(body.get("password", "")).encode(), PASSWORD.encode()):
        await asyncio.sleep(1.5)                     # slows down guessing
        raise HTTPException(401, "wrong password")
    r = Response('{"ok":true}', media_type="application/json")
    r.set_cookie("wxdeck_auth", _auth_token(), max_age=400 * 86400, httponly=True, samesite="lax")
    return r


@app.get("/logout")
async def logout():
    r = Response(status_code=302, headers={"Location": "/login"})
    r.delete_cookie("wxdeck_auth")
    return r


# ---------------------------------------------------------------- API
@app.get("/api/config")
async def get_config():
    out = []
    for rid in followed():
        nat = national.state["radars"].get(rid, {})
        rad = radars.get(rid, {"id": rid, "name": nat.get("name") or f"Radar {rid}", "lat": nat.get("lat"), "lon": nat.get("lon")})
        if rad.get("name", "").startswith("Radar ") and nat.get("name"):
            rad = {**rad, "name": nat["name"]}
        prods = []
        for suf in (PRODUCTS if rid in RADARS else AUTO_PRODUCTS):
            p = products.get(f"IDR{rid}{suf}")
            if not p:
                continue
            n = len(list((FRAMES / p["pid"]).glob("*.png"))) if (FRAMES / p["pid"]).exists() else 0
            prods.append({**p, "frames": n})
        layer_sets = [
            {"id": f"IDR{rid}{dg}", "km": km}
            for km, dg in KM_DIGIT.items()
            if (LAYERS / f"IDR{rid}{dg}.background.png").exists()
        ]
        out.append({**rad, "products": prods, "layer_sets": layer_sets, "auto": rid not in RADARS})
    if NATIONAL:
        d = FRAMES / national.PID
        n = len(list(d.glob("*.png"))) if d.exists() else 0
        out.append({"id": national.PID, "name": "Australia (all radars)", "lat": national.LAT0, "lon": national.LON0,
                    "national": True, "layer_sets": [],
                    "products": [{"pid": national.PID, "radar": national.PID, "suffix": "N", "label": "National mosaic",
                                  "km": national.HALF_KM, "px": national.SIZE, "type": "0", "layer_id": None,
                                  "available": n > 0, "error": None if n else "building the first mosaic", "frames": n}]})
    on = set(followed())
    for r in out:
        if r["id"] in SITES:
            r["state"] = SITES[r["id"]]["state"]
    all_radars = sorted(({"id": k, "name": v["name"], "lat": v["lat"], "lon": v["lon"], "state": v["state"]}
                         for k, v in SITES.items() if k not in on), key=lambda r: r["name"])
    return {
        "radars": out, "all_radars": all_radars, "home": HOME, "tz": TZ_NAME,
        "retention_hours": RETENTION_HOURS, "poll_seconds": POLL_SECONDS,
        "auth": bool(PASSWORD), "webcams": bool(WEBCAM_KEY), "ltg_alert_km": LTG_ALERT_KM,
    }


@app.get("/api/frames/{pid}")
async def get_frames(pid: str, hours: float = Query(3, gt=0, le=168)):
    if not (re.fullmatch(r"IDR\w{3,4}", pid) or pid == national.PID):
        raise HTTPException(400, "bad product id")
    d = FRAMES / pid
    if not d.exists():
        return {"pid": pid, "frames": []}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    frames = []
    for f in d.glob("*.png"):
        t = frame_time(f.name)
        if t and t >= cutoff:
            frames.append({"t": t.isoformat(), "url": f"/frames/{pid}/{f.name}"})
    frames.sort(key=lambda x: x["t"])
    return {"pid": pid, "frames": frames}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@app.get("/api/loop/{pid}")
async def get_loop(pid: str, names: str):
    """Several radar frames in one response: [count][length, name, PNG bytes]... Saves a round trip per
    frame, which matters on phones and over Tailscale."""
    if not (re.fullmatch(r"IDR\w{3,4}", pid) or pid == national.PID):
        raise HTTPException(400, "bad product")
    out = bytearray()
    files = []
    for n in names.split(",")[:600]:
        if not re.fullmatch(r"[A-Z]{3}\w*\.T\.\d{12}\.png", n):
            continue
        f = FRAMES / pid / n
        if f.exists():
            files.append((n, f.read_bytes()))
    out += len(files).to_bytes(4, "little")
    for n, b in files:
        nb = n.encode()
        out += len(nb).to_bytes(2, "little") + nb + len(b).to_bytes(4, "little") + b
    return Response(bytes(out), media_type="application/octet-stream", headers={"Cache-Control": "max-age=60"})


OBS_SEEN: dict = {}          # station id -> {time: row}: history kept from the state observations file


async def obs_from_state(st: str, prod: str, wmo: str):
    state_prod = prod[:3] + "60920"                     # IDW60901 (one station) -> IDW60920 (whole state)
    xml = await cached(f"obsxml|{state_prod}", 240, lambda: bom_fwo(f"{state_prod}.xml"))
    for a, tm, v in extras.station_rows(xml):
        if a.get("wmo-id") != wmo or not tm:
            continue
        row = {"t": datetime.fromisoformat(tm.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(),
               "temp": _num(v.get("air_temperature")), "app": _num(v.get("apparent_temp")),
               "dew": _num(v.get("dew_point")), "rh": _num(v.get("rel-humidity")),
               "press": _num(v.get("msl_pres")), "wind": _num(v.get("wind_spd_kmh")),
               "gust": _num(v.get("gust_kmh")), "dir": v.get("wind_dir"), "rain": _num(v.get("rainfall"))}
        seen = OBS_SEEN.setdefault(st, {})
        seen[row["t"]] = row
        for k in sorted(seen)[:-150]:
            del seen[k]
        hist = [seen[k] for k in sorted(seen)]
        return {"id": st, "name": a.get("description") or a.get("stn-name"), "lat": _num(a.get("lat")),
                "lon": _num(a.get("lon")), "latest": hist[-1], "history": hist}
    raise RuntimeError(f"station {wmo} not in {state_prod}")


@app.get("/api/obs")
async def get_obs():
    async def load():
        result = []
        for st in STATIONS:
            prod, wmo = st.split(".", 1)
            try:
                if RADAR_SOURCE == "ftp":
                    raise RuntimeError("FTP only")
                r = await app.state.http.get(f"{BOM}/fwo/{prod}/{prod}.{wmo}.json")
                r.raise_for_status()
                rows = r.json()["observations"]["data"]
            except Exception as e:
                # the per-station JSON is website-only: use the state observations file from the FTP feed
                # and build the history from what wxdeck has seen itself
                try:
                    result.append(await obs_from_state(st, prod, wmo))
                except Exception as e2:
                    result.append({"id": st, "error": f"{e}; FTP: {e2}"})
                continue
            hist = []
            for x in reversed(rows):
                t = x.get("aifstime_utc")
                if not t:
                    continue
                hist.append({
                    "t": datetime.strptime(t, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).isoformat(),
                    "temp": _num(x.get("air_temp")), "app": _num(x.get("apparent_t")),
                    "dew": _num(x.get("dewpt")), "rh": _num(x.get("rel_hum")),
                    "press": _num(x.get("press_msl")), "wind": _num(x.get("wind_spd_kmh")),
                    "gust": _num(x.get("gust_kmh")), "dir": x.get("wind_dir"),
                    "rain": _num(x.get("rain_trace")),
                })
            latest = rows[0] if rows else {}
            result.append({
                "id": st, "name": latest.get("name"),
                "lat": latest.get("lat"), "lon": latest.get("lon"),
                "latest": hist[-1] if hist else None, "history": hist,
            })
        return result
    return await cached("obs", 300, load)


async def get_retry(url, params, tries=3):
    """GET that tries again after a dropped connection or a 5xx (home internet and Open-Meteo both hiccup)."""
    for i in range(tries):
        try:
            r = await app.state.http.get(url, params=params)
            if r.status_code < 500 or i == tries - 1:
                r.raise_for_status()
                return r
        except httpx.TransportError:
            if i == tries - 1:
                raise
        await asyncio.sleep(2 * (i + 1))


def query_point(lat, lon):
    """lat/lon from a query string, or home when they're left out."""
    if lat is None or lon is None:
        return HOME["lat"], HOME["lon"]
    if not valid_point({"lat": lat, "lon": lon}):
        raise HTTPException(400, "lat/lon out of range")
    return round(lat, 3), round(lon, 3)


@app.get("/api/forecast")
async def get_forecast(lat: float | None = None, lon: float | None = None):
    base = "https://api.open-meteo.com/v1/forecast"
    plat, plon = query_point(lat, lon)
    common = {"latitude": plat, "longitude": plon, "timezone": TZ_NAME, "timeformat": "unixtime"}
    ck = f"{plat},{plon}"

    async def load_main():
        params = {
            **common, "forecast_days": 7,
            "hourly": ",".join([
                "temperature_2m", "apparent_temperature", "dew_point_2m",
                "precipitation_probability", "precipitation", "wind_speed_10m",
                "wind_gusts_10m", "wind_direction_10m", "cape", "lifted_index",
                "cloud_cover", "pressure_msl",
            ]),
            "daily": ",".join([
                "weather_code", "temperature_2m_max", "temperature_2m_min",
                "precipitation_sum", "precipitation_probability_max", "wind_gusts_10m_max",
            ]),
        }
        r = await get_retry(base, params)
        return r.json()

    async def load_models():
        params = {
            **common, "forecast_hours": 72,
            "hourly": "temperature_2m,precipitation",
            "models": "ecmwf_ifs025,gfs_seamless,icon_seamless",
        }
        r = await get_retry(base, params)
        return r.json()

    async def load_ens():
        # ECMWF's 51-member ensemble -> BoM-style daily rain wording: "5 to 15 mm" (75% chance of at least
        # the low number, 25% chance of more than the high one) and the chance of any rain
        r = await get_retry("https://ensemble-api.open-meteo.com/v1/ensemble", {
            "latitude": plat, "longitude": plon, "hourly": "precipitation", "models": "ecmwf_ifs025",
            "forecast_days": 7, "timezone": TZ_NAME, "timeformat": "unixtime"})
        return await run_in_threadpool(_rain_ranges, r.json())

    try:
        main = await cached(f"fc_main|{ck}", 900, load_main)
        models = await cached(f"fc_models|{ck}", 900, load_models)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            raise HTTPException(429, "Open-Meteo's free rate limit was hit; the forecast comes back within the hour")
        raise HTTPException(502, f"forecast source unavailable: {e}")
    except Exception as e:
        raise HTTPException(502, f"forecast source unavailable: {type(e).__name__} {e}")
    try:
        ens = await cached(f"fc_ens|{ck}", 3600, load_ens)
    except Exception:
        ens = None
    return {"main": main, "models": models, "rain_range": ens}


def _rain_ranges(d):
    H = d["hourly"]
    off = d.get("utc_offset_seconds", 0)
    members = [k for k in H if k.startswith("precipitation")]
    days = {}
    for i, t in enumerate(H["time"]):
        day = datetime.fromtimestamp(t + off, timezone.utc).strftime("%Y-%m-%d")
        for k in members:
            v = H[k][i]
            if v is not None:
                days.setdefault(day, {}).setdefault(k, 0.0)
                days[day][k] += v
    out = {}
    for day, sums in days.items():
        vals = sorted(sums.values())
        if len(vals) < 10:
            continue
        q = lambda f: vals[min(len(vals) - 1, int(f * len(vals)))]
        out[day] = {"chance": round(100 * sum(v >= 0.2 for v in vals) / len(vals)), "low": round(q(0.25), 1), "high": round(q(0.75), 1)}
    return out


# ---------------------------------------------------------------- satellite
def radar_point(rid):
    if rid == national.PID:
        return national.LAT0, national.LON0
    r = radars.get(rid)
    if not r or r.get("lat") is None:
        raise HTTPException(404, "radar location not known yet, wait for the first poll")
    return r["lat"], r["lon"]


@app.get("/api/natbase")
async def get_natbase(half: int = 2600):
    try:
        path = await satellite.national_base(app.state.http, DATA, national.LAT0, national.LON0, half)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"basemap unavailable: {e}")
    path = await run_in_threadpool(webp_of, path, 88)
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "max-age=604800"})


@app.get("/api/satcoast")
async def get_sat_coast(radar: str, half: int = 1536):
    lat, lon = radar_point(radar)
    try:
        path = await satellite.get_coastlines(app.state.http, DATA, radar, lat, lon, half)
    except ValueError:
        raise HTTPException(400, "bad size")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"coastline source unavailable: {e}")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=604800"})


def _when(t):
    when = datetime.fromisoformat(t.replace("Z", "+00:00")) if t else datetime.now(timezone.utc)
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


@app.get("/api/hsd/{product}")
async def get_hsd(product: str, radar: str, t: str | None = None, half: int = 512):
    """Brightness temperature grid (uint8: 0 = none, else Tb = 170 K + 0.6 K * value)."""
    if product not in himawari.BANDS or half not in himawari.SIZES:
        raise HTTPException(400, "unknown product or size")
    lat, lon = radar_point(radar)
    try:
        path, slot = await himawari.get_band(app.state.http, DATA, product, radar, lat, lon, _when(t), half)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Himawari source unavailable: {e}")
    if not path:
        raise HTTPException(404, "no Himawari scan in the last 2 hours")
    return FileResponse(path, media_type="application/octet-stream", headers={
        "X-Sat-Time": slot.isoformat(), "X-Sat-Half-Km": str(half), "X-Size": str(himawari.SIZES[half]),
        "X-Enc": f"{himawari.ENC_MIN}:{himawari.ENC_STEP}", "Cache-Control": "max-age=86400",
    })


def webp_of(path: Path, quality=82) -> Path:
    """Visual satellite images as WebP: a third to a fifth of the PNG size. Converted once, cached beside the PNG."""
    out = path.with_suffix(".webp")
    if not out.exists() or out.stat().st_mtime < path.stat().st_mtime:
        from PIL import Image
        im = Image.open(path)
        im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
        tmp = out.with_suffix(".part")
        im.save(tmp, "WEBP", quality=quality, method=4)
        tmp.replace(out)
    return out


@app.get("/api/sat/{layer}")
async def get_sat(layer: str, radar: str, t: str | None = None, half: int = 512):
    lat, lon = radar_point(radar)
    when = _when(t)
    if layer in himawari.RGBS:
        if half not in himawari.SIZES:
            raise HTTPException(400, "bad size")
        try:
            path, slot = await himawari.get_rgb(app.state.http, DATA, layer, radar, lat, lon, when, half)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Himawari source unavailable: {e}")
        if not path:
            raise HTTPException(404, "no Himawari scan in the last 2 hours")
        path = await run_in_threadpool(webp_of, path)
        return FileResponse(path, media_type="image/webp", headers={
            "X-Sat-Time": slot.isoformat(), "X-Sat-Half-Km": str(half), "Cache-Control": "max-age=86400"})
    if layer == "geocolor":
        if half not in himawari.SIZES:
            raise HTTPException(400, "bad size")
        try:
            path, slot = await himawari.get_geocolor(app.state.http, DATA, radar, lat, lon, when, half)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"GeoColor source unavailable: {e}")
        if not path:
            raise HTTPException(404, "no GeoColor image available")
        path = await run_in_threadpool(webp_of, path)
        return FileResponse(path, media_type="image/webp", headers={
            "X-Sat-Time": slot.isoformat(), "X-Sat-Half-Km": str(half), "Cache-Control": "max-age=86400"})
    try:
        path, slot = await satellite.get_image(app.state.http, DATA, layer, radar, lat, lon, when, half)
    except ValueError:
        raise HTTPException(400, "unknown layer")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"satellite source unavailable: {e}")
    if not path:
        raise HTTPException(404, "no satellite image in the last 2 hours")
    path = await run_in_threadpool(webp_of, path)
    return FileResponse(path, media_type="image/webp", headers={
        "X-Sat-Time": slot.isoformat(), "X-Sat-Half-Km": str(half), "Cache-Control": "max-age=86400",
        "Access-Control-Expose-Headers": "X-Sat-Time, X-Sat-Half-Km",
    })


# ---------------------------------------------------------------- lightning
@app.get("/api/lightning")
async def get_lightning(radar: str, start: str, end: str, radius: float = 600, fmt: str = "json"):
    lat, lon = radar_point(radar)
    try:
        t0 = int(datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp() * 1000)
        t1 = int(datetime.fromisoformat(end.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        raise HTTPException(400, "start and end must be ISO times")
    if t1 - t0 > 3 * 86400 * 1000 or t1 < t0:
        raise HTTPException(400, "window must be 0-3 days")
    radius = max(1.0, min(radius, 3000.0)) if math.isfinite(radius) else 600.0
    rows = await run_in_threadpool(app.state.strikes.query, t0, t1, lat, lon, radius)
    if fmt == "bin":
        # [header length][JSON header][uint32 seconds since t0][float32 lat][float32 lon]  (~12 bytes a strike)
        a = np.array(rows, dtype=np.float64).reshape(-1, 3) if rows else np.zeros((0, 3))
        secs = ((a[:, 0] - t0) / 1000).astype("<u4")
        hdr = json.dumps({"t0": t0, "n": len(rows), "status": lightning.status}).encode()
        body = len(hdr).to_bytes(4, "little") + hdr + b"\0" * ((4 - len(hdr) % 4) % 4)
        body += secs.tobytes() + a[:, 1].astype("<f4").tobytes() + a[:, 2].astype("<f4").tobytes()
        return Response(body, media_type="application/octet-stream")
    return {"strikes": rows, "status": lightning.status}


# ---------------------------------------------------------------- raw archive
def _check_ids(radar, date=None, hhmmss=None):
    if not radar.isdigit() or (date and not (date.isdigit() and len(date) == 8)) or (hhmmss and not (hhmmss.isdigit() and len(hhmmss) == 6)):
        raise HTTPException(400, "bad id")


@app.get("/api/archive/days")
async def archive_days(radar: str):
    _check_ids(radar)
    y = datetime.now(timezone.utc).year
    try:
        days = await archive.list_days(app.state.http, radar, [y, y - 1])
    except httpx.HTTPError as e:
        raise HTTPException(502, f"archive unavailable: {e}")
    return {"radar": radar, "days": days}


@app.get("/api/archive/scans")
async def archive_scans(radar: str, date: str):
    _check_ids(radar, date)
    try:
        idx = await archive.day_index(app.state.http, DATA, radar, date)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except (httpx.HTTPError, RuntimeError) as e:
        raise HTTPException(502, f"archive unavailable: {e}")
    cached = {p.stem for p in (DATA / "archive" / radar / date).glob("*.h5")}
    return {"radar": radar, "date": date, "scans": sorted(idx), "cached": sorted(cached)}


async def _volume_path(radar, date, hhmmss):
    _check_ids(radar, date, hhmmss)
    try:
        return await archive.fetch_volume(app.state.http, DATA, radar, date, hhmmss)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except (httpx.HTTPError, RuntimeError) as e:
        raise HTTPException(502, f"archive unavailable: {e}")


@app.get("/api/archive/volume")
async def archive_volume(radar: str, date: str, time: str):
    path = await _volume_path(radar, date, time)
    try:
        return await run_in_threadpool(archive.volume_meta, path)
    except OSError:
        path.unlink(missing_ok=True)
        raise HTTPException(500, "volume file was corrupt and has been removed, try again")


@app.get("/api/archive/sweep")
async def archive_sweep(radar: str, date: str, time: str, tilt: str, data: str):
    if not (tilt.startswith("dataset") and (data.startswith("data") or data in ("HCA", "RR"))):
        raise HTTPException(400, "bad keys")
    path = await _volume_path(radar, date, time)
    try:
        if data in ("HCA", "RR"):
            m = await run_in_threadpool(archive.volume_meta, path)
            fz = await freezing_levels(m["lat"], m["lon"], date)
            h0 = fz[min(23, int(time[:2]))][0] if fz else 3.0
            body, dtype = await run_in_threadpool(archive.polarimetric_sweep, path, tilt, data, h0)
        else:
            body, dtype = await run_in_threadpool(archive.sweep_bytes, path, tilt, data)
    except KeyError:
        raise HTTPException(404, "no such sweep or moment")
    return Response(body, media_type="application/octet-stream", headers={"X-Dtype": dtype, "Cache-Control": "max-age=86400"})


# ---------------------------------------------------------------- volume products
_fz_cache: dict = {}


async def freezing_levels(lat, lon, date):
    """(0 C height km, -20 C height km) for each UTC hour of a day, from Open-Meteo's historical forecasts."""
    key = (round(lat, 2), round(lon, 2), date)
    if key in _fz_cache:
        return _fz_cache[key]
    day = f"{date[:4]}-{date[4:6]}-{date[6:]}"
    levels = [700, 600, 500, 400, 300]
    hourly = ["freezing_level_height"] + [f"temperature_{p}hPa" for p in levels] + [f"geopotential_height_{p}hPa" for p in levels]
    out = None
    try:
        r = await app.state.http.get("https://historical-forecast-api.open-meteo.com/v1/forecast", params={
            "latitude": lat, "longitude": lon, "start_date": day, "end_date": day,
            "hourly": ",".join(hourly), "timezone": "UTC"})
        r.raise_for_status()
        H = r.json()["hourly"]
        out = []
        for i in range(len(H["time"])):
            h0 = (H["freezing_level_height"][i] or 3000) / 1000
            hm20 = None
            pts = [(H[f"geopotential_height_{p}hPa"][i], H[f"temperature_{p}hPa"][i]) for p in levels]
            for (za, ta), (zb, tb) in zip(pts, pts[1:]):
                if None in (za, ta, zb, tb):
                    continue
                if ta >= -20 >= tb:
                    hm20 = (za + (zb - za) * (ta + 20) / (ta - tb)) / 1000
                    break
            out.append((h0, hm20 or h0 + 3.1))
        _fz_cache[key] = out
    except Exception as e:
        log.warning("freezing level lookup failed: %s", e)
    return out


@app.get("/api/archive/derived")
async def archive_derived(radar: str, date: str, time: str, product: str):
    if product not in derived.ENC:
        raise HTTPException(400, "unknown product")
    path = await _volume_path(radar, date, time)
    cache = path.with_suffix(".derived.npz")
    meta = path.with_suffix(".derived.txt")
    if not cache.exists():
        m = await run_in_threadpool(archive.volume_meta, path)
        lat, lon = m["lat"], m["lon"]
        fz = await freezing_levels(lat, lon, date)
        h0, hm20 = fz[min(23, int(time[:2]))] if fz else (3.0, 6.1)
        grids = await run_in_threadpool(derived.grid_products, path, h0, hm20, lat < 0)
        meta.write_text(f"{h0:.2f} {hm20:.2f} {'model' if fz else 'default'}")
        tmp = path.with_suffix(f".{os.getpid()}.{id(grids)}.part.npz")       # written whole, then renamed
        await run_in_threadpool(lambda: np.savez_compressed(tmp, **grids))
        tmp.replace(cache)

    def read():
        with np.load(cache) as z:
            return z[product].tobytes()
    data = await run_in_threadpool(read)
    h0, hm20, src = meta.read_text().split() if meta.exists() else ("3.0", "6.1", "default")
    gain, off = derived.ENC[product]
    return Response(data, media_type="application/octet-stream", headers={
        "X-Size": str(derived.GRID_SIZE), "X-Half-Km": str(derived.GRID_HALF), "X-Gain": str(gain), "X-Offset": str(off),
        "X-Freezing": f"{h0},{hm20},{src}", "Cache-Control": "max-age=86400"})


@app.get("/api/archive/rotation")
async def archive_rotation(radar: str, date: str, time: str):
    """Mesocyclone / TVS / debris detections for one archive volume (cached beside it)."""
    path = await _volume_path(radar, date, time)
    cache = path.with_suffix(".rotation.json")
    if cache.exists():
        return json.loads(cache.read_text())
    m = await run_in_threadpool(archive.volume_meta, path)
    dets = await run_in_threadpool(derived.rotation_detections, path, m["lat"] < 0)
    for d in dets:
        d["lat"] = round(m["lat"] + d["y"] / 111.11, 4)
        d["lon"] = round(m["lon"] + d["x"] / (111.11 * math.cos(math.radians(d["lat"]))), 4)
    out = {"detections": dets}
    write_atomic(cache, json.dumps(out).encode())
    return out


@app.get("/api/archive/xsect")
async def archive_xsect(radar: str, date: str, time: str, moment: str, x1: float, y1: float, x2: float, y2: float,
                        mdir: float = 0, mspd: float = 0):
    if not re.fullmatch(r"[A-Z_]{2,12}", moment):
        raise HTTPException(400, "bad moment")
    path = await _volume_path(radar, date, time)
    xs = await run_in_threadpool(derived.cross_section, path, moment, x1, y1, x2, y2, 320, 160, 16.0, (mdir, mspd))
    if xs is None:
        raise HTTPException(404, "moment not in this volume")
    m = await run_in_threadpool(archive.volume_meta, path)
    fz = await freezing_levels(m["lat"], m["lon"], date)
    h0, hm20 = fz[min(23, int(time[:2]))] if fz else (None, None)
    return Response(xs.astype("<f4").tobytes(), media_type="application/octet-stream", headers={
        "X-Nx": "320", "X-Nz": "160", "X-Ztop": "16", "X-Freezing": f"{h0},{hm20}" if h0 else ""})


@app.post("/api/home")
async def set_home(body: dict):
    try:
        name = str(body.get("name") or "Home").strip()[:40] or "Home"
        lat, lon = float(body["lat"]), float(body["lon"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "need name, lat and lon")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "lat/lon out of range")
    HOME.update(name=name, lat=round(lat, 5), lon=round(lon, 5))
    save_settings()
    for k in [k for k in cache if k.startswith("fc_")]:
        cache.pop(k, None)
    return HOME


SOUNDING_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100]


@app.get("/api/sounding")
async def get_sounding(lat: float | None = None, lon: float | None = None):
    """Model forecast profiles (Open-Meteo best match) for skew-T / hodograph, next 48 h."""
    plat, plon = query_point(lat, lon)
    hourly = ["temperature_2m", "dew_point_2m", "surface_pressure", "wind_speed_10m", "wind_direction_10m", "cape", "lifted_index",
              "freezing_level_height"]
    for p in SOUNDING_LEVELS:
        hourly += [f"temperature_{p}hPa", f"dew_point_{p}hPa", f"wind_speed_{p}hPa", f"wind_direction_{p}hPa", f"geopotential_height_{p}hPa"]

    async def load():
        r = await get_retry("https://api.open-meteo.com/v1/forecast", {
            "latitude": plat, "longitude": plon, "hourly": ",".join(hourly), "forecast_hours": 48,
            "wind_speed_unit": "ms", "timeformat": "unixtime", "timezone": TZ_NAME})
        return r.json()
    try:
        data = await cached(f"snd|{plat},{plon}", 1800, load)
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(502, f"sounding source unavailable: {e}")
    return {"levels": SOUNDING_LEVELS, "data": data}


@app.get("/api/cases")
async def list_cases():
    return {"cases": CASES}


@app.post("/api/cases")
async def add_case(body: dict):
    try:
        case = {"radar": str(body["radar"]), "date": str(body["date"]), "scan": str(body["scan"]),
                "name": str(body.get("name") or "Saved case").strip()[:60]}
    except KeyError:
        raise HTTPException(400, "need radar, date, scan")
    _check_ids(case["radar"], case["date"], case["scan"])
    case["id"] = f"{case['radar']}-{case['date']}-{case['scan']}"
    CASES[:] = [c for c in CASES if c.get("id") != case["id"]] + [case]
    save_settings()
    return {"cases": CASES}


@app.delete("/api/cases/{case_id}")
async def delete_case(case_id: str):
    CASES[:] = [c for c in CASES if c.get("id") != case_id]
    save_settings()
    return {"cases": CASES}


@app.get("/api/spots")
async def list_spots():
    return {"spots": SPOTS}


@app.post("/api/spots")
async def add_spot(body: dict):
    try:
        spot = {"name": str(body.get("name") or "Spot").strip()[:40] or "Spot", "lat": round(float(body["lat"]), 4), "lon": round(float(body["lon"]), 4)}
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "need name, lat, lon")
    if not valid_point(spot):
        raise HTTPException(400, "lat/lon out of range")
    spot["id"] = f"{spot['lat']},{spot['lon']}"
    SPOTS[:] = [x for x in SPOTS if x["id"] != spot["id"]] + [spot]
    save_settings()
    return {"spots": SPOTS}


@app.delete("/api/spots/{spot_id}")
async def delete_spot(spot_id: str):
    SPOTS[:] = [x for x in SPOTS if x["id"] != spot_id]
    save_settings()
    return {"spots": SPOTS}


@app.post("/api/radars")
async def set_radars(body: dict):
    ids = [str(r).strip() for r in body.get("radars", []) if str(r).strip().isdigit()]
    if not ids:
        raise HTTPException(400, "need at least one radar number")
    RADARS[:] = list(dict.fromkeys(ids))[:8]
    save_settings()
    return {"radars": RADARS}


@app.get("/api/fcgrid")
async def get_fcgrid(radar: str, model: str = "best", kind: str = "sfc", fmt: str = "json"):
    if model not in extras.FC_MODELS or kind not in extras.KINDS:
        raise HTTPException(400, "unknown model or kind")
    lat, lon = radar_point(radar)
    try:
        half = 2600 if radar == national.PID else extras.FC_HALF
        D = await cached(f"fcgrid|{radar}|{model}|{kind}", 3 * 3600,
                         lambda: extras.forecast_grid(app.state.http, lat, lon, TZ_NAME, model, kind, half))
        if fmt != "bin":
            return D
        # [header length][JSON header][int16 per variable, time-major]; value = raw * scale, missing = -32768
        names, scales, blobs = [], [], []
        for k, arr in D["vars"].items():
            a = np.array([[np.nan if v is None else v for v in row] for row in arr], dtype=np.float64)
            amax = np.nanmax(np.abs(a)) if np.isfinite(a).any() else 1.0
            sc = max(amax / 32000.0, 1e-4)
            q = np.where(np.isfinite(a), np.round(a / sc), -32768).astype("<i2")
            names.append(k); scales.append(sc); blobs.append(q.tobytes())
        hdr = json.dumps({"half": D["half"], "n": D["n"], "time": D["time"], "kind": D["kind"], "vars": names, "scales": scales}).encode()
        body = len(hdr).to_bytes(4, "little") + hdr + b"\0" * ((2 - len(hdr) % 2) % 2) + b"".join(blobs)
        return Response(body, media_type="application/octet-stream")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            raise HTTPException(429, "Open-Meteo's free rate limit was hit; try again in a minute (or later today)")
        raise HTTPException(502, f"forecast grid unavailable: {e}")
    except (httpx.HTTPError, ValueError) as e:      # ValueError: a response that arrived cut short, three times
        raise HTTPException(502, f"forecast grid unavailable: {e}")


@app.get("/api/obsmap")
async def get_obsmap(scope: str = "state"):
    prods = ALL_OBS if scope == "national" else [OBS_MAP_PRODUCT]

    async def load():
        out, failed = [], 0
        for p in prods:
            try:
                out += await extras.station_obs(app.state.http, BOM, p, bom_fwo)
            except Exception as e:
                failed += 1
                log.warning("station obs %s failed: %s", p, e)
        if failed == len(prods):
            raise HTTPException(502, "BoM station observations didn't load")
        return Partial(out) if failed else out
    try:
        return {"stations": await cached(f"obsmap|{scope}", 600, load)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"station observations unavailable: {e}")


@app.get("/api/warnings")
async def get_warnings(scope: str = "state"):
    feeds = ALL_WARNINGS if scope == "national" else [WARNINGS_FEED]

    async def load():
        out, failed = [], 0
        for f in feeds:
            try:
                out += await bom_warnings(f)
            except Exception as e:
                failed += 1
                log.warning("warnings feed %s failed: %s", f, e)
        if failed == len(feeds):
            raise HTTPException(502, "BoM warnings feed didn't load")
        return Partial(out) if failed else out
    try:
        return {"warnings": await cached(f"warnings|{scope}", 300, load)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"warnings unavailable: {e}")


@app.get("/api/highways")
async def get_highways():
    try:
        return {"lines": await extras.highways(app.state.http, DATA, map_centres())}
    except Exception as e:
        raise HTTPException(502, f"highways unavailable: {e}")


@app.get("/api/fires")
async def get_fires():
    try:
        return {"fires": await cached("fires", 900, lambda: extras.fires(app.state.http, map_centres()))}
    except Exception as e:
        raise HTTPException(502, f"fire data unavailable: {e}")


@app.get("/api/obssounding")
async def get_obssounding(station: str | None = None):
    st = station or OBS_SOUNDING_STATION
    if not st.isdigit():
        raise HTTPException(400, "bad station")
    try:
        snd = await cached(f"obssnd|{st}", 1800, lambda: extras.observed_sounding(app.state.http, st))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"sounding archive unavailable: {e}")
    if not snd:
        raise HTTPException(404, "no recent sounding found")
    return snd


@app.get("/api/reports")
async def list_reports():
    return {"reports": REPORTS}


@app.post("/api/reports")
async def add_report(body: dict):
    try:
        rep_ = {"lat": round(float(body["lat"]), 4), "lon": round(float(body["lon"]), 4),
                "kind": str(body.get("kind", "other"))[:20], "size": float(body["size"]) if body.get("size") not in (None, "") else None,
                "note": str(body.get("note") or "")[:200], "t": str(body.get("t") or datetime.now(timezone.utc).isoformat())}
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "need lat, lon, kind")
    if not valid_point(rep_) or (rep_["size"] is not None and not (math.isfinite(rep_["size"]) and 0 <= rep_["size"] <= 300)):
        raise HTTPException(400, "lat/lon or size out of range")
    rep_["id"] = f"r{int(time.time() * 1000)}"
    REPORTS.append(rep_)
    REPORTS[:] = REPORTS[-500:]
    save_settings()
    return {"reports": REPORTS}


@app.delete("/api/reports/{rid}")
async def delete_report(rid: str):
    REPORTS[:] = [r for r in REPORTS if r.get("id") != rid]
    save_settings()
    return {"reports": REPORTS}


@app.get("/api/borders")
async def get_borders():
    try:
        return {"lines": await extras.state_borders(app.state.http, DATA)}
    except Exception as e:
        raise HTTPException(502, f"borders unavailable: {e}")


@app.get("/api/towns")
async def get_towns():
    try:
        return {"towns": await extras.towns(app.state.http, DATA, map_centres())}
    except Exception as e:
        raise HTTPException(502, f"town list unavailable: {e}")


def _speakable(t: str) -> str:
    """BoM titles shout (DAMAGING WINDS) and abbreviate; make them read naturally."""
    t = re.sub(r"\b([A-Z]{4,}(?:\s+[A-Z]{2,})*)\b", lambda m: m.group(1).lower(), t)
    t = t.replace("km/h", " kilometres per hour").replace("&", " and ")
    t = re.sub(r"(\d)\s*km\b", r"\1 kilometres", t)
    points = {"N": "north", "NNE": "north north-east", "NE": "north-east", "ENE": "east north-east", "E": "east",
              "ESE": "east south-east", "SE": "south-east", "SSE": "south south-east", "S": "south",
              "SSW": "south south-west", "SW": "south-west", "WSW": "west south-west", "W": "west",
              "WNW": "west north-west", "NW": "north-west", "NNW": "north north-west"}
    t = re.sub(r"\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b(?= of )", lambda m: points[m.group(1)], t)
    return re.sub(r"\s+", " ", t).strip()


def _nearby_towns(lat, lon, km, limit=60):
    try:
        towns = json.loads((DATA / "towns.json").read_text()).get("towns", [])
    except Exception:
        return []
    out = []
    for t in towns:
        if math.hypot((t["la"] - lat) * 111.11, (t["lo"] - lon) * 111.11 * math.cos(math.radians(lat))) <= km:
            out.append(t["n"])
            if len(out) >= limit:
                break
    return out


async def bom_severe():
    """BoM warnings worth an alert (severe thunderstorm, severe weather, cyclone, tsunami, fire, heatwave,
    moderate or major flood), each with its page text."""
    try:
        bom = await cached("warnings|state", 300, lambda: bom_warnings(WARNINGS_FEED))
    except Exception:
        return []
    out = []
    for b in bom:
        title = re.sub(r"^\d{2}/\d{2}:\d{2}\s+\w+\s+", "", re.sub(r"\s+", " ", b["title"])).strip()
        low = title.lower()
        if low.startswith("cancellation") or low.startswith("final") or "marine wind" in low or "sheep graziers" in low:
            continue
        if not (b["level"] == "severe" or any(k in low for k in ("severe weather", "fire weather", "heatwave", "bushfire"))
                or (b["level"] == "flood" and ("major" in low or "moderate" in low))):
            continue
        kind = "severe weather" if "severe weather" in low else "flood" if "flood" in low else "thunderstorm" if "thunderstorm" in low else "other"
        try:
            body = await cached(f"wtext|{b['link']}", 600, lambda: extras.warning_text(app.state.http, b["link"], bom_fwo))
        except Exception:
            body = ""
        if b.get("areas"):                       # FTP warnings list their districts directly
            body = (body + " Districts: " + ", ".join(b["areas"])).strip()
        out.append({"id": "bom-" + hashlib.sha1((b["link"] + "|" + title).encode()).hexdigest()[:12], "title": title,
                    "kind": kind, "link": b["link"], "pub": b.get("pub"), "body": body})
    return out


def _say_list(names):
    names = [n for n in names if n][:5]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1] if names else ""


def _bom_area_text(body: str, kind: str) -> str:
    """The parts of a BoM warning that say where it applies ("For people in ...", "Locations which may be
    affected include ..."). Matching the whole page is wrong: every WA warning says "Bureau of
    Meteorology, Perth" in its header and gives advice like "secure your home"."""
    parts = []
    for pat in (r"[Ff]or people in (.{0,500}?)(?:\.\s|Issued at)",
                r"[Ll]ocations (?:which|that) (?:may|could) be affected (?:include|are)\s*:?\s*(.{0,700}?)\.(?:\s|$)"):
        parts += re.findall(pat, body)
    if kind == "flood":
        # flood warnings name towns and gauges through the body; drop the header and the safety advice
        b = re.sub(r"Bureau of Meteorology[^.]{0,120}", " ", body)
        cut = re.search(r"(Emergency services advise|Safety advice|For emergency help)", b)
        parts.append(b[:cut.start()] if cut else b)
    return " ".join(parts)


@app.get("/api/alerts")
async def get_alerts(lat: float | None = None, lon: float | None = None, near: float = 50, far: float = 300, scope: str = "near"):
    """One alert feed for the web page and the phone app: wxdeck's own warnings and watches, BoM's severe
    ones, and damaging gusts measured near home, each with a short sentence to read aloud.
    Every alert says whether it is "near" (covers, or is within `near` km of, the point: home by default).
    scope "near" = only those; "all" = also wxdeck warnings, watches and gusts within `far` km (BoM
    warnings, which cover whole districts, only when they name a place near home). Near alerts come first."""
    if lat is not None and lon is not None and not (math.isfinite(lat) and math.isfinite(lon)):
        raise HTTPException(400, "bad position")
    plat, plon = (lat, lon) if lat is not None and lon is not None else (HOME["lat"], HOME["lon"])
    near, far = max(1.0, min(near, 500.0)), max(near, min(far, 5000.0))
    tz = ZoneInfo(TZ_NAME)
    now = datetime.now(timezone.utc)
    coslat = math.cos(math.radians(plat))
    km = lambda la, lo: math.hypot((la - plat) * 111.11, (lo - plon) * 111.11 * coslat)
    out = []
    names = {"TOR": "Tornado warning", "SVR": "Severe thunderstorm warning", "FFW": "Flash flood warning"}
    active = list(wxw.state["active"].values())          # the engine swaps in a new dict, so this is a safe snapshot
    for w in _dedupe([w for w in active if datetime.fromisoformat(w["expires"]) > now]):
        inside = wxw._in_poly(plat, plon, w["polygon"])
        # distance to the nearest corner of the warning area (0 inside), not to the storm's middle
        dist = 0.0 if inside else min(km(la, lo) for la, lo in w["polygon"])
        is_near = inside or dist <= near
        if not is_near and (scope != "all" or dist > far):
            continue
        until = datetime.fromisoformat(w["expires"]).astimezone(tz).strftime("%-I:%M %p")
        areas = w.get("towns") or []
        where = _say_list(areas) or "the area " + w["text"].split(" was located ")[-1].split(",")[0]
        # the event id stays the same when the national mosaic hands a storm to a radar (or back)
        out.append({"id": w.get("event") or w["id"], "source": "wxdeck", "type": w["type"], "severity": 3 if w["type"] == "TOR" else 2,
                    "title": names.get(w["type"], w["title"]), "areas": areas, "inside": inside, "near": is_near, "distance_km": round(dist),
                    "issued": w["issued"], "expires": w["expires"], "text": w["text"], "hazards": w.get("hazards", []),
                    "lat": w["lat"], "lon": w["lon"],
                    "speech": _speakable(f"{names.get(w['type'], w['title'])} issued for {where}, until {until}.")
                              + (" This includes your location." if inside else "")})
    local_names = [n.lower() for n in _nearby_towns(plat, plon, near) if n and len(n) > 3]
    for b in await bom_severe():
        title, kind, body = b["title"], b["kind"], b["body"]
        hay = (title + " " + _bom_area_text(body, kind)).lower()
        hits = [n for n in local_names if re.search(r"\b" + re.escape(n) + r"\b", hay)]
        is_near = bool(hits) or any(a in hay for a in BOM_AREAS)
        if not is_near and far < 1000:        # statewide feed: districts elsewhere in the state aren't "further away" alerts
            continue
        out.append({"id": b["id"],   # no issue time: updates don't re-alert
                    "source": "BoM", "type": "BOM", "bom_kind": kind, "severity": 2, "title": title,
                    "areas": [h.title() for h in hits[:6]], "inside": None, "near": is_near, "distance_km": None,
                    "issued": b.get("pub"), "expires": None, "text": title, "hazards": [], "link": b["link"],
                    "speech": f"Bureau of Meteorology. {_speakable(title).rstrip('.')}."
                              + (f" This includes {_say_list([h.title() for h in hits[:3]])}." if hits else "")})
    # wxdeck's model watches (damaging wind, severe thunderstorm, tornado, extreme heat, fire weather)
    for w in wxw.state.get("watches", []):
        if datetime.fromisoformat(w["valid_to"]) <= now:
            continue
        inside = wxw._in_poly(plat, plon, w["polygon"])
        dist = 0.0 if inside else min(km(la, lo) for la, lo in w["polygon"])
        is_near = inside or dist <= near
        if not is_near and (scope != "all" or dist > far):
            continue
        until = datetime.fromisoformat(w["valid_to"]).astimezone(tz)
        out.append({"id": w["id"], "source": "wxdeck", "type": w["type"], "severity": 1,
                    "title": w["title"], "areas": [], "inside": inside, "near": is_near, "distance_km": round(dist),
                    "issued": w.get("valid_from"), "expires": w["valid_to"], "text": w["text"], "hazards": [],
                    "speech": f"{w['title']} {'for your area' if inside else 'near your area'}, until {until.strftime('%-I %p').lower()}. "
                              + _speakable(w["text"])})
    # damaging wind gusts actually measured at stations (90 km/h or more, last 40 minutes)
    try:
        stations = await cached("obsmap|state", 600, lambda: extras.station_obs(app.state.http, BOM, OBS_MAP_PRODUCT, bom_fwo))
    except Exception:
        stations = []
    for st in stations:
        g = st.get("gust")
        if not g or g < 90 or not st.get("time"):
            continue
        d = km(st["lat"], st["lon"])
        is_near = d <= near
        if not is_near and (scope != "all" or d > far):
            continue
        try:
            obs_t = datetime.fromisoformat(st["time"].replace("Z", "+00:00"))
        except ValueError:
            continue
        if now - obs_t > timedelta(minutes=40):
            continue
        out.append({"id": f"gust-{st['name']}-{obs_t:%Y%m%d%H}", "source": "wxdeck", "type": "WIND", "severity": 2,
                    "title": "Damaging wind gust observed", "areas": [st["name"]], "inside": None, "near": is_near,
                    "distance_km": round(d), "issued": st["time"], "expires": None,
                    "text": f"A gust of {g:.0f} km/h was measured at {st['name']}.", "hazards": [],
                    "speech": f"Damaging wind gust of {g:.0f} kilometres per hour measured at {st['name']}."})
    out += await _extra_alerts(plat, plon, now, tz)
    # near ones first (most severe first), then the rest by distance
    out.sort(key=lambda a: (not a["near"], -a["severity"], a["distance_km"] if a["distance_km"] is not None else 0))
    return {"alerts": out, "point": [plat, plon], "generated": now.isoformat()}


LTG_ALERT_KM = float(os.getenv("LIGHTNING_ALERT_KM", "15"))


def nowcast_for(lat, lon):
    """Rain nowcast at a point from the nearest live radar covering it (or the national mosaic)."""
    best = None
    for rid in followed():
        r = radars.get(rid) or {}
        p3 = products.get(f"IDR{rid}3") or {}
        if r.get("lat") is None or not p3.get("available"):
            continue
        d = math.hypot((r["lat"] - lat) * 111.11, (r["lon"] - lon) * 111.11 * math.cos(math.radians(lat)))
        if d <= 110 and (best is None or d < best[0]):
            best = (d, f"IDR{rid}3", p3.get("km") or 128, r["lat"], r["lon"])
    tries = [best[1:]] if best else []
    if NATIONAL:
        tries.append((national.PID, national.HALF_KM, national.LAT0, national.LON0))
    for pid, km, la, lo in tries:
        nc = nowcast.nowcast(FRAMES, pid, km, la, lo, lat, lon)
        if nc:
            return nc
    return None


async def _extra_alerts(plat, plon, now, tz):
    """Lightning close by, a storm heading for the point, and rain about to start (flagged "rain" so the
    page and app only use it when switched on)."""
    out = []
    t1 = int(time.time() * 1000)
    try:
        rows = await run_in_threadpool(app.state.strikes.query, t1 - 10 * 60_000, t1, plat, plon, LTG_ALERT_KM)
    except Exception:
        rows = []
    near_rows = [r for r in rows if lightning.dist_km(plat, plon, r[1], r[2]) <= LTG_ALERT_KM]
    if near_rows:
        first = min(r[0] for r in near_rows)
        closest = min(lightning.dist_km(plat, plon, r[1], r[2]) for r in near_rows)
        out.append({"id": f"ltg-{first // 1_800_000}", "source": "wxdeck", "type": "LTG", "severity": 1,
                    "title": "Lightning nearby", "areas": [], "inside": None, "near": True, "distance_km": round(closest),
                    "issued": datetime.fromtimestamp(first / 1000, timezone.utc).isoformat(), "expires": None,
                    "text": f"{len(near_rows)} lightning strike{'s' if len(near_rows) != 1 else ''} within {LTG_ALERT_KM:.0f} km in the last 10 minutes, the closest {closest:.0f} km away.",
                    "hazards": [], "speech": f"Lightning within {max(1, round(closest))} kilometres. Head indoors."})
    # storms tracked by the warning engine whose path passes close to the point within the hour
    coslat = math.cos(math.radians(plat))
    fresh = {k for k, t in wxw.state.get("storms_t", {}).items() if time.time() - t < 20 * 60}
    seen = set()
    for src, lst in list(wxw.state.get("storms", {}).items()):
        if src not in fresh:
            continue
        for st in lst:
            if not st.get("dir") or st.get("speed", 0) < 10 or st.get("age", 1) < 3:
                continue
            x, y = (st["lon"] - plon) * 111.11 * coslat, (st["lat"] - plat) * 111.11
            a = math.radians(st["dir"])
            vx, vy = st["speed"] * math.sin(a), st["speed"] * math.cos(a)
            tca = -(x * vx + y * vy) / (vx * vx + vy * vy)           # hours to closest approach
            if not 0 < tca <= 1:
                continue
            miss = math.hypot(x + vx * tca, y + vy * tca)
            if miss > 8:
                continue
            key = (round(st["lat"], 1), round(st["lon"], 1))
            if key in seen:
                continue
            seen.add(key)
            eta = now + timedelta(hours=tca)
            dist = math.hypot(x, y)
            heavy = st["dbz"] >= 55
            out.append({"id": f"arr-{st['id']}", "source": "wxdeck", "type": "ARR", "severity": 1, "near": True,
                        "title": "Storm approaching", "areas": [], "inside": None, "distance_km": round(dist),
                        "issued": now.isoformat(), "expires": (eta + timedelta(minutes=20)).isoformat(),
                        "lat": st["lat"], "lon": st["lon"],
                        "text": f"A {'strong ' if heavy else ''}thunderstorm ({st['dbz']} dBZ) {dist:.0f} km away is moving towards you at {st['speed']} km/h, arriving around {eta.astimezone(tz):%-I:%M %p}.",
                        "hazards": [], "speech": f"{'Strong thunderstorm' if heavy else 'Thunderstorm'} approaching, arriving in about {max(5, round(tca * 60 / 5) * 5)} minutes."})
    # rain about to start (opt-in on each device)
    try:
        nc = await run_in_threadpool(nowcast_for, plat, plon)
    except Exception:
        nc = None
    if nc:
        w = nowcast.words(nc, tz)
        if w["starts_min"] is not None and 0 < w["starts_min"] <= 30:
            start = now + timedelta(minutes=w["starts_min"])
            out.append({"id": f"rain-{int(start.timestamp()) // 3600}", "source": "wxdeck", "type": "RAIN", "severity": 0,
                        "near": True, "title": "Rain soon", "areas": [], "inside": None, "distance_km": None,
                        "issued": now.isoformat(), "expires": None, "text": w["text"], "hazards": [], "rain": True,
                        "speech": w["text"].replace(" min)", " minutes)")})
    return out


WMO_WORDS = {0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy", 45: "foggy", 48: "foggy", 51: "drizzly", 53: "drizzly",
             55: "drizzly", 61: "rainy", 63: "rainy", 65: "heavy rain", 80: "showers", 81: "showers", 82: "heavy showers",
             95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail"}


@app.get("/api/brief")
async def get_brief(lat: float | None = None, lon: float | None = None):
    """A short spoken-style summary for the day: forecast, rain range, storms and anything in force."""
    plat, plon = query_point(lat, lon)
    tz = ZoneInfo(TZ_NAME)
    now = datetime.now(tz)
    try:
        fc = await get_forecast(plat, plon)
    except HTTPException:
        fc = None
    parts = [f"Good {'morning' if now.hour < 12 else 'afternoon' if now.hour < 17 else 'evening'}."]
    if fc:
        parts += _brief_forecast(fc, now, tz)
    else:
        parts.append("The forecast isn't available right now.")
    al = await get_alerts(plat, plon, scope="near")
    warns = [a for a in al["alerts"] if a["severity"] >= 1 and a["type"] not in ("LTG", "RAIN")]
    if warns:
        parts.append("In force now: " + _say_list([a["title"] for a in warns[:3]]) + ".")
    else:
        parts.append("No warnings near you.")
    nc = await run_in_threadpool(nowcast_for, plat, plon)
    w = nowcast.words(nc, tz)
    if nc and w["starts_min"] is not None:
        parts.append(w["text"].replace(" min)", " minutes)"))
    return {"text": " ".join(parts), "point": [plat, plon]}


def _brief_forecast(fc, now, tz):
    D = fc["main"]["daily"]
    i = 0
    for k, t in enumerate(D["time"]):
        if datetime.fromtimestamp(t, tz).date() == now.date():
            i = k
    sky = WMO_WORDS.get(D["weather_code"][i], "mixed")
    lo, hi = D["temperature_2m_min"][i], D["temperature_2m_max"][i]
    parts = [f"Today looks {sky}, {round(lo)} to {round(hi)} degrees."]
    rr = (fc.get("rain_range") or {}).get(now.strftime("%Y-%m-%d"))
    if rr:
        if rr["chance"] < 15:
            parts.append("No rain expected.")
        else:
            lo_mm, hi_mm = (0 if rr["low"] < 1 else round(rr["low"])), max(1, round(rr["high"]))
            amt = f"up to {hi_mm} millimetres" if lo_mm == 0 else f"{lo_mm} to {hi_mm} millimetres"
            parts.append(f"{rr['chance']} percent chance of rain, {amt}.")
    g = D["wind_gusts_10m_max"][i]
    if g and g >= 50:
        parts.append(f"Gusts up to {round(g)} kilometres per hour.")
    H = fc["main"]["hourly"]
    capes = [c for t, c in zip(H["time"], H["cape"]) if c is not None and datetime.fromtimestamp(t, tz).date() == now.date()]
    if capes and max(capes) >= 800:
        parts.append(f"Storms possible, with instability up to {round(max(capes), -2):.0f}.")
    return parts


@app.get("/api/nowcast")
async def get_nowcast(lat: float | None = None, lon: float | None = None):
    plat, plon = query_point(lat, lon)
    nc = await run_in_threadpool(nowcast_for, plat, plon)
    return {"point": [plat, plon], "nowcast": nc, **nowcast.words(nc, ZoneInfo(TZ_NAME))}


@app.get("/api/verify")
async def get_verify(days: int = 30):
    return await run_in_threadpool(verify.summary, DATA, max(1, min(days, 365)))


@app.get("/api/metar")
async def get_metar():
    """Airport observations (METAR) from the US Aviation Weather Center, around home and every radar."""
    async def load():
        boxes = []
        for c in map_centres():
            r = c[2] if len(c) > 2 else 400
            dl, dn = r / 111.0, r / (111.0 * max(0.2, math.cos(math.radians(c[0]))))
            boxes.append((c[0] - dl, c[1] - dn, c[0] + dl, c[1] + dn))
        if NATIONAL:
            boxes = [(-45.0, 110.0, -9.0, 155.0)]
        seen, out = set(), []
        for b in boxes[:6]:
            r = await get_retry("https://aviationweather.gov/api/data/metar", {"bbox": ",".join(f"{v:.2f}" for v in b), "format": "json"})
            for m in r.json() if r.content.strip() else []:
                if m.get("icaoId") in seen or m.get("lat") is None:
                    continue
                seen.add(m["icaoId"])
                out.append({k: m.get(k) for k in ("icaoId", "name", "lat", "lon", "temp", "dewp", "wdir", "wspd", "wgst", "visib",
                                                  "altim", "rawOb", "reportTime", "fltCat", "cover", "wxString")})
        return out
    try:
        return {"metars": await cached("metar", 600, load)}
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(502, f"METAR source unavailable: {e}")


WEBCAM_KEY = os.getenv("WINDY_WEBCAMS_KEY", "")


@app.get("/api/webcams")
async def get_webcams(lat: float | None = None, lon: float | None = None, radius: int = 100):
    """Public webcams near a point (Windy Webcams API; needs a free key in WINDY_WEBCAMS_KEY)."""
    if not WEBCAM_KEY:
        return {"webcams": [], "enabled": False}
    plat, plon = query_point(lat, lon)
    radius = max(5, min(radius, 250))
    async def load():
        r = await app.state.http.get("https://api.windy.com/webcams/api/v3/webcams", params={
            "nearby": f"{plat},{plon},{radius}", "include": "images,location,urls", "limit": 50},
            headers={"x-windy-api-key": WEBCAM_KEY}, timeout=20)
        r.raise_for_status()
        out = []
        for w in r.json().get("webcams", []):
            loc, img = w.get("location") or {}, (w.get("images") or {}).get("current") or {}
            out.append({"id": w.get("webcamId"), "title": w.get("title"), "lat": loc.get("latitude"), "lon": loc.get("longitude"),
                        "thumb": img.get("thumbnail") or img.get("preview"), "preview": img.get("preview"),
                        "url": ((w.get("urls") or {}).get("detail")), "updated": w.get("lastUpdatedOn")})
        return out
    try:
        return {"webcams": await cached(f"cams|{plat:.1f},{plon:.1f},{radius}", 900, load), "enabled": True}
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(502, f"webcams unavailable: {e}")


GEO_COUNTRY = os.getenv("GEOCODE_COUNTRY", "au")


@app.get("/api/geocode")
async def geocode(q: str):
    """Find an address, suburb or town. Street addresses come from OpenStreetMap's Nominatim (used
    lightly, as its policy asks: cached, one search per request); place names from Open-Meteo."""
    q = q.strip()
    if len(q) < 3 or len(q) > 120:
        raise HTTPException(400, "type at least 3 characters")

    async def load():
        out, failed = [], 0
        try:
            r = await app.state.http.get("https://nominatim.openstreetmap.org/search", params={
                "q": q, "countrycodes": GEO_COUNTRY, "format": "jsonv2", "limit": 6, "addressdetails": 1},
                headers={"User-Agent": "wxdeck/1.0 (self-hosted weather dashboard)"}, timeout=15)
            if r.status_code == 200:
                for x in r.json():
                    a = x.get("address", {})
                    short = (a.get("suburb") or a.get("town") or a.get("city") or a.get("village") or a.get("hamlet")
                             or x.get("name") or x["display_name"].split(",")[0])
                    out.append({"label": x["display_name"].replace(", Australia", ""), "name": short[:40],
                                "lat": round(float(x["lat"]), 5), "lon": round(float(x["lon"]), 5)})
            else:
                failed += 1
        except (httpx.HTTPError, ValueError, KeyError):
            failed += 1
        if len(out) < 3:
            try:
                r = await app.state.http.get("https://geocoding-api.open-meteo.com/v1/search", params={
                    "name": q, "count": 6, "language": "en", "format": "json", "countryCode": GEO_COUNTRY.upper()}, timeout=15)
                for x in (r.json().get("results") or []):
                    label = ", ".join(v for v in (x["name"], x.get("admin2"), x.get("admin1")) if v)
                    if not any(abs(o["lat"] - x["latitude"]) < 0.01 and abs(o["lon"] - x["longitude"]) < 0.01 for o in out):
                        out.append({"label": label, "name": x["name"][:40], "lat": round(x["latitude"], 5), "lon": round(x["longitude"], 5)})
            except (httpx.HTTPError, ValueError, KeyError):
                failed += 1
        return Partial(out[:8]) if failed or not out else out[:8]
    return {"results": await cached(f"geo|{q.lower()}", 86400, load)}


@app.get("/api/speech")
async def get_speech(text: str):
    """Spoken version of an alert (WAV), made on the server so it works on every device."""
    text = text.strip()[:400]
    if not text:
        raise HTTPException(400, "no text")
    if not (DATA / "voices" / f"{speech.VOICE}.onnx").exists():
        # never make a caller (the phone's alert service) wait for the 60 MB voice download
        if not getattr(app.state, "voice_task", None) or app.state.voice_task.done():
            app.state.voice_task = asyncio.create_task(speech.ensure_voice(DATA))
        raise HTTPException(503, "the alert voice is still downloading")
    try:
        path = await run_in_threadpool(speech.synthesize, DATA, text)
    except Exception as e:
        raise HTTPException(503, f"speech unavailable: {e}")
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "max-age=86400"})


@app.post("/api/follow")
async def follow_radar(body: dict):
    """Start following a BoM radar (128 km reflectivity + Doppler) for a few hours. BoM's loop page already
    holds the last hour or so, so the loop is ready as soon as the first poll finishes."""
    ids = [str(x) for x in (body.get("radars") or [body.get("radar", "")])]
    known = set(radars) | national.known_ids(DATA)            # every BoM radar, once the national list has loaded
    ids = [x for x in ids if x.isdigit() and (len(known) < 20 or x in known)][:16]
    if not ids:
        raise HTTPException(400, "bad radar")
    try:
        hours = float(body.get("hours", 3))
    except (TypeError, ValueError):
        hours = 3.0
    hours = min(max(hours, 0.25), 24.0) if math.isfinite(hours) else 3.0
    new = [x for x in ids if x not in followed()]
    for rid in ids:
        follow(rid, hours)
    if body.get("wait", True):
        for rid in new:
            await poll_now(rid)
    else:                        # seamless map: fetch in the background, the page checks back shortly
        async def bg():
            # loops first, several radars at once; basemaps follow in the normal poll cycle
            sem = asyncio.Semaphore(4)
            async with httpx.AsyncClient(headers=UA, timeout=20, follow_redirects=True) as client:
                async def one(rid):
                    async with sem:
                        try:
                            for suf in AUTO_PRODUCTS:
                                await poll_product(client, rid, suf)
                        except Exception as e:
                            log.warning("follow %s failed: %s", rid, e)
                await asyncio.gather(*(one(r) for r in new))
        asyncio.create_task(bg())
    return {"radars": followed(), "new": new}


def _dedupe(items):
    """Prefer a radar's own (Doppler-backed) result over the coarse national mosaic for the same storm, and
    show a storm two radars both see (same event) once."""
    own, events = [], set()
    for w in items:
        if w.get("source") != national.PID:
            ev = w.get("event")
            if ev and ev in events:
                continue
            if ev:
                events.add(ev)
            own.append(w)
    nat = [w for w in items if w.get("source") == national.PID and (not w.get("event") or w["event"] not in events)
           and not any(abs(o["lat"] - w["lat"]) < 0.3 and abs(o["lon"] - w["lon"]) < 0.35 for o in own)]
    return own + nat


@app.get("/api/wxwarnings")
async def get_wxwarnings():
    now = datetime.now(timezone.utc)
    active = _dedupe([w for w in wxw.state["active"].values() if datetime.fromisoformat(w["expires"]) > now])
    order = {"TOR": 0, "SVR": 1, "FFW": 2}
    active.sort(key=lambda w: (order.get(w["type"], 9), -w.get("dbz", 0)))
    # only storms from sources still being watched and recently evaluated (a radar dropped after 2 hours
    # would otherwise leave its last ratings on screen forever)
    fresh = {k for k, t in wxw.state.get("storms_t", {}).items() if time.time() - t < 20 * 60 and (k == national.PID or k in followed())}
    storms = _dedupe([s for k, lst in wxw.state["storms"].items() if k in fresh for s in lst])
    rank = {"high": 2, "moderate": 1, "low": 0}
    storms.sort(key=lambda s: (-rank[(s["threat"] or {}).get("tornado", "low")], -rank[(s["threat"] or {}).get("supercell", "low")], -s["dbz"]))
    return {"active": active, "recent": wxw.state["recent"][-20:], "watches": wxw.state["watches"], "storms": storms[:30],
            "last_run": wxw.state["last_run"], "enabled": WXWARN}


@app.get("/api/status")
async def status():
    return {"products": products, "radars": radars, "lightning": lightning.status,
            "national": {k: v for k, v in national.state.items() if k != "radars"} | {"radars": len(national.state["radars"])}}


# ---------------------------------------------------------------- static
FRAMES.mkdir(parents=True, exist_ok=True)
LAYERS.mkdir(parents=True, exist_ok=True)
app.mount("/frames", StaticFiles(directory=FRAMES), name="frames")
app.mount("/layers", StaticFiles(directory=LAYERS), name="layers")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/app")
async def app_page():
    """Phone-friendly download page for the Android app."""
    apk = STATIC / "downloads" / "wxdeck.apk"
    size = f"{apk.stat().st_size / 1e6:.1f} MB" if apk.exists() else "not built"
    return Response(f"""<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get wxdeck</title><style>body{{background:#0f1a20;color:#d6e2e4;font-family:system-ui,sans-serif;padding:28px 22px;line-height:1.5}}
a.b{{display:block;text-align:center;background:#f2a93b;color:#0f1a20;font-weight:700;padding:14px;border-radius:10px;text-decoration:none;margin:18px 0}}
h1{{color:#f2a93b;margin:0}} code{{background:#1b2c35;padding:1px 5px;border-radius:5px}} small{{color:#8aa0a6}}</style></head><body>
<h1>wxdeck</h1><p>Install the Android app, then connect it to this server.</p>
<a class="b" href="/app/wxdeck.apk">Download for Android ({size})</a>
<p><small>Android will ask you to allow installs from your browser the first time. When the app opens, enter this server's address:</small><br>
<code id="u"></code></p>
<p><b>iPhone / iPad:</b> open this server in Safari, tap Share, then <b>Add to Home Screen</b>. wxdeck opens full screen like an app.</p>
<p><b>PC:</b> in Chrome or Edge, use the install icon in the address bar (works on <code>localhost</code> or an https address).</p>
<script>document.getElementById("u").textContent = location.origin;</script></body></html>""", media_type="text/html")


@app.get("/app/wxdeck.apk")
async def app_apk():
    apk = STATIC / "downloads" / "wxdeck.apk"
    if not apk.exists():
        raise HTTPException(404, "the Android app hasn't been built into this server")
    return FileResponse(apk, media_type="application/vnd.android.package-archive", filename="wxdeck.apk")


@app.get("/sw.js")
async def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="application/javascript")


_index_cache = {"key": None, "html": None}


def _asset_versions():
    """Content hash of every app file, so browsers (which keep /static files for a year) always load
    the current version after an update without anyone bumping version numbers by hand."""
    import hashlib
    out = {}
    for f in STATIC.glob("*.*"):
        if f.suffix in (".js", ".css"):
            out[f.name] = hashlib.md5(f.read_bytes()).hexdigest()[:10]
    return out


@app.get("/")
async def index():
    files = sorted(STATIC.glob("*.*"))
    key = tuple((f.name, f.stat().st_mtime) for f in files)
    if _index_cache["key"] != key:
        v = _asset_versions()
        html = (STATIC / "index.html").read_text()
        html = re.sub(r'(/static/([\w.-]+\.(?:js|css)))\?v=\w+', lambda m: f"{m.group(1)}?v={v.get(m.group(2), '1')}", html)
        html = html.replace("<head>", f"<head>\n<script>window.WXV = {json.dumps(v)};</script>", 1)
        _index_cache.update(key=key, html=html)
    return Response(_index_cache["html"], media_type="text/html", headers={"Cache-Control": "no-cache"})
