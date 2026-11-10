"""A folder's earlier sessions in another workspaces folder than the one the workbench uses (cli.elsewhere_line,
folder_sessions.elsewhere). A workbench that ran with the workspaces folder in the terminal plugin's home as
THIMBLE_WORKSPACES_DIR kept its sessions there; a start without that variable reads its own folder and finds none of
them, so it says where they are, what they hold and the command that lists them. It says nothing in every other case,
and it changes no file there. No server runs: the start's server is faked."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import time
from pathlib import Path

import pytest

from app import cli

CMD = "THIMBLE_WORKSPACES_DIR=~/.thimble/workspaces thimble-browser --resume"
ONE = ("an earlier session of this folder is in ~/.thimble/workspaces (2 days ago, 0 turns, 1 card); to open it, "
       f"run {CMD}")
TWO = ("2 earlier sessions of this folder are in ~/.thimble/workspaces (the latest 2 days ago; 0 turns, 2 cards in "
       f"all); to open one, run {CMD}")
QUIT = "quit thimble-browser (Ctrl-C), then run"


def _a_card(monkeypatch, folder: Path, c: str = "mini") -> None:
    """A session of workspace `c` that holds one card, in the workspaces folder `folder`."""
    from app import config, notebook  # noqa: PLC0415

    with monkeypatch.context() as m:
        m.setattr(config, "WORKSPACES_DIR", folder)
        nb = notebook.create_notebook(config.workspace_dir(c), "G")
        notebook.insert_cell(c, nb["id"], notebook.new_cell("note", "test", "By hand", nb["id"],
                                                             payload={"text": "made by hand"}))


def _but_when(line: str) -> str:
    """`line` without how long ago, which a start reads from the clock."""
    return re.sub(r"\d+ \w+ ago|just now", "WHEN", line)


def _files(folder: Path) -> dict[str, tuple[int, int]]:
    """Every file and folder under `folder` with its size and the time of its last change."""
    return {str(p.relative_to(folder)): (p.stat().st_size, p.stat().st_mtime_ns) for p in sorted(folder.rglob("*"))}


def _a_server(home: Path, folder: Path) -> None:
    """server.json in the home `home`, as a server that runs with the workspaces folder `folder` writes it."""
    from app import config  # noqa: PLC0415

    home.mkdir(parents=True, exist_ok=True)
    (home / "server.json").write_text(json.dumps({"pid": 1, "port": 1, "repo": str(config.REPO_ROOT),
                                                  "env": {"workspaces_dir": str(folder)}}))


@pytest.fixture()
def other(home, data, tmp_path, monkeypatch) -> Path:
    """The workspaces folder in the terminal plugin's home, which is ~/.thimble as on a person's machine, with one
    session of `mini` that holds a card. The workbench's own workspaces folder (data) holds nothing."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("THIMBLE_PLUGIN_HOME", str(tmp_path / ".thimble"))
    folder = tmp_path / ".thimble" / "workspaces"
    _a_card(monkeypatch, folder)
    return folder


