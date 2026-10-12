"""Static checks for the web editions: translations stay complete, the Dashboard's
About/credits dialog is wired to real keys, and the credits match THIRD-PARTY-NOTICES.md."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
I18N = (ROOT / "web" / "i18n.js").read_text(encoding="utf-8")


def keys_by_lang():
    out = {}
    for lang, body in re.findall(r"(?ms)^  (th|en|zh): \{\n(.*?)^  \},?\n", I18N):
        out[lang] = set(re.findall(r'^    "([^"]+)":', body, re.M))
    return out


def test_all_languages_have_the_same_keys():
    k = keys_by_lang()
    assert set(k) == {"th", "en", "zh"}
    assert k["th"] == k["en"] == k["zh"]


def test_edition_copies_of_shared_files_are_in_sync():
    for name in ("app.js", "i18n.js"):
        assert (ROOT / "web-dashboard" / name).read_bytes() == (ROOT / "web" / name).read_bytes(), name


def test_dashboard_page_uses_only_defined_translation_keys():
    html = (ROOT / "web-dashboard" / "index.html").read_text(encoding="utf-8")
    used = set(re.findall(r'data-i18n(?:-aria|-ph)?="([^"]+)"', html))
    assert used and used <= keys_by_lang()["th"], sorted(used - keys_by_lang()["th"])


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
    js = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    assert "function initNumpad()" in js and "initNumpad();" in js
    used = set(re.findall(r'\bt\("(np\.[a-z]+)"', js))
    assert used == {"np.ok", "np.cancel", "np.range"}
    assert used <= keys_by_lang()["th"]


def test_caps_settings_labels_have_hints():
    js = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    keys = keys_by_lang()["th"]
    fields = re.findall(r'data-i18n="(caps\.f\.[a-z_]+)"', js)
    assert len(fields) >= 6
    for k in fields:
        assert k in keys and f"{k}.h" in keys, k
