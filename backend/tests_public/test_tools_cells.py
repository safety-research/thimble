"""The card tools in app.tools: add_card runs its code on the kernel and reports the output, called through tools.call
as a browser chat running as the analyst."""
from __future__ import annotations

import re

import pytest

from app import cardrun, config, notebook, tools

CORPUS = "mini"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):  # no interface to shoot a card in, unless a test says
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    # this process stands in for the card runner (`thimble-run`, where card code runs in every transport, R8)
    monkeypatch.setattr(cardrun, "defers", lambda c: False)
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def group() -> str:
    """The caller's own group, made the way tools.analyst_notebook would."""
    return notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]


async def call(name: str, nb: str, anchor: str | None = None, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", notebook=nb, terminal=False, anchor=anchor)


def _cid(result) -> str:
    """The card a result names on its own line (the takeaway reminder for the card before may come first)."""
    assert not result.is_error, result.text
    hit = next((m.group(1) for line in result.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, result.text
    return hit


def _body(result) -> str:
    """A result's text, which does not echo the call (the model and the terminal have it already)."""
    assert not result.text.startswith("$ "), result.text
    return result.text


SHAPES = ("chart", "image", "table", "text", "none", "error")  # what tools._output_shape can name


def _mismatch(result, kind: str) -> bool:
    """Whether a result carries the kind-mismatch hint for its card, whatever shape it names (the hint's text comes from
    prompts/tools.md, so no test pins its wording)."""
    cid = _cid(result)
    return any(tools.hint("kind-mismatch", cid=cid, kind=kind, shape=s) in result.text for s in SHAPES)


# ----------------------------------------------------------------------------------------------------------
# add_card


async def test_add_cell_runs_code_and_reports_the_output(group):
    r = await call("add_card", group, kind="code", question="How many?", code="print(3)")
    cid = _cid(r)
    assert r.text.splitlines()[0] == f"card:{cid}", "the result names the card first and does not echo the call"
    assert "L1|3" in r.text and not _mismatch(r, "code")
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["kind"] == "code" and cell["title"] == "How many?" and cell["created_by"] == "chat" and cell["notebook"] == group
    assert cell["status"] == "ok" and cell["labels"] == []
    # a clean card with no takeaway ends its result by asking for one, and the next card starts with the reminder
    assert r.text.rstrip().endswith(tools.hint("takeaway-missing", cid=cid)) and "takeaway pending" not in r.text
    r2 = await call("add_card", group, question="And then?", code="print(4)")
    assert _body(r2).startswith(tools.hint("takeaway-reminder", cid=cid))
    # once the takeaway is written, neither line comes back for that card
    await call("edit_card", group, cell=_cid(r2), takeaway="Four.")
    r3 = await call("edit_card", group, cell=_cid(r2), code="print(5)")
    assert tools.hint("takeaway-missing", cid=_cid(r2)) in r3.text  # a new run clears the stale takeaway, so it is asked for again
    same = "import builtins\nbuiltins.runs = getattr(builtins, 'runs', 0) + 1\nprint(min(builtins.runs, 2))"
    await call("edit_card", group, cell=_cid(r2), code=same, takeaway="One run.")
    r5 = await call("edit_card", group, cell=_cid(r2), code=same)
    cell = notebook.get_cell(CORPUS, _cid(r2))
    assert cell["takeaway"] == "One run." and cell["takeaway_stale"] is True, "a run of the same code keeps its takeaway, stale"
    assert tools.hint("takeaway-stale", cid=_cid(r2)) in r5.text
    await call("edit_card", group, cell=_cid(r2), takeaway="Two runs.")
    assert "takeaway_stale" not in notebook.get_cell(CORPUS, _cid(r2))
    r4 = await call("add_card", group, question="Errors?", code="raise ValueError('x')")
    assert "takeaway-missing" not in r4.text and tools.hint("takeaway-missing", cid=_cid(r4)) not in r4.text
    # `title` is the alias of `question`; an empty question or an unknown kind is refused before anything runs
    assert not (await call("add_card", group, title="Alias?", code="print(5)")).is_error
    assert (await call("add_card", group, code="print(1)")).is_error
    assert (await call("add_card", group, kind="md", question="q", code="1")).is_error
    assert (await call("add_card", group, kind="table", question="q")).is_error


async def test_a_takeaway_keeps_the_space_before_a_word_that_starts_with_punctuation(group):
    """The tidy-up of a takeaway removes a space before punctuation that ends a word, and kept the one before a period
    that starts a word but not before a colon: ":9100" read "on:9100". Only punctuation that ends a word loses it."""
    cid = _cid(await call("add_card", group, kind="note", question="Which port?", text="One port."))
    await call("edit_card", group, cell=cid, takeaway="Both relays bind one port , :9100 , and the cache dir .quill stays ; it lives on :9100 .")
    assert notebook.get_cell(CORPUS, cid)["takeaway"] == "Both relays bind one port, :9100, and the cache dir .quill stays; it lives on :9100."


async def test_a_takeaway_keeps_the_space_before_a_relative_path(group):
    """A period followed by a slash or another period starts a path, so "loads ./warble.rb" keeps its space, inside a
    citation too, and the same in a report's plain text."""
    from app import report

    cid = _cid(await call("add_card", group, kind="note", question="What does it load?", text="One file."))
    await call("edit_card", group, cell=cid, takeaway="Plinth [[loads ./warble.rb|data.jsonl#L3]] and then ../up/x.rb .")
    assert notebook.get_cell(CORPUS, cid)["takeaway"] == "Plinth [[loads ./warble.rb|data.jsonl#L3]] and then ../up/x.rb."
    assert report.plain_text("it loads ./warble.rb , then .\\win.rb .") == "it loads ./warble.rb, then .\\win.rb."


async def test_an_agent_s_card_code_may_not_install(group, tmp_path, monkeypatch):
    """Card code runs in the kernel, where neither a prompt nor Claude Code's permission mode reaches it, so an agent's
    card that installs or downloads is refused, also where an earlier config set `installs` to "allow" (read and
    ignored); the analyst's own session is not bound by it."""
    import json

    from app import userconf

    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    code = "import subprocess\nsubprocess.run(['curl', '--version'], capture_output=True)"

    async def add(session):
        return await tools.call(CORPUS, "add_card", {"kind": "code", "question": "q", "code": code}, actor="analyst",
                                notebook=group, terminal=False, session=session)

    refused = await add("orient")
    assert refused.is_error and tools.hint("card-installs", tool="add_card") in refused.text
    assert not any(c.get("code") == code for c in notebook.load_notebook(CORPUS, group)["cells"])
    assert "card-installs" not in (await add(None)).text
    userconf.global_file().parent.mkdir(parents=True, exist_ok=True)
    userconf.global_file().write_text(json.dumps({"installs": "allow"}))
    assert tools.hint("card-installs", tool="add_card") in (await add("orient")).text


# ----------------------------------------------------------------------------------------------------------
# read_ref


async def test_read_ref_of_a_card_with_long_code_or_a_long_payload_stays_under_claude_code_s_tool_result_cap(group):
    """read_ref capped a card's outputs alone, so a card with long code (or a custom card's long html, cut only at
    40,000 characters) gave a result past what Claude Code returns to the model whole. The card now fits within
    read_parts.READ_UNITS code units: its code and its outputs share what its other lines leave, a short one whole and
    a long one cut with a line that says how many characters it leaves out, and its head, question and takeaway stay."""
    from app import read_parts

    code = "".join(f"rows_{i} = load('runs/{i}.jsonl')  # 数字\n" for i in range(3_000))  # ~114,000 characters
    printed = "".join(f"run {i:05d}: 42 posts\n" for i in range(3_000))  # 63,000 characters

    def card(outputs: str) -> str:
        cell = notebook.new_cell("code", "analyst", "How long are the runs?", code=code)
        cell.update(status="ok", exec_count=1, takeaway="Every run has 42 posts.",
                    outputs=[{"text/plain": outputs, "_stream": "stdout"}])
        return notebook.insert_cell(CORPUS, group, cell)["id"]

    def cut_at(text: str, whole: str) -> int:
        """How many of `whole`'s characters `text` shows before its truncation line, which names the rest."""
        shown, whole = text.split("\n... [truncated, ", 1)[0], whole.rstrip()
        assert whole.startswith(shown) and f"\n... [truncated, {len(whole) - len(shown)} more chars]" in text
        return len(shown)

    both = card(printed)
    text = (await call("read_ref", group, ref=f"card:{both}")).text
    assert read_parts.units(text) <= read_parts.READ_UNITS, f"{read_parts.units(text):,} code units"
    assert text.startswith(f'card:{both} (group {group}, code, status ok)\n'
                           'question: How long are the runs?\ncode:\n')
    assert text.endswith("takeaway:\nEvery run has 42 posts.")
    code_part = text.split("\ncode:\n", 1)[1].split("\noutputs, from running the code above:\n", 1)
    texts, _ = tools._outputs_text(notebook.get_cell(CORPUS, both, full_outputs=True), addressed=True)
    outputs = "\n".join(t for t in texts if t)
    assert outputs.startswith("[out0]\nL1|run 00000: 42 posts\n"), "the outputs as read_ref shows them, lines addressed"
    shown_code, shown_out = cut_at(code_part[0], code), cut_at(code_part[1], outputs)
    assert read_parts.units(code[:shown_code]) > 9_000 and shown_out > 9_000, "each gets a share"
    alone = card("42 posts\n")
    text = (await call("read_ref", group, ref=f"card:{alone}")).text
    assert read_parts.units(text) <= read_parts.READ_UNITS
    assert "\noutputs, from running the code above:\n[out0]\nL1|42 posts\n" in text
    assert cut_at(text.split("\ncode:\n", 1)[1], code) > shown_code, "the code gets what short outputs leave"
    html = "<div class='row'>" + "数据 " * 20_000 + "</div>"
    custom = notebook.insert_cell(CORPUS, group,
                                  notebook.new_cell("custom", "analyst", "The page", payload={"html": html}))
    text = (await call("read_ref", group, ref=f"card:{custom['id']}")).text
    assert read_parts.units(text) <= read_parts.READ_UNITS and cut_at(text.split("\nhtml:\n", 1)[1], html) > 20_000
