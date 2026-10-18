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

from app import card_check, cardrun, config, context, filters, headless, notebook, records, refs, render, tools, userconf

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


async def test_main_learns_of_problems_the_check_found_but_could_not_fix_and_the_check_reads_thimble_chart_s_help(
        workspaces_tmp, monkeypatch):
    """Bug hunt L8: the check found that a chart main had called side by side stacked its groups, but its replacement
    called thimble.chart with an option it does not take (`stacked=False`), did not run, and the check ended with the
    card as it was and nothing said. Main now gets one line held for its next turn, as for a fix: the problems the
    check found, why its replacement was not kept, and that the card is as main made it. And the check reads
    thimble.chart's help with the code of a card that calls it, so its replacement can call it as it is written."""
    from terminal_fakes import write_launch

    from app import event_files, events

    async def started(k, workspace, kernel=None) -> None:
        return None

    async def ran(k, code, kind, timeout_s, extra_exprs=None):  # main's card; the check's revision runs in thimble-run
        k.last_labels, k.last_label_revs = [], {}
        return [_bars(LONG)], 1, "ok"

    monkeypatch.setattr(notebook, "_ensure_started", started)
    monkeypatch.setattr(notebook, "_run_card_code", ran)
    monkeypatch.setattr(cardrun, "defers", lambda c: False)
    ws = config.workspace_dir(CORPUS)
    write_launch(ws)
    monkeypatch.setattr(notebook, "_no_kernel_here", lambda c: None)
    group = notebook.create_notebook(ws, "Your work", role="analyst")["id"]
    code = ("import pandas as pd\nimport thimble\n"
            "df = pd.DataFrame({'round': ['r1', 'r1'], 'calls': [3, 4], 'crew': ['heron crew', 'lark crew']})\n"
            "thimble.chart('bar', df)")
    res = await tools.call(CORPUS, "add_card", {"kind": "plot", "question": "How many calls did each crew make in each round?",
                                                "code": code, "takeaway": "The crews' bars stand side by side."},
                           actor="analyst", notebook=group, terminal=False)
    assert not res.is_error, res.text
    cid = res.text.split("card:", 1)[1].split()[0]
    problem = "The analyst asked for the crews side by side, but the chart stacks them."
    seen: list[dict] = []

    async def draw(c, cell):
        return render.Rendered(png=b"\x89PNG card")

    async def read(c, cell, png, run, picture=None):
        seen.append(await card_check.card_input(c, cell, run, None, card_check._sections()))
        assessment = [{"problem": ""}] * card_check.CRITERIA
        assessment[1] = {"problem": problem}
        return assessment, {"question": cell["title"], "code": code.replace("df)", "df, stacked=False)"),
                            "takeaway": cell["takeaway"]}, "test-model"

    monkeypatch.setattr(render, "down", lambda: False)
    monkeypatch.setattr(card_check, "_draw", draw)
    monkeypatch.setattr(card_check, "_read", read)
    run = card_check.start(CORPUS, cid, card_check.MAIN)
    assert run is not None
    await run.task
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["check"]["status"] == "error" and cell["code"] == code, "the card stays as main made it"
    assert [f["state"] for f in cell["fixes"]] == ["rejected"]

    notes = event_files.held(ws)
    assert [n["meta"]["kind"] for n in notes] == ["card_fixed"] and notes[0]["meta"]["card"] == f"card:{cid}"
    line = events.meanwhile(notes)
    assert f"found problems in card:{cid} that it could not fix" in line, line
    assert "its code did not run clean: TypeError" in line and "not 'stacked'" in line, line
    assert problem in line and "The card is as you made it." in line and "`edit_card`" in line, line
    assert event_files.said(notes) == "", "main's terminal prints no line for it"
    # a card another agent made tells main nothing
    event_files.pop_held(ws)
    assert not card_check.tell_unfixed(CORPUS, cid, "orient:o1", [problem], "it could not be applied")

    # the reading got thimble.chart's help, with the option that sets bars side by side, under the card's code
    chart = seen[0]["card"]["chart"]
    assert "thimble.chart" in chart and "False sets bars side by side" in chart and "sort, stack, label" in chart, chart
    user = card_check._fill(card_check._sections()["card"], {**{k: "" for k in (
        "card", "kind", "question", "takeaway", "citations", "context", "typed", "kept")}, "code": code, "chart": chart})
    assert user.index(code) < user.index("False sets bars side by side")
    assert card_check._chart_text("alt.Chart(df).mark_bar()", card_check._sections()) == "", "no help for other code"


