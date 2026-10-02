"""Assemble the static web app into _site/ (what GitHub Pages serves).

    python scripts/build_site.py               # build into _site/
    python scripts/build_site.py --serve       # build and open http://localhost:8000
    python scripts/build_site.py --out deploy  # refresh deploy/, the folder to upload to a web host

Protecting the hosted copy
--------------------------
The build adds a deterrent layer to the output (hosting/protect.js): it locks
the app to the domains given by --lock-domain and discourages casual
right-click / view-source / DevTools use. It also minifies the page's JS when
`terser` is available, so the shipped code is harder to read and reuse.

    python scripts/build_site.py --out deploy \
        --lock-domain kittiphun.rut.mcupr.ac.th

These are deterrents, not real security — anything sent to the browser can be
read by a determined person. The only strong protection is keeping the source
repository private.
"""

import argparse
import functools
import hashlib
import http.server
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
WEB_ASSETS = ("style.css", "i18n.js", "app.js")
# hostnames always allowed so local testing of the deploy/ folder keeps working
LOCAL_HOSTS = ["localhost", "127.0.0.1"]
# pinned so the minified output is identical locally and in CI (the drift check
# in .github/workflows/ci.yml rebuilds deploy/ and diffs it)
TERSER = "terser@5.36.0"


def _minify_js(path: Path) -> bool:
    """Minify a .js file in place with a pinned terser. Returns True on success,
    False if terser can't run (the file is left readable)."""
    try:
        out = subprocess.run(
            ["npx", "--yes", TERSER, str(path), "--compress", "--mangle"],
            capture_output=True, text=True, timeout=180,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if out.returncode != 0 or not out.stdout.strip():
        return False
    path.write_text(out.stdout, encoding="utf-8")
    return True


def build(out: Path, lock_domains=None) -> Path:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out)
    pkg = out / "py" / "precision_qc"
    pkg.mkdir(parents=True)
    py_files = sorted(p.name for p in (ROOT / "precision_qc").glob("*.py"))
    for name in py_files:
        shutil.copy2(ROOT / "precision_qc" / name, pkg / name)
    samples = sorted(p.name for p in (ROOT / "samples").glob("*") if p.suffix.lower() in IMAGE_EXT)
    (out / "samples").mkdir()
    for name in samples:
        shutil.copy2(ROOT / "samples" / name, out / "samples" / name)

    index = out / "index.html"
    html = index.read_text(encoding="utf-8")

    # --- domain-lock / anti-copy layer -------------------------------------
    # Added only when --lock-domain is given (i.e. the deploy/ build for the real
    # host). The plain _site / dev build is left untouched so it runs anywhere.
    assets = list(WEB_ASSETS)
    minified = 0
    if lock_domains:
        allowed = sorted(set(lock_domains + LOCAL_HOSTS))
        tmpl = (ROOT / "hosting" / "protect.js").read_text(encoding="utf-8")
        protect = tmpl.replace("__ALLOWED_HOSTS__", json.dumps(allowed))
        (out / "protect.js").write_text(protect, encoding="utf-8")
        # load it first, before anything else in <head>
        marker = '<link rel="stylesheet" href="style.css" />'
        if marker not in html:
            raise SystemExit("index.html no longer has the style.css link to anchor protect.js")
        html = html.replace(marker, '<script src="protect.js"></script>\n  ' + marker, 1)
        assets.append("protect.js")
        # minify the page's JS so the shipped code is harder to read
        for name in ("i18n.js", "app.js", "protect.js"):
            if _minify_js(out / name):
                minified += 1

    # content hash of the engine: the web app appends it to every .py URL so a
    # new deploy is never served from a stale browser / CDN cache
    digest = hashlib.sha256()
    for name in py_files:
        digest.update((ROOT / "precision_qc" / name).read_bytes())
    build = digest.hexdigest()[:12]
    # same for the page's own CSS / JS: index.html links them as file?v=<hash>,
    # hashed AFTER minify so the URL reflects exactly what is shipped
    for name in assets:
        tag = hashlib.sha256((out / name).read_bytes()).hexdigest()[:12]
        ref = f'"{name}"'
        if ref not in html:
            raise SystemExit(f"index.html no longer references {name}")
        html = html.replace(ref, f'"{name}?v={tag}"')
    index.write_text(html, encoding="utf-8")

    manifest = {"build": build, "py_files": py_files, "samples": samples}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / ".nojekyll").write_text("")
    # server settings for Apache / LiteSpeed hosts (GitHub Pages ignores them)
    shutil.copy2(ROOT / "hosting" / ".htaccess", out / ".htaccess")

    if lock_domains:
        mintxt = f"{minified}/3 js minified" if minified else "js NOT minified (terser unavailable)"
        prot = f"domain lock: {', '.join(lock_domains)}; {mintxt}"
    else:
        prot = "no protection (dev build)"
    print(f"Built {out} (build {build}, {len(py_files)} python files, {len(samples)} samples; {prot})")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "_site"))
    ap.add_argument("--lock-domain", action="append", default=[],
                    help="hostname the hosted app may run on (repeatable); "
                         "localhost is always allowed")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    out = build(Path(args.out), lock_domains=args.lock_domain)
    if args.serve:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(out))
        print(f"Serving on http://localhost:{args.port}  (Ctrl+C to stop)")
        http.server.ThreadingHTTPServer(("", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
