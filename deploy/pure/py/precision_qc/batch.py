"""Multi-plate ("batch photo") analysis.

One photo may hold several petri dishes side by side.  This module

1. finds every *whole* dish in the photo (multi-circle Hough transform; dishes
   cut off by the image border and stacked/overlapping dishes are ignored),
2. analyses each dish on its own with :func:`precision_qc.analyzer.analyze`,
3. ranks the dishes by QC score (PASS before FAIL, then higher score first).

Only numpy + Pillow are used, so it also runs under Pyodide.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from .analyzer import Analysis, QCConfig, analyze, box_blur, load_image, sobel


@dataclass
class Plate:
    """One dish found in a photo: its analysis plus layout/rank information."""

    index: int  # 1-based reading order (top-to-bottom, left-to-right)
    analysis: Analysis
    center: Tuple[float, float]  # in full-photo pixels
    radius: float
    rank: int = 0


@dataclass
class BatchResult:
    plates: List[Plate]  # reading order
    photo: np.ndarray = field(repr=False, default=None)  # uint8 RGB used for detection
    summary: Dict[str, Any] = field(default_factory=dict)

    @property
    def ranked(self) -> List[Plate]:
        return sorted(self.plates, key=lambda p: p.rank)


def detect_dishes(
    rgb: np.ndarray,
    min_radius_frac: float = 0.06,
    max_radius_frac: float = 0.22,
    max_plates: int = 24,
) -> List[Tuple[float, float, float, float]]:
    """Find whole petri dishes. Returns ``[(cx, cy, radius, confidence), ...]`` in ``rgb`` pixels.

    Radii are limited to ``min/max_radius_frac`` of the longest side. A circle
    must lie completely inside the photo, so dishes cropped by the border (or a
    stack of lids in a corner) are not reported.
    """
    H, W = rgb.shape[:2]
    f = 360.0 / max(H, W)
    sw, sh = max(1, round(W * f)), max(1, round(H * f))
    gray = np.asarray(Image.fromarray(rgb).convert("L").resize((sw, sh), Image.BILINEAR), dtype=np.float32)
    gray = box_blur(gray, 3)
    h, w = gray.shape
    gx, gy = sobel(gray)
    mag = np.hypot(gx, gy)
    thr = float(np.percentile(mag, 88))
    if thr <= 1e-3:
        return []
    ys, xs = np.nonzero(mag > thr)
    m = mag[ys, xs]
    if m.size > 20000:
        keep = np.argpartition(m, -20000)[-20000:]
        ys, xs, m = ys[keep], xs[keep], m[keep]
    ux, uy = gx[ys, xs] / m, gy[ys, xs] / m

    L = max(h, w)
    radii = np.arange(max(8, int(min_radius_frac * L)), int(max_radius_frac * L) + 1, 2)
    score = np.zeros((len(radii), h, w), dtype=np.float32)
    for i, r in enumerate(radii):
        acc = np.zeros(h * w, dtype=np.float64)
        for sgn in (1.0, -1.0):
            cx = np.rint(xs + sgn * r * ux).astype(np.intp)
            cy = np.rint(ys + sgn * r * uy).astype(np.intp)
            ok = (cx >= 0) & (cx < w) & (cy >= 0) & (cy < h)
            acc += np.bincount(cy[ok] * w + cx[ok], minlength=h * w)
        score[i] = box_blur(acc.reshape(h, w), 3) * 9.0 / (2.0 * math.pi * r)

    # a circle must fit inside the photo (small tolerance for the rim shadow)
    yy, xx = np.mgrid[0:h, 0:w]
    edge_dist = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]).astype(np.float32)
    score[radii[:, None, None] > edge_dist[None] + 0.04 * radii[:, None, None]] = 0.0

    best = score.max(axis=0)
    top = float(best.max())
    if top < 0.12:
        return []
    # per centre, take the *largest* clearly-peaked radius: the dish rim, not the
    # (often stronger) colony edge or inner wall
    ok_r = score >= 0.6 * best[None]
    ok_r &= best[None] >= 0.2
    r_idx = (len(radii) - 1) - np.argmax(ok_r[::-1], axis=0)

    found: List[Tuple[float, float, float, float]] = []
    work = best.copy()
    floor = max(0.2, 0.4 * top)
    while len(found) < max_plates:
        j = int(np.argmax(work))
        val = float(work.flat[j])
        if val < floor:
            break
        cy_s, cx_s = divmod(j, w)
        r = float(radii[r_idx[cy_s, cx_s]])
        found.append((cx_s / f, cy_s / f, r / f, round(min(1.0, val), 3)))
        # suppress every centre that would overlap this dish
        work[np.hypot(xx - cx_s, yy - cy_s) < 0.9 * r] = 0.0

    if not found:
        return []
    # drop outliers: real dishes in one photo have a similar size
    med = float(np.median([d[2] for d in found]))
    found = [d for d in found if 0.75 * med <= d[2] <= 1.3 * med]
    # drop dishes that overlap another one (stacked dishes / lids)
    kept: List[Tuple[float, float, float, float]] = []
    for d in sorted(found, key=lambda t: -t[3]):
        if all(math.hypot(d[0] - k[0], d[1] - k[1]) >= 0.85 * (d[2] + k[2]) for k in kept):
            kept.append(d)
    return kept


def refine_dish(gray: np.ndarray, cx: float, cy: float, r: float) -> Tuple[float, float, float]:
    """Fine-tune a coarse Hough circle on the full-resolution image.

    Searches centres within +-12 % and radii within +-18 % of the coarse fit for
    the circle with the most radially-aligned edge pixels, preferring the outer
    rim over the inner wall of the lid.
    """
    H, W = gray.shape
    x0, x1 = int(max(1, cx - 1.4 * r)), int(min(W - 1, cx + 1.4 * r))
    y0, y1 = int(max(1, cy - 1.4 * r)), int(min(H - 1, cy + 1.4 * r))
    sub = box_blur(gray[y0:y1, x0:x1], 3)
    gx, gy = sobel(sub)
    mag = np.hypot(gx, gy)
    ys, xs = np.nonzero(mag > np.percentile(mag, 85))
    m = mag[ys, xs]
    ux, uy = gx[ys, xs] / m, gy[ys, xs] / m
    px, py = xs + x0, ys + y0
    step = max(1, int(0.015 * r))
    offs = np.arange(-int(0.12 * r), int(0.12 * r) + 1, step)
    r_lo, r_hi = int(0.88 * r), int(1.12 * r) + 1
    kernel = np.ones(5) / 5.0
    best = (-1.0, cx, cy, r)
    for dy in offs:
        for dx in offs:
            vx, vy = px - (cx + dx), py - (cy + dy)
            d = np.hypot(vx, vy)
            align = np.abs((vx * ux + vy * uy) / np.maximum(d, 1e-6))
            sel = (d >= r_lo) & (d < r_hi) & (align > 0.8)
            if not sel.any():
                continue
            hist = np.bincount((d[sel] - r_lo).astype(np.intp), weights=align[sel], minlength=r_hi - r_lo)
            hist = np.convolve(hist, kernel, mode="same")
            top = hist.max()
            if top <= 0:
                continue
            rr = int(np.flatnonzero(hist >= 0.85 * top)[-1])  # outermost strong ring
            val = float(hist[rr])
            if val > best[0]:
                best = (val, cx + dx, cy + dy, float(rr + r_lo))
    return best[1], best[2], best[3]


def reading_order(dishes: List[Tuple[float, float, float, float]]) -> List[Tuple[float, float, float, float]]:
    """Sort dishes top-to-bottom then left-to-right (rows grouped by dish radius)."""
    if not dishes:
        return []
    row_h = float(np.median([d[2] for d in dishes]))
    ordered = sorted(dishes, key=lambda d: d[1])
    rows: List[List[Tuple[float, float, float, float]]] = []
    for d in ordered:
        if rows and abs(d[1] - np.mean([x[1] for x in rows[-1]])) < row_h:
            rows[-1].append(d)
        else:
            rows.append([d])
    return [d for row in rows for d in sorted(row, key=lambda t: t[0])]


def rank_key(rep: Dict[str, Any]):
    """Best first: PASS before FAIL, then higher score, then less contamination."""
    return (0 if rep["passed"] else 1, -rep["score"], rep["contamination"]["contamination"])


def analyze_plates(
    src: Any,
    config: Optional[QCConfig] = None,
    name: str = "photo",
    work_size: int = 1600,
    plate_size: Optional[int] = None,
) -> BatchResult:
    """Split a photo into its dishes, analyse each, and rank them."""
    cfg = config or QCConfig()
    photo = load_image(src, work_size)
    H, W = photo.shape[:2]
    gray = photo.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    dishes = []
    for cx, cy, r, conf in detect_dishes(photo):
        cx, cy, r = refine_dish(gray, cx, cy, r)
        dishes.append((cx, cy, r, conf))
    dishes = reading_order(dishes)

    plates: List[Plate] = []
    for i, (cx, cy, r, conf) in enumerate(dishes, start=1):
        pad = 1.12 * r
        x0, x1 = int(max(0, cx - pad)), int(min(W, cx + pad))
        y0, y1 = int(max(0, cy - pad)), int(min(H, cy + pad))
        crop = photo[y0:y1, x0:x1]
        ch, cw = crop.shape[:2]
        hint = ((cx - x0) / cw, (cy - y0) / ch, r / max(cw, ch), conf)
        an = analyze(crop, cfg, name=f"{name}#{i}", dish_hint=hint)
        an.report["plate"] = i
        an.report["source"] = name
        plates.append(Plate(index=i, analysis=an, center=(cx, cy), radius=r))

    for rank, p in enumerate(sorted(plates, key=lambda p: rank_key(p.analysis.report)), start=1):
        p.rank = rank
        p.analysis.report["rank"] = rank
        p.analysis.report["plates_in_photo"] = len(plates)

    return BatchResult(plates=plates, photo=photo, summary=summarize(plates, name))


def summarize(plates: List[Plate], name: str = "photo") -> Dict[str, Any]:
    reps = [p.analysis.report for p in plates]
    n_pass = sum(r["passed"] for r in reps)
    out: Dict[str, Any] = {
        "source": name,
        "plates": len(reps),
        "pass": n_pass,
        "fail": len(reps) - n_pass,
        "pass_rate": round(100.0 * n_pass / len(reps), 1) if reps else 0.0,
        "mean_score": round(float(np.mean([r["score"] for r in reps])), 1) if reps else 0.0,
        "ranking": [],
    }
    for p in sorted(plates, key=lambda p: p.rank):
        r = p.analysis.report
        out["ranking"].append({"rank": p.rank, "plate": p.index, "result": r["result"], "score": r["score"],
                               "grade": r["grade"], "reasons": [x["code"] for x in r["reasons"]]})
    if reps:
        out["best"] = out["ranking"][0]["plate"]
        out["worst"] = out["ranking"][-1]["plate"]
    # batch-level condition: flag a photo whose dishes disagree strongly
    if len(reps) > 1:
        scores = [r["score"] for r in reps]
        out["score_spread"] = round(max(scores) - min(scores), 1)
    return out


def label_strips(photo: np.ndarray, cx: float, cy: float, r: float, half_deg: float = 72.0, scale: float = 2.0) -> Dict[str, Image.Image]:
    """Straightened, pen-ink-enhanced views of the dish rim, where the ID is usually written.

    The ring between 0.52 R and R is unrolled around the top and the bottom of the dish
    (+-``half_deg``), so curved handwriting becomes a straight line and text written upright
    reads left-to-right in both strips. Colour is dropped and dark strokes are boosted so
    faint pen marks are easy to read. Returns ``{"top": img, "bottom": img}``.
    """
    pad = int(r * 1.05) + 2
    x0, y0 = int(cx) - pad, int(cy) - pad
    gray = np.full((2 * pad, 2 * pad), 255.0, dtype=np.float32)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(photo.shape[1], x0 + 2 * pad), min(photo.shape[0], y0 + 2 * pad)
    g = photo[sy0:sy1, sx0:sx1].astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    gray[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] = g
    bg = box_blur(gray, int(r / 3) | 1)
    ink = 255.0 - np.clip((bg - gray) * 4.0, 0.0, 255.0)  # white paper, dark strokes
    ccx, ccy = cx - x0, cy - y0

    def unroll(center_deg: float, outer_on_top: bool) -> Image.Image:
        r0, r1 = 0.52 * r, 1.0 * r
        span = math.radians(2 * half_deg)
        w, h = int(span * 0.8 * r * scale), int((r1 - r0) * scale)
        u = np.linspace(0.0, 1.0, w)
        v = np.linspace(0.0, 1.0, h)
        # top: columns run clockwise (left->right); bottom: counter-clockwise, so text stays upright
        theta = math.radians(center_deg) + (u - 0.5) * span * (1.0 if outer_on_top else -1.0)
        rad = (r1 - v * (r1 - r0)) if outer_on_top else (r0 + v * (r1 - r0))
        xs = ccx + rad[:, None] * np.cos(theta)[None, :]
        ys = ccy + rad[:, None] * np.sin(theta)[None, :]
        xi = np.clip(np.floor(xs).astype(np.intp), 0, ink.shape[1] - 2)
        yi = np.clip(np.floor(ys).astype(np.intp), 0, ink.shape[0] - 2)
        fx, fy = np.clip(xs - xi, 0, 1), np.clip(ys - yi, 0, 1)
        out = (ink[yi, xi] * (1 - fx) * (1 - fy) + ink[yi, xi + 1] * fx * (1 - fy)
               + ink[yi + 1, xi] * (1 - fx) * fy + ink[yi + 1, xi + 1] * fx * fy)
        return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))

    return {"top": unroll(-90.0, True), "bottom": unroll(90.0, False)}


def overview_image(result: BatchResult) -> Image.Image:
    """Photo with every dish circled and labelled with its plate number, rank and result."""
    from PIL import ImageDraw

    from .render import _circle, _font

    im = Image.fromarray(result.photo).copy()
    d = ImageDraw.Draw(im)
    font = _font(max(14, im.width // 75))
    for p in result.plates:
        rep = p.analysis.report
        color = (30, 170, 80) if rep["passed"] else (215, 40, 40)
        _circle(d, p.center, p.radius, color, max(3, im.width // 400))
        label = f"#{p.index}  R{p.rank}  {rep['result']} {rep['score']:.1f}"
        tx, ty = p.center[0] - p.radius * 0.8, p.center[1] - 0.25 * font.size
        box = d.textbbox((tx, ty), label, font=font)
        d.rectangle([box[0] - 4, box[1] - 2, box[2] + 4, box[3] + 2], fill=(255, 255, 255))
        d.text((tx, ty), label, fill=color, font=font)
    return im
