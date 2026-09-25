"""The card check's replacement (app/card_check.py, app/checkstore.py): a part of the replacement card is applied only
when it changes the card as stored. A takeaway is compared after its values are linked to the card's outputs, so a
reading that gives back the card's own words with its links dropped or written apart changes nothing and records no
fix. An author's next edit_card that gives back what a fix replaced leaves the fix standing and says so, and one that
changes what the fix replaced is applied to the fix's version, so it does not put back what the fix took out. The numbers a
card's code types in that the card shows, rather than computing them from the data, are flagged on the check's record.
The cards and their tables are invented."""
import re

import pytest

from app import card_check, config, notebook, tools

CORPUS = "mini"

TABLE = ("<table><thead><tr><th></th><th>saves</th></tr></thead><tbody>"
         "<tr><th>week 1</th><td>13,339</td></tr><tr><th>week 2</th><td>2,104</td></tr></tbody></table>")


def _card(takeaway: str) -> dict:
    return {"id": "c1", "kind": "table", "title": "How many pages were saved each week?", "code": "df",
            "status": "ok", "exec_count": 1, "outputs": [{"text/html": TABLE, "text/plain": "..."}],
            "takeaway": takeaway, "takeaway_author": "model", "created_by": "terminal"}


def _reading(cell: dict, **parts: str) -> dict:
    return {"question": cell["title"], "code": cell["code"], "takeaway": cell["takeaway"], **parts}


def test_a_takeaway_that_stores_as_the_card_s_own_is_no_fix():
    cell = _card("Most saves fell in week 1, [[13,339|card:c1#saves/week%201]] of them.")
    same_words = _reading(cell, takeaway="Most saves fell in week 1, 13,339 of them.")
    assert card_check._patch(cell, same_words, cell) == {}, "the resolver links 13,339 where the card holds it"
    new_words = _reading(cell, takeaway="Week 1 held most saves, 13,339 of them.")
    assert set(card_check._patch(cell, new_words, cell)) == {"takeaway"}
    # a new question with the same takeaway changes the question alone
    asked = _reading(cell, question="Which week held most saves?", takeaway="Most saves fell in week 1, 13,339 of them.")
    assert card_check._patch(cell, asked, cell) == {"title": "Which week held most saves?"}


@pytest.fixture()
async def group(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    yield notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]
    await notebook.shutdown_all()


