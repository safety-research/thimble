"""A demo workspace is read-only on the server (app/demo_guard.py, bug hunt F5): a browser page's delete of a pre-cached
card is refused and the card stays, while what only reads or shows (a view's records, a filter, a label's switch) goes
on; thimble's own CLI, and a workspace a session attached to, write as before."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import agents, config, demo_guard, notebook, precached

CORPUS = "mini"
PAGE = {"Origin": "http://127.0.0.1", "Sec-Fetch-Site": "same-origin"}  # what a browser page's fetch carries


@pytest.fixture()
def client(workspaces_tmp):
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _card(title: str) -> str:
    cell = notebook.new_cell("note", "model", title, notebook=notebook.MAIN, payload={"text": title})
    notebook.insert_cell(CORPUS, notebook.MAIN, cell)
    return cell["id"]


def _ids() -> list[str]:
    return [c["id"] for c in notebook.load_notebook(CORPUS, notebook.MAIN)["cells"]]


def test_f5_a_demo_workspace_refuses_a_browser_page_s_delete_and_keeps_the_card(client):
    ws = config.workspace_dir(CORPUS)
    (ws / precached.MARKER).write_text(json.dumps({"dataset": "made-up-wiki"}), "utf-8")
    keep = _card("Which pages did the bots edit?")
    assert demo_guard.is_demo(CORPUS)
    r = client.delete(f"/api/ws/{CORPUS}/cells/{keep}", headers=PAGE)
    assert r.status_code == 403 and r.json() == {"detail": demo_guard.DEMO_REFUSED, "demo": True}
    r = client.put(f"/api/ws/{CORPUS}/cells/{keep}", headers=PAGE, json={"title": "Renamed"})
    assert r.status_code == 403
    assert _ids() == [keep], "the pre-cached card is still there"
    # what only reads or shows goes on: a filter, and a label's switch that only shows it
    concept = client.post(f"/api/ws/{CORPUS}/concepts", json={"name": "bot edits", "kind": "regex", "spec": "bot",
                                                                "labels": ["yes", "no"]}).json()
    assert client.put(f"/api/ws/{CORPUS}/concepts/{concept['id']}", headers=PAGE, json={"shown": True}).status_code == 200
    renamed = client.put(f"/api/ws/{CORPUS}/concepts/{concept['id']}", headers=PAGE, json={"name": "other", "shown": True})
    assert renamed.status_code == 403
    assert client.delete(f"/api/ws/{CORPUS}/concepts/{concept['id']}", headers=PAGE).status_code == 403
    assert client.delete(f"/api/ws/{CORPUS}/filters/files", headers=PAGE).status_code != 403
    # thimble's CLI (no browser headers), as `thimble demo --examples` defines labels, writes as before
    assert client.delete(f"/api/ws/{CORPUS}/concepts/{concept['id']}").status_code == 200
    # once a session attached, the workspace is the analyst's
    meta = agents.ensure_main(CORPUS)
    meta["attached"] = {"session": "7e000000-0000-4000-8000-0000000000f5", "cwd": str(config.corpus_dir(CORPUS))}
    agents.write_meta(CORPUS, meta)
    assert not demo_guard.is_demo(CORPUS)
    assert client.delete(f"/api/ws/{CORPUS}/cells/{keep}", headers=PAGE).status_code == 200
    assert _ids() == []
