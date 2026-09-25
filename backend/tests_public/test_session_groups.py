"""Where a card a session thimble runs beside main lands, and whom it is credited to (tools.own_group_session): a
writer's cards go to a root group of its own named for its document (`Report figures`), never into the analyst's Your
work or a group under it, whatever `group` the writer names, and they and that group are the writer's chat's."""
from __future__ import annotations

from pathlib import Path

import pytest

from app import agent_session, config, notebook, tools

CORPUS = "mini"
WRITER = "writer:report"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    tools._last_group.clear()
    yield
    agent_session._runs.pop((CORPUS, WRITER), None)
    await notebook.shutdown_all()


def _ws() -> Path:
    return config.workspace_dir(CORPUS)


async def _note(session: str | None, group: str = "", question: str = "What does the note say?") -> dict:
    args = {"kind": "note", "question": question, "text": "a note", "takeaway": "It says a note."}
    if group:
        args["group"] = group
    r = await tools.call(CORPUS, "add_card", args, actor="analyst", session=session)
    assert not r.is_error, r.text
    cid = next(line.strip()[5:] for line in r.text.splitlines() if line.strip().startswith("card:"))
    cell = notebook.get_cell(CORPUS, cid)
    assert cell is not None
    return cell


def _group(nb_id: str) -> dict:
    nb = notebook.read_notebook(_ws(), nb_id)
    assert nb is not None
    return nb


def _your_work() -> str:
    return notebook.create_notebook(_ws(), "Your work", role="analyst", created_by="user")["id"]


async def test_a_writers_card_lands_in_a_root_group_of_its_own_named_for_the_document():
    cell = await _note(WRITER)
    nb = _group(cell["notebook"])
    assert nb["title"] == "Report figures"
    assert nb["parent"] is None
    assert nb[tools.SESSION_GROUP_KEY] == WRITER
    assert [r for r in notebook.list_notebooks(_ws()) if r["title"] == "Your work"] == []  # nor is Your work made for it
    again = await _note(WRITER, question="What does a second note say?")
    assert again["notebook"] == cell["notebook"]
    row = next(r for r in notebook.list_notebooks(_ws()) if r["id"] == cell["notebook"])
    assert row["session"] == WRITER  # the browser reads the stamp from the group's row


async def test_a_writer_that_names_the_analysts_group_or_a_frame_in_it_gets_its_own():
    yours = _your_work()
    question = notebook.create_notebook(_ws(), "Why the spike", parent=yours)["id"]
    old = notebook.create_notebook(_ws(), "Report figures", parent=yours)["id"]  # an older writer's, under Your work
    for name in ("Your work", "Why the spike", "Report figures"):
        cell = await _note(WRITER, group=name, question=f"What does {name} hold?")
        assert cell["notebook"] not in (yours, question, old), name
        assert _group(cell["notebook"]).get(tools.SESSION_GROUP_KEY) == WRITER, name
    assert _group(yours)["cells"] == [] and _group(question)["cells"] == [] and _group(old)["cells"] == []


async def test_a_new_group_a_writer_names_is_made_under_its_own_group():
    _your_work()
    cell = await _note(WRITER, group="Deletions")
    nb = _group(cell["notebook"])
    assert nb["title"] == "Deletions"
    assert _group(str(nb["parent"])).get(tools.SESSION_GROUP_KEY) == WRITER


async def test_a_writers_cards_and_its_group_are_credited_to_its_chat_never_the_analyst():
    agent_session._runs[(CORPUS, WRITER)] = agent_session.Run(c=CORPUS, key=WRITER, chat="3c1e7a90", sid="s", cwd=_ws(), role="writer")
    cell = await _note(WRITER)
    assert cell["created_by"] == "chat:3c1e7a90"
    assert _group(cell["notebook"])["created_by"] == "chat:3c1e7a90"


async def test_mains_card_still_lands_in_your_work():
    yours = _your_work()
    cell = await _note(None)
    assert cell["notebook"] == yours
    assert cell["created_by"] == tools.TERMINAL
