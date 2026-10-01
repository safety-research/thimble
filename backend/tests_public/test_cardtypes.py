"""app.cardtypes and thimble.card, with the `multiagent-swimlane` card type, which the Swarm extension gave as `swarm` and
then `agent-swimlane` before. On a corpus of JSON Lines records, the registry finds the type without any view
proposal and lists it for main's prompt; a card's code draws it with thimble.card, which checks the arguments against the
type's schema, runs card.py on the reader's cached index under the labels the call names, whatever Files highlights, and
shows the data with a listing main reads and cites; the card check's page gets the type's frame from the request. Keep
writes a patch of the arguments into the card's one thimble.card call (its tests with a type that has such arguments are
in test_extensions). Main hears when a label it ran finishes, and can colour a label's values.

The corpus `crew` is 140 saves of 35 accounts on 4 pages, each naming the next account, which the Swarm reader reads as
a swarm; Swarm is added, and with it multiagent-swimlane. Reader calls run in this process (views._runner replaced by an exec of the kernel's
snippet), and thimble.card runs in this process in a module built from kernel_thimble.py, as a kernel builds it."""
from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import types
from pathlib import Path

import pytest

from fastapi import HTTPException

from app import card_check, cardtypes, channel, concepts, config, extensions, notebook, render, tools, views

SWIMLANE = extensions.builtin_dir() / "multiagent-swimlane" / "cards" / "multiagent-swimlane"

CORPUS = "crew"
ROWS = [{"page": f"p{i % 4}", "user": f"bot{i % 35}", "ts": f"2026-04-14T{i // 60:02d}:{i % 60:02d}:00Z",
         "text": f"Relay from bot{(i + 1) % 35}: the value is {i}."} for i in range(140)]


