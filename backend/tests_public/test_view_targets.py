"""Views without modes (views.py's module note, Pages): a view has the pages it has, and each build makes the page of its
target first, `term-page` (view.term.js) on the local transport and `html-page` (view.html) after the press, then goes
on to the other place's page in the same build. The first open of a view in the place whose page it still lacks builds
that page as a revision that keeps its reader.py: a terminal-built view opened in the browser, and a browser-built view
opened in the terminal."""
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


async def test_a_browser_built_view_opened_in_the_terminal_gets_its_terminal_page_built(workspaces_tmp, tmp_path,
                                                                                       monkeypatch, queued):
    """Bug hunt C12: a view built for the browser said "building the terminal page…" in the terminal for good, as
    nothing asked for that page: the panel drew the words and opened no program, and the view host, which alone called
    ensure_page, runs in a process that follows no build. The panel's open now asks (`thimble act view-term-page`):
    on the local transport the holder queues the build, after the press the server does, and when the page cannot be
    built the answer says why, with the fix; home's row says where the page stands."""
    from app import local, local_hooks, term_acts, term_views

    c = _corpus(tmp_path, monkeypatch, "board", "local")
    _built(c, "board", term=False, html=True)
    monkeypatch.setattr(term_views, "node_problem", lambda: "")
    row = lambda: next(r for r in local._home_views(c) if r["slug"] == "board")  # noqa: E731
    assert (row()["term"], row()["page"]) == (False, "missing")
    # the view host says it builds, and queues nothing in its own process
    with pytest.raises(term_views.TermViewError, match="building the terminal page"):
        term_views.term_view(c, "board")
    assert queued == []
    # the act hands the build to the holder, which queues it
    handed: list[tuple] = []
    monkeypatch.setattr(local, "_hand_over", lambda kind, c, body=None: handed.append((kind, body)))
    assert await local.act(c, "view-term-page", {"slug": "board"}) == {"ok": True, "queued": True}
    assert handed == [("view-term-page", {"slug": "board"})]
    assert "view-term-page" in local_hooks.KINDS
    local_hooks.ANSWERS["view-term-page"](c, handed[0][1])
    assert queued == [(c, "board")]
    prop = views.read_proposal(c, "board")
    assert (prop["status"], prop["target"]) == ("queued", views.TERM_PAGE)
    assert prop["change"] == views.MISSING_PAGE_REQUEST.format(page="view.term.js", place="the terminal panel")
    assert row()["page"] == "building"
    # asked again while it builds: it builds, and nothing more is handed over
    assert await local.act(c, "view-term-page", {"slug": "board"}) == {"ok": True, "queued": True}
    assert len(handed) == 1
    # its build failed: the answer and home's row say why, and that Retry builds it again
    views.end_revision(c, "board", "its program drew nothing", failed_change=prop["change"])
    assert (row()["page"], row()["page_why"]) == ("failed", "its program drew nothing")
    got = await local.act(c, "view-term-page", {"slug": "board"})
    assert (got["queued"], got["failed"]) == (False, True)
    assert got["reason"] == ("The build of its page for the terminal panel failed: its program drew nothing. "
                             "Retry builds it again.")
    # a machine that cannot build it says what it lacks
    views.update_proposal(c, "board", failed_change=None)
    monkeypatch.setattr(term_views, "node_problem", lambda: "Terminal views need Node 22+, and this machine has no Node.")
    got = await local.act(c, "view-term-page", {"slug": "board"})
    assert got == {"ok": True, "queued": False, "reason": "Its page for the terminal panel cannot be built here. "
                                                          "Terminal views need Node 22+, and this machine has no Node."}
    assert len(handed) == 1 and len(queued) == 1
    # after the press, the server's act route queues it itself
    monkeypatch.setattr(term_views, "node_problem", lambda: "")
    assert await term_acts.act_route(c, term_acts.ActBody(kind="view-term-page", payload={"slug": "board"})) == {
        "queued": True}
    assert queued == [(c, "board"), (c, "board")]


