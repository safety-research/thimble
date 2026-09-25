"""The card check after add_card and edit_card (app/card_check.py): which card is read (it has its takeaway, is not a
label card and is the model's to change), the one reading of its picture against card-check.md's five criteria, and
the replacement card applied in place only for the criteria it fails and only when its code runs and its card draws,
with nothing sent to the card's author. A check ends with a mark that says why whenever it fails, runs past its time,
or is cut off by the server's stop, and a check the previous server left pending ends when the next one starts.
The harness (render.render_card), the model (card_check._call, or the Messages API behind model.structured for the
fallback after a refusal) and the kernel's trial of new code are stand-ins; the cards are invented."""
import asyncio
import io

import pytest

import stub_messages
from app import card_check, checkstore, config, model, notebook, render, tools

C = "mini"
QUESTION = "How many pages were saved each day?"
TAKEAWAY = "Most saves fell in one week, [[13,339|card:{cid}@out0#L1]] of them."


@pytest.fixture(autouse=True)
def _on(monkeypatch, workspaces_tmp):
    monkeypatch.setenv("THIMBLE_CARD_CHECK", "on")
    card_check._runs.clear()
    yield
    for r in list(card_check._runs.values()):
        if r.task:
            r.task.cancel()
    for t in list(card_check._cleanup):
        t.cancel()


def _png(w=40, h=20) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (w, h), (250, 248, 240)).save(out, format="PNG")
    return out.getvalue()


def _seed(*, kind="plot", takeaway=TAKEAWAY, locked=False, author="model", status="ok", created_by="terminal") -> dict:
    ws = config.workspace_dir(C)
    nb = notebook.read_notebook(ws, "main")
    cell = notebook.new_cell("code", created_by, QUESTION, nb["id"], code="print(13339)")
    cell.update(kind=kind, status=status, exec_count=1, outputs=[{"text/plain": "13339\n", "_stream": "stdout"}],
                takeaway=takeaway.format(cid=cell["id"]), takeaway_author=author, locked=locked)
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return notebook.get_cell(C, cell["id"])


def _label_card(concept="k1", takeaway="Most tickets are refund requests.") -> dict:
    ws = config.workspace_dir(C)
    nb = notebook.read_notebook(ws, "main")
    cell = notebook.new_cell("label", "terminal", "How many tickets are refund requests?", nb["id"], payload={"concept": concept})
    cell.update(takeaway=takeaway, takeaway_author="model")
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return notebook.get_cell(C, cell["id"])


def _assessment(*failed: tuple[int, str]) -> list[dict]:
    """Five items as the reading gives them, each with no problem except those given as (index, problem)."""
    out = [{"problem": ""} for _ in range(card_check.CRITERIA)]
    for i, problem in failed:
        out[i] = {"problem": problem}
    return out


def _same(cell: dict, **changes) -> dict:
    """The reading's output for `cell`: every criterion passed and the card given back as it is, with `changes`
    (question, code, takeaway, assessment) in their place."""
    out = {"assessment": _assessment(), "question": cell["title"], "code": cell.get("code") or "",
           "takeaway": cell["takeaway"]}
    out.update(changes)
    return out


class FakeHarness:
    """render.render_card's stand-in: every drawing succeeds unless `unavailable`, or `broken` for a candidate."""

    def __init__(self, unavailable=False, broken=False):
        self.unavailable, self.broken = unavailable, broken
        self.calls: list[dict] = []

    async def __call__(self, c, cell, *, width=None, timeout_s=None):
        self.calls.append({"cell": cell})
        if self.unavailable:
            raise render.Unavailable("no browser here")
        if self.broken and cell.get("candidate"):
            return render.Rendered(error="the card did not render: bad spec")
        return render.Rendered(png=_png(), box={"x": 16, "y": 16, "width": 720, "height": 300}, ms={"total": 140})


class FakeModel:
    """card_check._call's stand-in: returns `reading` for every card."""

    def __init__(self, reading):
        self.reading = reading
        self.calls: list[dict] = []

    async def __call__(self, c, system, user, tool, images, *, effort=None):
        self.calls.append({"tool": tool.name, "system": system, "user": user, "images": len(images), "effort": effort})
        return model.CallResult(status="ok", output=self.reading, model_used="claude-opus-5")


