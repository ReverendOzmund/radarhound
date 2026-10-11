"""Rain nowcast for one point: "light rain starting around 7:40 pm" plus a minute-by-minute bar chart.

Extrapolation, the way RainViewer and the BoM app's rain alerts work: the echo pattern on the radar
(BoM's 128 km reflectivity, or the national mosaic when no radar covers the point) is moved along its
recent motion. Motion comes from phase correlation between the newest frame and the one 15-20 minutes
earlier. Each future step samples the newest frame upwind of the point (the largest value within a few
km, so small timing errors don't hide a cell). Good for about an hour; storms that form or die in that
time are not foreseen.
"""
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import warnings_engine as wxw

FRAME_T = re.compile(r"\.T\.(\d{12})\.png$")
REFL_RATE = wxw.REFL_RATE               # mm/h for BoM's 15 levels
STEP_MIN, HORIZON_MIN = 5, 60


def _frames(frames_dir: Path, pid: str):
    d = frames_dir / pid
    out = []
    if d.exists():
        for f in d.glob("*.png"):
            m = FRAME_T.search(f.name)
            if m:
                out.append((datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc), f))
    out.sort()
    return out


def _motion(a: np.ndarray, b: np.ndarray, kpp: float, dt_h: float):
    """Pattern shift from a to b by phase correlation -> (vx, vy) km/h (x east, y north), or None."""
    fa = np.fft.fft2((a > 0).astype(np.float32) * (a.astype(np.float32) + 1))
    fb = np.fft.fft2((b > 0).astype(np.float32) * (b.astype(np.float32) + 1))
    r = fb * np.conj(fa)
    r /= np.abs(r) + 1e-9
    c = np.abs(np.fft.ifft2(r))
    c[0, 0] *= 0.5                                 # ground clutter and the range rings pull towards zero shift
    j, i = np.unravel_index(int(np.argmax(c)), c.shape)
    n = a.shape[0]
    dy = j if j < n // 2 else j - n
    dx = i if i < n // 2 else i - n
    vx, vy = dx * kpp / dt_h, -dy * kpp / dt_h
    if math.hypot(vx, vy) > 150:                   # not believable for rain bands
        return None
    return vx, vy


def nowcast(frames_dir: Path, pid: str, km: float, lat0: float, lon0: float, lat: float, lon: float):
    fs = _frames(frames_dir, pid)
    if len(fs) < 2:
        return None
    t1, f1 = fs[-1]
    if datetime.now(timezone.utc) - t1 > timedelta(minutes=20):
        return None
    older = [x for x in fs if 12 <= (t1 - x[0]).total_seconds() / 60 <= 25] or fs[-2:-1]
    t0, f0 = older[-1]
    b = wxw.levels(f1.read_bytes())
    a = wxw.levels(f0.read_bytes())
    n = b.shape[0]
    kpp = km / (n / 2)
    mv = _motion(a, b, kpp, max(1e-3, (t1 - t0).total_seconds() / 3600)) or (0.0, 0.0)
    # the point in image km
    x = (lon - lon0) * 111.11 * math.cos(math.radians(lat))
    y = (lat - lat0) * 111.11
    if math.hypot(x, y) > km * 0.95:
        return None
    rad = max(1, int(round(3 / kpp)))              # sample the strongest echo within ~3 km
    steps = []
    now = datetime.now(timezone.utc)
    lead0 = (now - t1).total_seconds() / 3600       # the newest frame is already a few minutes old
    for k in range(0, HORIZON_MIN // STEP_MIN + 1):
        h = lead0 + k * STEP_MIN / 60
        sx, sy = x - mv[0] * h, y - mv[1] * h      # where the rain that reaches the point now was then
        px, py = int(round(n / 2 + sx / kpp)), int(round(n / 2 - sy / kpp))
        win = b[max(0, py - rad):py + rad + 1, max(0, px - rad):px + rad + 1]
        lv = int(win.max()) if win.size else 0
        rate = REFL_RATE[lv - 1] if lv >= 1 else 0.0
        steps.append({"min": k * STEP_MIN, "rate": rate, "level": lv})
    return {"radar": pid, "frame_time": t1.isoformat(), "motion_kmh": [round(mv[0]), round(mv[1])], "steps": steps}


def words(nc, tz) -> dict:
    """Plain-language summary: 'Light rain starting around 7:40 pm', 'Rain easing in about 20 minutes'."""
    if not nc:
        return {"text": "No nowcast: no live radar covers this spot.", "starts_min": None, "ends_min": None}
    st = nc["steps"]
    wet = [s["rate"] >= 0.5 for s in st]
    def kind(rate):
        return "heavy rain" if rate >= 10 else "moderate rain" if rate >= 2.5 else "light rain"
    now = datetime.now(timezone.utc)
    at = lambda m: (now + timedelta(minutes=m)).astimezone(tz).strftime("%-I:%M %p").lower()
    if wet[0]:
        end = next((s["min"] for s, w in zip(st, wet) if not w), None)
        peak = max(s["rate"] for s in st if s["rate"] >= 0.5)
        if end is None:
            return {"text": f"{kind(st[0]['rate']).capitalize()} now, continuing for the next hour.", "starts_min": 0, "ends_min": None}
        return {"text": f"{kind(peak).capitalize()} now, easing around {at(end)} (in about {end} min).", "starts_min": 0, "ends_min": end}
    start = next((s for s, w in zip(st, wet) if w), None)
    if start is None:
        if any(s["rate"] > 0 for s in st):
            return {"text": "Spits of very light rain at most in the next hour.", "starts_min": None, "ends_min": None}
        return {"text": "No rain expected in the next hour.", "starts_min": None, "ends_min": None}
    peak = max(s["rate"] for s in st if s["min"] >= start["min"])
    return {"text": f"{kind(peak).capitalize()} starting around {at(start['min'])} (in about {start['min']} min).",
            "starts_min": start["min"], "ends_min": None}
