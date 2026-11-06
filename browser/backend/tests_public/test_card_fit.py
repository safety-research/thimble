"""app.card_fit: a card whose body draws taller than the analyst's screen holds (card_size.BODY_MAX) is held before the
analyst sees it, and the card check reads it with one more criterion. The card shows when that check ends, as the
check left it: the check's replacement takes its place. The harness's drawing, the kernel and the model are faked
here; all data is made up."""
from __future__ import annotations

import re

import pytest

from app import card_check, card_fit, card_size, model, notebook, render, tools

CORPUS = "mini"


def png() -> bytes:
    """A made-up picture of a card: one white pixel."""
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (1, 1), "white").save(out, format="PNG")
    return out.getvalue()


def size(cell: dict) -> card_fit.Size:
    """A card as the fake harness draws it: a card of code as tall as the number the last line of its code gives."""
    last = str(cell.get("code") or "300").strip().splitlines()[-1]
    return card_fit.Size(body=float(eval(last, {"__builtins__": {}})))


@pytest.fixture(autouse=True)
def _harness(workspaces_tmp, monkeypatch):
    """The harness draws each card at its size (size); `calls` counts the drawings, what the card's record was during
    each, and every model call outside the check's reading, which none makes."""
    card_size.forget(CORPUS)
    card_fit.forget(CORPUS)
    tools._last_cell.clear()
    calls: dict = {"drawn": 0, "held_while_drawn": [], "model": []}

    async def measure(c, cell):
        calls["drawn"] += 1
        # the card waits for its measure from the moment its content was stored: the canvas never saw it
        calls["held_while_drawn"].append((notebook.get_cell(c, cell["id"]) or {}).get("held"))
        return size(cell)

    async def structured(prompt, **kw):
        calls["model"].append(prompt)
        return model.CallResult(status="error", detail="no model in this test")

    monkeypatch.setattr(card_fit, "holds_here", lambda *c: True)
    monkeypatch.setattr(card_fit, "_measure", measure)
    monkeypatch.setattr(model, "structured", structured)
    return calls


@pytest.fixture()
async def checking(monkeypatch):
    """The card check on, with its drawing and its reading stood in for: a card draws at its size (size), and the
    reading finds the card's question vague and gives back `revision` (its code, and its takeaway when given). Each
    reading notes whether it read the card as one that does not fit (`revision["read"]`). The kernel prints the value
    of the code's last line."""
    revision: dict = {"read": []}

    async def started(k, workspace, kernel=None) -> None:
        return None

    async def run(k, code, kind, timeout_s, extra_exprs=None):
        k.last_labels, k.last_label_revs = [], {}
        return [{"text/plain": str(eval(code.strip().splitlines()[-1], {"__builtins__": {}}))}], 1, "ok"

    async def draw(c, cell):
        return render.Rendered(png=png(), body=size(cell).body)

    async def read(c, cell, picture, run, path=None):
        too = (await card_check.card_input(c, cell, run, None))["card"]["too_large"]
        revision["read"].append(too)
        criteria = card_check.CRITERIA + 1 if too else card_check.CRITERIA
        assessment = [{"problem": "The question names no runs."}] + [{"problem": ""}] * (criteria - 1)
        return assessment, {"question": cell["title"], "code": revision.get("code", cell.get("code") or ""),
                            "takeaway": revision.get("takeaway", cell["takeaway"])}, "test-model"

    monkeypatch.setattr(card_check, "enabled", lambda: True)
    monkeypatch.setattr(card_check, "auto", lambda c: True)
    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", run)
    monkeypatch.setattr(render, "down", lambda: False)
    monkeypatch.setattr(card_check, "_draw", draw)
    monkeypatch.setattr(card_check, "_read", read)
    yield revision
    await notebook.shutdown_all()


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", terminal=True)


def _cid(res) -> str:
    assert not res.is_error, res.text
    return re.search(r"^card:([A-Za-z0-9_-]+)$", res.text, re.M).group(1)


def held(cid: str) -> dict | None:
    return (notebook.get_cell(CORPUS, cid) or {}).get("held")


def card_fit_lines() -> list[dict]:
    import json

    from app import config

    p = config.workspace_dir(CORPUS) / card_fit.LOG_FILE
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []


async def checked(cid: str) -> dict:
    """Card `cid` once the check that reads it now has ended."""
    run = card_check._runs.get((CORPUS, cid))
    assert run is not None, "no check reads the card"
    await run.task
    return notebook.get_cell(CORPUS, cid)


async def test_a_card_that_does_not_fit_shows_once_its_check_ends_as_the_check_s_replacement(_harness, checking):
    checking["code"] = "620"  # the check's replacement: the failed nights alone
    res = await call("add_card", kind="table", question="Which runs failed?", code="4068",
                     takeaway="14 of the 56 runs failed.")
    cid = _cid(res)
    assert " px" not in res.text, "the result says nothing of the card's size"
    assert held(cid) and held(cid)["body"] == 4068 and _harness["held_while_drawn"] == [notebook.MEASURING_HELD]
    cell = await checked(cid)
    assert held(cid) is None and cell["code"] == "620" and cell["check"]["status"] == "fixed"
    # one pass: the check read it once, as a card that does not fit, and no other model call was made for it
    assert checking["read"] == [True] and not _harness["model"]
    assert [(r["action"], r.get("why")) for r in card_fit_lines()] == [("held", None), ("shown", "checked")]
