"""thimble fix in the browser (app/fixes.py): /thimble-fix starts a fork of main's conversation on a copy the kernel
makes, in the person's words as they typed them, never main's; the kernel checks what it changed, and a fix that passes
is ready: a notice asks the person, and only their click (Use it now) puts it on, with the secret of that click, and
starts the server again from live. A fix that did not pass says what it tried. The kernel is a stand-in that keeps its records in memory (the kernel's own tests are plugin/tests/test_fixes.py), and the
Messages API the fake client of test_runtime: no model is called and nothing restarts."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from test_runtime import CORPUS, api_key, call, main_turn, on, text  # noqa: F401 — `on` is a fixture

from app import agents, config, dev, events, fixes, tools

PAGE = 'The card open in focus (card:c1), "Incidents by week":\nweek  incidents\n1  4\n2  7'


class Kernel:
    """`thimble fix VERB` in memory: new makes the copy's folder, done answers `ends` (ready by default)."""

    def __init__(self, home: Path, ends: str = "ready", error: str = "") -> None:
        self.home, self.ends, self.error = home, ends, error
        self.recs: dict[int, dict[str, Any]] = {}
        self.calls: list[tuple[str, ...]] = []
        self.envs: list[dict[str, str]] = []

    def __call__(self, args: list[str], *, stdin: str | None = None, timeout: float = 0, env: dict | None = None):
        self.calls.append(tuple(args))
        self.envs.append(dict(env or {}))
        verb = args[0]
        if verb == "new":
            fid = len(self.recs) + 1
            work = self.home / "fixes" / "work" / str(fid)
            (work / "browser").mkdir(parents=True)
            title = args[args.index("--title") + 1] if "--title" in args else (stdin or "")[:40]
            self.recs[fid] = {"id": fid, "title": title, "words": [stdin], "state": "working", "work": str(work),
                              "base": "HEAD", "made_in": args[args.index("--made-in") + 1], "updated": 1.0}
            return fixes.Ran(True, json.dumps(self.recs[fid]), "")
        if verb == "list":
            return fixes.Ran(True, json.dumps({"fixes": list(self.recs.values())}), "")
        rec = self.recs[int(args[1])]
        if verb == "done":
            if "--title" in args:
                rec["title"] = args[args.index("--title") + 1]
            rec.update(state=self.ends, tests="passed" if self.ends == "ready" else "failed", error=self.error or None,
                       summary="The card's title now ends with its row count.", files=[{"path": "a"}, {"path": "b"}])
        elif verb == "apply":
            assert stdin and len(stdin) == 64  # the secret of the click, on stdin
            ask = self.home / "fixes" / "asks" / f"{rec['id']}.json"
            assert json.loads(ask.read_text())["key"] == fixes.hashlib.sha256(stdin.encode()).hexdigest()
            ask.unlink()
            if rec["state"] not in ("ready", "off"):
                return fixes.Ran(False, "", f"fix {rec['id']} is {rec['state']}, so there is nothing to apply")
            rec["state"] = "on"
        elif verb == "round":
            if rec["state"] in ("on", "off", "ready"):  # changed in place: the version the person has stays (prev)
                rec["prev"] = {"state": rec["state"]}
            rec.update(state="working", words=[*rec["words"], stdin], rounds=int(rec.get("rounds") or 1) + 1)
        elif verb == "undo":
            rec["state"] = "off"
        elif verb == "redo":  # in its copy while that holds work no check took (a test's `unchecked`), else a new copy
            work = self.home / "fixes" / "work" / str(rec["id"])
            (work / "browser").mkdir(parents=True, exist_ok=True)
            same = bool(rec.pop("unchecked", False)) and rec["state"] == "failed"
            rec.update(state="working", words=[*rec["words"], ""], error=None, work=str(work))
            patch = str(self.home / "fixes" / "tmp" / str(rec["id"]) / "earlier.patch")
            said = {"same_copy": True} if same else {"earlier": patch} if rec.get("commit") else {}
            return fixes.Ran(True, json.dumps({**rec, **said}), "")
        elif verb == "diff":
            return fixes.Ran(True, str(rec.get("diff") or ""), "")
        return fixes.Ran(True, json.dumps(rec), "")


@pytest.fixture()
def fixing(on, monkeypatch, tmp_path):
    """Fixes on, the kernel a stand-in, the page built, and the restart recorded instead of made."""
    monkeypatch.setenv("THIMBLE_FIXES", "on")
    k = Kernel(fixes.plugin_home())
    monkeypatch.setattr(fixes, "kernel", k)
    monkeypatch.setattr(fixes, "srt_ready", lambda: "")
    monkeypatch.setattr(fixes, "prepare", lambda root: "")
    monkeypatch.setattr(fixes, "changed", lambda work, base: ["browser/frontend/src/canvas/Focus.tsx"])
    restarts: list[tuple[str, Path | None]] = []

    async def restart(title: str, *, ticket_id: str | None = None, cwd: Path | None = None) -> None:
        restarts.append((title, cwd))

    monkeypatch.setattr(dev, "supervised", lambda: True)
    monkeypatch.setattr(dev, "_do_restart", restart)
    fixes._phase.clear()
    fixes._fixers.clear()
    fixes._asked.clear()
    fixes._waiting.clear()
    k.restarts = restarts  # type: ignore[attr-defined]
    yield k
    fixes._phase.clear()
    fixes._fixers.clear()
    fixes._asked.clear()
    fixes._waiting.clear()


WAIT_S = 60.0  # the most a test waits for the event it waits on, which a busy machine delays but never skips


async def _until(cond: Any, what: str) -> None:
    """Waits until cond() holds: an apply or an undo runs the kernel in a thread and starts the server again a moment
    later (fixes.restart, call_later), which a busy machine stretches past any fixed sleep. Fails with `what` after
    WAIT_S."""
    end = time.monotonic() + WAIT_S
    while not cond():
        assert time.monotonic() < end, f"{what} (waited {WAIT_S:g} s)"
        await asyncio.sleep(0.02)


async def _ended(fid: int = 1) -> None:
    """Fix `fid`'s fixer ended, and so did the kernel's checks after it (fixes.settle, which runs in the fixer's task):
    no fixer of it runs and its phase is neither fixing nor testing."""
    end = time.monotonic() + WAIT_S
    while True:
        conv = fixes._fixers.get(fid)
        if conv is not None and conv.task is not None and not conv.task.done():
            await asyncio.wait_for(asyncio.shield(conv.task), max(0.0, end - time.monotonic()))
            continue
        if fixes._phase.get(fid) not in ("fixing", "testing"):
            return
        assert time.monotonic() < end, f"fix {fid}'s fixer did not end within {WAIT_S:g} s"
        await asyncio.sleep(0.02)


async def _went_on(fid: int = 1) -> None:
    """What a click on Use it started (fixes.apply's task): the page's build, then the undo or the restart's call."""
    for task in [t for t in asyncio.all_tasks() if t.get_name() == f"fix-apply:{fid}"]:
        await asyncio.wait_for(task, WAIT_S)


