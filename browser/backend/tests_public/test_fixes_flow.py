"""thimble fix in the browser (app/fixes.py): /thimble-fix starts a fork of main's conversation on a copy the kernel
makes, in the person's words as they typed them; the kernel checks what it changed, and a fix that passes is ready: a
notice asks the person, and only their click (Use it now) puts it on, with the secret of that click, and starts the
server again from live; Undo takes it off and starts the server again. The kernel is a stand-in that keeps its records
in memory, and the Messages API the fake client of test_runtime: no model is called and nothing restarts."""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from test_runtime import CORPUS, api_key, call, main_turn, on, text  # noqa: F401 — `on` is a fixture

from app import agents, config, dev, events, fixes, runtime, session

PAGE = 'The card open in focus (card:c1), "Incidents by week":\nweek  incidents\n1  4\n2  7'


class Kernel:
    """`thimble fix VERB` in memory: new makes the copy's folder, round takes more words for a fix (a fix the person
    has, at work again), done answers ready, apply takes the click's secret and puts a ready or off fix on (and refuses
    any other, as the kernel does), undo takes it off."""

    def __init__(self, home: Path) -> None:
        self.home = home
        self.recs: dict[int, dict[str, Any]] = {}
        self.calls: list[tuple[str, ...]] = []
        self.kind = "release"  # the install's kind, as the list says it: clone for a dev install

    def __call__(self, args: list[str], *, stdin: str | None = None, timeout: float = 0, env: dict | None = None):
        self.calls.append(tuple(args))
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
            return fixes.Ran(True, json.dumps({"fixes": list(self.recs.values()), "kind": self.kind}), "")
        rec = self.recs[int(args[1])]
        if verb == "round":
            rec.update(state="working", prev="HEAD", words=[*rec["words"], stdin])
        elif verb == "done":
            if "--title" in args:
                rec["title"] = args[args.index("--title") + 1]
            rec.update(state="ready", tests="passed", error=None,
                       summary="The card's title now ends with its row count.", files=[{"path": "a"}, {"path": "b"}])
        elif verb == "apply":
            if rec["state"] not in ("ready", "off"):
                return fixes.Ran(False, "", f"fix {rec['id']} is {rec['state']}, so there is nothing to apply")
            assert stdin and len(stdin) == 64  # the secret of the click, on stdin
            ask = self.home / "fixes" / "asks" / f"{rec['id']}.json"
            assert json.loads(ask.read_text())["key"] == fixes.hashlib.sha256(stdin.encode()).hexdigest()
            ask.unlink()
            rec["state"] = "on"
        elif verb == "undo":
            rec["state"] = "off"
        return fixes.Ran(True, json.dumps(rec), "")


@pytest.fixture()
def fixing(on, monkeypatch, tmp_path):
    """Fixes on, the kernel a stand-in, the page taken as built, and the restart recorded instead of made."""
    monkeypatch.setenv("THIMBLE_FIXES", "on")
    k = Kernel(fixes.plugin_home())
    monkeypatch.setattr(fixes, "kernel", k)
    monkeypatch.setattr(fixes, "srt_ready", lambda: "")
    monkeypatch.setattr(fixes, "prepare", lambda root, built=None: "")
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
    no fixer of it runs and its phase is neither fixing nor testing, which settle ends as it writes the fix's notice."""
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


async def test_a_fix_is_a_fork_of_main_on_its_copy_and_asks_the_person_when_its_checks_pass(fixing, monkeypatch):
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

    # the kernel checks what the change touched; the fix is ready, and nothing goes on by itself
    verbs = [c[0] for c in fixing.calls]
    assert verbs[:1] == ["new"] and "done" in verbs and "apply" not in verbs and fixing.restarts == []
    done = fixing.calls[verbs.index("done")]
    assert done[done.index("--title") + 1] == "Card says how many rows"
    row = fixes.status()["fixes"][0]
    assert (row["kind"], row["state"], row["phase"]) == ("ready", "ready", None)
    assert row["words"] == "make this card's title say how many rows it shows" and row["files"] == 2
    [chat] = _fixer_chats(CORPUS)
    assert any(r.get("kind") == "fix" and r.get("status") == "ready" for r in _log(CORPUS, chat["id"]))


