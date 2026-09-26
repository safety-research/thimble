"""The filters as the browser and a chat share them, so the analyst can filter from either: the canvas's whole filter
kept by the server, its card parts beside its label part (concepts.py, the filters section, and its routes), the chat's
set_filter and clear_filter (filters.py), list_cards stating the filter, and a Files filter on a second label turning
the first one off.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import agents, concepts, config, filters, notebook, tools

CORPUS = "mini"
PATTERN = r"(?i)forge pr claim"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    monkeypatch.setattr(concepts, "_loop", asyncio.get_running_loop())
    tools._last_cell.clear()
    tools._last_group.clear()
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def ws() -> Path:
    return config.workspace_dir(CORPUS)


@pytest.fixture()
async def api():
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=60) as c:
        yield c


def _card(ws: Path, group: str, kind: str, title: str, takeaway: str = "", created_by: str = "terminal", **fields) -> str:
    code = None if kind in ("note", "example", "label", "custom") else "1"
    payload = {"text": title} if kind == "note" else None
    cell = notebook.new_cell(kind, created_by, title, group, code=code, payload=payload)
    cell.update(takeaway=takeaway, **fields)
    return notebook.insert_cell(CORPUS, group, cell)["id"]


@pytest.fixture()
def board(ws):
    """Two groups and five cards: tables and a plot in Orientation, a note and a table in Your work, made by the
    orientation, main and a thread."""
    orient = notebook.create_notebook(ws, "Orientation")["id"]
    mine = notebook.create_notebook(ws, "Your work")["id"]
    thread = agents.new_thread(CORPUS, None, None, "why so many merges")
    ids = {
        "t1": _card(ws, orient, "table", "Merged PRs per agent", "[[31|card:x#merged/all]] of 40 runs merged", created_by="orient"),
        "t2": _card(ws, orient, "table", "Tests per run", "most runs ran the suite once", created_by="orient", starred=True),
        "p1": _card(ws, orient, "plot", "Merge time over the runs", "", created_by="orient"),
        "n1": _card(ws, mine, "note", "Open questions", "", created_by="terminal", locked=True),
        "t3": _card(ws, mine, "table", "Reviews per PR", "reviews do not predict a merge", created_by=f"chat:{thread['id']}"),
    }
    return {"orient": orient, "mine": mine, "thread": thread, **ids}


def _events(ws: Path) -> list[dict]:
    p = ws / "investigations" / "main" / "events.jsonl"
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()] if p.exists() else []


async def _settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


# ----------------------------------------------------------------------------- the store and its routes


async def test_the_canvas_filter_holds_its_card_parts_beside_its_label_part(api, ws, board):
    """Set in one tab, the whole canvas filter is on the server, so another tab and a reload read the same one; the
    label part and the card parts change on their own, and only `whole` clears both."""
    k = concepts.define_concept(CORPUS, "mentions merge", "", "regex", "merge", "cell")
    base = f"/api/ws/{CORPUS}/filters"
    r = await api.put(f"{base}/canvas/cards", json={"kinds": ["table", "table", " "], "groups": [board["orient"]], "text": "  merge   time "})
    assert r.status_code == 200
    assert r.json() == {"canvas": {"kinds": ["table"], "groups": [board["orient"]], "text": "merge time"}}
    r = await api.put(base, json={"scope": "canvas", "concept": k["id"], "value": "yes"})
    assert r.json()["canvas"] == {"concept": k["id"], "value": "yes", "kinds": ["table"], "groups": [board["orient"]], "text": "merge time"}
    # the parts are set all at once: one left out is unset, and the label stays
    r = await api.put(f"{base}/canvas/cards", json={"starred": True})
    assert r.json()["canvas"] == {"concept": k["id"], "value": "yes", "starred": True}
    assert (await api.get(base)).json() == r.json(), "what a second tab or a reload reads"
    # the label chip's clear keeps the card parts; clearing the whole filter drops both
    assert (await api.delete(f"{base}/canvas")).json() == {"canvas": {"starred": True}}
    await api.put(base, json={"scope": "canvas", "concept": k["id"], "value": "yes"})
    assert (await api.delete(f"{base}/canvas", params={"whole": "true"})).json() == {}
    assert json.loads(concepts.filters_file(ws).read_text()) == {}
    await _settle()
    got = [(e["scope"], e.get("concept"), e.get("value")) for e in _events(ws) if e["type"] == "filter"]
    assert got == [("canvas", None, None), ("canvas", k["id"], "yes"), ("canvas", k["id"], "yes"), ("canvas", None, None),
                   ("canvas", k["id"], "yes"), ("canvas", None, None)]


def test_a_stored_filter_is_read_back_only_where_it_fits(ws):
    concepts.filters_file(ws).write_text(json.dumps({
        "files": {"concept": "k1", "value": "yes", "kinds": ["table"]},
        "canvas": {"kinds": ["plot", 3, ""], "groups": "g1", "starred": "yes", "locked": True, "text": 7},
        "report": {"concept": "k2"},
    }))
    assert concepts.read_filters(ws) == {"files": {"concept": "k1", "value": "yes"},
                                         "canvas": {"kinds": ["plot"], "groups": ["g1"], "locked": True}}


async def test_deleting_a_label_keeps_the_canvas_card_parts(api, ws, board):
    k = concepts.define_concept(CORPUS, "mentions merge", "", "regex", "merge", "cell")
    concepts.set_card_filter(CORPUS, {"kinds": ["plot"]})
    concepts.set_filter(CORPUS, "canvas", k["id"], "yes")
    assert (await api.delete(f"/api/ws/{CORPUS}/concepts/{k['id']}")).status_code == 200
    assert concepts.read_filters(ws) == {"canvas": {"kinds": ["plot"]}}


async def test_a_files_filter_on_another_label_turns_the_first_off(api, ws):
    """Filter Files by A, then by B, and only B shows."""
    a = concepts.define_concept(CORPUS, "claims a PR", "", "regex", PATTERN, "record")
    b = concepts.define_concept(CORPUS, "mentions review", "", "regex", "review", "record")
    concepts.set_filter(CORPUS, "files", a["id"], "yes")
    assert concepts.read_concept(ws, a["id"])["shown"] is True
    concepts.set_filter(CORPUS, "files", b["id"], "yes")
    assert concepts.read_concept(ws, a["id"])["shown"] is False
    assert concepts.read_concept(ws, b["id"])["shown"] is True
    assert concepts.read_filters(ws)["files"] == {"concept": b["id"], "value": "yes"}
    # the same label with another value stays on
    concepts.set_filter(CORPUS, "files", b["id"], "no")
    assert concepts.read_concept(ws, b["id"])["shown"] is True


# ----------------------------------------------------------------------------- how the server reads a canvas filter


def test_maker_names_a_card_as_its_top_row_does():
    chats = {"t1": {"kind": "thread", "title": "why so many merges"}, "a1": {"kind": "agent", "role": "labels", "title": "x"}}
    assert [filters.maker(c, chats) for c in (None, "", "user", "terminal", "chat:main", "chat:t1", "chat:a1", "chat:gone", "orient")] == \
        ["main", "main", "main", "main", "main", "why so many merges", "labels", "gone", "orient"]


def test_text_search_reads_citations_as_their_labels():
    text = filters.search_text("Merged PRs per agent", "[[31|card:ab#outcome/merged]] of [[card:cd]] runs")
    assert text == "merged prs per agent 31 of runs"
    assert filters.text_matches(text, "MERGE runs") and not filters.text_matches(text, "outcome")
    # a word matches where a word starts: merge is in merged, not in emergent
    assert not filters.text_matches(filters.search_text("Runs managed or emergent"), "merge")
    assert filters.text_matches(filters.search_text("the 2,583 issues"), "2,583 ISS")


async def test_canvas_view_keeps_the_cards_every_part_passes(ws, board):
    k = concepts.define_concept(CORPUS, "mentions merge", "", "regex", "merge", "cell")
    concepts.labels_file(ws, k["id"]).parent.mkdir(parents=True, exist_ok=True)
    concepts.labels_file(ws, k["id"]).write_text("".join(
        json.dumps({"ref": f"card:{board[x]}", "label": "yes" if x in ("t1", "p1", "t3") else "no", "confidence": 1.0,
                    "source": "regex", "ts": "2026-09-25T00:00:00Z"}) + "\n" for x in ("t1", "t2", "p1", "n1", "t3")))
    assert filters.canvas_view(CORPUS) is None
    concepts.set_card_filter(CORPUS, {"kinds": ["table"]})
    assert filters.canvas_view(CORPUS)["kept"] == {board["t1"], board["t2"], board["t3"]}
    concepts.set_filter(CORPUS, "canvas", k["id"], "yes")
    assert filters.canvas_view(CORPUS)["kept"] == {board["t1"], board["t3"]}
    concepts.set_card_filter(CORPUS, {"kinds": ["table"], "makers": ["why so many merges"]})
    assert filters.canvas_view(CORPUS)["kept"] == {board["t3"]}
    concepts.clear_filter(CORPUS, "canvas", whole=True)
    concepts.set_card_filter(CORPUS, {"groups": [board["orient"]], "text": "merge"})
    assert filters.canvas_view(CORPUS)["kept"] == {board["t1"], board["p1"]}
    concepts.set_card_filter(CORPUS, {"starred": True})
    assert filters.canvas_view(CORPUS)["kept"] == {board["t2"]}
    concepts.set_card_filter(CORPUS, {"locked": True})
    view = filters.canvas_view(CORPUS)
    assert view["kept"] == {board["n1"]} and len(view["cards"]) == 5


# ----------------------------------------------------------------------------- the chat's tools


async def main_call(tool: str, **args):
    return await tools.call(CORPUS, tool, args)


async def test_set_filter_filters_the_canvas_by_kind_and_group_and_makes_nothing(ws, board):
    """ "only tables in Orientation": chips on the canvas, no label and no card."""
    cards_before = notebook.canvas(ws)["cells"]
    r = await main_call("set_filter", scope="canvas", kinds=["Table"], groups=["Orientation"])
    assert not r.is_error, r.text
    assert concepts.read_filters(ws) == {"canvas": {"kinds": ["table"], "groups": [board["orient"]]}}
    assert "Kind · table; Group · Orientation" in r.text and "It keeps 2 of the canvas's 5 cards" in r.text
    assert concepts.list_concepts(ws) == [] and notebook.canvas(ws)["cells"] == cards_before
    # a part given replaces that part, and the others stay
    r = await main_call("set_filter", scope="canvas", kinds=["plot", "table"], text="merge")
    assert concepts.read_filters(ws)["canvas"] == {"kinds": ["plot", "table"], "groups": [board["orient"]], "text": "merge"}
    assert "keeps 2 of" in r.text
    r = await main_call("set_filter", scope="canvas", groups=[], starred=True)
    assert concepts.read_filters(ws)["canvas"] == {"kinds": ["plot", "table"], "starred": True, "text": "merge"}
    # "clear the filters" brings every card back
    r = await main_call("clear_filter", scope="canvas")
    assert not r.is_error and "canvas filter is cleared" in r.text and concepts.read_filters(ws) == {}


async def test_the_canvas_filters_by_what_the_card_check_found_from_the_chat_and_the_route(api, ws, board):
    """A card's check state is what its check mark shows (lib/cardCheck.ts): verified once a check read it to the end,
    revised or not, or while a fix a check applied is in effect; unverified while a check runs or after one was stopped;
    failed when the check could not finish; unchecked when none read it. The chat's set_filter takes the states by name
    or by the menu's words, the route takes the parts the menu sets, and both keep the same cards."""
    def check(key: str, **fields) -> None:
        nb = notebook.read_notebook(ws, board["orient"] if key in ("t1", "t2", "p1") else board["mine"])
        next(c for c in nb["cells"] if c["id"] == board[key]).update(fields)
        notebook.write_notebook(ws, nb)

    check("t1", check={"status": "ok"})
    check("t2", check={"status": "fixed"})
    check("p1", check={"status": "pending", "phase": "queued"})
    check("t3", check={"status": "error", "reason": "the drawing timed out"})
    states = {c["id"]: c["check"] for c in filters.canvas_cards(CORPUS)}
    assert states == {board["t1"]: "verified", board["t2"]: "verified", board["p1"]: "unverified", board["n1"]: "unchecked",
                      board["t3"]: "failed"}
    assert filters.check_state({"kind": "table", "check": {"status": "stopped"}}) == "unverified"
    assert filters.check_state({"kind": "label", "check": {"status": "ok"}}) == "unchecked", "a label card is never checked"
    fixed = {"kind": "table", "title": "q", "takeaway": "Eight posts.", "fixes": [
        {"state": "applied", "fields": ["takeaway"], "before": {"takeaway": "8 posts."}, "after": {"takeaway": "Eight posts."}}]}
    assert filters.check_state(fixed) == "verified", "a fix still in effect, its record gone"
    assert filters.check_state({**fixed, "takeaway": "Edited since."}) == "unchecked"
    r = await main_call("set_filter", scope="canvas", checks=["Not checked", "failed"])
    assert not r.is_error, r.text
    assert concepts.read_filters(ws) == {"canvas": {"checks": ["unchecked", "failed"]}}
    assert "Check · Not checked, Failed" in r.text and "It keeps 2 of the canvas's 5 cards" in r.text
    assert filters.canvas_view(CORPUS)["kept"] == {board["n1"], board["t3"]}
    r = await main_call("set_filter", scope="canvas", checks=["maybe"])
    assert r.is_error and "no check state 'maybe'; the states are 'verified', 'unverified', 'failed', 'not checked'" in r.text
    assert concepts.read_filters(ws) == {"canvas": {"checks": ["unchecked", "failed"]}}
    r = await api.put(f"/api/ws/{CORPUS}/filters/canvas/cards", json={"checks": ["verified", "verified"], "kinds": ["table"]})
    assert r.json() == {"canvas": {"kinds": ["table"], "checks": ["verified"]}}
    assert filters.canvas_view(CORPUS)["kept"] == {board["t1"], board["t2"]}


