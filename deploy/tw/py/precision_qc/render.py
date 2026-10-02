"""Visual panels for the QC report (numpy + Pillow only)."""

from __future__ import annotations

import base64
import io
import math
from typing import Dict, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .analyzer import Analysis

PANEL_TITLES = {
    "original": "1. Original + Scale",
    "whiteness": "2. Whiteness Analysis",
    "fluffiness": "3. Fluffiness",
    "contamination": "4. Contamination Filter",
    "color_ratio": "5. Color Ratio (Y / R / B)",
    "shape": "6. Circularity",
}

CLASS_COLORS = {
    "clean": (255, 255, 255),
    "agar": (240, 200, 20),
    "contamination": (215, 40, 40),
    "ink": (60, 90, 210),
    "dark": (95, 95, 95),
}


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except Exception:  # Pillow < 10.1 or built without FreeType (e.g. Pyodide)
        return ImageFont.load_default()


def _blend(base: np.ndarray, mask: np.ndarray, color, alpha) -> None:
    """In-place alpha blend of ``color`` over ``base`` where ``mask``."""
    a = alpha if np.isscalar(alpha) else alpha[mask][:, None]
    base[mask] = base[mask] * (1 - a) + np.array(color, dtype=np.float32) * a


def _circle(draw: ImageDraw.ImageDraw, c: Tuple[float, float], r: float, color, width=2) -> None:
    draw.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], outline=color, width=width)


def _dashed(draw, p0, p1, color, dash=7, gap=5, width=2) -> None:
    length = math.dist(p0, p1)
    if length == 0:
        return
    ux, uy = (p1[0] - p0[0]) / length, (p1[1] - p0[1]) / length
    t = 0.0
    while t < length:
        e = min(t + dash, length)
        draw.line([(p0[0] + ux * t, p0[1] + uy * t), (p0[0] + ux * e, p0[1] + uy * e)], fill=color, width=width)
        t += dash + gap


def _polygon(layers) -> list:
    radii = layers["radii"]
    cx, cy = layers["colony_center"]
    ang = np.linspace(0, 2 * math.pi, radii.size, endpoint=False)
    return [(float(cx + r * math.cos(a)), float(cy + r * math.sin(a))) for r, a in zip(radii, ang)]


def panel_original(an: Analysis) -> Image.Image:
    L, rep = an.layers, an.report
    im = Image.fromarray(L["rgb"]).copy()
    d = ImageDraw.Draw(im)
    _circle(d, L["dish_center"], L["r_dish"], (40, 200, 230), 2)
    bbox = rep["colony"]["bbox"]
    if bbox:
        x0, y0, x1, y1 = bbox
        cx, cy = L["colony_center"]
        _dashed(d, (x0, cy), (x1, cy), (220, 30, 30))
        _dashed(d, (cx, y0), (cx, y1), (220, 30, 30))
    # 1 cm scale bar (bottom-right)
    W, H = im.size
    ppc = L["px_per_cm"]
    x1, y = W - 14, H - 18
    x0 = x1 - ppc
    d.line([(x0, y), (x1, y)], fill=(30, 90, 255), width=4)
    d.line([(x0, y - 6), (x0, y + 6)], fill=(30, 90, 255), width=2)
    d.line([(x1, y - 6), (x1, y + 6)], fill=(30, 90, 255), width=2)
    f = _font(14)
    try:
        d.text(((x0 + x1) / 2, y - 8), "1 cm", fill=(30, 90, 255), font=f, anchor="md",
               stroke_width=2, stroke_fill=(255, 255, 255))
    except Exception:  # bitmap fonts on older Pillow do not support anchors
        d.text((x0, y - 20), "1 cm", fill=(30, 90, 255), font=f)
    return im


def panel_whiteness(an: Analysis) -> Image.Image:
    L = an.layers
    base = L["rgb"].astype(np.float32)
    colony = L["colony"] if L["colony"].any() else L["dish"]
    base[~colony] *= 0.45
    wmask = colony & L["white"]
    alpha = np.clip(L["whiteness"] / 100.0, 0, 1) * 0.7
    _blend(base, wmask, (60, 220, 110), alpha)
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


_LUT_STOPS = np.array([[18, 14, 60], [75, 35, 140], [40, 150, 205], [250, 230, 90]], dtype=np.float32)


def _colormap(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0, 1) * (len(_LUT_STOPS) - 1)
    i = np.minimum(t.astype(int), len(_LUT_STOPS) - 2)
    f = (t - i)[..., None]
    return _LUT_STOPS[i] * (1 - f) + _LUT_STOPS[i + 1] * f


