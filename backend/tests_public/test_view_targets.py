"""Views without modes (views.py's module note, Pages): a view has the pages it has, and each build makes the page of its
target, `term-page` (view.term.js) on the local transport and `html-page` (view.html) after the press. The first open
of a view in the place whose page it lacks builds that page as a revision that keeps its reader.py: a terminal-built
view opened in the browser, and a browser-built view opened in the terminal."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import config, dev, views
from target_blocks import target_blocks  # noqa: F401 — the core lane's target flags, where prompts.py lacks them

READER = '''
def build_index(paths):
    return {"paths": list(paths)}


def problems(index):
    return []


def records(index, query):
    return {"rows": []}


def resolve(index, locator):
    return None
'''
PROGRAM = "import { draw } from 'thimble-term'\ndraw((d) => d.text('board'))\n"
VIEW = {"name": "Board", "description": "The posts.", "scope": ["board.jsonl"]}


def _corpus(tmp_path: Path, monkeypatch, name: str, transport: str) -> str:
    """A corpus whose session runs on `transport` (launch.json, the legacy `mode` beside it)."""
    d = tmp_path / "data" / name
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"name": name, "description": ""}))
    (d / "board.jsonl").write_text('{"body": "first"}\n')
    monkeypatch.setattr(config, "DATA_DIR", d.parent.resolve())
    ws = config.workspace_dir(name)
    (ws / "trusted").mkdir(parents=True, exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps(
        {"transport": transport, "mode": "terminal" if transport == "local" else "browser"}))
    return name


def _built(c: str, slug: str, *, term: bool, html: bool) -> Path:
    """A view that passed its checks, with the pages named."""
    views.ensure_local(config.workspace_dir(c))
    d = views.views_dir(c) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / views.VIEW_JSON).write_text(json.dumps(VIEW))
    (d / views.READER_PY).write_text(READER)
    if term:
        (d / views.VIEW_TERM).write_text(PROGRAM)
    if html:
        (d / views.VIEW_HTML).write_text("<div>board</div>")
    views.mark_built(c, slug)
    return d


@pytest.fixture()
def queued(monkeypatch):
    """The builds queued (dev.queue_view), none started."""
    got: list[tuple[str, str]] = []
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: got.append((c, slug)))
    return got


def test_a_terminal_built_view_gets_its_browser_page_on_its_first_browser_open(workspaces_tmp, tmp_path, monkeypatch,
                                                                               queued):
    c = _corpus(tmp_path, monkeypatch, "board", "server")
    d = _built(c, "board", term=True, html=False)
    assert views.default_target(c) == views.HTML_PAGE
    view = views.read_built(c, "board")
    doc = views.frame_document(view)
    assert views.BUILDING_HTML in doc
    assert views.ensure_page(c, "board", views.HTML_PAGE) is True
    assert queued == [(c, "board")]
    prop = views.read_proposal(c, "board")
    assert (prop["status"], prop["revision"], prop["target"]) == ("queued", True, views.HTML_PAGE)
    assert prop["change"] == views.MISSING_PAGE_REQUEST.format(page="view.html", place="the browser workbench")
    assert "Keep reader.py" in prop["change"]
    assert views.target_of(c, "board") == views.HTML_PAGE
    assert (d / views.READER_PY).read_text() == READER, "the reader that passed stays"
    # one build at a time: a second open while it is queued queues nothing more
    assert views.ensure_page(c, "board", views.HTML_PAGE) is False and len(queued) == 1
    # the builder's task names the page's packages; a view that has the page builds nothing
    task = dev.build_task(c, prop)
    assert "install the packages the page loads there" in task
    assert views.ensure_page(c, "board", views.TERM_PAGE) is False