async def test_set_filter_by_a_label_and_its_value(ws, board):
    k = concepts.define_concept(CORPUS, "mentions merge", "", "regex", "merge", "cell", labels=["yes", "no"])
    concepts.set_card_filter(CORPUS, {"kinds": ["table"]})
    r = await main_call("set_filter", scope="canvas", label="Mentions Merge")
    assert not r.is_error, r.text
    assert concepts.read_filters(ws)["canvas"] == {"concept": k["id"], "value": "yes", "kinds": ["table"]}
    assert "mentions merge = yes" in r.text
    await main_call("set_filter", scope="canvas", label=f"concept:{k['id']}", value="NO")
    assert concepts.read_filters(ws)["canvas"]["value"] == "no"
    # an empty label drops the label part alone
    await main_call("set_filter", scope="canvas", label="")
    assert concepts.read_filters(ws) == {"canvas": {"kinds": ["table"]}}


async def test_set_filter_refuses_what_it_does_not_know_and_changes_nothing(ws, board):
    files_label = concepts.define_concept(CORPUS, "claims a PR", "", "regex", PATTERN, "record")
    concepts.define_concept(CORPUS, "mentions merge", "", "regex", "merge", "cell")
    concepts.set_card_filter(CORPUS, {"kinds": ["plot"]})
    before = concepts.read_filters(ws)
    cases = [
        (dict(scope="moon", kinds=["table"]), "`scope` must be one of"),
        (dict(scope="canvas"), "name a `label`, or a part of the card filter"),
        (dict(scope="files", kinds=["table"]), "kinds filter the canvas's cards"),
        (dict(scope="canvas", kinds=["chart"]), "no card kind 'chart'; the kinds are plot, table"),
        (dict(scope="canvas", kinds=["table"], groups=["Nowhere"]), "no group 'Nowhere'; the groups are 'Orientation', 'Your work'"),
        (dict(scope="canvas", makers=["critic"]), "no card on the canvas was made by 'critic'; its makers are 'main', 'orient', 'why so many merges'"),
        (dict(scope="canvas", label="no such label"), "no label 'no such label'; the labels over canvas are 'mentions merge'"),
        (dict(scope="canvas", label=files_label["name"]), "labels records, not canvas"),
        (dict(scope="canvas", label="mentions merge", value="maybe"), "has no value 'maybe'; its values are 'yes', 'no'"),
    ]
    for args, said in cases:
        r = await main_call("set_filter", **args)
        assert r.is_error and said in r.text, (args, r.text)
        assert concepts.read_filters(ws) == before, args