class Slow(FakeModel):
    """A reading that takes longer than any check's time."""

    async def __call__(self, *a, **k):
        await asyncio.sleep(5)


def _install(monkeypatch, harness, reader) -> None:
    monkeypatch.setattr(render, "render_card", harness)
    monkeypatch.setattr(card_check, "_call", reader)


async def _after(cell: dict, name="add_card", session=None, args=None):
    res = tools.ok(f"card:{cell['id']}\n13339")
    return await card_check.after_tool(C, name, args or {}, res, session=session)


async def _settle(cid: str) -> dict:
    run = card_check._runs.get((C, cid))
    if run and run.task:
        await asyncio.wait_for(asyncio.shield(run.task), 5)
    return notebook.get_cell(C, cid)


def _rec(cid: str) -> dict:
    return notebook.get_cell(C, cid).get("check") or {}


def _trial(monkeypatch, status="ok"):
    """checkstore.candidate and notebook.trial_settle without a kernel: the candidate's code 'runs' with `status`.
    Returns (the patches tried, the settles as (trial, keep))."""
    tried, settled = [], []

    async def candidate(c, cid, patch):
        tried.append(dict(patch))
        out = {**notebook.get_cell(C, cid), **patch, "status": status, "trial": "t1", "candidate": True}
        out["outputs"] = ([{"text/plain": "13339\n", "_stream": "stdout"}] if status == "ok" else
                          [{"application/vnd.thimble.error+json": {"ename": "KeyError", "evalue": "'page'"}}])
        return out

    async def trial_settle(c, cid, tid, keep):
        settled.append((tid, keep))

    monkeypatch.setattr(checkstore, "candidate", candidate)
    monkeypatch.setattr(notebook, "trial_settle", trial_settle)
    return tried, settled


# ----------------------------------------------------------------------------- which card is read


def test_a_card_is_read_once_it_has_its_takeaway_and_never_a_label_card_or_one_no_replacement_could_change():
    assert card_check.wants_check(_seed())
    assert not card_check.wants_check(_seed(takeaway="")), "read once its author writes the takeaway"
    assert not card_check.wants_check(_seed(status="error")), "an errored card goes back through its own result"
    assert card_check.wants_check(_seed(kind="note")) is True
    assert not card_check.wants_check(_label_card()), "thimble draws a label card from its label: no reading"
    assert not card_check.wants_check(_seed(locked=True)), "the analyst's lock: nothing could replace it"
    assert not card_check.wants_check(_seed(created_by="user")), "a card the analyst made"
    assert card_check.wants_check(_seed(author="analyst")), "the analyst's takeaway stays, the rest may change"
    assert not card_check.wants_check(None)


# ----------------------------------------------------------------------------- what the replacement changes


async def test_a_new_takeaway_lands_in_place_as_one_step_and_nothing_reaches_the_author(monkeypatch):
    cell = _seed(takeaway="Saves fell to [[13,393|card:{cid}@out0#L1]].")
    new = "Saves fell to [[13,339|card:%s@out0#L1]]." % cell["id"]
    harness = FakeHarness()
    _install(monkeypatch, harness, FakeModel(_same(cell, takeaway=new,
                                                   assessment=_assessment((4, "The takeaway misreads the count.")))))
    await _after(cell)
    done = await _settle(cell["id"])
    assert done["check"]["status"] == "fixed" and "13,339" in done["takeaway"] and done["title"] == QUESTION
    fix = done["fixes"][-1]
    assert fix["state"] == "applied" and fix["by"] == "check" and fix["fields"] == ["takeaway"]
    assert fix["reason"] == "The takeaway misreads the count.", "the note of the criterion it failed"
    assert len(harness.calls) == 2 and harness.calls[1]["cell"].get("candidate"), "the replaced card is drawn once"
    later = await card_check.after_tool(C, "read_ref", {}, tools.ok("rows"))
    assert later.text == "rows", "the author's next tool result carries nothing of the check"


