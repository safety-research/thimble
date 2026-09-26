"""Labels from the chat and from the browser alike (concepts.py, tools.py): show_label turns a label over files on or
off without a run, the same predicate applied again keeps the label and its rows, a trial samples its records over the
files, a label the analyst runs in the browser gets its card and reaches main as the `labeled` event, and a label over
cards reads each card's kind and frames.

The regex kind runs for real over the synthetic corpus `mini` (mini_corpus.py); a code label's kernel is replaced by a
fake that reads the units file the wrapper is given. No test pins the wording of a line prompts/tools.md holds.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import agents, channel, concepts, config, notebook, session, tools

CORPUS = "mini"
CLAIM = r"(?i)forge pr claim"  # 3 of the 8 board posts match (L1, L6, L8)


@pytest.fixture(autouse=True)
async def _clean_state(workspaces_tmp, monkeypatch):
    for table in (concepts._runs, concepts._subs, concepts._locks, concepts._cancels, concepts._tasks, concepts._building,
                  concepts._building_answers):
        table.clear()
    channel._subs.clear()
    session._live.clear()
    session._expected.clear()
    agents._busy.clear()
    monkeypatch.setattr(concepts, "_loop", asyncio.get_running_loop())
    tools._last_cell.clear()
    yield
    for table in (concepts._runs, concepts._subs, concepts._tasks, concepts._building, concepts._building_answers):
        table.clear()
    channel._subs.clear()
    session._live.clear()
    await notebook.shutdown_all()


@pytest.fixture()
async def api():
    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=180) as c:
        yield c


def _ws() -> Path:
    return config.workspace_dir(CORPUS)


async def _label(name: str = "claims a PR", text: str = CLAIM, **kw) -> dict:
    """A regex label over files through apply_scoped, as apply_label makes it."""
    args = dict(scope="files", name=name, kind="regex", text=text, values=None, paths=["board.jsonl"], limit=None,
                comment=False, filter=False, created_by="terminal", chat=None, group=None)
    return await concepts.apply_scoped(CORPUS, **{**args, **kw})


async def _call(tool: str, **args):
    return await tools.call(CORPUS, tool, args, actor="analyst", terminal=True)


def _listen() -> asyncio.Queue:
    """A session's channel subscription, so that an event posted for the workspace is delivered (channel._publish)."""
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _events(q: asyncio.Queue) -> list[dict]:
    """What main was sent, and what waits for its next event (channel.QUIET_KINDS)."""
    out = channel._held.pop(CORPUS, [])
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _cards(ws: Path) -> list[dict]:
    return [x for info in notebook.list_notebooks(ws) for x in (notebook.read_notebook(ws, info["id"]) or {}).get("cells", [])]


# ----------------------------------------------------------------------------- show_label


async def test_show_label_turns_a_label_over_files_on_and_off_without_a_run():
    """The chat's twin of the Labels pane's toggle: `shown` changes, the version and the runs stay as they were, `values`
    picks what is highlighted, and turning it off drops a Files filter that names it."""
    s = await _label()
    before = concepts.read_concept(_ws(), s["concept"])
    r = await _call("show_label", name="claims a PR", on=True)
    assert not r.is_error, r.text
    after = concepts.read_concept(_ws(), s["concept"])
    assert after["shown"] is True and after["version"] == before["version"]
    assert len(after["applications"]) == len(before["applications"]) and concepts.running_apply(CORPUS, s["concept"]) is None
    assert f"[[concept:{s['concept']}]]" in r.text and "was off and is now on in Files and the views" in r.text and "highlighting yes" in r.text
    # by id, with the values to highlight
    r = await _call("show_label", name=s["concept"], on=True, values=["no"])
    assert not r.is_error and "is on in Files and the views, as it was" in r.text, r.text
    assert [(cl["name"], cl["highlight"]) for cl in concepts.read_concept(_ws(), s["concept"])["classes"]] == [("yes", False), ("no", True)]
    assert (await _call("show_label", name="claims a PR", on=True, values=["maybe"])).is_error
    # off drops the Files filter on it
    concepts.set_filter(CORPUS, "files", s["concept"], "yes")
    r = await _call("show_label", name="claims a PR", on=False)
    assert not r.is_error and concepts.read_concept(_ws(), s["concept"])["shown"] is False
    assert "files" not in concepts.read_filters(_ws())
    # a label no one defined, and one over cards, which Files does not show
    r = await _call("show_label", name="nope", on=True)
    assert r.is_error and "claims a PR" in r.text
    nb = notebook.create_notebook(_ws(), "Your work", role="analyst")
    notebook.insert_cell(CORPUS, nb["id"], notebook.new_cell("note", "user", "a claim", nb["id"], payload={"text": "forge pr claim"}))
    await _label(name="card claims", scope="canvas", paths=None)
    r = await _call("show_label", name="card claims", on=True)
    assert r.is_error and "card claims" in r.text
    assert concepts.find_concept(_ws(), "card claims")["shown"] is False
    assert (await _call("show_label", name="claims a PR")).is_error  # `on` is required


