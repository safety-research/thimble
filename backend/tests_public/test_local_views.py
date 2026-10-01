"""The views built for a workspace are its local extension: workspaces/<c>/extension/views/<slug>/ beside the extension's
manifest, with thimble's own state of them (proposals, versions, reviews) in workspaces/<c>/views/. A workspace an older
thimble wrote, with its views in views/, has them moved in once at the start, and its proposals, kept versions and
indexes keep working. Reader calls run in this process."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import sys
from pathlib import Path

import pytest

from app import config, extensions, ledger, views
from app.kernel_thimble import CARD_TYPES_FILE

CORPUS, OTHER = "boards", "notes"
READER = """
def build_index(paths):
    return sum(1 for p in paths for _ in open(p))


def records(index, query):
    return index


def resolve(index, locator):
    return None
"""


@pytest.fixture()
def corpora(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    for name in (CORPUS, OTHER):
        (d / name).mkdir(parents=True)
        (d / name / "manifest.json").write_text(json.dumps({"name": name, "description": "a message board"}))
        (d / name / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first", "second")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture(autouse=True)
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._memo.clear()
    views._ready.clear()


def _write(c: str, slug: str = "posts", **extra) -> dict:
    return views.write_view(c, slug, name="Posts", description="each post", claims=["board.jsonl"], reader=READER,
                            html="<p>posts</p>", **extra)


def _propose(c: str, slug: str = "posts") -> None:
    views._save_proposals(c, [{"slug": slug, "name": "Posts", "why": "", "claims": ["board.jsonl"], "arrangement": "",
                               "proposed_by": "analyst", "status": "built", "orientation": False, "ts": "t"}])


def test_a_view_built_for_a_workspace_is_its_local_extension_and_no_other_workspace_s(corpora):
    """A view's files go to the local extension's views/ beside a manifest that names the workspace, thimble's state of
    it stays in views/, Settings lists it under the workspace, and another workspace has none of it."""
    _propose(CORPUS)
    v = _write(CORPUS)
    ws = config.workspace_dir(CORPUS)
    assert Path(v["dir"]) == ws / "extension" / "views" / "posts"
    assert {p.name for p in Path(v["dir"]).iterdir()} == {"view.json", "reader.py", "view.html"}
    assert json.loads((ws / "extension" / "extension.json").read_text()) == {
        "name": CORPUS, "version": "local", "description": "The views thimble built for this workspace."}
    assert (ws / "views" / "proposals.json").is_file() and (ws / "views" / ".versions" / "posts" / v["version"]).is_dir()
    assert not (ws / "views" / "posts").exists()
    assert views.list_proposals(CORPUS)[0]["status"] == "built"
    assert views.local_extension(CORPUS) == {"name": CORPUS, "views": [{"slug": "posts", "name": "Posts",
                                                                        "file_viewer": False}]}
    assert views.read_built(OTHER, "posts") is None and views.local_extension(OTHER)["views"] == []
    got = asyncio.run(extensions.list_route(CORPUS))
    assert got["local"]["views"] == [{"slug": "posts", "name": "Posts", "file_viewer": False}]


def test_a_view_an_extension_installed_is_not_the_workspace_s_own(corpora, tmp_path):
    """A view installed from an extension's folder keeps its place in Settings under that extension, not under the
    workspace."""
    src = tmp_path / "ext-view"
    src.mkdir()
    (src / "view.json").write_text(json.dumps({"name": "Tally", "claims": ["board.jsonl"], "unit": "file"}))
    (src / "reader.py").write_text(READER)
    (src / "view.html").write_text("<p>tally</p>")
    views.install_viewer(CORPUS, "tally", src, ["board.jsonl"], why="", proposed_by="analyst", orientation=False,
                         extension="tally")
    assert views.read_built(CORPUS, "tally")["unit"] == "file"
    assert views.local_extension(CORPUS)["views"] == []


def test_unit_places_a_view_in_the_file_browser_or_the_views_bar(corpora):
    """`unit: "file"` makes a file viewer, a mode of the File browser, whatever its claims; any other unit a corpus view;
    without a unit a view whose claims are all one extension's glob is a file viewer, as before."""
    assert views.file_type_viewer({"unit": "file", "claims": ["runs/*/events.jsonl"]})
    assert not views.file_type_viewer({"unit": {"name": "run", "path": "runs/{run}/"}, "claims": ["**/*.jsonl"]})
    assert views.file_type_viewer({"claims": ["**/*.vtt"]})
    assert not views.file_type_viewer({"claims": ["board.jsonl"]})
    _write(CORPUS, "posts", unit="file")
    v = views.read_built(CORPUS, "posts")
    assert v["unit"] == "file" and views._public(v, CORPUS)["file_type"]
    assert views.local_extension(CORPUS)["views"] == [{"slug": "posts", "name": "Posts", "file_viewer": True}]


