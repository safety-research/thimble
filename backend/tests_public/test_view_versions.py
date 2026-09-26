"""A view's versions (views.VERSIONS_SUBDIR): each time a view passes its checks its files are kept under their digest,
and a page loaded at that version keeps reading them, through the frame, records, marks and resolve routes' `v`, while
the dev agent changes the view's own folder and after the next version is built. The newest VERSIONS_KEPT stay, and
deleting the view removes them. The board and its readers are invented; the readers run in this process."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI

from app import config, views

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
