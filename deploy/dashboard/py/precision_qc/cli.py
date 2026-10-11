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
import sys
from pathlib import Path
from typing import List

from .analyzer import QCConfig, analyze
from .batch import analyze_plates, overview_image, rank_key
from .render import report_image

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


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


def run_multi(files, cfg, out: Path, no_images: bool):
    """Each photo holds several dishes: split, analyse each, rank within the photo and overall."""
    rows = []
    for f in files:
        res = analyze_plates(f, cfg, name=f.name)
        if not no_images:
            overview_image(res).save(out / f"{f.stem}_overview.png")
        print(f"{f.name}: {res.summary['plates']} plate(s)  PASS {res.summary['pass']} / FAIL {res.summary['fail']}")
        for p in res.ranked:
            rep = p.analysis.report
            rep["photo"] = f.name
            rep["name"] = f"{f.stem}#{p.index}"
            rows.append(rep)
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="precision_qc", description="Fungal colony QC from petri-dish photos")
    ap.add_argument("inputs", nargs="+", help="image files or folders")
    ap.add_argument("-o", "--out", default="reports", help="output folder (default: reports)")
    ap.add_argument("-c", "--config", help="JSON file with QCConfig overrides")
    ap.add_argument("--set", action="append", metavar="KEY=VALUE", help="override one setting, e.g. --set min_score=70")
    ap.add_argument("--no-images", action="store_true", help="skip report PNGs (faster)")
    ap.add_argument("--multi", action="store_true",
                    help="each photo contains several dishes: split them, analyse each one and rank them")
    ap.add_argument("--strict", action="store_true", help="exit with code 1 if any image FAILs")
    args = ap.parse_args(argv)

    files = collect(args.inputs)
    if not files:
        print("No images found - nothing to do.", file=sys.stderr)
        return 0
    cfg = build_config(args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.multi:
        rows = run_multi(files, cfg, out, args.no_images)
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
        an = analyze(f, cfg, name=f.name)
        rep = an.report
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