async def _restarted(fixing: Any, after: str, n: int = 1) -> None:
    """The n-th restart was called (fixes.restart calls dev._do_restart a moment after it returns)."""
    await _until(lambda: len(fixing.restarts) >= n, f"the server never started again after {after}")


def _log(c: str, chat: str = "main") -> list[dict[str, Any]]:
    return agents.read_events(agents.paths(c, chat)[1])


def _fixer_chats(c: str) -> list[dict[str, Any]]:
    return [m for m in agents.list_chats(c) if m.get("role") == fixes.FIXER]


async def _mirrored(c: str, chat: str, kind: str = "tool_use") -> list[dict[str, Any]]:
    """The fixer chat's records once the mirror wrote one of `kind`."""
    end = time.monotonic() + WAIT_S
    while time.monotonic() < end:
        got = _log(c, chat)
        if any(r.get("type") == kind for r in got):
            return got
        await asyncio.sleep(0.05)
    return _log(c, chat)


def test_the_words_after_the_command():
    assert fixes.words_of("/thimble-fix make this card say rows") == "make this card say rows"
    assert fixes.words_of("  /thimble-fix\n two lines\nhere ") == "two lines\nhere"
    assert fixes.words_of("/thimble-fix") == ""
    assert fixes.words_of("/thimble-fixes now") is None
    assert fixes.words_of("please /thimble-fix it") is None


def test_the_tests_follow_what_the_change_touched():
    page = fixes.tests_for(["browser/frontend/src/chat/Rows.tsx"])
    assert "tsc -b" in page and "vitest run --changed HEAD~1" in page and "pytest" not in page
    server = fixes.tests_for(["browser/backend/app/tools.py"])
    assert "tests_public" in server and "vitest" not in server
    assert "pytest plugin" in fixes.tests_for(["plugin/core/answers.ts"])
    assert fixes.tests_for(["docs/notes.md"]) == "true"


async def test_a_fix_is_a_fork_of_main_on_its_copy_and_asks_the_person_when_its_checks_pass(fixing, monkeypatch, analyst):
    work = fixing.home / "fixes" / "work" / "1"
    client = api_key(monkeypatch, [
        text("Week 2 had the most incidents."),
        call("Write", {"file_path": str(work / "browser" / "note.txt"), "content": "rows\n"}),
        text("Title: Card says how many rows\nWhat it does: The card's title now ends with its row count."),
    ])
    await main_turn("Which week had the most incidents?")
    got = await fixes.request(CORPUS, "make this card's title say how many rows it shows", PAGE)
    assert got["fix"]["id"] == 1
    assert fixes.status()["fixes"][0]["phase"] == "fixing"
    await _ended()

    # the fixer has the chat so far, then the registry's fixer text, the person's words and the page
    body = client.bodies[1]
    said = json.dumps(body["messages"])
    assert "Which week had the most incidents?" in said and "Week 2 had the most incidents." in said
    first = body["messages"][-1]["content"]
    assert (fixes.plugin_dir() / "prompts" / "fixer.md").read_text().strip()[:80] in first
    assert "make this card's title say how many rows it shows" in first
    assert "Incidents by week" in first and str(work) in first
    assert {"Edit", "Write", "Read"} <= {t["name"] for t in body["tools"] if "name" in t}
    # it wrote its copy, and nothing else
    assert (work / "browser" / "note.txt").read_text() == "rows\n"

    # the kernel's checks, with the tests of what the change touched; the fix is ready and nothing goes on by itself
    verbs = [c[0] for c in fixing.calls]
    assert verbs[:1] == ["new"] and "done" in verbs and "apply" not in verbs and fixing.restarts == []
    done = fixing.calls[verbs.index("done")]
    assert done[done.index("--title") + 1] == "Card says how many rows"
    assert "vitest" in fixing.envs[verbs.index("done")]["THIMBLE_FIX_TESTS"]
    assert not (fixes.fixes_home() / "asks" / "1.json").exists()
    row = fixes.status()["fixes"][0]
    assert (row["kind"], row["said"], row["state"], row["phase"]) == (
        "ready", "thimble fixed: Card says how many rows · tests pass", "ready", None)
    # What changed: the person's words, what Claude did, how many files
    assert row["words"] == "make this card's title say how many rows it shows"
    assert row["summary"] == "The card's title now ends with its row count." and row["files"] == 2

    # Use it now: the click's secret to the kernel's apply, then the server starts again from live
    assert (await fixes.apply_route(1, analyst))["restart"] is True
    await _went_on()
    await _restarted(fixing, "Use it now")
    assert [c[0] for c in fixing.calls].count("apply") == 1
    assert fixing.restarts == [("fix 1: Card says how many rows", config.REPO_ROOT / "backend")]
    assert fixes.status()["fixes"][0]["phase"] == "restarting"
    fixes._phase.clear()  # the server that starts again knows of no phase: the notice is gone once the fix is on
    assert fixes.status()["fixes"] == []
    assert fixes.status(every=True)["fixes"][0]["state"] == "on"  # Your fixes still lists it, with Undo
    # how it ended, then that it is on: rows of main's chat and of the fix's thread, in the order they happened
    rows = [("ready", "thimble fixed: Card says how many rows · tests pass"), ("fixed", "“Card says how many rows” is on")]
    [chat] = _fixer_chats(CORPUS)
    for log in (_log(CORPUS), _log(CORPUS, chat["id"])):
        assert [(r["status"], r["text"]) for r in log if r.get("type") == "chip" and r.get("kind") == "fix"] == rows
        assert {r["ref"] for r in log if r.get("kind") == "fix"} == {"fix:1"}


def scripted(main: list[Any], fixer: list[Any]) -> list[Any]:
    """Replies for main and for the fixers, each from its own list, whichever asks first: a fixer's request is the one
    whose conversation holds the fixer's first message."""
    main, fixer = list(main), list(fixer)

    def reply(body: dict[str, Any]) -> Any:
        mine = fixer if "The person asked for this change to their thimble" in json.dumps(body["messages"]) else main
        item = mine.pop(0) if mine else text("(no more)")
        return item(body) if callable(item) else item

    return [reply] * (len(main) + len(fixer))


async def _main_done() -> None:
    """Main's turns on what was posted to it, to their end."""
    from app import runtime

    for _ in range(100):
        task = runtime._spaces[CORPUS].main.task
        if task is not None and not task.done():
            await task
            continue
        await asyncio.sleep(0.05)
        task = runtime._spaces[CORPUS].main.task
        if task is None or task.done():
            return


def _asked(client: Any, i: int = -1) -> str:
    """What main read of the person's /thimble-fix: the user message of main's request `i`."""
    msgs = [json.dumps(b["messages"]) for b in client.bodies]
    return [m for m in msgs if "The person asks for a change to thimble itself" in m
            and "The person asked for this change to their thimble" not in m][i]


