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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="precision_qc", description="Fungal colony QC from petri-dish photos")
    ap.add_argument("inputs", nargs="+", help="image files or folders")
    ap.add_argument("-o", "--out", default="reports", help="output folder (default: reports)")
    ap.add_argument("-c", "--config", help="JSON file with QCConfig overrides")
    ap.add_argument("--set", action="append", metavar="KEY=VALUE", help="override one setting, e.g. --set min_score=70")
    ap.add_argument("--no-images", action="store_true", help="skip report PNGs (faster)")
    ap.add_argument("--strict", action="store_true", help="exit with code 1 if any image FAILs")
    args = ap.parse_args(argv)

    files = collect(args.inputs)
    if not files:
        print("No images found - nothing to do.", file=sys.stderr)
        return 0
    cfg = build_config(args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

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
