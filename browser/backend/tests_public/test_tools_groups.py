"""Where main's cards stand on the canvas. The canvas has no group by default: a card main adds without a group stands
loose, outside every frame (the loose group), never in the analyst's Your work, and so does a label's card and a card
the analyst adds on the canvas. A group is for a sequence of cards that answer one question together: the one main
names is made at the root. Main edits and moves loose cards, its own and the analyst's. A card made where the analyst
wrote (`request:<id>`) and a writer's card land where they did.

Main's calls go through tools.call as main's shim makes them (runtime.call_thimble): the analyst's caller, no notebook
and no session of thimble's."""
from __future__ import annotations

import json
import re

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, notebook, tools

CORPUS = "mini"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks):
        table.clear()
    tools._last_cell.clear()
    tools._last_group.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks):
        table.clear()
    await notebook.shutdown_all()


def ws():
    return config.workspace_dir(CORPUS)


async def main(tool: str, **args):
    """One call of main's, as its shim makes it."""
    r = await tools.call(CORPUS, tool, args)
    assert not r.is_error, r.text
    return r


async def card(question: str, **args) -> str:
    """The id of a note card main adds."""
    r = await main("add_card", kind="note", question=question, text="x", **args)
    hit = next((m.group(1) for line in r.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, r.text
    return hit


def group_of(cid: str) -> dict:
    hit = notebook.find_cell(ws(), cid)
    assert hit is not None, cid
    return notebook.read_notebook(ws(), hit[0])


def titles() -> list[str]:
    return [r["title"] for r in notebook.list_notebooks(ws())]


async def test_a_card_main_adds_without_a_group_stands_loose_never_in_your_work():
    first = await card("How many runs failed?")
    assert group_of(first)["kind"] == notebook.LOOSE_KIND
    assert tools.ANALYST_NOTEBOOK_TITLE not in titles(), "no Your work is made for it"
    # after a sequence in a group of its own, the next single card stands loose, not in that group
    for q in ("When did they start?", "Which runner?"):
        await card(q, group="Why did the runs fail?")
    assert group_of(await card("Which runner is slowest?"))["kind"] == notebook.LOOSE_KIND
    # in a workspace that has a Your work with the analyst's cards, the frame they last selected among them
    yours = tools.analyst_notebook(CORPUS)
    notebook.insert_cell(CORPUS, yours, notebook.new_cell("note", "user", "Mine", payload={"text": "x"}))
    (ws() / "settings.json").write_text(json.dumps({"active_notebook": yours, "active_group": yours}))
    later = await card("How long do the runs take?")
    assert group_of(later)["kind"] == notebook.LOOSE_KIND
    assert [c["title"] for c in notebook.read_notebook(ws(), yours)["cells"]] == ["Mine"], "Your work is left as it was"


async def test_main_names_one_group_for_a_sequence_made_at_the_root():
    yours = tools.analyst_notebook(CORPUS)  # a workspace that has a Your work
    asked = "Why did refunds jump in March?"
    cids = [await card(q, group=asked) for q in ("When did they start?", "Which product?", "What do the tickets say?")]
    g = group_of(cids[0])
    assert {group_of(c)["id"] for c in cids} == {g["id"]}
    assert g["title"] == asked and g["parent"] is None and g["kind"] == notebook.DEFAULT_GROUP_KIND
    assert [c["id"] for c in g["cells"]] == cids
    assert g["id"] != yours and not notebook.read_notebook(ws(), yours)["cells"]


async def test_a_card_made_where_the_analyst_wrote_lands_in_your_work_as_before():
    """A `request:<id>` card lands in the analyst's Your work, made for it when missing, never in a group of main's."""
    seq = [await card(q, group="Which runs failed?") for q in ("How many?", "Which ones?")]
    req = await card("Runs per day?", group="request:r1")
    g = group_of(req)
    assert g["title"] == tools.ANALYST_NOTEBOOK_TITLE and g["id"] != group_of(seq[0])["id"]
    assert await card("And per week?", group="request:r2") in [c["id"] for c in notebook.read_notebook(ws(), g["id"])["cells"]]


async def test_main_edits_and_moves_loose_cards_its_own_and_the_analyst_s():
    mine = await card("Mine?")
    theirs = notebook.insert_cell(CORPUS, notebook.loose_group(ws()),
                                  notebook.new_cell("note", "user", "Theirs?", payload={"text": "b"}))["id"]
    await main("edit_card", card=f"card:{theirs}", question="Theirs, renamed?", text="c")
    assert notebook.get_cell(CORPUS, theirs)["title"] == "Theirs, renamed?"
    await main("edit_card", card=f"card:{mine}", after=f"card:{theirs}")
    loose = notebook.read_notebook(ws(), notebook.loose_group(ws()))
    assert [c["id"] for c in loose["cells"]] == [theirs, mine]
    for cid in (theirs, mine):
        await main("edit_card", card=f"card:{cid}", group="Both, in order?")
    g = group_of(mine)
    assert g["parent"] is None and [c["id"] for c in g["cells"]] == [theirs, mine]
    assert tools.ANALYST_NOTEBOOK_TITLE not in titles()


async def test_a_label_s_card_stands_loose_unless_its_call_names_a_group():
    await main("apply_label", scope="files", paths=["board.jsonl"], name="claims a PR",
               predicate={"kind": "regex", "text": "forge pr claim"})
    k = concepts.find_concept(ws(), "claims a PR")
    (_, cell), = concepts._label_cards(ws(), k["id"])
    assert group_of(cell["id"])["kind"] == notebook.LOOSE_KIND
    await main("apply_label", scope="files", paths=["board.jsonl"], name="asks for review", group="Who asks whom?",
               predicate={"kind": "regex", "text": "REVIEW WANTED"})
    k = concepts.find_concept(ws(), "asks for review")
    (_, cell), = concepts._label_cards(ws(), k["id"])
    assert group_of(cell["id"])["title"] == "Who asks whom?" and group_of(cell["id"])["parent"] is None
    # the analyst's own label, applied in the browser, gets its card loose too
    mine = concepts.label_card(CORPUS, {"id": "k-analyst", "name": "mine"}, None, "user")
    assert group_of(mine["id"])["kind"] == notebook.LOOSE_KIND
    assert tools.ANALYST_NOTEBOOK_TITLE not in titles()


async def test_a_writer_s_card_without_a_group_lands_in_its_own_group_as_before(monkeypatch):
    monkeypatch.setattr(tools, "session_chat", lambda c, s: None)
    r = await tools.call(CORPUS, "add_card", {"kind": "note", "question": "Figure?", "text": "x"}, session="writer:report")
    assert not r.is_error, r.text
    cid = re.search(r"card:([A-Za-z0-9_-]+)", r.text).group(1)
    g = group_of(cid)
    assert g["kind"] != notebook.LOOSE_KIND and g.get(tools.SESSION_GROUP_KEY) == "writer:report" and g["parent"] is None


@pytest.fixture()
async def client():
    a = FastAPI()
    a.include_router(notebook.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=60) as c:
        yield c


@pytest.mark.parametrize("dragged", [False, True], ids=["empty-frame", "card-dragged-in"])
async def test_a_card_made_where_the_analyst_wrote_lands_in_your_work_never_in_a_frame_they_made(client, dragged):
    """With main's single cards loose, the canvas has no Your work yet when the analyst first makes a frame with Group.
    A `request:<id>` card still lands in a Your work made for it, never in that frame, empty or holding a card the
    analyst dragged in, and never in a frame settings.active_notebook names when that frame is not Your work."""
    single = await card("How many runs failed?")
    r = await client.post(f"/api/ws/{CORPUS}/notebooks", json={"title": "Group 1", "pos": {"x": 1600, "y": 0}})
    assert r.status_code == 200, r.text
    frame = r.json()["id"]
    if dragged:
        r = await client.post(f"/api/ws/{CORPUS}/cells/move", json={"cells": [single], "group": frame})
        assert r.status_code == 200, r.text
    req = await card("Runs per day?", group="request:r1")
    yours = group_of(req)
    assert yours["title"] == tools.ANALYST_NOTEBOOK_TITLE and yours["id"] != frame and yours["parent"] is None
    held = notebook.read_notebook(ws(), frame)
    assert [c["id"] for c in held["cells"]] == ([single] if dragged else []) and not held.get("created_by")
    (ws() / "settings.json").write_text(json.dumps({"active_notebook": frame}))
    assert group_of(await card("And per week?", group="request:r2"))["id"] == yours["id"]
    # a Your work stored before groups carried their maker is still the analyst's, beside the frame they made
    notebook.write_notebook(ws(), {k: v for k, v in notebook.read_notebook(ws(), yours["id"]).items() if k != "created_by"})
    (ws() / "settings.json").write_text(json.dumps({"active_notebook": frame}))
    assert group_of(await card("And per month?", group="request:r3"))["id"] == yours["id"]


async def test_the_analyst_s_new_card_on_the_canvas_stands_loose(client):
    """The canvas's Card makes a card outside every frame, where the analyst is looking (`pos`), or below the board."""
    r = await client.post(f"/api/ws/{CORPUS}/cells", json={"kind": "code", "title": "New card", "code": "", "pos": {"x": 120, "y": 340}})
    assert r.status_code == 200, r.text
    cell = r.json()
    assert cell["pos"] == {"x": 120, "y": 340} and cell["created_by"] == "user"
    assert group_of(cell["id"])["kind"] == notebook.LOOSE_KIND
    r = await client.post(f"/api/ws/{CORPUS}/cells", json={"kind": "code", "title": "Another", "code": ""})
    assert r.status_code == 200 and r.json()["pos"] is None and group_of(r.json()["id"])["kind"] == notebook.LOOSE_KIND
    assert (await client.post(f"/api/ws/{CORPUS}/cells", json={"kind": "code", "title": "x", "pos": {"x": "a"}})).status_code == 400
    assert tools.ANALYST_NOTEBOOK_TITLE not in titles()