async def test_a_fix_runs_in_its_own_chat_in_the_tree_and_main_shows_it_where_main_started_it(fixing, monkeypatch,
                                                                                               analyst):
    work = fixing.home / "fixes" / "work" / "1"
    client = api_key(monkeypatch, scripted(
        [call("fix_thimble", {"words": "new make the card count its rows"}), text("Started a fix for the card.")],
        [call("Write", {"file_path": str(work / "browser" / "note.txt"), "content": "rows\n"}),
         text("Title: Card says how many rows\nWhat it does: The card's title now ends with its row count.")]))
    before = len(_log(CORPUS))
    got = await fixes.request_route(CORPUS, fixes.Asked(words="make the card count its rows", page=PAGE), analyst)
    assert got["event"]
    await _main_done()
    # main read the request as the terminal's /thimble-fix gives it, with the person's fixes (none) beside it
    asked = _asked(client)
    assert "make the card count its rows" in asked and "fix_thimble" in asked
    assert "for a new fix):\\n\\n(none yet)" in asked
    # the fix's own chat, which the thread tree lists by the fix's name, not its number
    [chat] = _fixer_chats(CORPUS)
    assert chat["kind"] == "agent" and chat["fix"] == 1 and chat["title"] == "fixing make the card count its rows"
    await _mirrored(CORPUS, chat["id"])
    await _ended()
    records = _log(CORPUS, chat["id"])
    # it opens with the person's words, not the fixer's prompt, and its steps are its own; it got the page
    users = [r["text"] for r in records if r["type"] == "user"]
    assert users == ["make the card count its rows"]
    assert any(r["type"] == "tool_use" and r["name"] == "Write" for r in records)
    assert "Incidents by week" in json.dumps([b for b in client.bodies if "The person asked for this change" in json.dumps(b)][-1]["messages"])
    # main's chat: the message as the person typed it, the fixer as main's subagent (its card reads the fix's chat),
    # main's line, and at the fix's end the row that asks the person; main's call carries the fix's name, never its
    # number
    added = _log(CORPUS)[before:]
    assert [(r["type"], r.get("text") or r.get("chat")) for r in added if r["type"] in ("user", "agent")] == [
        ("user", "/thimble-fix make the card count its rows"), ("agent", chat["id"])]
    assert [(r["status"], r["ref"]) for r in added if r["type"] == "chip"] == [("ready", "fix:1")]
    assert [r.get("name", "").rsplit("__", 1)[-1] for r in added if r["type"] == "tool_use"] == ["fix_thimble"]
    # what main read of its call: the fix by its name, never its number
    result = json.dumps([b for b in client.bodies if "tool_result" in json.dumps(b["messages"])
                         and "The person asked for this change" not in json.dumps(b["messages"])][-1]["messages"][-1])
    assert "(\\u201cmake the card count its rows\\u201d)" in result or '(\\"make the card count its rows\\")' in result
    assert "fix 1" not in result
    assert any(r["type"] == "text" and "Started a fix" in (r.get("delta") or "") for r in added)
    # main is not told of the fix a second time at the person's next message: it started it
    from app import runtime
    assert runtime._spaces[CORPUS].notes.get(runtime.MAIN) in (None, [])
    assert agents.read_meta(CORPUS, chat["id"])["status"] == "done"


async def test_main_tells_a_follow_up_from_a_new_fix_with_the_person_s_fixes_beside_the_words(fixing, monkeypatch,
                                                                                               analyst):
    client = api_key(monkeypatch, scripted(
        [call("fix_thimble", {"words": "new count the rows"}), text("Started."),
         call("fix_thimble", {"words": "1 count the columns too"}, "toolu_2"), text("Changing it."),
         call("fix_thimble", {"words": "5 rows a page"}, "toolu_3"), text("Started.")],
        [text("Title: Card counts rows\nWhat it does: The card counts rows."),
         text("Title: Card counts rows\nWhat it does: The card counts rows and columns."),
         text("Title: Five rows a page\nWhat it does: Pages hold five rows.")]))
    await fixes.request_route(CORPUS, fixes.Asked(words="count the rows"), analyst)
    await _main_done()
    await _ended()
    before = len(_log(CORPUS))
    await fixes.request_route(CORPUS, fixes.Asked(words="it should count the columns too"), analyst)
    await _main_done()
    # main read the person's fixes beside the words: the number as the handle, the name and the state
    asked = _asked(client)
    assert "it should count the columns too" in asked
    assert '1  \\"Card counts rows\\" (ready): The card\'s title now ends with its row count.' in asked
    # fix_thimble `1 <words>`: a round of fix 1 (`fix round 1`), never a new fix: the same id and the same chat, in the
    # person's words, never main's
    assert ("round", "1") in fixing.calls and [c[0] for c in fixing.calls].count("new") == 1
    assert fixing.recs[1]["words"] == ["count the rows", "it should count the columns too"]
    [chat] = _fixer_chats(CORPUS)
    assert chat["title"] == "changing Card counts rows"
    assert [(r["type"], r.get("text")) for r in _log(CORPUS)[before:] if r["type"] == "user"] == [
        ("user", "/thimble-fix it should count the columns too")]
    # main's card of the round is the fix's second run, so it shows that run's steps alone
    assert [(r["chat"], r.get("run")) for r in _log(CORPUS)[before:] if r["type"] == "agent"] == [(chat["id"], 1)]
    await _ended()
    assert [r["text"] for r in _log(CORPUS, chat["id"]) if r["type"] == "user"] == ["count the rows",
                                                                                     "it should count the columns too"]
    # a number of main's that is no fix of the person's names none: a new fix, in the person's words, as the terminal
    # reads it
    await fixes.request_route(CORPUS, fixes.Asked(words="five rows a page"), analyst)
    await _main_done()
    assert fixing.recs[2]["words"] == ["five rows a page"]
    await _ended(2)


async def test_main_may_ask_first_and_starts_the_fix_their_answer_names_in_their_own_words(fixing, monkeypatch,
                                                                                           analyst):
    client = api_key(monkeypatch, scripted(
        [text("Which card: the incidents card or the weeks card?"),
         call("fix_thimble", {"words": "new the incidents card should count its rows"}), text("Started.")],
        [text("Title: Card counts rows\nWhat it does: The card counts rows.")]))
    await fixes.request_route(CORPUS, fixes.Asked(words="the card should count", page=PAGE), analyst)
    await _main_done()
    assert [c[0] for c in fixing.calls] == ["list"] and _fixer_chats(CORPUS) == []
    await main_turn("the incidents one")
    await _main_done()
    # the fixer has the conversation with the answer; the fix's words are the ones the person typed after /thimble-fix
    assert fixing.recs[1]["words"] == ["the card should count"]
    await _ended()
    # the fixer still gets the page as it was when the person asked
    fixer = [b for b in client.bodies if "The person asked for this change to their thimble" in json.dumps(b["messages"])]
    assert "Incidents by week" in json.dumps(fixer[0]["messages"])


