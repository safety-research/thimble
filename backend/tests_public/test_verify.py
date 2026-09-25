"""The linking check of a card's takeaway (app/verify.py) and its single enqueue point. The numbers of a takeaway are
linked to the card's outputs where their value has one home, at once in the hook; the links job then checks every
citation by execution, with no model call: a citation the cited place contradicts nothing is left alone, a number no
output shows stays unlinked and quiet, and a bare citation that does not resolve is listed with why. A re-run moves a
citation whose value moved with its line and marks one whose target is gone. At a server's start the cells whose record
is stale or still pending are enqueued again.

Cards are seeded into a notebook with outputs the way a run leaves them, and the hooks (`on_cell_ran`, `on_takeaway`)
are called the way notebook's verify hook calls them. The tables are invented."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app import config, investigation, jobs, notebook, verify

C = "mini"
TABLE_HTML = ("<table><thead><tr><th></th><th>deletions</th><th>reviews</th></tr></thead><tbody>"
              "<tr><th>alpha</th><td>127</td><td>4</td></tr><tr><th>beta</th><td>3</td><td>1,250</td></tr></tbody></table>")
PRINTED = "       deletions  reviews\nalpha        127        4\nbeta           3     1250\ngamma         44        3\n"


@pytest.fixture(autouse=True)
def _isolate(workspaces_tmp, monkeypatch):
    """A fresh job queue whose start rescans, and the links job on (the suite's default is off)."""
    jobs.reset_for_tests()
    jobs.on_start(verify.rescan)
    monkeypatch.setattr(verify, "CHECK_JOBS", True)
    yield


@pytest.fixture(autouse=True)
async def _down():
    yield
    await jobs.shutdown()
    await notebook.shutdown_all()
    jobs.reset_for_tests()


def _ws() -> Path:
    return config.workspace_dir(C)


def _seed(*, outputs=None, takeaway="", exec_count=3, status="ok", code="print(df)", title="deletions per account") -> dict:
    ws = _ws()
    nb = notebook.read_notebook(ws, "main")
    cell = notebook.new_cell("code", "user", title, nb["id"], code=code)
    cell.update(status=status, exec_count=exec_count, takeaway=takeaway, duration_s=0.2,
                outputs=outputs if outputs is not None else
                [{"text/plain": "account  deletions\nalpha    127\nbeta      3\n", "_stream": "stdout"}])
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return cell


def _stored(cid: str) -> dict:
    return notebook.get_cell(C, cid)


def _events() -> list[dict]:
    p = investigation.inv_dir(C, "main") / "events.jsonl"
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.is_file() else []


def _recording_enqueue(monkeypatch) -> list[tuple]:
    calls: list[tuple] = []

    def enqueue(kind, target, version, fn, **kw):
        calls.append((kind, target, version))
        return True

    monkeypatch.setattr(verify.jobs, "enqueue", enqueue)
    return calls


def _hook_ran(cell: dict) -> dict:
    """What a run does: the hook on the cell, then the save."""
    ws = _ws()
    nb, stored = notebook._locate(ws, cell["id"])
    verify.on_cell_ran(C, nb, stored)
    notebook.write_notebook(ws, nb)
    return stored


def _hook_takeaway(cid: str, text: str) -> dict:
    """The takeaway as the `takeaway` tool stores it, the model's words, which the linking may correct or unwrap."""
    ws = _ws()
    nb, cell = notebook._locate(ws, cid)
    cell["takeaway"] = text
    cell["takeaway_author"] = "model"
    verify.on_takeaway(C, nb, cell)
    notebook.write_notebook(ws, nb)
    return cell


def _rerun(cid: str, outputs: list) -> dict:
    """What a re-run that keeps the takeaway does: the new outputs numbered against the old, a new exec_count, then the
    hook and the save."""
    ws = _ws()
    nb, cell = notebook._locate(ws, cid)
    memo = notebook._memo_of(cell)
    cell["outputs"] = notebook.number_outputs(memo, outputs)
    if notebook._has_output(outputs):
        cell[notebook.OUT_MEMO] = notebook.output_memo(outputs, memo)
    cell["exec_count"] = int(cell.get("exec_count") or 0) + 1
    verify.on_cell_ran(C, nb, cell)
    notebook.write_notebook(ws, nb)
    return cell


# ----------------------------------------------------------------------------- the hook


def test_the_hook_links_each_number_with_one_home_at_once_and_enqueues_the_links_job(monkeypatch):
    calls = _recording_enqueue(monkeypatch)
    cell = _seed(outputs=[{"text/html": TABLE_HTML, "text/plain": "   deletions  reviews\nalpha 127 4\nbeta 3 1250"}])
    _hook_ran(cell)
    t0 = time.perf_counter()
    stored = _hook_takeaway(cell["id"], "Alpha deleted 127 records and drew 1,250 reviews; 4 of them were on Monday.")
    assert time.perf_counter() - t0 < 0.5, "the hook adds no wait to the takeaway tool"
    cid = cell["id"]
    assert stored["takeaway"] == (f"Alpha deleted [[127|card:{cid}#deletions/alpha]] records and drew "
                                  f"[[1,250|card:{cid}#reviews/beta]] reviews; 4 of them were on Monday.")
    links = stored["verification"]["links"]
    assert [x["value"] for x in links["resolved"]] == ["127", "1,250"] and links["unresolved"] == ["4"]
    assert links["status"] == "pending" and stored["verification"]["status"] == "checking"
    assert calls[-1][:2] == ("links", f"card:{cid}") and calls[-1][2].startswith("3:")
    # the same takeaway again is the same version (an idempotent key); a changed one is a new version
    v1 = calls[-1][2]
    _hook_takeaway(cid, stored["takeaway"])
    assert calls[-1][2] == v1


# ----------------------------------------------------------------------------- the links job


async def test_links_job_checks_refs_by_execution_leaves_the_rest_unlinked_and_emits(monkeypatch):
    calls = _recording_enqueue(monkeypatch)
    cell = _seed(outputs=[{"text/plain": "account  deletions\nalpha    127\nbeta      3\nmonday   4\n", "_stream": "stdout"}])
    cid = cell["id"]
    _hook_ran(cell)
    stored = _hook_takeaway(cid, "Alpha deleted 127 records, 4 on Monday; the corpus has [[12|README.md#L1]] agents.")
    assert f"[[127|card:{cid}@out0#L2]]" in stored["takeaway"]
    assert stored["verification"]["links"]["unresolved"] == ["4"], "a small integer is not linked on uniqueness alone"
    await verify._links_job(C, cid, calls[-1][2])
    after = _stored(cid)
    # the file ref whose line shows no 12 is checked by execution and unwrapped, and the plain 4 stays unlinked for the
    # agent that wrote the takeaway to cite
    assert "[[4|" not in after["takeaway"]
    assert "[[12|" not in after["takeaway"] and "has 12 agents" in after["takeaway"]
    links = after["verification"]["links"]
    assert links["status"] == "partial", links
    assert [(x["value"], x["tier"]) for x in links["resolved"]] == [("127", 2)]
    assert links["broken"] == [] and "4" in links["unresolved"], "a line that shows no number contradicts nothing"
    assert links["checked"] is True and after["verification"]["status"] == "ok"
    ev = [e for e in _events() if e["type"] == "cell"]
    assert ev[-1]["kind"] == "verified" and ev[-1]["cell"] == cid and ev[-1]["notebook"] == "main"


async def test_a_bare_ref_that_does_not_resolve_is_listed_quiet_with_why(monkeypatch):
    """A `[[ref]]` with no value is checked by execution too; one that does not resolve lands in `links.quiet` with why,
    the grey chip, since red is kept for a number the cited place contradicts."""
    calls = _recording_enqueue(monkeypatch)
    cell = _seed()
    cid = cell["id"]
    _hook_ran(cell)
    _hook_takeaway(cid, f"Alpha deleted 127 records ([[card:{cid}@out0#L2]], [[card:{cid}@out0#L99]], [[agents/nope.jsonl#L1]]).")
    await verify._links_job(C, cid, calls[-1][2])
    links = _stored(cid)["verification"]["links"]
    assert [(b["ref"], b["value"]) for b in links["quiet"]] == [(f"card:{cid}@out0#L99", None), ("agents/nope.jsonl#L1", None)]
    assert links["quiet"][0]["why"] == verify.WHY_SPAN_MISSING
    assert links["quiet"][1]["why"].startswith("not found (404): no such file")
    assert links["broken"] == [] and links["status"] == "partial"


async def test_numbers_the_outputs_do_not_show_are_unresolved_and_the_card_is_still_ok(monkeypatch):
    """A takeaway stating a number neither the outputs show nor the data totals: the record names it under
    `unresolved`, the word is `unresolved`, the card's status `ok`. The row count and the column's total the same
    takeaway states are supported without a link, so they are not listed."""
    calls = _recording_enqueue(monkeypatch)
    cell = _seed(outputs=[{"text/html": TABLE_HTML, "text/plain": "table"}])
    cid = cell["id"]
    _hook_ran(cell)
    stored = _hook_takeaway(cid, "There are 2 accounts, totalling 130 deletions and 77 edits.")
    assert stored["verification"]["links"]["unresolved"] == ["77"]
    await verify._links_job(C, cid, calls[-1][2])
    v = _stored(cid)["verification"]
    assert {k: v["links"][k] for k in ("status", "resolved", "unresolved", "broken", "quiet", "checked")} == {
        "status": "unresolved", "resolved": [], "unresolved": ["77"], "broken": [], "quiet": [], "checked": True}
    assert v["status"] == "ok"


def test_a_re_run_marks_a_ref_whose_target_is_gone_and_moves_one_whose_value_moved(monkeypatch):
    calls = _recording_enqueue(monkeypatch)
    cell = _seed(outputs=[{"text/plain": PRINTED, "_stream": "stdout"}])  # printed, so the refs are line spans
    cid = cell["id"]
    _hook_ran(cell)
    stored = _hook_takeaway(cid, f"alpha made [[127|card:{cid}@out0#L2]] deletions; gamma [[44|card:{cid}@out0#L4]]; "
                                 f"beta [[1250|card:{cid}@out0#L3]].")
    assert f"[[44|card:{cid}@out0#L4]]" in stored["takeaway"]
    # the re-run prints a header line first (every line moves down one) and drops gamma
    moved = "deletions per account\n" + PRINTED.replace("gamma         44        3\n", "")
    after = _rerun(cid, [{"text/plain": moved, "_stream": "stdout"}])
    tw = after["takeaway"]
    assert f"[[127|card:{cid}@out0#L3]]" in tw and f"[[1250|card:{cid}@out0#L4]]" in tw, "moved with their lines"
    assert f"[[44|card:{cid}@out0#L4]]" in tw, "gone: kept as written, never silently unlinked"
    links = after["verification"]["links"]
    assert links["broken"] == [] and links["quiet"] == [{"value": "44", "ref": f"card:{cid}@out0#L4",
                                                          "why": "was 44 in an earlier run", "gone": True}]
    assert links["status"] == "pending" and links["unresolved"] == [] and calls[-1][0] == "links", "the job checks the rest"
    assert [x["value"] for x in links["resolved"]] == ["127", "1250"]


# ----------------------------------------------------------------------------- at a server's start


def test_rescan_enqueues_stale_and_pending_cells_only(monkeypatch):
    """A cell without a record for its run gets one (a links job when it has a takeaway); a links record left pending is
    enqueued again; a finished or failed record is left alone."""
    calls = _recording_enqueue(monkeypatch)
    ids = {name: _seed()["id"] for name in ("stale", "done", "failed", "links_pending")}
    ids["stale_takeaway"] = _seed(takeaway="Alpha deleted 127 records.")["id"]
    ids["rerun"] = _seed(takeaway="Alpha deleted 127 records.")["id"]
    ids["errored"] = _seed(status="error", outputs=[{notebook.ERROR_MIME: {"ename": "E", "evalue": ""}}])["id"]
    ws = _ws()
    nb = notebook.read_notebook(ws, "main")  # one object, changed, written once
    by = {c["id"]: c for c in nb["cells"]}
    for name in ("done", "failed", "links_pending", "rerun"):
        verify.on_cell_ran(C, nb, by[ids[name]])
    by[ids["failed"]]["verification"].update(status="failed", note="x", links={"status": "failed", "resolved": [],
                                                                               "unresolved": ["1"], "checked": False})
    lp = by[ids["links_pending"]]
    lp["takeaway"] = "Alpha deleted 127 records."
    lp["verification"]["links"] = {"status": "pending", "resolved": [], "unresolved": ["127"], "broken": [], "checked": False}
    by[ids["rerun"]]["exec_count"] = 4  # ran again after its record was written
    notebook.write_notebook(ws, nb)
    calls.clear()
    n = verify.rescan(C)
    assert sorted((k, t) for k, t, _ in calls) == sorted([
        ("links", f"card:{ids['stale_takeaway']}"), ("links", f"card:{ids['links_pending']}"), ("links", f"card:{ids['rerun']}")])
    assert n == 4, "the three enqueued and the stale cell without a takeaway, which got its record and no job"
    assert _stored(ids["stale"])["verification"]["exec_count"] == 3 and _stored(ids["rerun"])["verification"]["exec_count"] == 4
    assert _stored(ids["failed"])["verification"]["status"] == "failed"
    assert _stored(ids["errored"]).get("verification") is None


async def test_start_rescans_at_server_start(monkeypatch):
    calls = _recording_enqueue(monkeypatch)
    _seed(takeaway="Alpha deleted 127 records.")
    await jobs.start()
    assert [k for k, _, _ in calls] == ["links"]
    await asyncio.sleep(0)
