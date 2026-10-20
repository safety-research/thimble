"""Generative views: the files a view needs, its frame, and its reader run in the sandbox (views/)."""
import json
from pathlib import Path

import pytest

from thimble_browser import home, prompts, views
from thimble_browser.cards import sandbox

READER = '''
import json

def build_index(paths):
    rows = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                rows.append({**json.loads(line), "ref": f"{p}#L{n}"})
    return rows

def records(index, query):
    return {"rows": index}

def resolve(index, locator):
    return None
'''


def make(folder):
    ws = home.open_folder(folder)
    views.write_file(ws, "runs", "view.json", json.dumps({"name": "Runs", "scope": ["runs/*.jsonl"]}))
    views.write_file(ws, "runs", "reader.py", READER)
    views.write_file(ws, "runs", "view.html", "<main id=m></main><script>thimble.fetch({})</script>")
    return ws


def test_a_view_writes_only_its_three_files_and_never_built(folder):
    ws = make(folder)
    for name, text in (("../x.py", ""), ("other.js", ""), ("view.json", json.dumps({"built": "now"}))):
        with pytest.raises(ValueError):
            views.write_file(ws, "runs", name, text)
    with pytest.raises(KeyError):
        views.view_dir(ws, "../escape")
    assert views.source_problems(ws, "runs") == []


def test_only_a_built_view_is_listed_and_its_frame_holds_the_kit(folder):
    ws = make(folder)
    assert views.list_views(ws, folder) == []
    views.mark_built(ws, "runs")
    [v] = views.list_views(ws, folder)
    assert v["ok"] and not v["file_type"] and v["files"] == ["runs/a.jsonl"]
    html = views.frame(ws, "runs")
    assert "connect-src 'none'" in html and "window.__thimbleView" in html and html.endswith("</script>")


@pytest.mark.skipif(sandbox.available() is None, reason="no sandbox on this machine")
async def test_the_reader_runs_in_the_sandbox(folder):
    ws = make(folder)
    got = await views.run_reader(ws, "runs", folder, "records", {})
    assert got["ok"] and got["result"]["rows"][1]["outcome"] == "merged"
    checked = await views.check(ws, "runs", folder, page=False)
    assert checked["ok"], checked["lines"]


def test_the_builder_prompt_is_0_8s_with_the_listed_changes():
    text = views.builder_prompt(Path("/folder"), 3)
    assert "{{" not in text and "npm install" not in text
    assert "## A good view" in text and "## Citation forms" in text
