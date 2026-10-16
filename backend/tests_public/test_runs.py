"""`thimble purge` (app/runs.py) never follows a link out of the workspaces folder."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import cli, runs


@pytest.fixture()
def dirs(home, tmp_path, monkeypatch):
    """A registry and a workspaces folder the supervisor resolves (THIMBLE_DATA_DIR, THIMBLE_WORKSPACES_DIR), no server,
    and the folders the registry names under tmp_path/corpora."""
    data, ws = tmp_path / "data", tmp_path / "ws"
    data.mkdir()
    ws.mkdir()
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(data))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(ws))
    server_down(monkeypatch)
    return data.resolve(), ws.resolve()


def server_down(monkeypatch) -> None:
    monkeypatch.setattr(cli, "healthy", lambda url=None, timeout=1.0: False)
    monkeypatch.setattr(cli, "listening", lambda p: False)  # the default port may be a live server's
    monkeypatch.setattr(cli, "_request", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no request")))


def register(data: Path, name: str, folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    side = data / f"{name}.corpus.json"
    side.write_text(json.dumps({"name": name, "root": str(folder), "path": str(folder), "registered_at": "x",
                                "manifest": {"name": name}}))
    return side


def test_purge_never_follows_a_link_out_of_the_workspaces_folder(dirs, tmp_path, capsys):
    data, ws = dirs
    outside = tmp_path / "precious"
    (outside / "keep").mkdir(parents=True)
    register(data, "linked", tmp_path / "corpora" / "linked")
    (ws / "linked").symlink_to(outside, target_is_directory=True)
    (ws / runs.ARCHIVE_DIR).mkdir()
    (ws / runs.ARCHIVE_DIR / "linked-2026-01-01-000000").symlink_to(outside, target_is_directory=True)
    found = runs.rows(data, ws)
    assert [(r.id, r.path) for r in found] == [("linked", None)], "a link is no workspace and no archive"
    assert cli.main(["purge", "linked", "-y"]) == 0
    assert (outside / "keep").is_dir() and (ws / "linked").is_symlink()
    assert runs._child(ws, "..") is None and runs._child(ws, ".archive") is None and runs._child(ws, "linked") is None


def test_purge_removes_the_folder_s_active_marker(dirs, tmp_path, capsys, home):
    """/thimble and the launcher mark a folder they open (cli.mark_active: its path and its real path, each with `/`
    as `%`), which the plugin's watcher reads before it starts Python; `thimble purge` of its workspace removes it."""
    data, ws = dirs
    folder = tmp_path / "corpora" / "logs"
    register(data, "logs", folder)
    (ws / "logs").mkdir()
    link = tmp_path / "logs-link"
    link.symlink_to(folder, target_is_directory=True)
    cli.mark_active(link)
    active = home / cli.ACTIVE_DIR
    keys = {str(link).replace("/", "%"), str(folder.resolve()).replace("/", "%")}
    assert {p.name for p in active.iterdir()} == keys
    assert all(p.stat().st_size == 0 and p.stat().st_mode & 0o777 == 0o600 for p in active.iterdir())
    assert active.stat().st_mode & 0o077 == 0
    assert cli.main(["purge", "logs", "-y"]) == 0
    # the registered folder's spelling goes; the link's, which the registry does not name, only lets Python start there
    assert {p.name for p in active.iterdir()} == {str(link).replace("/", "%")}
    cli.mark_active(tmp_path / ("x" * 210))
    assert len(list(active.iterdir())) == 1, "a name longer than 200 characters is not written"
