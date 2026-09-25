"""Dev tickets across failures and restarts: gates that fail after the rebase leave the live checkout as it was; a
server's shutdown queues a running ticket again with its worktree kept, and the next start resumes its session; a
ticket a restart left running is queued again once, then fails, and one another live server runs is left alone; and a
rollback by the restart watch is recorded on its ticket at the next start. The live checkout is test_dev's scratch git
repository, with its faked sessions, gates and validation stack."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from app import agents, dev
from test_dev import (C, _commit, _git, api, chat_meta, chips, edit_backend, edit_css, env,  # noqa: F401
                      file_and_wait, wait_execs, wait_idle)


def chat_text(env, chat_id: str) -> str:
    return "".join(r.get("delta", "") for r in agents.read_events(env["ws"] / C / "chats" / f"{chat_id}.jsonl"))


async def test_gates_that_fail_after_the_rebase_leave_the_live_checkout_unchanged(api, env):
    """The rebased commits are checked before the fast-forward, never after it."""
    repo = env["repo"]

    def edit_and_move(cwd: Path, n: int) -> None:
        edit_css(cwd, n)
        (repo / "README.md").write_text("moved\n")
        _commit(repo, "moved")

    env["sessions"].edit = edit_and_move
    calls = env["gates"].calls
    real = env["gates"].__call__

    async def fail_second(tree, touched, *, scratch=None):
        res = await real(tree, touched, scratch=scratch)
        return res if len(calls) == 1 else {"ok": False, "steps": [{"name": "tsc", "ok": False, "tail": "boom"}]}

    dev.run_gates = fail_second
    moved_head = None
    try:
        t = await file_and_wait(api)
        moved_head = _git(repo, "rev-parse", "HEAD")
    finally:
        dev.run_gates = env["gates"]
    assert t["status"] == "failed" and "gates failed after the rebase" in t["error"] and "nothing was applied" in t["error"]
    assert "#654321" not in (repo / "frontend" / "src" / "styles.css").read_text()
    assert _git(repo, "log", "-1", "--format=%s") == "moved" and moved_head == _git(repo, "rev-parse", "HEAD")
    assert dev.last_apply() is None and t["commit"] is None


async def test_a_shutdown_queues_the_run_again_with_its_worktree_and_the_next_start_resumes_it(api, env, monkeypatch):
    gate = asyncio.Event()

    async def slow_gates(tree, touched, *, scratch=None):
        await gate.wait()
        return {"ok": True, "steps": []}

    monkeypatch.setattr(dev, "run_gates", slow_gates)
    t = (await api.post("/api/dev/tickets", json={"workspace": C, "title": "slow", "body": "b"})).json()
    await asyncio.sleep(0.2)
    await dev.shutdown()
    rec = (await api.get(f"/api/dev/tickets/{t['id']}")).json()
    assert rec["status"] == "queued" and rec["interrupted"] == 1 and rec["runner"] is None
    assert chat_meta(env, t["chat"])["status"] == "running" and env["stack"][-1] == ("stop", t["id"])
    assert rec["session"] in env["sessions"].stopped and Path(rec["worktree"]).exists(), "the worktree is kept"
    assert "goes on when it is back" in chat_text(env, t["chat"])
    # the next start (a fresh module state) resumes the session in the kept worktree and applies
    monkeypatch.setattr(dev, "_closing", False)
    monkeypatch.setattr(dev, "_current", None)
    gate.set()
    dev._recover()
    await wait_idle(api)
    rec = (await api.get(f"/api/dev/tickets/{t['id']}")).json()
    assert rec["status"] == "applied" and rec["attempts"] == 2 and chat_meta(env, t["chat"])["status"] == "done"
    assert env["sessions"].resumes[0]["session_id"] == rec["session_id"], "the run wakes the interrupted session"
    assert "worktree kept on" in chat_text(env, t["chat"])


async def test_recover_queues_a_ticket_a_restart_left_running_once_and_leaves_another_servers_alone(api, env, monkeypatch):
    monkeypatch.setattr(dev, "_running", lambda: True)  # nothing starts: this checks what _recover writes
    t = (await api.post("/api/dev/tickets", json={"workspace": C, "title": "x", "body": "b"})).json()
    dev._update(t["id"], status="running", session="abcd1234", runner=os.getpid())
    dev._recover()
    rec = dev._get(t["id"])
    assert rec["status"] == "queued" and rec["interrupted"] == 1 and "abcd1234" in env["sessions"].stopped
    # the second time it fails
    dev._update(t["id"], status="running", runner=None)
    dev._recover()
    rec = dev._get(t["id"])
    assert rec["status"] == "failed" and rec["error"] == "server restarted during the run"
    assert chat_meta(env, t["chat"])["status"] == "failed"
    # a ticket another live server runs is left alone
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        dev._update(t["id"], status="running", runner=other.pid)
        dev._recover()
        assert dev._get(t["id"])["status"] == "running"
    finally:
        other.kill()
        other.wait()
    # an applied ticket whose run a reloader cut short gets its bookkeeping
    dev._update(t["id"], status="applied", finished=False, runner=None)
    agents.update_agent(C, t["chat"], status="running")
    dev._recover()
    assert dev._get(t["id"])["finished"] is True and chat_meta(env, t["chat"])["status"] == "done"
    assert chips(env)[-1] == "ticket #1 applied"
    # the restart an applied ticket asked for is this start
    dev._update(t["id"], restart="restarting")
    dev._recover()
    assert dev._get(t["id"])["restart"] == "done" and chips(env)[-1] == "ticket #1 applied", "no second chip"


async def test_a_rollback_by_the_restart_watch_is_recorded_at_the_next_start(api, env):
    env["sessions"].edit = edit_backend
    t = await file_and_wait(api)
    await wait_execs(env)
    a = dev.apply_of(t["id"])
    # what restart_watch.py leaves when the restarted server never answered
    (env["home"] / "rollback.json").write_text(json.dumps({
        "ts": "2026-09-25T04:00:00+00:00", "ticket_id": t["id"], "title": t["title"], "commit": a["commit"],
        "prev_head": a["prev_head"], "reverted": "f" * 40, "ok": True, "error": "",
        "log_tail": "ImportError: cannot import name 'nope' from 'app.x'"}))
    dev._recover()
    rec = dev._get(t["id"])
    assert rec["status"] == "rolled back" and rec["error"] == dev.ROLLBACK_LINE
    assert dev.apply_of(t["id"]) is None and dev.last_apply() is None, "`thimble revert` has nothing left to take back"
    assert "the server did not start after the change: ImportError: cannot import name 'nope'" in chat_text(env, t["chat"])
    assert rec["rollback_log"].endswith("ImportError: cannot import name 'nope' from 'app.x'"), "the whole tail on the ticket"
    assert dev.last_error_line("Traceback (most recent call last):\n  File \"x\", line 1\nRuntimeError: boom\nINFO: waiting") \
        == "RuntimeError: boom"
    assert dev.last_error_line("just a line\n") == "just a line" and dev.last_error_line("") == ""
    assert chat_meta(env, t["chat"])["status"] == "failed"
    assert chips(env)[-1] == f"ticket #1 rolled back: {dev.ROLLBACK_LINE}"
    assert not (env["home"] / "rollback.json").exists() and dev.recover_rollback() is None
    assert dev.reset_line(f"rollback of {t['title']}") == dev.KERNEL_RESET_LINE_PLAIN
