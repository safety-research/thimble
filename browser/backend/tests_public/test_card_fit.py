"""app.card_fit: a card whose body draws taller than the analyst's screen holds (card_size.BODY_MAX), or whose content
lays out wider than its card, is held before the analyst sees it, and the result of the call that made it carries a
critique from one model call that reads the question, the card and the card guidance, and no measure of the card; a
version that fits shows at once, and after two new versions that do not fit, the one that comes closest shows with its
cut-off, whole with the takeaway written on it. A new card that takes a held card's place goes on from its versions. A
card still held when the turn or run of the one who made it ends (main's turn, an agent of thimble's run, a thread's
fork), or when the server starts again, shows as it stands. The card check's replacement of a card gets the same
measure. The harness's drawing and the model are faked here; all data is made up."""
from __future__ import annotations

import re

import pytest

from app import card_check, card_fit, card_size, model, notebook, render, tools

CORPUS = "mini"
CRITIQUE = ("The question asks which runs failed, but the page lists all 56 runs and 42 of its rows say passed. "
            "Show the 14 failed runs.")


def png() -> bytes:
    """A made-up picture of a card: one white pixel."""
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (1, 1), "white").save(out, format="PNG")
    return out.getvalue()


def page(height: int, width: int = 0, inner: int = 0) -> str:
    """A made-up page the fake harness draws `height` px tall, `inner` px of it in a box that scrolls, and `width` px
    wide in a 692 px frame when given."""
    return f"<table><tr><td>run 1</td></tr></table><!-- h{height} w{width} i{inner} -->"


