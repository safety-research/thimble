"""A code ticket (app/dev.py, app/ticket_tools.py): its agent is a `thimble:dev-ticket`, a subagent of main, started
through thimble's module for the analyst's click or by main's exact Agent call for main's file_dev_ticket. It works in
the ticket's worktree, checks with `ticket_checks` and finishes with `finish_ticket`, where the server commits its change
and runs the gates of record, counting the attempts; its end is the backstop. Contained, the gates and the ticket's
server run in a box (app/ticket_box.py) and the analyst is asked only before the change reaches thimble's own code;
where the box can't run the analyst is asked before it starts as well. The server's git commands in its worktree run
hardened.

The module is the fake bridge (subagent_fakes); the agent's calls are made through tools.call with the caller hook's
line written first, as the PreToolUse hook writes it, and its end is subagents.run_ended, as the mirror or the module's
`ended` post ends a run. The gates are faked unless a test says otherwise."""
from __future__ import annotations

import asyncio
import json
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import UI_KEY, _record, card_wait
from fastapi import HTTPException
from starlette.requests import Request

from app import agent_session, agents, config, dev, hook_auth, ledger, modes, subagents, ticket_box, tools
from app import subagent_files as sf
from subagent_fakes import bridge, hints  # noqa: F401 — fixtures

CORPUS = "mini"
BACKEND = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, monkeypatch):
    agent_session._hosted.clear()
    monkeypatch.setattr(dev, "_current", None)
    yield
    agent_session._hosted.clear()


async def _question(chat: str, seen: tuple[str, ...] = ()) -> dict:
    for _ in range(500):
        live = [p for p in agents.read_meta(CORPUS, chat).get("permissions") or []
                if not p.get("expired") and p.get("id") not in seen]
        if live:
            return live[0]
        await asyncio.sleep(0.01)
    raise AssertionError("no question on the card")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null",
                           *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def _repo(tmp_path: Path) -> Path:
    """A checkout like thimble's: its .gitignore names the venv and node_modules folders (the latter as a folder, which
    the worktree's link to it is not), and both are there for a worktree to link to."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("a\n")
    (repo / ".gitignore").write_text("backend/.venv\nfrontend/node_modules/\n")
    (repo / "backend" / ".venv").mkdir(parents=True)
    (repo / "frontend" / "node_modules").mkdir(parents=True)
    _git(repo, "add", "README.md", ".gitignore")
    _git(repo, "commit", "-qm", "a")
    return repo


@pytest.fixture()
def ticketing(tmp_path, monkeypatch, bridge, hints):
    """A development install in a scratch git repository whose tickets run contained, with the before and after shots
    and the gates faked: the gates pass unless the worktree's README says FAIL. The trees the gates ran over and the
    boxes they ran in."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    repo = _repo(tmp_path)
    monkeypatch.setattr(dev, "REPO", repo)
    monkeypatch.setattr(dev, "DEV_DIR", tmp_path / "dev-records")
    monkeypatch.setattr(dev, "STACK_ENABLED", True)
    monkeypatch.setattr(ticket_box, "works", lambda: True)
    seen: list = []

    async def gates(tree, touched, *, scratch=None, box=None):
        seen.append((Path(tree), touched, box))
        ok = "FAIL" not in (Path(tree) / "README.md").read_text()
        return {"ok": ok, "steps": [{"name": "pytest", "ok": ok, "tail": "" if ok else "README says FAIL"}]}

    async def no_shot(*_a, **_k):
        return None

    monkeypatch.setattr(dev, "run_gates", gates)
    monkeypatch.setattr(dev, "_preview_shot", no_shot)
    monkeypatch.setattr(dev, "_take_shot", no_shot)
    return {"repo": repo, "gates": seen, "bridge": bridge}


async def _until(cond, what: str, tries: int = 500) -> None:
    for _ in range(tries):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


async def _call(tool: str, agent: str, tid: str, args: dict | None = None, n: list[int] = [0]) -> tools.ToolResult:  # noqa: B006
    """A call of `tool` by the agent `agent`, whose calls run as the ticket's key, the caller hook's line written first."""
    n[0] += 1
    use = f"toolu_k{n[0]:06d}"
    a = subagents.agent(CORPUS, agent) or {}
    sf.add_caller(config.workspace_dir(CORPUS), use, agent, str(a.get("type") or "thimble:orient-helper"))
    return await tools.call(CORPUS, tool, args or {}, session=dev.ticket_key(tid), tool_use_id=use)


