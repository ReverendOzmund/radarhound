"""Dust devil potential and point environment snapshots.

Dust devils don't show on weather radar (too shallow, too small, no rain), so this is a model-derived
index. They need three things at once:

  1. strong surface heating over dry ground (a superadiabatic layer just above the surface),
  2. a deep, dry convective boundary layer (big thermals: the deeper the layer, the bigger the devil),
  3. light to moderate background wind (a bit of shear to spin the thermals up, not enough to tear them apart).

The physical core is the convective velocity scale  w* = (g/T * Qh * zi)^(1/3)  where Qh is the surface
sensible heat flux (estimated from sunshine and soil dryness) and zi is the boundary layer depth. Around
2 m/s thermals are weak; from about 3 m/s dust devils are common on bare dry ground.

The result is 0 to 10:  under 2 unlikely, 2 to 4 possible, 4 to 7 likely, 7+ very likely (and large ones).
It's a heuristic, not a verified forecast: log sightings and the verification data will show how well it does.
"""
import math

LABELS = [(7, "very likely"), (4, "likely"), (2, "possible"), (0, "unlikely")]


def label(v):
    if v is None:
        return "unknown"
    return next(name for lo, name in LABELS if v >= lo)


def _ramp(x, lo, hi):
    return 0.0 if x <= lo else 1.0 if x >= hi else (x - lo) / (hi - lo)


def index(t2, rh, wind_kmh, blh=None, sw=None, ts=None, sm=None, rain=None):
    """Dust devil potential (0-10) and its ingredients for one place and hour.

    t2 air temperature (C), rh relative humidity (%), wind_kmh 10 m wind, blh boundary layer height (m),
    sw downward shortwave radiation (W/m2), ts ground skin temperature (C), sm top soil moisture (m3/m3),
    rain precipitation (mm in the hour). Missing optional inputs fall back to neutral estimates: some models
    don't publish boundary layer depth (ECMWF, ICON) or soil fields (GFS), so the index is rougher for those
    than for "best match", and a model with no sunshine figure gives no index at all."""
    if t2 is None or wind_kmh is None or sw is None or t2 < -90:
        return None          # no sunshine figure from this model: say nothing rather than "unlikely"
    rh = 40.0 if rh is None else rh
    sw = max(0.0, sw)
    # sensible heat flux: about 45% of the incoming sunshine over bare dry ground, much less over wet soil
    dry = 1.0 if sm is None else max(0.25, min(1.0, 1 - (sm - 0.08) / 0.22))
    heat = 0.45 * sw * dry
    estimated = blh is None or blh <= 0
    if estimated:
        # no model boundary layer depth: use the lifting condensation level as a stand-in on sunny hours
        zi = max(300.0, min(4000.0, 125.0 * (100.0 - rh) / 5.0)) if sw > 150 else 200.0
    else:
        zi = blh
    wstar = max(0.0, 9.81 / (t2 + 273.15) * (heat / 1200.0) * zi) ** (1 / 3) if heat > 0 else 0.0
    f_heat = _ramp(wstar, 1.6, 4.0)
    w = wind_kmh / 3.6
    f_wind = 0.55 + 0.45 * _ramp(w, 0.5, 2.0) if w < 7 else 1 - _ramp(w, 7.0, 13.0)
    f_rh = 1 - 0.65 * _ramp(rh, 30.0, 65.0)
    dts = None if ts is None else ts - t2
    f_sa = 0.85 if dts is None else 0.7 + 0.3 * _ramp(dts, 3.0, 15.0)
    f_rain = 0.0 if rain is not None and rain >= 0.2 else 1.0
    ddp = 10.0 * f_heat * f_wind * f_rh * f_sa * f_rain
    # blh is only reported when the model supplied it (an estimate would look like model data on the map)
    return {"ddp": round(ddp, 1), "wstar": round(wstar, 2), "blh": None if estimated else round(zi), "dts": None if dts is None else round(dts, 1),
            "heat": round(heat)}


