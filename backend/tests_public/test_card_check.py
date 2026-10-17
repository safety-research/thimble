"""The card check (app/card_check.py) as the analyst meets it: its switch in Settings, the filter states that follow the
mark a card shows, its red ✕ for numbers a card's code types in rather than computes, and what happens on a machine
without the card harness's headless Chromium.

The switch (features.auto `card_check`, thimble's config `agents.cardCheck.auto`): on, add_card's and edit_card's
results start the check of the card they name (card_check.after_tool); off, they start none.

The card filter's check states follow the mark a card shows (frontend lib/cardCheck.ts checkState): Failed is the red ✕
the card check puts on a real problem, so a card with that ✕ never reads as Verified, and a check that could not finish,
which shows nothing on the card, is Unverified.

The red ✕ for typed numbers (card_check.typed_numbers) compares them with the numbers the card shows (shown_numbers). A
chart shows the rows of its table, so the heights typed in to place event notes over its bars are no data, while bars
whose counts are typed in still are (live QA 3: a merges chart with three events called out got the ✕ for its notes'
heights 39, 36 and 33).

The card harness (app/render.py) on a machine without its headless Chromium says so plainly, warns once and does not
try again, and no card check begins, or stays on a card when it began before the harness knew.

A check changes how a card draws its data, never the data: a replacement whose code would break a citation into the
card, from main's answer or a takeaway, has its code refused and keeps the rest (live bug hunt C7: the check shortened
a bar chart's long run names, and main's citations of two bars failed)."""
from __future__ import annotations

import json
import logging
from types import SimpleNamespace

import altair as alt
import pandas as pd
import playwright.async_api
import pytest

from app import card_check, cardrun, config, context, filters, headless, notebook, refs, render, tools, userconf

CORPUS = "mini"


async def _after(cid: str) -> None:
    res = SimpleNamespace(is_error=False, text=f"card:{cid}")
    got = await card_check.after_tool(CORPUS, "add_card", {"question": "q"}, res)
    assert got is res, "the result goes back unchanged"


async def test_the_card_check_follows_its_switch(workspaces_tmp, mini_dir, monkeypatch):
    config.workspace_dir(CORPUS)
    monkeypatch.setenv("THIMBLE_CARD_CHECK", "on")
    started: list[str] = []
    monkeypatch.setattr(card_check, "start", lambda c, cid, author, **kw: started.append(cid))
    monkeypatch.setattr(card_check, "card_of", lambda name, args, text, anchor=None: text.removeprefix("card:"))
    await _after("c1")
    assert started == ["c1"] and card_check.auto(CORPUS)
    conf = userconf.global_file()
    conf.parent.mkdir(parents=True, exist_ok=True)
    conf.write_text(json.dumps({"agents": {"cardCheck": {"auto": False}}}))
    assert not card_check.auto(CORPUS)
    await _after("c2")
    assert started == ["c1"], "no card check with the switch off"


def _card(status: str, *, stages: dict | None = None, fixes: list | None = None, **over) -> dict:
    return {"id": "c1", "kind": "plot", "code": "plot()", "takeaway": "12 PRs.", "title": "Who merged most?",
            "check": {"id": "chk_1", "status": status, "stages": stages or {}}, "fixes": fixes or [], **over}


TYPED_STAGE = {"render": {"status": "ok", "typed": ["12", "35", "44"]}}


def test_a_card_with_the_red_x_is_failed_and_one_whose_check_could_not_finish_is_unverified():
    rejected = {"id": "fix_1", "check": "chk_1", "state": "rejected", "fields": ["code"], "reason": "its code did not run clean"}
    older = {**rejected, "check": "chk_0"}
    code_fix = {"id": "fix_2", "check": "chk_1", "state": "applied", "fields": ["code"], "before": {"code": "x"},
                "after": {"code": "plot()"}}
    states = {
        "passed": filters.check_state(_card("ok")),
        "revised": filters.check_state(_card("fixed", fixes=[code_fix])),
        "running": filters.check_state(_card("pending")),
        "stopped": filters.check_state(_card("stopped")),
        "could not finish": filters.check_state(_card("error")),
        "typed in": filters.check_state(_card("ok", stages=TYPED_STAGE)),
        "typed in, code since fixed": filters.check_state(_card("fixed", stages=TYPED_STAGE, fixes=[code_fix])),
        "revision would not run": filters.check_state(_card("error", fixes=[rejected])),
        "an older check's revision": filters.check_state(_card("error", fixes=[older])),
        "never checked": filters.check_state({"id": "c2", "kind": "plot"}),
        "label card": filters.check_state(_card("ok", stages=TYPED_STAGE, kind="label")),
    }
    assert states == {
        "passed": "verified", "revised": "verified", "running": "unverified", "stopped": "unverified",
        "could not finish": "unverified", "typed in": "failed", "typed in, code since fixed": "verified",
        "revision would not run": "failed", "an older check's revision": "unverified", "never checked": "unchecked",
        "label card": "unchecked",
    }


