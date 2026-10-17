"""The server's port (app.cli, module note): without THIMBLE_PORT, a port another program or another install's server
holds is passed over for a free one, which server.json records and every reader finds there (this CLI, the launcher,
the browser link, the plugin's shim, watcher, statusline and permission hook). With THIMBLE_PORT that port alone is
used, and a taken one gets today's answer: FOREIGN_LINE for another install's server, the port line for another
program. Two THIMBLE_HOMEs side by side each start and find their own server. A real listener stands in for the program
that holds a port; the integration test starts two real uvicorns on free ports, never on the default port."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import socket

import pytest

from app import cli, config, permission_hook

PORT_FREE = cli.port_free  # before the home fixture stands it in
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
