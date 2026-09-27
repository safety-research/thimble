"""Dev tickets: filing with a number, the worktree run by a Claude Code background session, the fast-forward apply (a
dirty touched file or a conflict refuses the merge), the restart rules (only a supervised server restarts itself), the
gates, and nothing filed, restarted or reverted off loopback.

The live checkout is a scratch git repository; the background sessions (dev.SESSIONS), screenshots, gates and the
validation stack are faked; git is real."""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import agents, cli, config, dev

app = FastAPI()  # dev's router alone: these tests do not depend on the rest of the tree importing
app.include_router(dev.router, prefix="/api")

SECRET = "sk-ant-test-secret-never-logged"  # gitleaks:allow  fake fixture asserting secrets are never logged
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
PNG2 = b"\x89PNG\r\n\x1a\n" + b"\x01" * 16
C = "mini"
TARGET = {"selector": "header.shell-top", "url": "http://127.0.0.1:5300/?ws=mini", "text": "thimble"}


# ----------------------------------------------------------------------------- fakes


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True).stdout.strip()


def _commit(cwd: Path, message: str) -> None:
    _git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A")
    _git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message)


def _line(rec: dict) -> str:
    return json.dumps(rec) + "\n"


def transcript_turn(prompt: str, final: str) -> list[str]:
    """One turn as Claude Code writes it: the prompt, a text and a Read, its result, an Edit whose old string must
    never reach the chat, its result, the report, the turn's end; with records the tail skips."""
    return [
        _line({"type": "permission-mode", "permissionMode": "default"}),
        _line({"type": "user", "message": {"role": "user", "content": prompt}}),
        _line({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": ""}]}}),
        _line({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Looking"},
            {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "frontend/src/styles.css"}}]}}),
        _line({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": ":root { --accent: #123456; }"}]}}),
        _line({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t2", "name": "Edit", "input": {"file_path": "frontend/src/styles.css", "old_string": SECRET, "new_string": "x"}}]}}),
        _line({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": "edited"}]}]}}),
        _line({"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "a subagent's line"}]}}),
        _line({"type": "assistant", "message": {"content": [{"type": "text", "text": final}]}}),
        _line({"type": "system", "subtype": "turn_duration", "durationMs": 10}),
    ]


class FakeSessions:
    """Stands in for dev.SESSIONS. Each turn (a start, or a resume by the full id) runs `edit(cwd, n)` for the n-th turn
    of the ticket, commits the way the prompt asks unless `commit` is off, and writes the turn's transcript; `state`
    reports `working` once, then `final_state`."""

    def __init__(self, root: Path):
        self.root = root
        self.edit = edit_css
        self.commit = True
        self.final_state = "done"
        self.report = "Changed the accent colour; the after shot shows the darker header."
        self.starts: list[dict] = []
        self.resumes: list[dict] = []
        self.stopped: list[str] = []
        self.polls: dict[str, int] = {}
        self.turns = 0
        self.before_turn = None  # an async hook the test awaits inside a turn

    def _turn(self, cwd: Path, prompt: str, sid: str) -> None:
        self.turns += 1
        if self.edit is not None:
            self.edit(cwd, self.turns)
            if self.commit and _git(cwd, "status", "--porcelain"):
                tid = cwd.name
                _commit(cwd, f"dev: ticket {tid}")
        with (self.root / f"{sid}.jsonl").open("a") as f:
            f.writelines(transcript_turn(prompt, self.report))

    async def start(self, cwd: Path, prompt: str, *, name: str, workspace: str | None, add_dirs=(), env=None,
                    asking=None) -> dict:
        n = len(self.starts) + 1
        sid = f"{n:08x}-0000-4000-8000-000000000000"
        self.starts.append({"cwd": cwd, "prompt": prompt, "name": name, "workspace": workspace, "session_id": sid,
                            "add_dirs": list(add_dirs), "env": env, "asking": asking})
        if self.before_turn is not None:
            await self.before_turn()
        self._turn(cwd, prompt, sid)
        return {"id": sid[:8], "session_id": sid}

    async def resume(self, cwd: Path, session_id: str, prompt: str, *, env=None, **started) -> dict:
        self.resumes.append({"cwd": cwd, "prompt": prompt, "session_id": session_id, "env": env})
        self._turn(cwd, prompt, session_id)
        return {"id": session_id[:8], "session_id": session_id}

    async def state(self, cwd: Path, short: str) -> str | None:
        self.polls[short] = self.polls.get(short, 0) + 1
        return "working" if self.polls[short] == 1 else self.final_state

    def stop(self, short: str | None) -> None:
        if short:
            self.stopped.append(short)

    def transcript(self, session_id: str) -> Path | None:
        p = self.root / f"{session_id}.jsonl"
        return p if p.exists() else None


def edit_css(cwd: Path, n: int) -> None:
    p = cwd / "frontend" / "src" / "styles.css"
    p.write_text(p.read_text().replace("#123456", "#654321") + f"/* edit {n} */\n")


def edit_backend(cwd: Path, n: int) -> None:
    p = cwd / "backend" / "app" / "x.py"
    p.write_text(p.read_text() + "Y = 2\n")


class FakeShots:
    """Stands in for dev.run_shot: writes a png per phase and records every call."""

    def __init__(self):
        self.calls: list[tuple[str, str, str | None]] = []
        self.payloads = {"before": PNG, "after": PNG2}
        self.code = 0

    async def __call__(self, url: str, out: Path, selector: str | None = None, **opts) -> int:
        self.calls.append((url, Path(out).name, selector))
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(self.payloads.get(Path(out).stem, PNG))
        return self.code


class FakeGates:
    def __init__(self):
        self.calls: list[list[str]] = []
        self.fail_first = 0

    async def __call__(self, tree: Path, touched: list[str], *, scratch=None):
        self.calls.append(list(touched))
        ok = len(self.calls) > self.fail_first
        return {"ok": ok, "steps": [{"name": "tsc", "ok": ok, "tail": "" if ok else "error TS2322: bad"}]}


# ----------------------------------------------------------------------------- fixtures


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A scratch live checkout, a scratch THIMBLE_HOME and workspaces dir, faked sessions, shots, gates, stack, execv and
    events; the server counts as supervised unless a test says otherwise."""
    repo = tmp_path / "repo"
    (repo / "frontend" / "src").mkdir(parents=True)
    (repo / "backend" / "app").mkdir(parents=True)
    (repo / "plugin").mkdir()
    (repo / "frontend" / "src" / "styles.css").write_text(":root { --accent: #123456; }\n")
    (repo / "backend" / "app" / "x.py").write_text("X = 1\n")
    (repo / "plugin" / "README").write_text("plugin\n")
    (repo / ".gitignore").write_text("dev/\nfrontend/node_modules\nbackend/.venv\n")
    _git(repo, "init", "-q", "-b", "main")
    _commit(repo, "base")
    (repo / "frontend" / "node_modules").mkdir()
    (repo / "backend" / ".venv").mkdir()
    monkeypatch.setattr(dev, "REPO", repo)
    monkeypatch.setattr(dev, "DEV_DIR", repo / "dev")
    monkeypatch.setattr(dev, "STACK_ENABLED", True)
    monkeypatch.setattr(dev, "POLL_S", 0.01)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setattr(config, "WORKSPACES_DIR", ws)
    monkeypatch.setattr(dev, "_current", None)
    monkeypatch.setattr(dev, "_restart_pending", None)
    monkeypatch.setattr(dev, "_poller", None)
    monkeypatch.setattr(dev, "_announced", True)
    (tmp_path / "transcripts").mkdir()
    sessions = FakeSessions(tmp_path / "transcripts")
    monkeypatch.setattr(dev, "SESSIONS", sessions)
    monkeypatch.setattr(dev, "supervised", lambda: True)
    shots = FakeShots()
    monkeypatch.setattr(dev, "run_shot", shots)
    gates = FakeGates()
    monkeypatch.setattr(dev, "run_gates", gates)
    stack_calls = []

    async def fake_start_stack(tid, wt, workspace):
        stack_calls.append(("start", tid, str(wt), workspace))
        return {"ui": "http://127.0.0.1:5301", "api": "http://127.0.0.1:8301"}

    async def fake_stop_stack(tid=None):
        stack_calls.append(("stop", tid))

    monkeypatch.setattr(dev, "start_stack", fake_start_stack)
    monkeypatch.setattr(dev, "stop_stack", fake_stop_stack)
    execs: list[list[str]] = []
    monkeypatch.setattr(dev, "EXECV", lambda argv: execs.append(argv))
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(dev, "_emit_ws", lambda c, ev: events.append((c, ev)))
    # the watch over an apply's restart is a detached process that polls the server's port and may start a server, so
    # a test only records that it was asked for
    watches: list[dict] = []
    monkeypatch.setattr(dev, "spawn_restart_watch",
                        lambda t, prev, *, respawn: watches.append({"ticket": t.get("id"), "commit": t.get("commit"),
                                                                    "prev_head": prev, "respawn": respawn}))
    monkeypatch.setattr(dev, "_under_reloader", lambda: False)
    return {"repo": repo, "home": tmp_path / "home", "ws": ws, "shots": shots, "gates": gates, "stack": stack_calls,
            "execs": execs, "events": events, "sessions": sessions, "watches": watches}


@pytest.fixture()
async def api():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def wait_idle(api, timeout=10.0) -> dict:
    for _ in range(int(timeout / 0.02)):
        s = (await api.get("/api/dev/status")).json()
        if not s["running"]:
            return s
        await asyncio.sleep(0.02)
    pytest.fail("ticket did not finish")


async def file_and_wait(api, **body) -> dict:
    r = await api.post("/api/dev/tickets", json={"workspace": C, "title": "darker accent", "body": "make the header darker",
                                                 "target": TARGET, **body})
    assert r.status_code == 202, r.text
    t = r.json()
    await wait_idle(api)
    return (await api.get(f"/api/dev/tickets/{t['id']}")).json()


def chat_meta(env, chat_id: str) -> dict:
    return json.loads((env["ws"] / C / "chats" / f"{chat_id}.meta.json").read_text())


def main_log(env) -> list[dict]:
    return agents.read_events(env["ws"] / C / "chats" / "main.jsonl")


def chips(env) -> list[str]:
    return [r["text"] for r in main_log(env) if r["type"] == "chip"]


def ticket_events(env, tid: str) -> list[str]:
    return [ev["status"] for c, ev in env["events"] if ev.get("type") == "ticket" and ev.get("id") == tid]


async def wait_execs(env, timeout=5.0) -> None:
    for _ in range(int(timeout / 0.05)):
        if env["execs"]:
            return
        await asyncio.sleep(0.05)
    pytest.fail("the restart did not fire")


async def test_css_ticket_runs_as_a_background_session_in_a_worktree_and_lands_by_ff_merge(api, env):
    t = await file_and_wait(api)
    repo, sessions = env["repo"], env["sessions"]
    assert t["status"] == "applied" and t["error"] is None and t["touched"] == ["frontend/src/styles.css"]
    assert "#654321" in (repo / "frontend" / "src" / "styles.css").read_text(), "the change landed in the live checkout"
    assert _git(repo, "status", "--porcelain") == "" and _git(repo, "rev-parse", "HEAD") == t["commit"]
    assert _git(repo, "log", "-1", "--format=%s") == f"dev: ticket {t['id']}", "the session's commit, as the prompt names it"
    assert _git(repo, "branch", "--list", "dev/*") == "" and not Path(t["worktree"]).exists()
    assert env["stack"][0][:2] == ("start", t["id"]) and env["stack"][-1] == ("stop", t["id"])
    assert t["restart"] is None and env["execs"] == []
    assert ticket_events(env, t["id"]) == ["queued", "running", "applied"]
    assert all(c == C for c, _ in env["events"])
    applies = dev._read_jsonl(dev.applies_path(), "ts")
    assert len(applies) == 1 and applies[0]["ticket_id"] == t["id"] and applies[0]["workspace"] == C
    # one session, started in the worktree with the ticket prompt, named for the analyst, stopped at the end
    [start] = sessions.starts
    assert start["cwd"] == Path(t["worktree"]) and start["workspace"] == C and start["name"] == "thimble ticket #1: darker accent"
    prompt = start["prompt"]
    assert prompt.startswith("# Building thimble") and "darker accent (source ui)" in prompt
    assert str(Path(t["worktree"])) in prompt and "http://127.0.0.1:5301" in prompt and "scripts/ui_shot.mjs" in prompt
    assert f'git commit -m "dev: ticket {t["id"]}"' in prompt
    assert t["session"] == start["session_id"][:8] and t["session_id"] == start["session_id"]
    assert sessions.resumes == [] and t["session"] in sessions.stopped


async def test_dirty_touched_file_in_the_live_tree_refuses_the_merge(api, env):
    css = env["repo"] / "frontend" / "src" / "styles.css"
    css.write_text(css.read_text() + "/* local */\n")
    t = await file_and_wait(api)
    assert t["status"] == "needs manual merge" and t["error"].startswith("needs manual merge: frontend/src/styles.css")
    assert "/* local */" in css.read_text() and "#654321" not in css.read_text()
    assert chat_meta(env, t["chat"])["status"] == "failed"


async def test_rebase_conflict_ends_needs_manual_merge(api, env):
    repo = env["repo"]

    def edit_and_conflict(cwd: Path, n: int) -> None:
        edit_css(cwd, n)
        (repo / "frontend" / "src" / "styles.css").write_text(":root { --accent: #abcdef; }\n")
        _commit(repo, "conflict")

    env["sessions"].edit = edit_and_conflict
    t = await file_and_wait(api)
    assert t["status"] == "needs manual merge" and "frontend/src/styles.css" in t["error"]
    assert "#abcdef" in (repo / "frontend" / "src" / "styles.css").read_text()
    assert _git(repo, "status", "--porcelain") == ""


# ----------------------------------------------------------------------------- restart rules


async def test_backend_ticket_restarts_the_supervised_server_and_announces_the_restart(api, env):
    env["sessions"].edit = edit_backend
    t = await file_and_wait(api)
    assert t["status"] == "applied" and t["restart"] == "restarting" and t["touched"] == ["backend/app/x.py"]
    assert chat_meta(env, t["chat"])["status"] == "done", "the chat is closed before the process restarts"
    await wait_execs(env)
    assert env["execs"][0][:3] == [sys.executable, "-m", "uvicorn"]
    assert any(ev.get("type") == "server" and ev.get("status") == "restarting" for _, ev in env["events"])
    rec = json.loads((env["home"] / "restart.json").read_text())
    assert rec["title"] == "darker accent"
    # the new server announces: one event and one chip per workspace, the restart file consumed
    env["events"].clear()
    out = await dev.announce_restart()
    assert out["title"] == "darker accent" and out["workspaces"] == [C]
    assert not (env["home"] / "restart.json").exists()
    assert [ev for c, ev in env["events"] if ev.get("type") == "server"][0]["status"] == "restarted"
    says = [r for r in main_log(env) if r["type"] == "chip" and r["kind"] == "say"]
    assert says and says[-1]["text"] == dev.reset_line("darker accent")
    assert "darker accent" in says[-1]["text"] and "run a card again" in says[-1]["text"]
    assert await dev.announce_restart() is None, "nothing to announce twice"
    # the restart went out under a watch that rolls the apply back if the server does not come back
    a = dev.apply_of(t["id"])
    assert env["watches"] == [{"ticket": t["id"], "commit": a["commit"], "prev_head": a["prev_head"], "respawn": True}]


async def test_a_server_started_by_hand_is_never_restarted_or_rebuilt_by_a_ticket(api, env, monkeypatch):
    """The runner restarts only the server the supervisor started, never one started by hand.
    The apply lands in the checkout and main's chip says what the change still needs."""
    monkeypatch.setattr(dev, "supervised", lambda: False)
    env["sessions"].edit = edit_backend
    t = await file_and_wait(api)
    assert t["status"] == "applied" and t["restart"] == "manual"
    await asyncio.sleep(0.7)
    assert env["execs"] == [] and not (env["home"] / "restart.json").exists()
    assert chips(env)[-1] == "ticket #1 applied; restart thimble's server to load it"
    assert (await api.post("/api/dev/restart")).json() == {"status": "manual"}
    await asyncio.sleep(0.7)
    assert env["execs"] == []
    # a frontend change on a server serving the built UI is not rebuilt either
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    dist = env["repo"] / "frontend" / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>")
    monkeypatch.setattr(config, "FRONTEND_DIST", dist)
    builds: list[int] = []

    async def fake_build():
        builds.append(1)
        return 0, "built"

    monkeypatch.setattr(dev, "REBUILD_UI", fake_build)
    env["sessions"].edit = edit_css
    t2 = await file_and_wait(api, title="css")
    assert t2["status"] == "applied" and t2["ui_build"] is None and builds == []
    assert chips(env)[-1] == "ticket #2 applied; run scripts/rebuild_ui.sh to load it"


def test_supervised_needs_the_supervisors_mark_and_its_pid_in_server_json(tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.delenv(cli.SUPERVISED_ENV, raising=False)
    cli.write_state({"pid": os.getpid(), "port": 8300})
    assert dev.supervised() is False, "a uvicorn started from a shell carries no mark"
    monkeypatch.setenv(cli.SUPERVISED_ENV, "1")
    assert dev.supervised() is True
    cli.write_state({"pid": os.getpid() + 1, "port": 8300})
    assert dev.supervised() is False, "the mark inherited by a process server.json does not name (a scratch stack)"
    assert cli._server_environ({"data_dir": "d", "workspaces_dir": "w", "dev": False}, 8300, 5300)[cli.SUPERVISED_ENV] == "1"


def test_file_ticket_numbers_per_workspace_and_validates(env):
    a = dev.file_ticket(C, "one", "body", start=False)
    b = dev.file_ticket(C, "two", "body", "ui", start=False)
    n = dev.file_ticket(None, "fix", "body", "terminal", start=False)
    assert (a["n"], b["n"], n["n"]) == (1, 2, 1) and a["chat"] and b["chat"] and n["chat"] is None
    assert a["status"] == "queued" and a["attempts"] == 0 and a["source"] == "analyst"
    assert a["session"] is None and a["session_id"] is None and "sdk_session_id" not in a
    assert dev.file_ticket(C, "", "first line is the title\nmore", start=False)["title"] == "first line is the title"
    with pytest.raises(ValueError):
        dev.file_ticket(C, "", "", start=False)
    with pytest.raises(ValueError):
        dev.file_ticket(C, "x", "y", "dev-chat", start=False)
    with pytest.raises(ValueError):
        dev.file_ticket("no-such-corpus", "x", "y", start=False)
    assert [r["type"] for r in main_log(env)].count("agent") == 3 and len([r for r in main_log(env) if r["type"] == "chip"]) == 3
    assert [ev["n"] for c, ev in env["events"] if ev["type"] == "ticket"] == [1, 2, 3]


class RemoteApp:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope = {**scope, "client": ("10.0.0.5", 4321)}
        await self.inner(scope, receive, send)


async def test_off_loopback_nothing_files_restarts_or_reverts(env):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=RemoteApp(app)), base_url="http://test") as remote:
        assert (await remote.post("/api/dev/tickets", json={"workspace": C, "title": "x", "body": "y"})).status_code == 403
        assert (await remote.post("/api/dev/restart")).status_code == 403
        assert (await remote.post("/api/dev/revert")).status_code == 403
        assert (await remote.get("/api/dev/tickets")).status_code == 200


async def test_gates_run_tsc_and_vitest_for_frontend_files_and_pytest_per_backend_module(tmp_path, monkeypatch):
    tree = tmp_path / "tree"
    (tree / "frontend" / "node_modules" / ".bin").mkdir(parents=True)
    (tree / "frontend" / "node_modules" / ".bin" / "vitest").write_text("")
    (tree / "frontend" / "tests" / "public").mkdir(parents=True)
    (tree / "frontend" / "tests" / "public" / "a.test.ts").write_text("")
    (tree / "backend" / "app").mkdir(parents=True)
    (tree / "backend" / "tests_public").mkdir()
    (tree / "backend" / ".venv" / "bin").mkdir(parents=True)
    (tree / "backend" / ".venv" / "bin" / "python").symlink_to(sys.executable)
    (tree / "backend" / "app" / "x.py").write_text("X = 1\n")
    (tree / "backend" / "tests_public" / "test_x.py").write_text("def test_x():\n    assert True\n")
    cmds: list[list[str]] = []

    async def fake_run(cmd, *, cwd, timeout, env=None, environ=None):
        cmds.append(list(cmd))
        assert environ is not None and not any(k.startswith("THIMBLE_") and k not in (
            "THIMBLE_SKIP_KEY", "THIMBLE_WORKSPACES_DIR", "THIMBLE_PROMPTS_DIR") for k in environ), \
            "a gate never gets the live server's THIMBLE_* names"
        return 0, "fine"

    async def fake_boot(tree):
        return {"name": "server start", "ok": True, "tail": ""}

    monkeypatch.setattr(dev, "boot_check", fake_boot)
    monkeypatch.setenv("THIMBLE_HOME", "/live/home")
    monkeypatch.setattr(dev, "_run", fake_run)
    v = await dev.run_gates(tree, ["frontend/src/App.tsx", "backend/app/x.py", "prompts/dev.md"])
    assert v["ok"] and [s["name"] for s in v["steps"]] == ["tsc", "vitest", "pytest tests_public/test_x.py",
                                                           "import app.x", "server start"]
    assert cmds[0] == ["npx", "tsc", "--noEmit", "-p", "tsconfig.app.json"]
    assert cmds[1] == ["npx", "vitest", "run"]
    assert cmds[2][1:] == ["-m", "pytest", "tests_public/test_x.py", "-q", "-p", "no:cacheprovider"]
    assert "prompts load" not in [s["name"] for s in v["steps"]], "a prompt file that is not in the tree is skipped"
    (tree / "backend" / "tests_public" / "test_x.py").unlink()
    (tree / "frontend" / "tests" / "public" / "a.test.ts").unlink()
    cmds.clear()
    v = await dev.run_gates(tree, ["frontend/src/App.tsx", "backend/app/x.py"])
    assert [s["name"] for s in v["steps"]] == ["tsc", "pytest", "import app.x", "server start"]
    assert v["steps"][1] == {"name": "pytest", "ok": True, "tail": "no tests match the touched modules (skipped)"}
    assert len(cmds) == 2
    # a module the ticket deleted is not imported, and the server still has to start without it
    cmds.clear()
    v = await dev.run_gates(tree, ["backend/app/gone.py"])
    assert [s["name"] for s in v["steps"]] == ["pytest", "server start"] and cmds == []
    (tree / "frontend" / "node_modules" / ".bin" / "vitest").unlink()
    (tree / "frontend" / "node_modules" / ".bin").rmdir()
    (tree / "frontend" / "node_modules").rmdir()
    v = await dev.run_gates(tree, ["frontend/src/App.tsx"])
    assert not v["ok"] and "node_modules is missing" in v["steps"][0]["tail"]


async def test_gates_run_the_public_suites_when_the_checkout_has_them(tmp_path, monkeypatch):
    # tests_public and frontend/tests/public are the suites CI runs; a ticket's gates run the same ones
    tree = tmp_path / "tree"
    (tree / "frontend" / "node_modules" / ".bin").mkdir(parents=True)
    (tree / "frontend" / "node_modules" / ".bin" / "vitest").write_text("")
    (tree / "frontend" / "tests" / "public").mkdir(parents=True)
    (tree / "frontend" / "tests" / "public" / "a.test.ts").write_text("")
    (tree / "frontend" / "tests" / "old.test.mjs").write_text("")
    (tree / "backend" / "app").mkdir(parents=True)
    (tree / "backend" / "tests_public").mkdir()
    (tree / "backend" / "tests").mkdir()
    (tree / "backend" / ".venv" / "bin").mkdir(parents=True)
    (tree / "backend" / ".venv" / "bin" / "python").symlink_to(sys.executable)
    (tree / "backend" / "app" / "x.py").write_text("X = 1\n")
    (tree / "backend" / "tests_public" / "test_x.py").write_text("def test_x():\n    assert True\n")
    (tree / "backend" / "tests" / "test_x.py").write_text("def test_x():\n    assert True\n")
    cmds: list[list[str]] = []

    async def fake_run(cmd, *, cwd, timeout, env=None, environ=None):
        cmds.append(list(cmd))
        return 0, "fine"

    async def fake_boot(tree):
        return {"name": "server start", "ok": True, "tail": ""}

    monkeypatch.setattr(dev, "boot_check", fake_boot)
    monkeypatch.setattr(dev, "_run", fake_run)
    v = await dev.run_gates(tree, ["frontend/src/App.tsx", "backend/app/x.py"])
    assert v["ok"] and [s["name"] for s in v["steps"]] == ["tsc", "vitest", "pytest tests_public/test_x.py", "import app.x",
                                                           "server start"]
    assert cmds[1] == ["npx", "vitest", "run"]
    assert cmds[2][1:] == ["-m", "pytest", "tests_public/test_x.py", "-q", "-p", "no:cacheprovider"]
    cmds.clear()
    v = await dev.run_gates(tree, ["backend/tests_public/test_x.py"])
    assert [s["name"] for s in v["steps"]] == ["pytest tests_public/test_x.py"]
    # a test outside the public suites is no gate: without vitest installed tsc runs alone
    (tree / "frontend" / "node_modules" / ".bin" / "vitest").unlink()
    cmds.clear()
    v = await dev.run_gates(tree, ["frontend/src/App.tsx"])
    assert [s["name"] for s in v["steps"]] == ["tsc"] and len(cmds) == 1


def test_helpers():
    assert dev.needs_restart(["backend/app/x.py"]) and dev.needs_restart(["plugin/bin/thimble"])
    assert not dev.needs_restart(["frontend/src/a.tsx", "prompts/dev.md"])
    assert dev.needs_ui_build(["frontend/src/a.tsx"]) and not dev.needs_ui_build(["backend/app/x.py"])
    assert dev.rebase_url({"url": "http://127.0.0.1:5300/?ws=mini"}, "http://127.0.0.1:5301") == "http://127.0.0.1:5301/?ws=mini"
    assert dev.rebase_url(None, "http://127.0.0.1:5301/") == "http://127.0.0.1:5301/"
    assert dev.target_selector({"stable_selector": "[data-c=x]", "selector": "div"}) == "[data-c=x]"
    assert dev.target_selector({"selector": "div"}) == "div" and dev.target_selector(None) is None
    assert dev.summarize_input("Edit", {"file_path": "a.py", "old_string": SECRET, "new_string": "x"}) == {"file_path": "a.py"}
    assert dev.summarize_input("X", {"weird": 1}) == {"keys": ["weird"]}
    assert dev.fenced("ticket", "a ``` b").startswith("ticket (data):\n````\n")
    assert dev.reset_line("manual restart") == dev.KERNEL_RESET_LINE_PLAIN
    assert dev.reset_line("darker accent", kept=True) == "thimble restarted after a change (darker accent); your notebook picked up where it left off."
    assert dev.pending_line("revert of x") == dev.RESTART_PENDING_LINE_PLAIN
    assert dev.browser_missing("Please run the following command to download new browsers") and not dev.browser_missing("ok")
    assert set(dev.SOURCES) == {"ui", "analyst", "terminal"}


def test_the_screenshot_script_ships_in_the_release_zip():
    """Main's `screenshot` tool runs the page screenshot script in every install, so it lives outside scripts/dev/,
    which no release carries, and the zip's allowlist names it."""
    script = config.REPO_ROOT / "scripts" / "ui_shot.mjs"
    assert dev.shot_script().resolve() == script.resolve() and script.is_file()
    rel = script.relative_to(config.REPO_ROOT).as_posix()
    release = (config.REPO_ROOT / "scripts" / "release.sh").read_text()
    allow = re.search(r"^allow=\((.*?)\)", release, re.S | re.M)
    assert allow and rel in allow.group(1).split()