async def test_a_view_built_in_the_terminal_gets_its_browser_page_in_the_same_build_before_its_review(
        workspaces_tmp, tmp_path, monkeypatch, queued):
    """Bug hunt round 9, J13: a view built in the terminal was built again when the browser first opened it (7 minutes
    more, then a second review), and the tab said "building the page for the browser…" until a Reload. Once the
    terminal page passes, the same build goes on to the browser's page, which a browser opened meanwhile waits for
    (the views list says it has no page yet, and the pane loads the version that brings it); the review of the
    terminal page starts once the build ends."""
    from types import SimpleNamespace

    from app import headless, view_review, work_files

    c = _corpus(tmp_path, monkeypatch, "board", "local")
    d = _built(c, "board", term=True, html=False)
    views._save_proposals(c, [{"slug": "board", "name": "Board", "description": "The posts.", "task": "",
                               "claims": ["board.jsonl"], "status": "built", "target": views.TERM_PAGE,
                               "agent_id": "abuilder01", "finish": {"agent": "abuilder01", "result": "pass"}}])
    reviewed: list[tuple[str, str]] = []
    monkeypatch.setattr(view_review, "after_built", lambda c, slug: reviewed.append((slug, views.target_of(c, slug))))
    monkeypatch.setattr(views, "build_problem_for", lambda c, target=None: "")
    monkeypatch.setattr(headless, "missing", lambda kind: "")

    async def no_regate(c, slug):
        return None

    monkeypatch.setattr(views, "regate", no_regate)
    monkeypatch.setattr(work_files, "after_run", lambda *a, **k: None)
    run = SimpleNamespace(agent_id="abuilder01", chat=None, key="view:board", k=1)
    await dev._settle(c, "board", run, "done", "", "")
    assert queued == [(c, "board")], "the same build goes on to the browser's page"
    assert reviewed == [], "the review waits for the build's end"
    prop = views.read_proposal(c, "board")
    assert (prop["status"], prop["target"], prop["first_page"]) == ("queued", views.HTML_PAGE, views.TERM_PAGE)
    assert prop["change"] == views.MISSING_PAGE_REQUEST.format(page="view.html", place="the browser workbench")
    # the browser opens it meanwhile: no second build, and the list says it has no page there yet
    assert views.ensure_page(c, "board", views.HTML_PAGE) is False and len(queued) == 1
    assert views._public(views.read_built(c, "board"))["browser_page"] is False
    # the browser's page passes: the build ends, and the review looks at the terminal page it began with
    (d / views.VIEW_HTML).write_text("<div>board</div>")
    views.mark_built(c, "board")
    await dev._settle(c, "board", run, "done", "", "")
    assert len(queued) == 1 and reviewed == [("board", views.TERM_PAGE)]
    assert views.read_proposal(c, "board").get("first_page") is None
    assert views._public(views.read_built(c, "board"))["browser_page"] is True


