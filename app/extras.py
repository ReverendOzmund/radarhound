"""Map layers beyond radar and satellite.

* Forecast grid: Open-Meteo best-match model on a 21 x 21 grid (60 km spacing, +-600 km) around
  the radar, hourly for 48 h, for Windy-style colour layers, wind particles and isobars.
* Station observations: BoM's state-wide latest observations XML (e.g. IDW60920 for WA).
* Town labels: GeoNames populated places (downloaded once) so labels stay sharp at any zoom.
"""
import asyncio
import csv
import io
import json
import math
import re
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import httpx

import os
FC_HALF = 600
# Open-Meteo's free tier counts every grid point as a call (10,000 a day, 600 a minute), so the grid
# stays coarse: 13 x 13 points = 100 km spacing, 169 calls per layer group per refresh.
FC_N = int(os.getenv("FC_GRID", "13"))
FC_MODELS = {"best": None, "ecmwf": "ecmwf_ifs025", "gfs": "gfs_seamless", "icon": "icon_seamless", "access": "bom_access_global"}
LEVELS = [925, 850, 700, 500, 300, 250]

# what each grid "kind" asks Open-Meteo for, and how keys map to our short names
KINDS = {
    # at most 10 variables per request, or Open-Meteo counts it twice
    "sfc": {"api": "https://api.open-meteo.com/v1/forecast", "vars": {
        "temp": "temperature_2m", "dew": "dew_point_2m", "rh": "relative_humidity_2m", "gust": "wind_gusts_10m",
        "rain": "precipitation", "cloud": "cloud_cover", "mslp": "pressure_msl", "cape": "cape"},
        "wind": ("wind_speed_10m", "wind_direction_10m"), "models": True},
    "sfc2": {"api": "https://api.open-meteo.com/v1/forecast", "vars": {
        "wbt": "wet_bulb_temperature_2m", "low": "cloud_cover_low", "mid": "cloud_cover_mid", "high": "cloud_cover_high",
        "vis": "visibility", "li": "lifted_index", "fzl": "freezing_level_height", "uv": "uv_index"}, "models": True},
    "marine": {"api": "https://marine-api.open-meteo.com/v1/marine", "vars": {
        "wave": "wave_height", "wper": "wave_period", "swell": "swell_wave_height", "sper": "swell_wave_period",
        "sst": "sea_surface_temperature", "cur": "ocean_current_velocity"},
        "wind": ("swell_wave_height", "swell_wave_direction"), "dir_only": True, "models": False},
    "air": {"api": "https://air-quality-api.open-meteo.com/v1/air-quality", "vars": {
        "pm25": "pm2_5", "pm10": "pm10", "dust": "dust", "aod": "aerosol_optical_depth", "aqi": "us_aqi",
        "co": "carbon_monoxide", "uvi": "uv_index"}, "models": False},
}
# severe-weather environment: winds through 0-6 km plus CAPE/CIN/LCL -> shear, helicity, STP, SCP
KINDS["svr"] = {"api": "https://api.open-meteo.com/v1/forecast", "vars": {
    "t2": "temperature_2m", "td2": "dew_point_2m", "cape": "cape", "cin": "convective_inhibition",
    "ws0": "wind_speed_10m", "wd0": "wind_direction_10m", "ws925": "wind_speed_925hPa", "wd925": "wind_direction_925hPa",
    "ws850": "wind_speed_850hPa", "wd850": "wind_direction_850hPa", "ws700": "wind_speed_700hPa", "wd700": "wind_direction_700hPa",
    "ws500": "wind_speed_500hPa", "wd500": "wind_direction_500hPa"}, "models": True, "derive": "svr"}
SVR_Z = [0.0, 0.75, 1.5, 3.0, 5.6]          # approximate heights (km AGL) of 10 m, 925, 850, 700, 500 hPa