@pytest.fixture(autouse=True)
def _harness(workspaces_tmp, monkeypatch):
    """The harness draws each card at the size its page names; the critique is CRITIQUE. `calls` counts both."""
    card_size.forget(CORPUS)
    card_fit.forget(CORPUS)
    tools._last_cell.clear()
    calls = {"drawn": 0, "critiques": []}

    async def measure(c, cell):
        calls["drawn"] += 1
        # the card waits for its measure from the moment its content was stored: the canvas never saw it
        calls.setdefault("held_while_drawn", []).append((notebook.get_cell(c, cell["id"]) or {}).get("held"))
        m = re.search(r"<!-- h(\d+) w(\d+) i(\d+) -->", str((cell.get("payload") or {}).get("html") or ""))
        h, w, i = (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (300, 0, 0)
        return card_fit.Size(body=h, width=w, frame=692 if w else 0, inner=i), png()

    async def structured(prompt, **kw):
        calls["critiques"].append({"prompt": prompt, **kw})
        return model.CallResult(status="ok", output={"critique": CRITIQUE})

    monkeypatch.setattr(card_fit, "holds_here", lambda: True)
    monkeypatch.setattr(card_fit, "_measure", measure)
    monkeypatch.setattr(model, "structured", structured)
    return calls


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", terminal=True)


def _cid(res) -> str:
    assert not res.is_error, res.text
    return re.search(r"^card:([A-Za-z0-9_-]+)$", res.text, re.M).group(1)


def held(cid: str) -> dict | None:
    return (notebook.get_cell(CORPUS, cid) or {}).get("held")


async def test_a_card_taller_than_the_screen_is_held_with_a_critique_until_a_version_that_fits(_harness):
    res = await call("add_card", kind="custom", question="Which runs failed?", html=page(2400),
                     takeaway="14 of the 56 runs failed.")
    cid = _cid(res)
    assert f"The analyst does not see card:{cid} yet, since it shows more than the evidence for its answer:" in res.text
    # the way to the next version: edit_card keeps a custom card custom, and a card of another kind is a new card
    assert CRITIQUE in res.text and "Make the next version of this custom card with `edit_card`" in res.text
    assert "`add_card`" in res.text and f"delete card:{cid} with `delete_card`" in res.text
    # what Claude reads gives no measure of a version the analyst never saw
    assert not re.search(r"\d px|2,400|\b800\b", res.text.split("\n\n", 1)[1])
    assert held(cid) and held(cid)["body"] == 2400
    # the card check waits for the version that fits
    assert not card_check.wants_check(notebook.get_cell(CORPUS, cid))
    # the critique read the question, the card's page, its picture and the card guidance, at a low effort
    asked = _harness["critiques"][0]
    assert "Which runs failed?" in asked["prompt"] and "run 1" in asked["prompt"]
    assert "a custom card. The picture is the card as thimble draws it." in asked["prompt"]
    assert not re.search(r"2,400|\btall", asked["prompt"])  # its picture shows its height, and no measure goes to Claude
    assert "The content is the evidence for one answer" in asked["system"]
    assert asked["images"] and asked["effort"] == card_fit.CRITIQUE_EFFORT and asked["tool"].name == "critique"

    # a new takeaway leaves the content as measured: nothing is drawn again and no new critique is written, and the
    # result says again that the card waits, and how to make its next version
    drawn = _harness["drawn"]
    retake = await call("edit_card", card=cid, takeaway="14 of the 56 runs failed, every fourth night.")
    assert _harness["drawn"] == drawn and len(_harness["critiques"]) == 1 and held(cid)
    assert (f"The analyst does not see card:{cid} yet, since it shows more than the evidence for its answer. Make the "
            "next version of this custom card with `edit_card`.") in retake.text and CRITIQUE not in retake.text

    fits = await call("edit_card", card=cid, html=page(520))
    assert f"The analyst sees card:{cid} now." in fits.text
    assert held(cid) is None and card_check.wants_check(notebook.get_cell(CORPUS, cid))
    assert len(_harness["critiques"]) == 1
    steps = [r["action"] for r in card_fit_lines()]
    assert steps == ["held", "shown"] and card_fit_lines()[-1]["why"] == "fits"


def card_fit_lines() -> list[dict]:
    import json

    from app import config

    p = config.workspace_dir(CORPUS) / card_fit.LOG_FILE
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []


async def test_a_page_wider_than_its_card_is_held_with_its_width_and_the_card_s(_harness):
    res = await call("add_card", kind="custom", question="How did the outage unfold?", html=page(300, 1180))
    cid = _cid(res)
    asked = _harness["critiques"][0]["prompt"]
    assert "It is wider than its card. The picture" in asked and "1,180" not in asked and "692" not in asked
    assert held(cid) and (held(cid)["width"], held(cid)["frame"]) == (1180, 692)


async def test_a_page_that_fits_its_card_only_by_a_box_that_scrolls_is_held_and_says_so(_harness):
    res = await call("add_card", kind="custom", question="How did each stage go?", html=page(3060, inner=2440))
    cid = _cid(res)
    asked = _harness["critiques"][0]["prompt"]
    assert "Much of it is in a box of its own that scrolls. The picture" in asked
    assert "3,060" not in asked and "2,440" not in asked
    assert held(cid)


async def test_after_two_new_versions_that_do_not_fit_the_closest_shows_with_its_cut_off(_harness):
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400),
                          takeaway="Some of the 56 runs failed."))
    again = await call("edit_card", card=cid, html=page(1100), takeaway="14 of the 56 runs failed.")
    assert (f"The analyst still does not see card:{cid}, since it still shows more than the evidence for its "
            "answer:") in again.text
    assert "1,100" not in again.text and "1,100" not in _harness["critiques"][1]["prompt"] and CRITIQUE in again.text
    assert "Make the next version of this custom card with `edit_card`" in again.text and held(cid)
    # the last try draws taller than the one before it: the second version comes back, and shows with its cut-off
    last = await call("edit_card", card=cid, html=page(1700), takeaway="14 of the 56 runs failed, one a week.")
    assert f"The analyst sees card:{cid} now, as your second version." in last.text
    cell = notebook.get_cell(CORPUS, cid)
    assert held(cid) is None and cell["payload"]["html"] == page(1100)
    # its takeaway came back with it, still Claude's: a check may correct it, as it may any takeaway of Claude's
    assert cell["takeaway"] == "14 of the 56 runs failed." and cell["takeaway_author"] == tools.TAKEAWAY_AUTHOR
    assert len(_harness["critiques"]) == 2
    # the version shown is settled: a new takeaway does not hold it again
    retake = await call("edit_card", card=cid, takeaway="Some runs failed.")
    assert "evidence for its answer" not in retake.text and held(cid) is None