async def test_bug_hunt_k6_build_it_pressed_in_the_terminal_builds_the_terminal_page_first_and_main_hears_where(
        workspaces_tmp, tmp_path, monkeypatch, queued):
    """Bug hunt round 10, K6: `build it` pressed in the terminal after the browser had opened once was taken for a
    browser click: main heard that the analyst started the builder "in the browser", and the build made the browser's
    page first, so the analyst who pressed in the terminal waited 22 minutes for their page. A press is recorded where
    it was made: the terminal's builds the terminal page first (then the browser's, in the same build), the browser's
    the browser page, and main's note at the builder's start names the place."""
    from app import local_hooks, subagents, term_acts
    from app import subagent_files as sf

    c = _corpus(tmp_path, monkeypatch, "board", "server")  # the browser opened once: the server's transport
    assert views.default_target(c) == views.HTML_PAGE
    offered = {"name": "Board", "description": "The posts.", "task": "Read the board.", "claims": ["board.jsonl"],
               "status": "suggested", "route": "click", "offered": {"at": 1.0, "after": "main", "why": "posts"}}
    views._save_proposals(c, [{"slug": "board", **offered}, {"slug": "threads", **offered, "name": "Threads"},
                              {"slug": "posts", **offered, "name": "Posts"}])
    monkeypatch.setattr(subagents, "refusal_before", lambda c, click=False: None)
    got = await term_acts.act_route(c, term_acts.ActBody(kind="view-accept", payload={"slug": "board"}))
    assert got == {"queued": True} and queued == [(c, "board")]
    prop = views.read_proposal(c, "board")
    assert (prop["place"], prop["target"], views.target_of(c, "board")) == ("terminal", views.TERM_PAGE,
                                                                             views.TERM_PAGE)
    # the builder's task and registration are the terminal page's
    task = dev.build_task(c, prop)
    assert "install the packages the page loads there" not in task
    # the browser's press builds the browser's page; one in the terminal before the press, the terminal's
    views.accept(c, "threads", place=views.BROWSER)
    assert (views.read_proposal(c, "threads")["place"], views.target_of(c, "threads")) == ("browser", views.HTML_PAGE)
    local_hooks.ANSWERS["view-accept"](c, {"slug": "posts"})
    assert (views.read_proposal(c, "posts")["place"], views.target_of(c, "posts")) == ("terminal", views.TERM_PAGE)
    # main's note at the start says where the analyst pressed; a click that names no place is the browser's
    assert sf.how("click", "terminal") == "in the terminal" and sf.how("click", "browser") == "in the browser"
    assert sf.how("click") == "in the browser" and sf.how("follow-on", "terminal") == sf.HOW["follow-on"]
    from subagent_fakes import real_bridge

    note = real_bridge._note("view-builder", "board", "click", "terminal")
    assert "view-builder for board in the terminal," in note and "browser" not in note, note
    wire = real_bridge._args("spawn", {"role": "view-builder", "prompt": "p", "what": "board", "route": "click",
                                       "place": "terminal"})
    assert "in the terminal" in wire["note"]
    # after /clear a new main hears of the running builder with the same words
    state = {"agents": {"abuilder01": {"type": "thimble:view-builder", "key": "view:board", "status": "running",
                                       "route": "click", "place": "terminal", "plugin_started": True}}}
    assert any("in the terminal" in line for line in sf.started_notes(state))


def test_bug_hunt_k11_the_build_of_a_view_s_other_page_is_told_it_is_thimble_s_step_with_that_page_s_instructions(
        workspaces_tmp, tmp_path, monkeypatch, queued):
    """Bug hunt round 10, K11 (I12 again): the builder that built a view's browser page was resumed for its terminal
    page with "The analyst asked for a change to the view", though the analyst asked for nothing, and with only its
    first page's instructions; it grepped and read thimble's own source and docs, an ask each in Manual mode, and
    called no `view_reference`. The build of the page a view lacks now says it is thimble's next step and carries the
    instructions a build of that page starts with, `view_reference` and reading only the corpus's files and its own
    among them; an analyst's change still reads as theirs."""
    from app import view_tools

    c = _corpus(tmp_path, monkeypatch, "board", "server")
    _built(c, "board", term=False, html=True)
    assert views.ensure_page(c, "board", views.TERM_PAGE) is True
    prop = views.read_proposal(c, "board")
    text = dev.change_text(c, prop)
    assert text.startswith("## The view's page for the terminal panel\n"), text[:200]
    assert "The analyst asked" not in text and "the analyst asked for no change" in text
    assert f"Write view.term.js in {views.views_dir(c) / 'board'}." in text
    assert "`view_reference` gives thimble's doc `terminal-views`" in text, "the terminal page's view kit"
    assert "read only the corpus's files and your own" in text
    assert "thimble.colorBy" not in text and "npm install" not in text, "not the browser page's"
    # the instructions are those a build of the terminal page is registered with
    with views.spawning(c, views.TERM_PAGE):
        registered = view_tools.builder_definition(c)["prompt"]
    assert view_tools.builder_instructions(c, views.TERM_PAGE) in registered
    # a new builder, where none can be reached, gets the same step in its task
    task = dev.build_task(c, prop)
    assert "has no page for the terminal panel" in task and "The analyst asked" not in task
    # the browser's page of a view built in the terminal: the browser's instructions
    _built(c, "lanes", term=True, html=False)
    assert views.ensure_page(c, "lanes", views.HTML_PAGE) is True
    text = dev.change_text(c, views.read_proposal(c, "lanes"))
    assert text.startswith("## The view's page for the browser workbench\n") and "thimble.colorBy" in text
    # a change the analyst asked for still reads as theirs
    views.revise(c, "board", "Add a legend.")
    text = dev.change_text(c, views.read_proposal(c, "board"))
    assert "The analyst asked for a change to the view Board" in text and "Add a legend." in text
