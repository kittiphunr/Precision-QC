import json
from pathlib import Path

import numpy as np
import pytest

from precision_qc import QCConfig, analyze
from precision_qc.api import analyze_to_json
from precision_qc.caps import CapConfig
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
    singles = sorted(str(f) for f in SAMPLES.glob("*.jpg"))  # the แบบชุด/ sub-folder holds multi-dish photos
    code = cli_main(singles + ["-o", str(tmp_path), "--strict"])
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


def test_batch_photo_splits_and_ranks(tmp_path):
    """Three synthetic dishes on one photo (one good, one contaminated, one sparse) are split and ranked."""
    from precision_qc.batch import analyze_plates

    tile = 420
    good, bad, weak = plate(size=tile), plate(size=tile, patches=[(210, 210, 80, (190, 40, 40))]), plate(colony_frac=0.3, size=tile)
    photo = np.full((tile, tile * 3 + 40, 3), (25, 25, 30), np.uint8)
    for i, im in enumerate((good, bad, weak)):
        photo[:, 20 + i * tile : 20 + (i + 1) * tile] = im
    res = analyze_plates(photo, name="synthetic")
    assert len(res.plates) == 3
    assert [p.index for p in res.plates] == [1, 2, 3]  # left to right
    assert sorted(p.rank for p in res.plates) == [1, 2, 3]
    by_idx = {p.index: p.analysis.report for p in res.plates}
    assert by_idx[1]["result"] == "PASS" and by_idx[1]["rank"] == 1
    assert by_idx[2]["result"] == "FAIL" and "Contaminated" in [r["code"] for r in by_idx[2]["reasons"]]
    assert by_idx[3]["result"] == "FAIL" and by_idx[3]["rank"] in (2, 3)
    assert res.summary["pass"] == 1 and res.summary["fail"] == 2


def test_batch_sample_photos_ignore_partial_dishes():
    folder = SAMPLES / "แบบชุด"
    if not folder.is_dir():
        pytest.skip("batch samples not present")
    from precision_qc.batch import analyze_plates

    expected = {"0dRKZpPx.jpg": 4, "6RCgPJjP.jpg": 3, "Cw7hhoex.jpg": 3, "RR3Uo8Cu.jpg": 8,
                "VU-aGjrC.jpg": 3, "Zn2Bsu_m.jpg": 3, "bU--ghfq.jpg": 2}
    for fname, n in expected.items():
        res = analyze_plates(folder / fname, name=fname)
        assert len(res.plates) == n, fname  # stacked / cut-off dishes at the border are not counted


def test_cli_multi(tmp_path):
    folder = SAMPLES / "แบบชุด"
    if not folder.is_dir():
        pytest.skip("batch samples not present")
    out = tmp_path / "out"
    assert cli_main([str(folder / "bU--ghfq.jpg"), "-o", str(out), "--multi", "--no-images"]) == 0
    rows = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert [r["overall_rank"] for r in rows] == [1, 2]
    assert "Overall" in (out / "summary.md").read_text(encoding="utf-8")


def test_api_plates_json_for_web():
    """The web UI calls analyze_plates_to_json: one JSON with summary, overview and ranked plates + panels."""
    from precision_qc.api import analyze_plates_to_json

    tile = 420
    photo = np.full((tile, tile * 2 + 30, 3), (25, 25, 30), np.uint8)
    photo[:, 15:15 + tile] = plate(size=tile)
    photo[:, 15 + tile:15 + 2 * tile] = plate(size=tile, patches=[(210, 210, 80, (190, 40, 40))])
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(photo).save(buf, "PNG")
    out = json.loads(analyze_plates_to_json(buf.getvalue(), json.dumps({"min_score": 55}), "two.png"))
    assert out["summary"]["plates"] == 2 and out["photo"].startswith("data:image") and out["photo_size"][0] > 0
    assert [p["rank"] for p in out["plates"]] == [1, 2]  # ranked order
    assert all(p["panels"] and p["plate"] in (1, 2) and p["source"] == "two.png" for p in out["plates"])
    assert out["plates"][0]["config"]["min_score"] == 55
    assert all(p["strips"]["top"].startswith("data:image") and p["strips"]["bottom"].startswith("data:image") for p in out["plates"])
    w, h = out["photo_size"]
    assert all(0 < p["circle"]["cx"] < w and 0 < p["circle"]["cy"] < h and p["circle"]["r"] > 20 for p in out["plates"])


