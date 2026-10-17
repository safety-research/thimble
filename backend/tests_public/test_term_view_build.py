"""A view built for the terminal (a build whose target is term-page, views.target_of): its builder is asked for
view.term.js and reader.py in place of view.html (prompts/dev-view.md's term-page blocks), its gate runs the reader's
checks and then draws the program as text (views.term_draws, term_views.draw_check) at 120 and 200 columns in light and
dark and at the first place that resolved, with no browser, and fails on a program error, a timeout or a draw past the
panel. A broken program fails with what broke. Reader calls run in this process (views._runner), so no kernel starts."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app import config, local, prompts, term_views, tools, view_tools, views
from test_term_views import DRAW_WRAP, inproc, needs_node  # noqa: F401 — the fixture, used by name
from target_blocks import target_blocks  # noqa: F401 — the core lane's target flags, where prompts.py lacks them

EXAMPLE = views.EXAMPLES_DIR / "timeline"
BOARD_READER = '''
import json


def build_index(paths):
    rows, torn = [], []
    for p in paths:
        with open(p) as fh:
            for n, line in enumerate(fh, 1):
                try:
                    rows.append({"ref": f"{p}#L{n}", "body": json.loads(line)["body"]})
                except ValueError:
                    torn.append({"ref": f"{p}#L{n}", "why": "not JSON"})
    return {"rows": rows, "torn": torn}


def problems(index):
    return index["torn"]


def records(index, query):
    return {"rows": index["rows"]}


def resolve(index, locator):
    for r in index["rows"]:
        if locator.get("path") and r["ref"] == f"{locator['path']}#{locator['fragment']}":
            return {"excerpt": r["body"], "label": r["body"], "refs": [r["ref"]], "key": None, "target": r["ref"]}
    return None
'''


def _terminal(c: str) -> None:
    """Workspace `c`'s session as terminal mode starts it (launch.json's `mode`)."""
    ws = config.workspace_dir(c)
    (ws / "trusted").mkdir(parents=True, exist_ok=True)
    (ws / local.LAUNCH_FILE).write_text(json.dumps({"mode": "terminal"}))


def _draft(c: str, slug: str, raw: dict, reader: str, program: str | None) -> Path:
    """A view's draft as a builder in terminal mode leaves it: view.json, reader.py and view.term.js, no view.html."""
    views.ensure_local(config.workspace_dir(c))
    d = views.views_dir(c) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / views.VIEW_JSON).write_text(json.dumps(raw))
    (d / views.READER_PY).write_text(reader)
    if program is not None:
        (d / views.VIEW_TERM).write_text(program)
    return d


@pytest.fixture()
def sandboxed(monkeypatch):
    """The gate's programs in the sandbox the drawing tests use (DRAW_WRAP), and no browser at all: a page load or a
    picture fails the test."""
    real = term_views.Program
    monkeypatch.setattr(term_views, "Program", lambda *a, **k: real(*a, **{**k, "wrap": DRAW_WRAP}))

    async def no_browser(*a, **k):
        raise AssertionError("a view built in terminal mode is checked with no browser")

    monkeypatch.setattr(views, "shoot_states", no_browser)
    monkeypatch.setattr(views, "shoot_page", no_browser)


