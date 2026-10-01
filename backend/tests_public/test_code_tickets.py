"""A code ticket (app/dev.py): contained, it runs its checks and its server in a box (app/ticket_box.py) and asks the
analyst only before its change reaches thimble's own code; where the box can't run it asks before it starts as well.
The server's git commands in its worktree run hardened."""
from __future__ import annotations

import asyncio
import json
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from app import agent_session, agents, dev, ledger, modes, ticket_box

CORPUS = "mini"
BACKEND = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    agent_session._hosted.clear()
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
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("a\n")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-qm", "a")
    return repo


async def test_a_contained_ticket_asks_only_before_its_change_is_applied_in_every_mode(monkeypatch, tmp_path):
    """A contained ticket starts unasked, runs its gates in its box, stops its session, then waits on its card, in
    Bypass too, before the merge: a no leaves the live branch where it was and the change on the ticket's branch; an
    Allow merges the commit it named, and nothing when the branch moved after the question."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    repo = _repo(tmp_path)
    monkeypatch.setattr(dev, "REPO", repo)
    ledger.put_settings(CORPUS, {modes.SETTING: {"dev": "bypass"}})
    monkeypatch.setattr(dev, "runner_problem", lambda **_k: "")
    monkeypatch.setattr(ticket_box, "works", lambda: True)
    boxes: list = []

    async def never(_t):
        raise AssertionError("a contained ticket asked before it started")

    async def turn(run, run_log, wt, prompt, resume, **_k):
        (wt / "README.md").write_text("b\n")
        _git(wt, "commit", "-qam", "dev: ticket")
        run.session = "s1"
        return "done"

    async def gates(tree, touched, *, scratch=None, box=None):
        boxes.append(box)
        return {"ok": True, "steps": []}

    async def no_shot(*_a, **_k):
        return None

    monkeypatch.setattr(dev, "_code_refusal", never)
    monkeypatch.setattr(dev, "_worker_turn", turn)
    monkeypatch.setattr(dev, "run_gates", gates)
    monkeypatch.setattr(dev, "_preview_shot", no_shot)
    stopped: list = []
    monkeypatch.setattr(dev.SESSIONS, "stop", stopped.append)
    live = _git(repo, "rev-parse", "HEAD")
    for answer in ("no", "moved", "yes"):
        stopped.clear()
        t = dev.file_ticket(CORPUS, "Bigger font", "the labels are small", start=False)
        running = asyncio.ensure_future(dev.run_ticket(t, dev.Run(ticket_id=t["id"], title=t["title"], ts_start="")))
        q = await _question(t["chat"])
        assert (q["tool"], q["what"]) == (dev.CODE_TOOL, dev.APPLY_QUESTION) and "README.md" in q["why"]
        assert _git(repo, "rev-parse", "HEAD") == live and not running.done() and stopped == ["s1"]
        wt = Path(dev._get(t["id"])["worktree"])
        if answer == "moved":
            (wt / "extra.txt").write_text("x\n")
            _git(wt, "add", "extra.txt")
            _git(wt, "commit", "-qm", "after the question")
        assert agent_session.answer(CORPUS, t["chat"], q["id"], answer != "no")
        rec = await running
        branch = f"dev/{t['id']}"
        if answer == "no":
            assert (rec["status"], rec["error"]) == ("stopped", dev.APPLY_NOT_ALLOWED.format(branch=branch))
            assert _git(repo, "rev-parse", "HEAD") == live and _git(repo, "rev-parse", branch) != live
        elif answer == "moved":
            assert rec["status"] == "needs manual merge" and dev.BRANCH_MOVED in rec["error"]
            assert _git(repo, "rev-parse", "HEAD") == live and not (repo / "extra.txt").exists()
        else:
            assert rec["status"] == "applied" and (repo / "README.md").read_text() == "b\n"
    assert boxes and all(isinstance(b, ticket_box.Box) for b in boxes)


async def test_a_ticket_the_box_cannot_run_asks_before_it_starts_and_again_before_its_change_is_applied(monkeypatch,
                                                                                                      tmp_path):
    """Where the box can't run, the ticket's code runs outside the sandbox during the run, so the analyst is asked
    before it starts, and, like any ticket, again before its change reaches thimble's own code."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    repo = _repo(tmp_path)
    monkeypatch.setattr(dev, "REPO", repo)
    monkeypatch.setattr(dev, "runner_problem", lambda **_k: "")
    monkeypatch.setattr(ticket_box, "works", lambda: False)

    async def turn(run, run_log, wt, prompt, resume, **_k):
        (wt / "README.md").write_text("b\n")
        _git(wt, "commit", "-qam", "dev: ticket")
        return "done"

    async def gates(tree, touched, *, scratch=None, box=None):
        assert box is None
        return {"ok": True, "steps": []}

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(dev, "_worker_turn", turn)
    monkeypatch.setattr(dev, "run_gates", gates)
    monkeypatch.setattr(dev, "start_stack", nothing)
    monkeypatch.setattr(dev, "stop_stack", nothing)
    t = dev.file_ticket(CORPUS, "Bigger font", "the labels are small", start=False)
    running = asyncio.ensure_future(dev.run_ticket(t, dev.Run(ticket_id=t["id"], title=t["title"], ts_start="")))
    asked: list = []
    for _ in range(2):
        q = await _question(t["chat"], tuple(a["id"] for a in asked))
        asked.append(q)
        assert agent_session.answer(CORPUS, t["chat"], q["id"], True)
    assert [q["what"] for q in asked] == [dev.CODE_QUESTION, dev.APPLY_QUESTION]
    assert (await running)["status"] == "applied" and (repo / "README.md").read_text() == "b\n"