# ---------------------------------------------------------------- point environment (for sightings and the home indicator)
ENV_HOURLY = [
    "temperature_2m", "dew_point_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "precipitation", "cloud_cover", "cape", "convective_inhibition", "lifted_index", "boundary_layer_height",
    "shortwave_radiation", "soil_temperature_0cm", "soil_moisture_0_to_1cm",
    "wind_speed_925hPa", "wind_direction_925hPa", "wind_speed_850hPa", "wind_direction_850hPa",
    "wind_speed_700hPa", "wind_direction_700hPa", "wind_speed_500hPa", "wind_direction_500hPa",
    "temperature_850hPa", "temperature_700hPa", "temperature_500hPa",
    "geopotential_height_850hPa", "geopotential_height_700hPa", "geopotential_height_500hPa",
]
SVR_MAP = {"t2": "temperature_2m", "td2": "dew_point_2m", "cape": "cape", "cin": "convective_inhibition",
           "ws0": "wind_speed_10m", "wd0": "wind_direction_10m", "ws925": "wind_speed_925hPa", "wd925": "wind_direction_925hPa",
           "ws850": "wind_speed_850hPa", "wd850": "wind_direction_850hPa", "ws700": "wind_speed_700hPa", "wd700": "wind_direction_700hPa",
           "ws500": "wind_speed_500hPa", "wd500": "wind_direction_500hPa"}


def env_params(lat, lon, tz, past_days=0):
    p = {"latitude": lat, "longitude": lon, "hourly": ",".join(ENV_HOURLY), "wind_speed_unit": "kmh",
         "timeformat": "unixtime", "timezone": tz, "forecast_days": 3}
    if past_days:
        p["past_days"] = int(max(1, min(92, past_days)))
    return p


def env_series(d, svr_point, southern):
    """Open-Meteo point response -> one dict per hour with the surface, dust devil and storm ingredients."""
    H = d.get("hourly", {})
    out = []
    for i, t in enumerate(H.get("time", [])):
        def g(name, i=i):
            a = H.get(name)
            return a[i] if a and i < len(a) else None
        row = {"t": t, "temp": g("temperature_2m"), "dew": g("dew_point_2m"), "rh": g("relative_humidity_2m"),
               "wind": g("wind_speed_10m"), "wdir": g("wind_direction_10m"), "gust": g("wind_gusts_10m"),
               "rain": g("precipitation"), "cloud": g("cloud_cover"), "li": g("lifted_index"), "sw": g("shortwave_radiation")}
        dd = index(row["temp"], row["rh"], row["wind"], g("boundary_layer_height"), row["sw"],
                   g("soil_temperature_0cm"), g("soil_moisture_0_to_1cm"), row["rain"])
        if dd:
            row.update(ddp=dd["ddp"], wstar=dd["wstar"], blh=dd["blh"], dts=dd["dts"])
        s = svr_point(lambda k: g(SVR_MAP[k]), southern)
        if s:
            row.update({k: s[k] for k in ("stp", "scp", "shear6", "srh1", "srh3", "lcl", "cin", "cape")})
        else:
            row["cape"] = g("cape")
        for lo, name in ((700, "lr75"), (850, "lr85")):          # lapse rates to 500 hPa, C per km
            ta, tb, za, zb = g(f"temperature_{lo}hPa"), g("temperature_500hPa"), g(f"geopotential_height_{lo}hPa"), g("geopotential_height_500hPa")
            if None not in (ta, tb, za, zb) and zb - za > 500:
                row[name] = round((ta - tb) / ((zb - za) / 1000.0), 1)
        out.append(row)
    return out


def env_at(series, ts, max_gap=5400):
    """The hour of `series` nearest unix time `ts` (None when the nearest is more than `max_gap` seconds away)."""
    best = min(series, key=lambda r: abs(r["t"] - ts), default=None)
    return dict(best) if best and abs(best["t"] - ts) <= max_gap else None