async def test_set_filter_in_files_and_the_report(ws):
    k = concepts.define_concept(CORPUS, "claims a PR", "", "regex", PATTERN, "record")
    r = await main_call("set_filter", scope="files", label="claims a PR")
    assert not r.is_error and "The files filter is now claims a PR = yes." in r.text and "keeps" not in r.text
    assert "its views keep only the records that take the value" in r.text
    assert concepts.read_concept(ws, k["id"])["shown"] is True
    r = await main_call("clear_filter", scope="files")
    assert not r.is_error and concepts.read_filters(ws) == {} and concepts.read_concept(ws, k["id"])["shown"] is False


async def test_list_cards_states_the_canvas_filter(ws, board):
    r = await main_call("list_cards", group="all")
    assert "filter" not in r.text
    await main_call("set_filter", scope="canvas", kinds=["table"], groups=["Orientation"])
    r = await main_call("list_cards", group="all")
    lines = r.text.splitlines()
    assert lines[1] == ("The canvas filter Kind · table; Group · Orientation keeps 2 of the canvas's 5 cards. The analyst "
                        "sees the cards tagged filtered out dimmed.")
    tagged = {line.split()[1][len("card:"):] for line in lines if "filtered out" in line and line.startswith("- card:")}
    assert tagged == {board["p1"], board["n1"], board["t3"]}


