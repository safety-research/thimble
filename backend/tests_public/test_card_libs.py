"""app.card_libs: a custom card draws a chart by hand in any library while its frame still loads nothing from the
network. The card names its libraries in `libs`: thimble's own vega, vega-lite and vega-embed, each with what it needs
ahead of it, or an npm package that main installed in the workspace's card-libs folder with its own Bash call (which
Claude Code's permission mode decides; thimble installs nothing). add_card bundles that package there with its version
and hash, and the frame's head inlines the libraries, in the browser (GET /ws/{c}/card-libs) and in the card harness's
request (render.request_for).

The install is faked as in test_view_libs; esbuild is the frontend's own."""
from __future__ import annotations

import hashlib
import re
import shutil

import pytest
from fastapi.testclient import TestClient
from test_view_libs import install, no_npm  # noqa: F401 — the fixture, used by name

from app import card_libs, cli, config, notebook, render, subagents, tools, view_libs, views

CORPUS = "mini"

needs_vega = pytest.mark.skipif(not all(p.is_file() for p in views.LIBS.values()), reason="needs the frontend's vega builds")


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst")


def _cid(res) -> str:
    assert not res.is_error, res.text
    return re.search(r"^card:([A-Za-z0-9_-]+)$", res.text, re.M).group(1)  # its own line, not a reminder's


@needs_vega
async def test_a_card_naming_vega_embed_gets_thimble_s_vega_builds_in_order(workspaces_tmp):
    res = await call("add_card", kind="custom", question="Runs per day", html="<div id=c></div>", libs=["vega-embed"])
    cell = notebook.get_cell(CORPUS, _cid(res))
    assert cell["payload"] == {"html": "<div id=c></div>", "libs": ["vega-embed"]}
    got = card_libs.head(CORPUS, cell["payload"]["libs"])
    assert got["problems"] == []
    assert got["head"] == "".join(f"<script>{views._script_text(p.read_text('utf-8'))}</script>"
                                  for p in (views.LIBS["vega"], views.LIBS["vega-lite"], views.LIBS["vega-embed"]))
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as client:
        r = client.get(f"/api/ws/{CORPUS}/card-libs", params={"libs": card_libs.key(cell["payload"]["libs"])})
    assert r.status_code == 200 and r.json() == got
    assert "libs: vega-embed" in (await call("read_ref", ref=f"card:{cell['id']}")).text
    # the card harness carries the same head, which its page answers the frame's fetch with (render.tsx)
    req = render.request_for(CORPUS, cell)
    assert req["cardLibs"] == {"vega-embed": got}
    assert "cardLibs" not in render.request_for(CORPUS, {**cell, "payload": {"html": "<p>x</p>"}})


async def test_main_installs_a_package_in_card_libs_and_add_card_bundles_it_with_its_version_and_hash(workspaces_tmp,
                                                                                                    no_npm):
    folder = config.workspace_path(CORPUS) / card_libs.FOLDER
    assert folder in cli.write_dirs(CORPUS) and folder in subagents.write_dirs(CORPUS), "main's Bash installs there"
    res = await call("add_card", kind="custom", question="Graph", html="<svg id=g></svg>", libs=["tiny-graph@2"])
    assert res.is_error and "add_card: " + view_libs.NOT_INSTALLED.format(name="tiny-graph", where=folder, raw="tiny-graph@2") in res.text
    assert f"cd {folder} && npm install --ignore-scripts --cache .npm-cache tiny-graph@2" in res.text

    install(folder, "tiny-graph", "default-only")  # main's `npm install` there
    graph = _cid(await call("add_card", kind="custom", question="Graph", html="<svg id=g></svg>", libs=["tiny-graph@2"]))
    item = view_libs.lock(folder)["tiny-graph@2"]
    bundle = folder / view_libs.LIB_DIR / item["file"]
    assert item["version"] == "2.1.0" and item["sha256"] == hashlib.sha256(bundle.read_bytes()).hexdigest()
    other = _cid(await call("add_card", kind="custom", question="Draw", html="<p>d</p>", libs=["default-only@0.3.0"]))
    assert set(view_libs.lock(folder)) == {"tiny-graph@2", "default-only@0.3.0"}, "one card's package keeps another's"
    assert not [c for c in no_npm if c and c[0].endswith("npm")], "thimble installs nothing itself"

    shutil.rmtree(folder / "node_modules")  # the bundles are what the frames load: the card draws without the install
    got = card_libs.head(CORPUS, notebook.get_cell(CORPUS, graph)["payload"]["libs"])
    assert got["problems"] == [] and "window.__thimbleLibs" in got["head"] and "tinyGraph" in got["head"]
    assert "default-only" not in got["head"]

    # edit_card changes the html alone and keeps the libraries, or the libraries alone and keeps the html
    assert not (await call("edit_card", card=f"card:{other}", html="<p>e</p>")).is_error
    assert notebook.get_cell(CORPUS, other)["payload"] == {"html": "<p>e</p>", "libs": ["default-only@0.3.0"]}
    assert not (await call("edit_card", card=f"card:{other}", libs=["tiny-graph@2"])).is_error
    assert notebook.get_cell(CORPUS, other)["payload"] == {"html": "<p>e</p>", "libs": ["tiny-graph@2"]}

    bundle.write_text(bundle.read_text("utf-8") + "\nwindow.changed = 1;")  # bytes that are not the ones it was made of
    got = card_libs.head(CORPUS, ["tiny-graph@2"])
    assert got["problems"] == [f"the library tiny-graph@2 is not bundled in {folder / view_libs.LIB_DIR}"]
    assert "window.changed" not in got["head"] and "console.error" in got["head"]


async def test_libs_that_name_no_library_are_refused(workspaces_tmp):
    res = await call("add_card", kind="custom", question="Q", html="<p>x</p>", libs=["not a package!"])
    assert res.is_error and "neither vega, vega-lite, vega-embed nor an npm package" in res.text
