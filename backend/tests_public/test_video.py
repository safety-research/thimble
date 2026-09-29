"""The video document: a write of it starts a writer as any document's does, and what the writer saves is its narration
as checked and timed lines and its film, which reaches the browser under the views' policy. No model call, no Claude
Code and no browser."""
from __future__ import annotations

import pytest

from app import agent_session, config, investigation, notebook, report_types, tools, video

CORPUS = "mini"
MAIN = investigation.MAIN
FILM = ("<!doctype html><html><body><canvas id='c'></canvas>"
        "<script>window.seek = (t) => {}; window.ready = Promise.resolve()</script></body></html>")


@pytest.fixture()
def count(workspaces_tmp):
    """The id of a card that prints 27."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    cell = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    cell["status"], cell["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return cell["id"]


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst")


async def test_a_video_starts_a_writer_that_reads_the_video_form(count, monkeypatch):
    started: dict = {}

    async def start(c, key, **kw):
        started.update(c=c, key=key, **kw)
        return object()

    monkeypatch.setattr(agent_session, "start", start)
    assert "video" in [t["slug"] for t in report_types.list_types(CORPUS)]
    r = await call("start_writing", doc="video")
    assert not r.is_error, r.text
    assert started["key"] == "writer:video" and started["doc"] == "video" and "report:video" in started["prompt"]
    form = await call("read_ref", ref="type:video")
    assert "window.seek" in form.text and "window.timing" in form.text


async def test_a_saved_video_is_checked_and_timed_and_its_film_reaches_no_host(count):
    text = (f"# One account did it\n\nAll [[27|card:{count}]] deletions came from one account. (pause 0.8)\n\n"
            f"The log shows [[31|card:{count}]] deletions in all.\n\n```html\n{FILM}\n```\n")
    r = await call("write_document", doc="video", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "video")
    first, second = doc["lines"]
    assert first["pause_after"] == 0.8 and "unverified" not in first["sentences"][0]["tags"]
    assert "unverified" in second["sentences"][0]["tags"]  # the card shows 27, not 31
    lines = doc["timing"]["lines"]
    assert lines[0]["start"] == video.LEAD_S and lines[1]["start"] == pytest.approx(lines[0]["end"] + 0.8)
    page = video.film_document(doc)
    # the policy comes before the film's first element, so it governs the whole film
    assert page.index('http-equiv="Content-Security-Policy"') < page.index("<canvas")
    assert "connect-src 'none'" in page and "window.timing = " in page