async def _clicked_ticket(title: str = "Bigger font") -> tuple[dict, str]:
    """A ticket the analyst filed in the browser, started through the module: the ticket and its agent's id."""
    t = dev.file_ticket(CORPUS, title, "the labels are small", source="ui")
    await _until(lambda: (dev._get(t["id"]) or {}).get("agent_id"), "the ticket's agent did not start")
    return dev._get(t["id"]), str(dev._get(t["id"])["agent_id"])


def _click(path: str = "/") -> Request:
    """A click from the analyst's browser on localhost: it carries the cookie of the test server's ui_key."""
    _record(ui_key=UI_KEY)
    return Request({"type": "http", "path": path, "client": ("127.0.0.1", 1),
                    "headers": [(b"cookie", f"{hook_auth.ui_cookie()}={UI_KEY}".encode())]})


async def test_a_click_prepares_the_ticket_and_starts_its_agent_through_the_module_in_its_thread(ticketing):
    """A ticket filed in the browser gets its worktree, under the folder of worktrees main's fence lets subagents write,
    and its agent's own folder, then a `thimble:dev-ticket` through the module on the dev row's model and effort, whose
    prompt names the worktree; the agent's chat is the ticket's thread."""
    t, agent = await _clicked_ticket()
    [spawn] = ticketing["bridge"].ops("spawn")
    assert spawn["role"] == "dev-ticket" and spawn["route"] == subagents.CLICK
    assert spawn["values"] == subagents.values_for(CORPUS, "dev-ticket") == {
        "model": config.models_for(CORPUS)["dev"]["model"], "effort": config.models_for(CORPUS)["dev"]["effort"]}
    wt = Path(t["worktree"])
    assert wt.parent == dev.worktrees_dir() and wt.is_dir() and dev.ticket_work_dir(t["id"]).is_dir()
    assert str(wt) in spawn["prompt"] and spawn["description"] == f"ticket #{t['n']}: Bigger font"
    meta = agents.read_meta(CORPUS, t["chat"])
    assert (meta["route"], meta["agent_id"], meta["agent_type"], meta["ticket"]) == (
        "subagent", agent, "thimble:dev-ticket", t["id"]), "the agent's chat is the ticket's thread"
    assert subagents.agent(CORPUS, agent)["key"] == dev.ticket_key(t["id"]) and t["in_box"] is True
    assert dev._current is not None and dev._current.agent == agent
    from app import tray

    [row] = [r for r in tray.subagent_rows(CORPUS) if r["role"] == "dev-ticket"]
    assert (row["name"], row["label"]) == ("thimble:dev-ticket", f"code ticket: #{t['n']} Bigger font")


async def test_the_agent_checks_finishes_and_the_analyst_s_allow_applies_the_change_that_passed(ticketing):
    """The agent checks its change with ticket_checks, which commits nothing, and finishes with finish_ticket, where
    the server commits every change in the worktree and runs the gates of record in the box. After its end the worktree
    is put back to the commit that passed, and the card asks before the merge, in Bypass too: a no keeps the change on
    the ticket's branch, an Allow merges that commit and nothing the agent wrote after its pass."""
    repo = ticketing["repo"]
    ledger.put_settings(CORPUS, {modes.SETTING: {"dev": "bypass"}})
    live = _git(repo, "rev-parse", "HEAD")
    for answer in ("no", "yes"):
        t, agent = await _clicked_ticket()
        wt = Path(t["worktree"])
        (wt / "README.md").write_text("b\n")
        res = await _call("ticket_checks", agent, t["id"])
        assert not res.is_error and "The checks pass." in res.text and dev.touched_files(wt) == ["README.md"]
        res = await _call("finish_ticket", agent, t["id"])
        assert not res.is_error and "thimble asks the analyst" in res.text
        rec = dev._get(t["id"])
        assert rec["finish"]["result"] == "pass" and rec["change"] == _git(wt, "rev-parse", "HEAD") != rec["base"]
        assert dev.touched_files(wt) == [] and rec["touched"] == ["README.md"]
        assert (wt / "frontend" / "node_modules").is_symlink(), "the links stay out of the commit"
        assert _git(wt, "show", "--name-only", "--format=", "HEAD") == "README.md"
        assert all(isinstance(b, ticket_box.Box) for _, _, b in ticketing["gates"])
        (wt / "late.txt").write_text("written after the pass\n")
        subagents.run_ended(CORPUS, agent, "done", "The font is bigger.", source="handback")
        q = await _question(t["chat"])
        assert (q["tool"], q["what"]) == (dev.CODE_TOOL, dev.APPLY_QUESTION) and "README.md" in q["why"]
        assert _git(repo, "rev-parse", "HEAD") == live and not (wt / "late.txt").exists()
        assert agents.read_meta(CORPUS, t["chat"])["status"] == "running", "the thread runs until the ticket ends"
        assert agent_session.answer(CORPUS, t["chat"], q["id"], answer == "yes")
        await _until(lambda: dev._get(t["id"]).get("finished"), "the ticket did not end")
        rec = dev._get(t["id"])
        branch = f"dev/{t['id']}"
        if answer == "no":
            assert (rec["status"], rec["error"]) == ("stopped", dev.APPLY_NOT_ALLOWED.format(branch=branch))
            assert _git(repo, "rev-parse", "HEAD") == live and _git(repo, "rev-parse", branch) != live
        else:
            assert rec["status"] == "applied" and (repo / "README.md").read_text() == "b\n"
            assert not (repo / "late.txt").exists() and not _git(repo, "branch", "--list", branch)
            assert agents.read_meta(CORPUS, t["chat"])["status"] == "done"
        assert not wt.exists() and not dev.ticket_work_dir(t["id"]).exists() and dev._current is None


