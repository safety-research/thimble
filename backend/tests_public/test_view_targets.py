"""Views without modes (views.py's module note, Pages): a view has the pages it has, and each build makes the page of its
target, `term-page` (view.term.js) on the local transport and `html-page` (view.html) after the press. The first open
of a view in the place whose page it lacks builds that page as a revision that keeps its reader.py: a terminal-built
view opened in the browser, and a browser-built view opened in the terminal. The view prompts render per target exactly
as 0.8.0 rendered them per mode, and the builder's registration and its task follow the build's target. View proposals
follow their switch."""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from app import config, dev, prompts, proposer, term_views, userconf, view_tools, views

HERE = Path(__file__).resolve().parent
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


def test_a_browser_built_view_gets_its_terminal_page_on_its_first_terminal_open(workspaces_tmp, tmp_path, monkeypatch,
                                                                                queued):
    c = _corpus(tmp_path, monkeypatch, "board", "local")
    _built(c, "board", term=False, html=True)
    with pytest.raises(term_views.TermViewError) as e:
        term_views.term_view(c, "board")
    assert str(e.value) == term_views.BUILDING == "building the terminal page…"
    prop = views.read_proposal(c, "board")
    assert (prop["status"], prop["target"]) == ("queued", views.TERM_PAGE) and queued == [(c, "board")]
    assert prop["change"] == views.MISSING_PAGE_REQUEST.format(page="view.term.js", place="the terminal panel")
    assert "install the packages" not in dev.build_task(c, prop)
    # the view's own checks draw its draft and build nothing
    with pytest.raises(term_views.TermViewError):
        term_views.term_view(c, "board", live=True)
    assert len(queued) == 1


def test_a_view_whose_term_page_imports_thimble_term_is_drawn(workspaces_tmp, tmp_path, monkeypatch):
    """'thimble-term' stays the view kit's import name: a view.term.js that imports it is served to the terminal."""
    c = _corpus(tmp_path, monkeypatch, "board", "local")
    _built(c, "board", term=True, html=False)
    view, program = term_views.term_view(c, "board")
    assert "from 'thimble-term'" in program and view["slug"] == "board"
    assert "'thimble-term'" in (config.REPO_ROOT / "backend" / "app" / "term_kit" / "runtime.mjs").read_text()


def test_the_builder_s_registration_follows_the_build_s_target(workspaces_tmp, tmp_path, monkeypatch):
    c = _corpus(tmp_path, monkeypatch, "board", "local")
    with views.spawning(c, views.TERM_PAGE):
        term = view_tools.builder_definition(c)["prompt"]
    with views.spawning(c, views.HTML_PAGE):
        page = view_tools.builder_definition(c)["prompt"]
    assert "view.term.js" in term and "terminal-views.md" in term and "view.html" not in term
    assert "view.html" in page and "view.term.js" not in page
    assert view_tools.builder_definition(c)["prompt"] == term, "on the local transport a build makes view.term.js"
    assert views.spawn_target(c) == views.TERM_PAGE


@pytest.mark.parametrize("name", ["dev-view", "view-review", "dev-view-task", "view-propose"])
@pytest.mark.parametrize("target", ["term-page", "html-page"])
def test_the_view_prompts_render_per_target_as_0_8_0_rendered_them_per_mode(name, target, tmp_path, monkeypatch):
    """Each of the four view prompts, rendered for a build target, is word for word what 0.8.0 rendered for the mode of
    that page (terminal for term-page, browser for html-page): the renames of their blocks change no word. The prompts'
    includes are a placeholder here (PREAMBLE), as when the digests were taken from 0.8.0's prompts.py."""
    want = json.loads((HERE / "fixtures" / "view_prompts_080.json").read_text())[name][target]
    d = tmp_path / "prompts"
    d.mkdir()
    shutil.copyfile(config.REPO_ROOT / "prompts" / f"{name}.md", d / f"{name}.md")
    (d / "preamble.md").write_text("PREAMBLE\n")
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(d))
    text = prompts.load(name, views.target_flags(None, target))
    assert (hashlib.sha256(text.encode()).hexdigest(), len(text)) == (want["sha256"], want["chars"])


def test_no_mode_is_left_in_the_views():
    assert not hasattr(views, "NOT_BROWSER") and not hasattr(term_views, "NOT_TERMINAL")
    assert not hasattr(views, "terminal")
    for name in ("dev-view", "view-review", "dev-view-task", "view-propose"):
        text = (config.REPO_ROOT / "prompts" / f"{name}.md").read_text("utf-8")
        if hasattr(prompts, "TARGETS"):  # the core lane's renderer, which knows the build targets
            assert "{{if:terminal}}" not in text and "{{if:browser}}" not in text, name


def test_view_proposals_follow_their_switch(workspaces_tmp, tmp_path, monkeypatch):
    c = _corpus(tmp_path, monkeypatch, "board", "local")
    monkeypatch.setenv(views.PROPOSE_ENV, "on")
    assert proposer.enabled(c) is True
    conf = userconf.global_file()
    conf.parent.mkdir(parents=True, exist_ok=True)
    conf.write_text(json.dumps({"views": {"propose": False}}))
    assert views.propose_enabled(c) is False and proposer.enabled(c) is False
    proposer.trigger(c, proposer.MAIN, cut="cut-1", sid="s1")
    assert proposer.pending(c) is None, "no job with view proposals off"


def test_a_failed_page_build_waits_for_retry_and_retry_builds_that_page(workspaces_tmp, tmp_path, monkeypatch, queued):
    c = _corpus(tmp_path, monkeypatch, "board", "server")
    _built(c, "board", term=False, html=True)
    assert views.ensure_page(c, "board", views.TERM_PAGE) is True
    request = views.read_proposal(c, "board")["change"]
    views.end_revision(c, "board", "the program did not draw", failed_change=request)
    assert views.read_proposal(c, "board")["status"] == "built"
    assert views.ensure_page(c, "board", views.TERM_PAGE) is False, "no build again on the next open"
    monkeypatch.setattr(views, "click_refused", lambda c, slug: None)
    views.retry(c, "board")
    prop = views.read_proposal(c, "board")
    assert (prop["status"], prop["target"], prop["change"]) == ("queued", views.TERM_PAGE, request)
    assert len(queued) == 2
