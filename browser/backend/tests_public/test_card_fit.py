"""app.card_fit: a card whose body draws taller than the analyst's screen holds (card_size.BODY_MAX), or whose content
lays out wider than its card, is held before the analyst sees it, and the card check reads it with one more criterion.
The card shows when that check ends, as the check left it, whatever its size, and the result of the call that made it
says nothing of it. No model call measures a card. A card that fits shows at once, and its check reads it as any card. A
held card that no check reads shows when the turn or run of the one who made it ends (main's turn, an agent of
thimble's run, a thread's fork), or when the server starts again. The harness's drawing, the kernel and the model are
faked here; all data is made up."""
from __future__ import annotations

import asyncio
import contextlib
import re

import pytest

from app import card_check, card_fit, card_size, model, notebook, render, tools

CORPUS = "mini"
HOLDS_HERE = card_fit.holds_here  # as the module has it, before a test stands in for it


def png() -> bytes:
    """A made-up picture of a card: one white pixel."""
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (1, 1), "white").save(out, format="PNG")
    return out.getvalue()


def page(height: int, width: int = 0) -> str:
    """A made-up page the fake harness draws `height` px tall, and `width` px wide in a 692 px frame when given."""
    return f"<table><tr><td>run 1</td></tr></table><!-- h{height} w{width} -->"


def size(cell: dict) -> card_fit.Size:
    """A card as the fake harness draws it: a page at the size it names, and a card of code as tall as the number the
    last line of its code gives."""
    m = re.search(r"<!-- h(\d+) w(\d+) -->", str((cell.get("payload") or {}).get("html") or ""))
    if m:
        h, w = int(m.group(1)), int(m.group(2))
        return card_fit.Size(body=h, width=w, frame=692 if w else 0)
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
    reading notes whether it read the card as one that does not fit (`revision["read"]`), and waits for
    `revision["gate"]` when the test sets it. The kernel prints the value of the code's last line."""
    revision: dict = {"read": []}

    async def started(k, workspace, kernel=None) -> None:
        return None

    async def run(k, code, kind, timeout_s, extra_exprs=None):
        k.last_labels, k.last_label_revs = [], {}
        return [{"text/plain": str(eval(code.strip().splitlines()[-1], {"__builtins__": {}}))}], 1, "ok"

    async def draw(c, cell):
        return render.Rendered(png=png(), body=size(cell).body)

    async def read(c, cell, picture, run, path=None):
        too = (await card_check.card_input(c, cell, run, None, card_check._sections()))["card"]["too_large"]
        revision["read"].append(too)
        if "gate" in revision:
            await revision["gate"].wait()
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
    # the result says what it said before thimble measured cards: nothing of the hold or of the card's size
    assert "The analyst" not in res.text and "evidence for its answer" not in res.text and " px" not in res.text
    assert held(cid) and held(cid)["body"] == 4068 and _harness["held_while_drawn"] == [notebook.MEASURING_HELD]
    cell = await checked(cid)
    assert held(cid) is None and cell["code"] == "620" and cell["check"]["status"] == "fixed"
    # one pass: the check read it once, as a card that does not fit, and no other model call was made for it
    assert checking["read"] == [True] and not _harness["model"]
    assert [(r["action"], r.get("why")) for r in card_fit_lines()] == [("held", None), ("shown", "checked")]
    # nor does the check tell its author the size of the version the analyst never saw
    after = await call("add_card", kind="note", question="What comes next?", text="The failed nights.")
    assert "px tall" not in after.text


async def test_a_replacement_that_still_does_not_fit_shows_as_the_check_left_it_with_no_second_round(_harness,
                                                                                                   checking):
    checking["code"] = "2400"
    cid = _cid(await call("add_card", kind="table", question="Which runs failed?", code="4068",
                          takeaway="14 of the 56 runs failed."))
    cell = await checked(cid)
    assert held(cid) is None and cell["code"] == "2400" and cell["check"]["status"] == "fixed"
    assert [f["state"] for f in cell["fixes"]] == ["applied"]
    assert checking["read"] == [True] and not _harness["model"]


