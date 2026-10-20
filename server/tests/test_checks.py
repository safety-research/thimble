"""Report checks (checks.py): a run comments beside the passages it covers, the comments follow their passages, and a
run covers only what changed; a fake stands in for the Messages API."""
import asyncio
import json

import pytest

from thimble_browser import agent, checks, chats, home, llm, report, tools
from thimble_browser.app import build

from fakes import ScriptedClient, system_of, turns

REPORT = """# Most runs were merged

## The data is 24 runs

There are 24 runs [↗](results.csv). Each run is one task.

## Two runs failed

Run b failed because its test was flaky. It was never retried.
"""


@pytest.fixture(autouse=True)
def features(home):
    build(21997)


@pytest.fixture
def ws(folder):
    w = home.open_folder(folder)
    report.save(w, REPORT, by="chat:w1")
    return w


def check_script(comments):
    """A check's agent that leaves `comments` (a list of add_comment inputs) in its first reply, then ends."""
    def script(req):
        sys = system_of(req)
        if sys.startswith("# Check"):
            if turns(req) == 0 and comments:
                return [{"tool": "add_comment", "input": c} for c in comments]
            return [f"Commented on {len(comments)} passages of the report."]
        return ["(other agent)"]
    return script


async def idle(sessions, ws):
    for _ in range(300):
        await asyncio.sleep(0.01)
        if not sessions.running(ws):
            return
    raise AssertionError("still running")


async def test_a_run_comments_beside_its_passages_and_dismiss_resolves(ws, monkeypatch):
    fake = ScriptedClient(check_script([
        {"ref": "report:report#t2.0.1", "text": "No [record](runs/a.jsonl#L2) shows a retry was tried.",
         "details": "The run's log ends at [↗](runs/a.jsonl#L2)."},
        {"ref": "report:report#p1.0", "text": "The paragraph counts runs that results.csv does not hold."},
    ]))
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    rec = await checks.start_run(ws, sessions, "important-details")
    assert rec["covered"] == ["report:report#p1.0", "report:report#p2.0"]
    task = agent.load_messages(ws, rec["chat"])[0]["content"]
    assert "[t2.0.1] It was never retried." in task and "Comment on a passage only when" in task
    await idle(sessions, ws)
    doc = report.writeup(ws)
    got = {c["sentence_id"]: c for c in doc["comments"]}
    assert set(got) == {"t2.0.1", "t1.0.0"} and got["t1.0.0"]["paragraph"]
    assert got["t2.0.1"]["text"] == "No record shows a retry was tried." and "runs/a.jsonl#L2" in got["t2.0.1"]["evidence"]
    assert got["t2.0.1"]["check"] == "important-details" and got["t2.0.1"]["author"] == "check"
    check = checks.read(ws, "important-details")
    assert check["runs"]["report"]["status"] == "done" and check["runs"]["report"]["comments"] == 2
    assert chats.meta(ws, rec["chat"])["role"] == "check"
    # every passage is seen as it stands, so a second run covers nothing
    assert await checks.start_run(ws, sessions, "important-details") is None
    checks.resolve(ws, got["t1.0.0"]["id"])
    assert [c["sentence_id"] for c in report.writeup(ws)["comments"]] == ["t2.0.1"]


async def test_comments_follow_their_passage_and_a_run_covers_what_changed(ws, monkeypatch):
    fake = ScriptedClient(check_script([{"ref": "report:report#t2.0.1", "text": "No retry is shown."}]))
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    await checks.start_run(ws, sessions, "important-details")
    await idle(sessions, ws)
    # a new paragraph before it moves the sentence's id: the comment follows its words
    report.save(ws, REPORT.replace("## Two runs failed\n", "## Two runs failed\n\nA new first paragraph.\n"),
                by="analyst")
    [c] = report.writeup(ws)["comments"]
    assert c["sentence_id"] == "t2.1.1"
    assert checks.by_name(ws, "Important details")["runs"]["report"]["stale"] == 1
    rec = await checks.start_run(ws, sessions, "important-details")
    assert rec["covered"] == ["report:report#p2.0"]
    await idle(sessions, ws)
    # a sentence whose words changed loses its comment
    report.save(ws, REPORT.replace("It was never retried.", "It was retried once."), by="analyst")
    assert report.writeup(ws)["comments"] == []


async def test_a_comment_outside_the_run_s_passages_is_refused(ws, monkeypatch):
    sessions = agent.Sessions()
    fake = ScriptedClient(check_script([{"ref": "report:report#t1.0.0", "text": "Something."},
                                        {"ref": "report:report#t9.9.9", "text": "Nowhere."}]))
    monkeypatch.setattr(llm, "client", lambda: fake)
    rec = await checks.start_run(ws, sessions, "judgment", wanted=["report:report#t2.0.0"])
    assert rec["covered"] == ["report:report#p2.0"]
    await idle(sessions, ws)
    results = [b for m in agent.load_messages(ws, rec["chat"]) if m["role"] == "user" and isinstance(m["content"], list)
               for b in m["content"]]
    assert all(b.get("is_error") for b in results)
    assert report.writeup(ws)["comments"] == []


async def test_the_writer_s_save_runs_the_checks_that_are_on(ws, monkeypatch):
    def script(req):
        sys = system_of(req)
        if sys.startswith("# Writer"):
            return ["Wrote the report."]
        return ["Commented on 0 passages."]
    fake = ScriptedClient(script)
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    await sessions.start_agent(ws, "writer", "Report writer", "Write the report.", prefix="w")
    await idle(sessions, ws)
    await asyncio.sleep(0.05)
    await idle(sessions, ws)
    runs = {c["id"]: (c.get("runs") or {}).get("report") for c in checks.list_checks(ws)}
    assert runs["important-details"]["status"] == "done" and runs["judgment"] is None
    checks.set_auto(False)
    report.save(ws, REPORT + "\nOne more paragraph.\n", by="chat:w1")
    await sessions.start_agent(ws, "writer", "Report writer", "Write the report.", prefix="w")
    await idle(sessions, ws)
    await asyncio.sleep(0.05)
    assert checks.by_name(ws, "important-details")["runs"]["report"]["stale"] == 1


async def test_main_runs_a_new_check_and_turns_it_off(ws, folder, monkeypatch):
    fake = ScriptedClient(check_script([]))
    monkeypatch.setattr(llm, "client", lambda: fake)
    sessions = agent.Sessions()
    t = sessions.get(ws, "main").tools
    r = await t.call("run_check", {"name": "Flaky", "instructions": "Mark each sentence about flaky tests."})
    assert not r.is_error and "runs on 2 passages" in r.text
    check = checks.by_name(ws, "Flaky")
    assert check["shown"] and not check["builtin"] and check["colour"] == 3
    await idle(sessions, ws)
    r = await t.call("stop_check", {"name": "flaky"})
    assert not r.is_error and not checks.read(ws, check["id"])["shown"]
    r = await t.call("run_check", {"name": "Nothing like it"})
    assert r.is_error