async def test_finish_ticket_counts_its_attempts_and_only_the_ticket_s_agent_may_call_it(ticketing, bridge):
    """A failed gate answers what failed and the attempt, as an error result; the last failure, and any call after it,
    tells the agent to stop, and its end fails the ticket with what the checks found. A call with no change counts no
    attempt. Main, and any other agent, are refused the ticket's tools."""
    t, agent = await _clicked_ticket()
    wt = Path(t["worktree"])
    res = await _call("finish_ticket", agent, t["id"])
    assert res.is_error and "holds no change" in res.text and dev._get(t["id"])["attempt"] == 0
    (wt / "README.md").write_text("FAIL\n")
    for n in range(1, dev.MAX_ATTEMPTS):
        res = await _call("finish_ticket", agent, t["id"])
        assert res.is_error and f"attempt {n} of {dev.MAX_ATTEMPTS}" in res.text and "README says FAIL" in res.text
    res = await _call("finish_ticket", agent, t["id"])
    assert res.is_error and "No attempt is left" in res.text
    ran = len(ticketing["gates"])
    assert (await _call("finish_ticket", agent, t["id"])).is_error and len(ticketing["gates"]) == ran, \
        "a call after the last attempt runs nothing"
    main = await tools.call(CORPUS, "finish_ticket", {}, tool_use_id="toolu_main_finish")
    assert main.is_error and "not that agent's" in main.text
    other = await bridge.request(CORPUS, "spawn")  # an agent of another role, registered for the ticket's key: refused
    with subagents.update(CORPUS) as state:
        sf.registry(state)[other["agentId"]] = {"key": dev.ticket_key(t["id"]), "type": "thimble:check", "role": "check",
                                                "status": "running", "started": 0}
    assert (await _call("ticket_checks", other["agentId"], t["id"])).is_error
    subagents.mark_stopped_by(CORPUS, agent, subagents.STOPPED_ANALYST)  # thimble's own stop after its last attempt
    subagents.run_ended(CORPUS, agent, "stopped", "It still fails.", source="module")
    await _until(lambda: dev._get(t["id"])["status"] == "failed", "the ticket did not fail")
    assert "README says FAIL" in dev._get(t["id"])["error"] and not wt.exists()


async def test_an_agent_thimble_stops_after_its_pass_still_passed_and_the_analyst_s_stop_stops_it(ticketing, bridge):
    """An agent still running after its pass is stopped by thimble (view_tools.FINISH_GRACE_S), and the ticket goes on
    to the analyst's Allow; the analyst's own Stop after a pass ends the ticket stopped, with nothing applied."""
    for stop in ("grace", "analyst"):
        t, agent = await _clicked_ticket()
        (Path(t["worktree"]) / "README.md").write_text("e\n")
        assert not (await _call("finish_ticket", agent, t["id"])).is_error
        if stop == "analyst":
            assert (await dev.stop_ticket(t["id"], _click()))["ok"]
        else:
            await subagents.stop(CORPUS, agent)
        subagents.run_ended(CORPUS, agent, "stopped", "", source="module")
        if stop == "grace":
            q = await _question(t["chat"])
            assert q["what"] == dev.APPLY_QUESTION
            assert agent_session.answer(CORPUS, t["chat"], q["id"], False)
        await _until(lambda: dev._get(t["id"]).get("finished"), "the ticket did not end")
        rec = dev._get(t["id"])
        assert rec["status"] == "stopped", rec
        assert (rec["error"] or "").startswith("the analyst did not allow") if stop == "grace" else rec["error"] is None


