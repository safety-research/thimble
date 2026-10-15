"""The server's port (app.cli, module note): without THIMBLE_PORT, a port another program or another install's server
holds is passed over for a free one, which server.json records and every reader finds there (this CLI, the launcher,
the browser link, the plugin's shim, watcher, statusline and permission hook). With THIMBLE_PORT that port alone is
used, and a taken one gets today's answer: FOREIGN_LINE for another install's server, the port line for another
program. Two THIMBLE_HOMEs side by side each start and find their own server. A real listener stands in for the program
that holds a port; the integration test starts two real uvicorns on free ports, never on the default port."""
from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from app import cli, config, hook_auth, permission_hook, procs

PORT_FREE = cli.port_free  # before the home fixture stands it in
SERVER_FOR_LAUNCH = cli.server_for_launch  # before conftest's autouse fixture stands it in
BACKEND = Path(__file__).resolve().parents[1]
PLUGIN_BIN = config.REPO_ROOT / "plugin" / "bin"


def _held() -> socket.socket:
    """A listener on a free port of the loopback, as another program holds a port."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    return s


def _script(name: str):
    """A plugin script of bin/, loaded as a module (its shell line is a string to Python)."""
    loader = importlib.machinery.SourceFileLoader(f"port_test_{name.strip('.').replace('-', '_')}", str(PLUGIN_BIN / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def _found_by_readers() -> set[str]:
    """The server address each reader of server.json in THIMBLE_HOME finds: the plugin's MCP shim, its hooks' watcher,
    its statusline and the permission hook."""
    found = {_script(n).server() for n in ("thimble-mcp", ".thimble-watch", "thimble-agents")}
    found.add(permission_hook.server())
    return {f[0] if f else "" for f in found}


class FakeServer:
    """spawn's stand-in: each backend spawn answers health on the port its command names, from the next probe on."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.port = 0

    def __call__(self, cmd, *, cwd, env, log_file):
        self.calls.append(list(cmd))
        if "uvicorn" in cmd:
            self.port = int(cmd[cmd.index("--port") + 1])
        return 40000 + len(self.calls)

    @property
    def ports(self) -> list[int]:
        return [int(c[c.index("--port") + 1]) for c in self.calls if "uvicorn" in c]


@pytest.fixture()
def server(home, monkeypatch):
    """The supervisor with FakeServer for spawn, the real port probes, and health answered where it runs."""
    sp = FakeServer()
    monkeypatch.setattr(cli, "spawn", sp)
    monkeypatch.setattr(cli, "port_free", PORT_FREE)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: bool(sp.port) and
                        (url or cli.api_url()) == f"http://127.0.0.1:{sp.port}")
    monkeypatch.setattr(cli, "pid_alive", lambda pid: pid == 40000 + len(sp.calls))
    monkeypatch.setattr(cli, "spawned_exited", lambda pid: False)
    monkeypatch.setattr(cli, "is_server", lambda pid, p, repo=None: pid == 40000 + len(sp.calls) and p == sp.port)
    return sp


def test_a_taken_default_port_is_passed_over_for_a_free_one_that_server_json_records_and_every_reader_finds(
        server, data, monkeypatch, capsys):
    """Another program holds the default port: `up` starts the server on a free port above it, server.json records it,
    the link names it, and the CLI and the plugin's readers find the server there; the next `up` starts nothing."""
    held = _held()
    try:
        taken = held.getsockname()[1]
        monkeypatch.setattr(cli, "DEFAULT_PORT", taken)
        assert cli.explicit_port() is None and cli.port() == taken
        assert cli.main(["up", "--cwd", str(data / "mini")]) == 0
        picked = server.ports[0]
        assert picked != taken and taken < picked <= taken + cli.PORT_SCAN
        st = json.loads((cli.server_json()).read_text())
        assert (st["port"], st["api"], st["url"]) == (picked, f"http://127.0.0.1:{picked}", f"http://127.0.0.1:{picked}")
        assert capsys.readouterr().out.splitlines()[0] == f"thimble: http://127.0.0.1:{picked}/?ws=mini"
        assert cli.port() == picked and cli.api_url() == f"http://127.0.0.1:{picked}"
        assert _found_by_readers() == {f"http://127.0.0.1:{picked}"}
        assert cli.main(["up", "--cwd", str(data / "mini")]) == 0
        assert server.ports == [picked], "found: no second start"
        assert capsys.readouterr().out.splitlines()[0] == f"thimble: http://127.0.0.1:{picked}/?ws=mini"
    finally:
        held.close()


