"""BoM's anonymous FTP feed (ftp.bom.gov.au/anon/gen), the channel BoM offers for automated access.

The website's radar loop pages are meant for people in a browser and BoM blocks addresses that fetch them
too often. The FTP radar folder has the same frames (IDRxxx.T.yyyymmddhhmm.png) for every radar in one
directory, so one listing per poll cycle replaces dozens of page requests. Everything here is
synchronous ftplib behind a lock, called from a worker thread; one connection is kept open and reopened
when BoM drops it.
"""
import asyncio
import ftplib
import io
import logging
import os
import re
import threading
import time

log = logging.getLogger("wxdeck.ftp")

HOST = os.getenv("BOM_FTP_HOST", "ftp.bom.gov.au")
PORT = int(os.getenv("BOM_FTP_PORT", "21"))
RADAR_DIR = "/anon/gen/radar"
TRANSP_DIR = "/anon/gen/radar_transparencies"
FWO_DIR = "/anon/gen/fwo"             # warnings, observations and forecasts (same names as www.bom.gov.au/fwo/)
FRAME_NAME = re.compile(r"^(IDR\w{3,4})\.T\.(\d{12})\.png$")

_lock = threading.Lock()
_ftp: ftplib.FTP | None = None
_listing: dict = {}          # dir -> (fetched_at, [names])
state = {"ok": None, "error": None, "last_list": None, "files": 0, "bytes": 0}


def _connect() -> ftplib.FTP:
    global _ftp
    if _ftp is not None:
        try:
            _ftp.voidcmd("NOOP")
            return _ftp
        except ftplib.all_errors:
            _close()
    f = ftplib.FTP(timeout=30)
    f.connect(HOST, PORT)
    f.login()                         # anonymous
    f.set_pasv(True)
    _ftp = f
    return f


def _close():
    global _ftp
    if _ftp is not None:
        try:
            _ftp.close()
        except Exception:
            pass
    _ftp = None


def _run(fn):
    """Run fn(ftp) once, and once more on a fresh connection if the old one had gone stale."""
    with _lock:
        for attempt in (0, 1):
            try:
                out = fn(_connect())
                state.update(ok=True, error=None)
                return out
            except ftplib.error_perm:
                raise                                   # e.g. 550 no such file: not a connection problem
            except ftplib.all_errors as e:
                _close()
                if attempt:
                    state.update(ok=False, error=str(e) or type(e).__name__)
                    raise
                time.sleep(1)


def list_dir(path: str = RADAR_DIR, ttl: float = 45) -> list:
    hit = _listing.get(path)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    names = _run(lambda f: [n.rsplit("/", 1)[-1] for n in f.nlst(path)])
    _listing[path] = (time.time(), names)
    if path == RADAR_DIR:
        state["last_list"] = time.time()
    return names


def get(path: str) -> bytes:
    def fetch(f):
        buf = io.BytesIO()
        f.retrbinary(f"RETR {path}", buf.write)
        return buf.getvalue()
    b = _run(fetch)
    state["files"] += 1
    state["bytes"] += len(b)
    return b


def frames_for(pid: str, names: list) -> list:
    """Frame file names for one product, oldest first."""
    pre = pid + ".T."
    return sorted(n for n in names if n.startswith(pre) and n.endswith(".png"))


async def alist(path: str = RADAR_DIR, ttl: float = 45) -> list:
    return await asyncio.to_thread(list_dir, path, ttl)


async def aget(path: str) -> bytes:
    return await asyncio.to_thread(get, path)
