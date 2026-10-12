"""Mushroom-cap counting for a bunch of enoki ("ช่อดอก").

Photograph a bunch from above and count the round caps (heads):

1. the bunch is the biggest pale, non-blue blob in the photo (blue sleeve /
   background and neighbouring bunches cut by the border are ignored),
2. cap bodies are the pixels brighter than their surroundings — the darker
   gaps between touching caps split them apart,
3. a distance transform gives one centre + radius per cap,
4. each cap is classed small / medium / large relative to the median cap of
   that bunch (green / blue / red in the overlay),
5. caps the brightness view missed (small ones in the gaps, dim ones in shade)
   are searched again in several other views — the blue channel, the darkest
   channel (min of R,G,B: only white caps stay bright) and a lighter-local-mean
   version — then each new circle must stand out from the ring around it,
6. caps lying *under* others are recovered: the fully visible caps are masked
   out, shadows are lifted, and what is left of pale (low-saturation) pixels —
   the crescents peeking out — is split into fragments; a circle is fitted to
   each fragment's free outline to estimate the whole hidden cap (orange),
7. area shares: how much of the bunch area each size class covers.

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
    multi_view: int = 1  # 1 = also search other colour views (B, min-RGB, shadows lifted) for caps the first pass missed
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
    stages: Dict[str, Any] = field(repr=False, default_factory=dict)  # intermediate results, drawn by step_images()


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


def find_bunch(rgb: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Returns ``(pale, bunch, region, footprint)`` boolean masks.

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
        z = np.zeros_like(pale)
        return pale, z, z, z
    big = np.kron((lab == best).astype(np.uint8), np.ones((s, s), np.uint8)).astype(bool)
    bunch = np.zeros_like(pale)
    bunch[: big.shape[0], : big.shape[1]] = big
    region = bunch & (gaussian(pale.astype(np.float32), 6.0) > 0.5)
    return pale, _dilate(bunch, 8) & pale, region, _dilate(bunch, 8)


def count_caps(src: Any, config: Optional[CapConfig] = None, name: str = "bunch") -> CapResult:
    """Count the mushroom caps of the bunch in ``src`` (path / bytes / PIL / ndarray)."""
    cfg = config or CapConfig()
    rgb = load_image(src, cfg.work_size)
    pale, bunch, region, footprint = find_bunch(rgb)
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
    first_pass = list(caps)
    covered = _discs(caps, yy, xx, grow=1.05)
    more = []
    if cfg.multi_view and caps:
        more = _more_caps(f, footprint, covered, caps, med, cfg, yy, xx)
        caps += more
        covered = _discs(caps, yy, xx, grow=1.05)
    hidden, frag = [], np.zeros((H, W), dtype=bool)
    if cfg.find_hidden and caps:
        hidden, frag = _find_hidden(f, bunch, covered, med, cfg, yy, xx, caps)
        caps += hidden
    caps = _prune(caps)
    stages = {"footprint": footprint, "region": region, "body": body, "dist": dist, "first": first_pass,
              "more": more, "hidden": hidden, "median_r": med}
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
    return CapResult(name=name, photo=rgb, bunch=region, caps=caps, report=report, fragments=frag, stages=stages)


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


def _lens_area(d: np.ndarray, r1: float, r2: np.ndarray) -> np.ndarray:
    """Overlap area of circle(r1) with circles(r2) whose centres are ``d`` away."""
    d = np.asarray(d, dtype=np.float64)
    r2 = np.asarray(r2, dtype=np.float64)
    small = np.minimum(r1, r2)
    out = np.where(d >= r1 + r2, 0.0, np.pi * small * small)  # disjoint / one inside the other
    mid = (d < r1 + r2) & (d > np.abs(r1 - r2))
    dm = np.where(mid, d, 1.0)
    a1 = np.clip((dm * dm + r1 * r1 - r2 * r2) / (2 * dm * r1), -1, 1)
    a2 = np.clip((dm * dm + r2 * r2 - r1 * r1) / (2 * dm * r2), -1, 1)
    k = 0.5 * np.sqrt(np.maximum((-dm + r1 + r2) * (dm + r1 - r2) * (dm - r1 + r2) * (dm + r1 + r2), 0))
    lens = r1 * r1 * np.arccos(a1) + r2 * r2 * np.arccos(a2) - k
    return np.where(mid, lens, out)


def _prune(caps):
    """Drop a cap when (almost) all of it lies inside a bigger one — a second peak on the same cap.

    Caps genuinely tucked under another overlap by far less (they are kept)."""
    if len(caps) < 2:
        return caps
    arr = np.array([(c[0], c[1], c[2]) for c in caps], dtype=np.float64)
    order = np.argsort(-arr[:, 2])
    keep = np.ones(len(caps), dtype=bool)
    for i in order:
        if not keep[i]:
            continue
        x, y, r = arr[i]
        cand = np.nonzero(keep & (arr[:, 2] <= r) & (np.arange(len(caps)) != i))[0]
        if not len(cand):
            continue
        d = np.hypot(arr[cand, 0] - x, arr[cand, 1] - y)
        near = d < r + arr[cand, 2]
        cand, d = cand[near], d[near]
        if not len(cand):
            continue
        frac = _lens_area(d, r, arr[cand, 2]) / (np.pi * arr[cand, 2] ** 2)
        twin = (d < 0.45 * r) & (arr[cand, 2] > 0.7 * r)  # near-coincident, similar size: one cap seen twice
        keep[cand[(frac > 0.72) | twin]] = False
    return [c for c, k in zip(caps, keep) if k]


def _more_caps(f, footprint, covered, caps, med, cfg, yy, xx):
    """Second look for caps the brightness view missed, using other colour views.

    Every view is "brighter than its local surroundings" (an inverted view would
    show the same caps as dark blobs), computed on the blue channel, on
    min(R,G,B) and on the luminance with different offsets / window sizes.
    Candidates are circles from distance-transform peaks. A candidate is kept
    when it is not a duplicate, is not mostly inside an existing cap, and is
    brighter than the ring just outside it on most of its free outline.
    """
    H, W = footprint.shape
    ys, xs = np.nonzero(footprint)
    if len(ys) == 0:
        return []
    m = 14
    y0, y1, x0, x1 = max(0, ys.min() - m), min(H, ys.max() + m + 1), max(0, xs.min() - m), min(W, xs.max() + m + 1)
    sub = (slice(y0, y1), slice(x0, x1))
    fs, foot, cov = f[sub], footprint[sub], covered[sub].copy()
    ysub, xsub = yy[sub] - y0, xx[sub] - x0
    h, w = foot.shape
    mx, mn = fs.max(-1), fs.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1.0)
    lum = 0.299 * fs[..., 0] + 0.587 * fs[..., 1] + 0.114 * fs[..., 2]
    ok = foot & (sat < 0.42) & (fs[..., 2] < fs[..., 0] + 25) & (lum > 40)
    views = (("L", lum), ("B", fs[..., 2]), ("min", mn))
    raw = []
    for name, ch in views:
        for off, sig in ((3.0, 9.0), (8.0, 9.0), (15.0, 9.0), (6.0, 15.0), (0.0, 5.0)) if name == "L" else ((3.0, 9.0), (10.0, 9.0), (18.0, 9.0)):
            mask = ok & (ch > gaussian(ch, sig) - off)
            mask = gaussian(mask.astype(np.float32), 1.0) > 0.5
            if mask.any():
                raw += _peaks(mask, max(1.6, cfg.min_cap_px * 0.8))
    raw.sort(key=lambda c: -c[2])
    kx = np.array([c[0] - x0 for c in caps], dtype=np.float64)
    ky = np.array([c[1] - y0 for c in caps], dtype=np.float64)
    kr = np.array([c[2] for c in caps], dtype=np.float64)
    out = []
    for x, y, r in raw:
        if r > 2.2 * med or r < cfg.min_cap_px:
            continue
        if len(kx):
            d = np.hypot(kx - x, ky - y)
            ratio = r / kr
            if np.any((d < 0.6 * np.maximum(r, kr)) & (ratio > 0.65) & (ratio < 1.5)):
                continue
        a0, a1, b0, b1 = int(max(0, x - r)), int(min(w, x + r + 1)), int(max(0, y - r)), int(min(h, y + r + 1))
        disc = (xsub[b0:b1, a0:a1] - x) ** 2 + (ysub[b0:b1, a0:a1] - y) ** 2 <= r * r
        if disc.sum() < 6:
            continue
        overlap = float(cov[b0:b1, a0:a1][disc].mean())
        if overlap > 0.45:
            continue
        ang = np.linspace(0, 2 * math.pi, 24, endpoint=False)
        ix, iy = np.rint(x + 0.6 * r * np.cos(ang)).astype(int), np.rint(y + 0.6 * r * np.sin(ang)).astype(int)
        ox, oy = np.rint(x + 1.3 * r * np.cos(ang)).astype(int), np.rint(y + 1.3 * r * np.sin(ang)).astype(int)
        inb = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h) & (ox >= 0) & (ox < w) & (oy >= 0) & (oy < h)
        ix, iy, ox, oy = ix[inb], iy[inb], ox[inb], oy[inb]
        free = ~cov[oy, ox]
        if free.sum() < 6 or np.mean(lum[iy[free], ix[free]] > lum[oy[free], ox[free]] + 3) < 0.55:
            continue
        cls = "hidden" if overlap >= 0.15 else ("small" if r < cfg.small_below * med else ("large" if r > cfg.large_above * med else "medium"))
        out.append((x + x0, y + y0, r, cls))
        kx, ky, kr = np.append(kx, x), np.append(ky, y), np.append(kr, r)
        cov[b0:b1, a0:a1] |= disc
    return out


def _peaks(mask: np.ndarray, min_r: float):
    """Distance-transform peaks of a mask -> [(x, y, radius)]."""
    dist = _distance(mask, 60)
    smooth = gaussian(dist, 1.5)
    pad = np.pad(smooth, 2)
    pk = smooth >= min_r * 0.8
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dy or dx:
                pk &= smooth >= pad[2 + dy : 2 + dy + smooth.shape[0], 2 + dx : 2 + dx + smooth.shape[1]]
    ys, xs = np.nonzero(pk)
    return [(float(x), float(y), float(dist[y, x]) * 1.15 + 0.5) for x, y in zip(xs, ys) if dist[y, x] * 1.15 + 0.5 >= min_r]


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


# --------------------------------------------------------------------------- #
# "how it was counted" — one cropped picture per step
# --------------------------------------------------------------------------- #
STEP_KEYS = ("photo", "bunch", "gray", "channels", "contrast", "distance", "first", "views", "shadow", "final", "area")


def _heat(t: np.ndarray) -> np.ndarray:
    """0..1 -> dark blue / cyan / yellow / red colour ramp (uint8 RGB)."""
    stops = np.array([[10, 12, 60], [20, 90, 200], [30, 200, 190], [250, 230, 60], [240, 60, 30]], dtype=np.float32)
    t = np.clip(t, 0, 1) * (len(stops) - 1)
    i = np.minimum(t.astype(int), len(stops) - 2)
    fr = (t - i)[..., None]
    return (stops[i] * (1 - fr) + stops[i + 1] * fr).astype(np.uint8)


def _edge(mask: np.ndarray) -> np.ndarray:
    p = np.pad(mask, 1, constant_values=False)
    return mask & ~(p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:])


def _ring(im: Image.Image, caps, color=None, scale: float = 1.0, ox: int = 0, oy: int = 0, width: int = 2) -> None:
    d = ImageDraw.Draw(im)
    for x, y, r, cls in caps:
        x, y, r = (x - ox) * scale, (y - oy) * scale, r * scale
        d.ellipse([x - r, y - r, x + r, y + r], outline=color or CLASS_COLORS[cls], width=width)


def step_images(res: CapResult, width: int = 520) -> List[Tuple[str, Image.Image]]:
    """The counting technique, step by step: ``[(key, image)]`` in the order of STEP_KEYS.

    Every picture is cropped to the bunch (same crop, same size) so the steps
    can be compared side by side. Empty list when no bunch was found.
    """
    st = res.stages
    if not st or res.photo is None or not st["footprint"].any():
        return []
    photo = res.photo
    H, W = photo.shape[:2]
    ys, xs = np.nonzero(st["footprint"])
    m = 10
    y0, y1, x0, x1 = max(0, ys.min() - m), min(H, ys.max() + m + 1), max(0, xs.min() - m), min(W, xs.max() + m + 1)
    sc = min(1.0, width / float(x1 - x0))
    out_w, out_h = max(2, round((x1 - x0) * sc)), max(2, round((y1 - y0) * sc))
    foot = st["footprint"]

    def crop(a: np.ndarray) -> np.ndarray:
        return a[y0:y1, x0:x1]

    def to_img(a: np.ndarray) -> Image.Image:
        im = Image.fromarray(np.ascontiguousarray(a).astype(np.uint8))
        return im if im.size == (out_w, out_h) else im.resize((out_w, out_h), Image.LANCZOS)

    def dim(a: np.ndarray, k: float = 0.3) -> np.ndarray:
        return (a.astype(np.float32) * k).astype(np.uint8)

    f = photo.astype(np.float32)
    lum = 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]
    steps: List[Tuple[str, Image.Image]] = []

    # 1 the photo (cropped to the bunch)
    steps.append(("photo", to_img(crop(photo))))

    # 2 where the bunch is: footprint outlined, the rest dimmed
    b = np.where(foot[..., None], photo, dim(photo, 0.35))
    b[_edge(foot)] = (255, 214, 0)
    b[_edge(st["region"])] = (0, 230, 160)
    steps.append(("bunch", to_img(crop(b))))

    # 3 black & white + invert: caps become dark blobs on a light background
    inv = np.where(foot, 255.0 - lum, 235.0)
    steps.append(("gray", to_img(crop(np.stack([inv] * 3, -1)))))

    # 4 every colour band: R, G, B and the darkest of the three
    tiles = [f[..., 0], f[..., 1], f[..., 2], f.min(-1)]
    tw, th = out_w // 2, out_h // 2
    sheet = Image.new("RGB", (out_w, out_h), (20, 20, 24))
    dr = ImageDraw.Draw(sheet)
    for i, (ch, lab) in enumerate(zip(tiles, ("R", "G", "B", "min(R,G,B)"))):
        g = np.clip(np.where(foot, ch, 0), 0, 255)
        im = Image.fromarray(crop(np.stack([g] * 3, -1)).astype(np.uint8)).resize((tw, th), Image.LANCZOS)
        sheet.paste(im, ((i % 2) * tw, (i // 2) * th))
        dr.rectangle([(i % 2) * tw + 4, (i // 2) * th + 4, (i % 2) * tw + 12 + 7 * len(lab), (i // 2) * th + 20], fill=(0, 0, 0))
        dr.text(((i % 2) * tw + 8, (i // 2) * th + 6), lab, fill=(255, 255, 255))
    steps.append(("channels", sheet))

    # 5 caps = brighter than their surroundings (dark gaps between caps split them)
    body = st["body"]
    c = np.where(body[..., None], np.array([245, 245, 245], np.uint8), np.array([14, 16, 22], np.uint8))
    c = np.where(foot[..., None], c, dim(photo, 0.12))
    steps.append(("contrast", to_img(crop(c))))

    # 6 distance transform: the deeper inside a blob, the hotter; one peak per cap
    dist = st["dist"]
    heat = _heat(dist / max(1.0, float(np.percentile(dist[dist > 0], 99)) if (dist > 0).any() else 1.0))
    heat = np.where(body[..., None], heat, dim(photo, 0.15))
    im6 = to_img(crop(heat))
    d6 = ImageDraw.Draw(im6)
    for x, y, r, _ in st["first"]:
        px, py = (x - x0) * sc, (y - y0) * sc
        d6.ellipse([px - 2, py - 2, px + 2, py + 2], fill=(255, 255, 255))
    steps.append(("distance", im6))

    # 7 first pass: a circle per cap, coloured by size
    im7 = to_img(crop(dim(photo, 0.55)))
    _ring(im7, st["first"], scale=sc, ox=x0, oy=y0)
    steps.append(("first", im7))

    # 8 second look in other colour views: only the caps this found are bright
    im8 = to_img(crop(dim(photo, 0.5)))
    _ring(im8, st["first"], color=(150, 150, 150), scale=sc, ox=x0, oy=y0, width=1)
    _ring(im8, st["more"], color=(255, 0, 255), scale=sc, ox=x0, oy=y0, width=2)
    steps.append(("views", im8))

    # 9 shadows lifted: what is left (pale, not inside a full cap) are crescents of caps hidden underneath
    lifted = 255.0 * (lum / 255.0) ** 0.55
    lift = np.stack([lifted] * 3, -1)
    lift[res.fragments] = 0.45 * lift[res.fragments] + 0.55 * np.array(CLASS_COLORS["hidden"])
    im9 = to_img(crop(np.where(foot[..., None], lift, dim(lift, 0.3)).astype(np.uint8)))
    _ring(im9, st["hidden"], scale=sc, ox=x0, oy=y0)
    steps.append(("shadow", im9))

    # 10 the result
    im10 = to_img(crop(photo))
    _ring(im10, res.caps, scale=sc, ox=x0, oy=y0)
    steps.append(("final", im10))

    # 11 area share: every pixel coloured by the kind of cap covering it, stems / gaps grey
    yy, xx = np.mgrid[0:H, 0:W]
    canvas = dim(photo, 0.0)
    canvas[...] = (70, 70, 78)
    for cls in ("large", "medium", "small", "hidden"):  # smaller / hidden drawn last = on top
        mk = _discs([c for c in res.caps if c[3] == cls], yy, xx)
        canvas[mk] = CLASS_COLORS[cls]
    canvas = np.where(st["region"][..., None], canvas, dim(photo, 0.25))
    steps.append(("area", to_img(crop(canvas))))
    return steps
