"""Verification log: every wxdeck warning, what the storm did while it was in force, and whether BoM
warned for the same area. Used to tune the warning thresholds against real Australian storms.

A warning is one storm event (the same event id across radar handovers). For each it records the peak
core, rotation and lightning, the towns covered, storm reports inside the polygon, and any BoM severe
thunderstorm warning naming one of those towns. BoM thunderstorm warnings are logged too, so the page
can list storms BoM warned for that wxdeck missed.
"""
import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

_lock = threading.Lock()


def _db(data_dir: Path):
    c = sqlite3.connect(data_dir / "verify.sqlite", timeout=30)
    c.execute("""CREATE TABLE IF NOT EXISTS warnings (event TEXT PRIMARY KEY, type TEXT, source TEXT, issued TEXT,
                 last TEXT, lat REAL, lon REAL, polygon TEXT, towns TEXT, dbz REAL, dv REAL, ltg INTEGER,
                 threat TEXT, bom TEXT, reports TEXT, upgraded TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS bom (id TEXT PRIMARY KEY, title TEXT, first TEXT, last TEXT, areas TEXT)""")
    return c


def _in_poly(lat, lon, poly):
    inside = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i - 1]
        if (a[0] > lat) != (b[0] > lat) and lon < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0] + 1e-12) + a[1]:
            inside = not inside
    return inside


def record(data_dir: Path, active: list, bom: list, reports: list):
    """Called after every warning-engine cycle. `active` = wxdeck warnings, `bom` = [{id, title, text}]
    BoM thunderstorm/severe weather warnings currently out, `reports` = storm reports."""
    now = datetime.now(timezone.utc).isoformat()
    with _lock, _db(data_dir) as c:
        for b in bom:
            row = c.execute("SELECT first FROM bom WHERE id = ?", (b["id"],)).fetchone()
            c.execute("INSERT OR REPLACE INTO bom VALUES (?,?,?,?,?)",
                      (b["id"], b["title"], row[0] if row else now, now, b["text"][:4000]))
        bom_low = [(b["title"], b["text"].lower()) for b in bom]
        for w in active:
            ev = w.get("event") or w["id"]
            row = c.execute("SELECT dbz, dv, ltg, towns, bom, reports, type, polygon FROM warnings WHERE event = ?", (ev,)).fetchone()
            towns = sorted(set(json.loads(row[3]) if row else []) | set(w.get("towns") or []))
            poly = w["polygon"]
            bm = set(json.loads(row[4]) if row and row[4] else [])
            for title, low in bom_low:
                if any(t.lower() in low for t in towns if len(t) > 3):
                    bm.add(title)
            rp = {json.dumps(r, sort_keys=True) for r in (json.loads(row[5]) if row and row[5] else [])}
            issued = datetime.fromisoformat(w["issued"])
            for r in reports:
                try:
                    rt = datetime.fromisoformat(str(r.get("t")).replace("Z", "+00:00"))
                except ValueError:
                    continue
                if issued - timedelta(minutes=15) <= rt <= datetime.now(timezone.utc) + timedelta(minutes=5) and _in_poly(r["lat"], r["lon"], poly):
                    rp.add(json.dumps({"kind": r.get("kind"), "size": r.get("size"), "t": r.get("t")}, sort_keys=True))
            upgraded = "TOR" if (row and row[6] != "TOR" and w["type"] == "TOR") else None
            c.execute("""INSERT OR REPLACE INTO warnings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                ev, "TOR" if (row and row[6] == "TOR") else w["type"], w.get("source"), w["issued"], now, w["lat"], w["lon"],
                json.dumps(poly), json.dumps(towns), max(w.get("dbz") or 0, row[0] if row else 0),
                max(w.get("dv") or 0, row[1] if row else 0), max(w.get("lightning") or 0, row[2] if row else 0),
                json.dumps(w.get("threat") or {}), json.dumps(sorted(bm)), json.dumps(sorted(json.loads(x) for x in rp) if rp else []),
                upgraded))


def summary(data_dir: Path, days: int = 30):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with _lock, _db(data_dir) as c:
        rows = c.execute("SELECT event, type, source, issued, last, lat, lon, towns, dbz, dv, ltg, threat, bom, reports "
                         "FROM warnings WHERE issued >= ? ORDER BY issued DESC", (since,)).fetchall()
        boms = c.execute("SELECT id, title, first, last, areas FROM bom WHERE first >= ? ORDER BY first DESC", (since,)).fetchall()
    out = []
    matched_bom = set()
    for r in rows:
        bm = json.loads(r[12] or "[]")
        matched_bom |= set(bm)
        issued, last = datetime.fromisoformat(r[3]), datetime.fromisoformat(r[4])
        out.append({"event": r[0], "type": r[1], "source": r[2], "issued": r[3], "minutes": round((last - issued).total_seconds() / 60),
                    "lat": r[5], "lon": r[6], "towns": json.loads(r[7] or "[]")[:8], "dbz": r[8], "dv": r[9], "lightning": r[10],
                    "threat": json.loads(r[11] or "{}"), "bom": bm, "reports": json.loads(r[13] or "[]")})
    thunder = [b for b in boms if "thunderstorm" in b[1].lower()]
    missed = [{"title": b[1], "first": b[2]} for b in thunder if b[1] not in matched_bom]
    n = len(out)
    stats = {
        "warnings": n,
        "by_type": {t: sum(1 for w in out if w["type"] == t) for t in ("TOR", "SVR", "FFW")},
        "with_bom": sum(1 for w in out if w["bom"]),
        "with_reports": sum(1 for w in out if w["reports"]),
        "bom_thunderstorm_warnings": len(thunder),
        "bom_without_wxdeck": len(missed),
        "median_minutes": sorted(w["minutes"] for w in out)[n // 2] if n else None,
    }
    return {"days": days, "stats": stats, "warnings": out[:300], "bom_missed": missed[:100]}
