"""A view whose page plays video or audio, checked in a browser that cannot play H.264 or AAC (app/views.py media_note,
app/headless.py plays_recordings): the checks' report carries a note that the players in the pictures stay blank, which
the build session and the review read beside the pictures. The pictures and the browser probe are faked."""
from __future__ import annotations

import pytest

from app import headless, tools, views
from test_views import CORPUS, THREADS_HTML, THREADS_READER, VIEW, _fresh, bound, data, inproc, ws  # noqa: F401

VIDEO_HTML = THREADS_HTML.replace('<div id="out"></div>', '<div id="out"></div><video id="rec" controls></video>')


@pytest.fixture()
def pictures(monkeypatch):
    """The pictures faked, the browser Playwright's own, and each probe of it counted and answered by `plays[0]`."""
    async def no_page(c, slug, states, **k):
        return [{"ok": True, "errors": [], "fetches": 0, "records": 1} for _ in states]

    probes, plays = [], [False]

    async def probe(path):
        probes.append(path)
        return plays[0]

    monkeypatch.setattr(views, "shoot_states", no_page)
    monkeypatch.setattr(headless, "launch", lambda kind: "")
    monkeypatch.setattr(headless, "_missing", {})
    monkeypatch.setattr(headless, "plays_recordings", probe)
    return probes, plays


async def test_a_video_page_checked_where_the_browser_cannot_play_it_gets_a_note_and_others_do_not(
        ws, inproc, bound, pictures):
    probes, plays = pictures
    note = tools.hint("view-media-unplayable")
    assert note
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert rep["ok"] and note not in (rep.get("notes") or []) and not probes, "a page with no player asks nothing"

    views.write_view(CORPUS, "threads", reader=THREADS_READER, html=VIDEO_HTML, **VIEW)
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert rep["ok"], views.gate_lines(rep)
    assert rep["notes"] == [note] and f"note: {note}" in views.gate_lines(rep)
    assert probes == [""]

    plays[0] = True
    rep = await views.gate(CORPUS, "threads", ["board.jsonl#L3"])
    assert not rep.get("notes"), "a browser that plays H.264 and AAC shows the video, so no note"