async def test_a_ticket_whose_session_shows_no_activity_runs_on_until_the_analyst_stops_it(monkeypatch, tmp_path):
    """A turn has no time limit: a session that shows no activity gets a line in the ticket's thread and runs on, and
    the analyst's Stop ends the ticket `stopped` with its session stopped."""
    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    repo = _repo(tmp_path)
    monkeypatch.setattr(dev, "REPO", repo)
    monkeypatch.setattr(dev, "runner_problem", lambda **_k: "")
    monkeypatch.setattr(ticket_box, "works", lambda: True)
    tx = tmp_path / "s1-0000.jsonl"
    tx.write_text("")
    stopped: list = []

    class Sessions:
        async def start(self, cwd, prompt, **_k):
            return {"id": "s1", "session_id": "s1-0000"}

        async def state(self, cwd, short):
            return "working"

        def transcript(self, session_id):
            return tx

        def stop(self, short):
            stopped.append(short)

    async def no_shot(*_a, **_k):
        return None

    monkeypatch.setattr(dev, "SESSIONS", Sessions())
    monkeypatch.setattr(dev, "_preview_shot", no_shot)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setattr(dev, "QUIET_NOTE_S", 0.1)
    t = dev.file_ticket(CORPUS, "Bigger font", "the labels are small", start=False)
    rec = dev._claim(t["id"])
    run = dev.Run(ticket_id=t["id"], title=t["title"], ts_start="")
    monkeypatch.setattr(dev, "_current", run)
    run.task = asyncio.ensure_future(dev._run_task(run, rec))

    def thread() -> str:
        events = agents.read_events(agents.paths(CORPUS, t["chat"])[1])
        return "".join(str(e.get("delta") or e.get("text") or "") for e in events)

    for _ in range(300):
        if thread().count("no activity for") >= 2:
            break
        await asyncio.sleep(0.01)
    assert dev.QUIET_LINE.format(minutes=dev._minutes(0.1)) in thread()
    assert dev.QUIET_LINE.format(minutes=dev._minutes(0.2)) in thread()
    assert not run.task.done() and dev._get(t["id"])["status"] == "running"
    assert (await dev.stop_ticket(t["id"]))["ok"]
    await asyncio.wait_for(run.task, 10)
    assert dev._get(t["id"])["status"] == "stopped" and "s1" in stopped


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


async def test_a_ticket_the_box_cannot_run_asks_before_it_starts_and_a_no_stops_it_before_its_worktree(monkeypatch):
    """Where the box can't run, the question before the ticket starts waits on its card in Bypass too, with thimble's
    reason; a no stops the ticket before its worktree exists, and a ticket with no workspace never starts."""
    ledger.put_settings(CORPUS, {modes.SETTING: {"dev": "bypass"}})
    t = dev.file_ticket(CORPUS, "Fix the chart", "the bars are cut off", start=False)
    agent_session.host(CORPUS, dev.ticket_key(t["id"]), t["chat"], agent="dev", wait_s=10)
    allowed = asyncio.ensure_future(dev._code_refusal(t))
    q = await _question(t["chat"])
    assert (q["tool"], q["what"]) == (dev.CODE_TOOL, dev.CODE_QUESTION) and "every permission mode" in q["why"]
    assert agent_session.answer(CORPUS, t["chat"], q["id"], True)
    assert await allowed == ""
    denied = asyncio.ensure_future(dev._code_refusal(t))
    assert agent_session.answer(CORPUS, t["chat"], (await _question(t["chat"]))["id"], False)
    assert await denied == dev.CODE_NOT_ALLOWED
    monkeypatch.setattr(dev, "PERMISSION_WAIT_S", 0.3)
    agent_session.host(CORPUS, dev.ticket_key(t["id"]), t["chat"], agent="dev", wait_s=dev.PERMISSION_WAIT_S)
    assert await dev._code_refusal(t) == dev.CODE_UNANSWERED.format(wait=agent_session.wait_words(0.3)), \
        "a question nobody answers says so, not that the analyst refused"

    async def no(_t):
        return dev.CODE_NOT_ALLOWED

    def never(*_a, **_k):
        raise AssertionError("a worktree for a ticket the analyst did not allow")

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(ticket_box, "works", lambda: False)
    monkeypatch.setattr(dev, "runner_problem", lambda **_k: "")
    monkeypatch.setattr(dev, "_code_refusal", no)
    monkeypatch.setattr(dev, "create_worktree", never)
    monkeypatch.setattr(dev, "stop_stack", nothing)
    run = dev.Run(ticket_id=t["id"], title=t["title"], ts_start="")
    rec = await dev._run_ticket(t, run)
    assert (rec["status"], rec["error"]) == ("stopped", dev.CODE_NOT_ALLOWED)
    rec = await dev._run_ticket({**t, "workspace": None}, run)
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
