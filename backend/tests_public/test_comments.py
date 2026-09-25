"""Comments and checks from the chat (app/comments.py): main's own note beside a passage (`add_comment` from main's
shim), which no check owns and a rewrite keeps; `resolve_comment`, by a comment's id or by its passage, and `reopen`;
`stop_check`, which turns a check off as the Checks pane's switch does and stops its run. Each is called here through
tools.call as main's session would. A check's run is agent_session.start, replaced by a stand-in that records it and
ends when the test says; no model call and no kernel.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app import agent_session, agents, checks, comments, config, investigation, notebook, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN
TEXT = ("# Deletions\n\n## Who\n\nAlice deleted 27 pages [[27|card:{cid}]]. She did it in one night.\n\n"
        "Bob deleted none.\n\n## Why\n\nNobody says why.\n")


@pytest.fixture()
def cells(workspaces_tmp):
    """A printed count (27) in the analyst's group; returns its id."""
    report_types._writes.clear()
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"] += [count]
    notebook.write_notebook(ws, nb)
    yield count["id"]
    report_types._writes.clear()


@pytest.fixture()
def sessions(monkeypatch):
    """A check's run gets an agent chat and ends when the test calls its `on_end`; stop_run ends it as stopped."""
    started: list[SimpleNamespace] = []

    async def start(c, key, **kw):
        meta = agents.new_agent(c, kw["role"], kw["title"], announce=kw.get("announce", True))
        run = SimpleNamespace(c=c, key=key, chat=meta["id"], kw=kw)
        started.append(run)
        return run

    async def stop_run(run):
        run.kw["on_end"](run, "stopped", "")
        return True

    monkeypatch.setattr(agent_session, "start", start)
    monkeypatch.setattr(agent_session, "stop_run", stop_run)
    checks._active.clear()
    checks._dirty.clear()
    yield started
    for act in list(checks._active.values()):
        if act.task is not None:
            act.task.cancel()
    checks._active.clear()
    for h in checks._timers.values():
        h.cancel()
    checks._timers.clear()


async def call(tool: str, session: str | None = None, **args):
    return await tools.call(CORPUS, tool, args, actor="analyst", session=session)


def _doc() -> dict:
    return report_types.read_doc(CORPUS, MAIN, "report")


async def _write(cid: str) -> dict:
    r = await call("write_document", doc="report", text=TEXT.format(cid=cid))
    assert not r.is_error, r.text
    return _doc()


def _events(kind: str) -> list[dict]:
    return [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == kind]


async def _started(sessions: list, n: int) -> SimpleNamespace:
    for _ in range(200):
        if len(sessions) >= n:
            return sessions[n - 1]
        await asyncio.sleep(0.01)
    raise AssertionError(f"{n} runs did not start ({len(sessions)} did)")


def test_main_lists_the_comment_tools_and_a_writer_none():
    """add_comment is main's and a check's run's; resolve_comment and stop_check are main's alone."""
    main = [t["name"] for t in tools.list("analyst")]
    assert {"add_comment", "resolve_comment", "stop_check"} <= set(main)
    writer = {t["name"] for t in tools.list("analyst", session="writer:report")}
    assert not writer & {"add_comment", "resolve_comment", "stop_check"}
    check = {t["name"] for t in tools.list("analyst", session="check:unverified:report")}
    assert "add_comment" in check and not check & {"resolve_comment", "stop_check"}


async def test_main_s_note_goes_beside_its_passage_with_no_check_and_no_run(cells):
    cid = cells
    doc = await _write(cid)
    alice, bob = doc["sections"][0]["paragraphs"][:2]
    first = alice["sentences"][0]["id"]
    r = await call("add_comment", ref=f"[[report:report#p{alice['id']}]]",
                   text=f"Ep09 needs a second source; the count rests on one card [[27|card:{cid}]].")
    assert not r.is_error, r.text
    note = _doc()["comments"][-1]
    assert r.text.splitlines()[-1] == tools.hint("add_comment-added", doc="report", sid=f"p{alice['id']}", comment=note["id"])
    assert (note["author"], note["sentence_id"], note["paragraph"], note["status"]) == ("claude", first, True, "open")
    assert "check" not in note and "run" not in note, "no check owns main's note"
    assert note["text"] == "Ep09 needs a second source; the count rests on one card 27." and note["evidence"] == f"card:{cid}"
    assert not checks._active, "a note starts no check's session"
    assert _events("report")[-1]["status"] == "commented" and not checks._timers, "a note reruns no check"
    # the same note is not doubled; a sentence takes a note of its own
    await call("add_comment", ref=f"report:report#p{alice['id']}",
               text=f"Ep09 needs a second source; the count rests on one card [[27|card:{cid}]].")
    await call("add_comment", ref=f"report:report#{bob['sentences'][0]['id']}", text="Who says Bob deleted none?")
    got = [(c["sentence_id"], bool(c.get("paragraph"))) for c in _doc()["comments"]]
    assert got == [(first, True), (bob["sentences"][0]["id"], False)]
    # a ref that names no passage, or no written document, and a caller that is neither main nor a check's run
    r = await call("add_comment", ref="report:report#nope", text="x")
    assert r.is_error and tools.hint("add_comment-no-passage", ref="report:report#nope", doc="report") in r.text
    r = await call("add_comment", ref="report:story#s1", text="x")
    assert r.is_error and "report:report" in r.text and tools.hint("add_comment-no-document", ref="report:story#s1", docs="report:report") in r.text
    assert (await call("add_comment", ref=f"report:report#{first}", text="  ")).is_error
    r = await call("add_comment", session="writer:report", ref=f"report:report#{first}", text="x")
    assert r.is_error and tools.hint("add_comment-not-check") in r.text
    r = await call("add_comment", session=checks.session_key("unverified", "report"), ref=f"report:report#{first}", text="x")
    assert r.is_error and tools.hint("add_comment-not-check") in r.text, "a check's session with no run comments nothing"