async def test_a_card_that_fits_shows_at_once_and_its_check_reads_it_as_any_card(_harness, checking):
    res = await call("add_card", kind="table", question="Which runs failed?", code="480",
                     takeaway="14 of the 56 runs failed.")
    cid = _cid(res)
    # held only while the harness drew it, shown once it fit
    assert _harness["held_while_drawn"] == [notebook.MEASURING_HELD] and held(cid) is None
    await checked(cid)
    assert checking["read"] == [False]
    drawn = _harness["drawn"]
    await call("edit_card", card=cid, takeaway="14 runs failed.")
    assert _harness["drawn"] == drawn and held(cid) is None  # the same version: not drawn again


async def turn_text(conv, monkeypatch) -> str:
    """What the engine is sent for a turn of `conv` that starts now (runtime._engine_turn), with the engine faked."""
    from app import claude_access, runtime, runtime_api

    sent: list[str] = []

    async def turn(conv, text):
        sent.append(text)
        return runtime.TurnEnd("done")

    monkeypatch.setattr(claude_access, "problem", lambda: None)
    monkeypatch.setattr(runtime, "engine", lambda: "api")
    monkeypatch.setattr(runtime_api, "turn", turn)
    await runtime._engine_turn(conv, '<thimble-event kind="main" event="e1">\nAnd now?\n</thimble-event>')
    return sent[0]


async def test_the_check_s_replacement_reaches_its_author_with_its_next_call_or_as_its_next_turn_starts(
        _harness, checking, monkeypatch):
    """The analyst sees the check's version of a card in place of its author's, so the author hears of it once: its
    kind, question and takeaway, and what changed. A turn that still runs reads it in its next thimble call's result,
    else the author's next turn reads it as it starts, main's or a thread's fork's. Nothing waits for the check."""
    from types import SimpleNamespace

    from app import agents, runtime, session

    checking["code"], checking["takeaway"] = "620", "4 of the 56 runs failed, all in enrich."
    made = await call("add_card", kind="table", question="Which runs failed?", code="4068",
                      takeaway="14 of the 56 runs failed.")
    cid = _cid(made)
    assert "card check" not in made.text and held(cid)
    await checked(cid)
    # main's turn still runs: its next thimble call reads the version the analyst sees
    told = (await call("list_cards", group="all")).text
    assert f"thimble's card check replaced card:{cid} in place, so the analyst sees its version, not yours" in told
    # its kind, and what its code draws, since that is not a table (this test's kernel prints the code's last value)
    assert "not yours: a table card that draws text. Its question is “Which runs failed?”" in told
    assert "its takeaway “4 of the 56 runs failed, all in enrich.”" in told
    assert "It changed the code and takeaway: The question names no runs." in told
    assert "card check" not in (await call("list_cards", group="all")).text  # told once

    # main's turn ended before the check of its next card did: its next turn reads it as it starts
    space = SimpleNamespace(c=CORPUS, take_notes=lambda conv_id: [])
    main = runtime.Conv(space, runtime.MAIN, "main")
    later = _cid(await call("add_card", kind="table", question="How long did each run take?", code="3000",
                            takeaway="Each run took 40 s."))
    await checked(later)
    text = await turn_text(main, monkeypatch)
    assert text.startswith(runtime.NOTES_HEAD) and f"replaced card:{later}" in text and text.endswith("</thimble-event>")
    assert "card check" not in (await call("list_cards", group="all")).text  # told once

    # a thread's fork's card: the fork hears of it, with its next call or as its next run starts, and main does not
    tid = agents.new_thread(CORPUS, None, None, "Which stage failed most?")["id"]
    as_fork = dict(actor="analyst", terminal=True, chat=tid)
    forked = _cid(await tools.call(CORPUS, "add_card", dict(kind="table", question="Which stage failed most?",
                                                            code="2400", takeaway="Enrich failed most."), **as_fork))
    await checked(forked)
    assert "card check" not in (await call("list_cards", group="all")).text
    assert f"replaced card:{forked}" in (await tools.call(CORPUS, "list_cards", {"group": "all"}, **as_fork)).text
    again = _cid(await tools.call(CORPUS, "add_card", dict(kind="table", question="When did enrich fail?",
                                                           code="2400", takeaway="Enrich failed on 3 nights."),
                                  **as_fork))
    await checked(again)
    monkeypatch.setattr(session, "chat_of_agent", lambda c, agent_id: tid if agent_id == "a1" else None)
    fork = runtime.Conv(space, "a1", "fork", agent_id="a1", agent_type=runtime.FORK_TYPE)
    assert "card check" not in await turn_text(main, monkeypatch)
    assert f"replaced card:{again}" in await turn_text(fork, monkeypatch)