async def test_the_newest_version_shows_when_it_comes_closest(_harness):
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    await call("edit_card", card=cid, html=page(1700))
    last = await call("edit_card", card=cid, html=page(900))
    assert f"The analyst sees card:{cid} now, as this version." in last.text
    assert notebook.get_cell(CORPUS, cid)["payload"]["html"] == page(900)


async def test_the_first_version_comes_back_whole_when_it_comes_closest(_harness):
    """Each new version is two edits, its page and its takeaway: the first version comes back as add_card made it."""
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(1100),
                          takeaway="14 of the 56 runs failed."))
    await call("edit_card", card=cid, html=page(2400), takeaway="14 of the 56 runs failed, one a week.")
    last = await call("edit_card", card=cid, html=page(1700), takeaway="14 runs failed.")
    assert f"The analyst sees card:{cid} now, as your first version." in last.text
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["payload"]["html"] == page(1100) and cell["takeaway"] == "14 of the 56 runs failed."
    assert cell["takeaway_author"] == tools.TAKEAWAY_AUTHOR


async def test_a_held_card_of_code_s_next_version_can_be_any_kind_through_edit_card(_harness, monkeypatch):
    """edit_card turns a card of code into any kind, one that runs code or an example, a note or a custom card (N40), so
    a held card of code's result asks for its next version through edit_card, and no new card is needed."""
    async def ran(*a, **k):
        made = notebook.new_cell("table", k["created_by"], k["title"], k["notebook"], code="runs")
        return notebook.insert_cell(CORPUS, k["notebook"], {**made, "status": "ok"})

    async def tall(c, cell):
        return card_fit.Size(body=4068), png()

    monkeypatch.setattr(notebook, "run_code", ran)
    monkeypatch.setattr(card_fit, "_measure", tall)
    res = await call("add_card", kind="table", question="What did each stage of each run do?", code="runs")
    cid = _cid(res)
    assert held(cid) and "Make the next version with `edit_card`, in whatever kind fits it." in res.text
    assert "delete_card" not in res.text  # the call itself is echoed as `$ add_card ...`
    made = await call("edit_card", card=cid, kind="custom", html="<p>4 failed</p>")
    assert not made.is_error, made.text


async def test_a_card_that_fits_shows_once_measured_and_its_result_says_nothing_more(_harness):
    res = await call("add_card", kind="custom", question="Which runs failed?", html=page(480),
                     takeaway="14 of the 56 runs failed.")
    cid = _cid(res)
    # held while the harness drew it, shown once it fit
    assert _harness["held_while_drawn"] == [notebook.MEASURING_HELD]
    assert held(cid) is None and f"sees card:{cid}" not in res.text
    assert "evidence for its answer" not in res.text and not _harness["critiques"]
    drawn = _harness["drawn"]
    await call("edit_card", card=cid, takeaway="14 runs failed.")
    assert _harness["drawn"] == drawn  # the same version: not drawn again


async def test_a_card_still_held_when_main_s_turn_ends_shows_as_it_stands(_harness):
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


