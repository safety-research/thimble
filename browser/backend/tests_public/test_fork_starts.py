"""A thread's fork's start_writing and run_check (write_session.tool_start_writing, checks.tool_run_check). Claude Code
does not let a fork start subagents, so where the server runs thimble's agents (runtime.py) it starts each with the
fork's call, recorded as main's typed start is, with no call of the fork's and no event to main (tools._fork_start). The
fork is told in one line that it is filed and the agent runs. Where Claude Code runs main, the start is refused. The
module is the fake bridge (subagent_fakes); main's session is a Listener."""
from __future__ import annotations

import pytest
from conftest import Listener

from app import agents, checks, config, report_types, session, subagents, tools, write_session
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TEXT = ("# One account did it\n\n## One account\n\nAll the deletions came from one account. It ran at night.\n\n"
        "## Caveats\n\nThe log covers one week.\n")


@pytest.fixture()
def fork(workspaces_tmp, monkeypatch, bridge):
    """A side thread the analyst opened with a ⌘-click on a passage of the report, answered by the fork `fork1`, which
    main's session (a Listener) follows into the thread's chat; the orientation's, the writer's and the checks' rows of
    Settings. (thread meta, the Listener, a function that writes the caller hook's line of one of the fork's calls and
    gives its id.)"""
    rows = {"orient": {"model": "claude-opus-5-5[1m]", "effort": "max", "fast": False},
            "writer": {"model": "claude-opus-5-5", "effort": "high", "fast": False},
            "checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    meta = agents.new_thread(CORPUS, "report:report#s1", "All the deletions came from one account.", "One account",
                             surface="report")
    q = Listener(CORPUS)
    session._live[CORPUS].subs.append(session.Sub(CORPUS, meta["id"], "toolu_forked", "fork1", thread=True))
    n = [0]

    def call() -> str:
        n[0] += 1
        tid = f"toolu_fork{n[0]:04d}"
        sf.add_caller(config.workspace_dir(CORPUS), tid, "fork1", sf.FORK_TYPE)
        return tid

    yield meta, q, call
    q.close()


async def _write(doc: str = "report", text: str = TEXT) -> None:
    r = await tools.call(CORPUS, "write_document", {"doc": doc, "text": text}, actor="analyst")
    assert not r.is_error, r.text


def _started(spawn: dict) -> dict:
    """The request of a start the server made with the fork's call, as it makes main's typed one (subagents.start_job):
    a follow-on start marked typed, with no call of the fork's."""
    req = subagents.request(CORPUS, str(spawn["request"]))
    assert (req["route"], req.get("typed")) == (subagents.FOLLOW_ON, True), req
    assert not req.get("call") and not req.get("caller_agent"), "no call of the fork's claims it"
    return req


async def test_a_fork_s_start_writing_starts_the_writer_with_the_fork_s_call(fork, bridge, monkeypatch):
    """Where the server runs thimble's agents, the fork's start_writing records the writer's start (its context file
    written, the document's write pending) and the server starts the writer with the fork's call, with no event to main.
    The fork's result says in one line that it is filed and the writer runs."""
    _, q, call = fork
    res = await tools.call(CORPUS, "start_writing", {"doc": "report", "request": "Shorter, please."},
                           tool_use_id=call())
    assert not res.is_error, res.text
    title = report_types.read_type(CORPUS, "report")["name"]
    what = f"the request to write {title} (report:report)"
    assert res.text.endswith(tools.hint("agent-started-fork", what=what, agent="the writer"))
    assert "the writer is running" in res.text and "AGENT CALL" not in res.text
    [spawn] = bridge.ops("spawn")
    assert spawn["role"] == "writer" and "Shorter, please." in spawn["prompt"]
    _started(spawn)
    assert q.empty(), "main is asked for nothing"
    assert (write_session.work_dir(CORPUS, "report") / write_session.CONTEXT_FILE).is_file()
    assert report_types.write_pending(CORPUS, "report") is not None


async def test_a_fork_s_run_check_starts_each_run_with_the_fork_s_call(fork, bridge, monkeypatch):
    """Where the server runs thimble's agents, the fork's run_check turns the check on, records a run on each written
    document and starts each run's agent with the fork's call, with no event to main. The fork's result says for each
    run in one line that it is filed and the check runs."""
    _, q, call = fork
    await _write()
    report_types.create_document_type(CORPUS, "document", name="Summary", slug="summary",
                                      brief="A short summary of what the account did.")
    await _write("summary", "# Summary\n\nThe account ran at night. It deleted the posts.\n")
    res = await tools.call(CORPUS, "run_check", {"name": "Judgment"}, tool_use_id=call())
    assert not res.is_error, res.text
    check = checks.by_name(CORPUS, "Judgment")
    assert check["shown"]
    for doc in ("report", "summary"):
        what = f"a run of the check {check['name']} on report:{doc}"
        assert tools.hint("agent-started-fork", what=what, agent="the check") in res.text, doc
    assert "the check is running" in res.text and "AGENT CALL" not in res.text
    spawns = bridge.ops("spawn")
    assert [s["role"] for s in spawns] == ["check", "check"]
    got = {str(_started(s)["key"]).rsplit(":", 1)[-1] for s in spawns}
    assert got == {"report", "summary"}
    assert q.empty(), "main is asked for nothing"
    for doc in got:
        run = ((checks.read(CORPUS, check["id"]) or {}).get("runs") or {}).get(doc) or {}
        assert run.get("status") == "running" and not run.get("refused"), doc