async def _started_again() -> None:
    """The server starts again (Use it now): its agents stop and the mirror keeps where each transcript stands
    (runtime.stop_all), what it held in memory goes, and the next server attaches main's session again."""
    await runtime.stop_all(0.5)
    for lv in session._live.values():
        if lv.task is not None:
            lv.task.cancel()
    session._live.clear()
    session._own.clear()
    fixes._where.clear()
    runtime._spaces.clear()
    runtime.ensure(CORPUS)


def _has_fix(fixing: Any) -> None:
    """The person has fix 1, ready: a fix that more words can change."""
    work = fixing.home / "fixes" / "work" / "1"
    (work / "browser").mkdir(parents=True)
    fixing.recs[1] = {"id": 1, "title": "Card counts rows", "words": ["count the rows"], "state": "ready",
                      "work": str(work), "base": "HEAD", "made_in": "browser", "updated": 1.0}


async def test_more_words_for_a_fix_that_an_update_set_aside_start_its_fixer_from_the_old_change(fixing, monkeypatch):
    """An update set fix 1 aside (pending). Main reads it as off, in the terminal's words, and a round of it starts a
    fixer in the new copy that is told where the old change is, as the terminal's fixer is (plugin/fix/fixer.ts)."""
    _has_fix(fixing)
    patch = str(fixing.home / "fixes" / "tmp" / "1" / "earlier.patch")
    fixing.recs[1].update(state="pending", earlier=patch)
    assert fixes.fixes_context(list(fixing.recs.values())) == '1  "Card counts rows" (off, set aside at an update)'

    client = api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts its rows.")])
    await fixes.change(CORPUS, 1, "port it to the new release", "")
    await _ended()
    assert [c[0] for c in fixing.calls][:2] == ["show", "round"]
    first = client.bodies[0]["messages"][-1]["content"]
    assert (f"An earlier change for this request, which thimble did not use, is in {patch}; start from it when it "
            "helps.") in first
    assert "which did not pass" not in first and "The last try did not pass" not in first

    # a round of a fix that no update set aside names no earlier change
    client = api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: It counts the empty rows too.")])
    await fixes.change(CORPUS, 1, "count the empty rows too", "")
    await _ended()
    assert "An earlier change for this request" not in client.bodies[0]["messages"][-1]["content"]


async def test_a_fix_is_one_line_in_main_per_fixer_that_runs_until_its_checks_end_also_after_restarts(fixing,
                                                                                                     monkeypatch):
    """Main's chat shows each fixer once, as a side thread's line, whose chat runs while the fixer works and while the
    kernel checks its change, and stops when the fix's row says how it ended. A server that starts again knows each
    fixer's file as its fix's: live check br19 had main show a fixer again after each restart, as a new subagent of
    main's whose card ran on for good."""
    running: list[bool] = []

    def kernel(args: list[str], **kw: Any) -> fixes.Ran:
        if args[0] == "done":  # the kernel's checks of the change
            running.extend(agents.running(CORPUS, m["id"]) for m in _fixer_chats(CORPUS))
        return fixing(args, **kw)

    monkeypatch.setattr(fixes, "kernel", kernel)
    api_key(monkeypatch, [
        text("Title: Card counts rows\nWhat it does: The card counts rows."),
        text("Hello."),
        text("Title: Card counts rows\nWhat it does: The card counts rows, empty ones too."),
        text("Hello again."),
    ])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    [chat] = _fixer_chats(CORPUS)
    assert running == [True] and not agents.running(CORPUS, chat["id"])
    lines = len(_log(CORPUS, chat["id"]))

    def in_main() -> list[str]:
        return [r["chat"] for r in _log(CORPUS) if r["type"] == "agent"]

    await _started_again()
    await main_turn("Hello?")
    assert in_main() == [chat["id"]]
    assert len(_log(CORPUS, chat["id"])) == lines, "the fixer's lines are read once"

    # a round of the fix: a new fixer, in the fix's chat; then the server starts again once more
    await fixes.change(CORPUS, 1, "count the empty rows too", "")
    await _ended()
    assert running == [True, True] and not agents.running(CORPUS, chat["id"])
    await _started_again()
    await main_turn("And now?")
    assert in_main() == [chat["id"], chat["id"]]
    assert [m["id"] for m in agents.list_chats(CORPUS) if m.get("kind") == agents.KIND_AGENT] == [chat["id"]]