def test_the_filter_tools_are_main_and_threads_tools():
    names = [t["name"] for t in tools.list("analyst")]
    # the label tools, then the filter tools: apply_label, show_label, set_filter, clear_filter
    assert names.index("set_filter") == names.index("show_label") + 1 == names.index("apply_label") + 2
    assert names.index("clear_filter") == names.index("set_filter") + 1
    assert tools.schema_of("set_filter")["required"] == ["scope"]
    assert set(tools.schema_of("set_filter")["properties"]) == {"scope", "label", "value", *concepts.CARD_PARTS}


async def test_a_browser_message_carries_the_filters_set_now(ws, board, tmp_path, monkeypatch):
    """A filter the analyst set in the browser reaches main with their next message, as `canvas_filter`."""
    from app import channel, session

    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    channel._subs.clear()
    cwd, main = tmp_path / "corpus", tmp_path / "proj" / "0f0f0f0f-0000-4000-8000-0000000000f1.jsonl"
    cwd.mkdir()
    main.parent.mkdir(parents=True)
    main.write_text("")
    assert session.attach(CORPUS, main.stem, str(cwd), str(main)) is not None
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    try:
        channel.post(CORPUS, "main", {"text": "which cards am I looking at?"})
        assert not any(k.endswith("_filter") for k in q.get_nowait()["meta"])
        concepts.set_card_filter(CORPUS, {"kinds": ["table"], "text": "merge"})
        channel.post(CORPUS, "main", {"text": "which cards am I looking at?"})
        assert q.get_nowait()["meta"]["canvas_filter"] == 'Kind · table; Text · "merge"'
    finally:
        session._live.clear()
        channel._subs.clear()
