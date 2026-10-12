"""Core image-analysis engine for Precision QC.

Pipeline (mirrors the 8 report panels):

1. Load + resize, detect the petri dish (gradient Hough transform) -> pixel/cm scale
2. Lighting compensation (white balance + exposure) and pixel classification
   (white mycelium / exposed agar / red-brown & green contamination / ink / dark)
3. Colony segmentation via a radial profile from the colony centre
4. Metrics: growth, whiteness, fluffiness, contamination, colour ratios, shape
5. Weighted QC score -> grade -> PASS / FAIL with reasons

Only numpy + Pillow are used so the module also runs under Pyodide in the browser.
"""

from __future__ import annotations

import io
import math
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image, ImageOps

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@dataclass
class QCConfig:
    """Tunable parameters. Every field can be overridden from the CLI or web UI."""

    plate_cm: float = 8.5  # real diameter of the plate, used for the cm scale
    work_size: int = 480  # longest image side used for analysis (px)
    dark_threshold: Optional[float] = None  # 0-255 brightness; None = automatic
    white_max_chroma: float = 8.0  # max Lab chroma for "white" mycelium

    # PASS / FAIL criteria
    min_score: float = 60.0
    min_growth: float = 30.0  # % of plate area covered by the colony
    max_contamination: float = 3.0  # % of plate with red/brown/green pigment
    max_agar: float = 25.0  # % of plate showing bare (yellow) agar
    min_iou: float = 0.60  # colony vs. ideal circle

    # Score weights (normalised automatically)
    weight_growth: float = 0.35
    weight_whiteness: float = 0.25
    weight_fluffiness: float = 0.25
    weight_shape: float = 0.15

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "QCConfig":
        cfg = cls()
        if not data:
            return cfg
        for f in fields(cls):
            if f.name not in data or data[f.name] in (None, ""):
                continue
            value = data[f.name]
            if f.name == "work_size":
                value = int(value)
            else:
                value = float(value)
            setattr(cfg, f.name, value)
        return cfg

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Analysis:
    """Result of :func:`analyze`: a JSON-ready ``report`` plus image ``layers``."""

    report: Dict[str, Any]
    layers: Dict[str, Any] = field(repr=False, default_factory=dict)


COLOR_STANDARDS = [
    ("White", (245, 245, 245)),
    ("Blue", (65, 90, 160)),
    ("Red", (210, 50, 50)),
    ("Yellow", (235, 205, 20)),
    ("Black", (40, 40, 40)),
]

GRADES = [
    (80.0, "A", "Excellent"),
    (65.0, "B", "Good"),
    (50.0, "C", "Fair"),
    (0.0, "D", "Poor"),
]

# --------------------------------------------------------------------------- #
# Small numpy image helpers
# --------------------------------------------------------------------------- #


def box_blur(a: np.ndarray, k: int) -> np.ndarray:
    """Mean filter with an odd ``k`` x ``k`` window (edge-padded, via cumsums)."""
    a = a.astype(np.float64)
    if k <= 1:
        return a.astype(np.float32)
    p = k // 2
    a = np.pad(a, p, mode="edge")
    c = np.cumsum(a, axis=0)
    c = np.vstack([np.zeros((1, c.shape[1])), c])
    a = (c[k:] - c[:-k]) / k
    c = np.cumsum(a, axis=1)
    c = np.hstack([np.zeros((c.shape[0], 1)), c])
    a = (c[:, k:] - c[:, :-k]) / k
    return a.astype(np.float32)


def sobel(g: np.ndarray):
    p = np.pad(g.astype(np.float32), 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return gx, gy


def laplacian(g: np.ndarray) -> np.ndarray:
    p = np.pad(g.astype(np.float32), 1, mode="edge")
    return p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:] - 4 * p[1:-1, 1:-1]


def rgb_to_hsv(rgb: np.ndarray):
    """rgb float 0-255 -> (h degrees 0-360, s 0-1, v 0-1)."""
    c = rgb.astype(np.float32) / 255.0
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    mx = c.max(axis=-1)
    mn = c.min(axis=-1)
    d = mx - mn
    dd = np.where(d > 1e-6, d, 1.0)
    h = np.where(
        mx == r,
        np.mod((g - b) / dd, 6.0),
        np.where(mx == g, (b - r) / dd + 2.0, (r - g) / dd + 4.0),
    )
    h = np.where(d > 1e-6, h * 60.0, 0.0)
    s = np.where(mx > 1e-6, d / np.where(mx > 1e-6, mx, 1.0), 0.0)
    return h.astype(np.float32), s.astype(np.float32), mx.astype(np.float32)


