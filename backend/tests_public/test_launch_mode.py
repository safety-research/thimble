"""`thimble mode browser | terminal` (app/launch_mode.py): the store in thimble's home and how a folder finds its mode,
the command as the launcher runs it with python3 alone, and the session's mode as every process of a session reads it
from the workspace's launch.json (session_mode, current)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app import config, launch_mode

TREE = Path(__file__).resolve().parents[2]


@pytest.fixture()
def home(tmp_path, monkeypatch) -> Path:
    h = tmp_path / "home"
    monkeypatch.setenv("THIMBLE_HOME", str(h))
    monkeypatch.delenv(launch_mode.WS_ENV, raising=False)
    monkeypatch.delenv(launch_mode.ENV, raising=False)
    return h


def test_a_folder_takes_its_own_mode_else_the_nearest_folder_above_else_the_default(home, tmp_path, capsys):
    corpus = tmp_path / "corpus"
    (corpus / "sub").mkdir(parents=True)
    assert launch_mode.resolve(corpus) == ("browser", "built-in")
    assert launch_mode.cli([], str(corpus)) == 0
    assert capsys.readouterr().out == "thimble: `thimble` in this folder starts in browser mode (thimble's default).\n"
    assert launch_mode.cli(["terminal"], str(corpus)) == 0
    assert capsys.readouterr().out.splitlines() == [
        "thimble: `thimble` in this folder starts in terminal mode (set for this folder).", launch_mode.NEXT_START]
    assert launch_mode.resolve(corpus) == ("terminal", str(corpus.resolve()))
    assert launch_mode.resolve(corpus / "sub") == ("terminal", str(corpus.resolve())), "a folder inside takes it too"
    assert launch_mode.cli([], str(corpus / "sub")) == 0
    assert f"terminal mode (set for {corpus.resolve()})" in capsys.readouterr().out
    assert launch_mode.resolve(tmp_path) == ("browser", "built-in"), "a folder above does not"
    assert launch_mode.cli(["terminal"], str(corpus)) == 0
    assert launch_mode.NEXT_START not in capsys.readouterr().out, "nothing changed"
    assert launch_mode.cli(["terminal", "--default"], str(tmp_path)) == 0
    assert capsys.readouterr().out.splitlines() == [
        "thimble: folders without a mode of their own start in terminal mode.",
        "thimble: `thimble` in this folder starts in terminal mode (your default).", launch_mode.NEXT_START]
    assert launch_mode.resolve(tmp_path) == ("terminal", "default")
    assert launch_mode.cli(["browser"], str(corpus / "sub")) == 0
    assert launch_mode.resolve(corpus / "sub") == ("browser", str((corpus / "sub").resolve()))
    capsys.readouterr()
    assert launch_mode.cli(["--unset"], str(corpus / "sub")) == 0
    assert capsys.readouterr().out.splitlines()[0] == "thimble: removed this folder's own mode (browser)."
    assert launch_mode.resolve(corpus / "sub")[0] == "terminal"
    assert launch_mode.cli(["--unset"], str(corpus / "sub")) == 0
    assert capsys.readouterr().out.splitlines() == [
        "thimble: this folder has no mode of its own.",
        f"thimble: `thimble` in this folder starts in terminal mode (set for {corpus.resolve()})."]
    assert launch_mode.cli(["--default", "--unset"], str(tmp_path)) == 0
    assert capsys.readouterr().out.splitlines()[0] == "thimble: removed the default mode (terminal)."
    assert launch_mode.resolve(tmp_path) == ("browser", "built-in")
    assert json.loads((home / launch_mode.STORE).read_text()) == {"default": None,
                                                                   "folders": {str(corpus.resolve()): "terminal"}}
    assert not [p for p in tmp_path.rglob("*") if p.is_file() and home not in p.parents], "nothing in the folders"


def test_a_folder_is_keyed_by_its_real_path(home, tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    launch_mode.set_folder(tmp_path / "link", "terminal")
    assert launch_mode.resolve(real) == ("terminal", str(real.resolve()))
    assert launch_mode.unset(real) == "terminal"


def test_a_wrong_call_says_how_and_changes_nothing(home, tmp_path, capsys):
    launch_mode.set_folder(tmp_path, "terminal")
    before = (home / launch_mode.STORE).read_text()
    for wrong in (["bogus"], ["--default"], ["--unset", "browser"], ["browser", "terminal"], ["--other"],
                  ["terminal", "--default", "--default"]):
        assert launch_mode.cli(wrong, str(tmp_path)) == 2, wrong
        assert capsys.readouterr().err.startswith("usage: thimble mode"), wrong
    assert (home / launch_mode.STORE).read_text() == before
    assert launch_mode.cli(["--help"], str(tmp_path)) == 0 and capsys.readouterr().out.startswith("usage:")
    with pytest.raises(ValueError):
        launch_mode.set_folder(tmp_path, "both")


def test_an_unreadable_store_reads_as_empty_and_is_written_whole_again(home, tmp_path):
    home.mkdir()
    (home / launch_mode.STORE).write_text("{not json")
    assert launch_mode.resolve(tmp_path) == ("browser", "built-in")
    (home / launch_mode.STORE).write_text(json.dumps({"default": "dark", "folders": {"/x": "terminal", "/y": 3}}))
    assert launch_mode.read() == {"default": None, "folders": {"/x": "terminal"}}
    launch_mode.set_default("terminal")
    assert json.loads((home / launch_mode.STORE).read_text()) == {"default": "terminal", "folders": {"/x": "terminal"}}
    assert (home / launch_mode.STORE).stat().st_mode & 0o077 == 0, "readable by its owner alone"


def test_writers_at_once_keep_every_folder(home, tmp_path):
    """Each `thimble mode` re-reads the store under its lock, so two at once keep both folders."""
    script = ("import sys; sys.path.insert(0, sys.argv[1]); import launch_mode\n"
              "for i in range(15): launch_mode.set_folder(f'{sys.argv[2]}/f{i}', 'terminal')\n")
    app_dir = str(TREE / "backend" / "app")
    procs = [subprocess.Popen([sys.executable, "-I", "-c", script, app_dir, str(tmp_path / f"w{n}")],
                              env={**os.environ, "THIMBLE_HOME": str(home)}) for n in range(2)]
    assert [p.wait(timeout=60) for p in procs] == [0, 0]
    assert len(launch_mode.read()["folders"]) == 30


def _launch(ws: Path, **rec) -> None:
    (ws / "trusted").mkdir(parents=True, exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps(rec))


def test_the_session_s_mode_is_launch_json_s_else_browser(tmp_path):
    ws = tmp_path / "ws"
    assert launch_mode.session_mode(None) == launch_mode.session_mode(ws) == "browser", "no workspace, no launch"
    _launch(ws, session="s1")
    assert launch_mode.session_mode(ws) == "browser", "a launch from before modes"
    _launch(ws, session="s1", mode="terminal")
    assert launch_mode.session_mode(ws) == launch_mode.session_mode(str(ws)) == "terminal"
    _launch(ws, mode="dark")
    assert launch_mode.session_mode(ws) == "browser"
    (ws / "trusted" / "launch.json").write_text("[")
    assert launch_mode.session_mode(ws) == "browser"


def test_current_is_the_mode_of_the_folder_s_workspace_else_of_thimble_ws(home, tmp_path, monkeypatch):
    """A process of the session finds its workspace from its folder: the corpus (the shim, the hooks), or a folder
    inside the workspace (an agent's work folder); else from THIMBLE_WS, which the launcher exports. The server's own
    folder is no corpus and it has no THIMBLE_WS, so it is in browser mode."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    corpus = tmp_path / "logs"
    corpus.mkdir()
    name = config.register_corpus(corpus, exact=True)["name"]
    ws = config.workspace_dir(name)
    assert launch_mode.current(corpus) == "browser", "never launched"
    _launch(ws, session="s1", mode="terminal")
    assert launch_mode.current(corpus) == "terminal"
    work = ws / "orient" / "work"
    work.mkdir(parents=True)
    assert launch_mode.current(work) == "terminal", "an agent's work folder"
    monkeypatch.chdir(corpus)
    assert launch_mode.current() == "terminal", "this process's folder"
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    assert launch_mode.current(elsewhere) == "browser"
    monkeypatch.setenv(launch_mode.WS_ENV, str(ws))
    assert launch_mode.current(elsewhere) == "terminal", "THIMBLE_WS"
    monkeypatch.setenv(launch_mode.WS_ENV, "relative/ws")
    assert launch_mode.current(elsewhere) == "browser", "only an absolute folder counts"
    monkeypatch.delenv(launch_mode.WS_ENV)
    monkeypatch.chdir(TREE / "backend")
    assert launch_mode.current() == "browser", "the server's folder"


def _tree(tmp_path: Path) -> Path:
    """plugin/bin/thimble with backend/app/launch_mode.py, in a tree with no venv and no backend package: `thimble mode`
    runs the file with python3 alone."""
    bin_ = tmp_path / "tree" / "plugin" / "bin"
    bin_.mkdir(parents=True)
    shutil.copy(TREE / "plugin" / "bin" / "thimble", bin_ / "thimble")
    (bin_ / "thimble-app-dir").write_text(f'#!/bin/sh\necho "{tmp_path / "tree"}"\n')
    (bin_ / "thimble-app-dir").chmod(0o755)
    (tmp_path / "tree" / "backend" / "app").mkdir(parents=True)
    shutil.copy(TREE / "backend" / "app" / "launch_mode.py", tmp_path / "tree" / "backend" / "app" / "launch_mode.py")
    return bin_ / "thimble"


def test_the_launcher_runs_thimble_mode_with_python3_alone(tmp_path):
    launcher = _tree(tmp_path)
    work = tmp_path / "work"
    work.mkdir()
    env = {"PATH": f"{Path(shutil.which('python3')).parent}:/usr/bin:/bin", "HOME": str(tmp_path),
           "THIMBLE_HOME": str(tmp_path / "home")}

    def run(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(launcher), "mode", *args], capture_output=True, text=True, cwd=work, env=env,
                              timeout=60, check=False)

    first = run("terminal")
    assert first.returncode == 0, first.stderr
    assert first.stdout.splitlines()[0] == "thimble: `thimble` in this folder starts in terminal mode (set for this folder)."
    assert json.loads((tmp_path / "home" / launch_mode.STORE).read_text())["folders"] == {str(work.resolve()): "terminal"}
    wrong = run("bogus")
    assert wrong.returncode == 2 and wrong.stderr.startswith("usage: thimble mode")
    assert run().stdout.startswith("thimble: `thimble` in this folder starts in terminal mode")
