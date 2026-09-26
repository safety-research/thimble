"""The headless page of a view's checks (views.shoot_states) may send a message line far longer than asyncio's default
64 KiB, such as a marks request for thousands of records; the checks read it rather than crash. The page is a stand-in
script and the view invented."""
from __future__ import annotations

import json
import shutil

import pytest

from app import config, views

CORPUS = "longlines"
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
'''
PAGE = "<!doctype html><html><body><div>rows</div></body></html>"
# prints one line of about 200 KB, then the result of its one state
STAND_IN = """
const refs = Array.from({ length: 12000 }, (_, i) => `board.jsonl#L${i + 1}`)
process.stdout.write(JSON.stringify({ note: refs }) + '\\n')
process.stdout.write(JSON.stringify({ done: true, states: [{ ok: true, errors: [], fetches: 0, records: 12000 }] }) + '\\n')
"""

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not (config.REPO_ROOT / "frontend" / "node_modules" / "playwright").is_dir(),
    reason="the checks' page needs node and frontend/node_modules/playwright")


@pytest.fixture()
def view(tmp_path, monkeypatch, workspaces_tmp):
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (corpus / "board.jsonl").write_text(json.dumps({"body": "post"}) + "\n")
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    script = tmp_path / "stand_in.mjs"
    script.write_text(STAND_IN)
    monkeypatch.setattr(views, "SHOT_SCRIPT", script)
    views.write_view(CORPUS, "board", name="Board", why="w", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "a post"}], reader=READER, html=PAGE)
    return tmp_path


async def test_a_message_line_past_64_kib_is_read(view):
    views._bind_loop()
    [shot] = await views.shoot_states(CORPUS, "board", [{"out": view / "board.png", "open": {}, "labels": None}])
    assert shot["ok"], shot
    assert shot["records"] == 12000
