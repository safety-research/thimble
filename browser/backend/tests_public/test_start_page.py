"""GET /api/workspaces (app/start_page.py): the start page's rows and the top bar's switcher's. Every folder is a row
labeled by its own name, in the order of those names, with the names its workspace was renamed from. A folder that is
gone is left out, and the route is a read the page makes without the key's cookie."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, main


def register(folder: Path, name: str | None = None) -> str:
    folder.mkdir(parents=True, exist_ok=True)
    return str(config.register_corpus(folder, exact=True, name=name)["name"])


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    register(tmp_path / "work" / "Logs")
    register(tmp_path / "work" / "alpha")
    register(tmp_path / "mine" / "runs")
    config.rename_corpus("runs", "runs-renamed")
    gone = tmp_path / "work" / "gone"
    register(gone)
    shutil.rmtree(gone)
    return tmp_path


def test_the_start_page_lists_each_folder_by_its_name_with_the_names_it_was_renamed_from(world):
    rows = TestClient(main.create_app()).get("/api/workspaces").json()
    by_name = {r["name"]: r for r in rows}
    assert [(r["kind"], r["label"]) for r in rows] == [("folder", "alpha"), ("folder", "Logs"), ("folder", "runs")]
    renamed = by_name["runs-renamed"]
    assert renamed["folder"] == "runs" and renamed["path"] == str((world / "mine" / "runs").resolve())
    assert renamed["renamed_from"] == ["runs"] and by_name["alpha"]["renamed_from"] == []
    assert "gone" not in by_name


@pytest.mark.real_write_guard
def test_the_list_is_a_read_the_page_makes_without_the_key(world, monkeypatch):
    """Like GET /corpora, the list answers a page that holds no cookie yet (the key in its link is claimed after)."""
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    c = TestClient(main.create_app(), base_url="http://testserver")
    r = c.get("/api/workspaces")
    assert r.status_code == 200 and {x["name"] for x in r.json()} >= {"runs-renamed", "alpha"}
    assert c.post("/api/workspaces").status_code in (403, 405)


def test_no_workspace_is_an_empty_list(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "empty")
    assert TestClient(main.create_app()).get("/api/workspaces").json() == []
