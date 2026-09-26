"""Viewers for a file type, proposed when the analyst opens a file the files view shows only as raw text or bytes
(views.suggestion_for, views.suggest and their routes). A file of an ordinary type, a media file, a file a view claims
and a text file with no suffix get no proposal and no model call; a terminal recording (.cast) gets one model call,
whose yes is stored as a `suggested` proposal claiming every .cast file, not built until accepted, and whose no is
remembered, as a dismissal is. Accepting queues it as a view the analyst asked for; the built view is a file-type
viewer that opens every file of its type.

The corpus is invented: an asciinema-style recording casts/one.cast (and a second, two.cast), a jsonl log, notes, a
picture, a video, a small binary blob with no suffix and a README with none."""
from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app import config, views

CORPUS = "recordings"
CAST = [{"version": 2, "width": 80, "height": 24}, [0.5, "o", "$ make test\r\n"], [1.2, "o", "12 passed\r\n"]]


@pytest.fixture()
def corpus(tmp_path, monkeypatch, workspaces_tmp):
    data = tmp_path / "data"
    root = data / CORPUS
    (root / "casts").mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    for name in ("one", "two"):
        (root / "casts" / f"{name}.cast").write_text("".join(json.dumps(x) + "\n" for x in CAST))
    (root / "log.jsonl").write_text('{"a": 1}\n')
    (root / "notes.md").write_text("# notes\n")
    (root / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (root / "clip.mp4").write_bytes(b"\0\0\0\x18ftypmp42")
    (root / "blob").write_bytes(bytes(range(256)) * 4)
    (root / "README").write_text("read me\n")
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    views._folder_cache.clear()
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    return root


class Model:
    """The proposal's model call, stubbed: each answer in turn, every call recorded."""

    def __init__(self, monkeypatch, *answers):
        self.answers, self.calls = list(answers), []
        monkeypatch.setattr(views, "_suggest_call", self.call)

    async def call(self, c, system, user, tool):
        self.calls.append({"system": system, "user": user, "tool": tool})
        got = self.answers.pop(0)
        if isinstance(got, Exception):
            raise got
        return SimpleNamespace(status="ok", output=got)


YES = {"help": True, "name": "terminal replay", "why": "A recording replayed as the terminal showed it.",
       "arrangement": "One file's output events in time order, drawn as a terminal screen with a scrubber over its time."}


@pytest.fixture()
async def api(corpus):
    app = FastAPI()
    app.include_router(views.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=60) as c:
        yield c


async def test_an_ordinary_or_media_file_and_a_text_file_with_no_suffix_get_no_proposal(api, monkeypatch):
    m = Model(monkeypatch)
    for path, why in (("log.jsonl", "the files view reads it"), ("notes.md", "the files view reads it"),
                      ("shot.png", "a media file"), ("clip.mp4", "a media file"), ("README", "a text file with no suffix"),
                      ("blob", "a file with no suffix")):
        got = (await api.get(f"/api/ws/{CORPUS}/views/suggestions", params={"path": path})).json()
        assert not got["eligible"] and got["reason"] == why, (path, got)
        assert (await api.post(f"/api/ws/{CORPUS}/views/suggest", json={"path": path})).json() == {"slug": None}
    assert m.calls == []


async def test_a_recording_gets_a_suggested_viewer_that_builds_once_accepted(api, monkeypatch):
    m = Model(monkeypatch, YES)
    queued: list[str] = []
    monkeypatch.setattr(views, "_queue", lambda c, slug: queued.append(slug))
    assert (await api.get(f"/api/ws/{CORPUS}/views/suggestions", params={"path": "casts/one.cast"})).json()["eligible"]
    slug = (await api.post(f"/api/ws/{CORPUS}/views/suggest", json={"path": "casts/one.cast"})).json()["slug"]
    assert slug == "terminal-replay" and queued == []
    (call,) = m.calls
    assert "casts/one.cast" in call["user"] and "one of 2 files ending in `.cast`" in call["user"]
    assert '"$ make test\\r\\n"' in call["user"] and call["tool"].name == "proposal"
    prop = views.read_proposal(CORPUS, slug)
    assert prop["status"] == "suggested" and prop["claims"] == ["**/*.cast"] and prop["proposed_by"] == "files"
    assert prop["name"] == "Terminal Replay" and not prop.get("asked")
    # the other recording's opening finds the proposal for its type and asks nothing
    got = (await api.get(f"/api/ws/{CORPUS}/views/suggestions", params={"path": "casts/two.cast"})).json()
    assert not got["eligible"] and got["proposal"]["slug"] == slug and got["answer"] == "suggested"
    assert (await api.post(f"/api/ws/{CORPUS}/views/suggest", json={"path": "casts/two.cast"})).json() == {"slug": None}
    r = await api.post(f"/api/ws/{CORPUS}/views/proposals/{slug}/accept")
    assert r.status_code == 200 and r.json()["status"] == "queued" and r.json()["asked"] is True and queued == [slug]
    assert (await api.post(f"/api/ws/{CORPUS}/views/proposals/{slug}/accept")).status_code == 409


async def test_a_dismissed_suggestion_and_a_no_are_remembered_and_a_failed_call_is_not(api, monkeypatch):
    m = Model(monkeypatch, RuntimeError("the API is down"), YES)
    assert (await api.post(f"/api/ws/{CORPUS}/views/suggest", json={"path": "casts/one.cast"})).json() == {"slug": None}
    assert views.suggestions(CORPUS) == {}, "a failed call caches nothing"
    slug = (await api.post(f"/api/ws/{CORPUS}/views/suggest", json={"path": "casts/one.cast"})).json()["slug"]
    assert (await api.delete(f"/api/ws/{CORPUS}/views/proposals/{slug}")).status_code == 200
    assert views.read_proposal(CORPUS, slug) is None and views.suggestions(CORPUS)[".cast"]["answer"] == "dismissed"
    got = (await api.get(f"/api/ws/{CORPUS}/views/suggestions", params={"path": "casts/one.cast"})).json()
    assert not got["eligible"] and got["reason"] == "already answered (dismissed)"
    assert (await api.post(f"/api/ws/{CORPUS}/views/suggest", json={"path": "casts/one.cast"})).json() == {"slug": None}
    assert len(m.calls) == 2
    views._suggestions_path(CORPUS).write_text("{}")
    Model(monkeypatch, {"help": False, "name": "", "why": "", "arrangement": ""})
    assert (await api.post(f"/api/ws/{CORPUS}/views/suggest", json={"path": "casts/one.cast"})).json() == {"slug": None}
    assert views.suggestions(CORPUS)[".cast"]["answer"] == "none"


async def test_a_viewer_whose_claims_are_one_type_s_glob_opens_every_file_of_the_type(api):
    views.write_view(CORPUS, "terminal-replay", name="Terminal Replay", why="w", claims=["**/*.cast"],
                     accepts=[{"form": "L<n>", "means": "an event"}], reader="def build_index(p):\n    return {}\n\n"
                     "def records(i, q):\n    return []\n\ndef resolve(i, l):\n    return None\n", html="<html></html>")
    listed = {v["slug"]: v for v in (await api.get(f"/api/ws/{CORPUS}/views")).json()}
    assert listed["terminal-replay"]["file_type"] and listed["spreadsheet"]["file_type"], "thimble's own viewers too"
    assert not views.file_type_viewer({"claims": ["log.jsonl"]}) and not views.file_type_viewer({"claims": []})
    assert [v["slug"] for v in views.views_for(CORPUS, "casts/two.cast", "L2")] == ["terminal-replay"]
    got = (await api.get(f"/api/ws/{CORPUS}/views/suggestions", params={"path": "casts/one.cast"})).json()
    assert not got["eligible"] and got["reason"] == "a view opens it"
    assert views.type_suffix("*.VTT") == ".vtt" and views.type_suffix("calls/*.vtt") is None
