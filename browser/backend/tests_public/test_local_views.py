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

from app import config, views

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
    it stays in views/, and another workspace has none of it."""
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
    assert views.read_built(OTHER, "posts") is None


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

    shutil.rmtree(ws / "extension")
    (ws / "extension").write_text("")
    views.ensure_local(ws)
    assert (ws / "extension" / "views").is_dir(), "a file an older kernel left there goes, and the folder is made"


def _hidden_before(c: str, *slugs: str) -> None:
    """views/off.json as an earlier version wrote it for the views the analyst hid from the views bar."""
    views.state_dir(c).mkdir(parents=True, exist_ok=True)
    (views.state_dir(c) / "off.json").write_text(json.dumps(list(slugs)))


def test_a_view_hidden_before_shows_like_any_other_and_nothing_hides_one(corpora):
    """No view is hidden: a view an earlier version hid (views/off.json, which is not read) is in the views list, and so
    in the views bar, the File browser and the prompts; its proposal is listed without `off`, and a view proposal under
    a slug it names is offered. The routes that listed the hidden views and hid or showed one are gone, and `local` is
    a slug like any other."""
    _propose(CORPUS)
    _write(CORPUS, accepts=[{"form": "L<n>", "means": "one post"}])
    views._save_proposals(CORPUS, [*views.list_proposals(CORPUS),
                                   {"slug": "timeline", "name": "Timeline", "why": "", "claims": ["board.jsonl"],
                                    "arrangement": "", "proposed_by": "proposer", "status": "suggested",
                                    "orientation": False, "ts": "t", "offered": {"at": "t", "after": "main", "why": ""}}])
    _hidden_before(CORPUS, "posts", "timeline")
    assert [v["slug"] for v in views.list_views(CORPUS) if v["origin"] == "workspace"] == ["posts"]
    assert [v["slug"] for v in views.views_for(CORPUS, "board.jsonl")] == ["posts"]
    assert "one post" in views.forms_text(CORPUS)
    assert [p for p in asyncio.run(views.list_proposals_route(CORPUS)) if "off" in p] == []
    assert views.open_offer(CORPUS)["slug"] == "timeline"
    paths = {getattr(r, "path", "") for r in views.router.routes}
    assert "/ws/{c}/views/{slug}" in paths, "the views' own routes"
    assert "/ws/{c}/views/{slug}/on" not in paths and "/ws/{c}/views/local" not in paths
    assert views._check_slug("local") == "local"


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
