"""Static checks for the web editions: translations stay complete, the Dashboard's
About/credits dialog is wired to real keys, and the credits match THIRD-PARTY-NOTICES.md."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
I18N = (ROOT / "web" / "i18n.js").read_text(encoding="utf-8")


def keys_by_lang():
    out = {}
    for lang, body in re.findall(r"(?ms)^  (th|en|zh): \{\n(.*?)^  \},?\n", I18N):
        # a key starts a line, or follows a comma when several share one line ("r.param": ..., "r.result": ...)
        out[lang] = set(re.findall(r'(?:^    |,\s)"([^"]+)":', body, re.M))
    return out


def test_all_languages_have_the_same_keys():
    k = keys_by_lang()
    assert set(k) == {"th", "en", "zh"}
    assert k["th"] == k["en"] == k["zh"]


def test_edition_copies_of_shared_files_are_in_sync():
    for name in ("app.js", "common.js", "caps.js", "i18n.js"):
        assert (ROOT / "web-dashboard" / name).read_bytes() == (ROOT / "web" / name).read_bytes(), name


def test_pages_use_only_defined_translation_keys():
    for edition in ("web", "web-dashboard"):
        for page in ("index.html", "caps.html"):
            html = (ROOT / edition / page).read_text(encoding="utf-8")
            used = set(re.findall(r'data-i18n(?:-aria|-ph|-title)?="([^"]+)"', html))
            assert used and used <= keys_by_lang()["th"], (edition, page, sorted(used - keys_by_lang()["th"]))


def test_each_edition_has_two_pages_that_link_to_each_other_and_load_the_right_scripts():
    for edition in ("web", "web-dashboard"):
        idx = (ROOT / edition / "index.html").read_text(encoding="utf-8")
        caps = (ROOT / edition / "caps.html").read_text(encoding="utf-8")
        assert 'href="caps.html"' in idx and 'href="index.html"' in caps
        order = lambda html, files: [html.index(f'<script src="{f}"') for f in files]
        assert order(idx, ["i18n.js", "common.js", "app.js"]) == sorted(order(idx, ["i18n.js", "common.js", "app.js"]))
        assert order(caps, ["i18n.js", "common.js", "caps.js"]) == sorted(order(caps, ["i18n.js", "common.js", "caps.js"]))
        assert 'id="caps-root"' in caps and "<!--protect-->" in caps and "<!--protect-->" in idx
        assert "app.js" not in caps and "caps.js" not in idx
        import re as _re
        nav = lambda html: _re.findall(r'<nav class="sb-cap sb-nav".*?</nav>', html, _re.S)
        if nav(idx) and nav(caps):  # Dashboard edition: both functions get the same 5-entry menu
            n = lambda html: len(_re.findall(r"<a href=", nav(html)[0]))
            assert n(idx) == n(caps) == 5


def test_dashboard_credits_are_translated_and_listed_in_notices():
    js = (ROOT / "web-dashboard" / "ui-dash.js").read_text(encoding="utf-8")
    block = js[js.index("const CREDITS = ["):js.index("];", js.index("const CREDITS = ["))]
    rows = re.findall(r'\["([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\]', block)
    assert len(rows) >= 10
    keys = keys_by_lang()["th"]
    notices = (ROOT / "THIRD-PARTY-NOTICES.md").read_text(encoding="utf-8")
    for name, url, lic, use in rows:
        assert url.startswith("https://")
        assert use in keys, use
        if lic.startswith("credit."):
            assert lic in keys, lic
        assert url in notices, f"{name}: {url} missing from THIRD-PARTY-NOTICES.md"


def test_dashboard_assets_exist():
    for f in ("img/mcu-logo.png", "img/developer.jpg", "ui-dash.js"):
        assert (ROOT / "web-dashboard" / f).is_file(), f


def test_numpad_is_wired_and_translated():
    js = (ROOT / "web" / "common.js").read_text(encoding="utf-8")
    assert "function initNumpad()" in js
    for page in ("app.js", "caps.js"):
        assert "initNumpad();" in (ROOT / "web" / page).read_text(encoding="utf-8"), page
    used = set(re.findall(r'\bt\("(np\.[a-z]+)"', js))
    assert used == {"np.ok", "np.cancel", "np.range"}
    assert used <= keys_by_lang()["th"]


def test_caps_settings_labels_have_hints():
    js = (ROOT / "web" / "caps.js").read_text(encoding="utf-8")
    keys = keys_by_lang()["th"]
    fields = re.findall(r'data-i18n="(caps\.f\.[a-z_]+)"', js)
    assert len(fields) >= 6
    for k in fields:
        assert k in keys and f"{k}.h" in keys, k


def test_every_counting_step_has_a_translated_title_and_description():
    from precision_qc.caps import STEP_KEYS

    keys = keys_by_lang()
    for lang, ks in keys.items():
        for step in STEP_KEYS:
            assert f"caps.step.{step}" in ks and f"caps.step.{step}.d" in ks, (lang, step)


def test_every_translation_key_used_by_the_cap_page_exists_in_all_languages():
    js = (ROOT / "web" / "caps.js").read_text(encoding="utf-8") + (ROOT / "web" / "common.js").read_text(encoding="utf-8")
    used = set(re.findall(r'\b(?:L|t)\("([a-zA-Z][\w]*\.[\w.]*)"', js))
    assert len(used) > 40  # the page + the PDF report
    for lang, ks in keys_by_lang().items():
        missing = sorted(k for k in used if k not in ks)
        assert not missing, (lang, missing)
    # keys built from a variable: caps.<size> and r.cap.* used by the report
    for lang, ks in keys_by_lang().items():
        assert {"caps.small", "caps.medium", "caps.large", "caps.hidden"} <= ks, lang


def test_pdf_engine_is_shared_and_both_pages_can_make_reports():
    common = (ROOT / "web" / "common.js").read_text(encoding="utf-8")
    assert "async function makePdf(" in common and "html2canvas" in common
    assert "makePdf(" in (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    caps = (ROOT / "web" / "caps.js").read_text(encoding="utf-8")
    assert "makePdf(" in caps and "function capsReportPages(" in caps
    for edition in ("web", "web-dashboard"):
        assert 'id="busy"' in (ROOT / edition / "caps.html").read_text(encoding="utf-8")  # makePdf shows it


def test_readme_images_exist_and_none_is_unused():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    used = set(re.findall(r"\]\((docs/img/[^)]+)\)", readme))
    assert len(used) >= 10
    on_disk = {f"docs/img/{p.name}" for p in (ROOT / "docs" / "img").glob("*.jpg")}
    assert used == on_disk, (sorted(used - on_disk), sorted(on_disk - used))
    assert sum(p.stat().st_size for p in (ROOT / "docs" / "img").iterdir()) < 5_000_000  # keeps the repo light


def test_camera_code_is_shared_and_the_cap_page_has_the_camera_ui():
    common = (ROOT / "web" / "common.js").read_text(encoding="utf-8")
    assert "function initCamera(onCapture)" in common and "onCapture(new File(" in common
    assert "initCamera((file) => runFiles([file]))" in (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    caps = (ROOT / "web" / "caps.js").read_text(encoding="utf-8")
    assert "initCamera((file) => runCaps([file]))" in caps
    for ident in ("cam-toggle", "cam-panel", "cam-video", "cam-shot", "cam-close", "cam-canvas", "cam-select"):
        assert f'id="{ident}"' in caps, ident
    assert "function initCamera" not in (ROOT / "web" / "app.js").read_text(encoding="utf-8")  # no second copy


def test_every_translation_key_in_the_injected_cap_page_markup_exists():
    caps = (ROOT / "web" / "caps.js").read_text(encoding="utf-8")
    used = set(re.findall(r'data-i18n(?:-ph|-aria|-title)?="([^"]+)"', caps))
    assert {"cam.open", "cam.capture", "cam.close", "caps.camHint"} <= used
    for lang, ks in keys_by_lang().items():
        assert not sorted(used - ks), (lang, sorted(used - ks))


def test_cap_page_input_area_matches_the_dish_page_style():
    """Same drop zone / camera button / sample row structure (and CSS classes) as index.html."""
    caps = (ROOT / "web" / "caps.js").read_text(encoding="utf-8")
    for edition in ("web", "web-dashboard"):
        idx = (ROOT / edition / "index.html").read_text(encoding="utf-8")
        for cls in ('class="drop', 'class="drop-icon"', 'class="camera"', 'class="samples"', 'class="chips"'):
            assert cls in idx and cls in caps, (edition, cls)
    assert 'id="caps-drop"' in caps and 'type="file" accept="image/*" multiple' in caps
    for ev in ("dragenter", "dragover", "dragleave", "drop"):
        assert f'"{ev}"' in caps, ev
    assert "caps.pick" not in caps


def test_result_card_layout_uses_its_own_width_and_has_all_parts():
    caps = (ROOT / "web" / "caps.js").read_text(encoding="utf-8")
    for part in ("caps-head", "caps-photo", "caps-kpis", "caps-table", "caps-stack", "caps-legend", "caps-note", "caps-steps"):
        assert part in caps, part
    assert "container-type:inline-size" in caps and "@container" in caps  # table / KPI layout follows the card width, not the screen
    keys = keys_by_lang()
    for lang, ks in keys.items():
        assert {"caps.th.type", "caps.th.count", "caps.th.share", "caps.th.area", "caps.total", "caps.areaVisibleShort", "caps.compo", "caps.zoomHint"} <= ks, lang
        assert "caps.meta" not in ks, lang  # replaced by the KPI tiles