EVENTS = '''events = pd.DataFrame([
    ("2026-08-28 07:40", "Wave 2: every open PR has an owner", 39, "left", 4),
    ("2026-08-28 09:42", "Manager merges 11 approved PRs", 36, "left", 4),
    ("2026-08-28 12:49", "Freeze: 7 PRs for one bug", 33, "right", -4),
], columns=["t", "event", "y", "align", "dx"])
'''
COMPUTED = 'b = d.groupby("bin").size().rename("merged").reset_index()\n'
TYPED = 'b = pd.DataFrame({"bin": pd.date_range("2026-08-28 07:30", periods=4, freq="30min"), "merged": [21, 34, 27, 12]})\n'
LAYERS = '''bars = alt.Chart(b).mark_bar().encode(x="bin:T", y="merged:Q")
rules = alt.Chart(events).mark_rule().encode(x="t:T")
notes = alt.Chart(events).mark_text().encode(x="t:T", y="y:Q", text="event:N")
alt.layer(bars, rules, notes)
'''


def _typed(code: str) -> list[str]:
    """The numbers card_check calls typed in a plot card of `code` and the chart it draws: four half-hour bars and three
    event notes placed by height."""
    b = pd.DataFrame({"bin": pd.date_range("2026-08-28 07:30", periods=4, freq="30min"), "merged": [21, 34, 27, 12]})
    events = pd.DataFrame([("2026-08-28 07:40", "Wave 2: every open PR has an owner", 39, "left", 4),
                           ("2026-08-28 09:42", "Manager merges 11 approved PRs", 36, "left", 4),
                           ("2026-08-28 12:49", "Freeze: 7 PRs for one bug", 33, "right", -4)],
                          columns=["t", "event", "y", "align", "dx"])
    chart = alt.layer(alt.Chart(b).mark_bar().encode(x="bin:T", y="merged:Q"),
                      alt.Chart(events).mark_rule().encode(x="t:T"),
                      alt.Chart(events).mark_text().encode(x="t:T", y="y:Q", text="event:N"))
    cell = {"id": "c1", "kind": "plot", "code": code,
            "outputs": [{"application/vnd.vegalite.v6.json": chart.to_dict(), "text/plain": "<VegaLite 6 object>"}]}
    return card_check.typed_numbers(cell["code"], card_check.shown_numbers(cell))


def test_a_chart_whose_bar_counts_are_typed_in_still_gets_the_red_x_for_those_counts_alone():
    assert _typed(TYPED + EVENTS + LAYERS) == ["21", "34", "27", "12"]
    assert _typed(COMPUTED + EVENTS + LAYERS) == [], "the heights that place the event notes are not numbers it shows"


@pytest.fixture()
def no_browser(tmp_path, monkeypatch, workspaces_tmp):
    """Playwright's browsers folder empty, no system browser, the harness and the card check on, and nothing known yet
    of the browser."""
    empty = tmp_path / "browsers"
    empty.mkdir()
    page = tmp_path / "dist"
    page.mkdir()
    (page / render.RENDER_PAGE).write_text("<!doctype html>")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(empty))
    monkeypatch.setattr(userconf, "system_browser", lambda: "")
    monkeypatch.setenv("THIMBLE_RENDER_DIR", str(page))
    monkeypatch.setenv("THIMBLE_RENDER", "on")
    monkeypatch.setenv("THIMBLE_CARD_CHECK", "on")
    monkeypatch.setattr(headless, "_missing", {})
    monkeypatch.setattr(render, "_pool", None)