async def test_new_code_is_tried_on_the_kernel_and_kept_when_it_runs_and_draws(monkeypatch):
    cell = _seed()
    new = "print(13339)  # sorted"
    tried, settled = _trial(monkeypatch)
    _install(monkeypatch, FakeHarness(), FakeModel(_same(cell, code=new, assessment=_assessment((2, "The labels are cut.")))))
    await _after(cell)
    done = await _settle(cell["id"])
    assert tried == [{"code": new}] and settled == [("t1", True)]
    assert done["code"] == new and done["check"]["status"] == "fixed"


async def test_code_that_fails_or_a_card_that_does_not_draw_leaves_the_original_with_no_mark(monkeypatch):
    for broken, status in ((False, "error"), (True, "ok")):
        cell = _seed()
        _, settled = _trial(monkeypatch, status=status)
        _install(monkeypatch, FakeHarness(broken=broken), FakeModel(_same(cell, code="df.plot()",
                                                                          assessment=_assessment((2, "Cut labels.")))))
        await _after(cell)
        done = await _settle(cell["id"])
        assert done["code"] == "print(13339)" and settled == [("t1", False)], "the trial's variables are put back"
        assert done["check"]["status"] == "error" and "problems" not in done["check"]
        rejected = done["fixes"][-1]
        assert rejected["state"] == "rejected" and rejected["after"] == {"code": "df.plot()"}
        assert ("KeyError" in rejected["reason"]) if status == "error" else ("did not draw" in rejected["reason"])


def test_what_the_replacement_gives_back_unchanged_or_empty_is_not_applied():
    """A part equal to the card's (the code up to trailing spaces), or left empty, keeps the card's own; a card of data
    has no code to replace; a code longer than the reading saw is never replaced; the analyst's takeaway stays."""
    cell = _seed()
    assert card_check._patch(cell, _same(cell, code="print(13339)   \n\n", question=f" {QUESTION} ")) == {}
    assert card_check._patch(cell, _same(cell, code="", question="", takeaway="")) == {}
    note = {**_seed(kind="note"), "code": ""}
    assert card_check._patch(note, _same(note, code="print(1)")) == {}, "a card of data runs no code"
    long = {**cell, "code": "x = 1\n" * 2000}
    assert card_check._patch(long, _same(long, code="x = 2")) == {}
    theirs = _seed(author="analyst")
    assert card_check._patch(theirs, _same(theirs, takeaway="Other words.", question="Another question?")) == \
        {"title": "Another question?"}


async def test_a_card_that_fails_no_criterion_stays_as_it_is_whatever_the_replacement_says(monkeypatch):
    """The prompt asks for changes only to what fails a criterion, so a replacement that rewrites a card the reading
    found nothing wrong with is not applied."""
    cell = _seed()
    tried, _ = _trial(monkeypatch)
    _install(monkeypatch, FakeHarness(), FakeModel(_same(cell, code="print(13339)  # tidied", question="Saves per day?")))
    await _after(cell)
    done = await _settle(cell["id"])
    assert tried == [] and done["code"] == "print(13339)" and done["title"] == QUESTION and "fixes" not in done
    assert done["check"]["status"] == "ok"
    assert card_check._timings[-1]["not_applied"] == ["code", "title"]


# ----------------------------------------------------------------------------- how a check ends


async def test_every_failure_says_why_on_the_record(monkeypatch):
    unavailable = _seed()
    _install(monkeypatch, FakeHarness(unavailable=True), FakeModel({}))
    await _after(unavailable)
    assert "no picture can be drawn here" in (await _settle(unavailable["id"]))["check"]["reason"]

    refused = _seed()

    class Refusing(FakeModel):
        async def __call__(self, *a, **k):
            return model.CallResult(status="refused", detail="the model refused")

    _install(monkeypatch, FakeHarness(), Refusing({}))
    await _after(refused)
    rec = (await _settle(refused["id"]))["check"]
    assert rec["reason"].startswith("the model declined to read the card") and rec["stages"]["critique"]["message"]

    broken = _seed()
    _install(monkeypatch, FakeHarness(), FakeModel(_same(broken, code="print(page)",
                                                          assessment=_assessment((2, "the label is cut")))))
    _trial(monkeypatch, status="error")
    await _after(broken)
    rec = (await _settle(broken["id"]))["check"]
    assert rec["status"] == "error" and rec["reason"].startswith("its revision was not kept: its code did not run clean")

    slow = _seed()
    monkeypatch.setattr(card_check, "CHECK_TIMEOUT_S", dict.fromkeys(card_check.CHECK_TIMEOUT_S, 0.1))
    _install(monkeypatch, FakeHarness(), Slow({}))
    await _after(slow)
    assert "ran past its 0 s" in (await _settle(slow["id"]))["check"]["reason"]


