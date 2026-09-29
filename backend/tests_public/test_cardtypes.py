"""app.cardtypes and thimble.card: a viewer folder whose view.json has a `card` block is a card type. On a corpus the
Swarm viewer applies to, the registry finds it without any view proposal and lists it for main's prompt; a card's code
draws it with thimble.card, which checks the arguments against the type's schema, runs card.py on the reader's cached
index under the labels the call names, and shows the data with a listing main reads and cites; the card check's page
gets the type's frame from the request.

The corpus `crew` is 140 saves of 35 accounts on 4 pages, each naming the next account, which the Swarm viewer's
applies() reads as a swarm. Reader calls run in this process (views._runner replaced by an exec of the kernel's
snippet), and thimble.card runs in this process in a module built from kernel_thimble.py, as a kernel builds it."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import types
from pathlib import Path

import pytest

from app import cardtypes, concepts, config, render, tools, views

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
    assert text.startswith("- `swarm`: ") and '`rows` "account" or "signature"' in text and 'thimble.card("swarm"' in text


async def test_a_corpus_that_is_no_swarm_lists_no_card_type(crew):
    (crew / "saves.jsonl").write_text("".join(json.dumps({**r, "user": f"bot{i % 3}"}) + "\n" for i, r in enumerate(ROWS)))
    assert await cardtypes.refresh(CORPUS, warm=False) == {}
    assert cardtypes.prompt_text(CORPUS) == ""


async def test_a_card_draws_the_records_a_label_kept_coloured_by_another_and_lists_its_numbers(crew, kernel):
    await cardtypes.refresh(CORPUS, warm=False)
    await _label("early", r"value is [0-5]?\d\.", ["early", "later"])
    colour = await _label("even", r"value is \d*[02468]\.", ["even", "odd"])
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
    lines = bundle["text/plain"].split("\n")
    assert lines[0].startswith("swarm: 60 records by 35 accounts on 4 places; cards 1–40 shown")
    assert lines[1] == "even: even 30" and lines[2] == "no highlighted value: 30"
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
