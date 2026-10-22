"""A label's delete (concepts.delete_concept_route): its files, its card and the filters that name it go, and the top
bar's Undo brings all of them back (undo.label_deleted, concepts.restore_concept), Redo deletes it again. Main's
`delete_label` tool deletes the same way. The regex kind runs for real over the synthetic corpus `mini`."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, labels_store, tools, undo

CORPUS = "mini"
PATTERN = r"(?i)forge pr claim"  # 3 of the 8 board posts match


@pytest.fixture(autouse=True)
def _clean_state(workspaces_tmp):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    undo.forget()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    undo.forget()


@pytest.fixture()
async def api():
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    app.include_router(undo.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


async def _label(api) -> dict:
    """A regex label over the board, applied (which gives it its card), with the Files filter on its `yes`."""
    r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "claims a PR", "kind": "regex", "spec": PATTERN})
    assert r.status_code == 200, r.text
    k = r.json()
    r = await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"paths": ["board.jsonl"], "wait": True})
    assert r.status_code == 200, r.text
    concepts.set_filter(CORPUS, "files", k["id"], "yes")
    return k


def _state(cid: str) -> dict:
    ws = config.workspace_dir(CORPUS)
    cards = concepts._label_cards(ws, cid)
    return {"concept": concepts.read_concept(ws, cid) is not None,
            "rows": concepts.labels_file(ws, cid).is_file(),
            "cards": [cell["id"] for _, cell in cards],
            "filter": concepts.read_filters(ws).get("files")}


async def test_delete_takes_the_label_its_card_and_its_filter_and_undo_brings_them_back(api):
    k = await _label(api)
    cid = k["id"]
    before = _state(cid)
    assert before["concept"] and before["rows"] and len(before["cards"]) == 1
    assert before["filter"] == {"concept": cid, "value": "yes"}
    counts = concepts.with_stats(config.workspace_dir(CORPUS), concepts.read_concept(config.workspace_dir(CORPUS), cid))["counts"]

    r = await api.delete(f"/api/ws/{CORPUS}/concepts/{cid}")
    assert r.status_code == 200, r.text
    assert _state(cid) == {"concept": False, "rows": False, "cards": [], "filter": None}
    assert not labels_store.store_path(concepts.labels_file(config.workspace_dir(CORPUS), cid)).exists()
    assert (await api.get(f"/api/ws/{CORPUS}/undo")).json()["undo"] == "delete label claims a PR"

    r = await api.post(f"/api/ws/{CORPUS}/undo")
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == "delete label claims a PR"
    assert _state(cid) == before, "the label, its rows, its card and its filter are back"
    back = concepts.read_concept(config.workspace_dir(CORPUS), cid)
    assert concepts.with_stats(config.workspace_dir(CORPUS), back)["counts"] == counts
    assert not any((config.workspace_dir(CORPUS) / undo.TRASH_NAME).iterdir()), "the trash folder goes once restored"

    r = await api.post(f"/api/ws/{CORPUS}/redo")
    assert r.status_code == 200, r.text
    assert _state(cid) == {"concept": False, "rows": False, "cards": [], "filter": None}
    r = await api.post(f"/api/ws/{CORPUS}/undo")
    assert r.status_code == 200, r.text
    assert _state(cid) == before


async def test_undo_refuses_when_the_deleted_label_s_files_are_gone(api):
    k = await _label(api)
    await api.delete(f"/api/ws/{CORPUS}/concepts/{k['id']}")
    for d in (config.workspace_dir(CORPUS) / undo.TRASH_NAME).iterdir():
        for f in d.iterdir():
            f.unlink()
    r = await api.post(f"/api/ws/{CORPUS}/undo")
    assert r.status_code == 409
    assert "cannot be restored" in r.json()["detail"]


async def test_a_trash_folder_goes_once_its_step_leaves_the_journal(api, monkeypatch):
    k = await _label(api)
    await api.delete(f"/api/ws/{CORPUS}/concepts/{k['id']}")
    trash = config.workspace_dir(CORPUS) / undo.TRASH_NAME
    assert len(list(trash.iterdir())) == 1
    undo.push(CORPUS, {"kind": "doc", "op": "edited", "target": "report", "label": "edit the report"})
    monkeypatch.setattr(undo, "MAX_STEPS", 1)
    undo._rewrite(CORPUS)
    assert list(trash.iterdir()) == []


async def test_main_s_delete_label_deletes_by_name_and_names_the_labels_for_one_it_does_not_know(api):
    k = await _label(api)
    res = await tools.call(CORPUS, "delete_label", {"name": "nope"}, actor="analyst")
    assert res.is_error and "no label 'nope'" in res.text and "'claims a PR'" in res.text
    res = await tools.call(CORPUS, "delete_label", {"name": "Claims a  PR"}, actor="analyst")
    assert not res.is_error, res.text
    assert "is deleted, with its marks, its card and any filter that used it" in res.text
    assert _state(k["id"]) == {"concept": False, "rows": False, "cards": [], "filter": None}
    assert undo.labels(CORPUS)["undo"] == "delete label claims a PR"


def test_delete_label_is_main_s_alone():
    spec = tools.REGISTRY["delete_label"]
    assert spec.sessions == tools.MAIN_ONLY
    assert "delete_label" in tools.sections()