def _note_card() -> str:
    """A note card a model made, with its takeaway, which the check would read."""
    nb = notebook.create_notebook(config.workspace_dir(CORPUS), "Work")["id"]
    cell = notebook.new_cell("note", "model", payload={"text": "A note."})
    cell.update(takeaway="What the note shows.", takeaway_author="model")
    return notebook.insert_cell(CORPUS, nb, cell)["id"]


async def test_without_its_browser_the_harness_warns_once_and_no_card_check_is_left(no_browser, monkeypatch, caplog):
    launches = []
    real = playwright.async_api.async_playwright
    monkeypatch.setattr(playwright.async_api, "async_playwright", lambda: launches.append(1) or real())
    caplog.set_level(logging.WARNING)
    cid = _note_card()

    async def undrawable(c, cell, **kw):  # the harness as it answers before its first launch has failed
        raise render.Unavailable(headless.NOT_INSTALLED)

    monkeypatch.setattr(render, "render_card", undrawable)
    run = card_check.start(CORPUS, cid, card_check.MAIN)
    assert run is not None and run.task is not None
    await run.task
    assert "check" not in notebook.get_cell(CORPUS, cid)

    assert not await render.start() and not await render.start()
    assert len(launches) == 1 and render.down() and render.why() == headless.NOT_INSTALLED
    assert [r.name for r in caplog.records] == ["thimble.headless"], [r.getMessage() for r in caplog.records]
    assert card_check.start(CORPUS, cid, card_check.MAIN) is None
    assert "check" not in notebook.get_cell(CORPUS, cid)


# made-up run names, long enough for a chart to cut off, and the short names the check gave them
LONG = ["tracekit__underspecified-fan-out-attempt-07", "annotation__underspecified-fan-out-attempt-07", "plain-run"]
SHORT = ["tracekit__underspec", "annotation__underspec", "plain-run"]


def _bars(names: list[str]) -> dict:
    df = pd.DataFrame({"run": names, "tool calls": [99, 63, 7]})
    return {"application/vnd.vegalite.v6.json": alt.Chart(df).mark_bar().encode(y="run:N", x="tool calls:Q").to_dict(),
            "text/plain": "<VegaLite 6 object>"}


async def test_a_card_check_never_renames_the_rows_that_main_s_answer_cites(workspaces_tmp, tmp_path, monkeypatch):
    async def started(k, workspace, kernel=None) -> None:
        return None

    async def ran(k, code, kind, timeout_s, extra_exprs=None):  # `short()` draws the bars with the short names
        k.last_labels, k.last_label_revs = [], {}
        return [_bars(SHORT if code.strip().endswith("short()") else LONG)], 1, "ok"

    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", ran)
    monkeypatch.setattr(cardrun, "defers", lambda c: False)  # this process stands in for the card runner
    group = notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]
    res = await tools.call(CORPUS, "add_card", {"kind": "plot", "question": "Which runs have the most tool calls?",
                                                "code": "bars()", "takeaway": "Two runs stand out."},
                           actor="analyst", notebook=group, terminal=False)
    assert not res.is_error, res.text
    cid = res.text.split("card:", 1)[1].split()[0]
    cited = [f"card:{cid}#tool%20calls/{LONG[0]}", f"card:{cid}#tool%20calls/{LONG[1]}"]
    main = tmp_path / "transcripts" / "main.jsonl"  # main's answer, its citations as the terminal shows them
    main.parent.mkdir()
    main.write_text(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "text", "text": f"Most are in [99]({cited[0]}), then [63]({cited[1]})."}]}}) + "\n")
    monkeypatch.setattr(context, "transcript_path", lambda c: main)
    replacement = {"question": "Which runs made the most tool calls?", "code": "short()",
                   "takeaway": f"[[99|card:{cid}#tool%20calls/{SHORT[0]}]] calls."}

    async def draw(c, cell):
        return render.Rendered(png=b"\x89PNG card")

    async def read(c, cell, png, run, picture=None):
        assessment = [{"problem": ""}] * card_check.CRITERIA
        assessment[2] = {"problem": "Long run names are cut off."}
        return assessment, dict(replacement), "test-model"

    monkeypatch.setattr(render, "down", lambda: False)
    monkeypatch.setattr(card_check, "_draw", draw)
    monkeypatch.setattr(card_check, "_read", read)

    async def checked(again: bool = False) -> dict:
        run = card_check.start(CORPUS, cid, card_check.MAIN, again=again)
        assert run is not None
        await run.task
        cell = notebook.get_cell(CORPUS, cid)
        assert cell is not None and cell["code"] == "bars()", "the code that renames the cited rows is refused"
        for ref, value in zip(cited, ("99", "63")):
            meta = refs.resolve(config.corpus_dir(CORPUS), ref)["meta"]
            assert not meta.get("span_missing") and meta["span"]["value"] == value, (ref, meta)
        return cell

    takeaway = notebook.get_cell(CORPUS, cid)["takeaway"]
    cell = await checked()
    assert cell["title"] == replacement["question"], "the rest of the replacement is kept"
    assert cell["check"]["status"] == "fixed"
    assert [(f["state"], f["fields"]) for f in cell["fixes"]] == [("applied", ["title"])], "no red ✕ for the refused code"
    assert cell["takeaway"] == takeaway, "its takeaway, written for the short names, is not"
    replacement["question"] = cell["title"]  # a replacement that is its refused code alone leaves the card as it is
    cell = await checked(again=True)
    assert cell["check"]["status"] == "ok" and len(cell["fixes"]) == 1


