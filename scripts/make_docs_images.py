"""Regenerate the engine-drawn pictures used in README.md  (docs/img/*.jpg).

    python scripts/make_docs_images.py

Only numpy + Pillow are needed. The screenshots of the web pages and the PDF
reports in docs/img/ are captured separately from the built site (they are not
produced by this script).
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from precision_qc.analyzer import QCConfig, analyze  # noqa: E402
from precision_qc.batch import analyze_plates, overview_image  # noqa: E402
from precision_qc.caps import STEP_KEYS, count_caps, step_images  # noqa: E402
from precision_qc.render import report_image  # noqa: E402

OUT = ROOT / "docs" / "img"
CAPS_PHOTO = ROOT / "samples" / "ช่อดอก" / "AElY1DQU.jpg"
BATCH_PHOTO = ROOT / "samples" / "แบบชุด" / "0dRKZpPx.jpg"
TITLES = {
    "photo": "original (cropped)", "bunch": "find the bunch", "gray": "B&W + invert", "channels": "R · G · B · min",
    "contrast": "contrast mask", "distance": "distance transform", "first": "first pass", "views": "second look (RGB views)",
    "shadow": "shadows lifted: hidden caps", "final": "final result", "area": "area share",
}


def font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except Exception:
        return ImageFont.load_default()


def save(im: Image.Image, name: str, width: int = 0, quality: int = 86) -> None:
    im = im.convert("RGB")
    if width and im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(OUT / name, quality=quality, optimize=True)
    print(f"  {name}  {im.size[0]}x{im.size[1]}  {(OUT / name).stat().st_size // 1024} KB")


def labelled(im: Image.Image, text: str, n: int) -> Image.Image:
    im = im.copy()
    d = ImageDraw.Draw(im)
    d.ellipse([im.width - 38, 8, im.width - 8, 38], fill=(79, 70, 229))
    d.text((im.width - 23, 23), str(n), fill="white", font=font(18), anchor="mm")
    bar = font(15)
    w = d.textlength(text, font=bar)
    d.rectangle([0, im.height - 26, w + 16, im.height], fill=(0, 0, 0))
    d.text((8, im.height - 20), text, fill="white", font=bar)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # --- cap counter -------------------------------------------------------
    res = count_caps(CAPS_PHOTO, name=CAPS_PHOTO.name)
    steps = dict(step_images(res, width=900))
    trio = [steps["photo"], steps["final"], steps["area"]]
    w, h = trio[0].size
    sheet = Image.new("RGB", (w * 3 + 24, h), (24, 24, 30))
    for i, im in enumerate(trio):
        sheet.paste(im, (i * (w + 12), 0))
    save(sheet, "caps-hero.jpg", 1500)

    small = dict(step_images(res, width=420))
    cols = 4
    w, h = small["photo"].size
    rows = -(-len(STEP_KEYS) // cols)
    grid = Image.new("RGB", (cols * w + (cols + 1) * 8, rows * h + (rows + 1) * 8), (24, 24, 30))
    for i, key in enumerate(STEP_KEYS):
        grid.paste(labelled(small[key], TITLES[key], i + 1), (8 + (i % cols) * (w + 8), 8 + (i // cols) * (h + 8)))
    save(grid, "caps-steps.jpg", 1700)
    print(f"  caps: {res.report['total']} caps {res.report['counts']}  area {dict(res.report['area_percent'])}")

    # --- dish QC report + several dishes in one photo ---------------------------
    cfg = QCConfig()
    for name in ("white_colony", "sporulation"):
        save(report_image(analyze(ROOT / "samples" / f"{name}.jpg", cfg, name=f"{name}.jpg")), f"qc-report-{name}.jpg", 1400)
    save(overview_image(analyze_plates(BATCH_PHOTO, cfg, name=BATCH_PHOTO.name)), "multi-overview.jpg", 1000)


if __name__ == "__main__":
    main()