async def _call(name: str, nb: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", notebook=nb, terminal=False)


def _fixed(cid: str, **after: str) -> None:
    """The card as a check's fix leaves it: the new parts in place and an applied fix recording what they replaced."""
    hit = notebook.find_cell(config.workspace_dir(CORPUS), cid)
    assert hit is not None
    nb = notebook.read_notebook(config.workspace_dir(CORPUS), hit[0])
    cell = next(c for c in nb["cells"] if c["id"] == cid)
    before = {f: cell.get(f) for f in after}
    cell.update(after)
    cell.setdefault("fixes", []).append({"id": "fix1", "check": "chk1", "by": "check", "fields": list(after),
                                         "before": before, "after": dict(after), "state": "applied"})
    notebook.write_notebook(config.workspace_dir(CORPUS), nb)


async def test_an_author_s_next_edits_that_give_back_what_a_fix_replaced_leave_the_fix(group):
    r = await _call("add_card", group, kind="code", question="How many saves and why?", code="print(1204)",
                    takeaway="There were 1,204 saves, mostly in week 1.")
    cid = next(m.group(1) for ln in r.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", ln.strip())))
    _fixed(cid, title="How many saves were there?", takeaway="There were 1,204 saves.")
    # the author, unaware of the fix, gives back the question and the takeaway it last wrote
    r = await _call("edit_card", group, card=cid, question="How many saves and why?",
                    takeaway="There were 1,204 saves, mostly in week 1.")
    assert not r.is_error, r.text
    assert tools.hint("edit_card-check-kept", cid=cid, field="question") in r.text
    assert tools.hint("edit_card-check-kept", cid=cid, field="takeaway") in r.text
    assert notebook.get_cell(CORPUS, cid)["title"] == "How many saves were there?"
    # then gives back its own takeaway alone
    r = await _call("edit_card", group, card=cid, takeaway="There were 1,204 saves, mostly in week 1.")
    assert tools.hint("edit_card-check-kept", cid=cid, field="takeaway") in r.text
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["title"] == "How many saves were there?" and "mostly" not in cell["takeaway"], "the fix survives both edits"
    # a new takeaway is the author's change and goes through
    r = await _call("edit_card", group, card=cid, takeaway="All 1,204 saves came in one month.")
    assert "check's takeaway stays" not in r.text and "one month" in notebook.get_cell(CORPUS, cid)["takeaway"]


def test_an_edit_written_against_the_card_before_a_fix_is_applied_to_the_fix():
    before = "Week 1 held most saves, 13,339 of them; the table cannot say who saved them."
    after = "Week 1 held most saves, 13,339 of them."
    # the author adds a clause to the takeaway it last saw: the clause lands, and the half the fix took out stays out
    added = "Week 1 held most saves, 13,339 of them (86% of all); the table cannot say who saved them."
    assert card_check.merge_edit("takeaway", before, after, added) == "Week 1 held most saves, 13,339 of them (86% of all)."
    # a change over the words the fix changed cannot be applied without guessing, so the author's value stands
    assert card_check.merge_edit("takeaway", before, after, "Week 1 held most saves; nobody knows who saved them.") is None
    # an edit made to the check's version is already whole
    assert card_check.merge_edit("takeaway", before, after, "Week 1 held most saves, 13,339 of them, in May.") is None
    # code merges by line
    code_before = "df = load()\ndf = df[df.week < 9]\nshow(df)\n"
    code_after = "df = load()\nshow(df)\n"
    code_new = "df = load()\ndf = df[df.week < 9]\ndf['share'] = df.saves / df.saves.sum()\nshow(df)\n"
    assert card_check.merge_edit("code", code_before, code_after, code_new) == "df = load()\ndf['share'] = df.saves / df.saves.sum()\nshow(df)\n"


async def test_the_author_s_next_takeaway_keeps_the_fix_and_adds_its_change(group):
    r = await _call("add_card", group, kind="code", question="How many saves were there?", code="print(1204)",
                    takeaway="There were 1,204 saves; the output cannot say who made them.")
    cid = next(m.group(1) for ln in r.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", ln.strip())))
    _fixed(cid, takeaway="There were 1,204 saves.")
    r = await _call("edit_card", group, card=cid, takeaway="There were 1,204 saves, all in May; the output cannot say who made them.")
    assert not r.is_error, r.text
    assert tools.hint("edit_card-check-merged", cid=cid, field="takeaway") in r.text
    take = notebook.get_cell(CORPUS, cid)["takeaway"]
    assert "all in May" in take and "who made them" not in take, take


TYPED_CODE = '''import pandas as pd
rows = [("opened an issue", 1204, 3), ("closed an issue", 877, 0), ("pushed to main", 36, 12)]
df = pd.DataFrame(rows, columns=["action", "tries", "worked"]).set_index("action")
df
'''


def test_numbers_typed_into_the_code_that_the_card_shows_are_flagged():
    shown = {"1204", "877", "36", "3", "0", "12"}
    assert card_check.typed_numbers(TYPED_CODE, shown) == ["1204", "877", "36", "12"], "single digits settle nothing alone"
    # the same numbers not on the card, or computed from the data, are no flag
    assert card_check.typed_numbers(TYPED_CODE, {"5", "9"}) == []
    computed = 'import pandas as pd\ndf = pd.read_json("events.jsonl", lines=True)\ndf.groupby("action").size()\n'
    assert card_check.typed_numbers(computed, shown) == []
    # a chart's settings and a choice of records to look at are not the card's data
    settings = ('import matplotlib.pyplot as plt\nfig, ax = plt.subplots(figsize=(12, 36))\n'
                'ax.set_xticks([1204, 877, 36])\nfor pr in [1204, 877, 36]:\n    print(pr)\n'
                'picked = (1204, 877, 36)\nhits = [n for n in range(2000) if n in picked]\n')
    assert card_check.typed_numbers(settings, shown) == []
    # years are an axis, not a count
    assert card_check.typed_numbers("years = [2019, 2020, 2021]\nyears\n", {"2019", "2020", "2021"}) == []


def test_shown_numbers_read_a_table_and_printed_output_but_not_an_image():
    cell = {"outputs": [{"text/plain": "opened an issue  1,204\nclosed an issue    877"},
                        {"image/png": "iVBORw0KGgo1204AAAA"}]}
    assert card_check.shown_numbers(cell) >= {"1204", "877"}
    assert card_check.shown_numbers({"outputs": [{"image/png": "iVBORw0KGgo1204AAAA"}]}) == set()


async def test_the_check_records_the_numbers_a_card_types_in(group, monkeypatch):
    from app import render

    r = await _call("add_card", group, kind="table", question="Which actions did the agents try, and how often did they work?",
                    code=TYPED_CODE, takeaway="Most tries opened an issue.")
    assert not r.is_error, r.text
    cid = next(m.group(1) for ln in r.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", ln.strip())))

    async def drawn(c, cell):
        return render.Rendered(png=b"\x89PNG\r\n\x1a\n")

    async def reading(c, cell, png, run):
        return [{"problem": ""}] * card_check.CRITERIA, {"question": cell["title"], "code": cell["code"],
                                                          "takeaway": cell["takeaway"]}, "stub"

    monkeypatch.setattr(card_check, "_draw", drawn)
    monkeypatch.setattr(card_check, "_read", reading)
    monkeypatch.setattr(card_check, "read_effort", lambda c: "low")
    run = card_check.start(CORPUS, cid, "main")
    assert run is not None and run.task is not None
    await run.task
    rec = notebook.get_cell(CORPUS, cid)["check"]
    assert rec["status"] == "ok"
    assert rec["stages"]["render"]["typed"] == ["1204", "877", "36", "12"]


def test_the_check_reads_a_card_at_the_verify_role_s_own_effort(monkeypatch):
    """The card check runs at the `verify` role's effort, high by default, and a workspace's choice replaces it; the
    effort of the session that made the card plays no part."""
    monkeypatch.delenv("THIMBLE_VERIFY_EFFORT", raising=False)
    models_for = config.models_for
    stored: dict = {}
    monkeypatch.setattr(config, "models_for", lambda c=None, settings=None: models_for(None, stored))
    assert card_check.read_effort(CORPUS) == "high"
    stored["models"] = {"verify": {"effort": "max"}}
    assert card_check.read_effort(CORPUS) == "max"
