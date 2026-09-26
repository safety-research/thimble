"""A view's versions (views.VERSIONS_SUBDIR): each time a view passes its checks its files are kept under their digest,
and a page loaded at that version keeps reading them, through the frame, records, marks and resolve routes' `v`, while
the dev agent changes the view's own folder and after the next version is built. While a change builds, the view is
listed and read at the version it last passed. The newest VERSIONS_KEPT stay, and deleting the view removes them. The
board and its readers are invented; the readers run in this process."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI

from app import config, dev, view_review, views

from test_views import CORPUS, THREADS_HTML, THREADS_READER, VIEW, _inproc_run

NEWER_READER = THREADS_READER.replace('"author": a, "body": b}', '"author": a.upper(), "body": b}')
NEWER_HTML = THREADS_HTML.replace("<div id=\"out\">", "<div id=\"out\" class=\"newer\">")


@pytest.fixture()
async def board(tmp_path, monkeypatch, workspaces_tmp):
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"thread": t, "author": a, "time": "t", "body": b}) + "\n"
                                                for t, a, b in (("t1", "ada", "one"), ("t1", "bo", "two"))))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._memo.clear()
    views._ready.clear()
    views._bind_loop()
    return views.write_view(CORPUS, "threads", reader=THREADS_READER, html=THREADS_HTML, **VIEW)


@pytest.fixture()
async def client():
    app = FastAPI()
    app.include_router(views.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=60) as c:
        yield c


def _edit(reader: str, html: str) -> None:
    """The dev agent writing the view's own folder, as a change to it does before its checks pass."""
    d = views.views_dir(CORPUS) / "threads"
    (d / "reader.py").write_text(reader.rstrip("\n") + "\n")
    (d / "view.html").write_text(html.rstrip("\n") + "\n")


async def _authors(client: httpx.AsyncClient, v: str | None) -> list[str]:
    r = await client.post(f"/api/ws/{CORPUS}/views/threads/records", params={"v": v} if v else {},
                          json={"query": {"thread": "t1"}})
    assert r.status_code == 200, r.text
    return [p["author"] for p in r.json()["data"]]


async def test_a_page_keeps_its_version_while_the_view_changes_and_after_the_next_is_built(board, client):
    first = board["version"]
    assert views.VERSION_RE.match(first)
    listed = (await client.get(f"/api/ws/{CORPUS}/views")).json()
    assert [(v["slug"], v["version"]) for v in listed if v["origin"] == "workspace"] == [("threads", first)]

    _edit(NEWER_READER, NEWER_HTML)
    frame = (await client.get(f"/api/ws/{CORPUS}/views/threads/frame", params={"v": first})).text
    assert 'class="newer"' not in frame, "a change being made never reaches a page loaded at the version before it"
    assert await _authors(client, first) == ["ada", "bo"]

    second = views.mark_built(CORPUS, "threads")["version"]
    assert second != first
    assert 'class="newer"' in (await client.get(f"/api/ws/{CORPUS}/views/threads/frame", params={"v": second})).text
    assert 'class="newer"' not in (await client.get(f"/api/ws/{CORPUS}/views/threads/frame", params={"v": first})).text
    assert await _authors(client, first) == ["ada", "bo"], "the page still on the first version reads its reader"
    assert await _authors(client, second) == ["ADA", "BO"]
    opened = (await client.get(f"/api/ws/{CORPUS}/views/threads/resolve",
                               params={"ref": "board.jsonl#L2", "v": first})).json()
    assert opened["label"] == "bo" and opened["target"] == {"thread": "t1", "line": 2}


async def test_the_same_files_are_the_same_version_so_undo_brings_back_the_page_loaded_before(board):
    first = board["version"]
    _edit(NEWER_READER, NEWER_HTML)
    views.mark_built(CORPUS, "threads")
    _edit(THREADS_READER, THREADS_HTML)
    assert views.mark_built(CORPUS, "threads")["version"] == first


async def test_the_newest_versions_are_kept_an_unknown_one_is_refused_and_deleting_the_view_removes_them(board, client):
    made = [board["version"]]
    for n in range(views.VERSIONS_KEPT + 1):
        _edit(THREADS_READER + f"\n# change {n}\n", THREADS_HTML)
        made.append(views.mark_built(CORPUS, "threads")["version"])
    root = views.views_dir(CORPUS) / views.VERSIONS_SUBDIR / "threads"
    assert sorted(p.name for p in root.iterdir()) == sorted(made[-views.VERSIONS_KEPT:])
    gone = await client.get(f"/api/ws/{CORPUS}/views/threads/frame", params={"v": made[0]})
    assert gone.status_code == 404 and "reload it" in gone.text
    assert (await client.get(f"/api/ws/{CORPUS}/views/threads/frame", params={"v": "../../x"})).status_code == 404
    views.delete_view(CORPUS, "threads")
    assert not root.exists()