async def test_an_agent_that_ends_without_finish_ticket_gets_the_gates_once(ticketing):
    """The backstop: an agent that ended without calling finish_ticket but left a change gets the gates of record once,
    and a pass goes on to the analyst's Allow; one that made no change fails with its own last words."""
    t, agent = await _clicked_ticket()
    (Path(t["worktree"]) / "README.md").write_text("c\n")
    subagents.run_ended(CORPUS, agent, "done", "Done.", source="handback")
    q = await _question(t["chat"])
    assert q["what"] == dev.APPLY_QUESTION and dev._get(t["id"])["finish"]["result"] == "pass"
    assert agent_session.answer(CORPUS, t["chat"], q["id"], True)
    await _until(lambda: dev._get(t["id"])["status"] == "applied" and dev._get(t["id"]).get("finished"),
                 "the ticket was not applied")
    t, agent = await _clicked_ticket("Not doable")
    subagents.run_ended(CORPUS, agent, "done", "This cannot be done safely: it needs a new dependency.", source="handback")
    await _until(lambda: dev._get(t["id"])["status"] == "failed", "the ticket did not fail")
    assert dev._get(t["id"])["error"] == f"{dev.NO_CHANGE_LINE}: This cannot be done safely: it needs a new dependency."


async def test_main_s_file_dev_ticket_prepares_the_ticket_and_gives_the_exact_agent_call(ticketing, bridge):
    """Main's file_dev_ticket prepares the ticket, then answers the exact Agent call, which thimble's hook lets through
    and auto mode judges as main makes it; the agent it starts takes the ticket's thread. A second ticket main files while
    one runs waits for the analyst's Start on its card, which starts it through the module once the first ends."""
    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Bigger font", "body": "the labels are small"},
                           tool_use_id="toolu_main1")
    assert not res.is_error and "\nFiled ticket #1: Bigger font. AGENT CALL " in res.text, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    assert inp["subagent_type"] == "thimble:dev-ticket" and "model" not in inp
    assert not bridge.ops("spawn"), "main makes the call, not the module"
    [t] = [x for x in dev._read() if x["title"] == "Bigger font"]
    assert t["status"] == "running" and Path(t["worktree"]).is_dir() and t["route"] == "typed"
    rid = sf.REQUEST_RE.search(inp["prompt"].split("\n", 1)[0]).group(0)
    assert t["request"] == rid and subagents.request(CORPUS, rid)["route"] == subagents.TYPED
    with subagents.update(CORPUS) as state:
        assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": "toolu_x", "tool_input": inp}) is None
        sf.register(state, {"agent_id": "a0000000000000ticket", "agent_type": "thimble:dev-ticket", "session_id": "s"})
    subagents.ensure_chat(CORPUS, "a0000000000000ticket")
    assert dev._get(t["id"])["agent_id"] == "a0000000000000ticket"
    assert agents.read_meta(CORPUS, t["chat"])["agent_id"] == "a0000000000000ticket"

    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "Wider pane", "body": "the pane is narrow"},
                           tool_use_id="toolu_main2")
    assert "one at a time" in res.text and "Start on its card" in res.text and "AGENT CALL" not in res.text
    [w] = [x for x in dev._read() if x["title"] == "Wider pane"]
    assert (w["status"], w["held"]) == ("queued", True)
    with pytest.raises(HTTPException) as e:
        await dev.start_ticket(w["id"], Request({"type": "http", "client": ("127.0.0.1", 1), "headers": []}))
    assert e.value.status_code == 403, "Start is the analyst's click"
    await dev.start_ticket(w["id"], _click())
    assert dev._get(w["id"])["status"] == "queued" and not dev._get(w["id"])["held"], "it waits for the running one"
    subagents.run_ended(CORPUS, "a0000000000000ticket", "done", "nothing to do", source="handback")
    await _until(lambda: (dev._get(w["id"]) or {}).get("agent_id"), "the waiting ticket did not start")
    assert bridge.ops("spawn")[-1]["route"] == subagents.CLICK


async def test_stop_stops_the_agent_through_the_module_and_main_s_quit_stops_it_with_retry(ticketing, bridge):
    """Stop on a running ticket stops its agent through main's module, and its end leaves the ticket stopped with its
    branch and no worktree; main's quit stops a ticket's agent with main, and the ticket says so (MAIN_ENDED). Retry
    runs it again in a new thread."""
    t, agent = await _clicked_ticket()
    assert (await dev.stop_ticket(t["id"], _click()))["ok"]
    assert bridge.ops("stop")[-1]["agent"] == agent
    subagents.run_ended(CORPUS, agent, "stopped", "stopped", source="module")
    await _until(lambda: dev._get(t["id"])["status"] == "stopped", "the ticket did not stop")
    assert not Path(t["worktree"]).exists() and dev._get(t["id"])["error"] is None
    old_chat = dev._get(t["id"])["chat"]
    await dev.retry_ticket(t["id"], _click())
    await _until(lambda: dev._get(t["id"])["agent_id"] not in (None, agent), "Retry did not start a new agent")
    new_agent = dev._get(t["id"])["agent_id"]
    assert dev._get(t["id"])["chat"] != old_chat
    subagents.close_running(CORPUS)
    await _until(lambda: dev._get(t["id"])["status"] == "stopped", "main's quit did not stop the ticket")
    assert dev._get(t["id"])["error"] == dev.MAIN_ENDED and subagents.agent(CORPUS, new_agent)["status"] == "stopped"


