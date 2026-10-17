"""The server's stop ends the processes it started, and starts none while it stops (bug hunt G14). A view's headless run
(scripts/view_shot.mjs) is played by a stand-in that starts a "browser" in a session of its own, as Playwright does,
asks for a reader answer that does not come, and ignores SIGTERM and the end of its stdin, as the old script did. The
kernels are real, unwrapped: a reader kernel, one started on a kernel object the tables had dropped (a start that waited
for the kernel's lock while session._stop_server's shutdown_all ran), and the restart a cancelled reader call asks for
once the server stops (view_calls._drain)."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import signal
import time
from pathlib import Path

import pytest

from app import config, notebook, procs, view_calls, views

CORPUS = "mini"  # conftest's corpus

STAND_IN = r"""
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
browser.unref()
writeFileSync(process.env.STAND_IN_PIDS, JSON.stringify({ node: process.pid, browser: browser.pid }))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
console.log(JSON.stringify({ fetch: 'f1', state: 0, query: {} }))
"""

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="the headless run's stand-in is a node script")


@pytest.fixture()
def stand_in(tmp_path, monkeypatch) -> Path:
    """views runs the stand-in for scripts/view_shot.mjs; the file it writes {node, browser} pids to."""
    script = tmp_path / "view_shot_stand_in.mjs"
    script.write_text(STAND_IN)
    monkeypatch.setattr(views, "SHOT_SCRIPT", script)
    monkeypatch.setattr(views, "SHOT_STOP_S", 0.5)
    monkeypatch.setenv("STAND_IN_PIDS", str(tmp_path / "pids.json"))
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, "none")
    return tmp_path / "pids.json"


async def _shot_under_way(tmp_path: Path, pids: Path) -> tuple[asyncio.Task, list[int]]:
    """A headless run whose page waits for a reader answer: its task and the pids of its node and its browser."""
    asked = asyncio.Event()

    async def answer(kind, i, msg):
        asked.set()
        await asyncio.Event().wait()  # the reader call in flight

    work = tmp_path / "work"
    work.mkdir()
    task = asyncio.create_task(views._shoot_in(work, "<p>board</p>", [{"out": None, "open": {}}], answer, None,
                                               width=800, height=600, media=None))
    await asyncio.wait_for(asked.wait(), 30)
    got = json.loads(pids.read_text())
    return task, [got["node"], got["browser"]]


async def _left(pids: list[int], wait_s: float = 5.0) -> list[int]:
    """The processes of `pids` still running after up to `wait_s`."""
    deadline = time.monotonic() + wait_s
    while (alive := [p for p in pids if procs.alive(p)]) and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    return alive


def _kill(pids: list[int]) -> None:
    """What the test started and the code under test left: each pid's group (a kernel and the browser lead their own),
    else the pid."""
    for pid in pids:
        if procs.alive(pid):
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGKILL)


async def test_a_server_stop_leaves_no_headless_run_or_kernel_running(stand_in, tmp_path):
    started: list[int] = []
    try:
        await view_calls._start(CORPUS, "views")
        k = notebook._kernel(CORPUS, "views")
        started.append(k.pid)
        async with k.lock:  # a start waits for the lock while the server's shutdown_all drops the kernel
            waiting = asyncio.create_task(view_calls._start(CORPUS, "views"))
            await asyncio.sleep(0)
            await notebook.shutdown_all()
        await waiting
        started.append(k.pid)
        shot, shot_pids = await _shot_under_way(tmp_path, stand_in)
        started += shot_pids
        # the server stops: the modules' shutdown hooks, as main's lifespan calls them
        for module in (notebook, views):
            if (stop := getattr(module, "shutdown", None)) is not None:
                await stop()
        late = None
        with contextlib.suppress(Exception):
            await view_calls._start(CORPUS, "views-2")
            late = notebook._exec_kernels[(CORPUS, "views-2")].pid
            started.append(late)
        shot.cancel()  # as asyncio.run does to the tasks left when the server's loop ends
        with contextlib.suppress(BaseException):
            await shot
        assert not await _left(started), "processes the server started outlived its stop"
        assert late is None, "a kernel started while the server stopped"
    finally:
        _kill(started)


async def test_a_headless_run_whose_task_is_cancelled_as_it_ends_is_killed_with_its_browser(stand_in, tmp_path):
    started: list[int] = []
    try:
        shot, started = await _shot_under_way(tmp_path, stand_in)
        shot.cancel()  # uvicorn's, past its graceful wait: the run closes its stdin and waits for the process
        await asyncio.sleep(0.2)
        shot.cancel()  # asyncio.run's, when the loop ends
        with contextlib.suppress(BaseException):
            await shot
        assert not await _left(started), "the headless run or its browser outlived its cancelled task"
    finally:
        _kill(started)
