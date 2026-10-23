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
import shutil
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import config, extensions, views

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
    row = {"slug": "posts", "name": "Posts", "description": "each post", "file_viewer": False, "on": True}
    assert views.local_extension(CORPUS) == {"name": CORPUS, "views": [row]}
    assert views.read_built(OTHER, "posts") is None and views.local_extension(OTHER)["views"] == []
    got = asyncio.run(extensions.list_route(CORPUS))
    assert got["local"]["views"] == [row]


def test_a_view_an_extension_installed_is_not_the_workspace_s_own(corpora, tmp_path):
    """A view installed from an extension's folder keeps its place in Settings under that extension, not under the
    workspace."""
    src = tmp_path / "ext-view"
    src.mkdir()
    (src / "view.json").write_text(json.dumps({"name": "Tally", "claims": ["board.jsonl"], "unit": "file"}))
    (src / "reader.py").write_text(READER)
    (src / "view.html").write_text("<p>tally</p>")
    views.install_viewer(CORPUS, "tally", src, ["board.jsonl"], description="", proposed_by="analyst",
                         orientation=False, extension="tally")
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
    assert views.local_extension(CORPUS)["views"] == [{"slug": "posts", "name": "Posts", "description": "each post",
                                                       "file_viewer": True, "on": True}]


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

    other = config.workspace_dir(OTHER)
    (other / "extension").symlink_to(ws / "extension", target_is_directory=True)
    assert views.migrate_workspaces() == {}
    assert not (other / "extension").exists(), "a link left by an older kernel goes at the start"

    from app import notebook

    shutil.rmtree(ws / "extension")
    (ws / "extension").write_text("")
    notebook._guarded_files(CORPUS)
    assert (ws / "extension").is_dir(), "a kernel starts with the folder read-only, not with a file in its place"


def test_a_view_built_for_a_workspace_switches_off_and_on_in_settings_from_the_analyst_s_browser_only(
        corpora, analyst, tmp_path, monkeypatch):
    """Off, a view built for the workspace leaves the views list, and so the views bar, the File browser and the
    prompts, with its files and its proposal kept; on, it is back. Only the analyst's browser turns the switch, and only
    for a view built for the workspace."""
    _propose(CORPUS)
    _write(CORPUS, accepts=[{"form": "L<n>", "means": "one post"}])
    assert "one post" in views.forms_text(CORPUS)
    stranger = Request({"type": "http", "headers": []})
    with pytest.raises(HTTPException) as e:
        asyncio.run(views.view_on_route(CORPUS, "posts", views.OnBody(on=False), stranger))
    assert e.value.status_code == 403 and views.views_off(CORPUS) == set()

    got = asyncio.run(views.view_on_route(CORPUS, "posts", views.OnBody(on=False), analyst))
    assert got["views"] == [{"slug": "posts", "name": "Posts", "description": "each post", "file_viewer": False,
                             "on": False}]
    assert [v["slug"] for v in views.list_views(CORPUS) if v["origin"] == "workspace"] == []
    assert views.views_for(CORPUS, "board.jsonl") == [] and "one post" not in views.forms_text(CORPUS)
    assert views.read_built(CORPUS, "posts") is not None and views.list_proposals(CORPUS)[0]["status"] == "built"
    assert asyncio.run(views.list_proposals_route(CORPUS))[0]["off"] is True, "the views bar leaves it out"
    assert "off" not in views.list_proposals(CORPUS)[0]
    assert views.read_built(OTHER, "posts") is None and views.views_off(OTHER) == set()

    asyncio.run(views.view_on_route(CORPUS, "posts", views.OnBody(on=True), analyst))
    assert [v["slug"] for v in views.list_views(CORPUS) if v["origin"] == "workspace"] == ["posts"]
    assert "one post" in views.forms_text(CORPUS) and "off" not in asyncio.run(views.list_proposals_route(CORPUS))[0]
    shipped = tmp_path / "viewers" / "board"
    shipped.mkdir(parents=True)
    (shipped / "view.json").write_text(json.dumps({"name": "Board", "claims": ["*.jsonl"]}))
    (shipped / "reader.py").write_text(READER)
    (shipped / "view.html").write_text("<p>board</p>")
    monkeypatch.setattr(views, "VIEWERS_DIR", shipped.parent)
    monkeypatch.setattr(views, "BUILTIN_VIEWERS", ("board",))
    assert views.read_builtin("board") is not None
    with pytest.raises(HTTPException) as e:
        asyncio.run(views.view_on_route(CORPUS, "board", views.OnBody(on=False), analyst))
    assert e.value.status_code == 404


def test_a_view_switched_off_takes_its_card_type_with_it_and_a_deleted_one_leaves_no_switch_behind(corpora, analyst):
    """A workspace view that makes a card type leaves the card types while it is off and is back when it is on. A view
    deleted while off leaves nothing off behind, so a new view built under its slug is on."""
    from app import cardtypes

    _propose(CORPUS)
    v = _write(CORPUS)
    d = Path(v["dir"])
    (d / "card.py").write_text("def card(index, args):\n    return index\n")
    (d / "view.json").write_text(json.dumps({**json.loads((d / "view.json").read_text()), "card": {"use": "a post"}}))
    views.mark_built(CORPUS, "posts")
    assert "posts" in asyncio.run(cardtypes.refresh(CORPUS, warm=False))

    asyncio.run(views.view_on_route(CORPUS, "posts", views.OnBody(on=False), analyst))
    assert "posts" not in cardtypes.read_registry(CORPUS)
    asyncio.run(views.view_on_route(CORPUS, "posts", views.OnBody(on=True), analyst))
    assert "posts" in cardtypes.read_registry(CORPUS)

    asyncio.run(views.view_on_route(CORPUS, "posts", views.OnBody(on=False), analyst))
    views.delete_proposal(CORPUS, "posts")
    assert views.views_off(CORPUS) == set()
    _propose(CORPUS)
    _write(CORPUS)
    assert [v["slug"] for v in views.list_views(CORPUS) if v["origin"] == "workspace"] == ["posts"]


def test_a_file_viewer_s_extension_glob_names_the_files_at_the_corpus_root_too(corpora):
    """A `**` folder in a claim may stand for no folder, so a file viewer claiming `**/*.vtt` opens a subtitle file at
    the corpus root as well as one in a folder, and propose_view finds files for it."""
    root = config.corpus_dir(CORPUS)
    (root / "talk.vtt").write_text("WEBVTT\n")
    (root / "talks").mkdir()
    (root / "talks" / "standup.vtt").write_text("WEBVTT\n")
    assert views.glob_matches("talk.vtt", "**/*.vtt") and views.glob_matches("talks/standup.vtt", "**/*.vtt")
    assert views.glob_matches("talks/standup.vtt", "talks/**/standup.vtt")
    assert not views.glob_matches("board.jsonl", "**/*.vtt")
    assert views.unmatched_claims(CORPUS, ["**/*.vtt"]) == {}
    views._folder_cache.clear()
    assert [f[0] for f in views.claimed_files(CORPUS, {"claims": ["**/*.vtt"]})] == ["talk.vtt", "talks/standup.vtt"]
