"""Stand-ins for terminal mode (the two-modes build, lane agents): a workspace whose launch.json says terminal mode, as the
launcher writes it (lane mode), and thimble's hooks module as it answers in terminal mode (plugin/hooks/thimble.ts), a
thread that takes the requests subagents.json addresses to it and writes module.json, as the module does. Each is a
fixture or a helper a test asks for by name."""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pytest

from app import config
from app import subagent_files as sf

CORPUS = "mini"
MAIN = "7e000000-0000-4000-8000-00000000000a"


def write_launch(ws: Path, session: str = MAIN, mode: str = "terminal", pid: int | None = None, **more: Any) -> None:
    """launch.json as the launcher writes it in terminal mode, with the test process standing in for main's `claude`."""
    sf.ensure(ws)
    rec = {"session": session, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "fenced": True,
           "switches": {}, "unset": [], "pid": os.getpid() if pid is None else pid, "mode": mode, **more}
    sf.launch_path(ws).write_text(json.dumps(rec), "utf-8")


@pytest.fixture()
def terminal_ws(workspaces_tmp) -> Path:
    """The mini corpus's workspace folder, its session in terminal mode."""
    ws = config.workspace_dir(CORPUS)
    write_launch(ws)
    return ws


class FileModule:
    """The hooks module in terminal mode: a heartbeat in module.json, and an answer there to each pending request of
    kind module for its session (`answer(op, args)`, by default a new agent for a spawn and {agentId} for a send or a
    stop, {ok} for a note or a register). `ended` adds a run's end as the module writes it. Start with start(), end
    with stop()."""

    def __init__(self, ws: Path, session: str = MAIN, answer: Callable[[str, dict], dict | None] | None = None,
                 delay_s: float = 0.0) -> None:
        self.ws, self.session, self.delay_s = ws, session, delay_s
        self.answer = answer or self._default
        self.out: dict[str, Any] = {"session": session, "version": "0.6.0", "load": "l0ad", "beat": 0, "plan": None,
                                    "plan_at": 0, "problem": "", "taken": [], "answers": {}, "ended": [], "gone": False}
        self.seen: list[tuple[str, str, dict]] = []  # (id, op, args) of each request taken
        self.n = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.agents = 0

    def _default(self, op: str, args: dict) -> dict | None:
        if op == "spawn":
            self.agents += 1
            return {"agentId": f"a{self.agents:016x}"}
        if op in ("send", "stop"):
            return {"agentId": args.get("agent")}
        return {"ok": True}

    def write(self) -> None:
        self.out["beat"] = int(time.time() * 1000)
        path = sf.module_path(self.ws)
        path.write_text(json.dumps(self.out), "utf-8")

    def ended(self, agent_id: str, answer: str = "", reason: str = "answer", **more: Any) -> None:
        self.n += 1
        self.out["ended"] = [*self.out["ended"], {"n": self.n, "agentId": agent_id, "answer": answer, "reason": reason,
                                                  "at": int(time.time() * 1000), **more}]
        self.write()

    def plan(self, on: bool) -> None:
        self.out["plan"], self.out["plan_at"] = on, int(time.time() * 1000)
        self.write()

    def tick(self) -> None:
        state = sf.read(self.ws)
        now = time.time()
        for rid, r in sorted(sf.requests(state).items(), key=lambda kv: float(kv[1].get("asked_at") or 0)):
            if (not isinstance(r, dict) or r.get("kind") != sf.MODULE_KIND or r.get("module") != "pending"
                    or rid in self.out["taken"] or r.get("session") not in ("", None, self.session)
                    or float(r.get("expires_at") or 0) <= now):
                continue
            self.out["taken"].append(rid)
            self.seen.append((rid, str(r.get("op")), dict(r.get("args") or {})))
            if self.delay_s:
                time.sleep(self.delay_s)
            got = self.answer(str(r.get("op")), dict(r.get("args") or {}))
            if got is not None:
                self.out["answers"][rid] = got
        self.write()

    def _run(self) -> None:
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(0.02)

    def start(self) -> "FileModule":
        self.write()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def ops(self, op: str) -> list[dict]:
        return [a for _, o, a in self.seen if o == op]