_M_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float32,
)
_WHITE_D65 = np.array([0.95047, 1.0, 1.08883], dtype=np.float32)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0-255) -> CIE L*a*b* (D65)."""
    c = np.asarray(rgb, dtype=np.float32) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _M_XYZ.T / _WHITE_D65
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1).astype(np.float32)


def circular_median(a: np.ndarray, k: int) -> np.ndarray:
    if k <= 1 or a.size < k:
        return a.copy()
    half = k // 2
    return np.median(np.stack([np.roll(a, s) for s in range(-half, half + 1)]), axis=0)


# --------------------------------------------------------------------------- #
# Pipeline steps
# --------------------------------------------------------------------------- #


def load_image(src: Any, work_size: int = 480) -> np.ndarray:
    """Accepts a path, raw bytes, a PIL image or an ndarray; returns uint8 RGB."""
    if isinstance(src, np.ndarray):
        im = Image.fromarray(np.clip(src, 0, 255).astype(np.uint8))
    elif isinstance(src, Image.Image):
        im = src
    elif isinstance(src, (bytes, bytearray, memoryview)):
        im = Image.open(io.BytesIO(bytes(src)))
    else:
        im = Image.open(src)
    im = ImageOps.exif_transpose(im).convert("RGB")
    w, h = im.size
    scale = work_size / float(max(w, h))
    if abs(scale - 1.0) > 1e-3:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    return np.asarray(im, dtype=np.uint8)


def detect_dish(gray: np.ndarray):
    """Find the petri dish with a gradient-direction Hough transform.

    Returns (cx, cy, radius, confidence) in ``gray`` pixel coordinates.
    """
    H, W = gray.shape
    f = 200.0 / max(H, W)
    sw, sh = max(1, round(W * f)), max(1, round(H * f))
    small = np.asarray(
        Image.fromarray(np.clip(gray, 0, 255).astype(np.uint8)).resize((sw, sh), Image.BILINEAR),
        dtype=np.float32,
    )
    small = box_blur(small, 3)
    h, w = small.shape
    gx, gy = sobel(small)
    mag = np.hypot(gx, gy)

    fallback = (W / 2.0, H / 2.0, 0.46 * min(H, W), 0.0)
    thr = float(np.percentile(mag, 90))
    if thr <= 1e-3:
        return fallback
    ys, xs = np.nonzero(mag > thr)
    m = mag[ys, xs]
    if m.size > 8000:
        keep = np.argpartition(m, -8000)[-8000:]
        ys, xs, m = ys[keep], xs[keep], m[keep]
    ux, uy = gx[ys, xs] / m, gy[ys, xs] / m

    mn = min(h, w)
    radii = np.arange(max(8, int(0.22 * mn)), int(0.62 * mn) + 1, 2)
    best_score = np.zeros(len(radii))
    best_pos = np.zeros(len(radii), dtype=np.intp)
    for i, r in enumerate(radii):
        acc = np.zeros(h * w, dtype=np.float64)
        for sgn in (1.0, -1.0):
            cx = np.rint(xs + sgn * r * ux).astype(np.intp)
            cy = np.rint(ys + sgn * r * uy).astype(np.intp)
            ok = (cx >= 0) & (cx < w) & (cy >= 0) & (cy < h)
            acc += np.bincount(cy[ok] * w + cx[ok], minlength=h * w)
        acc = box_blur(acc.reshape(h, w), 3) * 9.0 / (2.0 * math.pi * r)
        j = int(np.argmax(acc))
        best_pos[i] = j
        best_score[i] = acc.flat[j]

    top = float(best_score.max()) if best_score.size else 0.0
    if top < 0.12:
        return fallback
    # The dish rim is the largest clearly-peaked circle; the colony edge is a
    # smaller (often stronger) one, so do not simply take the global maximum.
    padded = np.concatenate([[0.0], best_score, [0.0]])
    peak = (best_score >= padded[:-2]) & (best_score >= padded[2:])
    cand = np.flatnonzero(peak & (best_score >= max(0.2, 0.35 * top)))
    if cand.size == 0:
        cand = np.array([int(np.argmax(best_score))])
    i = int(cand[np.argmax(radii[cand])])
    cy_s, cx_s = divmod(int(best_pos[i]), w)
    return cx_s / f, cy_s / f, radii[i] / f, round(min(1.0, top), 3)


def compensate_lighting(rgb: np.ndarray, region: np.ndarray):
    """White-balance on the brightest pixels + exposure normalisation.

    Gains are clamped so a genuinely coloured plate (e.g. brown sporulation)
    is *not* neutralised into white.
    """
    px = rgb[region]
    if px.shape[0] < 50:
        return rgb.copy(), [1.0, 1.0, 1.0], 1.0
    lum = px @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    bright = px[lum >= np.percentile(lum, 95)]
    # of the brightest pixels, trust only the most neutral half as "white"
    lab_b = rgb_to_lab(bright)
    chroma_b = np.hypot(lab_b[:, 1], lab_b[:, 2])
    bright = bright[chroma_b <= np.median(chroma_b)]
    ref = bright.mean(axis=0) + 1e-3
    gains = np.clip(ref.mean() / ref, 0.85, 1.15)
    bal = rgb * gains
    lum_b = bal[region] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    p95 = float(np.percentile(lum_b, 95)) + 1e-3
    exposure = float(np.clip(235.0 / p95, 0.8, 1.6))
    bal = np.clip(bal * exposure, 0, 255)
    return bal.astype(np.float32), [round(float(g), 3) for g in gains], round(exposure, 3)


def radial_profile(occ: np.ndarray, cx: float, cy: float, r_max: float, n_ang: int = 240):
    """Colony radius along ``n_ang`` rays from (cx, cy), tolerating small gaps."""
    H, W = occ.shape
    steps = np.arange(0.0, max(r_max, 1.0), 1.0)
    ang = np.linspace(0.0, 2.0 * math.pi, n_ang, endpoint=False)
    xi = np.rint(cx + np.cos(ang)[:, None] * steps).astype(np.intp)
    yi = np.rint(cy + np.sin(ang)[:, None] * steps).astype(np.intp)
    inside = (xi >= 0) & (xi < W) & (yi >= 0) & (yi < H)
    vals = np.zeros(xi.shape, dtype=bool)
    vals[inside] = occ[yi[inside], xi[inside]]

    gap = max(3, int(0.08 * r_max))
    start_gap = max(4, int(0.20 * r_max))
    radii = np.zeros(n_ang, dtype=np.float32)
    for i in range(n_ang):
        idx = np.flatnonzero(vals[i])
        if idx.size == 0 or idx[0] > start_gap:
            continue
        breaks = np.flatnonzero(np.diff(idx) > gap)
        last = idx[breaks[0]] if breaks.size else idx[-1]
        radii[i] = last + 1.0
    return ang, radii


def profile_mask(radii: np.ndarray, cx: float, cy: float, xx, yy) -> np.ndarray:
    n = radii.size
    ang = np.linspace(0.0, 2.0 * math.pi, n, endpoint=False)
    theta = np.mod(np.arctan2(yy - cy, xx - cx), 2.0 * math.pi)
    r_at = np.interp(theta, ang, radii, period=2.0 * math.pi)
    return np.hypot(xx - cx, yy - cy) <= r_at, r_at


def grade_for(score: float):
    for lo, g, label in GRADES:
        if score >= lo:
            return g, label
    return "D", "Poor"


def _pct(n, d) -> float:
    return float(n) / float(d) * 100.0 if d else 0.0


def _r(x: float, nd: int = 1) -> float:
    return round(float(x), nd)


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #


def analyze(src: Any, config: Optional[QCConfig] = None, name: str = "sample", dish_hint=None) -> Analysis:
    """Analyse one dish. ``dish_hint`` = (cx, cy, radius, confidence) as fractions of the
    image (radius relative to the longest side) skips dish detection; used for batch photos."""
    cfg = config or QCConfig()
    rgb8 = load_image(src, cfg.work_size)
    rgb = rgb8.astype(np.float32)
    H, W = rgb.shape[:2]
    gray = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

    # 1) dish + scale --------------------------------------------------------
    if dish_hint is not None:
        dcx, dcy = dish_hint[0] * W, dish_hint[1] * H
        r_dish, dish_conf = dish_hint[2] * max(W, H), dish_hint[3]
    else:
        dcx, dcy, r_dish, dish_conf = detect_dish(gray)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r_in = 0.92 * r_dish  # stay inside the plastic wall
    dish = np.hypot(xx - dcx, yy - dcy) <= r_in
    n_dish = int(dish.sum()) or 1
    px_per_cm = 2.0 * r_dish / cfg.plate_cm

    # 2) lighting compensation + pixel classes -------------------------------
    bal, wb_gains, exposure = compensate_lighting(rgb, dish)
    h, s, v = rgb_to_hsv(bal)
    v255 = v * 255.0
    if cfg.dark_threshold:
        dark_thr = float(cfg.dark_threshold)
    else:
        dark_thr = float(np.clip(0.55 * np.percentile(v255[dish], 95), 70, 165))

    # Colour classes use CIE Lab chroma / hue angle of the compensated image:
    # white mycelium is near-neutral, agar is yellow-beige, sporulation or
    # bacterial contamination is orange/brown/red, moulds are green, ink is blue.
    lab = rgb_to_lab(bal)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    hab = np.mod(np.degrees(np.arctan2(lab[..., 2], lab[..., 1])), 360.0)
    ink = dish & (h >= 170) & (h < 330) & (s > 0.30) & (v > 0.25)
    low = v255 < dark_thr
    # pigmented growth may be darker than the threshold (e.g. dark-green
    # Trichoderma), so require a stronger colour there instead of skipping it
    pigment = dish & ~ink & (v > 0.12) & (chroma > np.where(low, 20.0, 12.0))
    red = pigment & ((hab < 75) | (hab >= 330)) & (chroma > np.where(low, 20.0, 14.0))
    green = pigment & (hab >= 115) & (hab < 200)
    dark = dish & ~ink & low & ~red & ~green
    rest = dish & ~ink & ~dark & ~red & ~green
    yellow = rest & (hab >= 60) & (hab < 115) & (chroma > cfg.white_max_chroma)
    white = rest & (chroma <= cfg.white_max_chroma)

    # 3) colony segmentation -------------------------------------------------
    # a wide-ish window bridges thin dark lines (pen marks, lid reflections)
    k_occ = int(max(5, 0.06 * r_in)) | 1
    occ = box_blur(white.astype(np.float32), k_occ) >= 0.5
    occ = box_blur(occ.astype(np.float32), k_occ) > 0.01  # closing: dilate ...
    occ = (box_blur(occ.astype(np.float32), k_occ) > 0.99) & dish  # ... then erode
    colony = np.zeros((H, W), dtype=bool)
    radii = np.zeros(240, dtype=np.float32)
    r_at = np.zeros((H, W), dtype=np.float32)
    ccx, ccy = dcx, dcy
    if occ.sum() >= 0.005 * n_dish:
        ys_o, xs_o = np.nonzero(occ)
        ccx, ccy = float(xs_o.mean()), float(ys_o.mean())
        for _ in range(2):
            _, raw = radial_profile(occ, ccx, ccy, r_in)
            radii = circular_median(raw, 7)
            colony, r_at = profile_mask(radii, ccx, ccy, xx, yy)
            colony &= dish
            if colony.sum() == 0:
                break
            ys_c, xs_c = np.nonzero(colony)
            ccx, ccy = float(xs_c.mean()), float(ys_c.mean())
        _, raw = radial_profile(occ, ccx, ccy, r_in)
        radii = circular_median(raw, 7)
        colony, r_at = profile_mask(radii, ccx, ccy, xx, yy)
        colony &= dish
    area = int(colony.sum())
    has_colony = area >= 0.003 * n_dish
    if not has_colony:
        colony[:] = False
        radii[:] = 0
        area = 0

    # 4) metrics -------------------------------------------------------------
    growth = _pct(area, n_dish)
    if has_colony:
        ys_c, xs_c = np.nonzero(colony)
        width_px = xs_c.max() - xs_c.min() + 1
        height_px = ys_c.max() - ys_c.min() + 1
        bbox = [int(xs_c.min()), int(ys_c.min()), int(xs_c.max()), int(ys_c.max())]
    else:
        width_px = height_px = 0
        bbox = None

    # whiteness (CIE Lab: bright and colourless = white)
    lab_raw = rgb_to_lab(rgb)

    def whiteness_map(lab_img):
        chroma = np.hypot(lab_img[..., 1], lab_img[..., 2])
        return np.clip((lab_img[..., 0] - 2.0 * chroma) / 90.0 * 100.0, 0, 100)

    w_map = whiteness_map(lab)
    region = colony if has_colony else dish
    whiteness = float(w_map[region].mean())
    whiteness_raw = float(whiteness_map(lab_raw)[region].mean())
    white_ratio = _pct((white & colony).sum(), area) if has_colony else 0.0

    # fluffiness (fine hyphal texture in the colony core)
    L = lab[..., 0]
    lap = np.abs(laplacian(L))
    tex = np.sqrt(np.maximum(box_blur(L * L, 5) - box_blur(L, 5) ** 2, 0))
    gxl, gyl = sobel(L)
    gmag = np.hypot(gxl, gyl) / 8.0
    core = colony & (np.hypot(xx - ccx, yy - ccy) <= 0.92 * r_at) if has_colony else dish
    if core.sum() < 20:
        core = region
    lap_mean = float(lap[core].mean()) if core.any() else 0.0
    tex_mean = float(tex[core].mean()) if core.any() else 0.0
    edge_density = _pct((gmag[core] > 2.5).sum(), core.sum())
    fluffiness = 100.0 * float(
        np.clip(
            0.40 * min(lap_mean / 5.0, 1.0) + 0.40 * min(tex_mean / 4.0, 1.0) + 0.20 * min(edge_density / 40.0, 1.0),
            0,
            1,
        )
    )

    # shape
    if has_colony:
        ang = np.linspace(0.0, 2.0 * math.pi, radii.size, endpoint=False)
        px_ = ccx + radii * np.cos(ang)
        py_ = ccy + radii * np.sin(ang)
        poly_area = 0.5 * abs(np.dot(px_, np.roll(py_, -1)) - np.dot(py_, np.roll(px_, -1)))
        perim = float(np.hypot(np.diff(np.append(px_, px_[0])), np.diff(np.append(py_, py_[0]))).sum())
        circularity = min(1.0, 4.0 * math.pi * poly_area / perim**2) if perim > 0 else 0.0
        mx_, my_ = float(xs_c.mean()), float(ys_c.mean())
        eq = np.hypot(xx - mx_, yy - my_) <= math.sqrt(area / math.pi)
        iou = float((eq & colony).sum()) / float((eq | colony).sum())
        opp = np.roll(radii, radii.size // 2)
        symmetry = float(np.clip(1.0 - np.mean(np.abs(radii - opp)) / max(radii.mean(), 1e-6), 0, 1))
    else:
        circularity = iou = symmetry = 0.0
    shape_score = 100.0 * (0.5 * iou + 0.3 * circularity + 0.2 * symmetry)

    # contamination / colour ratios (% of plate)
    contam = red | green
    agar_pct = _pct(yellow.sum(), n_dish)
    contam_pct = _pct(contam.sum(), n_dish)
    ink_pct = _pct(ink.sum(), n_dish)
    dark_pct = _pct(dark.sum(), n_dish)
    clean_pct = _pct((white & colony).sum(), n_dish)

    # colour calibration vs. reference swatches
    std_masks = {"White": white & (colony if has_colony else dish), "Blue": ink, "Red": red, "Yellow": yellow, "Black": dark}
    calibration = []
    for cname, std_rgb in COLOR_STANDARDS:
        m = std_masks[cname]
        entry = {"name": cname, "standard": list(std_rgb), "sample": None, "match": None}
        if m.sum() >= max(30, 0.002 * n_dish):
            sample = np.median(rgb[m], axis=0)
            de = float(np.linalg.norm(rgb_to_lab(sample[None, :])[0] - rgb_to_lab(np.array([std_rgb], dtype=np.float32))[0]))
            entry["sample"] = [int(round(c)) for c in sample]
            entry["match"] = _r(max(0.0, 100.0 - de))
        calibration.append(entry)

    # 5) score + decision ----------------------------------------------------
    growth_score = float(np.clip(growth / 75.0 * 100.0, 0, 100))
    wsum = cfg.weight_growth + cfg.weight_whiteness + cfg.weight_fluffiness + cfg.weight_shape or 1.0
    weights = {
        "growth": cfg.weight_growth / wsum,
        "whiteness": cfg.weight_whiteness / wsum,
        "fluffiness": cfg.weight_fluffiness / wsum,
        "shape": cfg.weight_shape / wsum,
    }
    score = (
        weights["growth"] * growth_score
        + weights["whiteness"] * whiteness
        + weights["fluffiness"] * fluffiness
        + weights["shape"] * shape_score
    )
    grade, grade_label = grade_for(score)

    reasons: List[Dict[str, str]] = []
    if contam_pct > cfg.max_contamination:
        reasons.append({"code": "Contaminated", "th": "พบการปนเปื้อน (สีแดง/น้ำตาล/เขียว)",
                        "detail": f"{contam_pct:.1f}% > {cfg.max_contamination:g}%"})
    if agar_pct > cfg.max_agar:
        reasons.append({"code": "Agar Exposed", "th": "เส้นใยไม่คลุมอาหารวุ้น",
                        "detail": f"{agar_pct:.1f}% > {cfg.max_agar:g}%"})
    if growth < cfg.min_growth:
        reasons.append({"code": "Low Growth", "th": "การเจริญเติบโตต่ำ",
                        "detail": f"{growth:.1f}% < {cfg.min_growth:g}%"})
    if has_colony and iou < cfg.min_iou:
        reasons.append({"code": "Check Shape", "th": "รูปทรงโคโลนีผิดปกติ",
                        "detail": f"IoU {iou:.3f} < {cfg.min_iou:g}"})
    if score < cfg.min_score:
        reasons.append({"code": "Low Score", "th": "คะแนนรวมต่ำกว่าเกณฑ์",
                        "detail": f"{score:.1f} < {cfg.min_score:g}"})
    passed = not reasons

    report = {
        "name": name,
        "result": "PASS" if passed else "FAIL",
        "passed": passed,
        "status": "Acceptable" if passed else reasons[0]["code"],
        "reasons": reasons,
        "score": _r(score),
        "grade": grade,
        "grade_label": grade_label,
        "image_size": [W, H],
        "dish": {"cx": _r(dcx), "cy": _r(dcy), "radius_px": _r(r_dish), "confidence": dish_conf,
                 "plate_cm": cfg.plate_cm, "px_per_cm": _r(px_per_cm, 2)},
        "colony": {"detected": bool(has_colony), "width_cm": _r(width_px / px_per_cm), "height_cm": _r(height_px / px_per_cm),
                   "area_cm2": _r(area / px_per_cm**2, 2), "center": [_r(ccx), _r(ccy)], "bbox": bbox},
        "metrics": {
            "growth": _r(growth),
            "whiteness": _r(whiteness),
            "whiteness_raw": _r(whiteness_raw),
            "white_ratio": _r(white_ratio),
            "fluffiness": _r(fluffiness),
            "laplacian": _r(lap_mean, 2),
            "texture": _r(tex_mean, 2),
            "edge_density": _r(edge_density),
            "circularity": _r(circularity * 100),
            "iou": round(iou, 3),
            "symmetry": _r(symmetry * 100),
            "shape": _r(shape_score),
        },
        "subscores": {"growth": _r(growth_score), "whiteness": _r(whiteness), "fluffiness": _r(fluffiness), "shape": _r(shape_score)},
        "weights": {k: round(v_, 3) for k, v_ in weights.items()},
        "contamination": {"clean": _r(clean_pct), "agar": _r(agar_pct), "contamination": _r(contam_pct),
                          "red": _r(_pct(red.sum(), n_dish)), "green": _r(_pct(green.sum(), n_dish)),
                          "ink": _r(ink_pct), "dark": _r(dark_pct), "dark_threshold": _r(dark_thr, 0)},
        "color_ratio": {"yellow": _r(agar_pct), "red": _r(_pct(red.sum(), n_dish)), "blue": _r(ink_pct)},
        "lighting": {"wb_gains": wb_gains, "exposure": exposure},
        "calibration": calibration,
        "config": cfg.to_dict(),
    }
    layers = {
        "rgb": rgb8, "dish_center": (dcx, dcy), "r_dish": r_dish, "r_in": r_in, "dish": dish,
        "colony": colony, "colony_center": (ccx, ccy), "radii": radii, "px_per_cm": px_per_cm,
        "white": white, "yellow": yellow, "red": red, "green": green, "ink": ink, "dark": dark,
        "texture": tex, "whiteness": w_map, "core": core,
    }
    return Analysis(report=report, layers=layers)
