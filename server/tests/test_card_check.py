"""The card check (card_check.py): one reading assesses a card and its replacement lands in place, with Undo; a fake
stands in for the Messages API."""
import asyncio
import json

import pytest

from thimble_browser import canvas, card_check, home, llm, tools
from thimble_browser.app import build
from thimble_browser.cards import sandbox

from fakes import ScriptedClient

OK = [{"problem": ""}] * 5


@pytest.fixture(autouse=True)
def features(home):
    build(21998)


@pytest.fixture
def ws(folder):
    return home.open_folder(folder)


def note(ws, **kw):
    args = {"question": "How did run a end?", "kind": "note", "text": "It was merged.",
            "takeaway": "Run a was merged and also failed.", **kw}
    return canvas.new_card(ws, args, by="main", chat="main")


def answer_with(reply, seen=None):
    def answer(system, user):
        if seen is not None:
            seen.append((system, user))
        return json.dumps(reply) if not callable(reply) else reply()
    return answer


async def settle(ws, cid):
    for _ in range(300):
        await asyncio.sleep(0.01)
        rec = canvas.find(ws, cid)[1].get("check") or {}
        if rec.get("status") != "pending":
            return rec
    raise AssertionError("the check never ended")


async def test_a_check_replaces_a_failing_takeaway_in_place_and_undo_puts_it_back(ws, folder, monkeypatch):
    seen = []
    reply = {"assessment": [{"problem": ""}, {"problem": ""}, {"problem": ""}, {"problem": ""},
                            {"problem": "The note does not show that run a failed."}],
             "question": "How did run a end?", "code": "", "takeaway": "Run a was [merged](runs/a.jsonl#L2)."}
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=answer_with(reply, seen)))
    cell = note(ws)
    assert card_check.start(ws, folder, cell["id"], author="main")
    rec = await settle(ws, cell["id"])
    assert rec["status"] == "fixed"
    after = canvas.find(ws, cell["id"])[1]
    assert after["takeaway"] == "Run a was [[merged|runs/a.jsonl#L2]]." and after["title"] == "How did run a end?"
    [fix] = after["fixes"]
    assert fix["fields"] == ["takeaway"] and fix["reason"] == "The note does not show that run a failed."
    # the reading saw the question, the takeaway and what the card shows
    system, user = seen[0]
    assert system.startswith("# Card check") and "It was merged." in user[0]["text"]
    got = card_check.undo_fix(ws, cell["id"], fix["id"])
    assert got["takeaway"] == "Run a was merged and also failed." and got["fixes"][0]["state"] == "undone"
    with pytest.raises(ValueError):
        card_check.undo_fix(ws, cell["id"], fix["id"])


async def test_a_card_that_meets_every_criterion_stays_as_it_is(ws, folder, monkeypatch):
    cell = note(ws, takeaway="Run a was merged.")
    reply = {"assessment": OK, "question": "Something else?", "code": "", "takeaway": "Other words."}
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=answer_with(reply)))
    card_check.start(ws, folder, cell["id"])
    rec = await settle(ws, cell["id"])
    assert rec["status"] == "ok" and not canvas.find(ws, cell["id"])[1].get("fixes")
    # the same card as it stands is not read again, unless asked
    assert card_check.begin(ws, cell["id"]) is None
    assert card_check.begin(ws, cell["id"], again=True)


async def test_a_card_that_changed_while_it_was_read_is_left_alone(ws, folder, monkeypatch):
    cell = note(ws)
    gate = asyncio.Event()

    class Slow(ScriptedClient):
        async def _create(self, **req):
            await gate.wait()
            return await super()._create(**req)
    reply = {"assessment": [{"problem": "x"}] + OK[:4], "question": "Q?", "code": "", "takeaway": "New."}
    monkeypatch.setattr(llm, "client", lambda: Slow(answer=answer_with(reply)))
    check_id = card_check.start(ws, folder, cell["id"])
    await asyncio.sleep(0.05)
    canvas.update_card(ws, cell["id"], {"text": "It was merged on Monday."}, by="analyst")
    gate.set()
    await asyncio.sleep(0.1)
    after = canvas.find(ws, cell["id"])[1]
    assert after["check"]["id"] == check_id and after["check"]["status"] == "stopped"
    assert after["takeaway"] == "Run a was merged and also failed." and not after.get("fixes")


async def test_the_analyst_s_cards_and_locked_cards_get_no_check(ws):
    mine = canvas.new_card(ws, {"question": "Q?", "kind": "note", "text": "t", "takeaway": "A."}, by="analyst")
    assert not card_check.checkable(mine)
    locked = note(ws)
    canvas.update_card(ws, locked["id"], {"locked": True}, by="analyst")
    assert not card_check.checkable(canvas.find(ws, locked["id"])[1])
    assert not card_check.checkable(note(ws, takeaway=""))


async def test_an_agent_s_card_with_a_takeaway_is_checked_by_itself_unless_turned_off(ws, folder, monkeypatch):
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=answer_with(
        {"assessment": OK, "question": "", "code": "", "takeaway": ""})))
    t = tools.Tools(ws, "main", folder)
    r = await t.call("add_card", {"question": "How did run a end?", "kind": "note", "text": "Merged.",
                                  "takeaway": "Merged."})
    assert (await settle(ws, r.cell_id))["status"] == "ok"
    card_check.set_auto(False)
    r = await t.call("add_card", {"question": "And run b?", "kind": "note", "text": "Failed.", "takeaway": "Failed."})
    await asyncio.sleep(0.05)
    assert "check" not in canvas.find(ws, r.cell_id)[1]


@pytest.mark.skipif(sandbox.available() is None, reason="no sandbox on this machine")
async def test_a_revision_whose_code_fails_is_not_kept(ws, folder, monkeypatch):
    cell = canvas.new_card(ws, {"question": "How many runs?", "kind": "table",
                                "code": "import pandas as pd\npd.DataFrame({'runs': [2]}, index=['all'])"},
                           by="main")
    await canvas.run_card(ws, cell["id"], folder)
    canvas.update_card(ws, cell["id"], {"takeaway": "There are 2 runs."})
    reply = {"assessment": [{"problem": ""}, {"problem": ""}, {"problem": "The table has no title."}, {"problem": ""},
                            {"problem": ""}], "question": "How many runs?", "code": "raise ValueError('no')",
             "takeaway": "There are 2 runs."}
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(answer=answer_with(reply)))
    card_check.start(ws, folder, cell["id"])
    rec = await settle(ws, cell["id"])
    after = canvas.find(ws, cell["id"])[1]
    assert rec["status"] == "error" and rec["reason"] == card_check.UNRUN
    assert after["fixes"][0]["state"] == "rejected" and "ValueError" in after["fixes"][0]["reason"]
    assert after["code"].startswith("import pandas")
