"""`thimble purge` (app/runs.py) never follows a link out of the workspaces folder."""
from __future__ import annotations

import json
import os
import time
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


def register(data: Path, name: str, folder: Path, *, make: bool = True) -> Path:
    if make:
        folder.mkdir(parents=True, exist_ok=True)
    side = data / f"{name}.corpus.json"
    side.write_text(json.dumps({"name": name, "root": str(folder), "path": str(folder), "registered_at": "x",
                                "manifest": {"name": name}}))
    return side


def workspace(ws: Path, name: str, age_s: float = 0.0) -> Path:
    p = ws / name
    (p / "chats").mkdir(parents=True, exist_ok=True)
    (p / "sessions.json").write_text("{}")
    t = time.time() - age_s
    for f in (p / "chats", p / "sessions.json", p):
        os.utime(f, (t, t))
    return p


def archive(ws: Path, name: str, age_s: float = 0.0) -> Path:
    p = ws / runs.ARCHIVE_DIR / name
    p.mkdir(parents=True)
    t = time.time() - age_s
    os.utime(p, (t, t))
    return p


@pytest.fixture()
def corpus(dirs, tmp_path):
    """wiki (a workspace used a minute ago, two archives of one second and an older one), old (its folder gone, used
    two days ago), fresh (registered, no workspace yet), stray (a workspace no registration names) and demo (a corpus
    directory in the registry, with a workspace)."""
    data, ws = dirs
    corpora = tmp_path / "corpora"
    register(data, "wiki", corpora / "wiki")
    workspace(ws, "wiki", age_s=90)
    archive(ws, "wiki-2026-09-25-123000", age_s=3 * 3600)
    archive(ws, "wiki-2026-09-25-123000-2", age_s=3 * 3600)
    archive(ws, "wiki-2026-09-20-080000", age_s=5 * 86400)
    register(data, "old", corpora / "old", make=False)
    workspace(ws, "old", age_s=2 * 86400)
    register(data, "fresh", corpora / "fresh")
    workspace(ws, "stray", age_s=20 * 86400)
    (data / "demo").mkdir()
    (data / "demo" / "manifest.json").write_text('{"name": "demo"}')
    workspace(ws, "demo", age_s=4 * 3600)
    return corpora


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
