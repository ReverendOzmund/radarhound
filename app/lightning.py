"""Live lightning from the Blitzortung.org community network.

Blitzortung's public map feed is a websocket stream of every detected strike worldwide.
We keep only strikes within LIGHTNING_RADIUS_KM of home or any configured radar and
store them in SQLite so loops (and archive replays) can show them later.
Blitzortung data is for private, non-commercial use.
"""
import asyncio
import json
import logging
import math
import os
import sqlite3
import threading
import time
from pathlib import Path

import websockets

log = logging.getLogger("wxdeck.lightning")

HOSTS = [h.strip() for h in os.getenv("LIGHTNING_HOSTS", "ws1,ws7,ws8").split(",") if h.strip()]
RADIUS_KM = float(os.getenv("LIGHTNING_RADIUS_KM", "800"))
KEEP_DAYS = float(os.getenv("LIGHTNING_RETENTION_DAYS", "30"))
ENABLED = os.getenv("LIGHTNING", "on").lower() not in ("0", "off", "false", "no")

status = {"connected": False, "host": None, "kept": 0, "seen": 0, "last_strike": None, "error": None}


def decode(b: str) -> str:
    """Blitzortung frames are LZW-compressed into a string of code points."""
    e = {}
    d = list(b)
    c = d[0]
    f = c
    out = [c]
    o = 256
    for ch in d[1:]:
        a = ord(ch)
        a = ch if a < 256 else (e[a] if a in e else f + c)
        out.append(a)
        c = a[0]
        e[o] = f + c
        o += 1
        f = a
    return "".join(out)


def dist_km(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


class Store:
    """Two SQLite connections: one the collector writes with (event loop), one the API reads with (thread
    pool). In WAL mode a read never waits for a write, so a big query can't stall the collector (and with
    it the whole web server). Each connection has its own lock, since one connection must not be used from
    two threads at once."""
    def __init__(self, path: Path):
        self.wlock, self.rlock = threading.Lock(), threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS strikes (t INTEGER, lat REAL, lon REAL)")
        self.db.execute("CREATE INDEX IF NOT EXISTS strikes_t ON strikes(t)")
        if self.db.execute("PRAGMA user_version").fetchone()[0] < 1:
            # reconnecting to the feed used to store its replay of recent strokes again: drop the copies once,
            # then let a unique index keep them out
            self.db.execute("UPDATE strikes SET lat = round(lat, 4), lon = round(lon, 4)")
            self.db.execute("DELETE FROM strikes WHERE rowid NOT IN (SELECT MIN(rowid) FROM strikes GROUP BY t, lat, lon)")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS strikes_u ON strikes(t, lat, lon)")
            self.db.execute("PRAGMA user_version = 1")
        self.db.commit()
        self.rdb = sqlite3.connect(path, check_same_thread=False, timeout=30)

    def add(self, rows):
        rows = [(int(t), round(la, 4), round(lo, 4)) for t, la, lo in rows]
        with self.wlock:
            self.db.executemany("INSERT OR IGNORE INTO strikes VALUES (?,?,?)", rows)
            self.db.commit()

    def query(self, t0_ms, t1_ms, lat, lon, radius_km):
        dlat = radius_km / 111.0
        dlon = radius_km / (111.0 * max(0.2, math.cos(math.radians(lat))))
        with self.rlock:
            cur = self.rdb.execute(
                "SELECT t, lat, lon FROM strikes WHERE t BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY t",
                (t0_ms, t1_ms, lat - dlat, lat + dlat, lon - dlon, lon + dlon))
            return cur.fetchall()

    def prune(self):
        cutoff = int((time.time() - KEEP_DAYS * 86400) * 1000)
        with self.wlock:
            self.db.execute("DELETE FROM strikes WHERE t < ?", (cutoff,))
            self.db.commit()


LM_HOSTS = ["live", "live2"]


def _bbox(centres):
    """[north, east, south, west] covering every centre and its radius."""
    n, e, so, w = -90.0, -180.0, 90.0, 180.0
    for c in centres:
        r = c[2] if len(c) > 2 else RADIUS_KM
        dlat = r / 111.0
        dlon = r / (111.0 * max(0.2, math.cos(math.radians(c[0]))))
        n, so = max(n, c[0] + dlat), min(so, c[0] - dlat)
        e, w = max(e, c[1] + dlon), min(w, c[1] - dlon)
    return [round(min(89, n), 2), round(min(180, e), 2), round(max(-89, so), 2), round(max(-180, w), 2)]


async def collector(store: Store, centres):
    """Two ways in to the same Blitzortung network. LightningMaps' area feed sends every located stroke
    inside a box (about 30-40 times more strokes over Australia than the global map feed, which only
    sends a sample). If it fails three times in a row, fall back to the global feed for a while."""
    if not ENABLED:
        status["error"] = "disabled"
        return
    fails = 0
    while True:
        if fails < 3:
            ok = await _lightningmaps(store, centres)
            fails = 0 if ok else fails + 1
            if not ok:
                await asyncio.sleep(10)
        else:
            await _blitzortung(store, centres, minutes=15)
            fails = 0


async def _lightningmaps(store, centres):
    host = LM_HOSTS[int(time.time() / 60) % len(LM_HOSTS)]
    seen = set()
    got_any = False
    try:
        async with websockets.connect(f"wss://{host}.lightningmaps.org/", open_timeout=20, ping_interval=30,
                                      additional_headers={"Origin": "https://www.lightningmaps.org"}) as ws:
            box = _bbox(centres())
            await ws.send(json.dumps({"v": 24, "i": {}, "s": False, "x": 0, "w": 0, "tx": 0, "tw": 1, "a": 4, "z": 4, "b": True,
                                      "h": "", "l": 1, "t": 1, "from_lightningmaps_org": True, "p": box}))
            status.update(connected=True, host=f"{host}.lightningmaps.org", error=None, feed="area")
            last_box = time.time()
            last_prune = 0
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=180)
                got_any = True
                try:
                    j = json.loads(msg)
                except Exception:
                    continue
                buf = []
                for st in j.get("strokes") or []:
                    lat, lon, t = st.get("lat"), st.get("lon"), st.get("time")
                    if lat is None or lon is None or t is None:
                        continue
                    key = (int(t), round(lat, 3), round(lon, 3))      # the first message repeats recent strokes
                    if key in seen:
                        continue
                    seen.add(key)
                    status["seen"] += 1
                    if any(dist_km(lat, lon, c[0], c[1]) <= (c[2] if len(c) > 2 else RADIUS_KM) for c in centres()):
                        buf.append((int(t), lat, lon))
                        status["kept"] += 1
                        status["last_strike"] = int(t)
                if len(seen) > 50000:
                    seen.clear()
                if buf:
                    store.add(buf)
                if time.time() - last_prune > 3600:
                    store.prune()
                    last_prune = time.time()
                # follow changes in the area (home moved, radars followed) every 10 minutes
                if time.time() - last_box > 600:
                    nb = _bbox(centres())
                    if nb != box:
                        box = nb
                        await ws.send(json.dumps({"v": 24, "i": {}, "s": False, "x": 0, "w": 0, "tx": 0, "tw": 1, "a": 4, "z": 4, "b": True,
                                                  "h": "", "l": 1, "t": 1, "from_lightningmaps_org": True, "p": box}))
                    last_box = time.time()
    except asyncio.CancelledError:
        raise
    except Exception as e:
        status.update(connected=False, error=f"{host}.lightningmaps.org: {e}")
        log.warning("lightning area feed dropped: %s", e)
    return got_any