async def test_only_the_analyst_s_click_puts_a_fix_on_and_undo_takes_it_off(fixing, monkeypatch, analyst):
    from starlette.requests import Request

    from app import hook_auth

    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    token_only = Request({"type": "http", "headers": [], "state": {}})
    with pytest.raises(HTTPException) as e:
        await fixes.apply_route(1, token_only)
    assert e.value.status_code == 403 and e.value.detail == hook_auth.ANALYST_ONLY
    assert "apply" not in [c[0] for c in fixing.calls]
    await fixes.apply_route(1, analyst)
    await _went_on()
    await _restarted(fixing, "Use it now")
    assert fixing.recs[1]["state"] == "on"
    assert (await fixes.undo_route(1, analyst))["restart"] is True
    await _restarted(fixing, "Undo", 2)
    assert fixing.restarts[-1][0] == "undo of fix 1" and fixing.recs[1]["state"] == "off"
    fixes._phase.clear()
    assert fixes.status()["fixes"][0]["said"] == "thimble fix undone: Card counts rows"
    await fixes.dismiss_route(1, analyst)
    assert fixes.status()["fixes"] == []


async def test_use_it_now_waits_for_each_running_turn_and_the_fix_s_row_names_the_turn_it_waits_for(
        fixing, monkeypatch, analyst):
    """Use it now while main and a side thread work: the server starts again only once both turns ended, and until
    then the fix's row names the turn the restart waits for, by its workspace and its chat's name in the thread list."""
    api_key(monkeypatch, [text("Title: Card counts rows\nWhat it does: The card counts rows."),
                          text("Because of the deploy.")])
    await fixes.request(CORPUS, "count the rows", "")
    await _ended()
    tid = str(agents.new_thread(CORPUS, None, None, "why")["id"])
    events.post(CORPUS, "thread", {"thread": tid, "text": "Why did it fail?"})
    sp = runtime.ensure(CORPUS)
    fork = next(c for c in sp.convs.values() if c.kind == "fork" and c.role != fixes.FIXER)
    await fork.task
    # a turn of main's and a turn of the thread's that run
    main_ends, thread_ends = asyncio.Event(), asyncio.Event()
    sp.main.task = asyncio.ensure_future(main_ends.wait())
    fork.task = asyncio.ensure_future(thread_ends.wait())

    def waits() -> Any:
        [row] = fixes.status()["fixes"]
        return row["phase"], row["waits"]

    await fixes.apply_route(1, analyst)
    await _until(lambda: waits() == ("restarting", {"workspace": CORPUS, "name": "main"}),
                 "the row never named main's turn")
    main_ends.set()
    await _until(lambda: waits() == ("restarting", {"workspace": CORPUS, "name": "main/why"}),
                 "the row never named the thread's turn")
    assert fixing.restarts == [], "no restart while a turn runs"
    thread_ends.set()
    await _restarted(fixing, "the turns ended")
    assert waits() == ("restarting", None)


async def test_a_dev_install_run_from_its_clone_shows_a_fix_that_is_on_as_off_and_use_it_starts_it_from_live(
        fixing, analyst):
    # a dev install (scripts/install.sh --local), whose launcher started this server from the clone (this checkout)
    # after Use it now had started it from live, where fix 1 is on
    fixing.kind = "clone"
    app = fixes.live_root() / "backend" / "app"
    app.mkdir(parents=True)
    (app / "main.py").write_text("")
    fixing.recs[1] = {"id": 1, "title": "Bigger minimap button", "words": ["make the minimap button bigger"],
                      "state": "on", "commit": "f" * 40, "updated": 1.0}
    [row] = fixes.status(every=True)["fixes"]
    assert (row["state"], row["why"]) == ("off", fixes.NOT_HERE)
    # Use it leaves the fix as it is, which the kernel would not apply again, and starts the server from live
    await fixes.apply_route(1, analyst)
    await _went_on()
    await _restarted(fixing, "Use it")
    assert "apply" not in [c[0] for c in fixing.calls] and fixing.recs[1]["state"] == "on"
    assert fixing.restarts == [("fix 1: Bigger minimap button", fixes.live_root() / "backend")]
    fixes._phase.clear()
    # on, as before: when the clone holds the fix's commit (the person merged it there), and in a release install
    fixing.recs[1]["commit"] = subprocess.run(["git", "-C", str(config.REPO_ROOT), "rev-parse", "HEAD"],
                                              capture_output=True, text=True, check=True).stdout.strip()
    assert fixes.status(every=True)["fixes"][0]["state"] == "on"
    fixing.recs[1]["commit"] = "f" * 40
    fixing.kind = "release"
    assert fixes.status(every=True)["fixes"][0]["state"] == "on"