async def test_main_learns_of_a_fix_of_its_card_in_one_line_at_its_next_turn_and_a_run_again_shows_the_new_takeaway(
        workspaces_tmp, monkeypatch):
    """A check's fix of a card main made reaches main as one line held for its next turn (a quiet event): the parts it
    changed and the problems it found, with no line in main's terminal. A run of the card again then says what the card
    asks and says now, so main does not compare the output with the takeaway it wrote before the fix (bug hunt D6)."""
    from terminal_fakes import write_launch

    from app import event_files, events

    async def started(k, workspace, kernel=None) -> None:
        return None

    async def ran(k, code, kind, timeout_s, extra_exprs=None):
        k.last_labels, k.last_label_revs = [], {}
        return [_bars(LONG)], 1, "ok"

    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", ran)
    monkeypatch.setattr(cardrun, "defers", lambda c: False)
    ws = config.workspace_dir(CORPUS)
    write_launch(ws)  # main runs, on local transport, where the check runs in main's shim and holds main's events
    monkeypatch.setattr(notebook, "_no_kernel_here", lambda c: None)  # this process stands in for the card runner
    group = notebook.create_notebook(ws, "Your work", role="analyst")["id"]
    res = await tools.call(CORPUS, "add_card", {"kind": "plot", "question": "Which runs made most calls, and why?",
                                                "code": "bars()", "takeaway": "One run made most of the calls."},
                           actor="analyst", notebook=group, terminal=False)
    assert not res.is_error, res.text
    cid = res.text.split("card:", 1)[1].split()[0]
    problem = "\"Most of the calls\" is wrong: the first run made 99 of 169."

    async def draw(c, cell):
        return render.Rendered(png=b"\x89PNG card")

    async def read(c, cell, png, run, picture=None):
        assessment = [{"problem": ""}] * card_check.CRITERIA
        assessment[0] = {"problem": "The question asks two things at once"}
        assessment[3] = {"problem": problem}
        return assessment, {"question": "Which runs made the most calls?", "code": "bars()",
                            "takeaway": "The first run made the most calls."}, "test-model"

    monkeypatch.setattr(render, "down", lambda: False)
    monkeypatch.setattr(card_check, "_draw", draw)
    monkeypatch.setattr(card_check, "_read", read)
    run = card_check.start(CORPUS, cid, card_check.MAIN)
    assert run is not None
    await run.task
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["check"]["status"] == "fixed" and cell["title"] == "Which runs made the most calls?"

    notes = event_files.held(ws)
    assert [n["meta"]["kind"] for n in notes] == ["card_fixed"]
    assert notes[0]["meta"]["card"] == f"card:{cid}"
    line = events.meanwhile(notes)
    assert f"changed the question and takeaway of card:{cid}" in line, line
    assert "The question asks two things at once." in line and problem in line, line
    assert event_files.said(notes) == "", "main's terminal prints no line for it"

    text, code = await cardrun.run_card(CORPUS, cid)
    assert code == 0
    assert "The card now asks \"Which runs made the most calls?\"" in text, text
    assert "takeaway now reads: The first run made the most calls." in text, text

    # a card another agent made (the orientation's) tells main nothing
    event_files.pop_held(ws)
    assert not card_check.tell_main(CORPUS, cid, "orient:o1", cell["fixes"][-1], [problem])
    assert event_files.held(ws) == []
