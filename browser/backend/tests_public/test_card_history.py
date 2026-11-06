"""A card's history (notebook.stamp_edit, version_of, restore_version): an edit of a card replaces it in place and is an
entry of its `edited` list naming the fields it changed, and what it replaced is kept beside the groups, so Restore and
the top bar's Undo bring the card as it was back."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app import config, notebook, tools

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


async def test_a_new_kind_replaces_the_card_in_place_and_restore_and_undo_bring_it_back(group, ran):
    """Asked to animate a plot, main gives the plot card the kind custom and its page: the card keeps its id and its
    place and shows the page, its code and outputs gone, as one edit whose record keeps them, so Restore and Undo show
    the plot again without a run. A custom card given a running kind and code runs the code in its place."""
    from app import undo  # noqa: PLC0415

    other = _cid(await call("add_card", group, kind="note", question="What is on the board?", text="Two cards."))
    cid = _cid(await call("add_card", group, kind="plot", question="How many tickets came in each day?",
                          code="print(7)", takeaway="Seven a day."))
    order = [c["id"] for c in notebook.read_notebook(config.workspace_dir(CORPUS), group)["cells"]]
    r = await call("edit_card", group, card=f"card:{cid}", kind="custom", html="<svg id='c'></svg><script>draw()</script>")
    assert not r.is_error and _cid(r) == cid and "<svg id='c'>" in r.text, r.text
    cell = _cell(cid)
    assert (cell["kind"], cell["payload"]["html"], cell["takeaway"]) == ("custom", "<svg id='c'></svg><script>draw()</script>", "")
    assert not {"code", "outputs", "status", "exec_count"} & set(cell)
    assert [c["id"] for c in notebook.read_notebook(config.workspace_dir(CORPUS), group)["cells"]] == order == [other, cid]
    [e] = _edits(cid)
    assert e["fields"] == ["kind", "code", "payload", "takeaway"]
    rec = _record(cid, e["id"])
    assert (rec["was"]["kind"], rec["was"]["code"]) == ("plot", "print(7)") and "out: print(7)" in json.dumps(rec["shown"])
    runs = len(ran)
    notebook.restore_version(CORPUS, cid, e["id"])
    cell = _cell(cid)
    assert (cell["kind"], cell["code"], cell["takeaway"]) == ("plot", "print(7)", "Seven a day.") and "payload" not in cell
    assert "out: print(7)" in json.dumps(cell["outputs"]) and len(ran) == runs, "the plot as it was, without a run"
    undo.undo(CORPUS)  # the Restore, then the change of kind
    undo.undo(CORPUS)
    cell = _cell(cid)
    assert (cell["kind"], cell["code"]) == ("plot", "print(7)") and "out: print(7)" in json.dumps(cell["outputs"])
    undo.redo(CORPUS)
    assert _cell(cid)["kind"] == "custom" and "code" not in _cell(cid)
    r = await call("edit_card", group, card=f"card:{cid}", kind="plot", code="print(8)")
    cell = _cell(cid)
    assert not r.is_error and (cell["kind"], cell["code"]) == ("plot", "print(8)") and "payload" not in cell, r.text
    assert "out: print(8)" in json.dumps(cell["outputs"]) and ran[-1].endswith("print(8)")