def test_a_port_the_last_start_recorded_is_kept_while_free_and_passed_over_once_taken(server, monkeypatch):
    """The port server.json records is the one the next start takes while it is free (the browser's link and cookie
    stay); taken by then, the start passes over it as over the default."""
    held = _held()
    recorded = held.getsockname()[1]
    held.close()
    cli.write_state({"port": recorded})
    assert cli.ensure_running(2.0) and server.ports == [recorded]
    cli.write_state({**cli.read_state(), "pid": None})
    server.port = 0
    again = socket.socket()
    try:
        again.bind(("127.0.0.1", recorded))
        again.listen(1)
        assert cli.ensure_running(2.0)
        assert server.ports[1] != recorded and cli.read_state()["port"] == server.ports[1] == cli.port()
    finally:
        again.close()


def test_in_dev_mode_a_taken_ui_port_is_passed_over_for_vite_unless_thimble_ui_port_names_it(server, monkeypatch,
                                                                                            tmp_path):
    """Dev mode: another program (or another install's Vite) on the UI port, and Vite starts on a free port, which the
    link names; this install's own Vite there is kept; THIMBLE_UI_PORT names the one port, as before."""
    monkeypatch.setenv("THIMBLE_DEV", "1")
    (tmp_path / "frontend" / "node_modules").mkdir(parents=True)
    monkeypatch.setattr(cli, "FRONTEND_DIR", tmp_path / "frontend")
    free = _held()
    monkeypatch.setattr(cli, "DEFAULT_PORT", free.getsockname()[1])
    free.close()
    held = _held()
    try:
        ui = held.getsockname()[1]
        monkeypatch.setattr(cli, "DEFAULT_UI_PORT", ui)
        st = cli.start()
        vite = [c for c in server.calls if "vite" in c]
        assert len(vite) == 1 and vite[0][vite[0].index("--port") + 1] != str(ui)
        picked = int(vite[0][vite[0].index("--port") + 1])
        assert (st["ui_port"], st["url"]) == (picked, f"http://127.0.0.1:{picked}") and cli.ui_port() == picked
        assert picked != st["port"]

        cli.write_state({**st, "ui_port": ui, "vite_pid": 777})
        monkeypatch.setattr(cli, "pid_alive", lambda pid: pid == 777)
        monkeypatch.setattr(cli, "_cmdline", lambda pid: f"node npx vite --port {ui} --strictPort" if pid == 777 else "")
        server.calls.clear()
        st = cli.start()
        assert not [c for c in server.calls if "vite" in c] and (st["ui_port"], st["vite_pid"]) == (ui, 777), "its own Vite"

        cli.write_state({**st, "vite_pid": None})
        monkeypatch.setenv("THIMBLE_UI_PORT", str(ui))
        server.calls.clear()
        st = cli.start()
        assert not [c for c in server.calls if "vite" in c] and st["url"] == f"http://127.0.0.1:{ui}", "THIMBLE_UI_PORT"
    finally:
        held.close()


def test_a_port_this_installs_own_stuck_server_holds_is_kept_so_the_failure_names_it(server, monkeypatch):
    """This install's own server holding the port but not answering is not passed over: a second server would run
    beside it, so the start keeps the port and the failure names the stuck server (start_failure)."""
    held = _held()
    try:
        p = held.getsockname()[1]
        cli.write_state({"port": p, "pid": 4242, "repo": str(config.REPO_ROOT)})
        monkeypatch.setattr(cli, "is_server", lambda pid, q, repo=None: pid == 4242 and q == p)
        assert cli.held_by_this_install(p, cli.read_state())
        cli.start()
        assert server.ports == [p]
        cli.write_state({"port": p, "pid": None})
        monkeypatch.setattr(procs, "listener", lambda q: 4242 if q == p else None)
        monkeypatch.setattr(procs, "environ", lambda pid: {"THIMBLE_HOME": str(cli.home())})
        assert cli.held_by_this_install(p, cli.read_state()), "the listener runs with this THIMBLE_HOME"
        monkeypatch.setattr(procs, "environ", lambda pid: {"THIMBLE_HOME": "/another/home"})
        assert not cli.held_by_this_install(p, cli.read_state()), "another install's server of this checkout"
    finally:
        held.close()


