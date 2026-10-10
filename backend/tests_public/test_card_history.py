"""A card's history (notebook.stamp_edit, version_of, restore_version): every edit of a card, whoever makes it and by
whichever path, is an entry of its `edited` list naming the fields it changed, and what it replaced is kept beside the
groups, small: the fields it changed alone, and for new code the outputs the card showed before. The card as it stood
before a kept edit opens to read (GET /cells/{id}/versions/{entry}), and Restore (POST .../restore) makes the card that
version again as an edit of the analyst's, itself an entry. The paths: edit_card on a note and on a plan (edit_cell), on a
card of code (edit_and_run, and stage_edit in terminal mode), the analyst's edits in the browser (PUT /cells/{id}), a
card check's fix and its Undo, and a takeaway written over another; a card's first takeaway is part of its making. Matt
2026-10-09: "we should not keep 'Before' with a strikethrough. maybe cards have a history button?"."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import card_check, checkstore, config, filters, notebook, plans, render, tools

CORPUS = "mini"
STEPS = [
    {"text": "Mirror pandas, its open PRs and issues into a local GitHub", "makes": ["mirror/", "forge/"]},
    {"text": "Build the agent container: PyPI and conda but no web", "makes": ["Dockerfile.agent"]},
    {"text": "Pilot: 2 agents, one PR each", "makes": ["pilot/"]},
]


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


async def test_a_plans_earlier_steps_open_without_marks_and_come_back_with_their_ids_and_statuses(group):
    cid = _cid(await call("add_card", group, kind="plan", question="Plan: build the environment and pilot it", steps=STEPS))
    # the analyst's feedback: a step put in, step 2 makes more, the pilot dropped; then step 1 starts
    await call("edit_card", group, card=f"card:{cid}", steps=[
        STEPS[0], {"text": "Write the prompts", "makes": ["prompts/"]}, {**STEPS[1], "makes": ["Dockerfile.agent", "wheelhouse/"]}])
    now = [{"text": s["text"]} for s in notebook.plan_steps(_cell(cid))]
    await call("edit_card", group, card=f"card:{cid}", steps=[{**now[0], "status": "running"}, *now[1:]])
    feedback, progress = _edits(cid)
    assert feedback["fields"] == progress["fields"] == ["payload"]
    got = await _version(cid, feedback["id"])
    steps = got["version"]["payload"]["steps"]
    assert [s["text"] for s in steps] == [s["text"] for s in STEPS] and [s["id"] for s in steps] == ["s1", "s2", "s3"]
    assert {s["status"] for s in steps} == {"not started"}
    # the marks of the last edit are about the card now, not the version
    assert plans.LAST_EDIT not in got["version"]["payload"] and plans.LAST_EDIT in _cell(cid)["payload"]
    assert (await _version(cid, progress["id"]))["version"]["payload"]["steps"][0]["status"] == "not started"
    notebook.restore_version(CORPUS, cid, feedback["id"])
    p = _cell(cid)["payload"]
    assert [s["id"] for s in p["steps"]] == ["s1", "s2", "s3"] and [s["text"] for s in p["steps"]] == [s["text"] for s in STEPS]
    assert p["steps"][0]["status"] == "not started" and p["steps"][1]["makes"] == ["Dockerfile.agent"]
    # marked against the steps it had, as any edit that changes the plan is; the step it drops keeps its id from reuse
    assert p[plans.LAST_EDIT]["steps"] == {"s3": {"new": True}, "s2": {"changed": ["makes"]}}
    assert p[plans.REMOVED] == ["s4"]
    assert _edits(cid)[-1]["by"] == "user"


async def test_the_analysts_edits_in_the_browser_are_entries_and_layout_is_not(group):
    cid = _cid(await call("add_card", group, kind="note", question="What can an agent reach?", text="PyPI and conda."))
    await notebook.update_cell_by_id(CORPUS, cid, notebook.CellEdit(title="What can an agent reach from its container?"))
    await notebook.update_cell_by_id(CORPUS, cid, notebook.CellEdit(takeaway="Agents reach PyPI and conda alone."))
    await notebook.update_cell_by_id(CORPUS, cid, notebook.CellEdit(width=420, starred=True))
    title, take = _edits(cid)
    assert (title["by"], title["fields"]) == ("user", ["title"]) and (take["by"], take["fields"]) == ("user", ["takeaway"])
    assert _record(cid, take["id"])["was"] == {"takeaway": ""}
    v = (await _version(cid, title["id"]))["version"]
    assert (v["title"], v["takeaway"]) == ("What can an agent reach?", ""), "before the title edit, and so before the takeaway"
    v = (await _version(cid, take["id"]))["version"]
    assert (v["title"], v["takeaway"]) == ("What can an agent reach from its container?", "")


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


async def test_a_staged_edit_in_terminal_mode_is_an_entry_with_the_outputs_it_replaces(group, ran):
    cid = _cid(await call("add_card", group, question="How many?", code="print(1)"))
    nb_id = notebook.find_cell(config.workspace_dir(CORPUS), cid)[0]
    notebook.stage_edit(CORPUS, nb_id, cid, "print(3)", {"state": "queued"}, by="terminal")
    [e] = _edits(cid)
    assert (e["by"], e["fields"]) == ("terminal", ["code"])
    assert "out: print(1)" in json.dumps(_record(cid, e["id"])["shown"]["outputs"])


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
    # a fix whose code changes the outputs is marked fixed, with Undo, as before
    revision["code"] = "9"
    cell = await _checked(cid, again=True)
    assert cell["check"]["status"] == "fixed" and [f["state"] for f in cell["fixes"]] == ["applied"]
    assert (_edits(cid)[-1]["by"], cell["outputs"][0]["text/plain"]) == (checkstore.ACTOR, "9")


async def test_a_fix_with_the_same_outputs_is_a_fix_on_a_card_that_shows_its_code_or_its_typed_numbers(group, ran):
    """A fix whose new code shows the same outputs still changes what a code card shows, its code, and takes the red ✕
    for numbers typed into the code off a card: both are fixes, marked fixed as before."""
    same = {"status": "ok", "code": "print( 1)", "outputs": [{"text/plain": "out: print(1)"}], "labels": [], "label_revs": {}}
    shown = _cid(await call("add_card", group, kind="code", question="How many?", code="print(1)", takeaway="One."))
    typed = _cid(await call("add_card", group, kind="table", question="How many?", code="print(1)", takeaway="One."))
    plain = _cid(await call("add_card", group, kind="table", question="How many?", code="print(1)", takeaway="One."))
    got = {}
    for cid in (shown, typed, plain):
        chk = checkstore.begin(CORPUS, cid)
        if cid == typed:
            assert checkstore.stage(CORPUS, cid, chk, "render", {"status": "ok", "typed": ["4", "5", "6"]})
        got[cid] = checkstore.apply_fix(CORPUS, cid, chk, {"code": "print( 1)"}, same, "the question was vague")["state"]
    assert got == {shown: "applied", typed: "applied", plain: checkstore.SAME}
    assert [len(_cell(cid).get("fixes") or []) for cid in (shown, typed, plain)] == [1, 1, 0]
    assert all(_edits(cid)[-1]["by"] == checkstore.ACTOR for cid in (shown, typed, plain))


async def test_a_takeaway_written_over_another_is_an_entry_and_a_late_first_one_too(group, monkeypatch):
    cid = _cid(await call("add_card", group, kind="note", question="What can an agent reach?", text="PyPI and conda."))
    # a note's takeaway, as an agent writes it right after making the card: part of the making
    assert notebook.append_takeaway(CORPUS, cid, "Agents reach PyPI.", overwrite=True, author="model")
    assert _edits(cid) == []
    assert notebook.append_takeaway(CORPUS, cid, "Agents reach PyPI and conda.", overwrite=True, author="model", by="chat:abc12345")
    [e] = _edits(cid)
    assert (e["by"], e["fields"]) == ("chat:abc12345", ["takeaway"])
    assert _record(cid, e["id"])["was"] == {"takeaway": "Agents reach PyPI."}
    # a first takeaway long after the card's last change is an edit of its own
    other = _cid(await call("add_card", group, kind="note", question="And the web?", text="No web."))
    monkeypatch.setattr(notebook, "TAKEAWAY_FOLD_S", -1)
    notebook.append_takeaway(CORPUS, other, "No agent reaches the web.", overwrite=True, author="model")
    [late] = _edits(other)
    assert late["fields"] == ["takeaway"] and _record(other, late["id"])["was"] == {"takeaway": ""}


async def test_a_first_takeaway_right_after_an_edit_joins_that_edit(group):
    cid = _cid(await call("add_card", group, kind="note", question="What can an agent reach?", text="PyPI and conda."))
    await call("edit_card", group, card=f"card:{cid}", text="PyPI, conda and no web.")
    notebook.append_takeaway(CORPUS, cid, "Agents reach PyPI and conda.", overwrite=True, author="model")
    [e] = _edits(cid)
    assert e["fields"] == ["payload", "takeaway"]
    v = (await _version(cid, e["id"]))["version"]
    assert (v["text"], v["takeaway"]) == ("PyPI and conda.", ""), "the card before that edit had no takeaway"


async def test_a_version_not_kept_does_not_open(group):
    cid = _cid(await call("add_card", group, kind="note", question="What can an agent reach?", text="PyPI and conda."))
    await call("edit_card", group, card=f"card:{cid}", text="PyPI and conda, no web.")
    await call("edit_card", group, card=f"card:{cid}", text="PyPI and conda through a proxy, no web.")
    first, second = _edits(cid)
    with pytest.raises(HTTPException) as e:
        await _version(cid, "0badc0de")
    assert e.value.status_code == 404
    # the second edit's record gone, as for an edit made before thimble kept them: neither it nor the first opens
    (config.workspace_dir(CORPUS) / notebook.HISTORY_DIR / cid / f"{second['id']}.json").unlink()
    for entry in (first["id"], second["id"]):
        with pytest.raises(HTTPException) as e:
            await _version(cid, entry)
        assert e.value.status_code == 404
        with pytest.raises(HTTPException):
            notebook.restore_version(CORPUS, cid, entry)
    assert _cell(cid)["text"] == "PyPI and conda through a proxy, no web."
