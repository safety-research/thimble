"""The card runner: the terminal plugin's own (plugin/cards/runner.mjs), one Node process per workspace. It runs every
card's view, keeps each card's state and handlers, and makes the text copy of what a card draws (the plugin's
cards/layout.js). The server talks to it over a Unix socket, as the plugin's hooks do (cards/ask.ts): POST /<op> with
a JSON body, each answer JSON. runner.mjs lists the requests (load, draw, copy, key, press, pointer, undo, act, ping).

It starts as the plugin's cards/argv.mjs starts it: an empty environment but PATH, Node's permission model (it reads
the plugin's cards/ code, core/text.js and the workspace's card copies, and writes only its socket's folder), no code
made from strings, at most 1 GB of memory. The boundary is the `vm` context each card version runs in, which holds only
the JavaScript built-ins and the card's rows. Around that the browser adds its sandbox (cards/sandbox.py), as for any
code Claude writes: the process sees only those folders and Node, and has no network. Unix sockets are allowed in it,
since the socket is how the server reaches it.

    ask(ws, op, body)   the runner's answer, or {ok: False, error}: with `down` when the runner cannot start, so no
                        card can draw; without it when the runner stopped while it answered, which the request itself
                        most likely caused (a view that took all the memory), so it is not sent again
    close_all()         stops every runner, when the server stops
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from . import home, prompts
from .cards import sandbox

log = logging.getLogger("thimble_browser.cardrunner")

PLUGIN = prompts.PLUGIN.resolve()
START_S = 10.0
ASK_S = 30.0
SOCKET_MAX = 100  # a socket's path holds at most about 100 bytes (108 on Linux, 104 on macOS)


def cards_dir(ws: str) -> Path:
    d = home.workspace_dir(ws) / "cards"
    d.mkdir(parents=True, exist_ok=True)
    return d


def argv(node: str, cards: Path, run: Path, sock: Path) -> list[str]:
    """The runner's command, as the plugin's cards/argv.mjs makes it (tests/test_cards.py holds them equal), with the
    Node that runs the sandbox."""
    return [node, "--permission", f"--allow-fs-read={PLUGIN}/cards", f"--allow-fs-read={PLUGIN}/core/text.js",
            f"--allow-fs-read={cards}", f"--allow-fs-write={run}", "--disallow-code-generation-from-strings",
            "--max-old-space-size=1024", f"{PLUGIN}/cards/runner.mjs", str(sock)]


@dataclass
class Runner:
    proc: asyncio.subprocess.Process
    folder: Path
    sock: Path
    client: httpx.AsyncClient
    said: list[str] = field(default_factory=list)  # the end of what it wrote to stderr

    def why(self) -> str:
        return " ".join("".join(self.said).strip().splitlines()[-2:])[:300]


_runners: dict[str, Runner] = {}
_starting: dict[str, asyncio.Lock] = {}


def _socket_folder() -> Path:
    """A new folder (mode 700) for a runner's socket, whose path is short enough for one."""
    for base in (tempfile.gettempdir(), "/tmp"):
        d = Path(tempfile.mkdtemp(prefix="thimble-cards-", dir=base)).resolve()
        if len(str(d / "cards.sock")) <= SOCKET_MAX:
            return d
        shutil.rmtree(d, ignore_errors=True)
    raise OSError("no temp folder has a path short enough for the card runner's socket")


async def _start(ws: str, unsandboxed: bool) -> Runner | str:
    """A new runner for the workspace, once it answers; else why it did not start."""
    st = sandbox.status()
    if not st.kind and not unsandboxed:
        return f"thimble browser draws cards only in a sandbox, and found none: {st.why}. {st.fix}"
    node = st.node or shutil.which("node") or ""
    if not node:
        return "Node is not installed, and cards draw on it"
    cards = cards_dir(ws).resolve()
    folder = _socket_folder()
    sock = folder / "cards.sock"
    command = argv(node, cards, folder, sock)
    env = {"PATH": "/usr/bin:/bin"}
    if st.kind:
        rule = sandbox.rules(platform=sys.platform, corpus=cards, run_dir=folder,
                             python=[Path(os.path.realpath(node)).parent.parent],
                             read=[PLUGIN / "cards", PLUGIN / "core" / "text.js"], home_dir=Path.home(),
                             workspaces=home.root())
        rule["network"]["allowUnixSockets" if sys.platform == "darwin" else "allowAllUnixSockets"] = (
            [str(folder)] if sys.platform == "darwin" else True)
        full = sandbox.launcher_argv(node, rule, command, env)
        env = sandbox.launcher_env(folder)
    else:
        full = ["/usr/bin/env", "-i", *(f"{k}={v}" for k, v in env.items()), *command]
    proc = await asyncio.create_subprocess_exec(*full, stdin=asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                                                env=env, cwd=str(folder), start_new_session=True)
    r = Runner(proc, folder, sock, httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(sock)),
                                                     timeout=ASK_S))

    async def listen() -> None:
        assert proc.stderr is not None
        async for line in proc.stderr:
            r.said = (r.said + [line.decode(errors="replace")])[-20:]

    asyncio.get_running_loop().create_task(listen())
    loop = asyncio.get_running_loop()
    until = loop.time() + START_S
    while loop.time() < until and proc.returncode is None:
        try:
            if (await _post(r, "ping", {})).get("ok"):
                return r
        except (httpx.HTTPError, ValueError):
            await asyncio.sleep(0.02)
    await _stop(r)
    why = r.why()
    if "permission" in why.lower() or "bad option" in why.lower():
        return f"Node 22.18 or later is needed to draw cards ({why})"
    return f"the card runner did not start{f' ({why})' if why else ''}"


async def _post(r: Runner, op: str, body: Any) -> dict[str, Any]:
    res = await r.client.post(f"http://runner/{op}", content=json.dumps(body or {}))
    got = res.json()
    return got if isinstance(got, dict) else {"ok": False, "error": "the runner gave no answer"}


async def _stop(r: Runner) -> None:
    await r.client.aclose()
    if r.proc.returncode is None:
        try:
            r.proc.terminate()
            await asyncio.wait_for(r.proc.wait(), 3)
        except (ProcessLookupError, asyncio.TimeoutError):
            try:
                r.proc.kill()
            except ProcessLookupError:
                pass
    shutil.rmtree(r.folder, ignore_errors=True)


async def ask(ws: str, op: str, body: dict[str, Any], *, unsandboxed: bool = False) -> dict[str, Any]:
    """One request to the workspace's runner, starting it when it is not there."""
    lock = _starting.setdefault(ws, asyncio.Lock())
    async with lock:
        r = _runners.get(ws)
        if r is None or r.proc.returncode is not None:
            if r is not None:
                await _stop(r)
            got = await _start(ws, unsandboxed)
            if isinstance(got, str):
                _runners.pop(ws, None)
                return {"ok": False, "error": got, "down": True}
            _runners[ws] = r = got
    try:
        return await _post(r, op, body)
    except (httpx.HTTPError, ValueError):
        await asyncio.sleep(0.05)
        _runners.pop(ws, None)
        why = r.why()
        await _stop(r)
        return {"ok": False, "error": "the card stopped the card runner" + (f" ({why})" if why else "") +
                ", most likely by using too much memory: draw fewer rows or elements"}


async def close_all() -> None:
    for ws in list(_runners):
        await _stop(_runners.pop(ws))