def test_batch_runs_with_32bit_indices(monkeypatch):
    """Pyodide (wasm32) rejects int64 index arrays in np.bincount; the multi-dish code must use intp."""
    real = np.bincount

    def strict(x, *a, **k):
        if np.asarray(x).dtype != np.intp:
            raise TypeError("Cannot cast array data to intp")
        return real(x, *a, **k)

    monkeypatch.setattr(np, "bincount", strict)
    monkeypatch.setattr(np, "intp", np.int32)
    from precision_qc.batch import analyze_plates

    tile = 300
    photo = np.full((tile, tile * 2 + 30, 3), (25, 25, 30), np.uint8)
    photo[:, 15:15 + tile] = plate(size=tile)
    photo[:, 15 + tile:15 + 2 * tile] = plate(size=tile, seed=3)
    assert len(analyze_plates(photo).plates) == 2


def test_label_strips_unroll_rim_writing():
    """Dark writing near the rim shows up (dark, upright) in the matching strip and not in the other."""
    from precision_qc.batch import label_strips

    img = plate(size=420)
    img[60:75, 170:250] = (20, 20, 20)  # a pen stroke just inside the top rim
    st = label_strips(img, 210, 210, 210 * 0.8)  # the dish rim of plate() is at 0.84 * 210
    assert st["top"].width > 200 and st["top"].height > 80
    top, bottom = np.asarray(st["top"]), np.asarray(st["bottom"])
    assert (top < 80).sum() > 200 and (bottom < 80).sum() < 20


# --------------------------------------------------------------------------- #
# mushroom cap counter (ช่อดอก)
# --------------------------------------------------------------------------- #
CAPS_DIR = SAMPLES / "ช่อดอก"


def bunch_photo(n_big=20, n_small=60, seed=1, size=(520, 400)):
    """Synthetic bunch: cream discs (shaded like spheres) on a blue sleeve; returns (image, n_discs)."""
    rng = np.random.default_rng(seed)
    h, w = size
    img = np.empty((h, w, 3), np.float32)
    img[:] = (30, 70, 190)  # blue sleeve
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy, rad = w / 2, h / 2, min(h, w) * 0.42
    placed = []
    for r, count in ((19, n_big), (10, n_small)):
        tries = 0
        while sum(1 for p in placed if p[2] == r) < count and tries < 4000:
            tries += 1
            a, d = rng.uniform(0, 2 * np.pi), rad * np.sqrt(rng.uniform(0, 1)) * 0.85
            x, y = cx + d * np.cos(a), cy + d * np.sin(a)
            if all(np.hypot(x - px, y - py) > r + pr + 2 for px, py, pr in placed):
                placed.append((x, y, r))
    for x, y, r in placed:
        dd = np.hypot(xx - x, yy - y)
        m = dd <= r
        shade = 1.0 - 0.18 * (dd[m] / r) ** 2
        img[m] = np.array([238, 230, 210]) * shade[:, None]
    return np.clip(img, 0, 255).astype(np.uint8), len(placed)


def test_caps_counts_synthetic_bunch_by_size():
    from precision_qc.caps import count_caps

    img, n = bunch_photo()
    res = count_caps(img)
    assert abs(res.report["total"] - n) <= 0.15 * n
    c = res.report["counts"]
    assert sum(c.values()) == res.report["total"]
    assert 0 < c["large"] < res.report["total"]  # the big discs are told apart from the small ones


def test_caps_ignores_blue_sleeve_only_photo():
    from precision_qc.caps import count_caps

    blue = np.full((300, 300, 3), (30, 70, 190), np.uint8)
    assert count_caps(blue).report["total"] == 0