async def test_the_row_times_a_round_from_its_start_not_from_when_the_fix_was_made(fixing):
    fixing.recs[1] = {"id": 1, "title": "Card counts rows", "state": "working", "words": ["a"], "created": time.time() - 3600}
    fixes._phase_set(1, "fixing")
    assert time.time() - fixes.status()["fixes"][0]["created"] < 60
    fixes._phase_set(1, "testing")  # the same work goes on: the same start
    assert time.time() - fixes.status()["fixes"][0]["created"] < 60
    fixes._phase_set(1, None)
    assert 1 not in fixes._since


async def test_a_fix_whose_server_stopped_while_it_worked_is_taken_as_it_stands_at_the_page_s_first_look(fixing,
                                                                                                       monkeypatch):
    fixing.recs[1] = {"id": 1, "title": "Card counts rows", "state": "working", "words": ["a"], "made_in": "browser",
                      "work": str(fixing.home / "fixes" / "work" / "1"), "base": "HEAD"}
    monkeypatch.setattr(fixes, "_recovered", False)
    await fixes.status_route()  # the route reads the records in a worker thread; the recovery starts on the loop
    await _until(lambda: fixing.recs[1]["state"] != "working", "the recovery's checks never ended")
    assert ("done" in [c[0] for c in fixing.calls]) and fixing.recs[1]["state"] == "ready"


def test_main_reads_each_fix_the_words_may_change_by_its_number_name_and_state():
    recs = [{"id": 1, "title": "Card counts rows", "state": "on", "summary": "The card counts\nits rows."},
            {"id": 2, "title": "", "state": "working", "prev": {"state": "on"}},
            {"id": 3, "title": "Old one", "state": "removed"}]
    assert fixes.fixes_context(recs).splitlines() == [
        '1  "Card counts rows" (on): The card counts its rows.',
        '2  "fix 2" (on, being changed (working))']
    assert fixes.fixes_context(recs[2:]) == "(none yet)"


async def test_words_in_the_fix_s_thread_go_to_its_fixer_while_it_works(fixing, monkeypatch, analyst):
    client = api_key(monkeypatch, [text("Working on it."), text("Title: Card counts rows\nWhat it does: Rows and columns.")])
    # the fixer's first answer comes once the words are in, so they come while it works
    words_in = asyncio.Event()
    streams = client.stream

    def stream(**body: Any) -> Any:
        s = streams(**body)
        if len(client.bodies) == 1:
            answer = s.get_final_message

            async def held() -> Any:
                await words_in.wait()
                return await answer()

            s.get_final_message = held
        return s

    client.stream = stream
    await fixes.request(CORPUS, "count the rows", "")
    before = len(_log(CORPUS))
    await _until(lambda: len(client.bodies) == 1, "the fixer never sent its first request")
    # typed in the fix's own thread while its fixer works: a round of the fix, for the same fixer
    got = await fixes.request_route(CORPUS, fixes.Asked(words="and the columns", fix=1), analyst)
    words_in.set()
    assert got["fix"]["id"] == 1 and ("round", "1") in fixing.calls
    await _ended()
    assert "The person adds to this fix (round 2): and the columns" in json.dumps(client.bodies[-1]["messages"])
    assert [c[0] for c in fixing.calls].count("new") == 1 and len(_fixer_chats(CORPUS)) == 1
    # main's chat shows nothing of it; the fix's thread shows the words, not the fixer's text
    assert not [r for r in _log(CORPUS)[before:] if r["type"] in ("user", "agent")]
    users = [r["text"] for r in _log(CORPUS, _fixer_chats(CORPUS)[0]["id"]) if r["type"] == "user"]
    assert users == ["count the rows", "and the columns"]