def test_a_start_says_where_the_folders_earlier_sessions_are(other, home, data, tmp_path, monkeypatch, capsys):
    """One session there, then two, the second one set aside: the line counts them and names the folder and the
    command. While a server of this home runs, the command comes after quitting thimble-browser, since a start uses the
    running server with the folder it started with. `--resume` that finds no session here says it too, and starts no
    server; a new start says it before the link. Nothing there changes."""
    cwd, now = data / "mini", time.time() + 2 * 86400 + 600
    assert cli.elsewhere_line(cwd, data, now=now) == ONE
    shutil.copytree(other / "mini", other / ".archive" / "mini-2026-01-02-030405")
    before = _files(other)
    assert cli.elsewhere_line(cwd, data, now=now) == TWO
    assert cli.elsewhere_line(cwd, data, "mini", now=now) == TWO, "by the name the start opened the folder as"

    started: list[float] = []
    monkeypatch.setattr(cli, "ensure_running", lambda wait_s: started.append(wait_s) or True)
    assert cli.cmd_browser(argparse.Namespace(cwd=str(cwd), session="pick")) == 1
    said = [_but_when(ln) for ln in capsys.readouterr().out.splitlines()]
    assert said == [cli.BROWSER_LINE.format(what=cli.SESSION_NONE_LINE["pick"].format(cwd=cwd)),
                    cli.BROWSER_LINE.format(what=_but_when(TWO))]
    assert not started, "and it starts no server"

    def start(wait_s: float) -> bool:
        _a_server(home, tmp_path / "ws")
        return True

    from app import claude_access  # noqa: PLC0415

    monkeypatch.setattr(cli, "ensure_running", start)
    monkeypatch.setattr(cli, "is_server", lambda pid, p, repo=None: True)
    monkeypatch.setattr(cli, "_request", lambda method, url, body=None, timeout=5.0: (200, {"name": "mini"}))
    monkeypatch.setattr(cli, "hold_server", lambda: None)
    monkeypatch.setattr(cli, "hold_until_quit", lambda: None)
    monkeypatch.setattr(claude_access, "start_line", lambda: "signed in")
    assert cli.cmd_browser(argparse.Namespace(cwd=str(cwd), session="new")) == 0
    said = [_but_when(ln) for ln in capsys.readouterr().out.splitlines()]
    assert said == [cli.BROWSER_LINE.format(what=_but_when(TWO.replace("run", QUIT, 1))),
                    cli.BROWSER_LINE.format(what=cli.ui_url("mini")), cli.BROWSER_LINE.format(what="signed in")]
    assert cli.elsewhere_line(cwd, data, now=now) == TWO.replace("run", QUIT, 1)
    assert _files(other) == before, "the start read the other folder and changed nothing in it"


def test_a_start_says_nothing_in_every_other_case(other, home, data, tmp_path, monkeypatch):
    """Silent for a folder the workbench does not know, a workspace with no session there, a name that the other home's
    registry gives to another folder, a folder registered just now that this registry does not name, a server that
    runs with that folder, a folder that cannot be read, a workbench whose own folder that is, and a session of its own
    that holds anything."""
    from app import folder_sessions  # noqa: PLC0415

    cwd, registry = data / "mini", tmp_path / ".thimble" / "data"
    (data / "empty").mkdir()
    (data / "empty" / "manifest.json").write_text('{"name": "empty"}')
    (tmp_path / "unknown").mkdir()
    assert cli.elsewhere_line(tmp_path / "unknown", data) is None
    assert cli.elsewhere_line(data / "empty", data) is None
    assert cli.elsewhere_line(cwd, data, "mini", new=True) is None
    registry.mkdir()
    (registry / "mini.corpus.json").write_text(json.dumps({"name": "mini", "path": str(tmp_path / "unknown")}))
    assert cli.elsewhere_line(cwd, data) is None
    (registry / "mini.corpus.json").write_text(json.dumps({"name": "mini", "path": str(cwd)}))
    assert cli.elsewhere_line(cwd, data, "mini", new=True), "that registry gives the name to this folder"

    monkeypatch.setattr(cli, "is_server", lambda pid, p, repo=None: True)
    for where in (home, tmp_path / ".thimble"):
        _a_server(where, other)
        assert cli.elsewhere_line(cwd, data) is None, where
        (where / "server.json").unlink()
    assert cli.elsewhere_line(cwd, data)

    with monkeypatch.context() as m:
        m.setattr(folder_sessions, "summary", lambda ws: 1 / 0)
        assert cli.elsewhere_line(cwd, data) is None, "and the start goes on"
    with monkeypatch.context() as m:
        m.setenv("THIMBLE_WORKSPACES_DIR", str(other))
        assert cli.elsewhere_line(cwd, data) is None
    _a_card(monkeypatch, tmp_path / "ws")
    assert cli.elsewhere_line(cwd, data) is None