def _svr_point(get, southern):
    """Bulk shear, storm-relative helicity, Bunkers motion, STP and SCP from a 5-level wind profile."""
    U, V = [], []
    for lv in ("0", "925", "850", "700", "500"):
        ws, wd = get(f"ws{lv}"), get(f"wd{lv}")
        if ws is None or wd is None:
            return None
        ws = ws / 3.6
        U.append(-ws * math.sin(math.radians(wd))); V.append(-ws * math.cos(math.radians(wd)))
    def at(z):
        for i in range(len(SVR_Z) - 1):
            if SVR_Z[i] <= z <= SVR_Z[i + 1]:
                f = (z - SVR_Z[i]) / (SVR_Z[i + 1] - SVR_Z[i])
                return U[i] + (U[i + 1] - U[i]) * f, V[i] + (V[i + 1] - V[i]) * f
        return U[-1], V[-1]
    zs = [k * 0.25 for k in range(23)]                         # 0 to 5.5 km
    mu = sum(at(z)[0] for z in zs) / len(zs); mv = sum(at(z)[1] for z in zs) / len(zs)
    su, sv = U[-1] - U[0], V[-1] - V[0]
    bwd = math.hypot(su, sv) or 0.1
    dev = (7.5 * sv / bwd, -7.5 * su / bwd)
    left, right = (mu - dev[0], mv - dev[1]), (mu + dev[0], mv + dev[1])
    sm = left if southern else right
    def srh(ztop):
        h = 0.0
        z = 0.0
        while z < ztop - 1e-6:
            (u1, v1), (u2, v2) = at(z), at(min(ztop, z + 0.1))
            h += (u2 - sm[0]) * (v1 - sm[1]) - (u1 - sm[0]) * (v2 - sm[1])
            z += 0.1
        return -h if southern else h                             # cyclonic helicity reported as positive
    srh1, srh3 = srh(1.0), srh(3.0)
    cape, cin = get("cape") or 0.0, -abs(get("cin") or 0.0)      # Open-Meteo reports CIN as a positive magnitude
    t2, td2 = get("t2"), get("td2")
    lcl = 125.0 * (t2 - td2) if t2 is not None and td2 is not None else 1500.0
    lcl_t = 1.0 if lcl < 1000 else 0.0 if lcl > 2000 else (2000 - lcl) / 1000
    shr_t = 0.0 if bwd < 12.5 else min(1.5, bwd / 20)
    cin_t = 1.0 if cin > -50 else 0.0 if cin < -200 else (200 + cin) / 150
    stp = max(0.0, cape / 1500) * lcl_t * max(0.0, srh1 / 150) * shr_t * cin_t
    scp = max(0.0, cape / 1000) * max(0.0, srh3 / 50) * (0.0 if bwd < 10 else min(1.0, bwd / 20))
    return {"stp": round(stp, 2), "scp": round(scp, 2), "shear6": round(bwd * 1.944, 1), "srh1": round(srh1),
            "srh3": round(srh3), "lcl": round(lcl), "cin": round(cin), "cape": round(cape),
            "u": round(sm[0] * 3.6, 1), "v": round(sm[1] * 3.6, 1), "mu": round(mu * 3.6, 1), "mv": round(mv * 3.6, 1)}


for _p in LEVELS:
    KINDS[f"p{_p}"] = {"api": "https://api.open-meteo.com/v1/forecast", "vars": {
        "temp": f"temperature_{_p}hPa", "rh": f"relative_humidity_{_p}hPa", "gph": f"geopotential_height_{_p}hPa"},
        "wind": (f"wind_speed_{_p}hPa", f"wind_direction_{_p}hPa"), "models": True}


def grid_points(lat0, lon0, half=FC_HALF, n=FC_N):
    step = 2 * half / (n - 1)
    pts = []
    for j in range(n):
        for i in range(n):
            x, y = -half + i * step, half - j * step
            la = lat0 + y / 111.11
            lo = lon0 + x / (111.11 * math.cos(math.radians(la)))
            pts.append((round(la, 3), round(lo, 3)))
    return pts