def panel_fluffiness(an: Analysis) -> Image.Image:
    L = an.layers
    H, W = L["dish"].shape
    out = np.full((H, W, 3), 232, dtype=np.float32)
    region = L["colony"] if L["colony"].any() else L["dish"]
    out[region] = _colormap(L["texture"][region] / 8.0)
    return Image.fromarray(out.astype(np.uint8))


def panel_contamination(an: Analysis) -> Image.Image:
    L = an.layers
    H, W = L["dish"].shape
    out = np.full((H, W, 3), 200, dtype=np.float32)
    out[L["dish"]] = (228, 228, 228)
    out[L["white"]] = CLASS_COLORS["clean"]
    out[L["yellow"]] = CLASS_COLORS["agar"]
    out[L["dark"]] = CLASS_COLORS["dark"]
    out[L["ink"]] = CLASS_COLORS["ink"]
    out[L["red"] | L["green"]] = CLASS_COLORS["contamination"]
    im = Image.fromarray(out.astype(np.uint8))
    _circle(ImageDraw.Draw(im), L["dish_center"], L["r_in"], (120, 120, 120), 1)
    return im


def panel_color_ratio(an: Analysis) -> Image.Image:
    L = an.layers
    base = L["rgb"].astype(np.float32)
    _blend(base, L["yellow"], (255, 215, 0), 0.85)
    _blend(base, L["red"], (230, 30, 30), 0.85)
    _blend(base, L["ink"], (40, 70, 235), 0.85)
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def panel_shape(an: Analysis) -> Image.Image:
    L, rep = an.layers, an.report
    base = L["rgb"].astype(np.float32)
    _blend(base, L["colony"], (240, 210, 60), 0.45)
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    _circle(d, L["dish_center"], L["r_dish"], (40, 140, 230), 3)
    if rep["colony"]["detected"]:
        area_px = float(L["colony"].sum())
        ys, xs = np.nonzero(L["colony"])
        _circle(d, (xs.mean(), ys.mean()), math.sqrt(area_px / math.pi), (40, 210, 230), 2)
        pts = _polygon(L)
        d.line(pts + [pts[0]], fill=(235, 90, 20), width=2)
    return im


PANEL_FUNCS = {
    "original": panel_original,
    "whiteness": panel_whiteness,
    "fluffiness": panel_fluffiness,
    "contamination": panel_contamination,
    "color_ratio": panel_color_ratio,
    "shape": panel_shape,
}


def render_panels(an: Analysis) -> Dict[str, Image.Image]:
    return {k: fn(an) for k, fn in PANEL_FUNCS.items()}