# ----------------------------------------------------------------------------- the same predicate again


async def test_the_same_predicate_again_keeps_the_label_and_runs_only_over_what_it_does_not_cover():
    """A chat that applies a label again, to show it or to filter by it, keeps its version and rows and starts no run;
    new files are run over; a changed predicate is a new version with its old rows cleared."""
    s = await _label()
    k = concepts.read_concept(_ws(), s["concept"])
    assert s["unchanged"] is False and k["version"] == 1 and len(k["applications"]) == 1
    again = await _label(filter=True)
    k = concepts.read_concept(_ws(), s["concept"])
    assert again["unchanged"] is True and again["concept"] == s["concept"] and again["counts"] == {"yes": 3, "no": 5}
    assert again["total"] == 8 and k["version"] == 1 and len(k["applications"]) == 1
    assert again["filter"] == {"concept": s["concept"], "value": "yes"}  # the filter is set with no run
    assert (await _label(limit=4))["unchanged"] is True  # a trial of a label that already ran on everything
    # another file: a run over it, keeping the board's rows
    more = await _label(paths=["events.jsonl"])
    k = concepts.read_concept(_ws(), s["concept"])
    assert more["unchanged"] is False and k["version"] == 1 and len(k["applications"]) == 2
    covered = {f["path"] for f in concepts.coverage(_ws(), k)["files"] if f["covered"]}
    assert covered == {"board.jsonl", "events.jsonl"}
    # a changed predicate: a new version, the old rows gone
    changed = await _label(text=r"(?i)review wanted")
    k = concepts.read_concept(_ws(), s["concept"])
    assert changed["unchanged"] is False and k["version"] == 2 and changed["counts"] == {"yes": 2, "no": 6}
    # a one-word name is the same label when named again, not a second label of that name
    one = await _label(name="claims")
    await _label(name="claims", text=r"(?i)claim")
    assert [x["id"] for x in concepts.list_concepts(_ws()) if x["name"] == "claims"] == [one["concept"]]
    assert concepts.read_concept(_ws(), one["concept"])["version"] == 2


async def test_apply_label_under_a_name_another_scope_holds_is_refused():
    """The analyst's label over files survives a chat that labels cards under its name."""
    s = await _label()
    r = await _call("apply_label", scope="canvas", name="claims a PR", predicate={"kind": "regex", "text": "claim"})
    assert r.is_error and f"concept:{s['concept']}" in r.text
    k = concepts.read_concept(_ws(), s["concept"])
    assert k["unit"] == "record" and k["version"] == 1 and concepts.concept_stats(_ws(), k)["n_labeled"] == 8


# ----------------------------------------------------------------------------- trials


def test_a_trial_spreads_its_limit_over_the_files_and_their_lines():
    assert concepts.spread(8, 4) == [1, 3, 5, 7] and concepts.spread(3, 5) == [0, 1, 2] and concepts.spread(10, 1) == [5]
    assert concepts.trial_quotas([20, 20, 20], 6) == [2, 2, 2]
    assert concepts.trial_quotas([100, 10, 0], 11) == [9, 2, 0]  # one from each file with lines, the rest by share
    assert concepts.trial_quotas([5] * 10, 3) == [0, 1, 0, 0, 0, 1, 0, 0, 1, 0]  # fewer than the files: spread over them
    assert concepts.trial_quotas([2, 3], 50) == [2, 3]  # never more than a file has
    assert sum(concepts.trial_quotas([7, 1, 400, 33], 95)) == 95