async def test_the_critique_of_a_thread_s_card_reads_the_analyst_s_question_in_that_thread(_harness, monkeypatch,
                                                                                          tmp_path):
    """A thread's fork works as main (its card's author is main), and the request it answers is the analyst's question
    in its thread, which main's conversation does not hold: the critique reads that thread whole, however long main's
    conversation is, as the card check does."""
    import json

    from conftest import Listener

    from app import agents, config, context, session
    from app import subagent_files as sf

    path = tmp_path / "main.jsonl"  # main's conversation, far longer than the critique reads
    path.write_text("\n".join(json.dumps({"type": "user", "message": {"role": "user", "content": f"Question {i}. " +
                                                                      "x" * 600}}) for i in range(40)))
    monkeypatch.setattr(context, "transcript_path", lambda c: path)
    anchor = _cid(await call("add_card", kind="custom", question="How many runs failed?", html=page(300)))
    tid = agents.new_thread(CORPUS, f"card:{anchor}", "How many runs failed?")["id"]
    asked = "Show me every stage of every run behind this card, with its start time, status and error."
    agents.append(agents.paths(CORPUS, tid)[1], {"type": "user", "text": asked})
    main = Listener(CORPUS)
    try:
        session._live[CORPUS].subs.append(session.Sub(CORPUS, tid, "toolu_forked", "fork1", thread=True))
        sf.add_caller(config.workspace_dir(CORPUS), "toolu_fork0001", "fork1", sf.FORK_TYPE)
        res = await tools.call(CORPUS, "add_card", {"kind": "custom", "question": "What did each stage of each run do?",
                                                    "html": page(2400)}, tool_use_id="toolu_fork0001")
        cid = _cid(res)
        assert held(cid)["agent"] == "fork1" and notebook.get_cell(CORPUS, cid)["created_by"] == f"chat:{tid}"
        prompt = _harness["critiques"][-1]["prompt"]
        assert f"### thread:{tid}" in prompt and asked in prompt
        assert "Question 0." not in prompt  # main's oldest turns are what the budget leaves out
    finally:
        main.close()


async def test_main_s_turn_end_leaves_a_card_the_orientation_s_call_is_measuring(_harness, monkeypatch):
    """A card waits for its measure with who made it on its record, so main's turn end in that moment leaves it, and
    the measure holds it."""
    seen: dict = {}

    async def measure(c, cell):
        seen["held"] = (notebook.get_cell(c, cell["id"]) or {}).get("held")
        seen["shown"] = card_fit.turn_ended(c)  # main's turn ends while the card is drawn
        return card_fit.Size(body=2400), png()

    monkeypatch.setattr(card_fit, "_measure", measure)
    cid = _cid(await as_session(tools.ORIENT_SESSION, kind="custom", question="How long did each stage take?",
                                html=page(2400)))
    assert seen == {"held": {**notebook.MEASURING_HELD, "author": tools.ORIENT_SESSION}, "shown": []}
    assert held(cid)["author"] == tools.ORIENT_SESSION and held(cid)["body"] == 2400


async def test_a_card_left_held_by_the_server_before_shows_at_the_next_start(_harness, workspaces_tmp):
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    assert held(cid)
    marked = notebook.mark_interrupted_cells(workspaces_tmp)
    assert any(m.endswith(f"/{cid} (held)") for m in marked)
    notebook.clear_cache()
    assert held(cid) is None


async def test_a_critique_that_fails_still_holds_the_card_and_says_why(_harness, monkeypatch):
    async def refused(prompt, **kw):
        return model.CallResult(status="error", detail="the made-up API was down")

    monkeypatch.setattr(model, "structured", refused)
    res = await call("add_card", kind="custom", question="Which runs failed?", html=page(2400))
    cid = _cid(res)
    assert "The critique of the card could not be written (the made-up API was down)." in res.text
    assert held(cid)


async def test_nothing_is_held_where_no_card_can_be_drawn(_harness, monkeypatch):
    async def undrawn(c, cell):
        return None

    monkeypatch.setattr(card_fit, "_measure", undrawn)
    res = await call("add_card", kind="custom", question="Which runs failed?", html=page(2400))
    assert held(_cid(res)) is None and "evidence for its answer" not in res.text
    # and where no card can be drawn at all, no card waits even for its measure
    monkeypatch.setattr(card_fit, "holds_here", lambda: False)
    res = await call("add_card", kind="custom", question="Which runs failed?", html=page(2400))
    assert held(_cid(res)) is None and "evidence for its answer" not in res.text