async def test_a_fix_that_fails_its_checks_says_why_and_offers_redo(fixing, monkeypatch):
    fixing.ends, fixing.error = "failed", "its tests failed in the sandbox"
    api_key(monkeypatch, [text("Title: Bar counts rows\nWhat it does: The bar counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    assert "apply" not in [c[0] for c in fixing.calls] and fixing.restarts == []
    row = fixes.status()["fixes"][0]
    assert row["kind"] == "failed"
    assert row["said"] == "“Bar counts rows” did not pass: its tests failed in the sandbox"


async def test_later_leaves_the_fix_ready_in_your_fixes_and_use_it_there_puts_it_on(fixing, monkeypatch, analyst):
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    await fixes.dismiss_route(1, analyst)  # Later
    assert fixes.status()["fixes"] == [] and fixing.recs[1]["state"] == "ready"
    listed = fixes.status(every=True)["fixes"]
    assert [(r["id"], r["state"], r["kind"]) for r in listed] == [(1, "ready", None)]
    await fixes.apply_route(1, analyst)  # Use it, in Your fixes
    await _went_on()
    await _restarted(fixing, "Use it")
    assert fixing.recs[1]["state"] == "on" and fixing.restarts[-1][0] == "fix 1: Card counts rows"


async def test_a_fix_that_did_not_pass_says_what_it_tried_for_ask_claude(fixing, monkeypatch):
    fixing.ends, fixing.error = "failed", "it needs a newer node"
    api_key(monkeypatch, [text("Title: Cards draw on Node 26\nWhat it does: The card runner starts with --allow-net.")])
    await fixes.request(CORPUS, "cards should draw on Node 26", "")
    await _ended()
    row = fixes.status()["fixes"][0]
    # the person's words, what the fixer did, the files it changed, and why
    assert (row["kind"], row["words"], row["error"]) == ("failed", "cards should draw on Node 26", "it needs a newer node")
    assert row["summary"] == "The card's title now ends with its row count." and row["paths"] == ["a", "b"]
    # a ready fix's row says no more than it did in 0.10.5: no sentence of the files it changes; and no path of the
    # copy, which main's sandbox cannot read
    assert "notice" not in row and "copy" not in row
    # Ask Claude's click reads what main can use in its place: the change, cut at a line, and the end of the tests'
    # output
    fixing.recs[1].update(diff="".join(f"+ line {i} of the change\n" for i in range(600)), tests_tail="FAIL made-up test")
    got = await fixes.tried_route(1)
    assert got["diff"].startswith("+ line 0 of the change\n") and got["diff"].endswith("\n…\n")
    assert len(got["diff"]) <= fixes.TRIED_CHARS + 3 and got["tests"] == "FAIL made-up test"
    fixing.recs[1].update(diff="+ one line\n", tests_tail=None)
    assert await fixes.tried_route(1) == {"diff": "+ one line\n", "tests": ""}


async def test_a_ready_notice_goes_once_the_fix_is_on_elsewhere(fixing, monkeypatch):
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    fixing.recs[1]["state"] = "on"  # the terminal's y put it on
    assert fixes.status()["fixes"] == []


async def test_only_the_click_applies_and_a_refused_apply_says_why(fixing, monkeypatch, analyst):
    from app import hook_auth
    from starlette.requests import Request

    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    token_only = Request({"type": "http", "headers": [], "state": {}})
    with pytest.raises(HTTPException) as e:
        await fixes.apply_route(1, token_only)
    assert e.value.status_code == 403 and e.value.detail == hook_auth.ANALYST_ONLY
    assert "apply" not in [c[0] for c in fixing.calls]
    fixing.recs[1]["state"] = "failed"
    with pytest.raises(HTTPException) as e:
        await fixes.apply_route(1, analyst)
    assert e.value.status_code == 409 and "nothing to apply" in e.value.detail
    assert fixes._phase == {} and fixing.restarts == []


async def test_a_page_that_does_not_build_takes_the_fix_off_again(fixing, monkeypatch, analyst):
    monkeypatch.setattr(fixes, "prepare", lambda root: "the page did not build: src/x.tsx(3,1): error TS1005")
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    await fixes.apply_route(1, analyst)
    await _went_on()
    await _until(lambda: (fixes.status()["fixes"][0]["said"] or "").endswith("it is off again"), "the failed fix never came off")
    # a restart the click had scheduled would come RESTART_AFTER_S after it, so before this wait, which starts later,
    # ends: the loop's timers fire in the order of their deadlines
    await asyncio.sleep(fixes.RESTART_AFTER_S)
    verbs = [c[0] for c in fixing.calls]
    assert verbs.index("undo") > verbs.index("apply") and fixing.restarts == []
    assert fixes.status()["fixes"][0]["said"].endswith("error TS1005; it is off again")


async def test_undo_takes_the_fix_off_and_starts_the_server_again(fixing, monkeypatch, analyst):
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    await fixes.apply_route(1, analyst)
    await _went_on()
    await _restarted(fixing, "Use it now")
    assert (await fixes.undo_route(1, analyst))["restart"] is True
    await _restarted(fixing, "Undo", 2)
    assert fixing.restarts[-1][0] == "undo of fix 1"
    fixes._phase.clear()
    assert fixes.status()["fixes"][0]["said"] == "thimble fix undone: Card counts rows"
    await fixes.dismiss_route(1, analyst)
    assert fixes.status()["fixes"] == []


async def test_the_routes_take_the_analyst_s_click_alone(fixing):
    from app import hook_auth
    from starlette.requests import Request

    token_only = Request({"type": "http", "headers": [], "state": {}})
    with pytest.raises(HTTPException) as e:
        await fixes.request_route(CORPUS, fixes.Asked(words="count the rows"), token_only)
    assert e.value.status_code == 403 and e.value.detail == hook_auth.ANALYST_ONLY
    with pytest.raises(HTTPException) as e:
        await fixes.request(CORPUS, "   ", "")
    assert e.value.status_code == 400


async def test_file_dev_ticket_on_thimble_s_code_starts_no_fix(fixing):
    # a change to thimble itself is the person's fix, which they ask for with /thimble-fix
    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Wider pane", "body": "the pane is narrow"},
                           tool_use_id="toolu_ticket")
    assert "/thimble-fix" in json.dumps(res.content) and not res.is_error
    assert fixing.calls == [] and _fixer_chats(CORPUS) == []


def test_fixes_off_leave_the_code_tickets_their_entry_points(monkeypatch):
    monkeypatch.setenv("THIMBLE_FIXES", "off")
    assert fixes.problem() == fixes.OFF_LINE
    assert fixes.status() == {"problem": fixes.OFF_LINE, "fixes": []}


def test_a_copy_gets_the_installed_packages_and_a_folder_of_its_own_for_the_page_s_temp_files(tmp_path):
    src, copy = tmp_path / "install", tmp_path / "copy"
    (src / "backend" / ".venv" / "bin").mkdir(parents=True)
    (src / "frontend" / "node_modules" / "vite").mkdir(parents=True)
    (src / "frontend" / "node_modules" / ".vite").mkdir()
    (copy / "backend").mkdir(parents=True)
    (copy / "frontend").mkdir()
    fixes.lend(copy, src)
    assert (copy / "backend" / ".venv").resolve() == (src / "backend" / ".venv").resolve()
    nm = copy / "frontend" / "node_modules"
    assert nm.is_dir() and not nm.is_symlink()
    assert (nm / "vite").resolve() == (src / "frontend" / "node_modules" / "vite").resolve()
    assert not (nm / ".vite").exists()


def test_the_tests_read_the_real_packages_also_when_the_server_runs_from_live(tmp_path, monkeypatch):
    """After a fix went on, the server runs from live's browser/, whose node_modules is a folder of links: the sandbox
    must read the folder the links point into, and a new copy links to the real packages."""
    real, live, copy = tmp_path / "install", tmp_path / "live", tmp_path / "copy"
    (real / "backend" / ".venv" / "bin").mkdir(parents=True)
    (real / "frontend" / "node_modules" / "vite").mkdir(parents=True)
    for root in (live, copy):
        (root / "backend").mkdir(parents=True)
        (root / "frontend").mkdir()
    fixes.lend(live, real)
    monkeypatch.setattr(config, "REPO_ROOT", live)
    assert set(fixes.lent_reads()) == {(real / "backend" / ".venv").resolve(), (real / "frontend" / "node_modules").resolve()}
    fixes.lend(copy)
    assert os.readlink(copy / "frontend" / "node_modules" / "vite") == str((real / "frontend" / "node_modules" / "vite").resolve())


# a release launcher that hands the way back off itself, as the plugin's launcher checks (plugin/bin/thimble)
HANDS_OFF = "#!/bin/sh\n# the way back runs from $THIMBLE_HOME/fixes/release/plugin (made up)\n"


def test_the_kernel_runs_from_the_release_checkout_once_there_is_one(tmp_path, monkeypatch):
    """The way back runs from the release, which no fix changes (plugin/engine/kernel/fixes.py): a fix to live's kernel
    cannot break the clicks that undo it. A release checkout from before the hand-off (its launcher names no
    fixes/release/plugin) runs an older kernel: this tree's runs instead, as the plugin's launcher does."""
    monkeypatch.setenv(fixes.PLUGIN_HOME_ENV, str(tmp_path / "home"))
    assert fixes.kernel_script() == fixes.plugin_dir() / "engine" / "thimble.py"
    release = tmp_path / "home" / "fixes" / "release" / "plugin" / "engine" / "thimble.py"
    release.parent.mkdir(parents=True)
    release.write_text("print('made-up kernel')\n")
    launcher = release.parents[1] / "bin" / "thimble"
    launcher.parent.mkdir()
    launcher.write_text("#!/bin/sh\n# a made-up launcher from before the hand-off\n")
    assert fixes.kernel_script() == fixes.plugin_dir() / "engine" / "thimble.py"
    launcher.write_text(HANDS_OFF)
    assert fixes.kernel_script() == release


def test_the_kernel_runs_only_the_releases_code_whatever_was_added_to_its_checkout(tmp_path, monkeypatch):
    """A file changed in the release checkout is restored and a file added to it (a module that would shadow one of
    Python's) removed before the kernel runs from it."""
    import subprocess  # noqa: PLC0415

    monkeypatch.setenv(fixes.PLUGIN_HOME_ENV, str(tmp_path / "home"))
    checkout = tmp_path / "home" / "fixes" / "release"
    engine = checkout / "plugin" / "engine"
    engine.mkdir(parents=True)
    # as the real kernel's command, it puts its own folder first on Python's path
    head = "import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parent))\nimport getpass\n"
    (engine / "thimble.py").write_text(head + "print('made-up kernel', getattr(getpass, 'WHO', 'python'))\n")
    (checkout / "plugin" / "bin").mkdir()
    (checkout / "plugin" / "bin" / "thimble").write_text(HANDS_OFF)
    ident = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t",
             "GIT_COMMITTER_EMAIL": "t@example.com"}
    for cmd in (["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "made-up release"]):
        subprocess.run(["git", *cmd], cwd=checkout, check=True, capture_output=True, env=ident)
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout, check=True, capture_output=True, text=True).stdout.strip()
    (checkout.parent / "release.json").write_text(json.dumps({"base": base}))
    (engine / "getpass.py").write_text("WHO = 'planted'\n")
    (engine / "thimble.py").write_text(head + "print('changed by hand', getattr(getpass, 'WHO', 'python'))\n")
    assert fixes.kernel(["list"]).out.strip() == "made-up kernel python"
    assert not (engine / "getpass.py").exists()
    assert subprocess.run(["git", "status", "--porcelain", "--ignored"], cwd=checkout, capture_output=True,
                          text=True).stdout == ""


IDENT = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t",
         "GIT_COMMITTER_EMAIL": "t@example.com"}


def _git(*args: str, cwd: Path) -> str:
    import subprocess  # noqa: PLC0415

    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, **IDENT}).stdout.strip()