def test_thimble_port_taken_gets_todays_answer_and_without_it_the_port_is_passed_over(server, data, monkeypatch,
                                                                                    capsys):
    """THIMBLE_PORT names the port: another install's server there is refused with FOREIGN_LINE by `up` and the launch,
    which start nothing, and another program there makes the start fail with the port line. Without THIMBLE_PORT the
    same port is passed over: no FOREIGN_LINE, and the server starts on a free port."""
    held = _held()
    try:
        p = held.getsockname()[1]
        url = f"http://127.0.0.1:{p}"
        monkeypatch.setattr(cli, "DEFAULT_PORT", p)
        theirs = {"healthy": True}  # another install's server answers on the port, until another program holds it
        ours = cli.healthy
        monkeypatch.setattr(cli, "healthy", lambda u=None, timeout=1.0: (theirs["healthy"] if (u or cli.api_url()) == url
                                                                          else ours(u, timeout)))
        monkeypatch.setattr(cli, "foreign_home", lambda u=None: ("/other/home" if (u or cli.api_url()) == url
                                                                 and theirs["healthy"] else None))
        foreign = cli.FOREIGN_LINE.format(port=p, other="/other/home")

        monkeypatch.setenv("THIMBLE_PORT", str(p))
        assert cli.main(["up", "--cwd", str(data / "mini")]) == 0
        assert capsys.readouterr().out.splitlines() == [foreign]
        assert SERVER_FOR_LAUNCH("mini") == [foreign]
        assert server.calls == [], "refused: nothing started"

        monkeypatch.delenv("THIMBLE_PORT")
        assert SERVER_FOR_LAUNCH("mini") == []
        assert cli.main(["up", "--cwd", str(data / "mini")]) == 0
        out = capsys.readouterr().out
        assert foreign not in out and len(server.ports) == 1 and server.ports[0] != p
        assert out.splitlines()[0] == f"thimble: http://127.0.0.1:{server.ports[0]}/?ws=mini"

        # another program on the port THIMBLE_PORT names: the start tries it and fails, with the port line
        (cli.server_json()).unlink()
        server.calls.clear()
        server.port = 0
        theirs["healthy"] = False
        monkeypatch.setenv("THIMBLE_PORT", str(p))
        monkeypatch.setattr(cli, "spawned_exited", lambda pid: True)
        assert cli.main(["up", "--cwd", str(data / "mini")]) == 0
        out = capsys.readouterr().out
        assert server.ports == [p], "THIMBLE_PORT alone"
        assert f"thimble: no server answers: {p} is taken by another program" in out and foreign not in out
        assert "start thimble on a free port with THIMBLE_PORT=<port> thimble" in out
    finally:
        held.close()


def _clean_env(env: dict[str, str]) -> dict[str, str]:
    """`env` without thimble's variables and any API key, with THIMBLE_SKIP_KEY on."""
    out = {k: v for k, v in env.items() if not k.startswith(("THIMBLE_", "ANTHROPIC_"))}
    out["THIMBLE_SKIP_KEY"] = "1"
    return out


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