def test_an_older_workspace_s_views_move_into_its_local_extension_once(corpora):
    """At the start a view an older thimble kept in views/<slug>/ is moved whole into the local extension: its proposal
    stays built rather than queued for a new build, its kept version and its cache stay, its index is read from the same
    cache rather than built again, and the card types' registry points at its new folder. A second start moves
    nothing."""
    _propose(CORPUS)
    v = _write(CORPUS)
    ws = config.workspace_dir(CORPUS)
    assert asyncio.run(views.reader_call(CORPUS, "posts", "records")) == 2
    index = views.index_dir(CORPUS, "posts")
    pickles = {p: p.stat().st_mtime_ns for p in index.glob("*.index.pickle")}
    assert pickles
    new = Path(v["dir"])
    (new / "cache" / "shots").mkdir(parents=True)
    (new / "cache" / "shots" / "a.png").write_bytes(b"png")
    old = ws / "views" / "posts"
    os.replace(new, old)
    for p in (ws / "extension").rglob("*"):
        if p.is_file():
            p.unlink()
    for p in sorted((ws / "extension").rglob("*"), reverse=True):
        p.rmdir()
    (ws / "extension").rmdir()
    registry = config.registry_dir(CORPUS) / CARD_TYPES_FILE
    registry.write_text(json.dumps({"types": {"posts": {"dir": str(old.resolve()),
                                                        "reader": str((old / "reader.py").resolve())}}}))
    assert views.list_proposals(CORPUS)[0]["status"] == "queued", "unmoved, the view is not found"

    assert views.migrate_workspaces() == {CORPUS: ["posts"]}
    assert views.list_proposals(CORPUS)[0]["status"] == "built"
    moved = views.read_built(CORPUS, "posts")
    assert moved is not None and Path(moved["dir"]) == new and moved["version"] == v["version"]
    assert (new / "cache" / "shots" / "a.png").read_bytes() == b"png" and not old.exists()
    assert views.read_version(CORPUS, "posts", v["version"]) is not None
    assert json.loads((ws / "extension" / "extension.json").read_text())["version"] == "local"
    assert json.loads(registry.read_text())["types"]["posts"] == {"dir": str(new.resolve()),
                                                                  "reader": str((new / "reader.py").resolve())}
    views._ready.clear()
    sys.modules.pop("_thimble_views", None)  # the kernel's memory: the index comes from its pickle
    assert asyncio.run(views.reader_call(CORPUS, "posts", "records")) == 2
    assert {p: p.stat().st_mtime_ns for p in index.glob("*.index.pickle")} == pickles

    assert views.migrate_workspaces() == {}
    assert views.read_built(CORPUS, "posts")["dir"] == str(new)


def test_a_link_left_where_the_local_extension_goes_is_replaced_by_a_folder(corpora, tmp_path):
    """A link a kernel planted where the local extension or its views folder goes is removed before thimble writes
    there, so a view's files never land outside the workspace."""
    outside = tmp_path / "outside"
    outside.mkdir()
    ws = config.workspace_dir(CORPUS)
    (ws / "extension").symlink_to(outside, target_is_directory=True)
    _write(CORPUS)
    assert not (ws / "extension").is_symlink() and (ws / "extension" / "views" / "posts" / "view.json").is_file()
    assert list(outside.iterdir()) == []
    (ws / "extension" / "views" / "planted").symlink_to(outside, target_is_directory=True)
    views.ensure_local(ws)
    assert not (ws / "extension" / "views" / "planted").exists()


def test_an_archive_an_older_thimble_made_has_its_views_moved_in_when_it_is_restored(corpora):
    """`/thimble restore` of an archive whose views are in views/ moves them into the local extension."""
    _propose(CORPUS)
    v = _write(CORPUS)
    ws = config.workspace_dir(CORPUS)
    os.replace(v["dir"], ws / "views" / "posts")
    archived = asyncio.run(ledger.archive_workspace(CORPUS))["archived"]
    asyncio.run(ledger.restore_workspace(CORPUS, {"archive": Path(archived).name}))
    assert views.read_built(CORPUS, "posts")["dir"] == str(ws / "extension" / "views" / "posts")
    assert views.list_proposals(CORPUS)[0]["status"] == "built"


def test_a_first_build_a_restart_cut_off_in_a_moved_folder_starts_a_new_session(corpora):
    """A first build cut off by the restart that moved its folder starts a new session, given the folder's new place,
    rather than resuming one whose earlier turns name the old place; a built view and a change keep their sessions."""
    ws = config.workspace_dir(CORPUS)
    rows = []
    for slug, status, changed in (("drafting", "building", None), ("posts", "built", None), ("changing", "queued", True)):
        d = ws / "views" / slug
        d.mkdir(parents=True)
        (d / "view.json").write_text(json.dumps({"name": slug, "claims": ["board.jsonl"]}))
        rows.append({"slug": slug, "name": slug, "why": "", "claims": ["board.jsonl"], "arrangement": "",
                     "proposed_by": "analyst", "status": status, "ts": "t", "session": "s", "session_id": f"id-{slug}",
                     **({"changed": True} if changed else {})})
    (ws / "views" / "proposals.json").write_text(json.dumps(rows))

    assert views.migrate_workspaces() == {CORPUS: ["changing", "drafting", "posts"]}
    kept = {p["slug"]: p for p in json.loads((ws / "views" / "proposals.json").read_text())}
    assert "session_id" not in kept["drafting"] and "session" not in kept["drafting"]
    assert kept["posts"]["session_id"] == "id-posts" and kept["changing"]["session_id"] == "id-changing"
    assert [p["slug"] for p in kept.values()] == ["drafting", "posts", "changing"]