async def test_a_quote_of_a_wiki_save_s_edit_summary_is_kept_shown_and_read_by_the_card_check(tmp_path):
    """Bug hunt J6: a wiki save's record shows its page's text and left its edit summary out, so add_card refused a true
    quote of that summary, the card drew the save without it, and the card check, reading only the text, called the
    quote "not found in the admin's record". The summary is now a field of the record: the quote is kept beside the
    record, the record resolves with it (an example card shows it), and the check of a value and the card check read
    it."""
    root = tmp_path / "garden-wiki"
    root.mkdir()
    saves = [{"rev_id": "Tomatoes@3", "name": "Tomatoes", "label": "SeedBot", "time": "2026-05-02T09:14:00Z",
              "body": "= Tomatoes =\nBuy cheap seeds at the Example Seed Shop!", "change_summary": "*"},
             {"rev_id": "Tomatoes@4", "name": "Tomatoes", "label": "Rowan", "time": "2026-05-02T09:20:00Z",
              "body": "= Tomatoes =\nPlant them out after the last frost.", "change_summary": "undo the seed shop advert"}]
    (root / "revisions.jsonl").write_text("".join(json.dumps(s) + "\n" for s in saves))
    c = config.register_corpus(root, exact=True)["name"]
    group = notebook.create_notebook(config.workspace_dir(c), "Your work", role="analyst")["id"]
    res = await tools.call(c, "add_card", {
        "kind": "example", "question": "What did Rowan's save on the Tomatoes page undo?",
        "refs": [{"ref": "revisions.jsonl#L1", "quote": "Example Seed Shop"},
                 {"ref": "revisions.jsonl#L2", "quote": "undo the seed shop advert"}],
        "takeaway": "Rowan's save [[undid the seed shop advert|revisions.jsonl#L2]] that SeedBot had added."},
        actor="analyst", notebook=group, terminal=False)
    assert not res.is_error, res.text
    cid = res.text.split("card:", 1)[1].split()[0]
    cell = notebook.get_cell(c, cid)
    assert cell["payload"]["refs"][1] == "revisions.jsonl#L2", "the record itself, its summary holds the quote"
    assert cell["payload"]["quotes"] == ["", "undo the seed shop advert"], "the quote kept beside it, for the card"

    got = refs.resolve(config.corpus_dir(c), "revisions.jsonl#L2")
    assert got["fields"] == [{"key": "change_summary", "text": "undo the seed shop advert"}]
    assert "fields" not in refs.resolve(config.corpus_dir(c), "revisions.jsonl#L1"), "a summary of no words is no field"
    from app import verify  # noqa: PLC0415

    assert await verify._ref_check(config.corpus_dir(c), "revisions.jsonl#L2", "undo the seed shop advert") is None, \
        "a citation of the summary's words finds them at its place"

    lines = card_check._citations_text(c, cell).splitlines()
    line = next(x for x in lines if x.startswith("- revisions.jsonl#L2:"))
    assert line.startswith("- revisions.jsonl#L2: change_summary: undo the seed shop advert"), line