async def _blitzortung(store, centres, minutes):
    """Blitzortung's global map feed (a sample of strokes worldwide), used as a fallback."""
    until = time.time() + minutes * 60
    i = 0
    while time.time() < until:
        host = HOSTS[i % len(HOSTS)]
        i += 1
        try:
            async with websockets.connect(
                f"wss://{host}.blitzortung.org/", open_timeout=20, ping_interval=30,
                additional_headers={"Origin": "https://map.blitzortung.org"},
            ) as ws:
                await ws.send('{"a":111}')
                status.update(connected=True, host=host, error=None, feed="global sample (fallback)")
                buf = []
                last_flush = time.time()
                while time.time() < until:
                    msg = await asyncio.wait_for(ws.recv(), timeout=120)
                    try:
                        j = json.loads(decode(msg))
                    except Exception:
                        continue
                    status["seen"] += 1
                    lat, lon = j.get("lat"), j.get("lon")
                    if lat is None or lon is None:
                        continue
                    if any(dist_km(lat, lon, c[0], c[1]) <= (c[2] if len(c) > 2 else RADIUS_KM) for c in centres()):
                        t_ms = int(j["time"] // 1_000_000)
                        buf.append((t_ms, lat, lon))
                        status["kept"] += 1
                        status["last_strike"] = t_ms
                    if buf and time.time() - last_flush > 5:
                        store.add(buf)
                        buf, last_flush = [], time.time()
                if buf:
                    store.add(buf)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            status.update(connected=False, error=f"{host}: {e}")
            log.warning("lightning feed %s dropped: %s", host, e)
            await asyncio.sleep(10)