def _live_git(*args: str) -> str:
    """git in the made-up live checkout, as thimble makes its commits there."""
    return subprocess.run(["git", "-C", str(fixes.live_root().parent), "-c", "user.name=thimble",
                           "-c", "user.email=thimble@example.invalid", "-c", "commit.gpgsign=false", *args],
                          capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture()
def from_live(fixing, monkeypatch):
    """This server runs from live, a git checkout of made-up files, and started at live's first commit. The fixture
    gives `on(fid, title, path)`: a fix that changes `path` went on after that, somewhere else (y in a Claude Code
    session), as a commit of live and a record of the kernel's."""
    top = fixes.live_root().parent
    for path in ("browser/backend/app/main.py", "browser/frontend/src/App.tsx", "plugin/engine/thimble.py",
                 "plugin/bar/bar.tsx", "plugin/tray/tray.mjs"):
        (top / path).parent.mkdir(parents=True, exist_ok=True)
        (top / path).write_text("made up\n")
    _live_git("init", "-q", "-b", "mine")
    _live_git("add", "-A")
    _live_git("commit", "-q", "-m", "thimble")
    monkeypatch.setattr(config, "REPO_ROOT", fixes.live_root())
    monkeypatch.setattr(config, "BOOT_COMMIT", _live_git("rev-parse", "HEAD"))

    def on(fid: int, title: str, path: str) -> None:
        (top / path).write_text(f"made up, with fix {fid}\n")
        _live_git("commit", "-q", "-am", title)
        fixing.recs[fid] = {"id": fid, "title": title, "words": [title], "state": "on", "files": [{"path": path}],
                            "commit": _live_git("rev-parse", "HEAD"), "updated": float(fid)}

    return on


def _shown() -> dict[int, tuple[str, str | None]]:
    """Each fix of Your fixes: its state there, and why it is off."""
    return {r["id"]: (r["state"], r["why"]) for r in fixes.status(every=True)["fixes"]}


async def test_a_fix_that_went_on_in_the_terminal_after_this_server_started_is_off_here_until_use_it_starts_it_again(
        fixing, from_live, analyst, monkeypatch):
    from_live(1, "Bigger minimap button", "browser/frontend/src/App.tsx")
    from_live(2, "Bar says read", "plugin/bar/bar.tsx")
    from_live(3, "Tray keeps its order", "plugin/tray/tray.mjs")
    # the fix to the page and the fix to a module of the plugin the page bundles are not in the code this server runs;
    # the fix to the terminal plugin alone is on, as the server runs none of it
    assert _shown() == {1: ("off", fixes.NOT_YET), 2: ("on", None), 3: ("off", fixes.NOT_YET)}
    # Use it leaves the fix as it is, which the kernel would not apply again, and starts the server again from live
    await fixes.apply_route(1, analyst)
    await _went_on()
    await _restarted(fixing, "Use it")
    assert "apply" not in [c[0] for c in fixing.calls] and fixing.recs[1]["state"] == "on"
    assert fixing.restarts == [("fix 1: Bigger minimap button", fixes.live_root() / "backend")]
    fixes._phase.clear()
    # the server that started again is at live's commit now: every fix is on
    booted = config.BOOT_COMMIT
    monkeypatch.setattr(config, "BOOT_COMMIT", _live_git("rev-parse", "HEAD"))
    assert _shown() == {1: ("on", None), 2: ("on", None), 3: ("on", None)}
    # and stays on when its commit was made anew with the same change (another fix went off), which the commit the
    # server started at does not hold
    fixing.recs[1]["commit"] = "f" * 40
    assert _shown()[1] == ("on", None)
    # a fix that went on before the server started and one after it, in the same file: only the later one is off
    from_live(4, "Minimap button has a label", "browser/frontend/src/App.tsx")
    fixing.recs[1]["commit"] = config.BOOT_COMMIT
    assert (_shown()[1], _shown()[4]) == (("on", None), ("off", fixes.NOT_YET))
    # a copy without git knows no commit of its start: each fix is on, as before, and Use it asks the kernel
    monkeypatch.setattr(config, "BOOT_COMMIT", "")
    assert set(_shown().values()) == {("on", None)} and fixes.on_elsewhere(4) is None
    monkeypatch.setattr(config, "BOOT_COMMIT", booted)
    assert fixes.on_elsewhere(4)["id"] == 4 and fixes.on_elsewhere(2) is None


def test_the_kernel_names_the_browser_s_restart_for_the_plugin_files_this_server_runs():
    # two lists, one in each program: a fix to one of these files is stale in a thimble-browser that runs
    import ast  # noqa: PLC0415

    tree = ast.parse((config.REPO_ROOT.parent / "plugin" / "engine" / "kernel" / "fixes.py").read_text())
    [theirs] = [ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "BROWSER_RUNS" for t in n.targets)]
    assert sorted(theirs) == sorted(fixes.BROWSER_RUNS)
    assert all(p in fixes.BROWSER_RUNS for p in fixes.PAGE_SOURCES if p.startswith("plugin/"))
    assert all(p in fixes.BROWSER_RUNS for p in fixes.SERVER_KEEPS)