async def test_a_reading_the_verify_models_safeguards_refuse_runs_on_the_fallback_and_the_record_says_so(monkeypatch):
    """The reading goes through model.structured to a stubbed Messages API that refuses every request on the verify
    role's model: it runs again on the fallback model, the check ends as that reading says, and the record's note,
    which the check mark's hover shows, says which model refused and which read the card. The refused reading's time
    is left out of the check's, so a check whose two readings together outlast its limit still finishes."""
    model._bind_sdk()  # the SDK's first import, which model.structured pays on its first call, outside the check's time
    cell = _seed()
    verify = card_check._role(C)["model"]
    assert verify != stub_messages.FALLBACK
    stub = stub_messages.install(monkeypatch, stub_messages.refusing(verify, lambda req: _same(cell)), delay_s=0.6)
    monkeypatch.setattr(card_check, "CHECK_TIMEOUT_S", dict.fromkeys(card_check.CHECK_TIMEOUT_S, 1.0))
    monkeypatch.setattr(render, "render_card", FakeHarness())
    await _after(cell)
    rec = (await _settle(cell["id"]))["check"]
    assert rec["status"] == "ok", rec
    assert rec["note"] == "Downgrading Opus 5.5 to Opus 4.8"
    assert rec["stages"]["critique"]["model"] == stub_messages.FALLBACK
    assert [q["model"] for q in stub.requests] == [verify, stub_messages.FALLBACK]
    assert card_check._timings[-1]["refused_by"] == verify


async def test_a_check_past_its_time_ends_without_a_mark(monkeypatch):
    cell = _seed()
    _install(monkeypatch, FakeHarness(), Slow({}))
    monkeypatch.setattr(card_check, "CHECK_TIMEOUT_S", dict.fromkeys(card_check.CHECK_TIMEOUT_S, 0.2))
    await _after(cell)
    done = await _settle(cell["id"])
    assert done["check"]["status"] == "error" and done["takeaway"] == cell["takeaway"]
    assert card_check._timings[-1]["card"] == cell["id"] and card_check._timings[-1]["timed_out_s"] == 0.2


async def test_a_check_running_when_the_server_stops_ends_as_an_error(monkeypatch):
    """shutdown(): a check cancelled with the server ends its record `error`, so the card shows the run-again mark
    rather than a spinner nothing will stop."""
    cell = _seed()
    gate = asyncio.Event()

    async def slow(c, system, user, tool, images, *, effort=None):
        await gate.wait()

    _install(monkeypatch, FakeHarness(), slow)
    await _after(cell)
    for _ in range(50):
        if notebook.get_cell(C, cell["id"])["check"]["stages"].get("render"):
            break
        await asyncio.sleep(0.01)
    await card_check.shutdown()
    rec = notebook.get_cell(C, cell["id"])["check"]
    assert rec["status"] == "error" and rec["reason"] == card_check.SERVER_STOPPED and card_check._runs == {}


def test_a_check_the_previous_server_left_pending_ends_when_the_server_starts():
    cell = _seed()
    checkstore.begin(C, cell["id"])
    marked = notebook.mark_interrupted_cells(config.WORKSPACES_DIR)
    rec = _rec(cell["id"])
    assert rec["status"] == "error" and rec["reason"] == checkstore.INTERRUPTED_REASON and "phase" not in rec
    assert any(cell["id"] in m for m in marked)
    assert notebook.get_cell(C, cell["id"])["status"] == "ok", "the card's own run is untouched"