@pytest.fixture()
def crew(workspaces_tmp, tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data" / CORPUS
    d.mkdir(parents=True)
    (d / "saves.jsonl").write_text("".join(json.dumps(r) + "\n" for r in ROWS))
    (d / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a swarm"}))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    extensions.add("swarm", yes=True, say=lambda _: None)
    return d.resolve()


async def _refresh() -> dict:
    await extensions.refresh(CORPUS, wait=10)
    return await cardtypes.refresh(CORPUS, warm=False)


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture(autouse=True)
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._memo.clear()
    views._ready.clear()
    saved = {k: sys.modules.get(k) for k in ("thimble", "_thimble_views")}
    yield
    for k, v in saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


@pytest.fixture()
def kernel(crew, monkeypatch):
    """thimble as a card's kernel has it, in the corpus folder, with what it displays kept in `shown`."""
    src = (Path(views.KERNEL_THIMBLE)).read_text("utf-8")
    mod = types.ModuleType("thimble")
    mod.WS = str(config.workspace_dir(CORPUS))
    exec(src, mod.__dict__)  # noqa: S102 — as notebook._THIMBLE_INSTALL builds it
    mod.shown = []
    mod._show = mod.shown.append
    sys.modules["thimble"] = mod
    monkeypatch.chdir(crew)
    return mod


async def _label(name: str, pattern: str, values: list[str]) -> str:
    s = await concepts.apply_scoped(CORPUS, scope="files", name=name, kind="regex", text=pattern, values=values,
                                    paths=["saves.jsonl"], limit=None, comment=False, filter=False, created_by="test",
                                    chat=None, group=None, card=False)
    await concepts.wait_apply(CORPUS, s["concept"], 60)
    return s["concept"]


async def test_the_swarm_extensions_type_is_found_and_listed_for_main_with_its_guide(crew):
    """The type is `multiagent-swimlane`; a card made while it was `swarm` or `agent-swimlane` still draws it."""
    types_ = await _refresh()
    assert sorted(types_) == ["multiagent-swimlane"]
    t = types_["multiagent-swimlane"]
    assert t["page"] == "card.html" and t["claims"] == ["*.jsonl", "*.csv"] and t["paths"] == ["saves.jsonl"]
    assert Path(t["reader"]).is_relative_to(config.workspace_dir(CORPUS)), "a card's kernel sees only the workspace"
    assert cardtypes.read_registry(CORPUS)["multiagent-swimlane"]["fp"] == t["fp"]
    text = cardtypes.prompt_text(CORPUS)
    assert text.startswith("### Card types") and "\n- `multiagent-swimlane`: " in text and "`swarm`" not in text
    assert "`actions` [{ref, summary, thread?}]" in text and 'thimble.card("multiagent-swimlane"' in text
    assert "Use `multiagent-swimlane` to answer how accounts acted on each other" in text
    assert cardtypes.find(CORPUS, "swarm") == t and cardtypes.canonical(CORPUS, "swarm") == "multiagent-swimlane"
    assert cardtypes.canonical(CORPUS, "agent-swimlane") == "multiagent-swimlane" and "`agent-swimlane`" not in text
    assert 'id="plot"' in cardtypes.frame_document(CORPUS, "swarm")


async def test_a_card_draws_the_actions_it_names_in_event_order_with_goals_threads_and_links(crew, kernel):
    await _refresh()
    colour = await _label("even", r"value is \d*[02468]\.", ["even", "odd"])
    kernel.card("multiagent-swimlane", labels=["even"],
                actions=[{"ref": "saves.jsonl#L9", "summary": "Relayed 8"},
                         {"ref": "L2", "summary": "Relayed 1", "thread": "the relay"},
                         {"ref": "./saves.jsonl#L5", "summary": "Relayed 4"}],
                goals={"BOT1": "Pass the value on"},
                links=[{"from": "saves.jsonl#L5", "to": "saves.jsonl#L2", "type": "copies"}, {"from": 3, "to": 1, "type": "copies"}])
    bundle = kernel.shown[-1]
    made = bundle[cardtypes.CARD_MIME]
    data = made["data"]
    assert made["type"] == "multiagent-swimlane" and made["labels"] == [{"id": colour, "name": "even"}]
    assert [(a["id"], a["account"], a["summary"]) for a in data["actions"]] == [
        (1, "bot1", "Relayed 1"), (2, "bot4", "Relayed 4"), (3, "bot8", "Relayed 8")], "numbered in event order"
    assert [(a["tag"], a["thread"]) for a in data["actions"]] == [("T1", "the relay"), ("T2", "p0"), ("T2", "p0")], (
        "a thread is the record's place unless the call names one")
    assert [a["m"] for a in data["actions"]] == [-1, 0, 0], "a label the call names colours its actions"
    assert [(t["name"], t["place"], t["ref"]) for t in data["threads"]] == [
        ("the relay", "p1", "saves.jsonl#L2"), ("p0", "p0", "saves.jsonl#L1")], "a thread on one page links to it"
    assert (data["actions"][1]["page"], data["actions"][1]["page_ref"]) == ("p0", "saves.jsonl#L1")
    assert data["rows"][0] == {"account": "bot1", "goal": "Pass the value on", "inferred": True, "n": 4}
    assert data["links"] == [{"from": 2, "to": 1, "type": "copies"}, {"from": 3, "to": 1, "type": "copies"}]
    assert data["types"] == ["copies"]
    lines = bundle["text/plain"].split("\n")
    assert lines[0] == "multiagent-swimlane: 3 actions by 3 accounts on 2 threads; 2 links (copies 2)"
    assert lines[2].startswith("#1 2026-04-14 00:01 bot1 T1: Relayed 1") and lines[2].endswith("saves.jsonl#L2")
    assert lines[3].endswith("[even]: Relayed 4 saves.jsonl#L5")
    assert "links: 2→1 copies, 3→1 copies" in lines
    cell = {"id": "c1", "kind": "plot", "status": "ok", "outputs": [bundle]}
    texts, extras = tools._outputs_text(cell, addressed=True)
    assert "chart" in extras and tools._output_shape(cell) == "chart"
    assert texts[0].split("\n")[1] == "L1|" + lines[0], "main cites the listing as card:<id>@out0#L<n>"
    with pytest.raises(ValueError, match=r"no action on 'saves.jsonl#L999'; a ref is a record's file and line"):
        kernel.card("multiagent-swimlane", actions=[{"ref": "saves.jsonl#L999", "summary": "x"}])
    with pytest.raises(ValueError, match=r"links\[0\].to 'saves.jsonl#L3' is none of the actions"):
        kernel.card("multiagent-swimlane", actions=[{"ref": "saves.jsonl#L2", "summary": "x"}],
                    links=[{"from": "saves.jsonl#L2", "to": "saves.jsonl#L3", "type": "reply"}])


async def test_a_wrong_argument_names_what_the_type_takes(crew, kernel):
    await _refresh()
    with pytest.raises(ValueError, match=r"has no `rows`; the keys are actions, goals, links"):
        kernel.card("multiagent-swimlane", actions=[{"ref": "saves.jsonl#L2", "summary": "x"}], rows="accounts")
    with pytest.raises(ValueError, match=r"needs `actions`"):
        kernel.card("multiagent-swimlane")
    with pytest.raises(ValueError, match=r"no card type 'graph'; the types here are 'multiagent-swimlane'"):
        kernel.card("graph")
    assert not kernel.shown
    kernel.card("swarm", actions=[{"ref": "saves.jsonl#L2", "summary": "x"}])
    assert kernel.shown[-1][cardtypes.CARD_MIME]["type"] == "multiagent-swimlane", "a card's code under the old name draws it"


async def test_the_check_s_page_gets_the_type_s_frame_from_the_request(crew, kernel):
    await _refresh()
    kernel.card("multiagent-swimlane", actions=[{"ref": "saves.jsonl#L2", "summary": "Relayed 1"}])
    cell = {"id": "c1", "kind": "plot", "status": "ok", "title": "Who relayed first?", "outputs": [kernel.shown[-1]]}
    req = render.request_for(CORPUS, cell)
    doc = req["frames"]["multiagent-swimlane"]
    assert "connect-src 'none'" in doc and '"card": true' in doc and 'id="plot"' in doc
    assert req["width"] == render.TYPE_W, "the check sees a card type's page at full width"
    assert "frames" not in render.request_for(CORPUS, {"id": "c2", "kind": "plot", "outputs": []})


def test_a_card_type_frame_shot_blank_is_found():
    import io

    from PIL import Image, ImageDraw

    box, frame = {"x": 16, "y": 16, "width": 200, "height": 100}, {"x": 26, "y": 56, "width": 180, "height": 50}
    im = Image.new("RGB", (200 * render.SCALE, 100 * render.SCALE), "#fbfaf6")
    ImageDraw.Draw(im).text((20, 10), "Who relayed first?", fill="black")
    png = io.BytesIO()
    im.save(png, "PNG")
    assert render.blank_frames(png.getvalue(), box, [frame])
    ImageDraw.Draw(im).rectangle((40, 100, 120, 140), outline="black")
    png = io.BytesIO()
    im.save(png, "PNG")
    assert not render.blank_frames(png.getvalue(), box, [frame]) and not render.blank_frames(png.getvalue(), box, [])


async def test_the_card_check_keeps_no_replacement_that_draws_another_kind_of_card():
    table = {"status": "ok", "outputs": [{"text/plain": "a table"}]}
    assert await card_check._not_kept(None, table, "multiagent-swimlane") == "it drew no multiagent-swimlane card"


def test_keep_rewrites_the_literal_arguments_of_the_one_card_call():
    schema = {"properties": {"rows": {"type": "string", "enum": ["account", "signature"], "default": "account", "ui": True},
                             "only": {"type": "array", "ui": True}, "accounts": {"type": "array", "ui": True}}}
    code = ('import thimble\nkept = ["kestrel"]\n'
            'thimble.card("swarm", labels=["signal"], within={"label": "early"}, only=[{"label": "signal", "value": "é"}])\n')
    out, written = cardtypes.rewrite_call(code, {"rows": "signature", "only": None}, schema)
    assert out == 'import thimble\nkept = ["kestrel"]\nthimble.card("swarm", labels=["signal"], within={"label": "early"}, rows="signature")\n'
    assert written == []
    back, _ = cardtypes.rewrite_call(out, {"rows": "account", "accounts": ["kestrel", "nova", "ParallelSectorAgent"]}, schema)
    assert back.endswith('thimble.card(\n    "swarm",\n    labels=["signal"],\n    within={"label": "early"},\n'
                         '    accounts=["kestrel", "nova", "ParallelSectorAgent"])\n'), (
        "a call longer than a line takes a line per argument, and a default removes the keyword")
    only = 'thimble.card("swarm", only=[{"label": "signal", "value": v} for v in vals], accounts=top)'
    out, written = cardtypes.rewrite_call(only, {"only": [{"label": "signal", "value": "ping"}], "accounts": ["nova"]}, schema)
    assert out == 'thimble.card("swarm", only=[{"label": "signal", "value": "ping"}], accounts=["nova"])'
    assert written == ["only", "accounts"], "an argument the code computed is written out as the analyst chose it"
    with pytest.raises(cardtypes.KeepError, match=r"passes its arguments with \*\*"):
        cardtypes.rewrite_call('thimble.card("swarm", **args)', {"rows": "signature"}, schema)
    with pytest.raises(cardtypes.KeepError, match="calls thimble.card once"):
        cardtypes.rewrite_call('thimble.card("swarm")\nthimble.card("swarm")', {"rows": "signature"}, schema)


async def test_main_hears_when_a_label_it_ran_finishes_and_can_colour_its_values(crew):
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    try:
        cid = await _label("even", r"value is \d*[02468]\.", ["even", "odd"])
        concepts.tell_when_done(CORPUS, cid)
        note = await asyncio.wait_for(q.get(), 10)
        assert note["meta"]["kind"] == "label_done" and "label even" in note["content"] and "even 70" in note["content"]
    finally:
        channel._subs.pop(CORPUS, None)
    concepts.show_concept(CORPUS, "even", None, colours={"odd": "cyan", "even": "blue"})
    after = {cl["name"]: cl["color"] for cl in concepts.read_concept(config.workspace_dir(CORPUS), cid)["classes"]}
    assert after == {"even": 1, "odd": 12}
    concepts.show_concept(CORPUS, "even", None, colours={"odd": "blue"})
    swapped = {cl["name"]: cl["color"] for cl in concepts.read_concept(config.workspace_dir(CORPUS), cid)["classes"]}
    assert swapped == {"even": 12, "odd": 1}, "the value that had the colour takes the one the other left"
    with pytest.raises(HTTPException, match="no label colour is named 'red'"):
        concepts.show_concept(CORPUS, "even", None, colours={"odd": "red"})
    named = tools.schema_of("show_label")["properties"]["colours"]["additionalProperties"]["enum"]
    assert named == list(concepts.COLOUR_NAMES) and sorted(concepts.COLOUR_NAMES.values()) == list(range(1, concepts.PALETTE + 1))


async def test_the_swarm_extension_ships_no_view_and_takes_back_the_one_it_installed(crew, monkeypatch, tmp_path):
    """Swarm and multiagent-swimlane give a card type and orientation but no view: on a swarm they run and nothing is proposed
    or installed, a card of its type has no view to open, and the Swarm view an earlier version installed goes, as does
    thimble's own install of it from before Swarm was an extension."""
    old = tmp_path / "old-swarm-view"
    old.mkdir()
    for name in ("reader.py", "card.py"):
        (old / name).write_text((SWIMLANE / name).read_text("utf-8"))
    (old / "view.html").write_text("<!doctype html><title>Swarm</title>")
    (old / "view.json").write_text(json.dumps({"name": "Swarm", "claims": ["saves.jsonl"]}))
    views.install_viewer(CORPUS, "swarm", old, ["saves.jsonl"], why="", proposed_by="extension", orientation=False,
                         extension="swarm")
    views.install_viewer(CORPUS, "relay", old, ["saves.jsonl"], why="", proposed_by="thimble", orientation=True)
    state = await extensions.refresh(CORPUS, wait=10)
    assert state["extensions"]["swarm"]["active"] and state["extensions"]["swarm"]["views"] == []
    assert views.list_proposals(CORPUS) == [] and views.read_view(CORPUS, "swarm") is None
    types_ = await cardtypes.refresh(CORPUS, warm=False)
    assert types_["multiagent-swimlane"]["view"] is None
    cell = {"id": "c1", "outputs": [{cardtypes.CARD_MIME: {"type": "swarm", "args": {}}}]}
    monkeypatch.setattr(notebook, "get_cell", lambda c, cid: cell)
    with pytest.raises(HTTPException, match="the multiagent-swimlane card type has no view"):
        await cardtypes.as_view(CORPUS, "c1")


def test_the_swarm_reader_s_shares_print_every_record_once(monkeypatch, capsys, tmp_path):
    """The Swarm reader's shares are cut by size at records, so a place may run over two, and between them they print
    every record once, each line whole; --shares writes them to a folder, and --from and --count print part of one
    place. The listing begins with each file and the records it reads there, or why it reads none."""
    spec = importlib.util.spec_from_file_location("swarm_reader", SWIMLANE / "reader.py")
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    monkeypatch.chdir(SWIMLANE / "sample")
    files = [x for g in ("roster.csv", "wiki/index.jsonl", "wiki/pages/**/*.jsonl", "chat/*.jsonl") for x in ("--files", g)]
    reader.main(files)
    out = capsys.readouterr().out
    assert out.startswith("files:\n  chat/help-desk.jsonl: 8 records (2 left out, 1 repeated)\n  chat/night-ops.jsonl: 5 records\n"
                          "  roster.csv: 0 records (a roster, the goals of 12 accounts)\n"
                          "  wiki/index.jsonl: 0 records (it names 5 places)\n")
    assert out.rstrip().splitlines()[-1].startswith("32 records from 7 files, ")
    printed, cut = [], False
    for k in range(1, 5):
        reader.main([*files, "--share", f"{k}/4"])
        out = capsys.readouterr().out
        printed += re.findall(r"^(\S+#L\d+) ", out, re.M)
        cut = cut or " of " in out
    index = reader.build_index(reader._script_files(files[1::2]))
    assert sorted(printed) == sorted(index["order"]) and cut
    reader.main([*files, "--place", "Night-14/Schedule", "--from", "2", "--count", "2"])
    out = capsys.readouterr().out
    assert "records 2–3 of 4" in out and re.findall(r"^(\S+#L\d+) ", out, re.M) == index["places"]["Night-14/Schedule"]["refs"][1:3]

    reader.main([*files, "--share", "1/1"])
    whole = capsys.readouterr().out
    monkeypatch.setattr(reader, "LINE_MAX", 30)
    reader.main([*files, "--shares", str(tmp_path / "shares")])
    assert "1 share of about 200 KB, written to" in capsys.readouterr().out
    wrapped = (tmp_path / "shares" / "share-1.txt").read_text()
    assert len(wrapped.splitlines()) > len(whole.splitlines())
    assert all(len(x) <= 30 + 6 for x in wrapped.splitlines() if x.startswith(" "))
    assert re.sub(r"\s+", "", wrapped) == re.sub(r"\s+", "", whole), "no line is cut"