def test_the_page_s_sources_are_the_files_its_modules_import():
    # every file outside browser/frontend that the page's modules import, and those import: a fix to one is in the page
    # only after a build, so each is a page source, and the plugin's among them are in BROWSER_RUNS by that
    top = config.REPO_ROOT.parent
    src = config.REPO_ROOT / "frontend" / "src"
    spec = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|@import\s+(?:url\()?)['"](\.{1,2}/[^'"?]+)""")
    ends = ("", ".ts", ".tsx", ".js", ".mjs", ".json", ".css", "/index.ts", "/index.tsx", "/index.js")
    todo = [f for f in src.rglob("*") if f.suffix in (".ts", ".tsx", ".js", ".mjs", ".css") and ".test." not in f.name]
    assert len(todo) > 50
    seen, outside = set(todo), set()
    while todo:
        f = todo.pop()
        for rel in spec.findall(f.read_text("utf-8")):
            hit = next((t for e in ends if (t := Path(os.path.normpath(f"{f.parent / rel}{e}"))).is_file()), None)
            if hit is None or hit in seen:
                continue
            seen.add(hit)
            if not hit.is_relative_to(config.REPO_ROOT / "frontend"):
                outside.add(hit.relative_to(top).as_posix())
            if hit.suffix != ".json":
                todo.append(hit)
    assert sorted(outside) == sorted(fixes.PAGE_SOURCES[1:])


def test_each_file_of_the_plugin_the_server_names_is_one_it_keeps_or_reads_at_each_use():
    # the server's code names the terminal plugin's files by path. One it loads once (SERVER_KEEPS) is stale in a
    # server that runs after a fix changes it; one it reads or starts at each use is as live has it at once. A path
    # that is new here belongs in one of the two.
    at_each_use = {
        "engine/thimble.py",  # the kernel: a process for each call
        "sandbox",  # setup.mjs: a process for each call
        "prompts",  # the texts: read for each prompt
        ".claude-plugin/plugin.json",  # read for each report
    }
    keeps = {p.removeprefix("plugin/") for p in fixes.SERVER_KEEPS}
    chain = re.compile(r'''(?:plugin_dir\(\)|\bPLUGIN\b|(?<!REPO_ROOT / )"plugin")((?:\s*/\s*"[^"]+")+)''')
    named = {"/".join(re.findall(r'"([^"]+)"', tail))
             for f in (config.REPO_ROOT / "backend" / "app").glob("*.py") for tail in chain.findall(f.read_text("utf-8"))}
    assert keeps <= named, "SERVER_KEEPS holds a file the server no longer names"
    assert named - keeps - at_each_use == set()
    # a module the server imports brings in no other file of the plugin: the validator is the standard library alone
    import ast  # noqa: PLC0415

    for mod in (config.REPO_ROOT.parent / p for p in fixes.SERVER_KEEPS if p.endswith(".py")):
        for n in ast.walk(ast.parse(mod.read_text("utf-8"))):
            names = [a.name for a in n.names] if isinstance(n, ast.Import) else []
            if isinstance(n, ast.ImportFrom):
                assert not n.level, f"{mod.name} imports a module beside it"
                names = [n.module or ""]
            assert not any((mod.parent / f"{x.split('.')[0]}.py").is_file() for x in names)


