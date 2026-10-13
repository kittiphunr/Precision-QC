"""Batch command line:  python -m precision_qc samples/ -o reports/

Writes, per image, a report PNG + JSON, and for the batch summary.csv /
summary.json / summary.md. Inside GitHub Actions the markdown table is also
appended to the job summary ($GITHUB_STEP_SUMMARY).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from . import __version__
from .analyzer import QCConfig, analyze
from .batch import analyze_plates, overview_image, rank_key
from .caps import CapConfig, count_caps, overlay_image, step_images
from .render import report_image

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


class UsageLog:
    """Optional usage log (``--log-dir``): one JSON object per line appended to
    ``<dir>/usage-YYYYMMDD.jsonl`` in the same schema as the web app's local log
    (docs/LOGGING.md). Only numbers and metadata are written - never the image, its
    name or its path. A disabled log (no directory) does nothing, and a write error
    never breaks the analysis."""

    def __init__(self, directory=None, mode: str = "dish"):
        self.dir = Path(directory) if directory else None
        self.mode = mode
        self.session = uuid.uuid4().hex[:16]
        if self.dir:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
            except OSError as err:
                print(f"warning: cannot create log dir {self.dir}: {err}", file=sys.stderr)
                self.dir = None

    def log(self, event: str, **data) -> None:
        if not self.dir:
            return
        now = datetime.now(timezone.utc)
        rec = {"v": 1, "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "session": self.session, "event": event,
               "app": {"ui": "cli", "ver": __version__}, "mode": self.mode, **data,
               "env": {"python": platform.python_version(), "os": platform.system(), "ci": bool(os.environ.get("GITHUB_ACTIONS"))}}
        try:
            with open(self.dir / f"usage-{now:%Y%m%d}.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError as err:
            print(f"warning: cannot write usage log: {err}", file=sys.stderr)
            self.dir = None

    def attempt(self, fn, **extra):
        """Call ``fn()``; return ``(value, elapsed_ms)``. A failure is logged as analyze_error and re-raised."""
        t0 = time.perf_counter()
        try:
            value = fn()
        except Exception as err:
            self.log("analyze_error", source="cli", error=type(err).__name__, **extra)
            raise
        return value, round((time.perf_counter() - t0) * 1000)

    def done(self, f: Path, rep: dict, result: dict, ms: int, **extra) -> None:
        """Log one finished analysis (``rep`` is its JSON report)."""
        w, h = rep.get("image_size") or (None, None)
        self.log("analyze_done", source="cli", image={"w": w, "h": h, "bytes": f.stat().st_size},
                 params=_numeric(rep.get("config")), result=result, timing_ms={"analyze": ms}, **extra)


def _numeric(d) -> dict:
    return {k: v for k, v in (d or {}).items() if isinstance(v, (int, float, bool))}


def _dish_result(rep) -> dict:
    return {"verdict": rep["result"], "score": rep["score"], "grade": rep["grade"],
            "reasons": [x["code"] for x in rep["reasons"]], "growth": rep["metrics"]["growth"],
            "contamination": rep["contamination"]["contamination"], "agar": rep["contamination"]["agar"]}


def _caps_result(rep) -> dict:
    c = rep["counts"]
    return {"count": rep["total"], "small": c["small"], "medium": c["medium"], "large": c["large"], "hidden": c["hidden"],
            "bunch_area_pct": rep.get("bunch_area_pct"), "density": rep.get("caps_per_1000px2")}


def collect(paths: List[str]) -> List[Path]:
    files: List[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(f for f in p.rglob("*") if f.suffix.lower() in IMAGE_EXT)
        elif p.suffix.lower() in IMAGE_EXT:
            files.append(p)
    return files


def build_config(args) -> QCConfig:
    data = {}
    if args.config:
        data.update(json.loads(Path(args.config).read_text(encoding="utf-8")))
    for item in args.set or []:
        key, _, value = item.partition("=")
        data[key.strip()] = value.strip()
    return QCConfig.from_dict(data)


def markdown_table(rows) -> str:
    lines = [
        "| Image | Result | Score | Grade | Growth % | Whiteness % | Fluffiness % | Shape % | Agar % | Contam % | Reason |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        icon = "✅ PASS" if r["passed"] else "❌ FAIL"
        reason = ", ".join(x["code"] for x in r["reasons"]) or "Acceptable"
        m, c = r["metrics"], r["contamination"]
        lines.append(
            f"| {r['name']} | {icon} | {r['score']} | {r['grade']} | {m['growth']} | {m['whiteness']} | "
            f"{m['fluffiness']} | {m['shape']} | {c['agar']} | {c['contamination']} | {reason} |"
        )
    n_pass = sum(r["passed"] for r in rows)
    lines.append("")
    lines.append(f"**PASS {n_pass} / {len(rows)}**  ·  FAIL {len(rows) - n_pass}")
    return "\n".join(lines)


def run_multi(files, cfg, out: Path, no_images: bool, ulog: UsageLog = None):
    """Each photo holds several dishes: split, analyse each, rank within the photo and overall."""
    ulog = ulog or UsageLog()
    rows = []
    for f in files:
        res, ms = ulog.attempt(lambda: analyze_plates(f, cfg, name=f.name), batch=True)
        if not no_images:
            overview_image(res).save(out / f"{f.stem}_overview.png")
        print(f"{f.name}: {res.summary['plates']} plate(s)  PASS {res.summary['pass']} / FAIL {res.summary['fail']}")
        for p in res.ranked:
            rep = p.analysis.report
            rep["photo"] = f.name
            rep["name"] = f"{f.stem}#{p.index}"
            rows.append(rep)
            ulog.done(f, rep, _dish_result(rep), ms, batch={"plates": res.summary["plates"], "rank": p.rank})
            stem = f"{f.stem}_p{p.index}"
            (out / f"{stem}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
            if not no_images:
                report_image(p.analysis).save(out / f"{stem}_report.png")
            reason = ", ".join(x["code"] for x in rep["reasons"]) or "Acceptable"
            print(f"  rank {p.rank}  plate #{p.index}  {rep['result']:4s}  {rep['score']:5.1f}  {rep['grade']}  ({reason})")
    for i, rep in enumerate(sorted(rows, key=rank_key), start=1):
        rep["overall_rank"] = i
    return rows


def multi_table(rows) -> str:
    lines = [
        "| Overall | Photo | Plate | Rank in photo | Result | Score | Grade | Growth % | Whiteness % | Fluffiness % | Shape % | Contam % | Reason |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in sorted(rows, key=lambda r: r["overall_rank"]):
        icon = "✅ PASS" if r["passed"] else "❌ FAIL"
        reason = ", ".join(x["code"] for x in r["reasons"]) or "Acceptable"
        m, c = r["metrics"], r["contamination"]
        lines.append(f"| {r['overall_rank']} | {r['photo']} | #{r['plate']} | {r['rank']}/{r['plates_in_photo']} | {icon} | {r['score']} | "
                     f"{r['grade']} | {m['growth']} | {m['whiteness']} | {m['fluffiness']} | {m['shape']} | {c['contamination']} | {reason} |")
    n_pass = sum(r["passed"] for r in rows)
    lines += ["", f"**PASS {n_pass} / {len(rows)}**  ·  FAIL {len(rows) - n_pass}"]
    return "\n".join(lines)


def run_caps(files, args, out: Path, ulog: UsageLog = None) -> int:
    """Each photo is one bunch of mushrooms: count the caps by size."""
    data = {}
    for item in args.set or []:
        key, _, value = item.partition("=")
        data[key.strip()] = value.strip()
    cfg = CapConfig.from_dict(data)
    ulog = ulog or UsageLog(mode="caps")
    rows = []
    for f in files:
        res, ms = ulog.attempt(lambda: count_caps(f, cfg, name=f.name))
        rep = res.report
        ulog.done(f, rep, _caps_result(rep), ms)
        rows.append(rep)
        (out / f"{f.stem}_caps.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
        if not args.no_images:
            overlay_image(res).save(out / f"{f.stem}_caps.png")
        if args.steps:  # one cropped picture per step of the technique
            sdir = out / f"{f.stem}_steps"
            sdir.mkdir(exist_ok=True)
            for i, (key, im) in enumerate(step_images(res), start=1):
                im.save(sdir / f"{i:02d}_{key}.png")
        c = rep["counts"]
        print(f"{rep['total']:5d} caps  small {c['small']}  medium {c['medium']}  large {c['large']}  hidden {c['hidden']}  "
              f"visible-area {rep['area_percent']['visible']}%  {f.name}")
    with open(out / "caps_summary.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["image", "total", "small", "medium", "large", "small_pct", "medium_pct", "large_pct", "median_diameter_px",
                    "hidden", "area_small_pct", "area_medium_pct", "area_large_pct", "area_visible_pct", "area_hidden_pct", "area_gaps_pct"])
        for r in rows:
            c, p, a = r["counts"], r["percent"], r["area_percent"]
            w.writerow([r["name"], r["total"], c["small"], c["medium"], c["large"], p["small"], p["medium"], p["large"],
                        r["median_diameter_px"], c["hidden"], a["small"], a["medium"], a["large"], a["visible"], a["hidden"], a["gaps"]])
    lines = ["## 🍄 Precision QC — mushroom cap count", "", "| Image | Total | Small | Medium | Large | Hidden | Caps area % of bunch |", "|---|---|---|---|---|---|---|"]
    lines += [f"| {r['name']} | {r['total']} | {r['counts']['small']} | {r['counts']['medium']} | {r['counts']['large']} | {r['counts']['hidden']} | {r['area_percent']['visible']} |" for r in rows]
    md = "\n".join(lines) + "\n"
    (out / "caps_summary.md").write_text(md, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(md)
    print(f"\n{sum(r['total'] for r in rows)} caps in {len(rows)} photo(s)  ->  {out}/")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="precision_qc", description="Fungal colony QC from petri-dish photos")
    ap.add_argument("inputs", nargs="+", help="image files or folders")
    ap.add_argument("-o", "--out", default="reports", help="output folder (default: reports)")
    ap.add_argument("-c", "--config", help="JSON file with QCConfig overrides")
    ap.add_argument("--set", action="append", metavar="KEY=VALUE", help="override one setting, e.g. --set min_score=70")
    ap.add_argument("--no-images", action="store_true", help="skip report PNGs (faster)")
    ap.add_argument("--multi", action="store_true",
                    help="each photo contains several dishes: split them, analyse each one and rank them")
    ap.add_argument("--caps", action="store_true",
                    help="count the mushroom caps of a bunch (ช่อดอก): small / medium / large (use --set contrast=3 etc.)")
    ap.add_argument("--steps", action="store_true",
                    help="with --caps: also save the counting technique step by step (<image>_steps/NN_<step>.png)")
    ap.add_argument("--log-dir", metavar="DIR",
                    help="append a usage log (numbers and metadata only, no images) to DIR/usage-YYYYMMDD.jsonl "
                         "for later analysis - see docs/LOGGING.md")
    ap.add_argument("--strict", action="store_true", help="exit with code 1 if any image FAILs")
    args = ap.parse_args(argv)

    files = collect(args.inputs)
    if not files:
        print("No images found - nothing to do.", file=sys.stderr)
        return 0
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    mode = "caps" if args.caps else "dish"
    ulog = UsageLog(args.log_dir, mode)
    ulog.log("run_start", cli={"multi": args.multi, "images": len(files)})
    if args.caps:
        return run_caps(files, args, out, ulog)
    cfg = build_config(args)

    if args.multi:
        rows = run_multi(files, cfg, out, args.no_images, ulog)
        with open(out / "summary.csv", "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["overall_rank", "photo", "plate", "rank_in_photo", "plates_in_photo", "result", "score", "grade",
                        "growth", "whiteness", "fluffiness", "shape", "iou", "agar", "contamination", "reasons"])
            for r in sorted(rows, key=lambda r: r["overall_rank"]):
                m, c = r["metrics"], r["contamination"]
                w.writerow([r["overall_rank"], r["photo"], r["plate"], r["rank"], r["plates_in_photo"], r["result"], r["score"],
                            r["grade"], m["growth"], m["whiteness"], m["fluffiness"], m["shape"], m["iou"], c["agar"],
                            c["contamination"], "; ".join(x["code"] for x in r["reasons"])])
        (out / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        md = "## 🍄 Precision QC results (batch plates)\n\n" + multi_table(rows) + "\n"
        (out / "summary.md").write_text(md, encoding="utf-8")
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
                fh.write(md)
        n_fail = sum(not r["passed"] for r in rows)
        print(f"\n{len(rows) - n_fail} PASS / {n_fail} FAIL of {len(rows)} plates  ->  {out}/")
        return 1 if (args.strict and n_fail) else 0

    rows = []
    for f in files:
        an, ms = ulog.attempt(lambda: analyze(f, cfg, name=f.name))
        rep = an.report
        ulog.done(f, rep, _dish_result(rep), ms)
        rows.append(rep)
        (out / f"{f.stem}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
        if not args.no_images:
            report_image(an).save(out / f"{f.stem}_report.png")
        reason = ", ".join(x["code"] for x in rep["reasons"]) or "Acceptable"
        print(f"{rep['result']:4s}  {rep['score']:5.1f}  {rep['grade']}  {f.name}  ({reason})")

    with open(out / "summary.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["image", "result", "score", "grade", "growth", "whiteness", "fluffiness", "shape",
                    "iou", "agar", "contamination", "ink", "width_cm", "height_cm", "reasons"])
        for r in rows:
            m, c = r["metrics"], r["contamination"]
            w.writerow([r["name"], r["result"], r["score"], r["grade"], m["growth"], m["whiteness"], m["fluffiness"],
                        m["shape"], m["iou"], c["agar"], c["contamination"], c["ink"], r["colony"]["width_cm"],
                        r["colony"]["height_cm"], "; ".join(x["code"] for x in r["reasons"])])
    (out / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    md = "## 🍄 Precision QC results\n\n" + markdown_table(rows) + "\n"
    (out / "summary.md").write_text(md, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(md)

    n_fail = sum(not r["passed"] for r in rows)
    print(f"\n{len(rows) - n_fail} PASS / {n_fail} FAIL  ->  {out}/")
    return 1 if (args.strict and n_fail) else 0
