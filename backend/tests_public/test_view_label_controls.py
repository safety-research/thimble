"""A view's page loaded headless (views.shoot_states, scripts/view_shot.mjs) counts the controls of its own that name a
label that is on: a checkbox the page builds for each label counts, while a row that shows a record's label mark among
its text does not, and with no label on there is nothing to count. The build's check notes such controls. The corpus
is invented: a board of three posts."""
from __future__ import annotations

import json
import shutil

import pytest

from app import config, views

CORPUS = "toggles"
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return [{"ref": f"board.jsonl#L{n}", "text": f"post {n}"} for n in (1, 2, 3)]


def resolve(index, locator):
    return None
'''
# the page builds a checkbox for each label that is on, as a label menu inside the view would
TOGGLES = '''<!doctype html><html><body><div id="menu"></div><div id="rows"></div><script>
thimble.onLabels((state) => {
  const menu = document.getElementById('menu')
  menu.innerHTML = ''
  for (const l of state.labels) {
    const row = document.createElement('label')
    row.innerHTML = '<input type="checkbox" checked> '
    row.append(l.name)
    menu.append(row)
  }
})
thimble.fetch({}).then((recs) => {
  for (const r of recs) {
    const d = document.createElement('div')
    d.dataset.anchor = r.ref
    d.textContent = r.text
    document.getElementById('rows').append(d)
  }
})
</script></body></html>'''
# the page shows each record as a row button whose text carries the names of the labels that mark it
ROWS = '''<!doctype html><html><body><div id="rows"></div><script>
let names = []
const draw = (recs) => {
  const rows = document.getElementById('rows')
  rows.innerHTML = ''
  for (const r of recs) {
    const b = document.createElement('button')
    b.dataset.anchor = r.ref
    b.textContent = r.text + ', a post of the board that runs on for a while ' + names.join(' ')
    rows.append(b)
  }
}
thimble.onLabels((state) => { names = state.labels.map((l) => l.name) })
thimble.fetch({}).then(draw)
</script></body></html>'''

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not (config.REPO_ROOT / "frontend" / "node_modules" / "playwright").is_dir(),
    reason="the headless page load needs node and frontend/node_modules/playwright")


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp):
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"body": f"post {n}"}) + "\n" for n in (1, 2, 3)))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    for slug, html in (("toggles", TOGGLES), ("rows", ROWS)):
        views.write_view(CORPUS, slug, name=slug.title(), why="w", claims=["board.jsonl"],
                         accepts=[{"form": "L<n>", "means": "a post"}], reader=READER, html=html)
    return tmp_path


async def _shoot(slug: str, tmp_path, labels) -> dict:
    views._bind_loop()
    [shot] = await views.shoot_states(CORPUS, slug, [{"out": tmp_path / f"{slug}.png", "open": {}, "labels": labels}])
    assert shot["ok"], shot
    return shot


async def test_a_label_menu_the_page_builds_is_counted_and_a_row_showing_a_mark_is_not(board):
    toggles = await _shoot("toggles", board, views.probe_context())
    assert toggles["controls"] == 1 and toggles["records"] == 3
    assert (await _shoot("rows", board, views.probe_context()))["controls"] == 0
    assert (await _shoot("toggles", board, views.NO_LABELS))["controls"] == 0, "no label is on to name"


def test_the_build_s_check_notes_label_controls():
    lines = views.gate_lines({"checks": [], "page": {"ok": True},
                              "shots": [{"ok": True, "state": "overview", "records": 3, "controls": 2}]})
    assert any(ln.startswith("note: The page has 2 controls of its own that name the test label") for ln in lines)
    assert not any("controls of its own" in ln for ln in views.gate_lines({"checks": [], "page": {"ok": True},
                                                                         "shots": [{"ok": True, "state": "overview"}]}))
