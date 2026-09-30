"""Precision QC — fungal colony (mycelium) quality inspection from petri-dish photos.

The engine depends only on numpy + Pillow so the exact same code runs:
  * on the command line / GitHub Actions  (``python -m precision_qc``)
  * in the browser on GitHub Pages via Pyodide (see ``web/``)
"""

from .analyzer import QCConfig, analyze

__all__ = ["QCConfig", "analyze"]
__version__ = "1.0.0"