async def forecast_grid(client: httpx.AsyncClient, lat0, lon0, tz, model="best", kind="sfc", half=FC_HALF, n=FC_N):
    spec = KINDS[kind]
    pts = grid_points(lat0, lon0, half, n)
    want = list(spec["vars"].values()) + (list(spec["wind"]) if spec.get("wind") else [])
    rows = []
    for k in range(0, len(pts), 100):
        chunk = pts[k:k + 100]
        params = {"latitude": ",".join(str(p[0]) for p in chunk), "longitude": ",".join(str(p[1]) for p in chunk),
                  "hourly": ",".join(dict.fromkeys(want)), "forecast_hours": 48, "timeformat": "unixtime", "timezone": tz}
        if kind not in ("air", "marine"):
            params["wind_speed_unit"] = "kmh"
        if spec["models"] and FC_MODELS.get(model):
            params["models"] = FC_MODELS[model]
        for attempt in range(3):                       # big responses occasionally arrive cut short: retry
            try:
                r = await client.get(spec["api"], params=params, timeout=90)
                r.raise_for_status()
                d = await asyncio.to_thread(r.json)      # several MB of JSON: parse off the event loop
                break
            except (ValueError, httpx.TransportError):
                if attempt == 2:
                    raise
                await asyncio.sleep(3)
        rows += d if isinstance(d, list) else [d]
    # turning ~170 points x 48 hours into grids (and, for "svr", lifting a parcel at each) takes a while:
    # do it in a worker thread so the web server keeps answering
    return await asyncio.to_thread(_assemble, rows, spec, kind, lat0, half, n)


def _assemble(rows, spec, kind, lat0, half, n):
    times = rows[0]["hourly"]["time"][:48]
    nt = len(times)
    if spec.get("derive") == "svr":
        southern = lat0 < 0
        keys = ["stp", "scp", "shear6", "srh1", "srh3", "lcl", "cin", "cape", "u", "v", "mu", "mv"]
        out = {k: [[None] * len(rows) for _ in range(nt)] for k in keys}
        for p, row in enumerate(rows):
            H = row.get("hourly", {})
            for t in range(nt):
                def get(k, H=H, t=t):
                    arr = H.get(spec["vars"][k])
                    return arr[t] if arr and t < len(arr) else None
                r = _svr_point(get, southern)
                if r:
                    for k in keys:
                        out[k][t][p] = r[k]
        return {"half": half, "n": n, "time": times, "kind": kind, "vars": out}
    keys = list(spec["vars"]) + (["u", "v"] if spec.get("wind") else [])
    out = {k: [[None] * len(rows) for _ in range(nt)] for k in keys}
    for p, row in enumerate(rows):
        H = row.get("hourly", {})
        for t in range(nt):
            if spec.get("wind"):
                sp_k, dr_k = spec["wind"]
                ws, wd = (H.get(sp_k) or [None] * nt)[t], (H.get(dr_k) or [None] * nt)[t]
                if ws is not None and wd is not None:
                    if spec.get("dir_only"):      # swell: unit vector in the direction waves travel
                        ws = 30.0
                        wd = (wd + 180) % 360
                    out["u"][t][p] = round(-ws * math.sin(math.radians(wd)), 1)
                    out["v"][t][p] = round(-ws * math.cos(math.radians(wd)), 1)
            for key, var in spec["vars"].items():
                arr = H.get(var)
                v = arr[t] if arr and t < len(arr) else None
                out[key][t][p] = None if v is None else round(v, 2 if key == "aod" else 1)
    return {"half": half, "n": n, "time": times, "kind": kind, "vars": out}


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


async def station_obs(client: httpx.AsyncClient, bom: str, product: str):
    r = await client.get(f"{bom}/fwo/{product}.xml")
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []
    for st in root.iter("station"):
        a = st.attrib
        vals = {}
        tm = None
        for per in st.iter("period"):
            tm = per.attrib.get("time-utc", tm)
            for el in per.iter("element"):
                vals[el.attrib.get("type")] = el.text
        lat, lon = _num(a.get("lat")), _num(a.get("lon"))
        if lat is None or lon is None:
            continue
        out.append({
            "name": a.get("description") or a.get("stn-name"), "lat": lat, "lon": lon, "time": tm,
            "t": _num(vals.get("air_temperature")), "td": _num(vals.get("dew_point")),
            "dir": _num(vals.get("wind_dir_deg")), "spd": _num(vals.get("wind_spd_kmh")),
            "gust": _num(vals.get("gust_kmh")), "msl": _num(vals.get("msl_pres")), "rain": _num(vals.get("rainfall")),
        })
    return out


