"""Spoken alerts generated on the server with Piper (a small neural text-to-speech engine), so every
device hears the same clear voice: phones, Android's web view and Linux browsers often have no working
speech voices of their own. The voice model (~60 MB) is downloaded once into the data volume."""
import hashlib
import logging
import os
import re
import threading
import wave
from pathlib import Path

import httpx

log = logging.getLogger("radarhound.speech")
VOICE = os.getenv("ALERT_VOICE", "en_GB-alan-medium")
_voice = None
_lock = threading.Lock()


def _voice_url(name, ext):
    lang, who, quality = name.split("-")
    return f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{lang[:2]}/{lang}/{who}/{quality}/{name}{ext}"


async def ensure_voice(data_dir: Path):
    d = data_dir / "voices"
    model = d / f"{VOICE}.onnx"
    if model.exists() and (d / f"{VOICE}.onnx.json").exists():
        return model
    d.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as c:
        for ext in (".onnx.json", ".onnx"):
            r = await c.get(_voice_url(VOICE, ext))
            r.raise_for_status()
            tmp = d / f"{VOICE}{ext}.part"
            tmp.write_bytes(r.content)
            tmp.replace(d / f"{VOICE}{ext}")
    log.info("downloaded alert voice %s", VOICE)
    return model


def _load(model: Path):
    global _voice
    if _voice is None:
        from piper import PiperVoice
        _voice = PiperVoice.load(str(model))
    return _voice


def clean(text: str) -> str:
    text = re.sub(r"[^\w\s,.:;'()\-/&%°]", " ", text)[:400]
    return re.sub(r"\s+", " ", text).strip()


def synthesize(data_dir: Path, text: str) -> Path:
    """WAV for `text`, cached by content."""
    text = clean(text)
    out_dir = data_dir / "speech"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (hashlib.sha1(f"{VOICE}|{text}".encode()).hexdigest()[:16] + ".wav")
    if out.exists():
        return out
    model = data_dir / "voices" / f"{VOICE}.onnx"
    if not model.exists():
        raise FileNotFoundError("voice not downloaded yet")
    with _lock:
        v = _load(model)
        tmp = out.with_suffix(".part")
        with wave.open(str(tmp), "wb") as w:
            if hasattr(v, "synthesize_wav"):
                v.synthesize_wav(text, w)
            else:
                v.synthesize(text, w)
        tmp.replace(out)
    files = sorted(out_dir.glob("*.wav"), key=lambda f: f.stat().st_mtime)
    for f in files[:-300]:
        f.unlink(missing_ok=True)
    return out