@pytest.mark.skipif(not CAPS_DIR.is_dir(), reason="no bunch samples")
def test_caps_sample_photos_give_plausible_counts():
    from precision_qc.caps import count_caps

    for name in ("8MV9U7gX.jpg", "AElY1DQU.jpg", "zfxmWT86.jpg"):
        rep = count_caps(CAPS_DIR / name).report
        assert 250 <= rep["total"] <= 800, (name, rep["total"])
        assert min(rep["counts"].values()) > 20, (name, rep["counts"])


def test_caps_api_and_cli(tmp_path):
    from precision_qc.api import count_caps_to_json, default_caps_config_json
    from PIL import Image

    img, _ = bunch_photo()
    f = tmp_path / "bunch.png"
    Image.fromarray(img).save(f)
    out = json.loads(count_caps_to_json(f.read_bytes(), json.dumps({"contrast": 3}), "bunch.png"))
    assert out["total"] == len(out["caps"]) and out["overlay"].startswith("data:image/")
    assert "contrast" in json.loads(default_caps_config_json())
    assert cli_main([str(f), "--caps", "-o", str(tmp_path / "out")]) == 0
    assert (tmp_path / "out" / "caps_summary.csv").is_file() and (tmp_path / "out" / "bunch_caps.png").is_file()


def test_caps_recovers_cap_hidden_under_another_and_reports_area_share():
    from precision_qc.caps import count_caps

    img, _ = bunch_photo(n_big=14, n_small=0, seed=3)
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    base = count_caps(img).report
    # a cream cap tucked under the biggest visible one: only a crescent peeks out
    probe = count_caps(img)
    x, y, r, _ = max(probe.caps, key=lambda c: c[2])
    s = w / probe.photo.shape[1]  # work size -> this image
    x, y, r = x * s, y * s, r * s
    for (hx, hy, hr, on_top) in ((x + 0.95 * r, y, 0.8 * r, False),):
        d = np.hypot(xx - hx, yy - hy)
        img[d <= hr] = (225, 215, 195)
        top = np.hypot(xx - x, yy - y) <= r
        img[top] = (238, 230, 210)
    rep = count_caps(img).report
    assert rep["counts"]["hidden"] >= 1
    assert rep["total"] > base["total"]
    a = rep["area_percent"]
    assert 0 < a["visible"] <= 100 and 0 <= a["hidden"] < 20
    assert abs(a["visible"] + a["hidden"] + a["gaps"] - 100) < 0.5
    off = count_caps(img, CapConfig(find_hidden=0, multi_view=0)).report
    assert off["counts"]["hidden"] == 0


def test_caps_multi_view_never_loses_caps_and_prune_removes_twins():
    from precision_qc.caps import _prune, count_caps

    img, _ = bunch_photo(n_big=20, n_small=60, seed=5)
    on = count_caps(img, CapConfig(multi_view=1)).report
    off = count_caps(img, CapConfig(multi_view=0)).report
    assert on["total"] >= off["total"] - 2
    caps = [(100.0, 100.0, 20.0, "large"), (101.0, 100.0, 19.0, "large"), (110.0, 100.0, 5.0, "small"), (150.0, 100.0, 20.0, "large")]
    kept = _prune(caps)
    assert len(kept) == 2 and {round(c[0]) for c in kept} == {100, 150}  # the twin and the cap sitting inside it are gone


def test_caps_steps_one_cropped_picture_per_step(tmp_path):
    from PIL import Image
    from precision_qc.api import count_caps_bytes
    from precision_qc.caps import STEP_KEYS, count_caps, step_images

    img, _ = bunch_photo(n_big=20, n_small=60, seed=2)
    res = count_caps(img)
    steps = step_images(res)
    assert [k for k, _ in steps] == list(STEP_KEYS)
    assert len({im.size for _, im in steps}) == 1  # same crop, same size: steps compare side by side
    w, h = steps[0][1].size
    assert w <= 520 and w < res.photo.shape[1] and h < res.photo.shape[0]  # cropped to the bunch, not the whole photo
    assert step_images(count_caps(np.full((200, 200, 3), (30, 70, 190), np.uint8))) == []  # no bunch -> no steps

    out = count_caps_bytes(_png_bytes(img), {}, "b.png")
    assert [s["key"] for s in out["steps"]] == list(STEP_KEYS) and out["steps"][0]["src"].startswith("data:image/")
    assert count_caps_bytes(_png_bytes(img), {}, "b.png", steps=False)["steps"] == []

    f = tmp_path / "bunch.png"
    f.write_bytes(_png_bytes(img))
    assert cli_main([str(f), "--caps", "--steps", "-o", str(tmp_path / "out")]) == 0
    files = sorted(p.name for p in (tmp_path / "out" / "bunch_steps").iterdir())
    assert files[0] == "01_photo.png" and len(files) == len(STEP_KEYS)