def _release(tmp_path: Path, monkeypatch) -> Path:
    """A made-up release checkout whose kernel imports a module of its own, at its release commit (release.json)."""
    monkeypatch.setenv(fixes.PLUGIN_HOME_ENV, str(tmp_path / "home"))
    checkout = tmp_path / "home" / "fixes" / "release"
    (checkout / "plugin" / "engine" / "kernel").mkdir(parents=True)
    (checkout / "plugin" / "bin").mkdir()
    (checkout / "plugin" / "bin" / "thimble").write_text(HANDS_OFF)
    (checkout / "plugin" / "engine" / "kernel" / "__init__.py").write_text("")
    (checkout / "plugin" / "engine" / "kernel" / "words.py").write_text("WORDS = 'made-up kernel'\n")
    (checkout / "plugin" / "engine" / "thimble.py").write_text(
        "import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parent))\n"
        "from kernel import words\nprint(words.WORDS, *sys.argv[1:])\n")
    (checkout / "bar.txt").write_text("as released\n")
    _git("init", "-q", cwd=checkout)
    _git("add", "-A", cwd=checkout)
    _git("commit", "-q", "-m", "made-up release", cwd=checkout)
    (checkout.parent / "release.json").write_text(json.dumps({"base": _git("rev-parse", "HEAD", cwd=checkout)}))
    return checkout


def _recording_hook(checkout: Path, tmp_path: Path) -> Path:
    """A post-checkout hook in the release checkout's repository (in a clone install, the person's own clone's)."""
    ran = tmp_path / "hook-ran"
    hooks = tmp_path / "made-up-hooks"
    hooks.mkdir()
    (hooks / "post-checkout").write_text(f"#!/bin/sh\necho ran >> '{ran}'\nexit 2\n")
    (hooks / "post-checkout").chmod(0o755)
    _git("config", "core.hooksPath", str(hooks), cwd=checkout)
    return ran


def test_the_releases_kernel_writes_no_bytecode_into_its_checkout(tmp_path, monkeypatch):
    checkout = _release(tmp_path, monkeypatch)
    assert fixes.kernel(["list"]).out.strip() == "made-up kernel fix list"
    assert _git("status", "--porcelain", "--ignored", cwd=checkout) == ""


def test_a_release_checkout_as_the_release_has_it_is_left_alone_and_one_that_is_not_waits_for_anothers_lock(
        tmp_path, monkeypatch):
    import threading  # noqa: PLC0415

    checkout = _release(tmp_path, monkeypatch)
    ran = _recording_hook(checkout, tmp_path)
    # as the release commit has it: no git changes it (the hook would say so), so the processes that run from it at once
    # never meet it half put back
    assert fixes.kernel(["list"]).out.strip() == "made-up kernel fix list"
    assert not ran.exists()
    # changed by hand while another git holds its index: put back once that git lets go, with no hook of the repository's
    (checkout / "bar.txt").write_text("changed by hand\n")
    lock = checkout / ".git" / "index.lock"
    lock.write_text("")
    t = threading.Timer(0.5, lambda: lock.unlink(missing_ok=True))
    t.start()
    assert fixes.kernel(["list"]).out.strip() == "made-up kernel fix list"
    t.join()
    assert (checkout / "bar.txt").read_text() == "as released\n" and not ran.exists()
    assert _git("status", "--porcelain", "--ignored", cwd=checkout) == ""


def test_the_files_a_copy_changed_are_read_by_git_on_its_own_entry_never_through_its_git_link(tmp_path, monkeypatch):
    monkeypatch.setenv(fixes.PLUGIN_HOME_ENV, str(tmp_path / "home"))
    live = tmp_path / "home" / "fixes" / "live"
    live.mkdir(parents=True)
    (live / "bar.txt").write_text("as released\n")
    _git("init", "-q", cwd=live)
    _git("add", "-A", cwd=live)
    _git("commit", "-q", "-m", "made-up release", cwd=live)
    work = tmp_path / "home" / "fixes" / "work" / "1"
    _git("worktree", "add", "-q", "--detach", str(work), "HEAD", cwd=live)
    (work / "notes.md").write_text("a made-up note\n")
    assert fixes.changed(work, "HEAD") == ["notes.md"]
    # the fixer's sandbox writes the copy: a git folder of its own there, whose settings would run its command here
    ran = tmp_path / "ran-outside"
    (work / "made-up-monitor").write_text(f"#!/bin/sh\ntouch '{ran}'\nexit 1\n")
    (work / "made-up-monitor").chmod(0o755)
    (work / ".git").unlink()
    _git("init", "-q", str(work), cwd=tmp_path)
    _git("config", "core.fsmonitor", str(work / "made-up-monitor"), cwd=work)
    assert fixes.changed(work, "HEAD") == []
    assert not ran.exists()


