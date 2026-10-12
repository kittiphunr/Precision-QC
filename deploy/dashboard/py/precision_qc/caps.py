"""Mushroom-cap counting for a bunch of enoki ("ช่อดอก").

Photograph a bunch from above and count the round caps (heads):

1. the bunch is the biggest pale, non-blue blob in the photo (blue sleeve /
   background and neighbouring bunches cut by the border are ignored),
2. cap bodies are the pixels brighter than their surroundings — the darker
   gaps between touching caps split them apart,
3. a distance transform gives one centre + radius per cap,
4. each cap is classed small / medium / large relative to the median cap of
   that bunch (green / blue / red in the overlay).

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
CLASS_COLORS = {"small": (80, 220, 90), "medium": (40, 60, 230), "large": (235, 50, 40)}


@dataclass
class CapConfig:
    work_size: int = 1100  # longest side (px) the photo is analysed at
    contrast: float = 3.0  # how much brighter than its surroundings a cap must be (higher = stricter)
    min_cap_px: float = 2.0  # smallest cap radius kept (px at work size)
    small_below: float = 0.85  # radius < small_below x median  -> small
    large_above: float = 1.20  # radius > large_above x median  -> large

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


def find_bunch(rgb: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Returns ``(pale, bunch)`` boolean masks.

    ``pale`` = cream / white pixels (not the blue sleeve), ``bunch`` = the
    biggest blob of them that is not cut off by the photo border (a blob that
    touches the border still counts when nothing else is whole).
    """
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    pale = (f.max(-1) > 120) & (b < r + 10) & (r > g - 25)
    H, W = pale.shape
    s = 4
    small = gaussian(pale[: H // s * s, : W // s * s].reshape(H // s, s, W // s, s).mean((1, 3)), 3.0) > 0.3
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
        return pale, np.zeros_like(pale)
    big = np.kron((lab == best).astype(np.uint8), np.ones((s, s), np.uint8)).astype(bool)
    bunch = np.zeros_like(pale)
    bunch[: big.shape[0], : big.shape[1]] = big
    return pale, _dilate(bunch, 8) & pale


def count_caps(src: Any, config: Optional[CapConfig] = None, name: str = "bunch") -> CapResult:
    """Count the mushroom caps of the bunch in ``src`` (path / bytes / PIL / ndarray)."""
    cfg = config or CapConfig()
    rgb = load_image(src, cfg.work_size)
    pale, bunch = find_bunch(rgb)
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
    counts = {k: sum(1 for c in caps if c[3] == k) for k in SIZE_CLASSES}
    total = len(caps)
    bunch_px = int(bunch.sum())
    H, W = rgb.shape[:2]
    report = {
        "name": name,
        "total": total,
        "counts": counts,
        "percent": {k: round(100.0 * v / total, 1) if total else 0.0 for k, v in counts.items()},
        "median_diameter_px": round(2 * med, 1),
        "bunch_area_pct": round(100.0 * bunch_px / (H * W), 1),
        "caps_per_1000px2": round(1000.0 * total / bunch_px, 2) if bunch_px else 0.0,
        "image_size": [W, H],
        "config": cfg.to_dict(),
    }
    return CapResult(name=name, photo=rgb, bunch=bunch, caps=caps, report=report)


def overlay_image(res: CapResult, width: int = 0) -> Image.Image:
    """The photo with a green / blue / red circle on every counted cap and a count legend."""
    im = Image.fromarray(res.photo)
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