@pytest.fixture()
def timeline(workspaces_tmp, tmp_path, monkeypatch, inproc, sandboxed) -> str:
    """The worked example Timeline as a terminal-mode builder's draft over the example's own sample."""
    d = tmp_path / "data"
    shutil.copytree(EXAMPLE / "sample", d / "timeline")
    (d / "timeline" / "manifest.json").write_text(json.dumps({"name": "timeline", "description": "an example"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    _terminal("timeline")
    _draft("timeline", "timeline", json.loads((EXAMPLE / "view.json").read_text("utf-8")),
           (EXAMPLE / "reader.py").read_text("utf-8"), (EXAMPLE / "view.term.js").read_text("utf-8"))
    return "timeline"


@pytest.fixture()
def board(workspaces_tmp, tmp_path, monkeypatch, inproc, sandboxed) -> str:
    d = tmp_path / "data" / "board"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"name": "board", "description": "a message board"}))
    (d / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first", "second", "third")))
    monkeypatch.setattr(config, "DATA_DIR", d.parent.resolve())
    _terminal("board")
    return "board"


BOARD_VIEW = {"name": "Board", "description": "The posts.", "scope": ["board.jsonl"],
              "accepts": [{"form": "L<n>", "means": "the post on line <n>"}]}


# ------------------------------------------------------------------------------------------------------ the builder


def test_a_build_in_terminal_mode_asks_for_view_term_js(board):
    """The builder's registered prompt for a term-page build asks for view.term.js on the terminal kit, points to the
    kit's doc and the worked examples' programs, and says nothing of view.html; for an html-page build it is the page's
    as before (0.9.0: the build's target, views.spawning, in place of the session's mode). The proposal's result says
    the view opens in thimble's panel in the terminal."""
    with views.spawning("board", views.TERM_PAGE):
        term = view_tools.builder_definition("board")["prompt"]
    with prompts.rendering("terminal"):
        proposed = tools.hint("propose_view-proposed", view="Board", slug="board", claims="board.jsonl")
    with views.spawning("board", views.HTML_PAGE):
        page = view_tools.builder_definition("board")["prompt"]
    with prompts.rendering("browser"):
        opened = tools.hint("propose_view-proposed", view="Board", slug="board", claims="board.jsonl")
    assert "view.term.js" in term and "`terminal-views`" in term and "thimble view text" in term
    assert all(f"`{x}`" in term for x in ("timeline", "linked-sessions", "repository"))
    assert "view.html" not in term and "data-anchor" not in term and "npm" not in term and "px" not in term
    assert "view.html" in page and "view.term.js" not in page and "terminal-views" not in page
    # 0.9.0 (SPEC-v2 3.18): one text for every session, the panel first and the browser workbench after the press
    assert "thimble's panel in the terminal" in proposed and "Files in the browser workbench" in proposed
    assert opened == proposed


def test_a_build_in_terminal_mode_needs_node_and_no_browser(board, monkeypatch):
    """A view build in terminal mode needs Node, not the frontend's Playwright (views.build_problem_for)."""
    monkeypatch.setattr(views, "build_problem", lambda: "Custom views need the frontend's packages")
    monkeypatch.setattr(term_views, "node_problem", lambda: "")
    assert views.build_problem_for("board") == ""
    monkeypatch.setattr(term_views, "node_problem", lambda: "Terminal views need Node 20.11+")
    assert views.build_problem_for("board") == "Terminal views need Node 20.11+"
    config.workspace_dir("board").joinpath(local.LAUNCH_FILE).unlink()
    assert views.build_problem_for("board") == "Custom views need the frontend's packages"


# ------------------------------------------------------------------------------------------------------ the gate


@needs_node
@pytest.mark.parametrize("program, says", [
    ("import { draw } from 'thimble-term'\ndraw((d) => { d.line('ok'); null.boom })\n", "failed"),
    ("import { draw } from 'thimble-term'\ndraw((d) => d.line('x'.repeat(d.cols + 30)))\n", "rows wider than its"),
])
async def test_the_terminal_gate_fails_a_broken_program_with_what_broke(board, monkeypatch, program, says):
    """A program that throws, does not parse, gets a fetch its reader cannot answer, draws past the panel's columns or
    rows, or never stops drawing fails the gate with that, once for all the draws it showed in; the reader's checks
    pass."""
    monkeypatch.setattr(term_views, "SETTLE_MAX_S", 3.0)
    reader = BOARD_READER.replace("def records(index, query):\n",
                                  'def records(index, query):\n    if query.get("op") == "fail":\n'
                                  '        raise ValueError("no such op")\n')
    assert "no such op" in reader
    _draft("board", "board", BOARD_VIEW, reader, program)
    report = await views.gate("board", "board")
    assert not report["ok"] and all(r["ok"] for r in report["checks"]), views.gate_lines(report)
    problems = [p for p in report["problems"] if says in p]
    assert len(problems) == 1 and len(report["problems"]) == 1, report["problems"]
    assert "as it opens at 120 columns in the light and dark themes and at 200 columns in the light and dark themes; " \
           "opened at board.jsonl#L" in problems[0]
    assert views.first_failure(report) == f"problem: {problems[0]}"
