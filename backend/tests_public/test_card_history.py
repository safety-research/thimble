"""A card's history (notebook.stamp_edit, version_of, restore_version): every edit of a card is an entry of its `edited`
list naming the fields it changed, and what it replaced is kept beside the groups, small: the fields it changed alone,
and for new code the outputs the card showed before. The card as it stood before a kept edit opens to read
(GET /cells/{id}/versions/{entry}), and Restore (POST .../restore) makes the card that version again as an edit of the
analyst's, itself an entry. The paths here: edit_card on a note and on a card of code, and a card check's fix and its
Undo. Matt 2026-10-09: "we should not keep 'Before' with a strikethrough. maybe cards have a history button?"."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app import card_check, cardrun, checkstore, config, filters, notebook, render, tools

CORPUS = "mini"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def group() -> str:
    return notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]


@pytest.fixture()
def ran(monkeypatch) -> list[str]:
    """A stand-in kernel whose output is the code it ran, so new code shows new outputs; the code of each run."""
    codes: list[str] = []

    async def started(k, workspace, kernel=None) -> None:
        return None

    async def run(k, code, kind, timeout_s, extra_exprs=None):
        codes.append(code)
        k.last_labels, k.last_label_revs = [], {}
        return [{"text/plain": f"out: {code}"}], len(codes), "ok"

    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", run)
    # this process stands in for the card runner (`thimble-run`, where card code runs in every transport, R8)
    monkeypatch.setattr(cardrun, "defers", lambda c: False)
    return codes


async def call(name: str, nb: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", notebook=nb, terminal=False)


def _cid(result) -> str:
    assert not result.is_error, result.text
    hit = next((m.group(1) for line in result.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, result.text
    return hit


def _cell(cid: str) -> dict:
    cell = notebook.get_cell(CORPUS, cid)
    assert cell is not None
    return cell


def _edits(cid: str) -> list[dict]:
    return list(_cell(cid).get("edited") or [])


def _record(cid: str, entry: str) -> dict:
    path: Path = config.workspace_dir(CORPUS) / notebook.HISTORY_DIR / cid / f"{entry}.json"
    return json.loads(path.read_text("utf-8"))


async def _version(cid: str, entry: str) -> dict:
    return await notebook.card_version_route(CORPUS, cid, entry)


async def test_an_edit_of_a_note_keeps_what_it_replaced_and_the_note_before_it_opens_and_restores(group):
    cid = _cid(await call("add_card", group, kind="note", question="What can an agent reach?", text="PyPI and conda."))
    assert _edits(cid) == []
    await call("edit_card", group, card=f"card:{cid}", text="PyPI and conda through a proxy, and no web.")
    [e] = _edits(cid)
    assert e["by"] == tools.BROWSER_CELL_AUTHOR and e["fields"] == ["payload"] and re.fullmatch(r"[0-9a-f]{8}", e["id"])
    # the card holds who, when and which fields; what the edit replaced is kept beside it, the changed field alone
    assert set(e) == {"by", "ts", "id", "fields"}
    rec = _record(cid, e["id"])
    assert set(rec) == {"id", "was"} and set(rec["was"]) == {"payload"} and rec["was"]["payload"]["text"] == "PyPI and conda."
    got = await _version(cid, e["id"])
    assert (got["card"], got["before"], got["by"], got["fields"]) == (cid, e["id"], e["by"], ["payload"])
    assert got["version"]["text"] == "PyPI and conda." and got["version"]["title"] == "What can an agent reach?"
    # reading a version changes nothing
    assert _cell(cid)["text"] == "PyPI and conda through a proxy, and no web." and len(_edits(cid)) == 1
    restored = await notebook.restore_version_route(CORPUS, cid, e["id"])
    assert restored["text"] == "PyPI and conda." and restored["payload"]["text"] == "PyPI and conda."
    # Restore is an edit of the analyst's like any other: the card before it opens in turn
    e1, e2 = _edits(cid)
    assert e2["by"] == "user" and e2["fields"] == ["payload"]
    assert (await _version(cid, e2["id"]))["version"]["text"] == "PyPI and conda through a proxy, and no web."
    assert (await _version(cid, e1["id"]))["version"]["text"] == "PyPI and conda.", "an older edit opens through the newer ones"
    # restoring the version the card already is changes nothing
    notebook.restore_version(CORPUS, cid, e1["id"])
    assert len(_edits(cid)) == 2


async def test_an_edit_of_a_card_of_code_keeps_its_code_takeaway_and_the_outputs_it_showed(group, ran):
    cid = _cid(await call("add_card", group, question="How many?", code="print(1)", takeaway="One."))
    # the takeaway written with the card is part of its making
    assert _cell(cid)["takeaway"] == "One." and _edits(cid) == []
    await call("edit_card", group, card=f"card:{cid}", code="print(2)")
    [e] = _edits(cid)
    assert e["fields"] == ["code", "takeaway"], "new code clears the takeaway written for the old outputs"
    rec = _record(cid, e["id"])
    assert rec["was"] == {"code": "print(1)", "takeaway": "One."}
    assert "out: print(1)" in json.dumps(rec["shown"]["outputs"]) and rec["shown"]["status"] == "ok"
    v = (await _version(cid, e["id"]))["version"]
    assert (v["code"], v["takeaway"], v["status"]) == ("print(1)", "One.", "ok") and "out: print(1)" in json.dumps(v["outputs"])
    assert "out: print(2)" in json.dumps(_cell(cid)["outputs"])
    runs = len(ran)
    notebook.restore_version(CORPUS, cid, e["id"])
    cell = _cell(cid)
    # the code with the outputs it showed then, as stored, without a run
    assert (cell["code"], cell["takeaway"], cell["takeaway_author"]) == ("print(1)", "One.", "analyst")
    assert "out: print(1)" in json.dumps(cell["outputs"]) and len(ran) == runs
    back = _edits(cid)[-1]
    assert back["by"] == "user" and back["fields"] == ["code", "takeaway"]
    assert "out: print(2)" in json.dumps(_record(cid, back["id"])["shown"]["outputs"])


async def test_a_card_checks_fix_and_its_undo_are_entries(group, ran):
    cid = _cid(await call("add_card", group, question="How many?", code="print(1)", takeaway="One."))
    chk = checkstore.begin(CORPUS, cid)
    cand = {"status": "ok", "code": "print(9)", "outputs": [{"text/plain": "out: print(9)"}], "labels": [], "label_revs": {}}
    fix = checkstore.apply_fix(CORPUS, cid, chk, {"code": "print(9)", "title": "How many records?"}, cand, "the question was vague")
    assert fix is not None
    [e] = _edits(cid)
    assert (e["by"], e["fields"]) == (checkstore.ACTOR, ["title", "code"]), "one entry for the whole fix"
    v = (await _version(cid, e["id"]))["version"]
    assert (v["title"], v["code"]) == ("How many?", "print(1)") and "out: print(1)" in json.dumps(v["outputs"])
    checkstore.undo_fix(CORPUS, cid, fix["id"])
    undone = _edits(cid)[-1]
    assert (undone["by"], undone["fields"]) == ("user", ["title", "code"])
    assert (await _version(cid, undone["id"]))["version"]["title"] == "How many records?"
    assert _cell(cid)["title"] == "How many?"


@pytest.fixture()
def sums(monkeypatch) -> None:
    """A stand-in kernel whose output is the value of the code's last line, so `8` and `4 + 4` show the same outputs."""
    async def started(k, workspace, kernel=None) -> None:
        return None

    async def run(k, code, kind, timeout_s, extra_exprs=None):
        k.last_labels, k.last_label_revs = [], {}
        return [{"text/plain": str(eval(code.strip().splitlines()[-1], {"__builtins__": {}}))}], 1, "ok"

    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", run)
    monkeypatch.setattr(cardrun, "defers", lambda c: False)  # this process stands in for the card runner (R8)