async def test_a_card_of_code_whose_run_failed_shows_with_its_error_and_is_not_measured(_harness, monkeypatch):
    async def errored(*a, **k):
        """A run whose code raised: the card stored with its error."""
        made = notebook.new_cell("table", k["created_by"], k["title"], k["notebook"], code="1/0")
        cell = notebook.insert_cell(CORPUS, k["notebook"], {**made, "status": "error"})
        assert cell.get("held") == notebook.MEASURING_HELD  # it waits for the measure from the moment it is stored
        return cell

    monkeypatch.setattr(notebook, "run_code", errored)
    res = await call("add_card", kind="table", question="How many runs?", code="1/0")
    assert held(_cid(res)) is None and not _harness["critiques"]


async def test_the_page_s_measure_says_nothing_more_of_a_version_the_result_told(_harness):
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    assert not card_size.tell(CORPUS, notebook.get_cell(CORPUS, cid), 2400)


async def test_the_cut_brings_back_the_version_that_comes_closest_with_the_takeaway_written_on_it(_harness, monkeypatch):
    """A takeaway its author wrote on a version while it waited, in a call of its own, is part of that version: the cut
    brings it back with the version, from the edit that replaced its content."""
    monkeypatch.setattr(notebook, "TAKEAWAY_FOLD_S", -1)  # each takeaway is an edit of its own
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(1100)))
    await call("edit_card", card=cid, takeaway="14 of the 56 runs failed.")
    assert held(cid) and [e["fields"] for e in notebook.get_cell(CORPUS, cid)["edited"]] == [["takeaway"]]
    await call("edit_card", card=cid, html=page(2400))
    last = await call("edit_card", card=cid, html=page(1700), takeaway="Some runs failed.")
    assert f"The analyst sees card:{cid} now, as your first version." in last.text
    cell = notebook.get_cell(CORPUS, cid)
    assert held(cid) is None and cell["payload"]["html"] == page(1100)
    assert cell["takeaway"] == "14 of the 56 runs failed." and cell["takeaway_author"] == tools.TAKEAWAY_AUTHOR


async def test_a_new_card_that_takes_a_held_card_s_place_goes_on_from_its_versions(_harness):
    """The result says to make a card of another kind as a new card, then delete the held one. The new card goes on from
    the held card's versions, so the two get no more new versions together than one card gets."""
    old = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    await call("edit_card", card=old, html=page(2000))  # its second version, held again
    new = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(1900)))
    assert held(new) and held(new).get("before") is None
    await call("delete_card", card=old)
    assert held(new)["before"] == 2
    last = await call("edit_card", card=new, html=page(1500))
    assert f"The analyst sees card:{new} now, as this version." in last.text and held(new) is None
    assert card_fit_lines()[-1]["tries"] == 3


async def test_a_held_card_deleted_before_the_card_that_takes_its_place_counts_for_that_card(_harness):
    old = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    await call("delete_card", card=old)
    new = await call("add_card", kind="custom", question="Which runs failed?", html=page(1900))
    cid = _cid(new)
    assert f"The analyst still does not see card:{cid}," in new.text and held(cid)["before"] == 1
    last = await call("edit_card", card=cid, html=page(1500))
    assert f"The analyst sees card:{cid} now, as this version." in last.text and held(cid) is None


async def test_a_held_card_deleted_while_the_card_that_takes_its_place_is_measured_counts_for_that_card(_harness,
                                                                                                      monkeypatch):
    """add_card and delete_card in one turn of Claude's run at once: the held card is deleted while the new card is
    measured, and the new card still goes on from its versions."""
    old = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    measure = card_fit._measure

    async def deleted_meanwhile(c, cell):
        if cell["id"] != old and held(old):
            assert not (await call("delete_card", card=old)).is_error
        return await measure(c, cell)

    monkeypatch.setattr(card_fit, "_measure", deleted_meanwhile)
    new = await call("add_card", kind="custom", question="Which runs failed?", html=page(1900))
    cid = _cid(new)
    assert f"The analyst still does not see card:{cid}," in new.text and held(cid)["before"] == 1
    last = await call("edit_card", card=cid, html=page(1500))
    assert f"The analyst sees card:{cid} now, as this version." in last.text and held(cid) is None


