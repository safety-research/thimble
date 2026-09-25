"""The watch over the restart after a dev ticket's apply (app/restart_watch.py), run as the script the server spawns,
over a scratch git repository, a scratch home and a port where the "server" answers or does not. A server that does
not come back is rolled back to the commit before the apply and started again; one that comes back with a new boot
token is left alone; the old process still answering with its old token does not count as back."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "app" / "restart_watch.py"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True).stdout.strip()


def _repo(tmp_path: Path) -> tuple[Path, str, str]:
    """A checkout with a base commit and the apply on top of it, whose code does not import: (repo, prev_head,
    commit)."""
    repo = tmp_path / "repo"
    (repo / "backend" / "app").mkdir(parents=True)
    (repo / "backend" / "app" / "x.py").write_text("X = 1\n")
    who = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, *who, "add", "-A")
    _git(repo, *who, "commit", "-q", "-m", "base")
    prev = _git(repo, "rev-parse", "HEAD")
    (repo / "backend" / "app" / "x.py").write_text("X = (((\n")
    _git(repo, *who, "commit", "-q", "-am", "dev: ticket abcd1234")
    return repo, prev, _git(repo, "rev-parse", "HEAD")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _run(args: dict) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), json.dumps(args)], capture_output=True, text=True, timeout=60)


def _health(boot: str) -> HTTPServer:
    """A stand-in server on a free port whose /api/health answers with `boot`."""

    class Health(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = json.dumps({"ok": True, "boot": boot}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Health)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_a_server_that_does_not_come_back_is_rolled_back_and_started_again(tmp_path):
    repo, prev, commit = _repo(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    (home / "server.log").write_text("Traceback (most recent call last):\nSyntaxError: '(' was never closed\n")
    (home / "server.json").write_text(json.dumps({"port": 1, "pid": 999999, "repo": str(repo)}))
    # the record the server wrote for the restart that never came back, which names the change
    (home / "restart.json").write_text(json.dumps({"title": "faster start", "ts": "t"}))
    marker = tmp_path / "started"
    argv = [sys.executable, "-c", f"open({str(marker)!r}, 'w').write('started')"]
    out = _run({"port": _free_port(), "boot": "old", "repo": str(repo), "commit": commit, "prev_head": prev,
                "ticket_id": "abcd1234", "title": "faster start", "home": str(home), "wait_s": 1.5,
                "pid": None, "argv": argv, "cwd": str(tmp_path), "server_json": str(home / "server.json")})
    assert out.returncode == 0, out.stdout + out.stderr
    assert "did not come back within 2 s after 'faster start'; rolling back" in out.stdout
    # the apply is reverted by a commit of its own, and the old code is back
    assert (repo / "backend" / "app" / "x.py").read_text() == "X = 1\n"
    assert _git(repo, "log", "-1", "--format=%s").startswith('Revert "dev: ticket abcd1234"')
    rb = json.loads((home / "rollback.json").read_text())
    assert rb["ok"] and rb["ticket_id"] == "abcd1234" and rb["commit"] == commit
    assert rb["reverted"] == _git(repo, "rev-parse", "HEAD")
    assert "SyntaxError" in rb["log_tail"], "the log's last lines say why the server did not start"
    assert json.loads((home / "restart.json").read_text())["title"] == "rollback of faster start"
    # the server is started again with its argv, and server.json names the new process
    deadline = time.monotonic() + 5
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert marker.read_text() == "started"
    assert json.loads((home / "server.json").read_text())["pid"] not in (999999, None)


def test_a_server_that_comes_back_with_a_new_boot_is_left_alone(tmp_path):
    repo, prev, commit = _repo(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    srv = _health("new")
    try:
        out = _run({"port": srv.server_address[1], "boot": "old", "repo": str(repo), "commit": commit,
                    "prev_head": prev, "ticket_id": "abcd1234", "title": "t", "home": str(home), "wait_s": 5})
    finally:
        srv.shutdown()
    assert out.returncode == 0 and "the server is back" in out.stdout
    assert _git(repo, "rev-parse", "HEAD") == commit and not (home / "rollback.json").exists()


def test_the_same_boot_answering_is_the_server_before_the_restart(tmp_path):
    """Until the old process is replaced it may still answer; its token is the old one, which does not count."""
    repo, prev, commit = _repo(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    srv = _health("old")
    try:
        out = _run({"port": srv.server_address[1], "boot": "old", "repo": str(repo), "commit": commit,
                    "prev_head": prev, "ticket_id": "abcd1234", "title": "t", "home": str(home), "wait_s": 1.5})
    finally:
        srv.shutdown()
    assert "rolling back" in out.stdout and (repo / "backend" / "app" / "x.py").read_text() == "X = 1\n"
    assert "the reloader starts the server again" in out.stdout, "with no argv the watch starts nothing"
