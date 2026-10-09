"""A thread's fork's start_writing and run_check (write_session.tool_start_writing, checks.tool_run_check). Claude Code
does not let a fork start subagents, so each start is recorded as main's typed start is, with no call of the fork's,
and main gets one start_agent event per start that carries the exact Agent call (tools._ask_main). The fork is told in
one line that it is filed and main is starting the agent. A fork's start_orientation is still refused at once
(tools._as_caller): one orientation runs at a time, and the analyst starts it. The module is the fake bridge
(subagent_fakes); main's session is a Listener."""
from __future__ import annotations

import json

import pytest
from conftest import Listener

from app import agents, checks, config, events, report_types, session, subagents, tools, write_session
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TEXT = ("# One account did it\n\n## One account\n\nAll the deletions came from one account. It ran at night.\n\n"
        "## Caveats\n\nThe log covers one week.\n")


@pytest.fixture()
def fork(workspaces_tmp, monkeypatch, bridge):
    """A side thread the analyst opened with a ⌘-click on a passage of the report, answered by the fork `fork1`, which
    main's session (a Listener) follows into the thread's chat; the writer's and the checks' rows of Settings. (thread
    meta, the Listener, a function that writes the caller hook's line of one of the fork's calls and gives its id.)"""
    rows = {"writer": {"model": "claude-opus-5-5", "effort": "high", "fast": False},
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


def _start_event(q: Listener) -> tuple[dict, dict]:
    """The start_agent event main got: its note, and the exact Agent call its text carries."""
    note = q.get_nowait()
    assert note["meta"]["kind"] == events.START_AGENT, note
    line = next(ln for ln in note["content"].splitlines() if ln.startswith("{"))
    return note, json.loads(line)


def _rid(inp: dict) -> str:
    return sf.REQUEST_RE.search(inp["prompt"].split("\n", 1)[0]).group(0)


def _main_claims(inp: dict, call: str) -> str | None:
    """Main's own Agent call with `inp`, as thimble's --agent-check decides it: None when it goes on."""
    with subagents.update(CORPUS) as state:
        return sf.check_call(state, {"tool_name": "Agent", "tool_use_id": call, "tool_input": inp})


def _asked_main(note: dict, inp: dict, meta: dict) -> dict:
    """The request of the start main is asked for: typed, pending on the event, claimed by main's call, not the fork's."""
    req = subagents.request(CORPUS, _rid(inp))
    assert (req["route"], req["state"], req["call"], req["via_main"], req["from_thread"]) == (
        subagents.TYPED, "pending", note["meta"]["event"], True, meta["id"])
    assert not req.get("caller_agent"), "main's Agent call claims it, not the fork's"
    assert (note["meta"]["from_thread"], note["meta"]["anchor"]) == ("One account", "report:report#s1")
    return req


async def test_a_fork_s_start_writing_records_the_writer_s_start_and_asks_main_once(fork, bridge):
    """The fork's start_writing is no longer refused with a line that sends the analyst to Write: the writer's start is
    recorded (its context file written, the document's write pending), main gets one start_agent event that names the
    document and carries the exact Agent call, and main's call from it starts the writer. The fork's result says in one
    line that it is filed and main is starting the writer."""
    meta, q, call = fork
    res = await tools.call(CORPUS, "start_writing", {"doc": "report", "request": "Shorter, please."},
                           tool_use_id=call())
    assert not res.is_error, res.text
    title = report_types.read_type(CORPUS, "report")["name"]
    what = f"the request to write {title} (report:report)"
    assert res.text.endswith(tools.hint("start_agent-fork", what=what, agent="the writer"))
    assert "main is starting the writer" in res.text
    assert tools.hint("start-refused-fork") not in res.text and "AGENT CALL" not in res.text
    assert not bridge.ops("spawn"), "main makes the call, not the module"
    note, inp = _start_event(q)
    assert q.empty(), "main is asked once"
    assert note["meta"]["filed"] == what
    assert note["terminal"] == f"start the writer for {what} (thread One account)"
    assert "start the writer for it now" in note["content"]
    assert inp["subagent_type"] == "thimble:writer" and "Shorter, please." in inp["prompt"]
    _asked_main(note, inp, meta)
    assert (write_session.work_dir(CORPUS, "report") / write_session.CONTEXT_FILE).is_file()
    assert report_types.write_pending(CORPUS, "report") is not None
    assert _main_claims(inp, "toolu_main_w") is None and subagents.request(CORPUS, _rid(inp))["state"] == "claimed"


async def test_a_fork_s_start_writing_that_cannot_reach_main_is_refused_on_its_document(fork, bridge, monkeypatch):
    """A fork's start_writing in plan mode, or with no session of main's listening, asks main for nothing and says why,
    never that it is filed; with no session listening the document's write is refused (no-call)."""
    _, q, call = fork
    monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    res = await tools.call(CORPUS, "start_writing", {"doc": "report"}, tool_use_id=call())
    assert res.is_error and tools.hint("start-plan-mode") in res.text and "Filed" not in res.text and q.empty()
    monkeypatch.setattr(session, "main_mode", lambda c: "default")
    events._subs[CORPUS].discard(q.sub)  # main's shim dropped its subscription: no event reaches main
    res = await tools.call(CORPUS, "start_writing", {"doc": "report"}, tool_use_id=call())
    assert res.is_error and "no Claude Code session is listening" in res.text and "Filed" not in res.text
    assert q.empty() and not bridge.ops("spawn") and report_types.write_pending(CORPUS, "report") is None
    [req] = [r for r in subagents.read(CORPUS)["requests"].values() if r.get("key") == "writer:report"]
    assert (req["state"], req["refused_kind"]) == ("refused", subagents.NO_CALL)


async def test_a_fork_s_run_check_records_each_run_and_asks_main_once_for_each(fork, bridge):
    """The fork's run_check is no longer refused: the check is turned on, a run is recorded on each written document,
    and main gets one start_agent event per run, each with the exact Agent call of that run's agent, which main's call
    from it starts. The fork's result says for each run in one line that it is filed and main is starting the check."""
    meta, q, call = fork
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
        assert tools.hint("start_agent-fork", what=what, agent="the check") in res.text, doc
    assert "main is starting the check" in res.text and "AGENT CALL" not in res.text
    assert not bridge.ops("spawn"), "main makes the calls, not the module"
    got = {}
    for _ in range(2):
        note, inp = _start_event(q)
        assert inp["subagent_type"] == "thimble:check" and "start the check for it now" in note["content"]
        req = _asked_main(note, inp, meta)
        got[str(req["key"]).rsplit(":", 1)[-1]] = (note, inp)
    assert q.empty(), "one event per run"
    assert set(got) == {"report", "summary"}
    assert got["report"][0]["meta"]["filed"] == f"a run of the check {check['name']} on report:report"
    for doc, (_, inp) in got.items():
        run = ((checks.read(CORPUS, check["id"]) or {}).get("runs") or {}).get(doc) or {}
        assert run.get("status") == "running" and not run.get("refused"), doc
        assert _main_claims(inp, f"toolu_main_{doc}") is None
        assert subagents.request(CORPUS, _rid(inp))["state"] == "claimed"


async def test_a_fork_s_start_orientation_is_still_refused_at_once(fork, bridge):
    """One orientation runs at a time and the analyst starts it, so a fork's start_orientation is refused at once with
    start-refused-fork: nothing is recorded and main is asked for nothing."""
    _, q, call = fork
    refused, as_session = await tools._as_caller(CORPUS, "start_orientation", call())
    assert refused == tools.hint("start-refused-fork") and as_session is None
    assert q.empty() and not subagents.read(CORPUS).get("requests") and not bridge.ops("spawn")