def to_data_url(im: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    if fmt == "JPEG":
        im.convert("RGB").save(buf, format="JPEG", quality=88)
        mime = "image/jpeg"
    else:
        im.save(buf, format="PNG")
        mime = "image/png"
    return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# --------------------------------------------------------------------------- #
# Full-page report image (used by the CLI / GitHub Actions)
# --------------------------------------------------------------------------- #

PASS_GREEN = (30, 125, 50)
FAIL_RED = (200, 25, 25)


def _panel_caption(key: str, rep: dict) -> str:
    m, c = rep["metrics"], rep["contamination"]
    return {
        "original": f"Colony {rep['colony']['width_cm']}x{rep['colony']['height_cm']} cm  Growth {m['growth']}%",
        "whiteness": f"Whiteness {m['whiteness']}% (raw {m['whiteness_raw']}%)  WhiteRatio {m['white_ratio']}%",
        "fluffiness": f"Fluffy {m['fluffiness']}%  Lap {m['laplacian']}  E {m['edge_density']}%",
        "contamination": f"Agar {c['agar']}%  Contam {c['contamination']}%  Ink {c['ink']}%",
        "color_ratio": f"Y {rep['color_ratio']['yellow']}%  R {rep['color_ratio']['red']}%  B {rep['color_ratio']['blue']}%",
        "shape": f"Circ {m['circularity']}%  IoU {m['iou']}  Sym {m['symmetry']}%",
    }[key]


def report_image(an: Analysis, tile: int = 380) -> Image.Image:
    rep = an.report
    panels = render_panels(an)
    pad, title_h, cap_h = 16, 60, 26
    cols = 4
    cell_w, cell_h = tile, tile + 28 + cap_h
    W = pad + cols * (cell_w + pad)
    H = title_h + 2 * (cell_h + pad) + 60
    page = Image.new("RGB", (W, H), (236, 236, 236))
    d = ImageDraw.Draw(page)
    f_title, f_head, f_txt, f_big = _font(26), _font(18), _font(15), _font(44)
    d.text((W / 2, 30), f"Precision QC  -  {rep['name']}", fill=(30, 30, 30), font=f_title, anchor="mm")

    order = ["original", "whiteness", "fluffiness", "contamination", "color_ratio", "shape"]
    slots = [(0, 0), (0, 1), (0, 2), (0, 3), (1, 0), (1, 1)]
    for key, (row, col) in zip(order, slots):
        x = pad + col * (cell_w + pad)
        y = title_h + row * (cell_h + pad)
        d.text((x + cell_w / 2, y + 12), PANEL_TITLES[key], fill=(30, 30, 30), font=f_head, anchor="mm")
        im = panels[key].copy()
        im.thumbnail((tile, tile))
        box = Image.new("RGB", (tile, tile), (20, 20, 20))
        box.paste(im, ((tile - im.width) // 2, (tile - im.height) // 2))
        page.paste(box, (x, y + 28))
        d.text((x + 4, y + 28 + tile + 5), _panel_caption(key, rep), fill=(40, 40, 40), font=f_txt)

    # 7. calibration table
    x = pad + 2 * (cell_w + pad)
    y = title_h + cell_h + pad
    d.text((x + cell_w / 2, y + 12), "7. Color Calibration", fill=(30, 30, 30), font=f_head, anchor="mm")
    ry = y + 40
    for e in rep["calibration"]:
        d.text((x + 4, ry + 20), e["name"], fill=(30, 30, 30), font=f_txt, anchor="lm")
        d.rectangle([x + 70, ry + 4, x + 110, ry + 36], fill=tuple(e["standard"]))
        if e["sample"]:
            d.rectangle([x + 118, ry + 4, x + 158, ry + 36], fill=tuple(e["sample"]))
            pct = e["match"]
            bar = (40, 170, 90) if pct >= 75 else (230, 130, 40) if pct >= 50 else (215, 60, 50)
            d.rectangle([x + 168, ry + 12, x + 168 + 200, ry + 28], fill=(220, 220, 220))
            d.rectangle([x + 168, ry + 12, x + 168 + 2 * pct, ry + 28], fill=bar)
            d.text((x + 372, ry + 20), f"{pct:.0f}%", fill=(30, 30, 30), font=f_txt, anchor="rm")
        else:
            d.text((x + 168, ry + 20), "Not detected", fill=(140, 140, 140), font=f_txt, anchor="lm")
        ry += 46

    # 8. QC report card
    x = pad + 3 * (cell_w + pad)
    color = PASS_GREEN if rep["passed"] else FAIL_RED
    d.text((x + cell_w / 2, y + 12), "8. QC Report", fill=(30, 30, 30), font=f_head, anchor="mm")
    d.rectangle([x, y + 28, x + cell_w, y + 64], fill=(30, 50, 80))
    d.text((x + cell_w / 2, y + 46), "PRECISION QC", fill=(255, 255, 255), font=f_head, anchor="mm")
    d.text((x + cell_w / 2, y + 100), rep["result"], fill=color, font=f_big, anchor="mm")
    m, w = rep["metrics"], rep["weights"]
    rows = [
        ("Colony", f"{rep['colony']['width_cm']} x {rep['colony']['height_cm']} cm"),
        (f"Growth ({w['growth']*100:.0f}%)", f"{m['growth']}%"),
        (f"Whiteness ({w['whiteness']*100:.0f}%)", f"{m['whiteness']}%"),
        (f"Fluffiness ({w['fluffiness']*100:.0f}%)", f"{m['fluffiness']}%"),
        (f"Shape ({w['shape']*100:.0f}%)", f"{m['shape']}%  IoU {m['iou']}"),
        ("Status", rep["status"]),
    ]
    ry = y + 140
    for k, v in rows:
        d.text((x + 6, ry), k, fill=(30, 30, 30), font=f_txt)
        d.text((x + 190, ry), v, fill=color if k == "Status" else (30, 30, 30), font=f_txt)
        ry += 30
    from . import CREDIT  # default fonts have no Thai glyphs, so English only here

    d.text((pad, H - 30), CREDIT, fill=(110, 110, 110), font=_font(13), anchor="lm")
    d.text(
        (W - pad, H - 30),
        f"Overall Score: {rep['score']} / 100   (Grade {rep['grade']} - {rep['grade_label']})",
        fill=color, font=_font(24), anchor="rm",
    )
    return page