async def test_a_held_card_waits_for_its_takeaway_then_for_its_check_whatever_the_turn(_harness, checking):
    checking["gate"] = asyncio.Event()
    cid = _cid(await call("add_card", kind="table", question="Which runs failed?", code="4068"))
    assert held(cid) and (CORPUS, cid) not in card_check._runs  # no takeaway: nothing to check yet
    drawn = _harness["drawn"]
    await call("edit_card", card=cid, takeaway="14 of the 56 runs failed.")
    assert _harness["drawn"] == drawn and held(cid)  # the content as measured: not drawn again
    run = card_check._runs[(CORPUS, cid)]
    # main's turn ends while the check reads the card: it waits for the check, not for the turn
    assert card_fit.turn_ended(CORPUS) == [] and held(cid)
    checking["gate"].set()
    await run.task
    assert held(cid) is None and checking["read"] == [True]


async def test_a_new_version_waits_for_its_own_check_and_the_check_of_the_one_before_shows_nothing(_harness,
                                                                                                    checking):
    checking["gate"] = asyncio.Event()
    cid = _cid(await call("add_card", kind="table", question="Which runs failed?", code="4068",
                          takeaway="14 of the 56 runs failed."))
    first = card_check._runs[(CORPUS, cid)]
    for _ in range(500):  # the first check reads the card
        if checking["read"]:
            break
        await asyncio.sleep(0.01)
    # its author's next version, which does not fit either: its takeaway goes with its code, so it waits for that
    await call("edit_card", card=cid, code="3000")
    with contextlib.suppress(asyncio.CancelledError):
        await first.task
    assert held(cid) and held(cid)["body"] == 3000  # the end of the first check left the new version held
    await call("edit_card", card=cid, takeaway="14 of the 56 runs failed.")
    second = card_check._runs[(CORPUS, cid)]
    assert second is not first and held(cid)
    checking["gate"].set()
    await second.task
    assert held(cid) is None and checking["read"] == [True, True]


async def test_the_reading_of_a_card_that_does_not_fit_asks_one_more_criterion(monkeypatch):
    seen = []

    async def reading(c, system, user, tool, images, *, effort, model=None):
        seen.append((user, tool.input_schema["properties"]["assessment"]))

    monkeypatch.setattr(card_check, "_call", reading)
    card = {"id": "c1", "kind": "table", "question": "Which runs failed?", "takeaway": "14 of the 56 runs failed.",
            "code": "runs"}
    await card_check.check_task(CORPUS, {"card": {**card, "too_large": True}, "picture": None, "effort": "low"})
    await card_check.check_task(CORPUS, {"card": {**card, "too_large": False}, "picture": None, "effort": "low"})
    (large, six), (fits, five) = seen
    assert "does not fit on the analyst's screen" in large and "only what the question needs" in large
    # with the card guidance its author works from, and the toolkit it writes a card's code with
    assert "The content is the evidence for one answer" in large and "thimble.chart(kind, df)" in large
    assert "does not fit" not in fits and "thimble.chart(kind, df)" not in fits
    assert (six["minItems"], six["maxItems"], five["minItems"], five["maxItems"]) == (6, 6, 5, 5)
    assert card_check._assessment([{"problem": ""}] * 6, 6) and card_check._assessment([{"problem": ""}] * 5, 6) is None


