"""The server's port (app.cli, module note): without THIMBLE_PORT, a port another program holds is passed over for a
free one, which server.json records and every reader finds there (this CLI and the browser link). A real listener
stands in for the program that holds a port; the server's spawn is faked."""
from __future__ import annotations

import json
import socket

import pytest
from conftest import bound_port

from app import cli

PORT_FREE = cli.port_free  # before the home fixture stands it in


def _held() -> socket.socket:
    """A listener on a free port of the loopback, as another program holds a port (conftest.SERVER_PORTS)."""
    s = bound_port()
    s.listen(8)
    return s


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
    """The supervisor with FakeServer for spawn, the real port probes, and health answered where it runs, where the
    server names the last spawn's pid as its leader. The folder's session opens with no request (open_session)."""
    sp = FakeServer()
    monkeypatch.setattr(cli, "spawn", sp)
    monkeypatch.setattr(cli, "open_session", lambda url, name, cwd, chosen: True)
    monkeypatch.setattr(cli, "port_free", PORT_FREE)
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: bool(sp.port) and
                        (url or cli.api_url()) == f"http://127.0.0.1:{sp.port}")
    monkeypatch.setattr(cli, "health_leader", lambda url=None: 40000 + len(sp.calls) if cli.healthy(url) else None)
    monkeypatch.setattr(cli, "pid_alive", lambda pid: pid == 40000 + len(sp.calls))
    monkeypatch.setattr(cli, "spawned_exited", lambda pid: False)
    monkeypatch.setattr(cli, "is_server", lambda pid, p, repo=None: pid == 40000 + len(sp.calls) and p == sp.port)
    return sp


def test_a_taken_default_port_is_passed_over_for_a_free_one_that_server_json_records_and_every_reader_finds(
        server, data, monkeypatch, capsys):
    """Another program holds the default port: thimble-browser starts the server on a free port above it, server.json
    records it, the link names it, and the CLI finds the server there; the next start starts nothing."""
    held = _held()
    try:
        taken = held.getsockname()[1]
        monkeypatch.setattr(cli, "DEFAULT_PORT", taken)
        assert cli.explicit_port() is None and cli.port() == taken
        assert cli.main(["browser", "--cwd", str(data / "mini"), "--detach"]) == 0
        picked = server.ports[0]
        assert picked != taken and taken < picked <= taken + cli.PORT_SCAN
        st = json.loads((cli.server_json()).read_text())
        assert (st["port"], st["api"], st["url"]) == (picked, f"http://127.0.0.1:{picked}", f"http://127.0.0.1:{picked}")
        assert capsys.readouterr().out.splitlines()[0] == f"thimble browser: http://127.0.0.1:{picked}/?ws=mini"
        assert cli.port() == picked and cli.api_url() == f"http://127.0.0.1:{picked}"
        assert cli.main(["browser", "--cwd", str(data / "mini"), "--detach"]) == 0
        assert server.ports == [picked], "found: no second start"
        assert capsys.readouterr().out.splitlines()[0] == f"thimble browser: http://127.0.0.1:{picked}/?ws=mini"
    finally:
        held.close()
