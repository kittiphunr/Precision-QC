"""JSON bridge used by the web UI (Pyodide) and anything else that wants
one call: image bytes in -> report + panel images out."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from .analyzer import QCConfig, analyze
from .batch import analyze_plates, overview_image
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
        rep["panels"] = [{"key": k, "title": PANEL_TITLES[k], "src": to_data_url(im)} for k, im in render_panels(p.analysis).items()]
        plates.append(rep)
    return {"summary": res.summary, "overview": to_data_url(overview_image(res)), "plates": plates}


def analyze_plates_to_json(data: Any, config_json: str = "{}", name: str = "photo") -> str:
    return json.dumps(analyze_plates_bytes(data, json.loads(config_json or "{}"), name))
