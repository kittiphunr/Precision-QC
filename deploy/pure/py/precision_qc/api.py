"""JSON bridge used by the web UI (Pyodide) and anything else that wants
one call: image bytes in -> report + panel images out."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from .analyzer import QCConfig, analyze
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