def _health(home: Path) -> dict:
    """The proven /api/health of the server home/server.json names."""
    st = json.loads((home / "server.json").read_text())
    req = urllib.request.Request(f"{st['api']}/api/health", headers=hook_auth.headers(st["token"], st["port"]))
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def test_two_thimble_homes_side_by_side_each_start_and_find_their_own_server(tmp_path, fake_claude):
    """Two installs (THIMBLE_HOMEs) whose server.json both name one free port: the first starts there, the second
    finds another install's server there and starts on a free port; each `up` again finds its own server, each reader
    of each home finds its own, and stopping one leaves the other running."""
    probe = subprocess.run([sys.executable, "-c", "import app.main"], cwd=BACKEND, capture_output=True, text=True,
                           timeout=120, env={**os.environ, "THIMBLE_SKIP_KEY": "1"})
    if probe.returncode != 0:
        pytest.skip("app.main does not import in this tree: " + probe.stderr.strip().splitlines()[-1][:200])
    held = _held()
    shared = held.getsockname()[1]
    held.close()
    homes: dict[str, Path] = {}
    envs: dict[str, dict[str, str]] = {}
    for name in ("a", "b"):
        h = tmp_path / f"home-{name}"
        h.mkdir(mode=0o700)
        (h / "server.json").write_text(json.dumps({"port": shared}))  # the port both last ran on
        d = tmp_path / f"data-{name}" / "mini"
        d.mkdir(parents=True)
        (d / "manifest.json").write_text('{"name": "mini"}')
        homes[name] = h
        envs[name] = {**_clean_env(dict(os.environ)), "THIMBLE_HOME": str(h),
                      "THIMBLE_DATA_DIR": str(d.parent), "THIMBLE_WORKSPACES_DIR": str(tmp_path / f"ws-{name}"),
                      "THIMBLE_CLAUDE_BIN": os.environ.get("THIMBLE_CLAUDE_BIN", "")}

    def up(name: str) -> list[str]:
        cwd = Path(envs[name]["THIMBLE_DATA_DIR"]) / "mini"
        out = subprocess.run([sys.executable, "-m", "app.cli", "server", "up", "--cwd", str(cwd)], cwd=BACKEND,
                             env=envs[name], capture_output=True, text=True, timeout=90)
        assert out.returncode == 0, out
        return out.stdout.splitlines()

    ports: list[int] = []
    try:
        first = up("a")
        st_a = json.loads((homes["a"] / "server.json").read_text())
        ports.append(st_a["port"])
        assert st_a["port"] == shared and first[0] == f"thimble: http://127.0.0.1:{shared}/?ws=mini", first
        second = up("b")
        st_b = json.loads((homes["b"] / "server.json").read_text())
        ports.append(st_b["port"])
        assert st_b["port"] != shared and second[0] == f"thimble: http://127.0.0.1:{st_b['port']}/?ws=mini", second
        assert not any("another install" in ln for ln in second), "no FOREIGN_LINE without THIMBLE_PORT"
        assert st_a["pid"] != st_b["pid"] and cli.pid_alive(st_a["pid"]) and cli.pid_alive(st_b["pid"])
        for name, st in (("a", st_a), ("b", st_b)):
            health = _health(homes[name])
            assert health["home"] == str(homes[name].resolve()) and health["leader"] == st["pid"]
        assert up("a")[0] == first[0] and up("b")[0] == second[0]
        for name, st in (("a", st_a), ("b", st_b)):
            assert json.loads((homes[name] / "server.json").read_text())["pid"] == st["pid"], "found: no new start"
            with pytest.MonkeyPatch.context() as mp:
                mp.setenv("THIMBLE_HOME", str(homes[name]))
                assert _found_by_readers() == {st["api"]}
        stop = subprocess.run([sys.executable, "-m", "app.cli", "stop", "--yes"], cwd=BACKEND, env=envs["b"],
                              capture_output=True, text=True, timeout=30)
        assert f"pid {st_b['pid']}" in stop.stdout, stop
        deadline = time.monotonic() + 10
        while cli.pid_alive(st_b["pid"]) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not cli.pid_alive(st_b["pid"]) and cli.pid_alive(st_a["pid"])
        assert _health(homes["a"])["home"] == str(homes["a"].resolve()), "the other install's server runs on"
        subprocess.run([sys.executable, "-m", "app.cli", "stop", "--yes"], cwd=BACKEND, env=envs["a"],
                       capture_output=True, text=True, timeout=30)
    finally:
        for p in ports or [shared]:
            for q in _uvicorns_on(p):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(q, 9)
        for name in homes:
            shutil.rmtree(homes[name], ignore_errors=True)
