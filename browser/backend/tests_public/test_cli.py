"""thimble-browser's start and stop (app.cli): a detached start in a folder prints the page's link, starts one uvicorn
on its port, which server.json records and which answers health; a second start finds it; `stop` ends it. A start
passes over a taken port (test_port.py). The test starts a real uvicorn on a free port under a scratch THIMBLE_HOME."""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest
from conftest import free_port

from app import cli

BACKEND = Path(__file__).resolve().parents[1]


def _uvicorns_on(p: int) -> list[int]:
    out: list[int] = []
    for entry in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            b = entry.read_bytes()
        except OSError:
            continue
        if b"uvicorn" in b and f"--port\0{p}".encode() in b:
            out.append(int(entry.parent.name))
    return out


# each step is a subprocess with a time limit of its own, so the test cannot hang; its time is a server's start, which a
# machine its parallel runs keep busy makes several times longer
@pytest.mark.timeout(300)
def test_a_detached_browser_start_starts_the_server_once_and_stop_ends_it(home, data, tmp_path, fake_claude):
    try:  # in this process, which runs the same Python on the same tree, rather than in a new one
        import app.main  # noqa: F401, PLC0415
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"app.main does not import in this tree: {type(e).__name__}: {e}"[:300])
    port = free_port()
    env = {**os.environ, "THIMBLE_HOME": str(home), "THIMBLE_PORT": str(port),
           "THIMBLE_DATA_DIR": str(data), "THIMBLE_WORKSPACES_DIR": str(tmp_path / "ws"), "THIMBLE_START_WAIT_S": "100",
           "THIMBLE_HEALTH_TIMEOUT_S": "100"}
    env.pop("THIMBLE_DEV", None)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        env.pop(k, None)
    cmd = [sys.executable, "-m", "app.cli", "browser", "--cwd", str(data / "mini"), "--detach"]
    pid = None
    try:
        out = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120)
        lines = out.stdout.splitlines()
        st = json.loads((home / "server.json").read_text())
        assert out.returncode == 0 and lines[0] == f"thimble browser: http://127.0.0.1:{port}/?ws=mini", out
        assert "ui_key" not in st
        pid = st["pid"]
        assert cli.pid_alive(pid) and st["port"] == port and st["env"]["data_dir"] == str(data)
        assert os.getsid(pid) == pid, "uvicorn is its own session leader"
        from app import hook_auth  # noqa: PLC0415

        proven = urllib.request.Request(f"http://127.0.0.1:{port}/api/health",
                                        headers=hook_auth.headers(st["token"], port))
        with urllib.request.urlopen(proven, timeout=5) as r:
            health = json.loads(r.read())
            assert {k: health[k] for k in ("ok", "leader")} == {"ok": True, "leader": pid}, "the server names the pid server.json records"
            assert len(str(health.get("boot") or "")) == 8, "and a boot token new for each start"
            assert health["home"] == str(home.resolve()), "and its home, to the token's holder"
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as r:
            assert set(json.loads(r.read())) == {"ok", "boot", "ui"}, "no pid or path to a caller without the token"
        out2 = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=30)
        assert out2.stdout.splitlines() == lines and json.loads((home / "server.json").read_text())["pid"] == pid
        assert len(_uvicorns_on(port)) == 1, "a second start finds the server and starts none"
        stop = subprocess.run([sys.executable, "-m", "app.cli", "stop"], cwd=BACKEND, env=env, capture_output=True,
                              text=True, timeout=30)
        assert f"pid {pid}" in stop.stdout
        deadline = time.monotonic() + 10
        while cli.pid_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not cli.pid_alive(pid)
    finally:
        if pid and cli.pid_alive(pid):
            os.kill(pid, 9)
        for q in _uvicorns_on(port):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(q, 9)


def test_continue_keeps_the_open_session_when_it_holds_a_card_but_no_chat(home, data, monkeypatch, capsys):
    """`thimble-browser --continue`, and `--resume` of the session open now, keep that session when it holds a card, a
    label, a document or a side thread but no chat of main with a turn, as a session of an earlier thimble or one with
    a card made by hand does: the page opens a new chat in it. Only a new session moves the open one aside
    (pick_session, open_session), and it says so with the command that brings it back. The server's routes are
    faked."""
    from app import config, notebook  # noqa: PLC0415

    with cli.server_dirs():
        nb = notebook.create_notebook(config.workspace_dir("mini"), "G")
        notebook.insert_cell("mini", nb["id"], notebook.new_cell("note", "test", "By hand", nb["id"],
                                                                 payload={"text": "made by hand"}))
    asked: list[tuple[str, dict]] = []

    def answer(method, url, body=None, timeout=5.0):
        asked.append((url.split("/api/", 1)[1], body or {}))
        return 200, ({"archived": "aside"} if url.endswith("/archive") else {"name": "mini"})

    monkeypatch.setattr(cli, "_request", answer)
    cwd = data / "mini"
    for how, routes in (("continue", ["corpora/register"]), ("new", ["ws/mini/archive", "corpora/register"])):
        asked.clear()
        with cli.server_dirs():
            assert cli.open_session("http://127.0.0.1:1", "mini", cwd, cli.pick_session(cwd, data, how))
        assert [route for route, _ in asked] == routes, how
        assert asked[-1][1]["chat"] == "new"
        said = capsys.readouterr().out.splitlines()
        assert said == ([cli.BROWSER_LINE.format(what=cli.SET_ASIDE_LINE)] if how == "new" else []), how


