"""A view built in terminal mode (views.terminal): its builder is asked for view.term.js and reader.py in place of
view.html (prompts/dev-view.md's terminal blocks), its gate runs the reader's checks and then draws the program as text
(views.term_draws, term_views.draw_check) at 120 and 200 columns in light and dark and at the first place that resolved,
with no browser, and fails on a program error, a timeout or a draw past the panel; its reviewer gets those drawings in
place of pictures. The worked example Timeline passes; a broken program fails with what broke. Browser mode keeps its
page and its pictures. Reader calls run in this process (views._runner), so no kernel starts."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app import config, local, prompts, term_views, tools, view_tools, views
from test_term_views import DRAW_WRAP, inproc, needs_node  # noqa: F401 — the fixture, used by name

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
GOOD = """import { draw, fetch, list } from 'thimble-term'
const rows = list({ key: (r) => r.ref })
let items = []
fetch({}).then((d) => { items = d.rows })
draw((d) => rows.draw(d, { items, row: (r, row) => row.add(r.body) }))
"""


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
    """The builder's registered prompt in terminal mode asks for view.term.js on the terminal kit, points to the kit's
    doc and the worked examples' programs, and says nothing of view.html; in browser mode it is the page's as before.
    The proposal's result says the view opens in thimble's panel in the terminal."""
    with prompts.rendering("terminal"):
        term = view_tools.builder_definition("board")["prompt"]
        proposed = tools.hint("propose_view-proposed", view="Board", slug="board", claims="board.jsonl")
    with prompts.rendering("browser"):
        page = view_tools.builder_definition("board")["prompt"]
        opened = tools.hint("propose_view-proposed", view="Board", slug="board", claims="board.jsonl")
    assert "view.term.js" in term and "terminal-views.md" in term and "thimble view text" in term
    assert all(f"`{x}`" in term for x in ("timeline", "linked-sessions", "repository"))
    assert "view.html" not in term and "data-anchor" not in term and "npm" not in term and "px" not in term
    assert "view.html" in page and "view.term.js" not in page and "terminal-views.md" not in page
    assert "thimble's panel in the terminal" in proposed and "Files" not in proposed
    assert "opens in Files" in opened


def test_the_reviewer_and_its_tools_read_drawings_in_terminal_mode(board):
    """The reviewer's prompt and view_pictures speak of the view drawn as text in terminal mode, of pictures in the
    browser; view_check's `picture` draws the view as text there."""
    from app import view_review

    with prompts.rendering("terminal"):
        review = view_review.reviewer_prompt("board")
        secs = tools.tool_sections(["view_pictures", "view_check"])
    with prompts.rendering("browser"):
        page = view_review.reviewer_prompt("board")
        browser = tools.tool_sections(["view_pictures"])
    assert "120 columns wide" in review and "1048 px" not in review and "Files tab" not in review
    assert "1048 px" in page and "120 columns" not in page
    states = secs["view_pictures"][1]["properties"]["states"]["items"]["properties"]["state"]["enum"]
    assert states == ["control", "detail", "open", "wide"] and "labels" in str(browser["view_pictures"][1])
    assert "drawn as text" in secs["view_check"][0]


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
async def test_the_terminal_gate_passes_the_worked_example_and_the_view_draws_once_built(timeline):
    """The gate of a terminal-mode draft: the reader's checks, then the program drawn as text at 120 and 200 columns in
    light and dark and at the first place that resolved, then with the test label on and every choice of its controls
    tried, with no browser. Timeline passes; once registered, the view is listed as built and drawn in the terminal
    panel (draw_text reads the view as it passed)."""
    report = await views.gate(timeline, "timeline", picture=True)
    lines = views.gate_lines(report)
    assert report["ok"], lines
    draws = report["draws"]
    assert [(d["cols"], d["theme"], d["state"]) for d in draws] == [
        (120, "light", "opens"), (120, "dark", "opens"), (200, "light", "opens"), (200, "dark", "opens"),
        (120, "light", "detail"), (120, "light", "choices")]
    assert all(d["ok"] and d["fetches"] for d in draws), lines
    tried = draws[5]["choices"]
    assert len(tried) > 20 and not [x for x in tried if x["errors"]], tried
    assert (f"draw: as it opens with the test label on, at 120 columns in the light theme: ok, {draws[5]['fetches']} "
            f"fetch(es), {len(tried)} choice(s) of its controls tried, 0 with an error") in lines, lines
    # the drawings the reviewer reads wrap the hint row as the panel does, so no row is wider than the panel
    assert all(len(row) <= d["cols"] + 2 for d in draws for row in d["text"].splitlines()), \
        [row for d in draws for row in d["text"].splitlines() if len(row) > d["cols"] + 2]
    assert draws[4]["ref"] and draws[4]["ref"] == next(r["locator"] for r in report["checks"] if r["ok"])
    assert any(ln.startswith("draw: as it opens at 200 columns in the dark theme: ok") for ln in lines)
    assert not any(ln.startswith(("page: ", "png: ")) for ln in lines)
    assert "/ search events" in report["drawing"] and "Color by" in report["drawing"]
    assert (await views.check_answer(timeline, "timeline", [], True))["drawing"] == report["drawing"]
    views.mark_built(timeline, "timeline")
    assert views.read_built(timeline, "timeline")["ok"]
    assert {r["slug"]: r for r in local._home_views(timeline)}["timeline"]["term"] is True
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP)
    assert out.splitlines()[0] == "  Timeline" and "Color by" in out