async def test_a_held_card_deleted_at_once_with_an_edit_of_the_card_that_takes_its_place_counts_for_that_card(
        _harness, monkeypatch):
    """edit_card of the new card and delete_card of the held one sent in one step run at once: the delete lands while
    the new version is measured, and that version still goes on from the held card's versions."""
    import asyncio

    old = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    new = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(1900)))
    assert held(new) and held(new).get("before") is None
    measure, drawing, deleted = card_fit._measure, asyncio.Event(), asyncio.Event()

    async def slow(c, cell):  # the harness draws the new version until the delete has landed
        if cell["id"] == new:
            drawing.set()
            await deleted.wait()
        return await measure(c, cell)

    async def delete():
        await drawing.wait()
        res = await call("delete_card", card=old)
        deleted.set()
        return res

    monkeypatch.setattr(card_fit, "_measure", slow)
    edit, gone = await asyncio.gather(call("edit_card", card=new, html=page(1500)), delete())
    assert not gone.is_error
    # the held card's version and the new card's two: the second new version that does not fit shows with its cut-off
    assert f"The analyst sees card:{new} now, as this version." in edit.text and held(new) is None
    assert card_fit_lines()[-1]["tries"] == 2


async def test_a_card_that_took_a_held_card_s_place_and_fit_leaves_nothing_for_a_later_card(_harness):
    old = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(2400)))
    assert held(_cid(await call("add_card", kind="custom", question="Which runs failed?", html=page(520)))) is None
    await call("delete_card", card=old)
    later = await call("add_card", kind="custom", question="How long did each stage take?", html=page(2400))
    assert f"The analyst does not see card:{_cid(later)} yet," in later.text
    # and when the author's turn ends, a held card it deleted leaves nothing for its next turn either
    gone = _cid(await call("add_card", kind="custom", question="Which stage failed?", html=page(2400)))
    await call("delete_card", card=gone)
    card_fit.turn_ended(CORPUS)
    nxt = await call("add_card", kind="custom", question="Which stage failed most?", html=page(2400))
    assert f"The analyst does not see card:{_cid(nxt)} yet," in nxt.text


def test_the_way_to_the_next_version_names_the_card_s_kind_whatever_its_first_letter():
    assert "Make the next version of this example card with `edit_card`." in card_fit._revise({"kind": "example"}, "c1")


@pytest.fixture()
async def checked(monkeypatch):
    """The card check with its drawing and its reading stood in for: a card of code draws as tall as the number its code
    prints, and the reading finds its question vague and gives back `revision` (its code, and its takeaway when given);
    a reading after a replacement that did not fit gives back `revision["again"]` when the test sets it. Each reading
    notes the critique it read (`revision["read"]`, '' for none). The kernel prints the value of the code's last line."""
    from app import render

    revision: dict = {}

    async def started(k, workspace, kernel=None) -> None:
        return None

    async def run(k, code, kind, timeout_s, extra_exprs=None):
        k.last_labels, k.last_label_revs = [], {}
        return [{"text/plain": str(eval(code.strip().splitlines()[-1], {"__builtins__": {}}))}], 1, "ok"

    async def draw(c, cell):
        last = str(cell.get("code") or "300").strip().splitlines()[-1]
        return render.Rendered(png=png(), body=float(eval(last, {"__builtins__": {}})))

    async def read(c, cell, picture, run, path=None, *, too_large=""):
        revision.setdefault("read", []).append(too_large)
        assessment = [{"problem": "The question names no runs."}] + [{"problem": ""}] * (card_check.CRITERIA - 1)
        gives = {**revision, **revision.get("again", {})} if too_large else revision
        return assessment, {"question": cell["title"], "code": gives.get("code", cell.get("code") or ""),
                            "takeaway": gives.get("takeaway", cell["takeaway"])}, "test-model"

    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", run)
    monkeypatch.setattr(render, "down", lambda: False)
    monkeypatch.setattr(card_check, "_draw", draw)
    monkeypatch.setattr(card_check, "_read", read)
    yield revision
    await notebook.shutdown_all()