async def test_the_check_of_a_thread_s_card_reads_the_analyst_s_question_in_that_thread(monkeypatch, tmp_path):
    """A thread's fork works as main (its card's author is main), and the request it answers is the analyst's question
    in its thread, which main's conversation does not hold: the check reads that thread whole, however long main's
    conversation is."""
    import json

    from app import agents, context

    path = tmp_path / "main.jsonl"  # main's conversation, far longer than the check reads
    path.write_text("\n".join(json.dumps({"type": "user", "message": {"role": "user", "content": f"Question {i}. " +
                                                                      "x" * 600}}) for i in range(100)))
    monkeypatch.setattr(context, "transcript_path", lambda c: path)
    anchor = _cid(await call("add_card", kind="custom", question="How many runs failed?", html=page(300)))
    tid = agents.new_thread(CORPUS, f"card:{anchor}", "How many runs failed?")["id"]
    asked = "Show me every stage of every run behind this card, with its start time, status and error."
    agents.append(agents.paths(CORPUS, tid)[1], {"type": "user", "text": asked})
    cell = {"id": "c9", "kind": "table", "title": "What did each stage of each run do?", "created_by": f"chat:{tid}"}
    text = card_check._context_text(CORPUS, cell, card_check.MAIN)
    assert f"### thread:{tid}" in text and asked in text
    assert "Question 0." not in text  # main's oldest turns are what the budget leaves out


async def test_a_card_held_with_no_check_shows_as_it_stands_when_main_s_turn_ends(_harness):
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    assert held(cid)
    assert card_fit.turn_ended(CORPUS) == [cid]
    assert held(cid) is None and card_fit_lines()[-1]["why"] == "turn ended"
    assert card_fit.turn_ended(CORPUS) == []


async def as_session(session: str | None = None, tool_use_id: str | None = None, **args):
    """add_card as one of thimble's agents (`session`) or a subagent of main's (the caller hook's `tool_use_id`)."""
    return await tools.call(CORPUS, "add_card", args, actor="analyst", terminal=True, session=session,
                            tool_use_id=tool_use_id)


async def test_a_card_the_orientation_or_a_thread_s_fork_holds_waits_for_its_own_end_not_main_s(_harness):
    """Main's turn end shows only the cards main's own calls hold. The orientation's card shows when the
    orientation's run ends (subagents.run_ended), and a thread's fork's when the fork ends (session._finish_sub)."""
    from app import agents, config, session, subagents
    from app import subagent_files as sf

    ws = config.workspace_dir(CORPUS)
    mine = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    orient = _cid(await as_session(tools.ORIENT_SESSION, kind="custom", question="How long did each stage take?",
                                   html=page(2400)))
    sf.add_caller(ws, "toolu_fork1", "fork1", sf.FORK_TYPE)
    forked = _cid(await as_session(None, "toolu_fork1", kind="custom", question="Which stage failed most?",
                                   html=page(2400)))
    assert held(orient)["author"] == tools.ORIENT_SESSION and held(forked)["agent"] == "fork1"
    assert "agent" not in held(mine)

    lv = session.Live(CORPUS, "sid", str(ws), None, None)
    session._open_turn(lv)
    session._end_turn(lv)
    assert held(mine) is None and held(orient) and held(forked)

    with subagents.update(CORPUS) as state:
        sf.registry(state)["orient1"] = {"role": "orientation", "key": tools.ORIENT_SESSION, "status": "running"}
    assert subagents.run_ended(CORPUS, "orient1", "done", "The analysis.", source="handback")
    assert held(orient) is None and held(forked)

    tid = agents.new_thread(CORPUS, None, None, "Which stage failed most?")["id"]
    session._finish_sub(lv, session.Sub(CORPUS, tid, "toolu_fork", "fork1", thread=True), "completed", None)
    assert held(forked) is None
    assert [r["why"] for r in card_fit_lines() if r["action"] == "shown"] == ["turn ended", "run ended", "agent ended"]