def test_a_trial_pick_on_a_line_without_words_takes_the_next_record_with_words():
    corpus_dir = config.corpus_dir(CORPUS)
    src = next(s for s in concepts.match_paths(corpus_dir, ["agents/agent-01.jsonl"]))
    units = concepts.trial_sample(corpus_dir, [src], 20, {src["path"]: 20})
    refs = [u.ref for u in units]
    assert len(refs) == len(set(refs)) and "agents/agent-01.jsonl#L9" not in refs  # L9: a thinking block with no text
    assert all(u.text(1000).strip() for u in units)


async def test_a_trial_over_files_reads_every_file_and_is_listed_once_shown():
    s = await _label(name="claims everywhere", text=r"(?i)the", paths=["agents/*.jsonl"], limit=6)
    rows = concepts.read_labels(_ws(), s["concept"])
    by_file: dict[str, int] = {}
    for r in rows:
        path = r["ref"].split("#")[0]
        by_file[path] = by_file.get(path, 0) + 1
    assert by_file == {"agents/agent-01.jsonl": 2, "agents/agent-02.jsonl": 2, "agents/agent-03.jsonl": 2}
    k = concepts.read_concept(_ws(), s["concept"])
    assert k["trial"] is True and s["total"] == 6 and k["applications"][-1]["limit"] == 6
    assert k["applications"][-1]["matched_total"] == 60
    # the same trial again is covered; a run without a limit runs on everything and makes it a label
    assert (await _label(name="claims everywhere", text=r"(?i)the", paths=["agents/*.jsonl"], limit=6))["unchanged"] is True
    whole = await _label(name="claims everywhere", text=r"(?i)the", paths=["agents/*.jsonl"])
    assert whole["unchanged"] is False and whole["total"] == 60 and concepts.read_concept(_ws(), s["concept"])["trial"] is False


async def test_a_trial_over_agent_files_runs_over_files_spread_over_the_scope(api):
    k = (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "a file with errors", "kind": "regex", "spec": "error",
                                                              "unit": "agent"})).json()
    s = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True, "paths": ["agents/*.jsonl"], "limit": 1})).json()
    assert s["total"] == 1 and s["matched_total"] == 3
    assert [r["ref"] for r in concepts.read_labels(_ws(), k["id"])] == ["agents/agent-02.jsonl"]  # the middle of three


# ----------------------------------------------------------------------------- the analyst's labels reach main


async def test_a_label_the_analyst_runs_in_the_browser_gets_a_card_and_reaches_main_once_per_version(api):
    k = (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "claims a PR", "kind": "regex", "spec": CLAIM,
                                                              "glob": "board.jsonl", "shown": True})).json()
    # with no session listening the run goes on, and main is told at a later run
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})).status_code == 200
    assert concepts.read_concept(_ws(), k["id"])["told"] == 0
    [card] = [x for x in _cards(_ws()) if x["kind"] == "label"]
    assert card["payload"] == {"concept": k["id"]} and card["title"] == "claims a PR"
    q = _listen()
    assert (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})).status_code == 200
    [note] = _events(q)
    assert note["meta"]["kind"] == "labeled" and note["meta"]["name"] == "claims a PR" and note["meta"]["what"] == "defined"
    assert note["meta"]["ref"] == f"concept:{k['id']}" and note["meta"]["scope"] == "files" and note["meta"]["classifier"] == "regex"
    assert note["meta"]["values"] == "yes, no" and note["meta"]["paths"] == "board.jsonl" and note["meta"]["card"] == f"card:{card['id']}"
    assert note["content"] == CLAIM
    assert [x["id"] for x in _cards(_ws()) if x["kind"] == "label"] == [card["id"]]  # the card is kept
    # a run of the same version tells main nothing new; a changed definition does
    await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})
    assert _events(q) == []
    await api.put(f"/api/ws/{CORPUS}/concepts/{k['id']}", json={"spec": r"(?i)review wanted"})
    await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})
    [note] = _events(q)
    assert note["meta"]["what"] == "changed" and note["content"] == r"(?i)review wanted"
    # a chat's own label is told as it is defined, so the chat's run posts nothing
    s = await _label(name="chat label")
    assert concepts.read_concept(_ws(), s["concept"])["told"] == 1 and _events(q) == []