async def _check(cid: str, again: bool = False) -> dict:
    run = card_check.start(CORPUS, cid, card_check.MAIN, again=again)
    assert run is not None
    await run.task
    return notebook.get_cell(CORPUS, cid)


async def test_the_card_check_s_replacement_gets_the_measure_any_version_gets(_harness, checked):
    """A replacement taller than the analyst's screen does not take the place of a card that fits. As a version of its
    author's would, it gets a critique, and the check reads the card once more with it; when that replacement does not
    fit either, the card stays as its author made it, and the check ends as for a card it left, with no mark. One that
    fits is applied."""
    cid = _cid(await call("add_card", kind="table", question="How did each night's run go?", code="661",
                          takeaway="26 of the 30 runs finished."))
    checked["code"] = "4068"  # every stage of every run, one row each, and again after the critique
    cell = await _check(cid)
    assert cell["code"] == "661" and cell["check"]["status"] == "ok", cell["check"]
    assert [(f["state"], f["reason"]) for f in cell["fixes"]] == [("rejected", card_check.TOO_LARGE)] * 2
    assert checked["read"] == ["", CRITIQUE]
    checked.update(code="700", read=[])
    cell = await _check(cid, again=True)
    assert cell["code"] == "700" and cell["check"]["status"] == "fixed" and checked["read"] == [""]


async def test_a_check_s_replacement_that_does_not_fit_gets_a_critique_and_one_more_version(_harness, checked):
    """The critique reads the replacement as the check made it, its code and its own output, and the reading after it
    gives the replacement that fits, which takes the card's place."""
    cid = _cid(await call("add_card", kind="table", question="How did each night's run go?", code="661",
                          takeaway="26 of the 30 runs finished."))
    checked.update(code="4000 + 68", again={"code": "700"})
    cell = await _check(cid)
    assert cell["code"] == "700" and cell["check"]["status"] == "fixed", cell["check"]
    assert [(f["state"], f.get("reason")) for f in cell["fixes"]][0] == ("rejected", card_check.TOO_LARGE)
    assert [f["state"] for f in cell["fixes"]] == ["rejected", "applied"]
    assert checked["read"] == ["", CRITIQUE]
    asked = _harness["critiques"][-1]["prompt"]
    assert "4000 + 68" in asked and "4068" in asked.split("Its output", 1)[1].split("The work that led", 1)[0]
    assert "a table card. The picture is the card as thimble draws it." in asked
    line = card_fit_lines()[-1]
    assert (line["action"], line["by"], line["card"], line["body"]) == ("critique", "check", cid, 4068)


async def test_a_replacement_of_a_card_shown_past_the_screen_is_kept_when_it_comes_no_farther(_harness, checked):
    """A card the canvas shows past the screen, as one shown as it stood when its author's turn ended: a replacement
    that changes its takeaway alone draws as tall, and is applied; one that draws taller is not."""
    cid = _cid(await call("add_card", kind="table", question="How did each night's run go?", code="2400",
                          takeaway="Most runs finished."))
    checked.update(code="2400", takeaway="26 of the 30 runs finished.")
    cell = await _check(cid)
    assert cell["takeaway"] == "26 of the 30 runs finished." and cell["check"]["status"] == "fixed"
    checked.update(code="4068", takeaway="26 of the 30 runs finished all five stages.")
    cell = await _check(cid, again=True)
    assert cell["code"] == "2400" and cell["check"]["status"] == "ok"
