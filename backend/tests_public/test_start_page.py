"""GET /api/workspaces (app/start_page.py): the start page's rows and the top bar's switcher's. A demo dataset is a folder
`thimble demo` put in $THIMBLE_HOME/demo or in a --dir beside its SOURCES.md, or a workspace with the pre-cache's mark,
and is `ready` with the mark; an example is a workspace named example-*, with its view; every other folder is a folder.
A folder that is gone is left out, and the route is a read the page makes without the key's cookie."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, main, precached
from app.demo_data import DATASETS


def register(folder: Path) -> str:
    folder.mkdir(parents=True, exist_ok=True)
    return str(config.register_corpus(folder, exact=True)["name"])


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    home = Path(os.environ["THIMBLE_HOME"])
    ws = config.WORKSPACES_DIR

    # in $THIMBLE_HOME/demo: one with its pre-cache installed, one without
    cw = register(home / "demo" / "collusion-wiki")
    (ws / cw).mkdir(parents=True)
    (ws / cw / precached.MARKER).write_text(json.dumps({"dataset": "collusion-wiki"}))
    register(home / "demo" / "mythos-5")
    # downloaded with --dir: the folder beside the SOURCES.md `thimble demo` writes
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "elsewhere" / "SOURCES.md").write_text("# thimble demo datasets\n")
    register(tmp_path / "elsewhere" / "transluce-urlquery")
    # a pre-cache installed on a folder of another name: the mark names the dataset
    marked = register(tmp_path / "copies" / "wiki-copy")
    (ws / marked).mkdir(parents=True)
    (ws / marked / precached.MARKER).write_text(json.dumps({"dataset": "collusion-wiki"}))
    # a folder that only shares a dataset's name is the analyst's own
    register(tmp_path / "mine" / "mythos-5")
    # an example, with the view `thimble demo --examples` installed
    ex = register(home / "examples" / "example-timeline")
    view = ws / ex / "extension" / "views" / "timeline"
    view.mkdir(parents=True)
    (view / "view.json").write_text(json.dumps({"name": "Timeline", "description": "lanes"}))
    # an example whose view is not installed yet
    register(home / "examples" / "example-bare")
    # the analyst's folders, and one that is gone
    register(tmp_path / "work" / "Logs")
    register(tmp_path / "work" / "alpha")
    gone = tmp_path / "work" / "gone"
    register(gone)
    shutil.rmtree(gone)
    return tmp_path


def test_the_start_page_lists_demo_datasets_examples_and_folders_in_that_order(world):
    rows = TestClient(main.create_app()).get("/api/workspaces").json()
    by_name = {r["name"]: r for r in rows}
    assert [(r["kind"], r["name"]) for r in rows] == [
        ("demo", "collusion-wiki"), ("demo", "wiki-copy"), ("demo", "mythos-5"), ("demo", "transluce-urlquery"),
        ("example", "example-bare"), ("example", "example-timeline"),
        ("folder", "alpha"), ("folder", "Logs"), ("folder", "mythos-5-2"),
    ]
    cw = by_name["collusion-wiki"]
    assert cw["dataset"] == "collusion-wiki" and cw["blurb"] == DATASETS["collusion-wiki"].blurb and cw["ready"] is True
    assert cw["title"] == DATASETS["collusion-wiki"].title and cw["folder"] == "collusion-wiki"
    assert by_name["wiki-copy"]["dataset"] == "collusion-wiki" and by_name["wiki-copy"]["ready"] is True
    assert by_name["mythos-5"]["ready"] is False and by_name["mythos-5"]["blurb"] == DATASETS["mythos-5"].blurb
    assert by_name["transluce-urlquery"]["kind"] == "demo" and by_name["transluce-urlquery"]["ready"] is False
    assert by_name["example-timeline"]["view"] == {"slug": "timeline", "name": "Timeline"}
    assert by_name["example-bare"]["view"] is None
    mine = by_name["mythos-5-2"]
    assert mine["folder"] == "mythos-5" and mine["path"] == str((world / "mine" / "mythos-5").resolve())
    assert "blurb" not in mine and "dataset" not in mine
    assert "gone" not in by_name


@pytest.mark.real_write_guard
def test_the_list_is_a_read_the_page_makes_without_the_key(world, monkeypatch):
    """Like GET /corpora, the list answers a page that holds no cookie yet (the key in its link is claimed after)."""
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    c = TestClient(main.create_app(), base_url="http://testserver")
    r = c.get("/api/workspaces")
    assert r.status_code == 200 and {x["name"] for x in r.json()} >= {"collusion-wiki", "example-timeline", "alpha"}
    assert c.post("/api/workspaces").status_code in (403, 405)


def test_no_workspace_is_an_empty_list(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "empty")
    assert TestClient(main.create_app()).get("/api/workspaces").json() == []
