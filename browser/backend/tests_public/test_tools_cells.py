"""The card tools in app.tools: add_card runs its code on the kernel and reports the output, called through tools.call
as a browser chat running as the analyst."""
from __future__ import annotations

import json
import re

import pytest

from app import config, notebook, tools

CORPUS = "mini"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):  # no interface to shoot a card in, unless a test says
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def group() -> str:
    """The caller's own group, which its calls name as their notebook (tools.Ctx.notebook), where its cards land when a
    call names no group (tools.default_group)."""
    return notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]


async def call(name: str, nb: str, anchor: str | None = None, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", notebook=nb, terminal=False, anchor=anchor)


def _cid(result) -> str:
    """The card a result names on its own line (the call line and the takeaway reminder for the card before come first)."""
    assert not result.is_error, result.text
    hit = next((m.group(1) for line in result.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, result.text
    return hit


def _body(result) -> str:
    """A result's text after its first line, the call as run (`$ add_card kind="note" ...`; tools.call_line)."""
    first, _, rest = result.text.partition("\n")
    assert first.startswith("$ "), result.text
    return rest


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
    assert r.text.splitlines()[0] == '$ add_card kind="code" question="How many?" code="print(3)"'
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


async def test_a_question_s_escaped_quotation_marks_are_stored_as_marks(group):
    """Live check term-fix5, new quirk 13: main wrote `\\"June\\"` inside a card's question, and the card's title showed
    the backslashes. A question keeps its quotation marks and drops the backslashes, in add_card and edit_card."""
    r = await call("add_card", group, kind="code", question='Which pages have \\"June\\" in their name?', code="print(33)")
    cid = _cid(r)
    assert notebook.get_cell(CORPUS, cid)["title"] == 'Which pages have "June" in their name?'
    await call("edit_card", group, cell=cid, question='Which pages have \\"July\\" in their name?')
    assert notebook.get_cell(CORPUS, cid)["title"] == 'Which pages have "July" in their name?'


async def test_an_example_keeps_each_quote_of_a_record_whose_ref_stays_as_given(group):
    """Three quotes of one row of a database: span_of_quote keeps the row's ref, so the three refs were the same string
    and the card showed three copies of the row from its start. Each quote is kept beside its ref, so the card can show
    the row once with every passage highlighted. A quote of a JSONL line becomes a span, which says where it is, and
    keeps no quote."""
    r = await call("add_card", group, kind="example", question="Where does the row name the style?",
                   refs=[{"ref": "forge.db#prs/7114", "quote": "Quote the style name"},
                         {"ref": "forge.db#prs/7114", "quote": "configuration example"},
                         {"ref": "forge.db#prs/7114", "quote": "merged"}])
    payload = notebook.get_cell(CORPUS, _cid(r))["payload"]
    assert payload["refs"] == ["forge.db#prs/7114"] * 3
    assert payload["quotes"] == ["Quote the style name", "configuration example", "merged"]
    assert "- forge.db#prs/7114 “configuration example”" in tools._payload_lines("example", payload), \
        "the card read back names each quote with its ref"
    r = await call("add_card", group, kind="example", question="Which post asks for thread 1?",
                   refs=[{"ref": "board.jsonl#L3", "quote": "please use thread 1"}, "board.jsonl#L1"])
    payload = notebook.get_cell(CORPUS, _cid(r))["payload"]
    assert payload["refs"][0].startswith("board.jsonl#L3.b") and payload["refs"][1] == "board.jsonl#L1"
    assert "quotes" not in payload


def _trajectory(data, trial: str, said: list[str]) -> str:
    """An agent trajectory of one trial, as `<job>/<trial>/agent/trajectory.json` holds it (ATIF): a user step, then one
    agent step per message in `said`. Returns its corpus path."""
    rel = f"picnic-runs/{trial}/agent/trajectory.json"
    steps = [{"step_id": 1, "source": "user", "message": "Plan the club picnic in Willow Park for Saturday."}]
    steps += [{"step_id": n, "source": "agent", "message": m} for n, m in enumerate(said, 2)]
    path = data / CORPUS / rel
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"schema_version": "ATIF-v1.2", "session_id": trial, "steps": steps}, indent=2))
    return rel