async def test_main_s_turn_end_leaves_a_card_the_orientation_s_call_is_measuring(_harness, monkeypatch):
    """A card waits for its measure with who made it on its record, so main's turn end in that moment leaves it, and
    the measure holds it."""
    seen: dict = {}

    async def measure(c, cell):
        seen["held"] = (notebook.get_cell(c, cell["id"]) or {}).get("held")
        seen["shown"] = card_fit.turn_ended(c)  # main's turn ends while the card is drawn
        return card_fit.Size(body=2400)

    monkeypatch.setattr(card_fit, "_measure", measure)
    cid = _cid(await as_session(tools.ORIENT_SESSION, kind="custom", question="How long did each stage take?",
                                html=page(2400)))
    assert seen == {"held": {**notebook.MEASURING_HELD, "author": tools.ORIENT_SESSION}, "shown": []}
    assert held(cid)["author"] == tools.ORIENT_SESSION and held(cid)["body"] == 2400


async def test_a_page_wider_than_its_card_is_held_with_its_width_and_the_card_s(_harness):
    cid = _cid(await call("add_card", kind="custom", question="How did the outage unfold?", html=page(300, 1180)))
    assert held(cid) and (held(cid)["width"], held(cid)["frame"]) == (1180, 692)


async def test_a_card_left_held_by_the_server_before_shows_at_the_next_start(_harness, workspaces_tmp):
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    assert held(cid)
    marked = notebook.mark_interrupted_cells(workspaces_tmp)
    assert any(m.endswith(f"/{cid} (held)") for m in marked)
    notebook.clear_cache()
    assert held(cid) is None


async def test_nothing_is_held_where_no_card_can_be_drawn(_harness, monkeypatch):
    async def undrawn(c, cell):
        return None

    monkeypatch.setattr(card_fit, "_measure", undrawn)
    res = await call("add_card", kind="custom", question="Which runs failed?", html=page(2400))
    assert held(_cid(res)) is None
    # and where no card can be drawn at all, no card waits even for its measure
    monkeypatch.setattr(card_fit, "holds_here", lambda *c: False)
    res = await call("add_card", kind="custom", question="Which runs failed?", html=page(2400))
    assert held(_cid(res)) is None


def test_a_card_is_held_only_where_the_card_check_reads_cards_by_itself(monkeypatch):
    """A held card shows when its check ends: where the workspace does not check cards by itself, none would end."""
    from app import launch_mode

    monkeypatch.setattr(render, "enabled", lambda: True)
    monkeypatch.setattr(render, "down", lambda: False)
    monkeypatch.setattr(launch_mode, "current", lambda: launch_mode.BROWSER)
    monkeypatch.setattr(card_check, "enabled", lambda: True)
    monkeypatch.setattr(card_check, "auto", lambda c: c == "checked")
    assert HOLDS_HERE("checked") and not HOLDS_HERE("unchecked")


async def test_a_card_of_code_whose_run_failed_shows_with_its_error_and_is_not_measured(_harness, monkeypatch):
    async def errored(*a, **k):
        """A run whose code raised: the card stored with its error."""
        made = notebook.new_cell("table", k["created_by"], k["title"], k["notebook"], code="1/0")
        cell = notebook.insert_cell(CORPUS, k["notebook"], {**made, "status": "error"})
        assert cell.get("held") == notebook.MEASURING_HELD  # it waits for the measure from the moment it is stored
        return cell

    monkeypatch.setattr(notebook, "run_code", errored)
    res = await call("add_card", kind="table", question="How many runs?", code="1/0")
    assert held(_cid(res)) is None and not _harness["drawn"]