async def test_a_rewrite_keeps_main_s_note_as_it_keeps_the_analyst_s(cells):
    """A check's open comment on a passage that changed is superseded, since the check reads the new text on its next
    run; main's note, like the analyst's, stays open, and a sentence whose text survives a new generation takes it."""
    cid = cells
    doc = await _write(cid)
    alice, bob = doc["sections"][0]["paragraphs"][:2]
    why = doc["sections"][1]["paragraphs"][0]
    await call("add_comment", ref=f"report:report#p{bob['id']}", text="Bob's count has no source.")
    await call("add_comment", ref=f"report:report#{why['sentences'][0]['id']}", text="Ask the moderators.")
    d = _doc()
    d["comments"].append({"id": "c9", "sentence_id": bob["sentences"][0]["id"], "text": "no card", "author": "check",
                          "check": "unverified", "status": "open"})
    report_types.write_doc(CORPUS, MAIN, "report", d)
    await report_types.replace_passage(CORPUS, "report", bob["id"], "Bob deleted two pages.", {"by": "edit", "actor": "t"})
    got = {c["text"]: c["status"] for c in _doc()["comments"]}
    assert got == {"Bob's count has no source.": "open", "Ask the moderators.": "open", "no card": "dismissed"}
    # a new generation that keeps "Nobody says why." carries the note onto the new sentence of that text
    r = await call("write_document", doc="report", text=TEXT.format(cid=cid).replace("Bob deleted none.", "Bob deleted two."))
    assert not r.is_error, r.text
    new_why = next(x for x in report_types.all_sentences(_doc()) if x["text"] == "Nobody says why.")
    note = next(c for c in _doc()["comments"] if c["text"] == "Ask the moderators.")
    assert note["status"] == "open" and note["sentence_id"] == new_why["id"]
    assert note in report_types.anchored_open_comments(_doc())


async def test_resolve_comment_by_its_id_or_its_passage_and_reopen(cells):
    cid = cells
    doc = await _write(cid)
    alice, bob = doc["sections"][0]["paragraphs"][:2]
    r = await call("add_comment", ref=f"report:report#p{alice['id']}", text="Ep09 needs a second source.")
    note = _doc()["comments"][-1]
    assert note["id"] in r.text
    r = await call("resolve_comment", comment=note["id"])
    assert not r.is_error and r.text.splitlines()[-1] == tools.hint(
        "resolve_comment-done", action="resolved", comment=note["id"], ref=f"report:report#p{alice['id']}", who="claude",
        text="Ep09 needs a second source.")
    stored = _doc()["comments"][-1]
    assert (stored["status"], stored["resolved_by"]) == ("dismissed", "claude")
    assert _events("report")[-1]["status"] == "commented"
    assert (await call("resolve_comment", comment=note["id"])).is_error, "it is resolved already"
    r = await call("resolve_comment", comment=f"report:report#{note['id']}", reopen=True)
    assert not r.is_error and r.text.splitlines()[-1].startswith(f"reopened comment {note['id']}")
    assert _doc()["comments"][-1]["status"] == "open" and "resolved_by" not in _doc()["comments"][-1]
    # a passage's ref resolves every open comment on it, the analyst's and a check's among them
    d = _doc()
    s_bob = bob["sentences"][0]["id"]
    d["comments"] += [{"id": "c1", "sentence_id": s_bob, "text": "mine", "author": "analyst", "status": "open"},
                      {"id": "c2", "sentence_id": s_bob, "text": "no card", "author": "check", "check": "unverified",
                       "status": "open"}]
    report_types.write_doc(CORPUS, MAIN, "report", d)
    r = await call("resolve_comment", comment=f"report:report#p{bob['id']}")
    assert not r.is_error and len(r.text.splitlines()) == 3 and "· Unverified ·" in r.text and "· analyst ·" in r.text
    assert {c["id"]: c["status"] for c in _doc()["comments"]} == {note["id"]: "open", "c1": "dismissed", "c2": "dismissed"}
    r = await call("resolve_comment", comment="deadbeef")
    assert r.is_error and tools.hint("resolve_comment-none", comment="deadbeef", state="open") in r.text
    assert (await call("resolve_comment", comment="report:story#x")).is_error


async def test_stop_check_turns_the_check_off_and_stops_its_run(cells, sessions):
    cid = cells
    await _write(cid)
    r = await call("run_check", name="Unverified")
    assert not r.is_error, r.text
    run = await _started(sessions, 1)
    assert checks.read(CORPUS, "unverified")["shown"] is True and checks.running(CORPUS, "unverified", "report")
    r = await call("stop_check", name="unverified")
    assert not r.is_error and r.text.splitlines()[-1] == tools.hint("stop_check-stopped", check="Unverified", docs="report:report")
    check = checks.read(CORPUS, "unverified")
    assert check["shown"] is False and check["runs"]["report"]["status"] == "stopped" and not checks._active
    assert run.kw["on_end"], "its session was stopped"
    off = [e for e in _events("check") if e.get("status") == comments.OFF]
    assert off and (off[-1]["id"], off[-1]["doc"]) == ("unverified", ""), "the open tabs read the checks again"
    r = await call("stop_check", name="Unverified")
    assert not r.is_error and tools.hint("stop_check-off", check="Unverified") in r.text
    r = await call("stop_check", name="Nope")
    assert r.is_error and "Unverified" in r.text and tools.hint("stop_check-none", check="Nope", names="Unverified, Verified, Judgment calls") in r.text
