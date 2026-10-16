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
from conftest import card_wait

from app import agent_session, agents, config, dev, ledger, modes, notices, subagents, ticket_box, tools
from app import subagent_files as sf
from subagent_fakes import bridge, hints  # noqa: F401 — fixtures

CORPUS = "mini"
BACKEND = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, monkeypatch):
    agent_session._hosted.clear()
    monkeypatch.setattr(dev, "_current", None)
    monkeypatch.setattr(dev, "_ticket_looks", {}, raising=False)
    monkeypatch.setattr(dev, "_ticket_retry", None, raising=False)
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
        # the terminal's band says the change waits for the Allow on the browser's card (notice ticket:<id>)
        [waits] = [n for n in notices.open_notices(CORPUS) if n.get("key") == dev.ticket_key(t["id"])]
        assert waits["text"] == dev.ALLOW_TEXT.format(n=rec["n"])
        assert agent_session.answer(CORPUS, t["chat"], q["id"], answer == "yes")
        await _until(lambda: dev._get(t["id"]).get("finished"), "the ticket did not end")
        assert not [n for n in notices.open_notices(CORPUS) if n.get("key") == dev.ticket_key(t["id"])]
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


def test_a_preview_server_gets_a_private_server_json_so_a_local_tool_can_use_its_token_routes(tmp_path):
    """A server no supervisor starts (a box's preview, like the dev stack) still has a token, or a local tool could
    use none of its token routes (hook_auth.guarded): ticket_box.seed_home writes it, readable by the owner alone,
    with no pid and a new token at each start. No browser credential is in the file."""
    home = tmp_path / "preview" / "server" / "home"
    ticket_box.seed_home(home, 8301)
    first = json.loads((home / "server.json").read_text())
    assert first == {"port": 8301, "api": "http://127.0.0.1:8301", "token": first["token"]} and first["token"]
    assert (home / "server.json").stat().st_mode & 0o077 == 0 and home.stat().st_mode & 0o077 == 0
    ticket_box.seed_home(home, 8301)
    again = json.loads((home / "server.json").read_text())
    assert set(again) == {"port", "api", "token"} and again["token"] != first["token"]


# --------------------------------------------------------------------------- every install


def _git_tree(tmp_path: Path) -> Path:
    """A release-like install: the tree committed as one baseline, with no frontend/node_modules and no
    scripts/dev/dev_stack.sh."""
    tree = tmp_path / "app"
    (tree / "backend" / "app").mkdir(parents=True)
    (tree / "frontend" / "src").mkdir(parents=True)
    (tree / "prompts").mkdir()
    (tree / "README.md").write_text("thimble\n")
    (tree / "prompts" / "note.md").write_text("A note.\n")
    (tree / "frontend" / "src" / "a.ts").write_text("export const a = 1\n")
    run = ["git", "-c", "user.name=thimble", "-c", "user.email=thimble@localhost", "-c", "core.hooksPath=/dev/null"]
    subprocess.run([*run, "init", "-q"], cwd=tree, check=True)
    subprocess.run([*run, "add", "."], cwd=tree, check=True)
    subprocess.run([*run, "commit", "-q", "-m", "thimble 0.9.0"], cwd=tree, check=True)
    return tree


def test_a_git_tree_without_the_validation_stack_runs_code_tickets(tmp_path, monkeypatch):
    """Code tickets run in every install whose tree is a git repository, a release install with its git baseline too,
    even without the validation stack's tools; in a tree that is none they do not, and main hears why."""
    tree = _git_tree(tmp_path)
    monkeypatch.setattr(dev, "REPO", tree)
    monkeypatch.setattr(dev, "STACK_ENABLED", True)
    assert not (tree / "frontend" / "node_modules").exists() and not dev.stack_script().is_file()
    assert dev.ticket_problem() == "" and dev.tickets_run_here()
    monkeypatch.setattr(dev, "REPO", tmp_path / "no-git")
    assert dev.ticket_problem() == dev.RELEASE_LINE and "`thimble update`" in dev.RELEASE_LINE
    assert "development install" not in dev.RELEASE_LINE