def _check_gives(monkeypatch, revision: dict) -> None:
    """The card check with its drawing and its model's reading stood in for: every card draws, and the reading finds
    the question vague and gives the card back with `revision["code"]`."""
    async def draw(c, cell):
        return render.Rendered(png=b"\x89PNG card")

    async def read(c, cell, png, run, picture=None):
        assessment = [{"problem": "The question names no wiki."}] + [{"problem": ""}] * (card_check.CRITERIA - 1)
        return assessment, {"question": cell["title"], "code": revision["code"], "takeaway": cell["takeaway"]}, "test-model"

    monkeypatch.setattr(render, "down", lambda: False)
    monkeypatch.setattr(card_check, "_draw", draw)
    monkeypatch.setattr(card_check, "_read", read)


async def _checked(cid: str, again: bool = False) -> dict:
    run = card_check.start(CORPUS, cid, card_check.MAIN, again=again)
    assert run is not None
    await run.task
    return _cell(cid)


async def test_a_card_checks_fix_that_shows_the_same_outputs_is_a_version_in_the_history_and_no_fix(group, sums, monkeypatch):
    """Matt 2026-10-10, of a card check's fix that changes nothing the card shows: "I would just increment the cards
    history, not add fixed". Its new code is one more version in the card's history, by the check, which Restore takes
    back; the card is not marked fixed and has no Undo: the check ends `ok`, as for a card it did not revise. A fix whose
    code changes the outputs is marked fixed as before."""
    cid = _cid(await call("add_card", group, kind="table", question="How many posts?", code="8", takeaway="There are 8 posts."))
    revision = {"code": "4 + 4"}
    _check_gives(monkeypatch, revision)
    cell = await _checked(cid)
    assert cell["code"] == "4 + 4" and cell["check"]["status"] == "ok", cell["check"]
    assert "reason" not in cell["check"] and not cell.get("fixes"), "no fix to mark the card or to undo"
    assert filters.check_state(cell) == "verified"
    [e] = _edits(cid)
    assert (e["by"], e["fields"]) == (checkstore.ACTOR, ["code"])
    v = (await _version(cid, e["id"]))["version"]
    assert v["code"] == "8" and json.dumps(v["outputs"]) == json.dumps(cell["outputs"])
    notebook.restore_version(CORPUS, cid, e["id"])
    assert _cell(cid)["code"] == "8" and _edits(cid)[-1]["by"] == "user"
    # a fix whose code changes the outputs is marked fixed, with Undo, as before; it keeps the 8 the takeaway cites
    revision["code"] = "8, 9"
    cell = await _checked(cid, again=True)
    assert cell["check"]["status"] == "fixed" and [f["state"] for f in cell["fixes"]] == ["applied"]
    assert (_edits(cid)[-1]["by"], cell["outputs"][0]["text/plain"]) == (checkstore.ACTOR, "(8, 9)")