@needs_node
@pytest.mark.parametrize("program, says", [
    ("import { draw } from 'thimble-term'\ndraw((d) => { d.line('ok'); null.boom })\n", "failed"),
    ("import { draw } from 'thimble-term'\nnope(\n", "failed"),
    ("import { draw, fetch } from 'thimble-term'\nlet rows = []\nfetch({ op: 'fail' }).then((d) => { rows = d.rows })\n"
     "draw((d) => d.line(String(rows.length)))\n", "a fetch failed"),
    ("import { draw } from 'thimble-term'\ndraw((d) => d.line('x'.repeat(d.cols + 30)))\n", "rows wider than its"),
    ("import { draw } from 'thimble-term'\ndraw((d) => { for (let i = 0; i < d.rows + 3; i++) d.line(`row ${i}`) })\n",
     "3 rows past its 40 rows"),
    ("import { draw, redraw } from 'thimble-term'\nlet n = 0\ndraw((d) => d.line(`tick ${n}`))\n"
     "setInterval(() => { n += 1; redraw() }, 20)\n", "did not end its draw"),
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


# the kit's three controls, Color by's onChange reading its choice's title, so Color by: Off throws as it is chosen, and
# the drawing reading Rows' title, so Rows: None throws as it draws; every other choice draws
CHOICES = """import { colorBy, draw, fetch, filterBy, list, rows as rowsBy } from 'thimble-term'
const FIELDS = [{ name: 'kind', title: 'Kind' }]
let heard = ''
const colour = colorBy({ fields: FIELDS, onChange: () => { heard = colour.by.title } })
const filter = filterBy({ fields: FIELDS })
const rows = rowsBy({ fields: FIELDS })
const posts = list({ key: (r) => r.ref })
let items = []
fetch({}).then((d) => { items = d.rows.map((r) => ({ ...r, kind: r.body.length > 5 ? 'long' : 'short' })) })
draw((d) => {
  colour.draw(d, (r) => { filter.add(r).gap(); rows.add(r).gap() })
  d.line(`${rows.by.title} ${heard}`)
  posts.draw(d, { items: items.filter((p) => filter.keeps(p)), colour, row: (p, r) => r.add(p.body) })
})
"""


@needs_node
async def test_the_terminal_gate_tries_every_choice_of_the_kit_s_controls_and_names_the_one_that_gives_an_error(board):
    """The gate's last draw, with the test label on, tries each choice of Color by, Filter by and Rows the program
    draws, Off, None and the test label among them, then each control's first choice again after the others, and fails
    the view on the choices that give an error, naming them (choice_problems): an error thrown as the choice is made
    and one thrown as it draws, each the choice's own, so the choice after it draws."""
    _draft("board", "board", BOARD_VIEW, BOARD_READER, CHOICES)
    report = await views.gate("board", "board")
    choices = report["draws"][-1]["choices"]
    tried = [(x["control"], x["choice"]) for x in choices]
    for want in [("Color by", "Off"), ("Color by", "Kind"), ("Color by", "test label"), ("Filter by", "None"),
                 ("Filter by", "Kind"), ("Filter by", "test label"), ("Rows", "None"), ("Rows", "Kind"),
                 ("Rows", "test label"), ("Color by", "Off (after the others)"), ("Rows", "None (after the others)")]:
        assert want in tried, tried
    bad = [(x["control"], x["choice"]) for x in choices if x["errors"]]
    assert bad == [("Color by", "Off"), ("Rows", "None"), ("Color by", "Off (after the others)"),
                   ("Rows", "None (after the others)")], choices
    assert all("reading 'title'" in x["errors"][0] and "view.term.js line" in x["errors"][0] for x in choices if x["errors"])
    assert not report["ok"] and all(d["ok"] for d in report["draws"]), views.gate_lines(report)
    (problem,) = report["problems"]
    assert problem.startswith("4 choices of the view's controls gave a script error when chosen: Color by: Off (") \
        and "; Rows: None (" in problem and " and 1 more." in problem, problem
    assert views.first_failure(report) == f"problem: {problem}"


@needs_node
async def test_the_terminal_gate_names_view_term_js_and_runs_the_reader_s_checks(board):
    """A terminal-mode draft without view.term.js fails on its files before anything runs, a page beside it or not; a
    good program passes; a reader that leaves a claimed file unread fails the reader's check as in browser mode, its
    draws passing."""
    _draft("board", "board", BOARD_VIEW, BOARD_READER, None)
    assert (await views.gate("board", "board"))["problems"] == ["view.term.js is empty"]
    (views.views_dir("board") / "board" / views.VIEW_HTML).write_text("<p>a page</p>")
    assert (await views.gate("board", "board"))["problems"] == ["view.term.js is empty"], "a page is no program"
    _draft("board", "board", BOARD_VIEW, BOARD_READER, GOOD)
    report = await views.gate("board", "board")
    assert report["ok"], views.gate_lines(report)
    _draft("board", "board", BOARD_VIEW, BOARD_READER.replace("for n, line in enumerate(fh, 1):",
                                                              "for n, line in enumerate([fh.readline()], 1):"), GOOD)
    report = await views.gate("board", "board")
    assert not report["ok"] and any("neither read to the end" in p for p in report["problems"]), report["problems"]
    assert report["draws"] and all(d["ok"] for d in report["draws"])


# ------------------------------------------------------------------------------------------------------ the review


@needs_node
async def test_the_terminal_review_gets_drawings_in_place_of_pictures(timeline, monkeypatch):
    """view_pictures in terminal mode: the overview drawn 120 columns wide, then the states asked for (200 columns,
    the place a ref opens, keys pressed in turn), each with what it shows and the drawing itself, the records its
    program fetched, and no browser; a state of the browser's alone is left out."""
    from app import view_review

    monkeypatch.setattr(view_review.headless, "missing", lambda what: True)
    views._save_proposals(timeline, [{"slug": "timeline", "name": "Timeline", "why": "The events on one axis.",
                                      "claims": ["agents.log"], "status": "built"}])
    views.mark_built(timeline, "timeline")
    more = [{"state": "wide", "why": "the wide panel"},
            {"state": "control", "controls": ["down", "return"], "why": "a row"},
            {"state": "labels", "why": "the browser's alone"}]
    paths, records, reading = await view_review.pictures(timeline, "timeline", "a1", more)
    assert reading == ""
    assert "1: the view as it opens, 120 columns wide\n```\n  Timeline" in paths
    assert "2: the view as it opens, 200 columns wide, asked for: the wide panel" in paths
    assert "3: the view after the keys down return, 120 columns wide, asked for: a row" in paths
    # the row opens in the side pane beside the list, its place a link that asks too
    assert "\n4: " not in paths and "│ deploy started · 02:00:05" in paths.split("\n3: ", 1)[1]
    assert "alerts/" in records
    assert views.read_proposal(timeline, "timeline")["review"]["shots"] == 3
    with prompts.rendering("terminal"):
        assert "drawn as text" in tools.hint("view-pictures", paths=paths, records=records)
