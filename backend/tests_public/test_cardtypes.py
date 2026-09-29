"""app.cardtypes and thimble.card: a viewer folder whose view.json has a `card` block is a card type. On a corpus the
Swarm viewer applies to, the registry finds it without any view proposal and lists it for main's prompt; a card's code
draws it with thimble.card, which checks the arguments against the type's schema, runs card.py on the reader's cached
index under the labels the call names, whatever Files highlights, and shows the data with a listing main reads and
cites; the card check's page gets the type's frame from the request. Keep writes a patch of the arguments the type lets
the card change into the card's one thimble.card call. Main hears when a label it ran finishes, and can colour a label's
values.

The corpus `crew` is 140 saves of 35 accounts on 4 pages, each naming the next account, which the Swarm viewer's
applies() reads as a swarm. Reader calls run in this process (views._runner replaced by an exec of the kernel's
snippet), and thimble.card runs in this process in a module built from kernel_thimble.py, as a kernel builds it."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import sys
import types
from pathlib import Path

import pytest

from fastapi import HTTPException

from app import card_check, cardtypes, channel, concepts, config, render, tools, views

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
    return d.resolve()


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


async def test_the_swarm_type_is_found_without_a_proposal_and_listed_for_main(crew):
    types_ = await cardtypes.refresh(CORPUS, warm=False)
    assert list(types_) == ["swarm"] and views.read_view(CORPUS, "swarm") is None
    t = types_["swarm"]
    assert t["claims"] == ["saves.jsonl"] and t["paths"] == ["saves.jsonl"] and Path(t["card"]).is_file()
    assert Path(t["reader"]).is_relative_to(config.workspace_dir(CORPUS)), "a card's kernel sees only the workspace"
    assert cardtypes.read_registry(CORPUS)["swarm"]["fp"] == t["fp"]
    text = cardtypes.prompt_text(CORPUS)
    assert text.startswith("### Card types") and "\n- `swarm`: " in text
    assert '`rows` "account" or "signature"' in text and 'thimble.card("swarm"' in text


async def test_a_corpus_that_is_no_swarm_lists_no_card_type(crew):
    (crew / "saves.jsonl").write_text("".join(json.dumps({**r, "user": f"bot{i % 3}"}) + "\n" for i, r in enumerate(ROWS)))
    assert await cardtypes.refresh(CORPUS, warm=False) == {}
    assert cardtypes.prompt_text(CORPUS) == ""


async def test_a_card_draws_the_records_a_label_kept_coloured_by_another_and_lists_its_numbers(crew, kernel):
    await cardtypes.refresh(CORPUS, warm=False)
    await _label("early", r"value is [0-5]?\d\.", ["early", "later"])
    colour = await _label("even", r"value is \d*[02468]\.", ["even", "odd"])
    concepts.show_concept(CORPUS, "even", True, ["odd"])  # Files highlights only "odd", which the card does not follow
    kernel._LABELS_READ.clear()
    kernel.card("swarm", labels=["even"], within={"label": "early"}, links=["reply", "names"])
    bundle = kernel.shown[-1]
    made = bundle[cardtypes.CARD_MIME]
    data = made["data"]
    assert made["type"] == "swarm" and made["labels"] == [{"id": colour, "name": "even"}]
    assert made["args"]["rows"] == "account", "a default the schema gives is filled in"
    assert data["source"] == "chosen" and data["total"] == 60, "the records `within` kept, whatever `labels` mark"
    assert data["mark_counts"] == [30] and data["unmarked"] == 30
    assert {x["type"] for x in data["links"]} <= {"reply", "names"} and data["links"]
    assert len(data["cards"]) == 40 and data["shown"] == "linked"
    assert sum(c["m"] == 0 for c in data["cards"]) == 20, "the records shown are in proportion to each value's records"
    linked = {c["id"] for x in data["links"] for c in data["cards"] if c["id"] in (x["from"], x["to"])}
    assert len(linked) >= 30, "and the most linked to each other"
    lines = bundle["text/plain"].split("\n")
    assert lines[0] == f"swarm: 60 records by 35 accounts on 4 places; 40 shown with {len(data['links'])} links among them"
    assert lines[1] == "the 40 shown: in proportion to each value's records, the most linked first"
    assert lines[2] == "even: even 30" and lines[3] == "no highlighted value: 30"
    assert lines[4] == f"links among all 60 records: names {data['reach']['counts']['names']}", "counted over every record"
    assert lines[-1].endswith(data["cards"][-1]["ref"]), "a card's line ends in its record's ref"
    assert {x["id"] for x in kernel._LABELS_READ} >= {colour}, "the card goes stale when its label changes"

    cell = {"id": "c1", "kind": "plot", "status": "ok", "outputs": [bundle]}
    texts, extras = tools._outputs_text(cell, addressed=True)
    assert "chart" in extras and tools._output_shape(cell) == "chart"
    assert texts[0].split("\n")[1] == "L1|" + lines[0], "main cites the listing as card:<id>@out0#L<n>"


async def test_a_wrong_argument_names_what_the_type_takes(crew, kernel):
    await cardtypes.refresh(CORPUS, warm=False)
    with pytest.raises(ValueError, match=r"`rows` is one of 'account', 'signature', not 'accounts'"):
        kernel.card("swarm", rows="accounts")
    with pytest.raises(ValueError, match=r"has no `colour`; the keys are within, rows"):
        kernel.card("swarm", colour="red")
    with pytest.raises(ValueError, match=r"no card type 'graph'; the types here are 'swarm'"):
        kernel.card("graph")
    assert not kernel.shown


async def test_the_check_s_page_gets_the_type_s_frame_from_the_request(crew, kernel):
    await cardtypes.refresh(CORPUS, warm=False)
    kernel.card("swarm")
    cell = {"id": "c1", "kind": "plot", "status": "ok", "title": "Who names whom?", "outputs": [kernel.shown[-1]]}
    req = render.request_for(CORPUS, cell)
    doc = req["frames"]["swarm"]
    assert "connect-src 'none'" in doc and '"card": true' in doc and 'id="chart"' in doc
    assert "frames" not in render.request_for(CORPUS, {"id": "c2", "kind": "plot", "outputs": []})


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


async def test_keep_changes_only_the_arguments_the_type_lets_the_card_change(crew, kernel):
    await cardtypes.refresh(CORPUS, warm=False)
    code = 'import thimble\nthimble.card("swarm", links=["names"])'
    kernel.card("swarm", links=["names"])
    cell = {"id": "c1", "kind": "plot", "code": code, "outputs": [kernel.shown[-1]]}
    new, patch, written = cardtypes.keep_patch(CORPUS, cell, {"rows": "signature"})
    assert new == 'import thimble\nthimble.card("swarm", links=["names"], rows="signature")' and patch == {"rows": "signature"}
    assert written == []
    with pytest.raises(HTTPException, match="Keep does not change `within`"):
        cardtypes.keep_patch(CORPUS, cell, {"within": {"label": "early"}})
    with pytest.raises(HTTPException, match="`rows` is one of 'account', 'signature'"):
        cardtypes.keep_patch(CORPUS, cell, {"rows": "sideways"})


async def test_the_card_check_gives_back_the_arguments_keep_set(crew, kernel):
    await cardtypes.refresh(CORPUS, warm=False)
    kernel.card("swarm", rows="signature")
    kept = 'import thimble\nthimble.card("swarm", rows="signature", links=["names"])'
    cell = {"id": "c1", "kind": "plot", "code": kept, "outputs": [kernel.shown[-1]], "kept_args": {"rows": "signature"}}
    revised = 'import thimble\nthimble.card("swarm", links=["names", "reply"])'
    assert cardtypes.keep_kept(CORPUS, cell, revised) == 'import thimble\nthimble.card("swarm", links=["names", "reply"], rows="signature")'
    reverted = {"question": "", "takeaway": "", "code": 'import thimble\nthimble.card("swarm", links=["names"])'}
    assert card_check._patch(cell, reverted, None, c=CORPUS) == {}, "a revision that only undoes Keep changes nothing"
    undone = {**cell, "code": 'import thimble\nthimble.card("swarm", links=["names"])'}
    assert cardtypes.kept_in_force(CORPUS, undone) == {} and cardtypes.keep_kept(CORPUS, undone, revised) == revised, (
        "once an undo took Keep's arguments out of the code, they bind nothing")


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
    concepts.show_concept(CORPUS, "even", None, colours={"odd": "red", "even": "blue"})
    after = {cl["name"]: cl["color"] for cl in concepts.read_concept(config.workspace_dir(CORPUS), cid)["classes"]}
    assert after == {"even": 1, "odd": 12}
    concepts.show_concept(CORPUS, "even", None, colours={"odd": "blue"})
    swapped = {cl["name"]: cl["color"] for cl in concepts.read_concept(config.workspace_dir(CORPUS), cid)["classes"]}
    assert swapped == {"even": 12, "odd": 1}, "the value that had the colour takes the one the other left"
    with pytest.raises(HTTPException, match="no label colour is named 'teal'"):
        concepts.show_concept(CORPUS, "even", None, colours={"odd": "teal"})
