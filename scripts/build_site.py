"""Assemble the static web app into _site/ (what GitHub Pages serves).

    python scripts/build_site.py               # build into _site/
    python scripts/build_site.py --serve       # build and open http://localhost:8000
    python scripts/build_site.py --out deploy  # refresh deploy/, the folder to upload to a web host

Two editions are built from one command:
  <out>/        the Pure.css edition         (source: web/)
  <out>/tw/     the Tailwind CSS edition      (source: web-tw/, tw.css compiled here)
Both share the same Python engine, samples and behaviour — only the styling
differs — so you can upload whichever you prefer (or both).

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
# page assets (besides index.html) that get a ?v=<hash> for cache-busting
EDITION_ASSETS = {"web": ("style.css", "i18n.js", "app.js"),
                  "web-tw": ("tw.css", "i18n.js", "app.js")}
# hostnames always allowed so local testing of the deploy/ folder keeps working
LOCAL_HOSTS = ["localhost", "127.0.0.1"]
# pinned so the built output is identical locally and in CI (the drift check in
# .github/workflows/ci.yml rebuilds deploy/ and diffs it)
TERSER = "terser@5.36.0"
TAILWIND = "tailwindcss@3.4.17"


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


def _build_tailwind(src_dir: Path, out_css: Path) -> None:
    """Compile <src_dir>/src.css -> out_css with a pinned Tailwind. Required for
    the Tailwind edition — the build fails if it can't run."""
    try:
        res = subprocess.run(
            ["npx", "--yes", TAILWIND, "-c", "tailwind.config.js",
             "-i", "src.css", "-o", str(out_css.resolve()), "--minify"],
            cwd=src_dir, capture_output=True, text=True, timeout=300,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        raise SystemExit(f"Tailwind build failed ({e}). Node.js / npx is required to build the web-tw edition.")
    if res.returncode != 0:
        raise SystemExit(f"Tailwind build failed:\n{res.stderr.strip()}")


def _assemble(src: str, out: Path, build_id: str, samples, lock_domains) -> None:
    """Copy one web edition into `out` (engine, samples, cache-busting, the
    optional protection layer). `out` must already exist and be empty."""
    src_dir = ROOT / src
    shutil.copytree(src_dir, out, dirs_exist_ok=True)

    # Tailwind edition: compile tw.css here, drop the build-only sources
    if src == "web-tw":
        _build_tailwind(src_dir, out / "tw.css")
        for junk in ("src.css", "tailwind.config.js"):
            (out / junk).unlink(missing_ok=True)

    pkg = out / "py" / "precision_qc"
    pkg.mkdir(parents=True)
    py_files = sorted(p.name for p in (ROOT / "precision_qc").glob("*.py"))
    for name in py_files:
        shutil.copy2(ROOT / "precision_qc" / name, pkg / name)
    (out / "samples").mkdir()
    for name in samples:
        shutil.copy2(ROOT / "samples" / name, out / "samples" / name)

    index = out / "index.html"
    html = index.read_text(encoding="utf-8")

    # --- domain-lock / anti-copy layer -------------------------------------
    # Added only when --lock-domain is given (the deploy/ build for the real
    # host). Plain _site / dev builds are left unprotected so they run anywhere.
    assets = list(EDITION_ASSETS[src])
    minified = 0
    if lock_domains:
        allowed = sorted(set(lock_domains + LOCAL_HOSTS))
        tmpl = (ROOT / "hosting" / "protect.js").read_text(encoding="utf-8")
        (out / "protect.js").write_text(tmpl.replace("__ALLOWED_HOSTS__", json.dumps(allowed)), encoding="utf-8")
        if "<!--protect-->" not in html:
            raise SystemExit(f"{src}/index.html is missing the <!--protect--> placeholder")
        html = html.replace("<!--protect-->", '<script src="protect.js"></script>', 1)
        assets.append("protect.js")
        for name in ("i18n.js", "app.js", "protect.js"):
            if _minify_js(out / name):
                minified += 1
    else:
        html = html.replace("<!--protect-->\n  ", "").replace("<!--protect-->", "")

    # cache-busting: index.html links each asset as file?v=<content hash>,
    # hashed AFTER minify so the URL reflects exactly what is shipped
    for name in assets:
        tag = hashlib.sha256((out / name).read_bytes()).hexdigest()[:12]
        ref = f'"{name}"'
        if ref not in html:
            raise SystemExit(f"{src}/index.html no longer references {name}")
        html = html.replace(ref, f'"{name}?v={tag}"')
    index.write_text(html, encoding="utf-8")

    (out / "manifest.json").write_text(json.dumps({"build": build_id, "py_files": py_files, "samples": samples}, indent=2))
    (out / ".nojekyll").write_text("")
    # server settings for Apache / LiteSpeed hosts (GitHub Pages ignores them)
    shutil.copy2(ROOT / "hosting" / ".htaccess", out / ".htaccess")

    if lock_domains:
        tail = f"domain lock: {', '.join(lock_domains)}; {minified}/3 js minified" if minified \
            else f"domain lock: {', '.join(lock_domains)}; js NOT minified (terser unavailable)"
    else:
        tail = "no protection (dev build)"
    print(f"  {out}  ({src} edition; {tail})")


def build(out: Path, lock_domains=None) -> Path:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # one engine build id, shared by both editions
    py_files = sorted((ROOT / "precision_qc").glob("*.py"))
    digest = hashlib.sha256()
    for p in py_files:
        digest.update(p.read_bytes())
    build_id = digest.hexdigest()[:12]
    samples = sorted(p.name for p in (ROOT / "samples").glob("*") if p.suffix.lower() in IMAGE_EXT)

    print(f"Built (engine {build_id}, {len(py_files)} python files, {len(samples)} samples):")
    _assemble("web", out, build_id, samples, lock_domains)          # Pure.css at the root
    _assemble("web-tw", out / "tw", build_id, samples, lock_domains)  # Tailwind at /tw
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
        print(f"Serving on http://localhost:{args.port}  (Tailwind edition at /tw/ · Ctrl+C to stop)")
        http.server.ThreadingHTTPServer(("", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