async def test_a_fix_that_needs_a_file_no_fix_may_change_says_so_so_the_page_offers_no_try_again(fixing, monkeypatch):
    api_key(monkeypatch, [text("Title: Cards draw on Node 26\nWhat it does: The card runner starts with --allow-net.")])
    await fixes.request(CORPUS, "cards should draw on Node 26", "")
    await _ended()
    assert fixes.status()["fixes"][0]["blocked"] is False
    # the kernel's record names the protected files the fixer could not do without (kernel fixes.py, `blocked`)
    fixing.recs[1]["blocked"] = ["plugin/sandbox/setup.mjs"]
    assert fixes.status()["fixes"][0]["blocked"] is True


async def test_fix_thimble_starts_no_fix_from_main_s_words_and_the_person_s_own_head_names_the_fix(fixing, monkeypatch,
                                                                                                   analyst):
    # main saw thimble misbehave and calls fix_thimble with no /thimble-fix of the person's: no fix starts, and main
    # reads that the person asks for one
    res = await tools.call(CORPUS, "fix_thimble", {"words": "new the legend hides its last row"}, tool_use_id="toolu_f1")
    said = json.dumps(res.content)
    assert "thimble started no fix" in said and "/thimble-fix <what should work differently>" in said
    assert fixing.calls == [] and _fixer_chats(CORPUS) == []
    # alone, or a number or new with no words after it: nothing says what should change, and main is not asked; the
    # line is the terminal's
    assert fixes.EMPTY == "Ask for a change to thimble with /thimble-fix <what should work differently>."
    for words in ("", "1", "#2:", "new"):
        with pytest.raises(HTTPException) as e:
            await fixes.request_route(CORPUS, fixes.Asked(words=words), analyst)
        assert e.value.status_code == 400 and e.value.detail == fixes.EMPTY
    # the person's own `1 …` names their fix 1, whatever main's form says; the words after it go to the fix
    fixing.recs[1] = {"id": 1, "title": "Card counts rows", "state": "on", "words": ["count the rows"], "updated": 1.0,
                      "work": None}
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: Rows and columns.")])
    fixes._asked[CORPUS] = fixes._Asking("1 and the columns", "", fixes.ASKED_TURNS)
    got = await fixes.from_tool(CORPUS, "new: Columns too")
    assert got["kind"] == "round" and ("round", "1") in fixing.calls
    assert fixing.recs[1]["words"] == ["count the rows", "and the columns"]
    await _ended()
    # a request is answered once: main's next call starts nothing
    with pytest.raises(HTTPException) as e:
        await fixes.from_tool(CORPUS, "1")
    assert e.value.status_code == 409 and e.value.detail == fixes.NOT_ASKED


async def test_the_person_s_words_go_after_two_of_main_s_turns_so_a_later_call_of_main_s_own_starts_no_fix(
        fixing, monkeypatch, analyst):
    # the person's /thimble-fix says nothing main can name, so main asks for words that do; the person asks something
    # else, and then, without /thimble-fix, for a fix: main's call starts no fix from the words of two turns before
    client = api_key(monkeypatch, scripted(
        [text("Say what should work differently with /thimble-fix <what should work differently>."),
         text("Runs 3 and 4 failed."),
         call("fix_thimble", {"words": "new"}), text("No fix started.")],
        [text("Title: Something\nWhat it does: Something.")]))
    await fixes.request_route(CORPUS, fixes.Asked(words="this", page=PAGE), analyst)
    await _main_done()
    assert fixes._asked[CORPUS].turns == 1
    await main_turn("Which runs failed?")
    await _main_done()
    assert CORPUS not in fixes._asked
    await main_turn("Please start a fix of thimble for the notes column")
    await _main_done()
    assert [c for c in fixing.calls if c[0] in ("new", "round", "redo")] == [] and _fixer_chats(CORPUS) == []
    # main read that no fix started, and that the person asks for one with /thimble-fix
    result = json.dumps(client.bodies[-1]["messages"][-1])
    assert "thimble started no fix" in result and "/thimble-fix <what should work differently>" in result
    # words posted while main's turns run: no turn counts until the one that reads them, from which they last two
    posted: list[str] = []
    monkeypatch.setattr(events, "post", lambda *a, **k: posted.append(k["event_id"]) or {"id": k["event_id"]})
    await fixes.ask(CORPUS, "the legend hides its last row")
    for _ in range(3):  # the turn that runs, and the turns of messages posted before the words
        fixes.main_turn_ended(CORPUS)
    assert CORPUS not in fixes._asked and list(fixes._waiting[CORPUS]) == posted
    fixes.words_read(CORPUS, "made-up-event-of-another-message")
    assert CORPUS not in fixes._asked
    fixes.words_read(CORPUS, posted[0])
    for _ in range(fixes.ASKED_TURNS):
        assert fixes._asked[CORPUS].words == "the legend hides its last row"
        fixes.main_turn_ended(CORPUS)
    assert CORPUS not in fixes._asked and not fixes._waiting[CORPUS]


def _fix_calls(fixing: Any) -> list[tuple[str, ...]]:
    return [c for c in fixing.calls if c[0] in ("new", "round", "redo")]


async def test_words_typed_while_main_works_last_from_the_turn_that_reads_them_even_behind_another_message(
        fixing, monkeypatch, analyst):
    # main's turn runs (a command that takes a second); meanwhile the person sends another message, then /thimble-fix:
    # both wait in main's queue. The words count from the turn that reads them, as the terminal's do from the turn its
    # command runs in: main asks one short question there, and the person's answer starts the fix
    loop = asyncio.get_running_loop()
    held: dict[str, Any] = {}

    def first(_body: dict[str, Any]) -> Any:
        events.post(CORPUS, "main", {"text": "Also, which runs passed?"})
        held["ask"] = loop.create_task(fixes.ask(CORPUS, "the legend hides its last row", PAGE))
        return call("Bash", {"command": "sleep 1; echo done", "description": "wait"}, tid="toolu_sleep")

    client = api_key(monkeypatch, scripted(
        [first, text("Runs 3 and 4 failed."), text("Runs 1 and 2 passed."),
         text("Is this about one of your fixes, or a new fix?"), call("fix_thimble", {"words": "new"}), text("Started.")],
        [text("Title: Legend shows every row\nWhat it does: The legend wraps.")]))
    await main_turn("Which runs failed?")
    await held["ask"]
    await _main_done()
    # the turn that read the words asked its question: they wait for the answer's turn
    assert fixes._asked[CORPUS].turns == 1
    await main_turn("a new one")
    await _main_done()
    assert [c[0] for c in _fix_calls(fixing)] == ["new"]
    assert fixing.recs[1]["words"] == ["the legend hides its last row"]
    assert "thimble started no fix" not in json.dumps(client.bodies)
    await _ended()
    # with nothing queued before them, the same: the turn that runs is not theirs
    fixes._asked.clear()

    def busy(_body: dict[str, Any]) -> Any:
        held["ask"] = loop.create_task(fixes.ask(CORPUS, "and the legend's title", PAGE))
        return call("Bash", {"command": "sleep 1; echo done", "description": "wait"}, tid="toolu_sleep2")

    api_key(monkeypatch, scripted(
        [busy, text("Runs 3 and 4 failed."), text("Is this about your fix, or a new fix?"),
         call("fix_thimble", {"words": "1"}, "toolu_f2"), text("Changing it.")],
        [text("Title: Legend shows every row\nWhat it does: The legend wraps, and its title too.")]))
    await main_turn("Which runs failed?")
    await held["ask"]
    await _main_done()
    assert fixes._asked[CORPUS].turns == 1
    await main_turn("my fix")
    await _main_done()
    assert [c[0] for c in _fix_calls(fixing)] == ["new", "round"]
    assert fixing.recs[1]["words"] == ["the legend hides its last row", "and the legend's title"]