async def test_plan_mode_s_stop_ends_the_ticket_stopped_saying_why_and_to_choose_retry(ticketing, bridge):
    """U4: thimble stopped the ticket's agent through the module when main went into plan mode: the ticket ends stopped,
    and the ticket and its thread say why and to choose Retry once main leaves plan mode; nothing starts again."""
    t, agent = await _clicked_ticket()
    assert await subagents.stop_for_plan(CORPUS) == [agent]
    assert bridge.ops("stop")[-1]["agent"] == agent
    subagents.run_ended(CORPUS, agent, "stopped", "", source="notification")
    await _until(lambda: dev._get(t["id"])["status"] == "stopped", "the ticket did not stop")
    line = subagents.plan_line("dev-ticket")
    assert dev._get(t["id"])["error"] == line and "plan mode" in line and "Retry on the ticket" in line
    assert agents.read_meta(CORPUS, t["chat"])["result"] == line, "its thread ends saying why"
    assert len(bridge.ops("spawn")) == 1, "nothing starts again by itself"


async def test_a_restarted_server_takes_up_the_running_agent_and_asks_again_for_a_change_that_passed(ticketing):
    """After a server restart, a ticket whose agent still runs in main is the server's run again; one whose agent
    passed while no server ran is settled, its Allow asked again; one whose agent ended without a pass, or whose
    preparation the restart cut short, ends stopped with Retry."""
    t, agent = await _clicked_ticket()
    (Path(t["worktree"]) / "README.md").write_text("d\n")
    assert not (await _call("finish_ticket", agent, t["id"])).is_error
    dev._current = None  # the server restarted
    dev._recover()
    assert dev._current is not None and dev._current.agent == agent and dev._current.task is None
    with subagents.update(CORPUS) as state:
        sf.registry(state)[agent]["status"] = "done"  # it handed back while no server ran
    dev._current = None
    dev._recover()
    q = await _question(t["chat"])
    assert q["what"] == dev.APPLY_QUESTION
    assert agent_session.answer(CORPUS, t["chat"], q["id"], True)
    await _until(lambda: dev._get(t["id"])["status"] == "applied" and dev._get(t["id"]).get("finished"),
                 "the ticket was not applied")
    gone = dev.file_ticket(CORPUS, "Cut short", "x", start=False)
    dev._update(gone["id"], status="running", agent_id="a00000000000000gone")
    orphan = dev.file_ticket(CORPUS, "Prepared", "y", start=False)
    dev._update(orphan["id"], status="running")
    dev._current = None
    dev._recover()
    assert (dev._get(gone["id"])["status"], dev._get(gone["id"])["error"]) == ("stopped", dev.TICKET_ORPHANED)
    assert (dev._get(orphan["id"])["status"], dev._get(orphan["id"])["error"]) == ("stopped", dev.TICKET_CUT_SHORT)


async def test_a_release_install_registers_no_ticket_agent_and_main_hears_why(ticketing, tmp_path, monkeypatch):
    """Code tickets run only in a development install: elsewhere the module registers no `thimble:dev-ticket`, the
    browser offers no ticket, and main's file_dev_ticket fails at once with the reason."""
    assert "dev-ticket" in subagents.roles(CORPUS) and dev.tickets_run_here(CORPUS)
    monkeypatch.setattr(dev, "REPO", tmp_path / "installed")
    assert "dev-ticket" not in subagents.roles(CORPUS) and not dev.tickets_run_here(CORPUS)
    assert (await dev.status())["tickets"] == dev.RELEASE_LINE
    res = await tools.call(CORPUS, "file_dev_ticket", {"title": "x", "body": "y"}, tool_use_id="toolu_main3")
    assert "cannot run here" in res.text and dev.RELEASE_LINE in res.text


