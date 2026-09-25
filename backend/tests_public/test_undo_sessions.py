"""undo.py with the sessions thimble starts: a writer's tool calls make steps that name the writer (`session`, and `by`
where the change names no author), and while the writer runs Undo passes over them to the analyst's own last change,
refusing when the writer has changed that same card or document since. No model call and no kernel."""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app import agent_session, canvas_history, config, investigation, notebook, report_types, tools, undo

CORPUS = "mini"
MAIN = investigation.MAIN
WRITER = "writer:report"


@pytest.fixture()
def cells(workspaces_tmp):
    """One card in the analyst's group, kept as it stands so its first change is a step."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    card = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    card["status"], card["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(card)
    notebook.write_notebook(ws, nb)
    undo.forget()
    canvas_history.prime(CORPUS)
    yield card["id"]
    undo.forget()


@pytest.fixture()
def running(monkeypatch):
    """The sessions that run, as agent_session answers for them."""
    live: set[str] = set()
    monkeypatch.setattr(agent_session, "running", lambda c, key: key in live)
    return live


async def writer_writes(text: str):
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst", session=WRITER)
    assert not r.is_error, r.text


def journal() -> list[dict]:
    return [json.loads(line) for line in undo.log_path(CORPUS).read_text("utf-8").splitlines()]


async def test_a_writers_steps_name_it_and_hold_the_analysts_step_on_a_card_it_changed_since(cells, running):
    cid = cells
    notebook.edit_cell(CORPUS, cid, title="How many deletions in March?", by="analyst")
    running.add(WRITER)
    await writer_writes("# One account issued every deletion\n\n## One account\n\nOne account issued them.\n")
    # a card the writer changes reads `terminal` on the canvas; its step names the writer
    with undo.acting_session(WRITER), canvas_history.acting("terminal"):
        notebook.edit_cell(CORPUS, cid, takeaway="One account issued all 27.")
    steps = [s for s in journal() if s["type"] == "step"]
    assert [(s["kind"], s.get("session")) for s in steps] == [("card", None), ("doc", WRITER), ("card", WRITER)]
    assert [s["by"] for s in steps[1:]] == [WRITER, WRITER]
    # the takeaway was set on the card the analyst's step changed: that step is held until the writer ends
    with pytest.raises(HTTPException) as e:
        undo.undo(CORPUS)
    assert e.value.status_code == 409 and "the writer of the report has changed card" in e.value.detail


async def test_undo_during_a_writer_reverts_the_analysts_edit_and_leaves_the_writers(cells, running):
    cid = cells
    notebook.edit_cell(CORPUS, cid, title="How many deletions in March?", by="analyst")
    running.add(WRITER)
    await writer_writes("# One account issued every deletion\n\n## One account\n\nOne account issued them.\n")
    written = report_types.read_doc(CORPUS, MAIN, "report")
    assert undo.labels(CORPUS)["undo"].startswith("edit the question of card")
    undo.undo(CORPUS)
    assert notebook.find_cell(config.workspace_dir(CORPUS), cid)[1]["title"] == "How many deletions?"
    assert report_types.read_doc(CORPUS, MAIN, "report")["sections"] == written["sections"], "the writer's document stands"
    # what is left is the writer's alone: Undo names nothing and refuses while it runs, the journal replays the same
    undo.forget(CORPUS)
    assert undo.labels(CORPUS)["undo"] is None and undo.labels(CORPUS)["redo"].startswith("edit the question of card")
    with pytest.raises(HTTPException) as e:
        undo.undo(CORPUS)
    assert e.value.status_code == 409 and e.value.detail.startswith("the writer of the report is still running")
    # once the writer has ended, its edit is the analyst's to undo like any other
    running.discard(WRITER)
    assert undo.labels(CORPUS)["undo"] == "edit the report"
    undo.undo(CORPUS)
    assert report_types.read_doc(CORPUS, MAIN, "report") is None


async def test_the_analysts_edit_of_a_document_the_running_writer_changed_since_is_held(cells, running):
    running.add(WRITER)
    report_types.write_doc(CORPUS, MAIN, "report", {"id": "report", "type": "report", "renderer": "document", "title": "Draft", "generation": 1,
                                                    "sections": [], "comments": [], "locked": []})
    await writer_writes("# One account issued every deletion\n\n## One account\n\nOne account issued them.\n")
    with pytest.raises(HTTPException) as e:
        undo.undo(CORPUS)
    assert e.value.detail == "the writer of the report has changed the report since and is still running; undo it once that ends"
    assert undo.labels(CORPUS) == {**undo.labels(CORPUS), "undo": None, "held": e.value.detail}
    assert report_types.read_doc(CORPUS, MAIN, "report")["title"] == "One account issued every deletion"


def test_session_names():
    assert undo.session_name("writer:report") == "the writer of the report"
    assert undo.session_name("orient") == "the orientation"
    assert undo.session_name("critique:orient") == "the critique"
    assert undo.session_name("check:unverified:report") == "a report check"