async def towns(client: httpx.AsyncClient, data_dir: Path, centres, radius_km=800, country="AU"):
    """Populated places near the radars/home, biggest first. Cached; rebuilt if centres change."""
    key = json.dumps([[round(c[0], 2), round(c[1], 2)] + list(c[2:]) for c in centres])
    cache = data_dir / "towns.json"
    if cache.exists():
        saved = json.loads(cache.read_text())
        if saved.get("key") == key:
            return saved["towns"]
    raw = data_dir / f"geonames_{country}.txt"
    if not raw.exists() or time.time() - raw.stat().st_mtime > 90 * 86400:
        r = await client.get(f"https://download.geonames.org/export/dump/{country}.zip", timeout=120)
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            raw.write_bytes(z.read(f"{country}.txt"))
    out = []
    with raw.open(encoding="utf-8") as f:
        for line in f:
            c = line.split("\t")
            if len(c) < 15 or c[6] != "P":
                continue
            la, lo = float(c[4]), float(c[5])
            if not any(abs(la - c[0]) * 111 < (c[2] if len(c) > 2 else radius_km) and
                       math.hypot((la - c[0]) * 111, (lo - c[1]) * 111 * math.cos(math.radians(c[0]))) < (c[2] if len(c) > 2 else radius_km)
                       for c in centres):
                continue
            pop = int(c[14] or 0)
            rank = pop + {"PPLC": 5e6, "PPLA": 1e6, "PPLA2": 2e4, "PPLA3": 5e3}.get(c[7], 0)
            out.append({"n": c[1], "la": round(la, 4), "lo": round(lo, 4), "p": int(rank)})
    out.sort(key=lambda t: -t["p"])
    out = out[:4000]
    cache.write_text(json.dumps({"key": key, "towns": out}))
    return out


async def warnings(client: httpx.AsyncClient, bom: str, feed: str):
    """BoM's public warnings RSS for one state (e.g. IDZ00060.warnings_wa)."""
    r = await client.get(f"{bom}/fwo/{feed}.xml")
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []
    for it in root.iter("item"):
        title = " ".join((it.findtext("title") or "").split())
        link = (it.findtext("link") or "").replace("http://", "https://")
        low = title.lower()
        level = "severe" if any(k in low for k in ("thunderstorm", "severe weather", "cyclone", "tsunami", "emergency")) \
            else "flood" if "flood" in low else "other"
        out.append({"title": title, "link": link, "pub": it.findtext("pubDate"), "level": level})
    return out


async def highways(client: httpx.AsyncClient, data_dir: Path, centres, radius_km=900):
    """Natural Earth major and secondary highways near the radars/home (downloaded once, ~50 MB)."""
    key = json.dumps([[round(c[0], 2), round(c[1], 2)] + list(c[2:]) for c in centres])
    cache = data_dir / "highways.json"
    if cache.exists():
        saved = json.loads(cache.read_text())
        if saved.get("key") == key:
            return saved["lines"]
    raw = data_dir / "ne_10m_roads.geojson"
    if not raw.exists():
        r = await client.get("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson", timeout=300)
        r.raise_for_status()
        raw.write_bytes(r.content)
    d = json.loads(raw.read_text())
    lines = []
    for f in d["features"]:
        t = f["properties"].get("type")
        if t not in ("Major Highway", "Secondary Highway", "Road"):
            continue
        g = f["geometry"]
        parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for ln in parts:
            near = any(math.hypot((la - c[0]) * 111, (lo - c[1]) * 111 * math.cos(math.radians(c[0]))) < (c[2] if len(c) > 2 else radius_km)
                       for lo, la in ln[::4] for c in centres)
            if near:
                lines.append({"t": 1 if t == "Major Highway" else 2, "c": [[round(la, 4), round(lo, 4)] for lo, la in ln]})
    cache.write_text(json.dumps({"key": key, "lines": lines}))
    return lines


