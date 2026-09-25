"""What the supervisor says about the machine when something is off: the doctor's machine lines (versions, Claude Code
against the tested version, Node, the port, disk, the network, the delivery route), why a `server up` found no server
(another program on the port, the error the server exited with), a full disk, the log's rotation, the log's recent
errors in the doctor, and the warning an old Claude Code gets at launch and at /thimble. Nothing here runs `claude`,
opens a connection off this machine, or probes a port it did not bind."""
from __future__ import annotations

import errno
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import cc_channel, cli, procs

# the readers the fixture below stands in for, as this module imported them
REAL_CLAUDE_CODE_VERSION = cli.claude_code_version
REAL_NETWORK_LINE = cli.network_line


@pytest.fixture(autouse=True)
def _no_probes_of_the_machine(monkeypatch):
    """The doctor and `up` read Claude Code's version (`claude --version`) and try a connection to the API host; the
    tests run neither, so they are the same offline and on a machine without claude. The tests of those readers call
    the functions this module imported before the patch."""
    monkeypatch.setattr(cli, "claude_code_version", lambda: cli.TESTED_CLAUDE_CODE)
    monkeypatch.setattr(cli, "network_line", lambda timeout_s=cli.NET_TIMEOUT_S: f"{cli.API_HOST} answers")


