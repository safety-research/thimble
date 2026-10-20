"""A card's code runs in the sandbox: it reads the folder and nothing else, writes nothing, reaches no network."""
import pytest

from thimble_browser.cards import sandbox

pytestmark = pytest.mark.skipif(sandbox.available() is None, reason="no sandbox on this machine")
ERR = "application/vnd.thimble.error+json"


async def test_a_table(folder):
    r = await sandbox.run_code("import pandas as pd\npd.read_csv('results.csv').set_index('run')", folder, timeout=30)
    assert r["status"] == "ok" and r["frame"]["rows"] == [["a", "merged"], ["b", "failed"]]


async def test_no_home_no_environment_no_writes_no_network(folder, monkeypatch):
    monkeypatch.setenv("SOME_TOKEN", "x")
    r = await sandbox.run_code("import os\nprint(sorted(os.environ))\nprint(os.listdir('/tmp'))", folder, timeout=30)
    assert "SOME_TOKEN" not in r["outputs"][0]["text/plain"]
    r = await sandbox.run_code("open('new.txt', 'w')", folder, timeout=30)
    assert r["status"] == "error" and "Read-only" in r["outputs"][-1][ERR]["evalue"]
    r = await sandbox.run_code("import socket\nsocket.create_connection(('1.1.1.1', 80), timeout=3)", folder, timeout=30)
    assert r["status"] == "error"
    r = await sandbox.run_code("import os\nos.listdir(os.path.expanduser('~'))", folder, timeout=30)
    assert "files" not in str(r["outputs"])


async def test_a_run_past_its_time_is_stopped(folder):
    r = await sandbox.run_code("import time\ntime.sleep(10)", folder, timeout=1)
    assert r["status"] == "error" and r["outputs"][-1][ERR]["ename"] == "TimeoutError"
