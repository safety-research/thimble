"""set_layout, main's tool that lays the browser's panes out (panes.py): it names one surface per pane of a preset, a
view by `view:<slug>`, its slug or its name, and reaches the page as the stream's `layout` record; a call that names a
surface there is not, names one twice, or names more or fewer than the preset's panes is refused and sends nothing.
Only main's shim lists it."""
from __future__ import annotations

import json
from pathlib import Path

from app import config, panes, tools, views

CORPUS = "mini"
READER = """
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
"""
PAGE = "<!doctype html><html><body><script>thimble.onOpen(() => {})</script></body></html>"


def _layouts(ws: Path) -> list[dict]:
    p = ws / "investigations" / "main" / "events.jsonl"
    rows = [json.loads(ln) for ln in p.read_text().splitlines() if ln.strip()] if p.is_file() else []
    return [{k: r[k] for k in ("layout", "surfaces")} for r in rows if r.get("type") == "layout"]


def _body(res) -> str:
    return res.text.partition("\n")[2]


async def test_a_layout_names_a_surface_per_pane_and_reaches_the_page_as_a_layout_record(workspaces_tmp):
    ws = config.workspace_dir(CORPUS)
    res = await tools.call(CORPUS, "set_layout", {"layout": "columns", "surfaces": ["Files", " report "]})
    assert not res.is_error, res.text
    assert _body(res) == "The browser shows files and report side by side."
    assert _layouts(ws) == [{"layout": "columns", "surfaces": ["files", "report"]}]


async def test_a_view_is_named_by_its_ref_its_slug_or_its_name(workspaces_tmp):
    views.write_view(CORPUS, "threads", reader=READER, html=PAGE, name="Thread map", why="The board by thread.",
                     claims=["board.jsonl"], accepts=[], declares=[], default=True, libs=[])
    ws = config.workspace_dir(CORPUS)
    assert ("view:threads", "Thread map") in panes.surfaces(CORPUS)
    for given in ("view:threads", "threads", "thread map"):
        res = await tools.call(CORPUS, "set_layout", {"layout": "quadrants", "surfaces": ["files", "canvas", "report", given]})
        assert not res.is_error, (given, res.text)
    assert {tuple(x["surfaces"]) for x in _layouts(ws)} == {("files", "canvas", "report", "view:threads")}


async def test_a_call_that_cannot_be_laid_out_is_refused_and_sends_nothing(workspaces_tmp):
    ws = config.workspace_dir(CORPUS)
    cases = {
        "`layout` must be one of": {"layout": "grid", "surfaces": ["files"]},
        "there is no surface 'chat'": {"layout": "columns", "surfaces": ["files", "chat"]},
        "in one pane at most": {"layout": "columns", "surfaces": ["files", "files"]},
        "quadrants has 4 panes, so name 4; the surfaces are files, canvas, report": {"layout": "quadrants", "surfaces": ["files", "canvas", "report"]},
        "one has 1 pane, so name 1": {"layout": "one", "surfaces": ["files", "report"]},
        "is a list": {"layout": "one", "surfaces": "files"},
    }
    for why, args in cases.items():
        res = await tools.call(CORPUS, "set_layout", args)
        assert res.is_error and why in res.text, (args, res.text)
    assert _layouts(ws) == []


def test_only_main_lists_it_and_its_enum_is_the_presets():
    assert "set_layout" in [t["name"] for t in tools.list("analyst")]
    for session in (tools.ORIENT_SESSION, "writer:report", "critique:orient", "check:verified:report"):
        assert "set_layout" not in [t["name"] for t in tools.list("analyst", session=session)], session
    assert tuple(tools.schema_of("set_layout")["properties"]["layout"]["enum"]) == tuple(panes.PRESETS)