def _script(folder: Path, name: str, body: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / name
    p.write_text(f"#!/bin/sh\n{body}\n")
    p.chmod(0o755)
    return p


def _finished_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


@pytest.fixture()
def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _no_holdings(monkeypatch) -> None:
    """`up` asks the server what the workspace holds; here nothing answers, so no request leaves the test."""
    monkeypatch.setattr(cli, "_request", lambda m, u, b=None, timeout=5.0: (404, {"detail": "Not Found"}))


# ----------------------------------------------------------------------------- versions


def test_claude_code_older_than_tested_or_missing_gets_a_warning_and_the_same_or_newer_none():
    assert cli.version_tuple("2.1.282 (Claude Code)") == (2, 1, 282) and cli.version_tuple("no version") is None
    old = cli.claude_code_warning("2.1.100")
    assert old.startswith("thimble: WARNING - Claude Code 2.1.100 is older than " + cli.TESTED_CLAUDE_CODE)
    assert "`claude update`" in old
    assert cli.claude_code_warning(cli.TESTED_CLAUDE_CODE) is None and cli.claude_code_warning("9.0.0") is None
    assert "not found on PATH" in cli.claude_code_warning(None)


def test_claude_code_version_reads_what_the_binary_prints(monkeypatch, tmp_path):
    fake = _script(tmp_path / "bin", "claude", 'echo "2.1.290 (Claude Code)"')
    monkeypatch.setenv("THIMBLE_CLAUDE_BIN", str(fake))
    assert REAL_CLAUDE_CODE_VERSION() == "2.1.290"
    monkeypatch.setenv("THIMBLE_CLAUDE_BIN", str(_script(tmp_path / "bin", "silent", "exit 0")))
    assert REAL_CLAUDE_CODE_VERSION() is None
    monkeypatch.setattr(cli, "claude_code_version", lambda: "2.1.200")
    assert cli.claude_code_line().startswith("Claude Code 2.1.200 is older than")
    monkeypatch.setattr(cli, "claude_code_version", lambda: "2.1.300")
    assert cli.claude_code_line() == f"2.1.300 (thimble is tested with {cli.TESTED_CLAUDE_CODE})"


def test_node_line_names_what_custom_views_need(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    assert cli.node_line().startswith("not found; custom views need Node 20+")
    _script(tmp_path / "bin", "node", "echo v18.19.0")
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    assert cli.node_line().startswith("v18.19.0, too old; custom views need Node 20+")
    _script(tmp_path / "bin", "node", "echo v22.1.0")
    monkeypatch.setattr(cli, "FRONTEND_DIR", tmp_path / "frontend")
    assert cli.node_line().startswith("v22.1.0; ") and "npm ci" in cli.node_line()
    (tmp_path / "frontend" / "node_modules").mkdir(parents=True)
    assert cli.node_line() == "v22.1.0"


def test_an_old_claude_code_is_named_at_launch_and_at_thimble(home, data, monkeypatch, capsys, named_sessions):
    monkeypatch.setattr(cli, "claude_code_version", lambda: "2.1.100")
    monkeypatch.setattr(cli, "launch_args", lambda cwd, resume=False: "tools\n\nprompt")
    assert cli.main(["launch-args", "--cwd", str(data)]) == 0
    got = capsys.readouterr()
    assert got.out == "tools\n\nprompt\n" and got.err.startswith("thimble: WARNING - Claude Code 2.1.100 is older than")
    monkeypatch.setattr(cli, "ensure_running", lambda wait: True)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: True)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    _no_holdings(monkeypatch)
    cli.write_state({"port": 8300, "url": "http://127.0.0.1:5300", "env": {}})
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s1"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "thimble: http://127.0.0.1:5300/?ws=mini"
    assert any(line.startswith("thimble: WARNING - Claude Code 2.1.100 is older than") for line in out)
    monkeypatch.setattr(cli, "claude_code_version", lambda: cli.TESTED_CLAUDE_CODE)
    assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s1"]) == 0
    assert "WARNING" not in capsys.readouterr().out


def test_the_launcher_stops_with_a_sentence_when_claude_is_missing():
    text = (cli.config.REPO_ROOT / "plugin" / "bin" / "thimble").read_text()
    check = text.index("command -v claude >/dev/null 2>&1 ||")
    assert check < text.index('exec claude ') and "the `claude` CLI is not on PATH" in text


def test_the_claude_code_version_of_a_process_comes_from_its_executable(tmp_path):
    if not procs.HAVE_PROC:
        pytest.skip("reads /proc")
    exe = tmp_path / "2.1.300"
    exe.write_bytes(Path(cli.shutil.which("sleep")).read_bytes())
    exe.chmod(0o755)
    p = subprocess.Popen([str(exe), "30"])
    try:
        time.sleep(0.2)
        assert procs.version_of(p.pid) == "2.1.300"
    finally:
        p.kill()
        p.wait()
    assert procs.version_of(os.getpid()) is None and procs.version_of(None) is None


# ----------------------------------------------------------------------------- the machine


def test_disk_line_says_low_when_little_is_free_and_names_one_line_per_filesystem(monkeypatch, tmp_path):
    a, b = tmp_path / "a", tmp_path / "b" / "not-yet"
    a.mkdir()
    assert cli.disk_line([a, b]).count(" free at ") == 1, "one filesystem, one entry"
    monkeypatch.setattr(cli.shutil, "disk_usage", lambda p: type("U", (), {"free": 200_000_000})())
    line = cli.disk_line([a])
    assert line.startswith("200.0 MB free at ") and "LOW, free some space or writes will fail" in line


def test_port_line_names_another_program_on_the_port_and_the_way_around_it(monkeypatch, free_port):
    assert cli.port_line(free_port, False) == f"{free_port} (free)"
    assert cli.port_line(free_port, True) == f"{free_port} (thimble answers there)"
    with socket.socket() as s:
        s.bind(("127.0.0.1", free_port))
        s.listen()
        monkeypatch.setattr(procs, "listener", lambda p: os.getpid())
        line = cli.port_line(free_port, False)
    assert line.startswith(f"{free_port} is taken by another program (pid {os.getpid()}: ")
    assert "THIMBLE_PORT=<port> thimble" in line


def test_procs_listener_finds_the_pid_that_listens(free_port):
    if not (cli.shutil.which("lsof") or cli.shutil.which("ss")):
        pytest.skip("neither lsof nor ss on this machine")
    with socket.socket() as s:
        s.bind(("127.0.0.1", free_port))
        s.listen()
        assert procs.listener(free_port) == os.getpid()
    assert procs.listener(free_port) is None


def test_delivery_line_names_the_route_a_launched_session_would_take(home, monkeypatch, tmp_path):
    assert cli.delivery_line(tmp_path).startswith("channel")
    monkeypatch.setattr(cc_channel, "claude_ai_login", lambda cwd, environ=None, argv=None: False)
    line = cli.delivery_line(tmp_path)
    assert line.startswith("hooks (channels need a claude.ai login") and "browser messages still arrive" in line
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text(json.dumps({"disableAllHooks": True}))
    assert cli.delivery_line(tmp_path).startswith("Monitor (channels need a claude.ai login")


def test_network_line_names_the_host_it_cannot_reach(monkeypatch):
    def unreachable(address, timeout=None):
        raise socket.gaierror(-2, "Name or service not known")

    monkeypatch.setattr(cli.socket, "create_connection", unreachable)
    monkeypatch.delenv(cli.SANDBOX_ENV, raising=False)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.example.invalid/v1")
    assert cli.api_host() == "api.example.invalid"
    line = REAL_NETWORK_LINE(timeout_s=1.0)
    assert line.startswith("cannot reach api.example.invalid (") and line.endswith("model calls fail until the network is back")
    monkeypatch.delenv("ANTHROPIC_BASE_URL")
    assert cli.api_host() == cli.API_HOST
    monkeypatch.setenv(cli.SANDBOX_ENV, "1")
    assert REAL_NETWORK_LINE().startswith("not checked: this runs inside Claude Code's Bash sandbox")


def test_doctor_prints_the_machine_lines_and_survives_one_that_fails(home, monkeypatch, free_port):
    monkeypatch.setenv("THIMBLE_PORT", str(free_port))
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    text = cli.doctor_text()
    for head in ("  versions: thimble ", "  claude code: ", "  node: ", f"  port: {free_port}", "  disk: ", "  network: ",
                 "  delivery (a session `thimble` starts in "):
        assert head in text, head
    monkeypatch.setattr(cli, "node_line", lambda: (_ for _ in ()).throw(RuntimeError("broken node")))
    assert "  node: not checked (RuntimeError: broken node)" in cli.doctor_text()


def test_doctor_lists_the_log_s_recent_errors_after_its_tail(home, monkeypatch, free_port):
    monkeypatch.setenv("THIMBLE_PORT", str(free_port))
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    home.mkdir(parents=True, exist_ok=True)
    cli.log_path().write_text("\n".join([
        "2026-09-25 03:43:41,891 INFO thimble: data dir /d",
        "2026-09-25 03:43:42,361 ERROR thimble.error: request 14acf8b8 failed: GET /api/ws/w/chats (workspace w) -> 500",
        "Traceback (most recent call last):",
        "KeyError: 'attached'",
        "2026-09-25 03:43:43,000 INFO:     127.0.0.1:1 - \"GET /api/health HTTP/1.1\" 200 OK",
        "ERROR:    [Errno 98] error while attempting to bind on address ('127.0.0.1', 8300): address already in use",
    ] + [f"filler {i}" for i in range(20)]) + "\n")
    text = cli.doctor_text()
    assert text.index("  log tail (") < text.index("  recent errors in the log (3 of its last 2.0 MB):")
    recent = text.split("  recent errors in the log")[1]
    assert "request 14acf8b8 failed" in recent and "KeyError: 'attached'" in recent and "address already in use" in recent
    assert "INFO thimble: data dir" not in recent and "GET /api/health" not in recent
    cli.log_path().write_text("2026-09-25 03:43:41,891 INFO thimble: all well\n")
    assert "  recent errors in the log: none in its last 2.0 MB" in cli.doctor_text()


# ----------------------------------------------------------------------------- why a server up found no server


def test_a_start_whose_process_exited_ends_the_wait_and_names_the_error(home, monkeypatch):
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    pid = _finished_pid()
    t = time.monotonic()
    assert cli.wait_healthy("http://127.0.0.1:1", 10.0, pid) is False
    assert time.monotonic() - t < 2.0, "the wait ends once the spawned server has exited"
    home.mkdir(parents=True, exist_ok=True)
    cli.log_path().write_text("an older run's line\nValueError: from before\n")
    offset = cli.log_path().stat().st_size
    with cli.log_path().open("a") as f:
        f.write("Traceback (most recent call last):\n  File \"x\", line 1\nModuleNotFoundError: No module named 'fastapi'\n")
    cli.LAST_START.update(pid=pid, port=1, log_offset=offset)
    monkeypatch.setattr(cli, "listening", lambda p: False)
    try:
        assert cli.start_failure("http://127.0.0.1:1") == ("the server exited while starting: ModuleNotFoundError: "
                                                           "No module named 'fastapi'")
        with cli.log_path().open("a") as f:
            f.write("INFO:     Started server process [1]\nERROR:    [Errno 98] error while attempting to bind on address "
                    "('127.0.0.1', 8300): address already in use\n")
        assert cli.start_failure("http://127.0.0.1:1").endswith("address already in use")
    finally:
        cli.LAST_START.clear()
    assert cli.start_failure("http://127.0.0.1:1") == ""


def test_up_names_the_program_on_the_port_instead_of_waiting_blind(home, data, monkeypatch, capsys, free_port,
                                                                   named_sessions):
    monkeypatch.setenv("THIMBLE_PORT", str(free_port))
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(procs, "listener", lambda p: os.getpid())

    def ensure(wait):
        cli.LAST_START.update(pid=_finished_pid(), port=free_port, log_offset=0)
        return False

    monkeypatch.setattr(cli, "ensure_running", ensure)
    try:
        with socket.socket() as s:
            s.bind(("127.0.0.1", free_port))
            s.listen()
            assert cli.main(["up", "--cwd", str(data / "mini"), "--session", "s1"]) == 0
    finally:
        cli.LAST_START.clear()
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith(f"thimble: the server did not start: {free_port} is taken by another program (pid {os.getpid()}")
    assert "THIMBLE_PORT=<port> thimble" in out[0] and "thimble doctor" in out[1]
    assert f"no server answers at http://127.0.0.1:{free_port} ({free_port} is taken" in cli.log_path().read_text()


def test_a_full_disk_is_named_with_its_path(home, data, monkeypatch, capsys, named_sessions):
    full = OSError(errno.ENOSPC, "No space left on device", str(home / "server.json"))
    assert cli.failure_text(full) == f"the disk that holds {home / 'server.json'} is full; free some space, then try again"
    assert cli.failure_text(PermissionError(errno.EACCES, "Permission denied", "/x")) == "cannot write /x (Permission denied)"
    assert cli.failure_text(ValueError("x")) is None

    def boom(wait):
        raise full

    monkeypatch.setattr(cli, "ensure_running", boom)
    assert cli.main(["server", "up", "--cwd", str(data / "mini"), "--session", "s1"]) == 0
    assert capsys.readouterr().out.strip() == (f"thimble: server up failed: the disk that holds {home / 'server.json'} "
                                               "is full; free some space, then try again")
    log = cli.log_path().read_text()
    assert "server up failed: OSError" in log and "Traceback (most recent call last)" in log


def test_a_failed_command_logs_its_traceback(home, monkeypatch, capsys):
    monkeypatch.setattr(cli, "doctor_text", lambda: (_ for _ in ()).throw(RuntimeError("doctor broke")))
    assert cli.main(["doctor"]) == 1
    assert "thimble doctor: RuntimeError: doctor broke" in capsys.readouterr().err
    log = cli.log_path().read_text()
    assert "doctor failed: RuntimeError: doctor broke" in log and "Traceback (most recent call last)" in log


def test_a_large_log_is_moved_aside_when_a_server_starts(home, tmp_path):
    home.mkdir(parents=True, exist_ok=True)
    small = tmp_path / "small.log"
    small.write_text("x\n")
    assert cli.rotate_log(small, limit=100) is False and small.exists()
    big = tmp_path / "server.log"
    big.write_text("y" * 200)
    (tmp_path / "server.log.1").write_text("older")
    assert cli.rotate_log(big, limit=100) is True
    assert not big.exists() and (tmp_path / "server.log.1").read_text() == "y" * 200
    assert cli.rotate_log(tmp_path / "missing.log") is False
