"""The analyst's comments on a document reach every tab (bug hunt G6): adding one, resolving one (the margin's ✓, Done)
and opening one again each send `report {slug, status: commented}` on the workspace's stream, as a check's or main's
comment does, so another tab on the document reads it again. Called through the comment routes' functions; the stream
is caught at investigation.emit."""
from __future__ import annotations

import pytest

from app import investigation, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
async def doc(workspaces_tmp, mini_dir, monkeypatch) -> dict:
    """A report of one section with a check's open comment on its first sentence."""
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    text = "# Two kinds of posts\n\n## Posts\n\nMost posts claim a pull request. The rest ask for a review.\n"
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text
    d = report_types.read_doc(CORPUS, MAIN, "report")
    first = report_types.unit_sentences(d["sections"][0])[0]
    d["comments"] = [{"id": "c1", "sentence_id": first["id"], "text": "Most of how many?", "check": "important", "status": "open"}]
    report_types.write_doc(CORPUS, MAIN, "report", d)
    return d


@pytest.fixture()
def stream(monkeypatch) -> list[dict]:
    out: list[dict] = []
    monkeypatch.setattr(investigation, "emit", lambda c, inv, ev: out.append(dict(ev)))
    return out


async def test_resolving_reopening_and_adding_a_comment_reach_the_other_tabs(doc, stream):
    sid = doc["comments"][0]["sentence_id"]
    want = {"type": "report", "slug": "report", "status": "commented", "span": f"report:report#{sid}"}

    got = await report_types.dismiss(CORPUS, MAIN, "report", "c1")
    assert got["comments"][0]["status"] == "dismissed"
    assert stream == [want]

    stream.clear()
    await report_types.reopen(CORPUS, MAIN, "report", "c1")
    assert stream == [want]

    stream.clear()
    await report_types.post_comment(CORPUS, MAIN, "report", report_types.CommentBody(sentence_id=sid, text="Say how many."))
    assert stream == [want]