async def test_a_ticket_the_box_cannot_run_asks_before_it_starts_and_again_before_its_change_is_applied(ticketing,
                                                                                                      monkeypatch):
    """Where the box can't run, the ticket's code runs outside the sandbox during its checks, so the analyst is asked
    before it starts, and, like any ticket, again before its change reaches thimble's own code."""
    monkeypatch.setattr(ticket_box, "works", lambda: False)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(dev, "start_stack", nothing)
    monkeypatch.setattr(dev, "stop_stack", nothing)
    t = dev.file_ticket(CORPUS, "Bigger font", "the labels are small", source="ui")
    q = await _question(t["chat"])
    assert q["what"] == dev.CODE_QUESTION and not dev._get(t["id"]).get("worktree")
    assert agent_session.answer(CORPUS, t["chat"], q["id"], True)
    await _until(lambda: (dev._get(t["id"]) or {}).get("agent_id"), "the agent did not start")
    t = dev._get(t["id"])
    (Path(t["worktree"]) / "README.md").write_text("b\n")
    assert not (await _call("finish_ticket", t["agent_id"], t["id"])).is_error
    assert all(b is None for _, _, b in ticketing["gates"])
    subagents.run_ended(CORPUS, t["agent_id"], "done", "done", source="handback")
    q2 = await _question(t["chat"], (q["id"],))
    assert q2["what"] == dev.APPLY_QUESTION
    assert agent_session.answer(CORPUS, t["chat"], q2["id"], True)
    await _until(lambda: dev._get(t["id"])["status"] == "applied" and dev._get(t["id"]).get("finished"),
                 "the ticket was not applied")
    assert (ticketing["repo"] / "README.md").read_text() == "b\n"


def test_the_box_reads_nothing_its_worktree_s_links_point_to(tmp_path):
    """The session can change its worktree's links to the live venv and node_modules: what the box may read is taken
    from the live checkout, and nothing runs in the box once a link leads elsewhere."""
    live, tree, elsewhere = tmp_path / "live", tmp_path / "tree", tmp_path / "elsewhere"
    for d in (live / "backend" / ".venv", live / "frontend" / "node_modules", tree / "backend", tree / "frontend",
              elsewhere):
        d.mkdir(parents=True)
    (tree / "backend" / ".venv").symlink_to(live / "backend" / ".venv")
    (tree / "frontend" / "node_modules").symlink_to(elsewhere)
    box = ticket_box.Box(tree, tmp_path / "cache", tmp_path / "srt", live=live)
    reads = box.settings()["filesystem"]["allowRead"]
    assert str(live / "frontend" / "node_modules") in reads and not any(r.startswith(str(elsewhere)) for r in reads)
    assert asyncio.run(ticket_box.run(box, ["true"], cwd=tree, timeout=5)) == (
        -1, ticket_box.LINK_MOVED.format(link="frontend/node_modules"))


async def test_a_ticket_the_box_cannot_run_asks_before_it_starts_and_a_no_stops_it_before_its_worktree(monkeypatch,
                                                                                                     bridge):
    """Where the box can't run, the question before the ticket starts waits on its card in Bypass too, with thimble's
    reason; a no stops the ticket before its worktree exists, and a ticket with no workspace never starts."""
    ledger.put_settings(CORPUS, {modes.SETTING: {"dev": "bypass"}})
    t = dev.file_ticket(CORPUS, "Fix the chart", "the bars are cut off", start=False)
    agent_session.host(CORPUS, dev.ticket_key(t["id"]), t["chat"], agent="dev")
    allowed = asyncio.ensure_future(dev._code_refusal(t))
    q = await _question(t["chat"])
    assert (q["tool"], q["what"]) == (dev.CODE_TOOL, dev.CODE_QUESTION) and "every permission mode" in q["why"]
    assert agent_session.answer(CORPUS, t["chat"], q["id"], True)
    assert await allowed == ""
    denied = asyncio.ensure_future(dev._code_refusal(t))
    assert agent_session.answer(CORPUS, t["chat"], (await _question(t["chat"]))["id"], False)
    assert await denied == dev.CODE_NOT_ALLOWED
    wait = card_wait(0.005)
    agent_session.host(CORPUS, dev.ticket_key(t["id"]), t["chat"], agent="dev")
    assert await dev._code_refusal(t) == dev.CODE_UNANSWERED.format(wait=agent_session.wait_words(wait)), \
        "a question nobody answers says so, not that the analyst refused"

    async def no(_t):
        return dev.CODE_NOT_ALLOWED

    def never(*_a, **_k):
        raise AssertionError("a worktree for a ticket the analyst did not allow")

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(ticket_box, "works", lambda: False)
    monkeypatch.setattr(dev, "ticket_problem", lambda: "")
    monkeypatch.setattr(dev, "_code_refusal", no)
    monkeypatch.setattr(dev, "create_worktree", never)
    monkeypatch.setattr(dev, "stop_stack", nothing)
    run = dev.Run(ticket_id=t["id"], title=t["title"], ts_start="", workspace=CORPUS)
    await dev._launch_ticket(run, t, subagents.CLICK)
    rec = dev._get(t["id"])
    assert (rec["status"], rec["error"]) == ("stopped", dev.CODE_NOT_ALLOWED)
    await dev._launch_ticket(run, {**t, "workspace": None}, subagents.CLICK)
    rec = dev._get(t["id"])
    assert (rec["status"], rec["error"]) == ("stopped", dev.CODE_NOBODY)