def _png_bytes(arr):
    import io
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def _read_log(directory):
    files = sorted(Path(directory).glob("usage-*.jsonl"))
    assert len(files) == 1 and files[0].name.startswith("usage-")
    return [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]


def test_cli_log_dir_records_numbers_only_and_appends(tmp_path):
    img = SAMPLES / "white_colony.jpg"
    logs = tmp_path / "logs"
    for _ in range(2):  # a second run appends to the same day file
        assert cli_main([str(img), "-o", str(tmp_path / "out"), "--no-images", "--log-dir", str(logs)]) == 0
    ev = _read_log(logs)
    assert [e["event"] for e in ev] == ["run_start", "analyze_start", "analyze_done"] * 2
    assert ev[1]["image"]["bytes"] == img.stat().st_size and ev[1]["source"] == "cli"
    done = ev[2]
    assert done["v"] == 1 and done["app"]["ui"] == "cli" and done["source"] == "cli" and done["mode"] == "dish"
    assert done["result"]["verdict"] == "PASS" and done["result"]["score"] > 60
    assert done["params"]["min_score"] == 60 and done["image"]["bytes"] == img.stat().st_size
    assert done["timing_ms"]["analyze"] >= 0 and ev[0]["session"] != ev[3]["session"]
    raw = (Path(logs) / next(logs.iterdir()).name).read_text(encoding="utf-8")
    assert "white_colony" not in raw and str(tmp_path) not in raw  # no file name or path


def test_cli_log_dir_caps_and_multi(tmp_path):
    from PIL import Image

    img, _ = bunch_photo()
    f = tmp_path / "bunch.png"
    Image.fromarray(img).save(f)
    assert cli_main([str(f), "--caps", "-o", str(tmp_path / "o1"), "--no-images", "--log-dir", str(tmp_path / "l1")]) == 0
    done = [e for e in _read_log(tmp_path / "l1") if e["event"] == "analyze_done"][0]
    assert done["mode"] == "caps" and done["result"]["count"] > 0 and "contrast" in done["params"]
    folder = SAMPLES / "แบบชุด"
    if folder.is_dir():
        assert cli_main([str(folder / "bU--ghfq.jpg"), "-o", str(tmp_path / "o2"), "--multi", "--no-images", "--log-dir", str(tmp_path / "l2")]) == 0
        plates = [e for e in _read_log(tmp_path / "l2") if e["event"] == "analyze_done"]
        assert len(plates) == 2 and plates[0]["batch"]["plates"] == 2


def test_cli_without_log_dir_writes_no_log_and_a_bad_dir_never_breaks_the_run(tmp_path, capsys):
    img = str(SAMPLES / "white_colony.jpg")
    assert cli_main([img, "-o", str(tmp_path / "out"), "--no-images"]) == 0
    assert not list(tmp_path.rglob("usage-*.jsonl"))
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert cli_main([img, "-o", str(tmp_path / "out2"), "--no-images", "--log-dir", str(blocker / "sub")]) == 0
    assert "warning" in capsys.readouterr().err


def test_cli_log_dir_records_errors_then_reraises(tmp_path):
    bad = tmp_path / "broken.png"
    bad.write_bytes(b"not an image")
    with pytest.raises(Exception):
        cli_main([str(bad), "-o", str(tmp_path / "out"), "--log-dir", str(tmp_path / "logs")])
    ev = _read_log(tmp_path / "logs")
    assert [e["event"] for e in ev[-2:]] == ["analyze_start", "analyze_error"]
    assert ev[-1]["event"] == "analyze_error" and "broken" not in json.dumps(ev[-1]) and str(tmp_path) not in json.dumps(ev[-1])