async def test_a_label_over_cards_from_the_browser_is_listed_for_the_canvas_filter(api):
    """Files' new label over cards: unit `cell`, no files, run over the canvas; its card reaches the canvas and its
    values are what the canvas's Filter menu lists (Canvas.tsx canvasLabels: every label whose unit is the card)."""
    nb = notebook.create_notebook(_ws(), "Orientation", role="finding")
    for text in ("forge pr claim of #7160", "the backlog"):
        notebook.insert_cell(CORPUS, nb["id"], notebook.new_cell("note", "orient", text, nb["id"], payload={"text": text}))
    k = (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "mentions a claim", "kind": "regex", "spec": "claim",
                                                              "unit": "cell"})).json()
    s = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})).json()
    assert s["total"] == 2 and s["counts"] == {"yes": 1, "no": 1}
    listed = [x for x in (await api.get(f"/api/ws/{CORPUS}/concepts")).json() if x["unit"] == "cell"]
    assert [(x["name"], x["counts"]) for x in listed] == [("mentions a claim", {"yes": 1, "no": 1})]


# ----------------------------------------------------------------------------- a card's fields


def test_a_card_unit_carries_its_kind_question_takeaway_and_frames():
    ws = _ws()
    orient = notebook.create_notebook(ws, "Orientation", role="finding")
    plots = notebook.create_notebook(ws, "Charts", role="finding", parent=orient["id"])
    plot = notebook.new_cell("plot", "orient", "How many PRs merged per hour?", plots["id"], code="chart")
    plot["takeaway"] = "Most merges came in the first hour."
    note = notebook.new_cell("note", "orient", "", orient["id"], payload={"text": "The backlog."})
    for nb, cell in ((plots, plot), (orient, note)):
        notebook.insert_cell(CORPUS, nb["id"], cell)
    scratch = notebook.create_notebook(ws, notebook.SCRATCH_TITLE, role="exploration")
    stored = notebook.read_notebook(ws, scratch["id"])
    stored[notebook.SCRATCH_KEY] = True
    stored["cells"].append(notebook.new_cell("note", "orient", "", scratch["id"], payload={"text": "working"}))
    notebook.write_notebook(ws, stored)
    units = {u.ref: u.record for u in concepts.cell_units(ws)}
    assert set(units) == {f"card:{plot['id']}", f"card:{note['id']}"}  # scratch work is not on the canvas
    p = units[f"card:{plot['id']}"]
    assert p["kind"] == "plot" and p["question"] == p["title"] == "How many PRs merged per hour?"
    assert p["takeaway"] == "Most merges came in the first hour." and p["group"] == "Charts" and p["groups"] == ["Orientation", "Charts"]
    assert units[f"card:{note['id']}"]["group"] == "Orientation" and units[f"card:{note['id']}"]["kind"] == "note"


async def test_a_code_label_over_cards_reads_the_card_fields(api, monkeypatch):
    """label(unit) gets the card's fields in the units file, so "the plots in Orientation" is unit['kind'] and
    unit['groups'], not the group files."""
    ws = _ws()
    orient = notebook.create_notebook(ws, "Orientation", role="finding")
    plot = notebook.new_cell("plot", "orient", "Merges per hour", orient["id"], code="chart")
    table = notebook.new_cell("table", "orient", "PRs by state", orient["id"], code="df")
    for cell in (plot, table):
        notebook.insert_cell(CORPUS, orient["id"], cell)
    seen: dict = {}

    async def fake_execute_on(c, kernel, code, timeout_s=None):
        rows_file = Path(re.search(r"^_rows_file = '(.*)'$", code, re.M)[1])
        units = [json.loads(line) for line in Path(re.search(r"^_units_file = '(.*)'$", code, re.M)[1]).read_text("utf-8").splitlines()]
        seen["units"] = units
        rows_file.write_text("".join(json.dumps({"ref": u["ref"], "confidence": 1.0,
                                                 "label": "yes" if u["unit"]["kind"] == "plot" and "Orientation" in u["unit"]["groups"] else "no"})
                                     + "\n" for u in units), "utf-8")
        return [], 1, "ok"

    monkeypatch.setattr(notebook, "execute_on", fake_execute_on)
    k = (await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": "plots in Orientation", "kind": "code", "unit": "cell",
                                                              "spec": "def label(unit):\n    return unit['kind'] == 'plot'\n"})).json()
    s = (await api.post(f"/api/ws/{CORPUS}/concepts/{k['id']}/apply", json={"wait": True})).json()
    assert s["counts"] == {"yes": 1, "no": 1}
    assert {u["unit"]["question"]: (u["unit"]["kind"], u["unit"]["group"]) for u in seen["units"]} == {
        "Merges per hour": ("plot", "Orientation"), "PRs by state": ("table", "Orientation")}
