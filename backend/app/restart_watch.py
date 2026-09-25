"""Watch the restart after a dev ticket's apply, and roll the apply back when the server does not come back.

dev.spawn_restart_watch runs a copy of this file, detached, so a ticket that broke it cannot break its own rollback;
it uses the standard library only. The server's /api/health answers with a `boot` token new for every start
(config.BOOT_ID). When no new token arrives within `wait_s`, the server is ended, `git revert` takes back the apply's
commits, and the server is started again (only after an execv restart; under uvicorn's reloader the revert restarts
it). <home>/rollback.json and <home>/restart.json tell the next server what happened."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOG_LINES = 40  # of the server log kept in rollback.json, which the ticket's chat shows


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def say(line: str) -> None:
    print(f"{_now()} restart watch: {line}", flush=True)


def health(port: int) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2.0) as r:
            body = json.loads(r.read() or b"{}")
    except Exception:  # noqa: BLE001
        return None
    return body if isinstance(body, dict) and body.get("ok") else None


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def came_back(port: int, old_boot: str | None, wait_s: float) -> bool:
    """Whether a server whose boot token differs from `old_boot` answers within `wait_s`."""
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        body = health(port)
        if body is not None and body.get("boot") != old_boot:
            return True
        time.sleep(1.0)
    return False


def end(pid: int) -> None:
    """End the server's process group (it leads its own session), then the process alone, SIGTERM before SIGKILL."""
    for sig, wait in ((signal.SIGTERM, 8.0), (signal.SIGKILL, 2.0)):
        try:
            os.killpg(pid, sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                return
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if not alive(pid):
                return
            time.sleep(0.2)


def git(repo: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, timeout=120)


def revert(repo: str, prev_head: str, commit: str) -> tuple[bool, str, str]:
    """(ok, the new head, the error)."""
    r = git(repo, "-c", "user.name=thimble dev", "-c", "user.email=dev@thimble.local", "revert", "--no-edit",
            f"{prev_head}..{commit}")
    if r.returncode != 0:
        git(repo, "revert", "--abort")
        return False, "", (r.stderr or r.stdout).strip()[-400:]
    return True, git(repo, "rev-parse", "HEAD").stdout.strip(), ""


def log_tail(home: Path) -> str:
    try:
        lines = (home / "server.log").read_text("utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(ln for ln in lines[-LOG_LINES:] if "restart watch:" not in ln)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False) + "\n", "utf-8")
    tmp.replace(path)


def start(a: dict[str, Any], home: Path) -> int:
    """The server started again as its own session leader, output appended to the server log; server.json names the
    new pid, so the supervisor (and dev.supervised) knows the server."""
    with (home / "server.log").open("ab") as out:
        proc = subprocess.Popen(a["argv"], cwd=a.get("cwd") or None, stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, env=os.environ.copy(), start_new_session=True, close_fds=True)
    sj = Path(a["server_json"]) if a.get("server_json") else None
    if sj is not None:
        try:
            state = json.loads(sj.read_text("utf-8"))
            if isinstance(state, dict):
                write_json(sj, {**state, "pid": proc.pid})
        except (OSError, ValueError):
            pass
    return proc.pid


def main(a: dict[str, Any]) -> int:
    home = Path(a["home"])
    port, wait_s = int(a["port"]), float(a.get("wait_s") or 120)
    title, commit = str(a.get("title") or "a dev ticket"), str(a["commit"])
    if came_back(port, a.get("boot"), wait_s):
        say(f"the server is back after {title!r}")
        return 0
    say(f"the server did not come back within {wait_s:.0f} s after {title!r}; rolling back {commit[:7]}")
    tail = log_tail(home)
    pid = a.get("pid")
    if isinstance(pid, int) and pid > 0 and alive(pid):
        end(pid)
    ok, head, error = revert(str(a["repo"]), str(a["prev_head"]), commit)
    write_json(home / "rollback.json", {"ts": _now(), "ticket_id": a.get("ticket_id"), "title": title, "commit": commit,
                                        "prev_head": a["prev_head"], "reverted": head, "ok": ok, "error": error,
                                        "log_tail": tail, "wait_s": wait_s})
    if not ok:
        say(f"the rollback failed, so the server stays down: {error}")
        return 1
    # the restart.json the server left for its restart names the change, which is gone again: the next server's
    # announcement says it restarted without it
    write_json(home / "restart.json", {"title": f"rollback of {title}", "ts": _now()})
    if a.get("argv"):
        say(f"rolled back as {head[:7]}; started the server again (pid {start(a, home)})")
    else:
        say(f"rolled back as {head[:7]}; the reloader starts the server again")
    say("the server is back" if came_back(port, a.get("boot"), wait_s) else
        f"the server has not answered within {wait_s:.0f} s of the rollback either")
    return 0


if __name__ == "__main__":
    sys.exit(main(json.loads(sys.argv[1])))
