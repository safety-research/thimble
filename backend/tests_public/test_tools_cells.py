"""The card tools in app.tools: add_card runs its code on the kernel and reports the output, called through tools.call
as a browser chat running as the analyst."""
from __future__ import annotations

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
    """The caller's own group, made the way tools.analyst_notebook would."""
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