async def test_an_example_quotes_several_moments_of_each_trial_and_code_on_it_asks_for_its_refs(group, data_tmp):
    """An example of several passages of each of two trials' trajectories is one example card that keeps each quote by
    its line, and one passage named by its JSON pointer keeps the pointer. Code given to an example is refused with the
    field the card shows, `refs`, rather than sent to a card of code, which shows its code above what it prints."""
    said = ["The forecast says rain until noon, so the picnic could start at one instead.",
            "The shelter by the lake seats twenty, and the club has eighteen names on its list.",
            "I am done: the lake shelter is booked for one o'clock and the guest list went out."]
    trials = [_trajectory(data_tmp, t, said) for t in ("picnic-lake__RvtmQxa", "picnic-hill__GdsaPwe")]
    quotes = ["start at one instead", "The shelter by the lake seats twenty", "I am done"]
    r = await call("add_card", group, kind="example", question="Where and when did each agent plan the picnic?",
                   refs=[{"ref": t, "quote": q} for t in trials for q in quotes])
    refs = notebook.get_cell(CORPUS, _cid(r))["payload"]["refs"]
    assert len(refs) == 6 and all(ref.startswith(trials[i // 3] + "#L") for i, ref in enumerate(refs)), refs
    # one passage of one step, by its JSON pointer, keeps the pointer and the quote beside it
    r = await call("add_card", group, kind="example", question="How did the first trial end?",
                   refs=[{"ref": f"{trials[0]}#/steps/3", "quote": "I am done"}])
    assert notebook.get_cell(CORPUS, _cid(r))["payload"] == {"refs": [f"{trials[0]}#/steps/3"], "quotes": ["I am done"]}
    code = "ex = [(%r, %r)]\nfor trial, why in ex:\n    print(trial, why)" % (trials[0], said[0])
    r = await call("add_card", group, kind="example", question="Why?", code=code, refs=trials)
    assert r.is_error and "`refs`" in r.text and "card of code" not in r.text, r.text


async def test_fix_this_on_a_card_of_code_that_printed_quotes_makes_it_an_example_in_place(group, data_tmp):
    """A card of code printed two trials' quotes as a Python list, and a request to fix that card made another card:
    edit_card could not change a card of code to another kind, so no fix of that card could succeed. Given an
    example's refs, edit_card now makes the card that example where it stands, its question kept; the takeaway,
    written for the printed list, goes, and the card's history keeps the code. Code given beside the refs is refused,
    and the card stays as it was."""
    said = ["The forecast says rain until noon, so the picnic could start at one instead.",
            "The shelter by the lake seats twenty, and the club has eighteen names on its list."]
    trials = [_trajectory(data_tmp, t, said) for t in ("picnic-lake__RvtmQxa", "picnic-hill__GdsaPwe")]
    code = "quotes = [%r, %r]\nfor q in quotes:\n    print(q)" % tuple(said)
    r = await call("add_card", group, kind="code", question="What did the agents say about the weather?",
                   code=code, takeaway="Both agents moved the picnic to the afternoon.")
    cid = _cid(r)
    after = _cid(await call("add_card", group, kind="note", question="What next?", text="Book the shelter."))
    refs = [{"ref": t, "quote": "start at one instead"} for t in trials]
    r = await call("edit_card", group, card=f"card:{cid}", kind="example", refs=refs)
    assert _cid(r) == cid and tools.hint("takeaway-missing-shown", cid=cid) in r.text, r.text
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["kind"] == "example" and not notebook.runnable(cell) and "code" not in cell and "outputs" not in cell
    assert [ref.split("#")[0] for ref in cell["payload"]["refs"]] == trials, cell["payload"]
    assert cell["title"] == "What did the agents say about the weather?" and cell["takeaway"] == ""
    ws = config.workspace_dir(CORPUS)
    assert [c["id"] for c in notebook.read_notebook(ws, group)["cells"]] == [cid, after], "the card stays in its place"
    was = notebook.version_of(ws, cell, cell["edited"][-1]["id"])
    assert was["kind"] == "code" and was["code"] == code and was["status"] == "ok", was
    # code beside the refs, or a kind that runs code, is refused and leaves the card as it was; a plan's steps still
    # ask for a card of their own; a note's text alone makes a card of code that note
    sid = _cid(await call("add_card", group, kind="code", question="Steps?", code="print(1)"))
    for wrong in ({"kind": "example", "code": code, "refs": refs}, {"kind": "code", "code": code, "refs": refs},
                  {"steps": [{"text": "Read the trials"}]}):
        r = await call("edit_card", group, card=f"card:{sid}", **wrong)
        assert r.is_error and notebook.get_cell(CORPUS, sid)["code"] == "print(1)", r.text
    tid = _cid(await call("add_card", group, kind="table", question="How many trials?",
                          code="import pandas as pd\npd.DataFrame({'trials': [2]}, index=['all'])"))
    assert _cid(await call("edit_card", group, card=f"card:{tid}", text="Two trials.")) == tid
    assert notebook.get_cell(CORPUS, tid)["payload"] == {"text": "Two trials."}


async def test_an_edit_that_left_the_outputs_as_they_were_says_so_and_read_ref_says_the_code_ran(group):
    """Live QA 2: a fix turned a chart's weeks into text for its ticks, thimble.chart read the text as times again, and
    the card came out as before with nothing to say so; main then read the card and told the analyst that it had not
    run since the edit. edit_card now says when new code left all that the card shows as it was, and read_ref says
    that the outputs come from running the code it shows."""
    table = "import pandas as pd\npd.DataFrame({{'posts': [{n}]}})"
    cid = _cid(await call("add_card", group, kind="table", question="How many?", code=table.format(n="8")))
    same = tools.hint("edit_card-same-outputs", cid=cid)
    assert same in (await call("edit_card", group, cell=cid, code=table.format(n="4 + 4"))).text
    # new code with other outputs, and the same code run again with a new question, say nothing of the kind
    assert same not in (await call("edit_card", group, cell=cid, code=table.format(n="9"))).text
    assert same not in (await call("edit_card", group, cell=cid, code=table.format(n="9"), question="How many now?")).text
    read = (await call("read_ref", group, ref=f"card:{cid}")).text
    assert "[9]" in read and "from running the code above" in read and "has not run" not in read
    # nor does new code that leaves the outputs as they were in an edit that changes something else the card shows: its
    # question, its takeaway, or its kind, here to a code card, which shows its code, as is any edit of a code card's code
    assert same not in (await call("edit_card", group, cell=cid, code=table.format(n="4 + 5"), question="Posts?")).text
    assert same not in (await call("edit_card", group, cell=cid, code=table.format(n="5 + 4"), takeaway="Nine.")).text
    assert same not in (await call("edit_card", group, cell=cid, code=table.format(n="3 * 3"), kind="code")).text
    assert same not in (await call("edit_card", group, cell=cid, code=table.format(n="10 - 1"))).text
    # a card whose run goes on shows the outputs of an earlier run, or none on its first run
    shown = notebook.get_cell(CORPUS, cid)
    assert tools._outputs_lines({**shown, "status": "running"}, "9")[0] == "outputs, from an earlier run, while the code above runs now:"
    assert tools._outputs_lines({**shown, "status": "running", "outputs": []}, "") == ["outputs: none yet, since the code above runs now"]


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
    assert text.startswith(f'$ read_ref ref="card:{both}"\ncard:{both} (group {group}, code, status ok)\n'
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
