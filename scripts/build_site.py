"""Assemble the static web app into _site/ (what GitHub Pages serves).

    python scripts/build_site.py            # build into _site/
    python scripts/build_site.py --serve    # build and open http://localhost:8000
"""

import argparse
import functools
import http.server
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def build(out: Path) -> Path:
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
    (out / "manifest.json").write_text(json.dumps({"py_files": py_files, "samples": samples}, indent=2))
    (out / ".nojekyll").write_text("")
    print(f"Built {out} ({len(py_files)} python files, {len(samples)} samples)")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "_site"))
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    out = build(Path(args.out))
    if args.serve:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(out))
        print(f"Serving on http://localhost:{args.port}  (Ctrl+C to stop)")
        http.server.ThreadingHTTPServer(("", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
