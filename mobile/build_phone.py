"""Copy the wxdeck web page into the phone app for phone mode (run before `npx cap sync android`).

www/static/   the same page files the server serves (app/static), minus the APK download
www/app.html  the page, with the phone-mode server (phone-server.js) loaded first and the phone engine last
www/data/     reference data the page normally gets from the server (radars, towns, borders, highways)
"""
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT.parent / "app" / "static"
WWW = ROOT / "www"

dst = WWW / "static"
if dst.exists():
    shutil.rmtree(dst)
shutil.copytree(SRC, dst, ignore=shutil.ignore_patterns("downloads", "sw.js", "phone-*.js"))
for f in ("phone-server.js", "phone-engine.js", "phone-ui.js"):
    shutil.copy2(SRC / f, dst / f)

html = (SRC / "index.html").read_text(encoding="utf-8")
html = re.sub(r'<script>if \("serviceWorker".*?</script>\n?', "", html)            # no service worker inside the app
html = html.replace('<link rel="manifest" href="/static/manifest.json">', "")
html = html.replace("<head>", '<head>\n<script src="/static/phone-server.js"></script>', 1)
# the engine and the phone tweaks go after the page's last script
last = list(re.finditer(r'<script src="/static/[\w.-]+\.js(\?v=\w+)?"></script>', html))[-1]
html = html[:last.end()] + '\n<script src="/static/phone-engine.js"></script>\n<script src="/static/phone-ui.js"></script>' + html[last.end():]
(WWW / "app.html").write_text(html, encoding="utf-8")
print("phone build ready:", sum(1 for _ in dst.iterdir()), "files in www/static")