def test_the_server_runs_no_git_in_a_worktree_that_points_elsewhere(monkeypatch, tmp_path):
    """The session can write its worktree and the worktree's own git folder. The server's git commands there run with
    no fsmonitor and no hooks, name the git folders themselves, and don't run at all once `.git` or the git folder's
    commondir names another git folder, whose config could run a command."""
    repo, marker = _repo(tmp_path), tmp_path / "ran-outside"
    monkeypatch.setattr(dev, "REPO", repo)
    wt, _branch, _base = dev.create_worktree("t9")
    pointer = (wt / ".git").read_text()
    own = Path(pointer.removeprefix("gitdir: ").strip())
    (own / "config.worktree").write_text("")  # what Claude Code's sandbox leaves there
    assert dev.touched_files(wt) == []
    (own / "config.worktree").write_text(f"[core]\n\tfsmonitor = touch {marker}; false\n")
    with pytest.raises(dev.GitError, match="a config of its own"):
        dev.touched_files(wt)
    (own / "config.worktree").unlink()
    evil = wt / ".evil"
    _git(wt, "init", "-q", "--bare", str(evil))
    _git(evil, "config", "core.fsmonitor", f"touch {marker}; false")
    _git(evil, "config", "core.worktree", str(wt))
    (wt / ".git").write_text(f"gitdir: {evil}\n")
    with pytest.raises(dev.GitError, match="no longer points"):
        dev.touched_files(wt)
    (wt / ".git").write_text(pointer)
    (own / "commondir").write_text(str(evil))
    with pytest.raises(dev.GitError, match="another commondir"):
        dev.branch_files(wt, "HEAD")
    assert not marker.exists()


def test_a_link_in_place_of_a_worktree_leads_no_git_command_or_removal_elsewhere(monkeypatch, tmp_path):
    """Main's fence lets main's Bash and its subagents write the folder of the tickets' worktrees, so an agent can put a
    link there in place of its worktree. The server then runs no git command where the link leads (the live checkout,
    where a commit, a reset and a clean would change the analyst's work), its box runs nothing, and removing the
    ticket's worktree removes the link alone, never another worktree of the live checkout it leads to."""
    repo = _repo(tmp_path)
    monkeypatch.setattr(dev, "REPO", repo)
    (repo / "mine.txt").write_text("the analyst's work in progress\n")
    other = tmp_path / "other-worktree"
    _git(repo, "worktree", "add", "-q", "-b", "other", str(other))
    (other / "draft.txt").write_text("not committed\n")
    head = _git(repo, "rev-parse", "HEAD")
    wt, _branch, _base = dev.create_worktree("t8")
    shutil.rmtree(wt)
    wt.symlink_to(repo)
    for git_call in (lambda: dev.touched_files(wt), lambda: dev.commit_worktree(wt, "t8"),
                     lambda: dev.reset_worktree(wt, head)):
        with pytest.raises(dev.GitError, match="a link"):
            git_call()
    assert _git(repo, "rev-parse", "HEAD") == head and (repo / "mine.txt").exists()
    assert _git(repo, "status", "--porcelain") == "?? mine.txt", "nothing was staged or committed in the live checkout"
    box = ticket_box.Box(wt, tmp_path / "cache", tmp_path / "srt", live=repo)
    assert asyncio.run(ticket_box.run(box, ["true"], cwd=wt, timeout=5)) == (-1, ticket_box.TREE_LINKED)
    wt.unlink()
    wt.symlink_to(other)
    dev.remove_worktree(wt)
    assert not wt.is_symlink() and not wt.exists()
    assert (other / "draft.txt").read_text() == "not committed\n", "the worktree the link led to is still there"
    assert str(other) in _git(repo, "worktree", "list")
    dev.worktree_path("t7").symlink_to(other)  # planted before the ticket was filed
    wt7, _b, _s = dev.create_worktree("t7")
    assert wt7.is_dir() and not wt7.is_symlink() and (other / "draft.txt").exists()


