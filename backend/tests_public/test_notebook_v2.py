"""The canvas shape of app.notebook: card kinds and payloads, groups with their tree fields, the canvas route, roles,
moves, and layout fields that are not edits.

No kernel is started here except where a run is the behavior under test; data cells never run at all.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from app import config, notebook, refs

RUNNABLE_FIELDS = {"code", "outputs", "status", "exec_count"}
EVERY_CELL = {"id", "notebook", "kind", "title", "takeaway", "takeaway_author", "labels", "locked", "created_by",
              "created_at_event", "edited", "created_ts", "ts", "width", "height", "pos", "starred"}


@pytest.fixture()
def corpus(workspaces_tmp) -> str:
    return "mini"


@pytest.fixture(autouse=True)
async def _kernels_down():
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(notebook.router, prefix="/api")
    return a


@pytest.fixture()
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"] if "_stream" in b)


# ----------------------------------------------------------------------------------------------------------
# cell kinds and payloads


def test_new_cell_shapes_per_kind():
    code = notebook.new_cell("code", "chat:c1", "How many?", "nb1", code="print(1)", created_at_event=7)
    assert code["kind"] == "code" and code["code"] == "print(1)" and code["status"] == "idle" and code["outputs"] == []
    assert code["created_by"] == "chat:c1" and code["created_at_event"] == 7 and code["labels"] == []
    assert code["takeaway"] == "" and code["takeaway_author"] is None and "payload" not in code
    assert set(code) == EVERY_CELL | RUNNABLE_FIELDS
    for kind in ("plot", "table"):
        assert notebook.runnable(notebook.new_cell(kind, "u", "q", "nb1", code="df"))
    note = notebook.new_cell("note", "u", "", "nb1", payload={"text": "Why [[events.jsonl#L1]]?"})
    assert note["payload"] == {"text": "Why [[events.jsonl#L1]]?"} and note["text"] == note["payload"]["text"]
    assert not notebook.runnable(note) and not (RUNNABLE_FIELDS & set(note))
    assert set(note) == EVERY_CELL | {"payload", "text"}
    example = notebook.new_cell("example", "u", "One", "nb1", payload={"refs": ["[[events.jsonl#L1]]", " board.jsonl#L2 ", ""]})
    assert example["payload"] == {"refs": ["events.jsonl#L1", "board.jsonl#L2"]}
    assert notebook.new_cell("example", "u", "One", "nb1", payload={"refs": "events.jsonl#L1"})["payload"]["refs"] == ["events.jsonl#L1"]
    label = notebook.new_cell("label", "u", "Admin", "nb1", payload={"concept": "abcd1234"})
    assert label["payload"] == {"concept": "abcd1234"} and label["labels"] == ["abcd1234"]
    custom = notebook.new_cell("custom", "u", "", "nb1", payload={"html": "<b>x</b>", "height": 200})
    assert custom["payload"] == {"html": "<b>x</b>", "height": 200}  # other keys ride along
    # a diagram or a timeline is runnable with code and a data cell with a dataset
    assert notebook.runnable(notebook.new_cell("diagram", "u", "q", "nb1", code="svg"))
    tl = notebook.new_cell("timeline", "u", "When?", "nb1", payload={"dataset": {"events": []}})
    assert not notebook.runnable(tl) and tl["payload"] == {"dataset": {"events": []}}
    assert notebook.new_cell("diagram", "u", "q", "nb1")["payload"] == {"dataset": None}
    # every kind is runnable or a data kind
    assert set(notebook.RUNNABLE_KINDS) | set(notebook.DATA_KINDS) == set(notebook.CELL_KINDS)
    # what does not fit
    for kind, kw in (("md", {}), ("note", {"code": "1"}), ("plot", {"payload": {"x": 1}}), ("diagram", {"code": "1", "payload": {"dataset": 1}})):
        with pytest.raises(ValueError):
            notebook.new_cell(kind, "u", "q", "nb1", **kw)


async def test_note_cell_shape_and_sse(client, corpus):
    nb = (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "N"})).json()["id"]
    q: asyncio.Queue = asyncio.Queue()
    notebook._subscribers.setdefault((corpus, nb), set()).add(q)
    try:
        r = await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells",
                              json={"kind": "note", "payload": {"text": "The peak is [[3|events.jsonl#L1]]."}})
        assert r.status_code == 200
        cell = r.json()
        assert cell["kind"] == "note" and cell["payload"] == {"text": "The peak is [[3|events.jsonl#L1]]."}
        assert cell["text"] == cell["payload"]["text"]  # the legacy field mirrors the payload
        assert cell["notebook"] == nb and len(cell["id"]) == 8 and cell["created_by"] == "user"
        assert cell["locked"] is False and cell["edited"] == [] and cell["created_at_event"] is None and cell["labels"] == []
        assert not (RUNNABLE_FIELDS & set(cell)), cell
        emitted = json.loads(q.get_nowait())
        assert emitted["id"] == cell["id"] and emitted["kind"] == "note"
    finally:
        notebook._subscribers[(corpus, nb)].discard(q)
    on_disk = json.loads((config.WORKSPACES_DIR / corpus / "notebooks" / f"{nb}.json").read_text())
    assert on_disk["cells"][0]["kind"] == "note" and "code" not in on_disk["cells"][0]
    # a data kind without a payload gets the empty one; `after` places a cell
    ex = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "example", "title": "One"})).json()
    assert ex["payload"] == {"refs": []}
    mid = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "code", "code": "1", "after": cell["id"]})).json()
    assert mid["kind"] == "code" and mid["status"] == "idle"
    ids = [c["id"] for c in (await client.get(f"/api/ws/{corpus}/notebooks/{nb}")).json()["cells"]]
    assert ids == [cell["id"], mid["id"], ex["id"]]
    # a kind outside the list is a 422; a mismatch of kind and content a 400
    assert (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "md", "payload": {"text": "t"}})).status_code == 422
    assert (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "note", "code": "1+1"})).status_code == 400
    assert (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "plot", "payload": {"x": 1}})).status_code == 400
    assert (await client.post(f"/api/ws/{corpus}/notebooks/nope/cells", json={"kind": "note"})).status_code == 404


async def test_data_cells_do_not_run(client, corpus):
    nb = (await client.post(f"/api/ws/{corpus}/notebooks", json={})).json()["id"]
    note = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "note", "payload": {"text": "prose"}})).json()
    tl = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "timeline", "payload": {"dataset": {"events": []}}})).json()
    for cid in (note["id"], tl["id"]):
        r = await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells/{cid}/run")
        assert r.status_code == 400 and "no code to run" in r.json()["detail"]
        assert (await client.post(f"/api/ws/{corpus}/cells/{cid}/run")).status_code == 400
    with pytest.raises(HTTPException) as e:
        await notebook.run_code(corpus, "print(1)", "chat:x", replace=note["id"])
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        await notebook.edit_and_run(corpus, nb, note["id"], "1", by="chat:x")
    assert e.value.status_code == 400
    with pytest.raises(ValueError):
        await notebook.run_code(corpus, "print(1)", "chat:x", kind="note")
    assert (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/run", json={"code": "1", "kind": "note"})).status_code == 422
    assert (await client.post(f"/api/ws/{corpus}/cells/nope1234/run")).status_code == 404


async def test_put_edits_payload_code_title_takeaway_and_lock(client, corpus):
    nb = (await client.post(f"/api/ws/{corpus}/notebooks", json={})).json()["id"]
    note = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "note", "payload": {"text": "v1"}})).json()
    code = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"code": "1", "title": "q"})).json()
    # a payload on a runnable cell and code on a data cell are 400
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{nb}/cells/{note['id']}", json={"code": "x"})).status_code == 400
    assert (await client.put(f"/api/ws/{corpus}/cells/{code['id']}", json={"payload": {"text": "x"}})).status_code == 400
    # the payload changes and the text mirror follows; the edit is recorded
    r = await client.put(f"/api/ws/{corpus}/notebooks/{nb}/cells/{note['id']}", json={"payload": {"text": "v2"}, "title": "Why?"})
    cell = r.json()
    assert cell["payload"] == {"text": "v2"} and cell["text"] == "v2" and cell["title"] == "Why?"
    assert len(cell["edited"]) == 1 and cell["edited"][0]["by"] == "user"
    # the same payload again is not an edit; the cell-addressed route edits the same cell
    r = await client.put(f"/api/ws/{corpus}/cells/{note['id']}", json={"payload": {"text": "v2"}, "by": "chat:c1"})
    assert len(r.json()["edited"]) == 1
    r = await client.put(f"/api/ws/{corpus}/cells/{note['id']}", json={"payload": {"text": "v3"}, "by": "chat:c1"})
    assert [e["by"] for e in r.json()["edited"]] == ["user", "chat:c1"] and r.json()["text"] == "v3"
    # a takeaway on any cell is the analyst's; clearing it clears the author; `locked` is set only when asked
    r = await client.put(f"/api/ws/{corpus}/cells/{note['id']}", json={"takeaway": "A thought.", "locked": True})
    assert r.json()["takeaway"] == "A thought." and r.json()["takeaway_author"] == "analyst" and r.json()["locked"] is True
    r = await client.put(f"/api/ws/{corpus}/cells/{note['id']}", json={"takeaway": ""})
    assert r.json()["takeaway"] == "" and r.json()["takeaway_author"] is None and r.json()["locked"] is True
    r = await client.put(f"/api/ws/{corpus}/cells/{code['id']}", json={"code": "2"})
    assert r.json()["code"] == "2" and r.json()["locked"] is False
    # a label card's labels follow its concept
    label = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "label", "payload": {"concept": "aaaa0001"}})).json()
    assert label["labels"] == ["aaaa0001"]
    assert (await client.put(f"/api/ws/{corpus}/cells/{label['id']}", json={"payload": {"concept": "bbbb0002"}})).json()["labels"] == ["bbbb0002"]
    # the cell-addressed GET and DELETE
    assert (await client.get(f"/api/ws/{corpus}/cells/{note['id']}")).json()["id"] == note["id"]
    assert (await client.get(f"/api/ws/{corpus}/cells/nope1234")).status_code == 404
    assert (await client.delete(f"/api/ws/{corpus}/cells/{note['id']}")).json() == {"ok": True}
    assert (await client.delete(f"/api/ws/{corpus}/cells/{note['id']}")).status_code == 404
    assert (await client.put(f"/api/ws/{corpus}/cells/{note['id']}", json={"title": "x"})).status_code == 404
    # a cell is addressed through its own group on the group routes
    assert (await client.put(f"/api/ws/{corpus}/notebooks/main/cells/{code['id']}", json={"title": "x"})).status_code == 404
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/main/cells/{code['id']}")).status_code == 404


async def test_takeaway_lands_on_a_data_cell_too(client, corpus):
    nb = (await client.post(f"/api/ws/{corpus}/notebooks", json={})).json()["id"]
    note = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "note", "payload": {"text": "prose"}})).json()
    assert notebook.append_takeaway(corpus, note["id"], "a takeaway", author="model") is True
    cell = notebook.get_cell(corpus, note["id"])
    assert cell["takeaway"] == "a takeaway" and cell["takeaway_author"] == "model"


async def test_note_ref_resolves_to_its_text(client, corpus):
    nb = (await client.post(f"/api/ws/{corpus}/notebooks", json={})).json()["id"]
    text = "Spike of [[3|events.jsonl#L1]] admin actions; see [[events.jsonl#L2]]."
    note = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "note", "payload": {"text": text}})).json()
    assert refs.extract_refs(note["payload"]["text"]) == ["events.jsonl#L1", "events.jsonl#L2"]
    got = refs.resolve(config.corpus_dir(corpus), f"card:{note['id']}")
    assert got["kind"] == "cell" and got["notebook"] == nb  # the excerpt is refs._cell_excerpt's reading of the payload


async def test_labels_are_the_ones_the_code_read_when_a_cell_runs(corpus):
    """`labels` names the labels the code read through thimble.labels, as the kernel noted them during the run
    (kernel_thimble._labels_read, notebook.LABELS_EXPR): a label named through a variable counts, a label's name in a
    string the code never calls with does not, a listing of every label reads none, and a re-run that reads none, or
    raises before its expression runs, stores []. `label_revs` keeps the revision of each label as the run read it."""
    ws = config.workspace_dir(corpus)
    (ws / "concepts").mkdir(parents=True, exist_ok=True)
    for cid, name, rev in (("conc0001", "admin actions", 4), ("conc0002", "Late", 0)):
        (ws / "concepts" / f"{cid}.json").write_text(json.dumps({"id": cid, "name": name, "labels": ["yes", "no"], "ts": cid,
                                                                 "rev": rev}))
    code = ("import thimble\nname = 'late'\nnote = 'thimble.labels(\"admin actions\")'\n"
            "a = thimble.labels(name)\nb = thimble.labels('conc0001')\nc = thimble.labels('Late')\nthimble.labels()\nprint(len(a))")
    cell = await notebook.run_code(corpus, code, "chat:c1", title="Which labels?")
    assert cell["status"] == "ok", cell["outputs"]
    assert cell["labels"] == ["conc0002", "conc0001"] and cell["label_revs"] == {"conc0002": 0, "conc0001": 4}
    assert notebook.get_cell(corpus, cell["id"])["labels"] == ["conc0002", "conc0001"]
    again = await notebook.run_code(corpus, "print('thimble.labels(\"Late\")')", "chat:c1", replace=cell["id"])
    assert again["labels"] == [] and again["label_revs"] == {}
    failed = await notebook.run_code(corpus, "import thimble\nthimble.labels('Late')\nraise ValueError('x')", "chat:c1", replace=cell["id"])
    assert failed["status"] == "error" and failed["labels"] == []
    after = await notebook.run_code(corpus, "print(1)", "chat:c1", replace=cell["id"])
    assert after["labels"] == [], "a run that raised leaves nothing noted for the next"


def test_labels_read_reads_the_kernel_expression():
    """notebook.labels_read: the JSON list of {id, rev} kernel_thimble._labels_read sends, as {id: rev} in the order
    read; a bare id from a kernel of an earlier thimble has no revision; {} for a failed or missing expression."""
    ok = {"status": "ok", "data": {"text/plain": '[{"id": "conc0001", "rev": 3}, {"id": "conc0002", "rev": 0}]'}}
    assert list(notebook.labels_read(ok).items()) == [("conc0001", 3), ("conc0002", 0)]
    old = {"status": "ok", "data": {"text/plain": '["conc0001", "conc0002"]'}}
    assert notebook.labels_read(old) == {"conc0001": None, "conc0002": None}
    assert notebook.labels_read({"status": "error", "ename": "AttributeError"}) == {}
    assert notebook.labels_read(None) == {}
    assert notebook.labels_read({"status": "ok", "data": {"text/plain": "'[]'"}}) == {}


# ----------------------------------------------------------------------------------------------------------
# legacy reads


LEGACY_FILE = {
    "id": "legacy01",
    "title": "Old notebook",
    "ts": "2026-09-01T00:00:00+00:00",
    "cells": [
        {"id": "aaaa1111", "notebook": "legacy01", "code": "print('x')", "title": "q?", "slug": "", "answer": "",
         "takeaway": "t [[events.jsonl#L1]]", "exec_count": 1, "status": "ok", "hidden_code": None,
         "outputs": [{"text/plain": "x\n", "_stream": "stdout"}], "created_by": "user",
         "created_at_event": None, "edited": [], "created_ts": "2026-09-01T00:00:00+00:00",
         "ts": "2026-09-01T00:00:00+00:00"},
        {"id": "bbbb2222", "notebook": "legacy01", "kind": "md", "text": "# notes", "slug": "", "locked": False,
         "created_by": "user", "created_at_event": None, "edited": [], "created_ts": "2026-09-01T00:00:00+00:00",
         "ts": "2026-09-01T00:00:00+00:00"},
    ],
}


async def test_odd_stored_values_are_normalized(client, corpus, workspaces_tmp):
    d = workspaces_tmp / corpus / "notebooks"
    d.mkdir(parents=True)
    (d / "odd1.json").write_text(json.dumps({"id": "odd1", "title": "T", "ts": "2026-09-01T00:00:00+00:00", "role": "scratch",
                                             "kind": "columns", "parent": 3, "investigation": 7, "finding": "two",
                                             "cells": [{"id": "c1", "kind": "plot", "payload": {"x": 1}, "code": "df"},
                                                       {"id": "c2", "kind": "label", "payload": {"concept": "k1"}},
                                                       {"id": "c3", "kind": "diagram", "payload": {"dataset": [1]}}]}))
    nb = (await client.get(f"/api/ws/{corpus}/notebooks/odd1")).json()
    assert nb["role"] == "analyst" and nb["kind"] == "sequence" and nb["parent"] is None
    assert nb["investigation"] is None and nb["finding"] is None
    c1, c2, c3 = nb["cells"]
    assert c1["kind"] == "plot" and "payload" not in c1 and c1["status"] == "idle" and c1["outputs"] == []
    assert c2["labels"] == ["k1"] and c2["payload"] == {"concept": "k1"}
    assert c3["payload"] == {"dataset": [1]} and not notebook.runnable(c3)


async def test_notebook_roles_created_listed_and_defaulted(client, corpus):
    r = await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "F1", "role": "exploration", "investigation": "abcd1234"})
    assert r.status_code == 200
    row = r.json()
    assert row["role"] == "exploration" and row["investigation"] == "abcd1234"
    r = await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "Mine"})
    assert r.json()["role"] == "analyst" and r.json()["kind"] == "sequence" and r.json()["parent"] is None
    rows = {s["id"]: s for s in (await client.get(f"/api/ws/{corpus}/notebooks")).json()}
    assert rows[row["id"]]["role"] == "exploration"
    assert all({"role", "kind", "parent", "anchor", "chat", "n_cells"} <= set(s) for s in rows.values())


async def test_role_or_kind_outside_the_lists_is_rejected(client, corpus):
    assert (await client.post(f"/api/ws/{corpus}/notebooks", json={"role": "scratch"})).status_code == 422
    assert (await client.post(f"/api/ws/{corpus}/notebooks", json={"kind": "columns"})).status_code == 422
    with pytest.raises(ValueError):
        notebook.create_notebook(config.workspace_dir(corpus), role="scratch")
    with pytest.raises(ValueError):
        notebook.create_notebook(config.workspace_dir(corpus), kind="columns")
    with pytest.raises(ValueError):
        notebook.create_notebook(config.workspace_dir(corpus), parent="nope1234")


async def test_group_tree_fields_on_post_and_put(client, corpus):
    top = (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "Orientation", "kind": "split", "role": "exploration"})).json()
    assert top["kind"] == "split" and top["parent"] is None
    child = (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "Timeline", "parent": top["id"], "role": "exploration"})).json()
    assert child["parent"] == top["id"] and child["kind"] == "sequence" and child["role"] == "exploration"
    assert (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "Scratch", "role": "working"})).status_code == 422, \
        "no group is made working any more"
    assert (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "x", "parent": "nope1234"})).status_code == 404
    # the record carries anchor and chat when made in Python (a thread's group beside its card)
    ws = config.workspace_dir(corpus)
    cell = notebook.insert_cell(corpus, top["id"], notebook.new_cell("note", "orient", "", top["id"], payload={"text": "t"}))
    thread = notebook.create_notebook(ws, "main/why", role="analyst", parent=top["id"], anchor=cell["id"], chat="ab12cd34")
    got = (await client.get(f"/api/ws/{corpus}/notebooks/{thread['id']}")).json()
    assert (got["parent"], got["anchor"], got["chat"], got["kind"]) == (top["id"], cell["id"], "ab12cd34", "sequence")
    # PUT moves, renames and re-kinds; null parent goes to the root; a cycle is a 400; an unknown parent a 404
    r = await client.put(f"/api/ws/{corpus}/notebooks/{child['id']}", json={"parent": None, "title": "Loose", "kind": "split"})
    assert r.status_code == 200 and (r.json()["parent"], r.json()["title"], r.json()["kind"]) == (None, "Loose", "split")
    r = await client.put(f"/api/ws/{corpus}/notebooks/{child['id']}", json={"parent": top["id"]})
    assert r.json()["parent"] == top["id"]
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{top['id']}", json={"parent": child["id"]})).status_code == 400
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{top['id']}", json={"parent": top["id"]})).status_code == 400
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{top['id']}", json={"parent": "nope1234"})).status_code == 404
    r = await client.put(f"/api/ws/{corpus}/notebooks/{top['id']}", json={"title": "Orientation 2"})
    assert r.json()["title"] == "Orientation 2" and r.json()["parent"] is None  # an omitted parent is left alone


async def test_canvas_lists_groups_in_tree_order_with_their_cells(client, corpus):
    ws = config.workspace_dir(corpus)
    top = notebook.create_notebook(ws, "Orientation", role="exploration", kind="split")
    scratch = notebook.create_notebook(ws, "Scratch", role="exploration", parent=top["id"])
    final = notebook.create_notebook(ws, "Final", role="exploration", parent=top["id"])
    mine = notebook.create_notebook(ws, "Your work", role="analyst")
    figs = notebook.create_notebook(ws, "Report figures", role=notebook.FIGURES_ROLE)
    s1 = notebook.insert_cell(corpus, scratch["id"], notebook.new_cell("code", "orient", "s?", scratch["id"], code="1"))
    f1 = notebook.insert_cell(corpus, final["id"], notebook.new_cell("note", "orient", "", final["id"], payload={"text": "f"}))
    f2 = notebook.insert_cell(corpus, final["id"], notebook.new_cell("table", "orient", "f?", final["id"], code="df"))
    m1 = notebook.insert_cell(corpus, mine["id"], notebook.new_cell("code", "user", "m?", mine["id"], code="2"))
    notebook.insert_cell(corpus, figs["id"], notebook.new_cell("plot", "figures", "fig", figs["id"], code="plt"))
    thread = notebook.create_notebook(ws, "main/why", role="analyst", parent=final["id"], anchor=f2["id"], chat="ab12cd34")
    t1 = notebook.insert_cell(corpus, thread["id"], notebook.new_cell("code", "chat:ab12cd34", "t?", thread["id"], code="3"))

    r = await client.get(f"/api/ws/{corpus}/canvas")
    assert r.status_code == 200
    doc = r.json()
    assert set(doc) == {"groups", "cells", "hidden"} and doc["hidden"] == [], "no old Scratch, so nothing is left out"
    # tree order: each root oldest first, followed by its subtree; the figures group is not in
    assert [g["title"] for g in doc["groups"]] == ["Orientation", "Scratch", "Final", "main/why", "Your work"]
    by_id = {g["id"]: g for g in doc["groups"]}
    assert by_id[top["id"]]["kind"] == "split" and by_id[top["id"]]["n_cells"] == 0
    assert by_id[scratch["id"]]["parent"] == top["id"] and by_id[scratch["id"]]["n_cells"] == 1
    assert (by_id[thread["id"]]["parent"], by_id[thread["id"]]["anchor"], by_id[thread["id"]]["chat"]) == (final["id"], f2["id"], "ab12cd34")
    assert [c["id"] for c in doc["cells"]] == [s1["id"], f1["id"], f2["id"], t1["id"], m1["id"]]
    assert [c["kind"] for c in doc["cells"]] == ["code", "note", "table", "code", "code"]
    # the browser's list leaves the figures group out; the Python default keeps it
    listed = [g["id"] for g in (await client.get(f"/api/ws/{corpus}/notebooks")).json()]
    assert set(listed) == {top["id"], scratch["id"], final["id"], mine["id"], thread["id"]}
    assert figs["id"] in [g["id"] for g in notebook.list_notebooks(ws)]
    assert (await client.get(f"/api/ws/{corpus}/notebooks/{scratch['id']}")).status_code == 200
    assert (await client.get(f"/api/ws/{corpus}/notebooks/{figs['id']}")).status_code == 200
    assert notebook.canvas(ws) == doc


def test_tree_order_handles_orphans_and_cycles():
    rows = [{"id": "a", "ts": "1", "parent": None}, {"id": "b", "ts": "2", "parent": "a"}, {"id": "c", "ts": "0", "parent": "zz"},
            {"id": "d", "ts": "3", "parent": "e"}, {"id": "e", "ts": "4", "parent": "d"}, {"id": "f", "ts": "1.5", "parent": "a"}]
    assert [r["id"] for r in notebook.tree_order(rows)] == ["c", "a", "f", "b", "d", "e"]
    assert notebook.tree_order([]) == []


async def test_a_figures_group_is_read_by_the_pipeline_and_cited_but_never_listed_to_the_browser(client, corpus):
    ws = config.workspace_dir(corpus)
    figs = notebook.create_notebook(ws, "figs", role=notebook.FIGURES_ROLE)
    legacy = notebook.create_notebook(ws, notebook.LEGACY_FIGURES_TITLE, role="finding")
    for nb, cid in ((figs, "fig00001"), (legacy, "leg00001")):
        cell = notebook.new_cell("plot", "figures", "How many?", nb["id"], code="1")
        cell.update(id=cid, status="ok", outputs=[{"text/plain": "3"}], exec_count=1)
        notebook.insert_cell(corpus, nb["id"], cell)
    assert notebook.is_figures(figs) and notebook.is_figures(legacy) and not notebook.is_figures({"role": "analyst"})
    assert (await client.get(f"/api/ws/{corpus}/notebooks")).json() == []
    assert [g["id"] for g in notebook.list_notebooks(ws)] == [figs["id"], legacy["id"]]
    assert notebook.list_notebooks(ws, figures=False) == []
    rows = (await client.get(f"/api/ws/{corpus}/cells/names")).json()
    assert {x["id"]: (x["notebook"], x["kind"]) for x in rows} == {"fig00001": (figs["id"], "plot"), "leg00001": (legacy["id"], "plot")}
    assert refs.resolve(config.corpus_dir(corpus), "card:fig00001")["meta"]["notebook"] == figs["id"]


async def test_cell_names_lists_every_cell_without_outputs(client, corpus):
    ws = config.workspace_dir(corpus)
    nb = notebook.create_notebook(ws, "Exploration", role="exploration")
    c1 = notebook.new_cell("table", "t", "How many rows are there?", nb["id"], code="1")
    c1.update(id="cn000001", status="ok", outputs=[{"text/plain": "840" * 1000}], exec_count=3)
    note = notebook.new_cell("note", "t", "", nb["id"], payload={"text": "# notes"})
    note["id"] = "cn000002"
    nb["cells"] = [c1, note]
    notebook.write_notebook(ws, nb)
    rows = (await client.get(f"/api/ws/{corpus}/cells/names")).json()
    assert [(x["id"], x["kind"]) for x in rows] == [("cn000001", "table"), ("cn000002", "note")]
    row = rows[0]
    assert row["notebook"] == nb["id"] and row["title"] == "How many rows are there?" and row["exec_count"] == 3
    assert "outputs" not in row and "code" not in row and rows[1]["status"] is None


async def test_a_run_keeps_the_kind_and_replace_may_change_it(corpus):
    cell = await notebook.run_code(corpus, "print(1)", "chat:c1", title="q", kind="table")
    assert cell["kind"] == "table" and cell["status"] == "ok" and _text(cell) == "1\n"
    again = await notebook.run_code(corpus, "print(2)", "chat:c1", replace=cell["id"])
    assert again["kind"] == "table" and again["id"] == cell["id"]
    plot = await notebook.run_code(corpus, "print(3)", "chat:c1", replace=cell["id"], kind="plot")
    assert plot["kind"] == "plot" and notebook.get_cell(corpus, cell["id"])["kind"] == "plot"


# ----------------------------------------------------------------------------------------------------------
# the canvas' layout fields: a group's pos, a cell's width


def test_pos_and_width_normalizers():
    assert notebook.pos_of({"x": 10, "y": -4.6}) == {"x": 10, "y": -5}
    assert notebook.pos_of({"x": 1.2, "y": 3}) == {"x": 1, "y": 3}
    for bad in (None, [], "1,2", {"x": 1}, {"x": "1", "y": 2}, {"x": True, "y": 2}, {"x": float("nan"), "y": 0}, {"x": float("inf"), "y": 0}):
        assert notebook.pos_of(bad) is None, bad
    assert notebook.clamp_width(500) == 500 and notebook.clamp_width(500.4) == 500
    assert notebook.clamp_width(10) == notebook.CARD_WIDTH_MIN and notebook.clamp_width(99999) == notebook.CARD_WIDTH_MAX
    for bad in (None, "500", True, float("nan")):
        assert notebook.clamp_width(bad) is None, bad


async def test_group_pos_is_stored_listed_and_cleared(client, corpus):
    g = (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "Placed"})).json()
    assert g["pos"] is None  # the default placement until the analyst drags the column
    r = await client.put(f"/api/ws/{corpus}/notebooks/{g['id']}", json={"pos": {"x": 480.4, "y": -12}})
    assert r.status_code == 200 and r.json()["pos"] == {"x": 480, "y": -12}
    # the pos rides in the summary everywhere a group is listed, and in the record
    assert [x["pos"] for x in (await client.get(f"/api/ws/{corpus}/notebooks")).json() if x["id"] == g["id"]] == [{"x": 480, "y": -12}]
    assert [x["pos"] for x in (await client.get(f"/api/ws/{corpus}/canvas")).json()["groups"] if x["id"] == g["id"]] == [{"x": 480, "y": -12}]
    assert (await client.get(f"/api/ws/{corpus}/notebooks/{g['id']}")).json()["pos"] == {"x": 480, "y": -12}
    # a rename leaves the pos alone; null clears it; a malformed pos is a 400 and changes nothing
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{g['id']}", json={"title": "Moved"})).json()["pos"] == {"x": 480, "y": -12}
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{g['id']}", json={"pos": {"x": "a", "y": 2}})).status_code == 400
    assert (await client.get(f"/api/ws/{corpus}/notebooks/{g['id']}")).json()["pos"] == {"x": 480, "y": -12}
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{g['id']}", json={"pos": None})).json()["pos"] is None


async def test_cell_width_is_clamped_stored_and_not_an_edit(client, corpus):
    nb = (await client.post(f"/api/ws/{corpus}/notebooks", json={})).json()["id"]
    cell = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "note", "payload": {"text": "t"}})).json()
    assert cell["width"] is None
    r = await client.put(f"/api/ws/{corpus}/cells/{cell['id']}", json={"width": 640})
    assert r.status_code == 200 and r.json()["width"] == 640 and r.json()["edited"] == []
    assert (await client.put(f"/api/ws/{corpus}/cells/{cell['id']}", json={"width": 100})).json()["width"] == notebook.CARD_WIDTH_MIN
    assert (await client.put(f"/api/ws/{corpus}/cells/{cell['id']}", json={"width": 5000})).json()["width"] == notebook.CARD_WIDTH_MAX
    # the width rides in the canvas and survives another edit; a runnable cell takes one too
    assert [c["width"] for c in (await client.get(f"/api/ws/{corpus}/canvas")).json()["cells"] if c["id"] == cell["id"]] == [notebook.CARD_WIDTH_MAX]
    assert (await client.put(f"/api/ws/{corpus}/cells/{cell['id']}", json={"title": "T"})).json()["width"] == notebook.CARD_WIDTH_MAX
    code = (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "code", "code": "1"})).json()
    assert (await client.put(f"/api/ws/{corpus}/cells/{code['id']}", json={"width": 800})).json()["width"] == 800


async def test_odd_stored_pos_and_width_read_as_none(client, corpus, workspaces_tmp):
    d = workspaces_tmp / corpus / "notebooks"
    d.mkdir(parents=True)
    (d / "odd2.json").write_text(json.dumps({"id": "odd2", "title": "T", "ts": "2026-09-01T00:00:00+00:00", "pos": [1, 2],
                                             "cells": [{"id": "c1", "kind": "note", "payload": {"text": "t"}, "width": "wide"},
                                                       {"id": "c2", "kind": "code", "code": "1", "width": 50}]}))
    nb = (await client.get(f"/api/ws/{corpus}/notebooks/odd2")).json()
    assert nb["pos"] is None
    assert nb["cells"][0]["width"] is None and nb["cells"][1]["width"] == notebook.CARD_WIDTH_MIN


# ----------------------------------------------------------------------------------------------------------
# the board's layout fields: a cell's pos, height and star, a group's order, moves, the loose group, deep deletes


async def _group(client, corpus, **body) -> str:
    return (await client.post(f"/api/ws/{corpus}/notebooks", json=body)).json()["id"]


async def _note(client, corpus, nb, text="t") -> str:
    return (await client.post(f"/api/ws/{corpus}/notebooks/{nb}/cells", json={"kind": "note", "payload": {"text": text}})).json()["id"]


async def _ids(client, corpus, nb) -> list[str]:
    return [c["id"] for c in (await client.get(f"/api/ws/{corpus}/notebooks/{nb}")).json()["cells"]]


def test_height_and_order_normalizers():
    assert notebook.clamp_height(300.6) == 301
    assert notebook.clamp_height(5) == notebook.CARD_HEIGHT_MIN and notebook.clamp_height(10 ** 6) == notebook.CARD_HEIGHT_MAX
    for bad in (None, "300", True, float("nan")):
        assert notebook.clamp_height(bad) is None, bad
    assert notebook.order_of(2) == 2 and notebook.order_of(2.7) == 2 and notebook.order_of(0) == 0
    for bad in (None, -1, "1", True):
        assert notebook.order_of(bad) is None, bad


async def test_odd_stored_cell_layout_reads_as_defaults(client, corpus, workspaces_tmp):
    d = workspaces_tmp / corpus / "notebooks"
    d.mkdir(parents=True)
    (d / "odd3.json").write_text(json.dumps({"id": "odd3", "title": "T", "ts": "2026-09-01T00:00:00+00:00", "order": "first",
                                             "cells": [{"id": "c1", "kind": "note", "payload": {"text": "t"}, "pos": "here", "height": "tall", "starred": "yes"},
                                                       {"id": "c2", "kind": "note", "payload": {"text": "t"}, "pos": {"x": 4.4, "y": 8}, "height": 20, "starred": True}]}))
    nb = (await client.get(f"/api/ws/{corpus}/notebooks/odd3")).json()
    assert nb["order"] is None
    assert [(c["pos"], c["height"], c["starred"]) for c in nb["cells"]] == [(None, None, False), ({"x": 4, "y": 8}, notebook.CARD_HEIGHT_MIN, True)]


async def test_cell_pos_height_and_star_are_stored_and_not_edits(client, corpus):
    nb = await _group(client, corpus)
    cid = await _note(client, corpus, nb)
    r = await client.put(f"/api/ws/{corpus}/cells/{cid}", json={"pos": {"x": 30.2, "y": 400}, "height": 260, "starred": True})
    assert r.status_code == 200
    cell = r.json()
    assert (cell["pos"], cell["height"], cell["starred"], cell["edited"]) == ({"x": 30, "y": 400}, 260, True, [])
    # a PUT without pos leaves it; null returns the card to its group's flow; a malformed pos is a 400 and changes nothing
    assert (await client.put(f"/api/ws/{corpus}/cells/{cid}", json={"title": "Q"})).json()["pos"] == {"x": 30, "y": 400}
    assert (await client.put(f"/api/ws/{corpus}/cells/{cid}", json={"pos": {"x": "a", "y": 2}})).status_code == 400
    assert (await client.get(f"/api/ws/{corpus}/cells/{cid}")).json()["pos"] == {"x": 30, "y": 400}
    assert (await client.put(f"/api/ws/{corpus}/notebooks/{nb}/cells/{cid}", json={"pos": None, "starred": False})).json()["pos"] is None
    got = [c for c in (await client.get(f"/api/ws/{corpus}/canvas")).json()["cells"] if c["id"] == cid][0]
    assert (got["pos"], got["height"], got["starred"]) == (None, 260, False)


async def test_move_reorders_a_card_in_its_group(client, corpus):
    nb = await _group(client, corpus)
    a, b, c = [await _note(client, corpus, nb, t) for t in "abc"]
    r = await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [c], "group": nb, "after": a})
    assert r.status_code == 200 and [x["id"] for x in r.json()] == [c]
    assert await _ids(client, corpus, nb) == [a, c, b]
    await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [b], "group": nb, "after": None})
    assert await _ids(client, corpus, nb) == [b, a, c]
    await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [b], "group": nb})
    assert await _ids(client, corpus, nb) == [a, c, b]


async def test_the_canvas_leaves_out_an_old_scratch_its_groups_and_cards(client, corpus):
    """Scratch work never shows on the canvas: an older workspace's `Orientation scratch` at the root is marked on open
    (notebook.migrate_scratch) and the canvas leaves it out with the groups nested in it and their cards, listing the
    cards' ids as `hidden`; a group of the analyst's stays, and the hidden cards still resolve by their refs."""
    ws = config.workspace_dir(corpus)
    old = notebook.create_notebook(ws, notebook.SCRATCH_TITLE, role="exploration")
    inside = notebook.create_notebook(ws, "Timeline", role="exploration", parent=old["id"])
    mine = notebook.create_notebook(ws, "Your work")
    kept = notebook.insert_cell(corpus, mine["id"], notebook.new_cell("note", "user", "", mine["id"], payload={"text": "m"}))
    gone = notebook.insert_cell(corpus, inside["id"], notebook.new_cell("note", "orient", "", inside["id"],
                                                                        payload={"text": "s"}))
    notebook._scratch_migrated.discard(str(ws))
    doc = (await client.get(f"/api/ws/{corpus}/canvas")).json()
    assert [g["id"] for g in doc["groups"]] == [mine["id"]]
    assert [c["id"] for c in doc["cells"]] == [kept["id"]] and doc["hidden"] == [gone["id"]]
    assert notebook.read_notebook(ws, old["id"])[notebook.SCRATCH_KEY] is True
    assert refs.resolve(config.corpus_dir(corpus), f"card:{gone['id']}")["notebook"] == inside["id"]


async def test_move_between_groups_keeps_order_and_the_kernel_it_ran_on(client, corpus):
    src = await _group(client, corpus, title="Mine")
    final = await _group(client, corpus, title="Final", role="exploration")
    dst = await _group(client, corpus, title="Elsewhere")
    first = await _note(client, corpus, dst, "first")
    code = (await client.post(f"/api/ws/{corpus}/notebooks/{src}/cells", json={"kind": "code", "code": "x = 1"})).json()["id"]
    note = await _note(client, corpus, src)
    shared = (await client.post(f"/api/ws/{corpus}/notebooks/{final}/cells", json={"kind": "code", "code": "1"})).json()["id"]
    r = await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [note, code], "group": dst, "after": first})
    assert r.status_code == 200 and [x["notebook"] for x in r.json()] == [dst, dst]
    assert await _ids(client, corpus, src) == []
    assert await _ids(client, corpus, dst) == [first, note, code]
    moved = (await client.get(f"/api/ws/{corpus}/cells/{code}")).json()
    assert moved["kernel"] == src and moved["pos"] is None
    assert "kernel" not in (await client.get(f"/api/ws/{corpus}/cells/{note}")).json()  # a data card runs nowhere
    nb = notebook.read_notebook(notebook._ws(corpus), dst)
    assert notebook._kernel_for(nb, None, moved) == src
    # a card of an exploration group ran on the shared kernel and keeps it: '' reads as the shared one
    await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [shared], "group": dst})
    kept = (await client.get(f"/api/ws/{corpus}/cells/{shared}")).json()
    assert kept["kernel"] == "" and notebook._kernel_for(nb, None, kept) is None
    # moving on keeps the first kernel; an explicit kernel still wins
    await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [code], "group": src})
    assert (await client.get(f"/api/ws/{corpus}/cells/{code}")).json()["kernel"] == src
    assert notebook._kernel_for(nb, "other", moved) == "other"


async def test_move_places_one_card_free_and_out_of_every_group(client, corpus):
    nb = await _group(client, corpus)
    a, b = await _note(client, corpus, nb), await _note(client, corpus, nb)
    r = await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [a], "group": nb, "pos": {"x": 480, "y": 20.6}})
    assert r.json()[0]["pos"] == {"x": 480, "y": 21}
    # group null: the loose group, made once and reused, never listed as a frame of its own kind twice
    r = await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [b], "group": None, "pos": {"x": -200, "y": 900}})
    loose = r.json()[0]["notebook"]
    assert loose != nb and r.json()[0]["pos"] == {"x": -200, "y": 900}
    groups = {g["id"]: g for g in (await client.get(f"/api/ws/{corpus}/canvas")).json()["groups"]}
    assert groups[loose]["kind"] == notebook.LOOSE_KIND and groups[loose]["title"] == notebook.LOOSE_TITLE
    await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [a], "group": None, "pos": {"x": 0, "y": 0}})
    assert await _ids(client, corpus, loose) == [b, a]
    assert [g for g in (await client.get(f"/api/ws/{corpus}/notebooks")).json() if g["kind"] == notebook.LOOSE_KIND] == [groups[loose] | {"n_cells": 2}]
    # back into a group's flow: the pos goes
    r = await client.post(f"/api/ws/{corpus}/cells/move", json={"cells": [a], "group": nb})
    assert r.json()[0]["pos"] is None and await _ids(client, corpus, nb) == [a]


async def test_move_rejects_what_it_cannot_do_and_changes_nothing(client, corpus):
    nb = await _group(client, corpus)
    other = await _group(client, corpus)
    a, b = await _note(client, corpus, nb), await _note(client, corpus, nb)
    move = lambda **body: client.post(f"/api/ws/{corpus}/cells/move", json=body)  # noqa: E731
    assert (await move(cells=[a, b], group=other, pos={"x": 1, "y": 2})).status_code == 400
    assert (await move(cells=[a], group=other, pos={"x": "1", "y": 2})).status_code == 400
    assert (await move(cells=[a, b], group=nb, after=a)).status_code == 400
    assert (await move(cells=[a], group=other, after=b)).status_code == 400
    assert (await move(cells=[a, a], group=other)).status_code == 400
    assert (await move(cells=[], group=other)).status_code == 400
    assert (await move(cells=[a], group="nosuch")).status_code == 404
    assert (await move(cells=["nosuch"], group=other)).status_code == 404
    assert await _ids(client, corpus, nb) == [a, b] and await _ids(client, corpus, other) == []


async def test_group_order_and_pos_on_create_and_update(client, corpus):
    root = await _group(client, corpus, title="Root", pos={"x": 40, "y": 60})
    kid = (await client.post(f"/api/ws/{corpus}/notebooks", json={"title": "Kid", "parent": root, "order": 2, "kind": "grid"})).json()
    assert (kid["parent"], kid["order"], kid["pos"], kid["kind"]) == (root, 2, None, "grid")
    groups = {g["id"]: g for g in (await client.get(f"/api/ws/{corpus}/canvas")).json()["groups"]}
    assert groups[root]["pos"] == {"x": 40, "y": 60} and groups[kid["id"]]["order"] == 2
    # a frame dragged into another is nested with a pos inside it; out again it is a root with a pos on the board
    r = await client.put(f"/api/ws/{corpus}/notebooks/{kid['id']}", json={"order": None, "pos": {"x": 20, "y": 46}})
    assert (r.json()["order"], r.json()["pos"]) == (None, {"x": 20, "y": 46})
    r = await client.put(f"/api/ws/{corpus}/notebooks/{kid['id']}", json={"parent": None, "pos": {"x": 900, "y": 12}})
    assert (r.json()["parent"], r.json()["pos"]) == (None, {"x": 900, "y": 12})
    # a cycle is a 400 and leaves the group as it was
    await client.put(f"/api/ws/{corpus}/notebooks/{kid['id']}", json={"parent": root})
    r = await client.put(f"/api/ws/{corpus}/notebooks/{root}", json={"parent": kid["id"], "pos": {"x": 1, "y": 1}})
    assert r.status_code == 400
    back = (await client.get(f"/api/ws/{corpus}/notebooks/{root}")).json()
    assert (back["parent"], back["pos"]) == (None, {"x": 40, "y": 60})
    assert (await client.post(f"/api/ws/{corpus}/notebooks", json={"kind": "loose"})).status_code == 422


async def test_delete_group_takes_its_frames_and_cards(client, corpus):
    top = await _group(client, corpus, title="Top")
    mid = await _group(client, corpus, title="Mid", parent=top)
    low = await _group(client, corpus, title="Low", parent=mid)
    keep = await _group(client, corpus, title="Keep")
    for g in (top, mid, low, keep):
        await _note(client, corpus, g)
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/{top}")).status_code == 200
    data = (await client.get(f"/api/ws/{corpus}/canvas")).json()
    assert [g["id"] for g in data["groups"]] == [keep] and [c["notebook"] for c in data["cells"]] == [keep]
    assert (await client.delete(f"/api/ws/{corpus}/notebooks/{top}")).status_code == 404


