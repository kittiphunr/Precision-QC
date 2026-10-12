"""Mushroom-cap counting for a bunch of enoki ("ช่อดอก").

Photograph a bunch from above and count the round caps (heads):

1. the bunch is the biggest pale, non-blue blob in the photo (blue sleeve /
   background and neighbouring bunches cut by the border are ignored),
2. cap bodies are the pixels brighter than their surroundings — the darker
   gaps between touching caps split them apart,
3. a distance transform gives one centre + radius per cap,
4. each cap is classed small / medium / large relative to the median cap of
   that bunch (green / blue / red in the overlay),
5. caps lying *under* others are recovered: the fully visible caps are masked
   out, shadows are lifted, and what is left of pale (low-saturation) pixels —
   the crescents peeking out — is split into fragments; a circle is fitted to
   each fragment's free outline to estimate the whole hidden cap (orange),
6. area shares: how much of the bunch area each size class covers.

Only numpy + Pillow are used, so it also runs under Pyodide.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, fields
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw

from .analyzer import box_blur, load_image, rgb_to_hsv

SIZE_CLASSES = ("small", "medium", "large")
CLASSES = SIZE_CLASSES + ("hidden",)  # "hidden" = a cap partly covered by others, estimated from the part that peeks out
CLASS_COLORS = {"small": (80, 220, 90), "medium": (40, 60, 230), "large": (235, 50, 40), "hidden": (255, 170, 0)}


@dataclass
class CapConfig:
    work_size: int = 1100  # longest side (px) the photo is analysed at
    contrast: float = 3.0  # how much brighter than its surroundings a cap must be (higher = stricter)
    min_cap_px: float = 2.0  # smallest cap radius kept (px at work size)
    small_below: float = 0.85  # radius < small_below x median  -> small
    large_above: float = 1.20  # radius > large_above x median  -> large
    find_hidden: int = 1  # 1 = also recover caps lying under other caps (0 = off)
    hidden_sat: float = 0.16  # max colour saturation of a hidden cap's visible part (stems are more saturated)
    shadow_lift: float = 0.55  # gamma < 1 brightens shadows before looking for hidden caps
    hidden_min_px: float = 40.0  # smallest visible fragment (px² at work size) accepted as a hidden cap

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> "CapConfig":
        base = cls()
        for f in fields(cls):
            if d and d.get(f.name) not in (None, ""):
                setattr(base, f.name, type(getattr(base, f.name))(float(d[f.name])))
        base.work_size = int(min(2400, max(400, base.work_size)))
        return base

    def to_dict(self) -> Dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass
class CapResult:
    name: str
    photo: np.ndarray = field(repr=False, default=None)  # uint8 RGB at work size
    bunch: np.ndarray = field(repr=False, default=None)  # bool mask of the bunch
    caps: List[Tuple[float, float, float, str]] = field(default_factory=list)  # x, y, r, class
    report: Dict[str, Any] = field(default_factory=dict)
    fragments: np.ndarray = field(repr=False, default=None)  # bool mask: visible parts of hidden caps


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _gauss_kernel(sigma: float) -> np.ndarray:
    n = max(1, int(math.ceil(3 * sigma)))
    x = np.arange(-n, n + 1, dtype=np.float32)
    k = np.exp(-(x * x) / (2 * sigma * sigma))
    return k / k.sum()


def gaussian(a: np.ndarray, sigma: float) -> np.ndarray:
    k = _gauss_kernel(sigma)
    n = len(k) // 2
    p = np.pad(a.astype(np.float32), n, mode="edge")
    out = np.zeros((p.shape[0], a.shape[1]), dtype=np.float32)
    for i, w in enumerate(k):
        out += w * p[:, i : i + a.shape[1]]
    res = np.zeros(a.shape, dtype=np.float32)
    for i, w in enumerate(k):
        res += w * out[i : i + a.shape[0], :]
    return res


def _label(mask: np.ndarray) -> Tuple[np.ndarray, int]:
    """4-connected component labelling (iterative flood fill; fine for small masks)."""
    h, w = mask.shape
    lab = np.zeros((h, w), dtype=np.int32)
    n = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        n += 1
        lab[y0, x0] = n
        stack = [(y0, x0)]
        while stack:
            y, x = stack.pop()
            for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n
                    stack.append((yy, xx))
    return lab, n


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    return gaussian(mask.astype(np.float32), max(0.5, r / 2.0)) > 0.15


def _distance(mask: np.ndarray, max_iter: int = 60) -> np.ndarray:
    """Approximate Euclidean distance to the background (alternating 4/8-neighbour erosions)."""
    dist = np.zeros(mask.shape, dtype=np.float32)
    cur = mask.copy()
    for i in range(max_iter):
        if not cur.any():
            break
        dist += cur
        p = np.pad(cur, 1, constant_values=False)
        nxt = cur & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
        if i % 2:
            nxt &= p[:-2, :-2] & p[:-2, 2:] & p[2:, :-2] & p[2:, 2:]
        cur = nxt
    return dist


def find_bunch(rgb: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns ``(pale, bunch, region)`` boolean masks.

    ``pale`` = cream / white pixels (not the blue sleeve), ``bunch`` = the
    biggest blob of them that is not cut off by the photo border (a blob that
    touches the border still counts when nothing else is whole). ``region`` is
    the bunch's whole footprint (gaps between caps filled in) — the "bunch area"
    the percentages are measured against.
    """
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    sat = (f.max(-1) - f.min(-1)) / np.maximum(f.max(-1), 1.0)
    pale = (f.max(-1) > 120) & (sat < 0.2) & (r > g - 25)  # cream / white; the blue sleeve is far more saturated
    H, W = pale.shape
    s = 4
    small = gaussian(pale[: H // s * s, : W // s * s].reshape(H // s, s, W // s, s).mean((1, 3)), 2.0) > 0.2
    lab, n = _label(small)
    h, w = small.shape
    best, best_score = 0, -1.0
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        touches = ys.min() == 0 or xs.min() == 0 or ys.max() == h - 1 or xs.max() == w - 1
        score = len(ys) * (0.3 if touches else 1.0)
        if score > best_score:
            best, best_score = i, score
    if not best:
        return pale, np.zeros_like(pale), np.zeros_like(pale)
    big = np.kron((lab == best).astype(np.uint8), np.ones((s, s), np.uint8)).astype(bool)
    bunch = np.zeros_like(pale)
    bunch[: big.shape[0], : big.shape[1]] = big
    region = bunch & (gaussian(pale.astype(np.float32), 6.0) > 0.5)
    return pale, _dilate(bunch, 8) & pale, region


def count_caps(src: Any, config: Optional[CapConfig] = None, name: str = "bunch") -> CapResult:
    """Count the mushroom caps of the bunch in ``src`` (path / bytes / PIL / ndarray)."""
    cfg = config or CapConfig()
    rgb = load_image(src, cfg.work_size)
    pale, bunch, region = find_bunch(rgb)
    f = rgb.astype(np.float32)
    lum = 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]
    body = (lum > gaussian(lum, 9.0) - cfg.contrast) & bunch
    body = gaussian(body.astype(np.float32), 1.0) > 0.5
    dist = _distance(body)
    smooth = gaussian(dist, 1.5)
    pad = np.pad(smooth, 2)
    peak = smooth >= cfg.min_cap_px * 0.8
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dy or dx:
                peak &= smooth >= pad[2 + dy : 2 + dy + smooth.shape[0], 2 + dx : 2 + dx + smooth.shape[1]]
    ys, xs = np.nonzero(peak)
    raw = [(float(x), float(y), float(dist[y, x]) * 1.15 + 0.5) for x, y in zip(xs, ys) if dist[y, x] * 1.15 + 0.5 >= cfg.min_cap_px]
    med = float(np.median([c[2] for c in raw])) if raw else 0.0
    caps = []
    for x, y, r in raw:
        cls = "small" if r < cfg.small_below * med else ("large" if r > cfg.large_above * med else "medium")
        caps.append((x, y, r, cls))
    H, W = rgb.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    covered = _discs(caps, yy, xx, grow=1.05)
    hidden, frag = [], np.zeros((H, W), dtype=bool)
    if cfg.find_hidden and caps:
        hidden, frag = _find_hidden(f, bunch, covered, med, cfg, yy, xx, caps)
        caps += hidden
    counts = {k: sum(1 for c in caps if c[3] == k) for k in CLASSES}
    total = len(caps)
    bunch_px = int(bunch.sum())
    region_px = int(region.sum())
    # share of the bunch's area (gaps filled in) covered by each class of cap
    area = {}
    for k in SIZE_CLASSES:
        m = _discs([c for c in caps if c[3] == k], yy, xx) & region
        area[k] = round(100.0 * m.sum() / region_px, 1) if region_px else 0.0
    caps_union = _discs([c for c in caps if c[3] != "hidden"], yy, xx) & region
    area["visible"] = round(100.0 * caps_union.sum() / region_px, 1) if region_px else 0.0
    area["hidden"] = round(100.0 * (frag & region & ~caps_union).sum() / region_px, 1) if region_px else 0.0
    area["gaps"] = round(max(0.0, 100.0 - area["visible"] - area["hidden"]), 1)
    report = {
        "name": name,
        "total": total,
        "counts": counts,
        "percent": {k: round(100.0 * v / total, 1) if total else 0.0 for k, v in counts.items()},
        "area_percent": area,
        "bunch_area_px": region_px,
        "median_diameter_px": round(2 * med, 1),
        "bunch_area_pct": round(100.0 * region_px / (H * W), 1),
        "caps_per_1000px2": round(1000.0 * total / region_px, 2) if region_px else 0.0,
        "image_size": [W, H],
        "config": cfg.to_dict(),
    }
    return CapResult(name=name, photo=rgb, bunch=region, caps=caps, report=report, fragments=frag)


def _discs(caps, yy, xx, grow: float = 1.0) -> np.ndarray:
    """Boolean mask: union of the cap discs (radius x ``grow``)."""
    H, W = yy.shape
    m = np.zeros((H, W), dtype=bool)
    for x, y, r, *_ in caps:
        rr = r * grow + (1 if grow != 1.0 else 0)
        x0, x1, y0, y1 = int(max(0, x - rr - 1)), int(min(W, x + rr + 2)), int(max(0, y - rr - 1)), int(min(H, y + rr + 2))
        m[y0:y1, x0:x1] |= (xx[y0:y1, x0:x1] - x) ** 2 + (yy[y0:y1, x0:x1] - y) ** 2 <= rr * rr
    return m


def _fit_circle(pts: np.ndarray) -> Optional[Tuple[float, float, float]]:
    """Least-squares circle through points (Kasa fit); None if degenerate."""
    if len(pts) < 5:
        return None
    x, y = pts[:, 0], pts[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones(len(x))]
    try:
        (cx, cy, c), *_ = np.linalg.lstsq(A, x * x + y * y, rcond=None)
    except np.linalg.LinAlgError:
        return None
    r2 = c + cx * cx + cy * cy
    return (float(cx), float(cy), math.sqrt(r2)) if r2 > 1 else None


def _find_hidden(f, bunch, covered, med, cfg, yy, xx, caps):
    """Caps lying under other caps, estimated from the crescents that peek out.

    Shadows are lifted (gamma) so darker, shaded caps count, then pixels that
    are pale (low saturation — stems are more yellow) and not already inside a
    full cap are kept. Thin slivers (rim of imprecise circles) are opened away,
    the rest is split into fragments by distance-transform peaks, and a circle
    is fitted to each fragment's *free* outline (the part not touching another
    cap) to guess the whole cap.
    """
    H, W = bunch.shape
    mx, mn = f.max(-1), f.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1.0)
    lum = 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]
    lifted = 255.0 * (lum / 255.0) ** cfg.shadow_lift
    core = _discs([(x, y, r * 0.5) for x, y, r, _ in caps], yy, xx)
    ref = float(np.median(lifted[core])) if core.any() else 200.0  # brightness of a lit cap's middle
    cand = bunch & ~covered & (sat < cfg.hidden_sat) & (lifted > max(105.0, 0.72 * ref))
    # open: drop slivers thinner than ~3 px
    p = np.pad(cand, 1, constant_values=False)
    er = cand & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    p = np.pad(er, 1, constant_values=False)
    er2 = er & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    cand = cand & (gaussian(er2.astype(np.float32), 2.0) > 0.08)
    if cand.sum() < cfg.hidden_min_px:
        return [], cand
    lab, n = _label(cand)
    dist = _distance(cand, 30)
    smooth = gaussian(dist, 1.0)
    ys, xs = np.nonzero(cand)
    # edge of fragment: candidate pixel with a non-candidate 4-neighbour
    pp = np.pad(cand, 1, constant_values=False)
    edge = cand & ~(pp[:-2, 1:-1] & pp[2:, 1:-1] & pp[1:-1, :-2] & pp[1:-1, 2:])
    near_cap = _discs_mask_dilate(covered)
    free_edge = edge & ~near_cap
    out = []
    fy, fx = np.nonzero(free_edge)
    for i in range(1, n + 1):
        comp = lab == i
        area = int(comp.sum())
        if area < cfg.hidden_min_px:
            continue
        cy_, cx_ = np.nonzero(comp)
        sel = lab[fy, fx] == i
        pts = np.c_[fx[sel], fy[sel]].astype(np.float64)
        fit = _fit_circle(pts)
        pk = np.argmax(dist[cy_, cx_])
        r_fb = float(dist[cy_[pk], cx_[pk]]) * 1.15 + 0.5
        ok = fit is not None and 0.55 * med <= fit[2] <= 1.8 * med and area <= math.pi * fit[2] ** 2 * 1.05
        if ok:
            x, y, r = fit
        else:  # too little free outline to fit: use the fragment itself
            x, y, r = float(cx_[pk]), float(cy_[pk]), r_fb
        if r < cfg.min_cap_px:
            continue
        out.append((float(x), float(y), float(r), "hidden"))
    return out, cand


def _discs_mask_dilate(mask: np.ndarray, it: int = 2) -> np.ndarray:
    m = mask
    for _ in range(it):
        p = np.pad(m, 1, constant_values=False)
        m = m | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def overlay_image(res: CapResult, width: int = 0) -> Image.Image:
    """The photo with a circle on every counted cap: green / blue / red = small / medium / large,
    orange = hidden under other caps (its visible crescent is tinted)."""
    photo = res.photo
    if res.fragments is not None and res.fragments.any():
        photo = photo.copy()
        m = res.fragments
        photo[m] = (0.45 * photo[m] + 0.55 * np.array(CLASS_COLORS["hidden"])).astype(np.uint8)
    im = Image.fromarray(photo)
    scale = 1.0
    if width and width != im.width:
        scale = width / im.width
        im = im.resize((width, round(im.height * scale)), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    lw = 2 if scale >= 0.8 else 1
    for x, y, r, cls in res.caps:
        x, y, r = x * scale, y * scale, r * scale
        d.ellipse([x - r, y - r, x + r, y + r], outline=CLASS_COLORS[cls], width=lw)
    return im