APP = '''
import json, pathlib, socket
def attempt(f):
    try:
        f()
        return True
    except Exception:
        return False
attempt(lambda: pathlib.Path(OUTSIDE).write_text("x"))
RESULT = {
    "home": attempt(lambda: pathlib.Path(HOME, ".ssh", "id").read_text()),
    "network": attempt(lambda: socket.create_connection(("127.0.0.1", PORT), timeout=2)),
    "tree": attempt(lambda: pathlib.Path(TREE, "ok").write_text("x")),
}
async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        while (await receive())["type"] != "lifespan.shutdown":
            await send({"type": "lifespan.startup.complete"})
        await send({"type": "lifespan.shutdown.complete"})
        return
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": json.dumps({"ok": True, **RESULT}).encode()})
'''


@pytest.mark.skipif(not ticket_box.works(), reason=f"thimble's sandbox runtime can't run here: {ticket_box.problem()}")
async def test_the_box_s_server_reads_no_home_writes_only_its_tree_and_reaches_no_network(monkeypatch, tmp_path):
    """Code a ticket edited, imported by the server in its box, can't read the home folder, write outside its worktree
    and cache, or connect to a port on this machine, and the server still answers the host through the handoff."""
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id").write_text("secret")
    monkeypatch.setenv("HOME", str(home))
    listener = socket.create_server(("127.0.0.1", 0))
    tree = tmp_path / "tree"
    (tree / "backend" / "app").mkdir(parents=True)
    (tree / "backend" / "app" / "__init__.py").write_text("")
    shutil.copy(BACKEND / "app" / "handoff_serve.py", tree / "backend" / "app" / "handoff_serve.py")
    (tree / "backend" / ".venv").symlink_to(Path(sys.prefix), target_is_directory=True)
    (tmp_path / "live" / "backend").mkdir(parents=True)
    (tmp_path / "live" / "backend" / ".venv").symlink_to(Path(sys.prefix), target_is_directory=True)
    consts = {"HOME": str(home), "OUTSIDE": str(tmp_path / "escaped"), "PORT": listener.getsockname()[1],
              "TREE": str(tree)}
    (tree / "backend" / "app" / "main.py").write_text("".join(f"{k} = {v!r}\n" for k, v in consts.items()) + APP)
    preview = ticket_box.Preview(ticket_box.Box(tree, tmp_path / "cache", tmp_path / "srt", live=tmp_path / "live"), {})
    try:
        url = await preview.start(wait_s=60)
        body = json.loads(await asyncio.to_thread(ticket_box.fetch, f"{url}/api/health"))
    finally:
        await preview.stop()
        listener.close()
    # a write outside is refused, or on Linux lands in the empty folder the box shows there, which the host never sees
    assert body == {"ok": True, "home": False, "network": False, "tree": True}
    assert not (tmp_path / "escaped").exists() and (tree / "ok").exists()


@pytest.mark.skipif(not ticket_box.works(), reason=f"thimble's sandbox runtime can't run here: {ticket_box.problem()}")
async def test_a_check_that_times_out_leaves_nothing_in_the_worktree(tmp_path):
    """srt puts empty stand-ins for dotfiles such as .bashrc and .mcp.json in the box's working directory while a check
    runs; a check stopped at its timeout must still leave the worktree as it was."""
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "a.txt").write_text("a")
    box = ticket_box.Box(tree, tmp_path / "cache", tmp_path / "srt")
    code, out = await ticket_box.run(box, ["sleep", "60"], cwd=tree, timeout=2)
    assert code == -1 and "timed out" in out
    assert sorted(p.name for p in tree.iterdir()) == ["a.txt"]


def test_a_preview_server_gets_a_private_server_json_so_a_local_tool_can_write_to_it(tmp_path):
    """A server no supervisor starts (a box's preview, like the dev stack) still has a token and a ui_key, or
    hook_auth.LocalWriteGuard would refuse every write to it: ticket_box.seed_home writes them, readable by the owner
    alone, with no pid, a new token at each start and the ui_key kept."""
    home = tmp_path / "preview" / "server" / "home"
    ticket_box.seed_home(home, 8301)
    first = json.loads((home / "server.json").read_text())
    assert first["port"] == 8301 and first["api"] == "http://127.0.0.1:8301" and first["token"] and first["ui_key"]
    assert "pid" not in first
    assert (home / "server.json").stat().st_mode & 0o077 == 0 and home.stat().st_mode & 0o077 == 0
    ticket_box.seed_home(home, 8301)
    again = json.loads((home / "server.json").read_text())
    assert again["ui_key"] == first["ui_key"] and again["token"] != first["token"]