def _strip_stamps() -> None:
    """A session that rewrote view.json during a change, leaving the view's folder a draft."""
    vj = views.views_dir(CORPUS) / "threads" / views.VIEW_JSON
    vj.write_text(json.dumps({k: v for k, v in json.loads(vj.read_text()).items() if k not in ("built", "version")}))


async def _listed(client: httpx.AsyncClient) -> list[tuple[str, str, str]]:
    listed = (await client.get(f"/api/ws/{CORPUS}/views")).json()
    return [(v["slug"], v["name"], v["version"]) for v in listed if v["origin"] == "workspace"]


async def test_a_view_being_improved_stays_listed_and_read_at_its_version_until_the_new_one_passes(board, client,
                                                                                                   monkeypatch):
    """The orientation proposing a built view again, a change asked in its thread and a dev ticket all change the view
    in its own folder (views.revise). While that builds, the view is listed, and read without a version, as it last
    passed its checks, though the session left its folder a draft, and a proposal of its name changes it again rather
    than building another. Once the change passes, the new version is listed."""
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    first = board["version"]
    prop = views.propose(CORPUS, "Threads", "each thread with its authors", ["board.jsonl"], "one thread per page",
                         proposed_by="orient", orientation=True)
    assert prop["revision"] and prop["status"] == "queued"
    views.update_proposal(CORPUS, "threads", status="building")
    _edit(NEWER_READER, NEWER_HTML.replace("<head>", "<head><title>half written</title>"))
    _strip_stamps()

    assert await _listed(client) == [("threads", "Threads", first)]
    assert views.read_built(CORPUS, "threads")["version"] == first
    frame = (await client.get(f"/api/ws/{CORPUS}/views/threads/frame")).text
    assert 'class="newer"' not in frame and "half written" not in frame
    assert await _authors(client, first) == ["ada", "bo"]
    [row] = (await client.get(f"/api/ws/{CORPUS}/views/proposals")).json()
    assert row["status"] == "building" and row["revision"], "not taken for a view to build from scratch"
    assert views.built_slug(CORPUS, "Threads") == "threads"

    _edit(NEWER_READER, NEWER_HTML)
    second = views.mark_built(CORPUS, "threads")["version"]
    views.drop_built_copy(CORPUS, "threads")
    views.update_proposal(CORPUS, "threads", revision=None, changed=None, change=None)
    assert await _listed(client) == [("threads", "Threads", second)]
    assert await _authors(client, second) == ["ADA", "BO"]


async def test_a_change_that_fails_or_crashes_leaves_the_view_listed_as_it_was(board, client, monkeypatch):
    """A change that fails its checks, or whose run crashed, puts the view's folder back (views.end_revision), so the
    view is listed at the same version, built, with nothing to reload."""
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    monkeypatch.setattr(dev, "_close_chat", lambda t, status, result: None)
    chips: list[str] = []
    monkeypatch.setattr(dev, "_change_failed_chip", lambda c, prop, why: chips.append(why))
    first = board["version"]
    for fail in (lambda: views.end_revision(CORPUS, "threads", "checks failed", failed_change="newest first"),
                 lambda: dev._view_failed(CORPUS, "threads", "the run crashed: KeyError: 'x'")):
        views.message(CORPUS, "threads", "newest first")
        _edit(NEWER_READER, NEWER_HTML)
        _strip_stamps()
        assert await _listed(client) == [("threads", "Threads", first)]
        fail()
        prop = views.read_proposal(CORPUS, "threads")
        assert prop["status"] == "built" and not prop.get("revision") and prop["failed_change"] == "newest first"
        assert await _listed(client) == [("threads", "Threads", first)]
        assert not views._revision_dir(CORPUS, "threads").exists()
        assert 'class="newer"' not in (await client.get(f"/api/ws/{CORPUS}/views/threads/frame")).text
    assert chips == ["the run crashed: KeyError: 'x'"], "a crashed change says so in main, as a failed one does"


async def test_a_view_its_review_is_revising_is_listed_as_it_last_passed(board, client, monkeypatch):
    """A revision the review asked for writes the view's folder while its proposal stays built, so the view is listed at
    the version it last passed, not at what the session has half written."""
    first = board["version"]
    run = view_review._Run(CORPUS, "threads", revising=True)
    monkeypatch.setitem(view_review._runs, (CORPUS, "threads"), run)
    vj = views.views_dir(CORPUS) / "threads" / views.VIEW_JSON
    vj.write_text(json.dumps({**json.loads(vj.read_text()), "name": "Threads (half)", "version": ""}))
    assert await _listed(client) == [("threads", "Threads", first)]
    run.revising = False
    assert await _listed(client) == [("threads", "Threads (half)", "")], "outside a revision the folder is the view"