async def test_main_s_own_call_before_its_turn_reads_the_person_s_words_starts_no_fix_and_leaves_the_words_to_that_turn(
        fixing, monkeypatch, analyst):
    loop = asyncio.get_running_loop()
    held: dict[str, Any] = {}

    def offer(_body: dict[str, Any]) -> Any:
        # the person's /thimble-fix waits in main's queue while main, on its own, calls fix_thimble
        held["ask"] = loop.create_task(fixes.ask(CORPUS, "the legend hides its last row", PAGE))
        return call("Bash", {"command": "sleep 1; echo done", "description": "wait"}, tid="toolu_sleep")

    client = api_key(monkeypatch, scripted(
        [offer, call("fix_thimble", {"words": "new"}, "toolu_own"), text("No fix started."),
         call("fix_thimble", {"words": "new"}, "toolu_theirs"), text("Started.")],
        [text("Title: Legend shows every row\nWhat it does: The legend wraps.")]))
    await main_turn("The legend looks cut off. Can you fix thimble?")
    await held["ask"]
    await _main_done()
    said = json.dumps(client.bodies)
    assert "thimble started no fix" in said
    assert [c[0] for c in _fix_calls(fixing)] == ["new"]
    assert fixing.recs[1]["words"] == ["the legend hides its last row"]


async def test_a_fix_s_number_alone_tries_a_fix_that_failed_or_does_not_fit_again_as_its_try_again_does(
        fixing, monkeypatch, analyst):
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: Rows."), text("Title: Card counts rows\nWhat it does: Rows.")])
    fixing.recs[1] = {"id": 1, "title": "Card counts rows", "state": "failed", "words": ["count the rows"],
                      "updated": 1.0, "work": None, "error": "its tests failed"}
    before = len(_log(CORPUS))
    got = await fixes.request_route(CORPUS, fixes.Asked(words="#1"), analyst)
    # the kernel's redo, in the person's words of before, with no turn of main's
    assert got["fix"]["id"] == 1 and ("redo", "1") in fixing.calls
    assert not [r for r in _log(CORPUS)[before:] if r["type"] == "user"]
    await _ended()
    # a fix changed in place whose new version did not fit when the person used it: it waits, its record says why, and
    # the kernel's line names /thimble-fix 1
    fixing.recs[1].update(state="ready", prev={"state": "on"}, error="its new version does not fit fix 2")
    await fixes.request_route(CORPUS, fixes.Asked(words="1"), analyst)
    assert [c for c in fixing.calls if c[0] == "redo"] == [("redo", "1"), ("redo", "1")]
    await _ended()
    # a fix with nothing to try again: its number alone says how to ask, as the terminal says it
    for state, error in (("on", None), ("ready", None)):
        fixing.recs[1].update(state=state, error=error)
        with pytest.raises(HTTPException) as e:
            await fixes.request_route(CORPUS, fixes.Asked(words="1"), analyst)
        assert e.value.status_code == 400 and e.value.detail == fixes.EMPTY
    assert [c for c in fixing.calls if c[0] == "redo"] == [("redo", "1"), ("redo", "1")]


async def test_try_again_goes_on_in_the_copy_while_it_holds_work_no_check_took_and_the_fixer_reads_so(fixing, monkeypatch):
    # a fix that did not pass; in the terminal, Claude changed its copy after d: Try again (or /thimble-fix 1 alone) goes
    # on in that copy, whose check takes the change, and the new fixer reads that the copy holds the last try and what
    # changed after it, and why that try did not pass
    fixing.ends, fixing.error = "failed", "it needs a newer node"
    client = api_key(monkeypatch, scripted([], [text("Title: Card counts rows\nWhat it does: Rows."),
                                                text("Title: Card counts rows\nWhat it does: Rows, on any node.")]))
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    assert fixing.recs[1]["state"] == "failed"
    fixing.recs[1]["unchecked"] = True
    got = await fixes.redo(CORPUS, 1)
    assert got["fix"]["id"] == 1 and ("redo", "1") in fixing.calls
    await _ended()
    first = [json.dumps(b["messages"]) for b in client.bodies if "The person asked for this change" in json.dumps(b)][-1]
    assert ("The last try did not pass because it needs a newer node. Your copy holds the change of that try, and the "
            "changes that were made in the copy after it. Start from them.") in first
    assert "earlier.patch" not in first
    [chat] = _fixer_chats(CORPUS)
    assert any(r["type"] == "text" and r.get("delta") == "\n· Redo, in its copy\n" for r in _log(CORPUS, chat["id"]))
    # a copy with nothing beyond what the check took: a new copy, with the earlier change the kernel names
    fixing.recs[1].update(state="failed", commit="c0ffee1", error="its tests failed in the sandbox")
    await fixes.redo(CORPUS, 1)
    await _ended()
    first = [json.dumps(b["messages"]) for b in client.bodies if "The person asked for this change" in json.dumps(b)][-1]
    assert "earlier.patch; start from it when it helps. It did not pass because its tests failed in the sandbox." in first
    assert any(r["type"] == "text" and r.get("delta") == "\n· Redo, in a new copy\n" for r in _log(CORPUS, chat["id"]))


def test_the_form_s_head_and_the_fix_it_names():
    recs = [{"id": 2, "state": "on"}, {"id": 3, "state": "removed"}]
    assert fixes.head_of("2: it breaks") == (2, False, "it breaks")
    assert fixes.head_of("#2 - it breaks") == (2, False, "it breaks")
    assert fixes.head_of("new") == (None, True, "") and fixes.head_of("NEW: a pane") == (None, True, "a pane")
    assert fixes.head_of("new-style labels") is None and fixes.head_of("it breaks") is None
    assert fixes.form_of("2 it breaks", recs) == ("it breaks", 2)
    assert fixes.form_of("3 it breaks", recs) == ("3 it breaks", None)
    assert fixes.form_of("new: a pane", recs) == ("a pane", None)
    # the person's own head first, else main's form, with or without words after it
    assert fixes.named_fix("2 it breaks", "new", recs) == 2
    assert fixes.named_fix("new a pane", "2", recs) is None
    assert fixes.named_fix("it breaks", "2", recs) == 2
    assert fixes.named_fix("it breaks", "#2: it breaks on click", recs) == 2
    assert fixes.named_fix("it breaks", "3", recs) is None and fixes.named_fix("it breaks", "", recs) is None
