"""`thimble-browser --link` (app.cli cmd_link, and the launcher browser/scripts/thimble-browser): a fresh sign-in link
to the server that runs, for the folder's workspace, with no new session. It starts, registers and moves aside nothing,
so the page keeps its chat. With no server answering it says so, builds no page and starts no server."""
from __future__ import annotations

import json
import socket
import subprocess
from pathlib import Path

import pytest

from app import cli

LAUNCHER = Path(__file__).resolve().parents[2] / "scripts" / "thimble-browser"
VENV_PYTHON = Path(__file__).resolve().parents[1] / ".venv" / "bin" / "python"

pytestmark = pytest.mark.usefixtures("named_sessions")


def test_link_prints_a_fresh_sign_in_link_for_the_folder_and_starts_nothing(home, data, monkeypatch, capsys, tmp_path):
    """With the server running: the link of the folder's workspace (also from a folder in it) with a new code at each
    call, and the start page's link for a folder the server holds no workspace for. Nothing is started, registered or
    moved aside. A link that a program reads has no code, as at the start. With no server, the line says so."""
    cli.write_state({"port": 8399, "url": "http://127.0.0.1:8399", "env": {}})
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    started: list = []
    monkeypatch.setattr(cli, "ensure_running", lambda wait: started.append(wait) or True)
    monkeypatch.setattr(cli, "spawn", lambda *a, **k: started.append(a) or 1)
    posted: list[tuple[str, dict | None]] = []

    def request(m, u, b=None, timeout=5.0):
        if m != "POST":  # the health check that tells this install's server from another's: an older server's 404
            return 404, {"detail": "Not Found"}
        posted.append((u.removeprefix("http://127.0.0.1:8399"), b))
        if u.endswith("/api/ui/pair"):
            return 200, {"code": f"c{len(posted)}", "expires_s": 300}
        return 201, {}

    monkeypatch.setattr(cli, "_request", request)
    monkeypatch.setattr(cli, "to_terminal", lambda: True)
    runs = tmp_path / "runs"
    (runs / "agents").mkdir(parents=True)
    (data / "runs.corpus.json").write_text(json.dumps({"name": "runs", "root": str(runs), "path": str(runs)}))
    other = tmp_path / "other"
    other.mkdir()
    for folder in (runs, runs / "agents", other):
        assert cli.main(["link", "--cwd", str(folder)]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble browser: http://127.0.0.1:8399/?ws=runs#p=c1",
                                                    "thimble browser: http://127.0.0.1:8399/?ws=runs#p=c2",
                                                    "thimble browser: http://127.0.0.1:8399/#p=c3"]
    assert posted == [("/api/ui/pair", {"ws": "runs"}), ("/api/ui/pair", {"ws": "runs"}), ("/api/ui/pair", {})]
    assert started == []
    posted.clear()
    monkeypatch.setattr(cli, "to_terminal", lambda: False)
    assert cli.main(["link", "--cwd", str(runs)]) == 0
    assert capsys.readouterr().out.splitlines() == ["thimble browser: http://127.0.0.1:8399/?ws=runs"]
    assert posted == [], "no code for a program's output"
    monkeypatch.setattr(cli, "to_terminal", lambda: True)
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (404, {"detail": "Not Found"}))
    assert cli.main(["link", "--cwd", str(runs)]) == 1, "a server that gives no code gives no fresh link"
    assert capsys.readouterr().out.splitlines() == ["thimble browser: http://127.0.0.1:8399/?ws=runs",
                                                    cli.NO_CODE_LINE.format(log=cli.log_path())]
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    assert cli.main(["link", "--cwd", str(runs)]) == 1
    assert capsys.readouterr().out.splitlines() == [cli.BROWSER_LINE.format(what=cli.LINK_NO_SERVER_LINE)]
    assert started == [] and posted == []


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.skipif(not VENV_PYTHON.exists(), reason="the launcher runs the server's .venv, which uv sync makes")
def test_the_launcher_s_link_with_no_server_running_says_so_and_builds_and_starts_nothing(tmp_path):
    """thimble-browser --link FOLDER, with homes of the test's own and a free port: no server answers there, so it
    prints the line that says so and how to start one, and exits 1, without a page build (npm) or a server."""
    port = _free_port()
    stubs = tmp_path / "stubs"
    stubs.mkdir()
    npm_log = tmp_path / "npm.log"
    (stubs / "npm").write_text(f'#!/bin/sh\necho "$@" >> "{npm_log}"\n')
    (stubs / "npm").chmod(0o755)
    folder = tmp_path / "runs"
    folder.mkdir()
    env = {"PATH": f"{stubs}:/usr/bin:/bin", "HOME": str(tmp_path / "home"), "THIMBLE_HOME": str(tmp_path / "plugin-home"),
           "THIMBLE_BROWSER_HOME": str(tmp_path / "browser-home"), "THIMBLE_SKIP_KEY": "1"}
    p = subprocess.run([str(LAUNCHER), "--link", "--port", str(port), str(folder)], capture_output=True, text=True,
                       env=env, stdin=subprocess.DEVNULL, timeout=60)
    assert p.returncode == 1, p.stdout + p.stderr
    assert p.stdout.splitlines() == [cli.BROWSER_LINE.format(what=cli.LINK_NO_SERVER_LINE)], p.stderr
    assert not npm_log.exists(), "no page build"
    with socket.socket() as s:
        assert s.connect_ex(("127.0.0.1", port)) != 0, "no server started"