FIRMS_FEEDS = [
    ("VIIRS S-NPP", "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Australia_NewZealand_24h.csv"),
    ("VIIRS NOAA-20", "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Australia_NewZealand_24h.csv"),
    ("VIIRS NOAA-21", "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Australia_NewZealand_24h.csv"),
    ("MODIS", "modis-c6.1/csv/MODIS_C6_1_Australia_NewZealand_24h.csv"),
]


async def fires(client: httpx.AsyncClient, centres, radius_km=1500):
    """NASA FIRMS active fire detections from the last 24 h near the radars/home."""
    out = []
    for sat, path in FIRMS_FEEDS:
        try:
            r = await client.get(f"https://firms.modaps.eosdis.nasa.gov/data/active_fire/{path}", timeout=60)
            r.raise_for_status()
        except httpx.HTTPError:
            continue
        for row in csv.DictReader(io.StringIO(r.text)):
            try:
                la, lo = float(row["latitude"]), float(row["longitude"])
            except (KeyError, ValueError):
                continue
            if not any(math.hypot((la - c[0]) * 111, (lo - c[1]) * 111 * math.cos(math.radians(c[0]))) < (c[2] if len(c) > 2 else radius_km)
                       for c in centres):
                continue
            t = row.get("acq_time", "0000").zfill(4)
            out.append({"la": la, "lo": lo, "t": f"{row.get('acq_date')}T{t[:2]}:{t[2:]}:00Z", "frp": float(row.get("frp") or 0),
                        "conf": row.get("confidence"), "sat": sat})
    return out


async def observed_sounding(client: httpx.AsyncClient, station: str):
    """Latest radiosonde from the University of Wyoming archive (00Z/12Z, plus 23Z/11Z launches)."""
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0)
    for back in range(0, 48):
        t = base - timedelta(hours=back)
        if t.hour not in (0, 12, 23, 11):
            continue
        r = await client.get("https://weather.uwyo.edu/wsgi/sounding", params={
            "datetime": t.strftime("%Y-%m-%d %H:%M:%S"), "id": station, "src": "UNKNOWN", "type": "TEXT:LIST"}, timeout=40)
        if r.status_code != 200 or "<PRE>" not in r.text.upper():
            continue
        txt = r.text
        i = txt.upper().find("<PRE>")
        block = txt[i + 5: txt.upper().find("</PRE>", i)]
        levels = []
        for line in block.splitlines():
            parts = line.split()
            if len(parts) < 8:
                continue
            try:
                p, z, tt, td = float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])
                drct, sped = float(parts[6]), float(parts[7])
            except ValueError:
                continue
            levels.append({"p": p, "z": z, "t": tt, "td": td, "dir": drct, "spd": sped})
        if len(levels) > 10:
            return {"station": station, "time": t.isoformat(), "levels": levels}
    return None


async def state_borders(client: httpx.AsyncClient, data_dir: Path, country="Australia"):
    """Natural Earth state/territory boundary lines (downloaded once)."""
    cache = data_dir / "borders.json"
    if cache.exists():
        return json.loads(cache.read_text())
    r = await client.get("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson", timeout=120)
    r.raise_for_status()
    d = r.json()
    lines = []
    for f in d["features"]:
        p = f["properties"]
        if country not in (p.get("adm0_name") or p.get("ADM0_NAME") or ""):
            continue
        g = f["geometry"]
        parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for ln in parts:
            lines.append([[round(la, 4), round(lo, 4)] for lo, la in ln])
    cache.write_text(json.dumps(lines))
    return lines


async def warning_text(client: httpx.AsyncClient, link: str) -> str:
    """Plain text of a BoM warning page (for "Locations which may be affected include ..." matching)."""
    import html as _html
    r = await client.get(link.replace("http://", "https://"), timeout=30)
    r.raise_for_status()
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", r.text, flags=re.S)
    t = _html.unescape(re.sub(r"<[^>]+>", " ", t))
    t = re.sub(r"\s+", " ", t)
    i = t.find("Bureau of Meteorology", t.find("Skip to main content"))
    return t[max(0, i):][:6000]
