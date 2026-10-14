"""BoM warnings from the anonymous FTP feed.

The website's warnings RSS isn't on FTP, but every warning is: each product is an XML file in
/anon/gen/fwo (IDW21033.xml and so on) whose <amoc><product-type> is "W". A detailed folder listing every
few minutes shows which files changed; only those are downloaded and parsed, and what's been parsed is
kept on disk so a restart doesn't fetch the lot again. The result has the same shape as the RSS items
(title, link, pub, level) so the rest of wxdeck doesn't care where warnings came from.
"""
import asyncio
import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from . import bomftp

log = logging.getLogger("wxdeck.warn")

STATE_LETTER = {"wa": "W", "nsw": "N", "vic": "V", "qld": "Q", "sa": "S", "tas": "T", "nt": "D", "act": "N"}
NAME = re.compile(r"^(ID[A-Z]\d{5})\.xml$")
ENDED = {"CAN", "FIN", "EXP"}

state = {"loaded": False, "last": None, "error": None, "products": {}}   # id -> parsed warning or None
_versions: dict = {}             # file name -> listing fingerprint (size + date) of the copy parsed


def _cache_file(data_dir: Path) -> Path:
    return data_dir / "bom_warnings.json"


def load(data_dir: Path):
    f = _cache_file(data_dir)
    if not f.exists():
        return
    try:
        d = json.loads(f.read_text())
        _versions.update(d.get("versions", {}))
        state["products"].update(d.get("products", {}))
        state["loaded"] = bool(_versions)
    except ValueError:
        pass


def save(data_dir: Path):
    f = _cache_file(data_dir)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps({"versions": _versions, "products": state["products"]}))
    tmp.replace(f)


def parse(xml: bytes):
    """A BoM AMOC product -> warning dict, or None when it isn't a warning."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    amoc = root.find("amoc")
    if amoc is None or (amoc.findtext("product-type") or "").strip() != "W":
        return None
    pid = (amoc.findtext("identifier") or "").strip()
    texts = {}
    for t in root.iter("text"):
        typ = t.get("type")
        if typ and typ not in texts:
            texts[typ] = " ".join("".join(t.itertext()).split())
    title = texts.get("warning_title") or texts.get("headline") or texts.get("warning_headline") or (amoc.findtext("service") or "")
    areas = []
    for a in root.iter("area"):
        if a.get("type") == "region" or a.get("phase") == "CAN":
            continue
        d = a.get("description")
        if d and d not in areas:
            areas.append(d)
    expiry = (amoc.findtext("expiry-time") or "").strip() or None
    return {"id": pid, "title": title, "phase": (amoc.findtext("phase") or "").strip(),
            "issued": (amoc.findtext("issue-time-utc") or "").strip() or None, "expiry": expiry,
            "areas": areas[:40], "service": (amoc.findtext("service") or "").strip()}


def _listing():
    """Detailed listing of the fwo folder: name -> fingerprint (size and date as BoM's server prints them)."""
    lines = []
    bomftp._run(lambda f: f.retrlines(f"LIST {bomftp.FWO_DIR}", lines.append))
    out = {}
    for ln in lines:
        parts = ln.split(None, 8)
        if len(parts) == 9 and NAME.match(parts[8]):
            out[parts[8]] = " ".join(parts[4:8])
    return out


def refresh(data_dir: Path, letters: set):
    files = _listing()
    changed = [n for n, fp in files.items() if n[2] in letters and _versions.get(n) != fp]
    for n in changed:
        try:
            w = parse(bomftp.get(f"{bomftp.FWO_DIR}/{n}"))
        except Exception as e:
            log.debug("warning file %s failed: %s", n, e)
            continue
        _versions[n] = files[n]
        state["products"][n[:-4]] = w
    for n in [n for n in _versions if n not in files]:           # products BoM has removed
        del _versions[n]
        state["products"].pop(n[:-4], None)
    state.update(loaded=True, last=time.time(), error=None)
    if changed:
        save(data_dir)
    return len(changed)


async def run(data_dir: Path, feeds_fn, every_s: int = 240):
    """Keep the warning cache fresh. feeds_fn() gives the warnings feeds in use (e.g. IDZ00060.warnings_wa)."""
    await asyncio.to_thread(load, data_dir)
    while True:
        try:
            letters = {STATE_LETTER.get(f.rsplit("_", 1)[-1], "") for f in feeds_fn()} - {""}
            n = await asyncio.to_thread(refresh, data_dir, letters)
            if n:
                log.info("BoM warnings: %d products updated from FTP", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            state["error"] = str(e)
            log.warning("BoM warnings from FTP failed: %s", e)
        await asyncio.sleep(every_s)


def items(feed: str):
    """Current warnings for one state feed name, shaped like the website's RSS items."""
    letter = STATE_LETTER.get(feed.rsplit("_", 1)[-1])
    now = datetime.now(timezone.utc)
    out = []
    for pid, w in state["products"].items():
        if not w or pid[2] != letter or w.get("phase") in ENDED:
            continue
        if w.get("expiry"):
            try:
                if datetime.fromisoformat(w["expiry"].replace("Z", "+00:00")) < now:
                    continue
            except ValueError:
                pass
        title = w["title"] or pid
        low = title.lower()
        level = "severe" if any(k in low for k in ("thunderstorm", "severe weather", "cyclone", "tsunami", "emergency")) \
            else "flood" if "flood" in low else "other"
        out.append({"title": title, "link": f"https://www.bom.gov.au/products/{pid}.shtml", "pub": w.get("issued"),
                    "level": level, "areas": w.get("areas", [])})
    out.sort(key=lambda x: x["pub"] or "", reverse=True)
    return out
