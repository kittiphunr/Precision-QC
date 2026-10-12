"""JSON bridge used by the web UI (Pyodide) and anything else that wants
one call: image bytes in -> report + panel images out."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from PIL import Image

from .analyzer import QCConfig, analyze
from .batch import analyze_plates, label_strips
from .render import PANEL_TITLES, render_panels, to_data_url


def _as_bytes(data: Any) -> bytes:
    if hasattr(data, "to_py"):  # Pyodide JsProxy (Uint8Array)
        data = data.to_py()
    return bytes(data)


def analyze_bytes(data: Any, config: Optional[Dict[str, Any]] = None, name: str = "sample") -> Dict[str, Any]:
    an = analyze(_as_bytes(data), QCConfig.from_dict(config), name=name)
    panels = render_panels(an)
    out = dict(an.report)
    out["panels"] = [{"key": k, "title": PANEL_TITLES[k], "src": to_data_url(im)} for k, im in panels.items()]
    return out


def analyze_to_json(data: Any, config_json: str = "{}", name: str = "sample") -> str:
    """Entry point called from JavaScript."""
    return json.dumps(analyze_bytes(data, json.loads(config_json or "{}"), name))


def default_config_json() -> str:
    return json.dumps(QCConfig().to_dict())


def analyze_plates_bytes(data: Any, config: Optional[Dict[str, Any]] = None, name: str = "photo") -> Dict[str, Any]:
    """One photo with several dishes -> per-plate reports (with rank) + an annotated overview."""
    res = analyze_plates(_as_bytes(data), QCConfig.from_dict(config), name=name)
    plates = []
    for p in res.ranked:
        rep = dict(p.analysis.report)
        rep["strips"] = {k: to_data_url(im) for k, im in label_strips(res.photo, *p.center, p.radius).items()}
        rep["circle"] = {"cx": round(p.center[0], 1), "cy": round(p.center[1], 1), "r": round(p.radius, 1)}  # photo pixels
        rep["panels"] = [{"key": k, "title": PANEL_TITLES[k], "src": to_data_url(im)} for k, im in render_panels(p.analysis).items()]
        plates.append(rep)
    # the plain photo + circles: the web UI draws the labelled overview itself so the user can type a dish ID
    h, w = res.photo.shape[:2]
    return {"summary": res.summary, "photo": to_data_url(Image.fromarray(res.photo)), "photo_size": [w, h], "plates": plates}


def analyze_plates_to_json(data: Any, config_json: str = "{}", name: str = "photo") -> str:
    return json.dumps(analyze_plates_bytes(data, json.loads(config_json or "{}"), name))