async def test_an_example_of_a_json_store_s_message_shows_and_checks_the_words_it_quotes_from_a_tool_call(tmp_path):
    """Bug hunt round 10, K3: a message of a JSON store of messages by id resolved as its JSON, so an example card showed
    its id, its role and its content cut after one line, never the vote it quoted from a tool call's command or a tool's
    output, and the card check, reading the start of the record, said the card never showed a vote. The message resolves
    as the Transcript mode reads it (its tool call, its tool's output), so the card draws the words it quotes; a check
    reads the whole message, past its excerpt's cut; a label still reads the record's JSON."""
    root = tmp_path / "picnic-agents"
    (root / "rowan").mkdir(parents=True)
    note = "\n".join(f"line {i}: the tables, the blankets and the lemonade are packed." for i in range(80))
    command = "cat >> PLAN.md <<'EOF'\n## Saturday\n\n`CHOICE: north gate` — Rowan\nEOF"
    store = {"agent": "rowan", "messages": {
        "m1": {"id": "m1", "role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_a1", "name": "Bash", "input": {"command": command, "description": "Add my choice"}}],
            "first_seen_ts": 1782799367.5},
        "m2": {"id": "m2", "role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_a1", "content": f"{note}\n+`CHOICE: north gate` — Maya\n"}],
            "first_seen_ts": 1782799370.5}},
        "conversations": {"c1": {"id": "c1", "messages": ["m1", "m2"]}}}
    (root / "rowan" / "chat.json").write_text(json.dumps(store, indent=2, ensure_ascii=False))
    c = config.register_corpus(root, exact=True)["name"]
    corpus = config.corpus_dir(c)
    group = notebook.create_notebook(config.workspace_dir(c), "Your work", role="analyst")["id"]
    deep = "`CHOICE: north gate` — Maya"
    res = await tools.call(c, "add_card", {
        "kind": "example", "question": "How did Rowan and Maya cast their choices?",
        "refs": [{"ref": "rowan/chat.json#/messages/m1", "quote": "`CHOICE: north gate` — Rowan"},
                 {"ref": "rowan/chat.json#/messages/m2", "quote": deep}],
        "takeaway": f'Rowan cast his in a Bash call, and Maya\'s [["{deep}" shows in its output|rowan/chat.json#/messages/m2]].'},
        actor="analyst", notebook=group, terminal=False)
    assert not res.is_error, res.text
    cid = res.text.split("card:", 1)[1].split()[0]
    cell = notebook.get_cell(c, cid)
    assert cell["payload"]["quotes"] == ["`CHOICE: north gate` — Rowan", deep], "each quote kept beside its message"

    call = refs.resolve(corpus, "rowan/chat.json#/messages/m1")
    assert [b["kind"] for b in call["blocks"]] == ["tool_use"] and "`CHOICE: north gate` — Rowan" in call["blocks"][0]["text"]
    assert call["blocks"][0]["text"].startswith("Bash\n"), "the tool call under its tool's name, as the Transcript mode reads it"
    output = refs.resolve(corpus, "rowan/chat.json#/messages/m2")
    assert [b["kind"] for b in output["blocks"]] == ["tool_result"] and deep in output["blocks"][0]["text"]
    assert deep not in output["excerpt"], "the quote sits past the excerpt's cut"
    assert '"role": "user"' in records.read(corpus / "rowan" / "chat.json", "rowan/chat.json", "/messages/m2")["text"], \
        "a label still reads the message's JSON"
    value = refs.resolve(corpus, "rowan/chat.json#/messages/m1/content/0/input/command")
    assert value["blocks"] == [{"kind": "text", "text": command}], "a string inside the message reads as its words, not as JSON"
    from app import verify  # noqa: PLC0415

    assert await verify._ref_check(corpus, "rowan/chat.json#/messages/m2", f'"{deep}"') is None, \
        "a citation of words deep in the tool's output finds them at its place"
    assert await verify._ref_check(corpus, "rowan/chat.json#/messages/m1/content/0/input/command",
                                   '"`CHOICE: north gate` — Rowan"') is None
    lines = card_check._citations_text(c, cell).splitlines()
    line = next(x for x in lines if x.startswith("- rowan/chat.json#/messages/m2:"))
    assert deep in line and len(line) < 600, line