def test_a_new_session_that_finds_the_open_one_empty_names_the_earlier_one_and_continue_brings_it_back(home, data,
                                                                                                       monkeypatch, capsys):
    """A plain thimble-browser start whose open session is empty, as the start after the one that set the last session
    aside leaves it, says that an earlier session is set aside, what it holds, and that --continue brings it back. The
    server's routes are faked; its archive moves the folder as ledger.archive_workspace does."""
    from app import config, ledger, notebook  # noqa: PLC0415

    with cli.server_dirs():
        nb = notebook.create_notebook(config.workspace_dir("mini"), "G")
        notebook.insert_cell("mini", nb["id"], notebook.new_cell("note", "test", "By hand", nb["id"],
                                                                 payload={"text": "made by hand"}))

    def answer(method, url, body=None, timeout=5.0):
        if url.endswith("/archive"):
            ws = config.workspace_path("mini")
            to = ledger.archive_path("mini")
            to.parent.mkdir(parents=True, exist_ok=True)
            ws.rename(to)
            config.workspace_dir("mini")
            return 200, {"archived": to.name}
        return 200, {"name": "mini"}

    monkeypatch.setattr(cli, "_request", answer)
    cwd = data / "mini"
    said = []
    for _ in range(2):
        with cli.server_dirs():
            assert cli.open_session("http://127.0.0.1:1", "mini", cwd, cli.pick_session(cwd, data, "new"))
        said.append(capsys.readouterr().out.splitlines())
    assert said[0] == [cli.BROWSER_LINE.format(what=cli.SET_ASIDE_LINE)]
    # the second start sets nothing aside, and says what is there to bring back
    assert len(said[1]) == 1 and "thimble-browser --continue brings it back" in said[1][0], said[1]
    assert "0 turns and 1 card" in said[1][0], said[1]
    with cli.server_dirs():
        assert cli.pick_session(cwd, data, "continue")["archive"]


@pytest.mark.timeout(120)
def test_a_quit_leaves_the_server_running_while_another_thimble_browser_holds_it(home, monkeypatch, capsys):
    """One server serves every folder, so the thimble-browser of a second folder uses the server the first one started.
    Ctrl-C in one of them, before its link or after it, stops the server only when no other thimble-browser holds it
    (hold_server, last_holder), and says so when it keeps running. Once the other one has ended, however it ended, the
    next quit stops the server. The other thimble-browser is a process of its own; the stop is faked."""
    import argparse  # noqa: PLC0415

    stops: list[int] = []
    monkeypatch.setattr(cli, "stop", lambda **kw: stops.append(1) or ["server: pid 1 stopped (1 process)"])
    monkeypatch.setattr(cli, "HELD", {})

    def quit_now(_s: float) -> None:
        raise KeyboardInterrupt

    def hold_again() -> None:  # this terminal's next thimble-browser
        os.close(cli.HELD.pop("fd"))
        cli.hold_server()

    other = subprocess.Popen([sys.executable, "-c", "from app import cli; cli.hold_server(); print('holding', flush=True); "
                              "import time; time.sleep(100)"], cwd=BACKEND, env={**os.environ, "THIMBLE_HOME": str(home)},
                             stdout=subprocess.PIPE, text=True)
    try:
        assert other.stdout.readline().strip() == "holding"
        cli.hold_server()
        cli.hold_until_quit(sleep=quit_now)
        assert stops == [] and capsys.readouterr().out.splitlines()[-1] == cli.KEPT_LINE
        hold_again()
        monkeypatch.setattr(cli, "LAST_START", {"pid": other.pid})  # a server this run started, stand-in
        assert cli.interrupted(argparse.Namespace(cmd="browser", detach=False)) == 130
        assert stops == [] and capsys.readouterr().out.splitlines()[-1] == cli.KEPT_LINE
    finally:
        other.kill()
        other.wait(timeout=10)
    hold_again()
    cli.hold_until_quit(sleep=quit_now)
    assert stops == [1] and cli.STOPPING_LINE in capsys.readouterr().out.splitlines()
    os.close(cli.HELD.pop("fd"))


def test_stop_ends_a_server_that_a_restart_started_in_another_tree(tmp_path, monkeypatch):
    """A fix that goes on starts the server again from the checkout of the person's fixes, under the same pid
    (fixes.restart, dev._do_restart). The server records the tree it runs from as it starts, so that the launcher's
    stop (its Ctrl-C) ends it there, as it ends the server it started."""
    from app import config  # noqa: PLC0415

    clone, live = tmp_path / "clone" / "browser", tmp_path / "fixes" / "live" / "browser"
    for d in (clone, live):
        (d / "backend").mkdir(parents=True)
    port = free_port()
    # the server's command line, in live's backend folder
    server = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)", "uvicorn", "app.main:app", "--port",
                               str(port)], cwd=live / "backend", start_new_session=True)
    try:
        monkeypatch.setattr(config, "REPO_ROOT", clone)
        cli.write_state({"port": port, "pid": server.pid, "repo": str(clone)})
        monkeypatch.setattr(config, "REPO_ROOT", live)
        cli.record_source_fingerprint(server.pid)
        monkeypatch.setattr(config, "REPO_ROOT", clone)
        assert f"server: pid {server.pid} stopped" in cli.stop(vite=False)
        assert server.wait(timeout=10) is not None
    finally:
        if server.poll() is None:
            server.kill()