def test_a_fixers_end_in_a_code_fence_leaves_the_fence_out():
    end = fixes.end_of("It already is.\n\n```\nTitle: Bar word is bold\nRequest: The bar's word is bold already.\n```")
    assert end == {"title": "Bar word is bold", "summary": "The bar's word is bold already.", "request": True}


def test_a_page_with_no_build_to_take_is_built_without_a_second_type_check(monkeypatch, tmp_path):
    # live's page after the person's click, with no build of its sources to take (prepare): the checks of each fix ran
    # the type check, so the person waits for the page's build alone
    root = tmp_path / "browser"
    fe = root / "frontend"
    fe.mkdir(parents=True)
    monkeypatch.setattr(fixes, "lend", lambda root: None)
    monkeypatch.setattr(fixes, "page_tree", lambda fe: "")
    monkeypatch.setattr(fixes.shutil, "which", lambda name: f"/usr/bin/{name}")
    ran: list[tuple[list[str], Any]] = []
    ends = [subprocess.CompletedProcess([], 0, "built in 9s\n", "")]

    def run(argv: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        ran.append(([str(a) for a in argv], kw.get("cwd")))
        return ends[0]

    monkeypatch.setattr(fixes.subprocess, "run", run)
    assert fixes.prepare(root) == ""
    assert ran == [([str(fe / "node_modules" / ".bin" / "vite"), "build"], fe)]
    # a page that does not build: the row says what the build said failed, not the heading above it
    ends[0] = subprocess.CompletedProcess([], 1, "transforming...\n", (
        'x Build failed in 2s\nerror during build:\nsrc/App.tsx (3:9): "Gone" is not exported by "src/chat/fix.ts", '
        'imported by "src/App.tsx".\n    at getRollupError (parseAst.js:317:41)\n'))
    assert '"Gone" is not exported by "src/chat/fix.ts"' in fixes.prepare(root)
    # no Node to run the build with: the row says so, and nothing ran
    del ran[:]
    monkeypatch.setattr(fixes.shutil, "which", lambda name: None)
    assert "Node" in fixes.prepare(root) and not ran


def test_the_fixer_of_another_try_reads_how_the_last_try_s_tests_ended_and_where_their_whole_output_is(tmp_path):
    # the kernel's refusal of a change whose tests failed stays on the fix's record: the next fixer reads the failure
    # in its first message and does not run the tests again to see it
    log = tmp_path / "tests.log"
    log.write_text("all of it")
    tests = "page: unit tests (failed after 11 s)\n FAIL  tests/public/bar.test.ts > the bar says rows"
    rec = {"id": 3, "title": "Bar says rows", "words": ["make the bar say rows"], "work": "/made-up/fixes/work/3",
           "same_copy": True, "error": "its tests failed in the sandbox",
           "refused": {"why": "its tests failed in the sandbox", "files": [], "tests": tests, "log": str(log)}}
    again = fixes.first_message(rec, "the page", earlier=True)
    assert "The last try did not pass because its tests failed in the sandbox." in again
    assert f"The end of the output of the last try's tests:\n\n{tests}\n\n" in again
    assert f"Their whole output is in {log}. Fix what fails." in again
    # a log that is gone is not named, and a first try is told of no tests
    log.unlink()
    assert "whole output" not in fixes.first_message(rec, "the page", earlier=True)
    assert "last try" not in fixes.first_message(rec, "the page")


def test_the_end_of_a_fix_s_tests_keeps_the_line_that_names_the_check_when_it_is_cut():
    head = "page: unit tests (failed after 11 s)"
    cut = fixes.tail_of(head + "\n" + "a line the tests printed\n" * 400 + "the last line")
    assert cut.startswith(head + "\n…") and cut.endswith("the last line")
    assert len(cut) <= fixes.TAIL_CHARS + 2
    assert fixes.tail_of(head + "\nthe last line\n") == head + "\nthe last line"
