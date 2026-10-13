"""The PHP usage-log receiver (hosting/log-endpoint/log.php): accepts only well-formed,
same-origin, whitelisted events and writes nothing else. Skipped when php is not installed."""
import json
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("php") is None, reason="php not installed")


@pytest.fixture()
def server(tmp_path):
    shutil.copytree(ROOT / "hosting" / "log-endpoint", tmp_path / "ep", ignore=shutil.ignore_patterns("data"))
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen(["php", "-S", f"127.0.0.1:{port}", "-t", str(tmp_path / "ep")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    yield f"http://127.0.0.1:{port}/log.php", tmp_path / "ep" / "data"
    proc.terminate()
    proc.wait()


def post(url, payload, headers=None, raw=None):
    body = raw if raw is not None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "text/plain", **(headers or {})})
    try:
        return urllib.request.urlopen(req).status
    except urllib.error.HTTPError as e:
        return e.code


def ev(**kw):
    return {"v": 1, "ts": "2026-10-13T08:30:12.123Z", "session": "b7f3a1c2d4e5f607", "event": "analyze_done",
            "app": {"ui": "dashboard", "ver": "1.2", "lang": "th"}, "mode": "dish", "source": "upload",
            "result": {"verdict": "PASS", "score": 83.0}, **kw}


def lines(data):
    files = list(data.glob("usage-*.jsonl"))
    return [json.loads(x) for f in files for x in f.read_text(encoding="utf-8").splitlines()]


def test_valid_events_are_stored_with_only_whitelisted_fields(server):
    url, data = server
    bad = [ev(event="evil"), ev(session="../../etc"), ev(ts="yesterday"), "x", {"v": 2}]
    ok = ev(evil_key="x", error="e" * 500)
    assert post(url, {"v": 1, "events": [ok, *bad]}) == 204
    rows = lines(data)
    assert len(rows) == 1  # everything malformed was dropped
    assert "evil_key" not in rows[0] and len(rows[0]["error"]) == 80 and rows[0]["result"]["verdict"] == "PASS"
    assert rows[0]["received"].endswith("Z")
    assert post(url, {"v": 1, "events": [ev(event="feedback", feedback={"correct": False, "expected_count": 42})]}) == 204
    assert len(lines(data)) == 2  # appended to the same day file
    assert post(url, {"v": 1, "events": [ev(event="analyze_start"), ev(event="camera_use", action="open"), ev(event="camera_error", error="NotAllowedError")]}) == 204
    assert [r["event"] for r in lines(data)][2:] == ["analyze_start", "camera_use", "camera_error"] and lines(data)[3]["action"] == "open"


def test_refuses_wrong_method_origin_size_and_shape(server):
    url, data = server
    try:
        urllib.request.urlopen(url)
        got = 200
    except urllib.error.HTTPError as e:
        got = e.code
    assert got == 405
    assert post(url, {"v": 1, "events": [ev()]}, headers={"Origin": "https://evil.example"}) == 403
    assert post(url, {"v": 1, "events": [ev()]}, headers={"Origin": url.rsplit("/", 1)[0]}) == 204
    assert post(url, None, raw=b"not json") == 400
    assert post(url, {"v": 1, "events": [ev()] * 51}) == 400
    assert post(url, None, raw=b"x" * 40000) == 413
    assert len(lines(data)) == 1  # only the same-origin one was stored


def test_rate_limit_per_visitor(server):
    url, data = server
    batch = {"v": 1, "events": [ev()] * 50}
    codes = [post(url, batch) for _ in range(13)]
    assert codes[:12] == [204] * 12 and codes[12] == 429  # 600 events per hour
