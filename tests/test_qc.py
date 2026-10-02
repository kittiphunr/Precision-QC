import json
from pathlib import Path

import numpy as np
import pytest

from precision_qc import QCConfig, analyze
from precision_qc.api import analyze_to_json
from precision_qc.cli import main as cli_main
from precision_qc.render import report_image

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def plate(colony_frac=0.97, agar=(205, 190, 150), bg=(25, 25, 30), patches=None, size=480, seed=0):
    """Synthetic petri dish: dark background, rim, agar, fluffy white colony."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    c, R = size / 2, size * 0.42
    d = np.hypot(xx - c, yy - c)
    img = np.empty((size, size, 3), np.float32)
    img[:] = bg
    img[d <= R] = agar
    img[(d > R - 4) & (d <= R)] = (170, 170, 170)  # plastic rim
    theta = np.arctan2(yy - c, xx - c)
    edge = colony_frac * R * 0.92 * (1 + 0.03 * np.sin(18 * theta))
    col = d <= edge
    shade = rng.normal(0, 14, (size, size))
    img[col] = (np.array([236, 236, 232]) + shade[col][:, None])
    for (px, py, pr, color) in patches or []:
        img[np.hypot(xx - px, yy - py) <= pr] = color
    return np.clip(img, 0, 255).astype(np.uint8)


def test_good_colony_passes():
    rep = analyze(plate()).report
    assert rep["result"] == "PASS", rep["reasons"]
    assert rep["metrics"]["growth"] > 60
    assert rep["metrics"]["iou"] > 0.85
    assert rep["contamination"]["contamination"] < 1


def test_small_colony_fails_low_growth():
    rep = analyze(plate(colony_frac=0.3)).report
    assert rep["result"] == "FAIL"
    assert "Low Growth" in [r["code"] for r in rep["reasons"]]


def test_green_mould_fails_contaminated():
    img = plate(patches=[(170, 180, 45, (60, 140, 60)), (300, 300, 35, (70, 150, 70))])
    rep = analyze(img).report
    assert rep["result"] == "FAIL"
    assert "Contaminated" in [r["code"] for r in rep["reasons"]]


def test_dark_green_mould_is_not_ignored_as_dark_area():
    rep = analyze(plate(patches=[(170, 180, 45, (30, 70, 35))])).report
    assert "Contaminated" in [r["code"] for r in rep["reasons"]]


def test_scale_uses_plate_size():
    rep = analyze(plate(colony_frac=1.0), QCConfig(plate_cm=9.0)).report
    # colony spans ~92% of the plate diameter
    assert 7.0 < rep["colony"]["width_cm"] < 9.0


@pytest.mark.parametrize(
    "name, expected, reason",
    [
        ("white_colony.jpg", "PASS", None),
        ("labeled_plate.jpg", "PASS", None),
        ("sporulation.jpg", "FAIL", "Contaminated"),
        ("black_king_oyster.jpg", "FAIL", "Agar Exposed"),
    ],
)
def test_reference_samples(name, expected, reason):
    rep = analyze(SAMPLES / name, name=name).report
    assert rep["result"] == expected, (rep["score"], rep["reasons"])
    if reason:
        assert reason in [r["code"] for r in rep["reasons"]]


def test_config_from_dict_ignores_unknown_and_casts():
    cfg = QCConfig.from_dict({"min_score": "70", "nope": 1, "work_size": "400", "dark_threshold": ""})
    assert cfg.min_score == 70.0 and cfg.work_size == 400 and cfg.dark_threshold is None


def test_api_json_roundtrip():
    data = (SAMPLES / "white_colony.jpg").read_bytes()
    out = json.loads(analyze_to_json(data, json.dumps({"min_score": 50}), "x.jpg"))
    assert out["result"] in ("PASS", "FAIL")
    assert len(out["panels"]) == 6
    assert out["panels"][0]["src"].startswith("data:image/jpeg;base64,")
    assert out["config"]["min_score"] == 50


def test_report_image_and_cli(tmp_path):
    an = analyze(SAMPLES / "sporulation.jpg", name="s")
    assert report_image(an).size[0] > 1000
    code = cli_main([str(SAMPLES), "-o", str(tmp_path), "--strict"])
    assert code == 1  # two reference samples fail
    assert (tmp_path / "summary.csv").exists()
    assert (tmp_path / "white_colony_report.png").exists()
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert len(summary) == 4


def test_index_arrays_are_intp_for_32bit_pyodide(monkeypatch):
    """Pyodide is wasm32: np.bincount rejects int64 indices there. Simulate that."""
    real_bincount = np.bincount

    def strict_bincount(x, *args, **kwargs):
        if np.asarray(x).dtype != np.intp:
            raise TypeError(f"Cannot cast array data from dtype('{np.asarray(x).dtype}') to intp")
        return real_bincount(x, *args, **kwargs)

    monkeypatch.setattr(np, "bincount", strict_bincount)
    monkeypatch.setattr(np, "intp", np.int32)  # wasm32 pointer size
    rep = analyze(plate()).report
    assert rep["result"] == "PASS"
